'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { logErr, rpCompile, log, hdrName, utf8, safeParse, rpWalk, randId } = require('./util');
const { dsmlDiag, makeDirectPipe, dsmlExtractCall, dsmlCleanText, dsmlPickCall } = require('./dsml');
const { ResponsesStreamParser, UpstreamStreamParser, SSEDecoder, responsesRespToCanonical, makeResponsesWriter, makeWriter, canonicalToResponsesResp, canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp, responsesToCanonical } = require('./convert');
const { UP_RESP, TO_CANON, buildRequestForChannel, SAME_RETRYABLE, BUILD_BODY } = require('./sync');
const { tokOf, sendError, corsHeaders, pickChannels, globMatch, forcedChannelName, analyzePrompt, calibRatio, calibUpdate, scaleDist } = require('./router');
const { upstreamRequest, joinUrl } = require('./upstream');
const { respRedactOn, wrapRedactWriter, redactText, redactDeep } = require('./redact');
const { isConnErr, makeFreshAgents } = require('./proxy');

// ================= Request recording / token stats =================
/* ================= Request recording (config.record: {enable, server, maxChars}) ================= */
function instName(cfg) {
  if (cfg._name) return cfg._name;
  const bn = cfg._configFile ? path.basename(cfg._configFile, '.json') : 'config';
  return bn === 'config' ? 'default' : bn.replace(/^config\./, '');
}
// Write a record: POST JSON to the configured server when present (async, never blocks the response), otherwise append to local log/requests-<inst>.jsonl
function writeRequestRecord(cfg, recCfg, rec) {
  const line = JSON.stringify(rec);
  if (recCfg.server) { postRequestRecord(recCfg.server, line); return; }
  try {
    const dir = path.join(path.dirname(cfg._configFile || process.cwd()), 'log');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'requests-' + instName(cfg) + '.jsonl');
    // simple rotation: past 5MB keep only the last ~2MB (line-aligned, never mid-JSON)
    try {
      const st = fs.statSync(f);
      if (st.size > 5 * 1024 * 1024) {
        const txt = fs.readFileSync(f, 'utf8');
        const cut = txt.indexOf('\n', Math.max(0, txt.length - 2 * 1024 * 1024));
        fs.writeFileSync(f, cut >= 0 ? txt.slice(cut + 1) : txt.slice(-2 * 1024 * 1024));
      }
    } catch (_) {}
    fs.appendFileSync(f, line + '\n');
  } catch (e) { logErr('请求记录写入失败:', e.message); }
}
function postRequestRecord(server, line) {
  try {
    const u = new URL(server);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(line) },
    }, (resp) => { resp.resume(); });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => logErr('请求记录上报失败:', e.message));
    r.end(line);
  } catch (e) { logErr('请求记录服务器地址无效:', e.message); }
}

function handleUpstreamResponse(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, res, upRes, upReq, built, ctx, retryHook) {
  const { direct, stream, upApi } = built;
  const { logMeta, t0, usageCapture, stats } = ctx;
  const rpInc = (cfg.replace && Array.isArray(cfg.replace.inc)) ? rpCompile(cfg.replace.inc) : [];
  // channel-level override (ch.transcreet): on / off / res-only; unset = follow the instance's global dsmlClean
  const chTrans = ch && ch.transcreet ? String(ch.transcreet).toLowerCase() : '';
  const dsmlOn = chTrans === 'off' ? false : (chTrans ? true : !!(cfg.dsmlClean && cfg.dsmlClean.enable));        // 内置 DSML 标记清洗(默认开)
  const dsmlThink = chTrans === 'on' ? true : (chTrans === 'off' || chTrans === 'res-only') ? false : !!(cfg.dsmlClean && cfg.dsmlClean.reasoning); // 思考字段是否也清
/* SSE streams are never cleaned: no DSML scrubbing, no per-event rewriting.  The stream
   *   is forwarded byte-for-byte (same format) or converted event-by-event.  DSML cleaning
   *   remains available for non-streaming JSON only, where the whole body is already in hand. */
/* Backfill gate: restore a textual call into a structured one only when the function name matches a tool the client declared this round */
  const dsmlBackfill = !!(cfg.dsmlClean && cfg.dsmlClean.backfill);
  const dsmlToolNames = (() => {
    if (!dsmlBackfill) return null;
    const arr = (canonical && Array.isArray(canonical.tools)) ? canonical.tools : [];
    const set = new Set();
    for (const t of arr) { const n = t && t.function && t.function.name; if (n) set.add(String(n)); }
    return set.size ? set : null;
  })();
  const dsmlOpts = {
    toolNames: dsmlToolNames,
    onDiag: (rec) => dsmlDiag(cfg, Object.assign({ ch: ch.name, model: canonical && canonical.model, fmt: clientFormat, stream: !!stream, direct: !!direct }, rec)),
  };
  const ctSse = /event-stream/i.test(String(upRes.headers['content-type'] || ''));
  const dsmlPipe = dsmlOn && !stream;   // stream-process cleaning removed: never rewrite SSE
  const rewritePipe = !!(rpInc.length || dsmlPipe || (stream && ctSse));   // SSE forwarding still uses the event pipe (no cleaning)
  const isResponsesUp = ch.type === 'openai' && upApi === 'responses';

/* **Unified settlement + finalization hardening (2026-09-18, same origin as ai-gateway-core)
   * Incident: the direct streaming branch's upRes.on('end') called ctx.logDone() bare. Once it threw, the EventEmitter
   * emit loop broke -- upRes.pipe(res)'s onend never fired, so the downstream never saw the end marker,
   * leaving ghost records of "1 request / 0 tokens" in stats (on core it showed as requests hanging 9 minutes unsettled).
   * Now: (1) settlement runs exactly once (2) settlement errors never break downstream finalization (3) interrupted streams still settle. */
  let __settled = false;
  const __settle = (status, why) => {
    if (__settled) return;
    __settled = true;
    if (__doneTimer) { clearTimeout(__doneTimer); __doneTimer = null; }
    if (why) logErr('[settle]', why, 'status=' + status);
    try { ctx.logDone(status); } catch (e) { logErr('[settle] logDone 失败:', e.message); }
  };

/* *Client disconnect (stop button / page closed / flaky network): cancel the upstream request immediately.
   *   this channel did not exist before -- after pressing stop the upstream kept generating until natural end or the 180s timeout, looking like a dead stop button. */
/* *Upstream sends finish_reason/[DONE] but keeps the connection open (common with reverse proxies): force finalization after 2.5s.
   *   without this, settlement/logDone never fires -- 0 tokens in stats, a frozen ball ring, a client that spins forever. */
  let __forceEnd = () => { try { if (!res.writableEnded) res.end(); } catch (_) {} };
  let __doneTimer = null;
  const __armForceEnd = () => {
    if (__doneTimer || __settled) return;
    __doneTimer = setTimeout(() => {
      __doneTimer = null;
      if (__settled) return;
      log('[force-end] 上游未关连接, 强制收尾 req=' + ctx.reqId);
      __settle(upRes.statusCode && upRes.statusCode < 400 ? upRes.statusCode : 200);
      try { __forceEnd(); } catch (_) {}
      try { upRes.destroy(); } catch (_) {}
    }, 2500);
  };
/* *Fallback settlement: upstream/client disconnects previously never reached logDone -- stats froze at "1 request / 0 tokens",
   *  the ball's context ring never moves either (observed 2026-10-26: all 4 requests around 20:5x vanished this way). */
  upRes.on('close', () => { if (!__settled) __settle(upRes.statusCode || 200, '上游连接关闭(没等到 end)'); });
  let clientGone = false;
  const killUp = () => {
    if (clientGone) return; clientGone = true;
    try { if (upReq) upReq.destroy(); } catch (_) {}
    try { if (upRes) upRes.destroy(); } catch (_) {}
    __settle(499, '客户端断开, 已取消上游');
  };
  res.on('close', () => { if (!res.writableEnded) killUp(); });
  req.on('aborted', () => killUp());
  res.on('error', () => {});   // ★吃掉"对已结束/已断开响应写入"的流错误: 客户端断开瞬间的 write-after-end 曾以 uncaughtException 打死整个网关进程(2026-10-16 实测)

  if (direct) {
    const ct = upRes.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json');
    try {
      res.writeHead(upRes.statusCode, { 'Content-Type': ct, 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    } catch (e) {
/* *Never return silently: if writing the headers fails, the client gets nothing and nobody reads the upstream response,
       *  the request would hang forever. Now it errors clearly and releases the upstream connection. */
      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    if (stream) {
      const parser = isResponsesUp ? new ResponsesStreamParser(() => {}) : new UpstreamStreamParser(ch.type, () => {});
      const dec = new SSEDecoder((data) => {
        try {
          if (data === '[DONE]') { __armForceEnd(); return; }
          const j = JSON.parse(data);
          const c0 = j && j.choices && j.choices[0];
          if (c0 && (c0.finish_reason || (c0.delta && c0.delta.finish_reason))) __armForceEnd();
          parser.handle(j);
        } catch (_) {}
      });
const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
      let convPaused = false;
      upRes.on('data', c => {
        if (convPaused) return;
        try { dec.push(u8(c)); } catch (_) {}
        if (res.writableNeedDrain) {
          convPaused = true;
          upRes.pause();
          res.once('drain', () => { convPaused = false; try { upRes.resume(); } catch (_) {} });
        }
      });
      upRes.on('end', () => {
        try {
          dec.end(); parser.finish();
          usageCapture.input = parser.usage ? parser.usage.input : 0;
          usageCapture.output = parser.usage ? parser.usage.output : 0;
          usageCapture.cached = parser.usage ? (parser.usage.cached || 0) : 0;
          usageCapture.reasoning = parser.usage ? (parser.usage.reasoning || 0) : 0;
          __settle(upRes.statusCode);
        } catch (e) { logErr('[stream] 结算失败，仍强制给下游收尾:', e.message); }
/* *When a rewrite pipe exists (inc replacement / DSML scrubbing), finalization belongs to the pipe -- it must flush the trailing partial line and the state machine residue first;
         *   calling res.end() here turns later pipe writes into write-after-end (trailing bytes were lost, observed 2026-10-15). */
        if (!rewritePipe) { try { res.end(); } catch (_) {} }
      });
      upRes.on('error', (e) => { if (!rewritePipe) { try { res.end(); } catch (_) {} } __settle(502, '上游流中断(' + e.message + ')'); });
    } else {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const j = safeParse(Buffer.concat(chunks).toString('utf8'));
        if (j) {
          const cr = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j);
          usageCapture.input = cr.usage.input; usageCapture.output = cr.usage.output;
          usageCapture.cached = cr.usage.cached || 0; usageCapture.reasoning = cr.usage.reasoning || 0;
          try {
            const __cpt = Math.max(1, Number(cfg.charsPerToken) || 4);
            const __tok = (t) => tokOf(t, __cpt);
            ctx.respDist.reasoning = __tok(cr.reasoning);
            ctx.respDist.text = __tok(cr.text);
            if (Array.isArray(cr.tool_calls)) for (const tc of cr.tool_calls) { const fn = (tc && tc.function) || {}; ctx.respDist.tool += __tok(fn.name) + __tok(fn.arguments) + 8; }
          } catch (_) {}
        }
        __settle(upRes.statusCode);
      });
      upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游中断(非流式): ' + e.message); });
    }
/* SSE streams keep the event-level forwarding pipe (framing, tolerant decode, [DONE]);
     * DSML scrubbing is non-stream only, so dsmlPipe is false here for streams. */
    if (rewritePipe) {
/* Unified rewrite pipe (2026-10-15): inc text replacement + built-in DSML markup scrubbing
       *   - rewrites line by line; lines that need no rewrite pass through verbatim (same-format passthrough stays as lossless as possible);
       *   - the DSML state machine is isolated per field, touching only content/text and reasoning_content/reasoning/thinking;
       *   - finalization (trailing partial line + state-machine residue) and res.end() both live inside the pipe; see makeDirectPipe. */
      const pipe = makeDirectPipe(res, rpInc, dsmlPipe, dsmlThink, stream, Object.assign({}, dsmlOpts, { isSSE: ctSse, appendDone: clientFormat === 'openai' }));
      let upEnded = false;
      const finishPipe = () => { if (upEnded) return; upEnded = true; try { pipe.end(); } catch (_) {} };
      __forceEnd = () => finishPipe();
      let pipePaused = false;
      upRes.on('data', c => {
        if (pipePaused) return;
        let ok = true;
        try { ok = pipe.push(c); } catch (_) {}
        if (ok === false) {
          pipePaused = true;
          upRes.pause();
          res.once('drain', () => { pipePaused = false; try { upRes.resume(); } catch (_) {} });
        }
      });
      upRes.on('end', finishPipe);
      upRes.on('close', finishPipe);                          // ★上游连接被重置/掐断(没发 end) → 强制在管道内收尾, 下游不再悬挂
      upRes.on('error', (e) => { __settle(502, '上游中断(改写管道): ' + e.message); finishPipe(); });   // 错误也走管道收尾(补 [DONE]), 不提前 res.end()
    } else {
      upRes.on('close', () => { if (!res.writableEnded) { try { res.end(); } catch (_) {} } });   // 裸直通同样兜住上游断流
      upRes.pipe(res);
    }
    return;
  }

// Cross-format conversion
  if (stream) {
    const isArrayStream = clientFormat === 'gemini' && !urlInfo.altSse;
    try {
      res.writeHead(200, {
        'Content-Type': isArrayStream ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*',
      });
    } catch (e) {
/* *Never return silently: if writing the headers fails, the client gets nothing and nobody reads the upstream response,
       *  the request would hang forever. Now it errors clearly and releases the upstream connection. */
      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    const baseWriter = (clientFormat === 'openai' && clientApi === 'responses') ? makeResponsesWriter(res, canonical.model) : makeWriter(clientFormat, res, canonical.model, { geminiArray: isArrayStream });
/* Streaming path: no cleaning stage.  Format conversion and optional privacy filtering only. */
    let writer = baseWriter;
    if (respRedactOn(cfg, urlInfo)) writer = wrapRedactWriter(writer, cfg.redact && cfg.redact.extra);
// Response-side token distribution counter (side channel; counts only; ctx.respDist declared at the top of handleChat)
    const __origOnEvent = writer.onEvent.bind(writer);
    writer.onEvent = (ev) => {
      try {
        const cpt = Math.max(1, Number(cfg.charsPerToken) || 4);
        if (ev.type === 'reasoning') ctx.respDist.reasoning += tokOf(ev.t);
        else if (ev.type === 'text') ctx.respDist.text += tokOf(ev.t);
        else if (ev.type === 'tool_start') ctx.respDist.tool += tokOf(ev.name) + 8;
        else if (ev.type === 'tool_delta') ctx.respDist.tool += tokOf(ev.s);
      } catch (_) {}
      return __origOnEvent(ev);
    };
    const parser = isResponsesUp ? new ResponsesStreamParser(ev => {
      try { if (rpInc.length) rpWalk(ev, rpInc, 0, false); writer.onEvent(ev); } catch (e) { logErr('writer error:', e.message); }
    }) : new UpstreamStreamParser(ch.type, ev => {
      try { if (rpInc.length) rpWalk(ev, rpInc, 0, false); writer.onEvent(ev); } catch (e) { logErr('writer error:', e.message); }
    });
    const dec = new SSEDecoder((data) => {
      if (data === '[DONE]') { parser.finish(); return; }
      try { parser.handle(JSON.parse(data)); } catch (e) { logErr('bad SSE data (first 200 chars):', String(data).slice(0, 200)); }
    });
const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
    let convPaused = false;
    upRes.on('data', c => {
      if (convPaused) return;
      try { dec.push(u8(c)); } catch (_) {}
      if (res.writableNeedDrain) {
        convPaused = true;
        upRes.pause();
        res.once('drain', () => { convPaused = false; try { upRes.resume(); } catch (_) {} });
      }
    });
    let upStreamDone = false;
    const upStreamFinal = () => {
      if (upStreamDone) return; upStreamDone = true;
      try {
        dec.end(); parser.finish();
        usageCapture.input = parser.usage ? parser.usage.input : 0;
        usageCapture.output = parser.usage ? parser.usage.output : 0;
        usageCapture.cached = parser.usage ? (parser.usage.cached || 0) : 0;
        usageCapture.reasoning = parser.usage ? (parser.usage.reasoning || 0) : 0;
        __settle(200);
      } catch (e) { logErr('[stream] 转换路径结算失败，仍强制收尾:', e.message); }
      try { res.end(); } catch (_) {}
    };
    upRes.on('end', upStreamFinal);
    upRes.on('close', upStreamFinal);                         // ★上游断流(连接重置, 没发 end)也强制收尾
    upRes.on('error', (e) => { logErr('upstream stream error:', e.message); try { res.end(); } catch (_) {} __settle(502, '上游流中断(转换): ' + e.message); });
  } else {
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', async () => {
      const txt = Buffer.concat(chunks).toString('utf8');
      const j = safeParse(txt);
      if (!j) {
// Upstream returned 200 but the body is not JSON (HTML error pages etc.; content-type may even fake json): retryable
        const why = 'upstream returned non-JSON: ' + redactText(txt.slice(0, 200), cfg.redact && cfg.redact.extra);
        if (retryHook && retryHook(why)) return;
        stats.errors++;
        return sendError(clientFormat, res, 502, why);
      }
      const cresp = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j);
      usageCapture.input = cresp.usage.input;
      usageCapture.output = cresp.usage.output;
if (dsmlOn) {   /* non-streaming: scrub the whole text at once (final=true: unclosed markup dropped, deferred tail appended) + textual-call backfill */
        try {
          if (typeof cresp.text === 'string') {
            const cand = dsmlExtractCall(cresp.text);
            cresp.text = dsmlCleanText(cresp.text);
            const hasStructured = Array.isArray(cresp.tool_calls) && cresp.tool_calls.length;
            const pick = (!hasStructured && cand) ? dsmlPickCall(cand, dsmlToolNames) : null;
            if (pick) {
              cresp.tool_calls = [{ id: randId('call_dsml_'), type: 'function', function: { name: pick.name, arguments: pick.arguments } }];
              if (!cresp.finish_reason || cresp.finish_reason === 'stop') cresp.finish_reason = 'tool_calls';
              dsmlDiag(cfg, { ch: ch.name, model: canonical && canonical.model, fmt: clientFormat, stream: false, direct: false, content: 1, emptied: cand ? 1 : 0, blocks: cand ? cand.length : 0, names: (cand || []).map(c => c.name), backfill: 'no-structured-call→tool_calls', finishIn: 'stop', finishOut: cresp.finish_reason });
            } else if (cand && hasStructured) {
              dsmlDiag(cfg, { ch: ch.name, model: canonical && canonical.model, fmt: clientFormat, stream: false, direct: false, blocks: cand.length, names: cand.map(c => c.name), backfill: 'already-has-structured-call' });
            }
          }
          if (dsmlThink && typeof cresp.reasoning === 'string') cresp.reasoning = dsmlCleanText(cresp.reasoning);
        } catch (e) { logErr('[dsml] 非流式清洗失败:', e.message); }
      }
if (respRedactOn(cfg, urlInfo)) {   // response-direction filter (non-streaming): content/thinking/tool args
        try {
          const rx = cfg.redact && cfg.redact.extra;
          if (typeof cresp.text === 'string') cresp.text = redactText(cresp.text, rx);
          if (typeof cresp.reasoning === 'string') cresp.reasoning = redactText(cresp.reasoning, rx);
          if (Array.isArray(cresp.tool_calls)) for (const tc of cresp.tool_calls) {
            if (tc && tc.function && typeof tc.function.arguments === 'string') tc.function.arguments = redactText(tc.function.arguments, rx);
          }
        } catch (e) { logErr('[redact] 非流式响应过滤失败:', e.message); }
      }
      let out;
      if (clientFormat === 'openai') out = clientApi === 'responses' ? canonicalToResponsesResp(cresp, canonical.model) : canonicalToOpenAIResp(cresp, canonical.model);
      else if (clientFormat === 'claude') out = canonicalToClaudeResp(cresp, canonical.model);
      else out = canonicalToGeminiResp(cresp, canonical.model);
      if (rpInc.length) rpWalk(out, rpInc, 0, false);
      try {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
        res.end(JSON.stringify(out));
      } catch (e) { logErr('[resp] 响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
      __settle(200);
    });
    upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游中断(转换/非流式): ' + e.message); });
  }
}

function handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr) {
  const stats = cfg._stats;
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch (e) { return sendError(clientFormat, res, 400, 'invalid JSON body: ' + e.message); }
  if (!body || typeof body !== 'object') return sendError(clientFormat, res, 400, 'request body must be a JSON object');
// Privacy filter: replace secrets/tokens in the request body with *** before forwarding
  // the admin master switch redact.enable (instance-level, on by default) is the ceiling; a user card can opt out with redact=false
  const redactInstOn = !(cfg.redact && cfg.redact.enable === false);
  let redactOn = redactInstOn;
if (redactInstOn && urlInfo.userKey && urlInfo.userKey.redact === false) redactOn = false; // user card opted out
  if (redactOn) body = redactDeep(body, cfg.redact && cfg.redact.extra, 0);
  // text replacement (request direction): config.replace.out rules apply to request text (model fields and data: URLs skipped)
  const rpOutRules = (cfg.replace && Array.isArray(cfg.replace.out)) ? rpCompile(cfg.replace.out) : [];
  if (rpOutRules.length) body = rpWalk(body, rpOutRules, 0, true);

  const canonical = (clientApi === 'responses') ? responsesToCanonical(body, urlInfo.model) : TO_CANON[clientFormat](body, urlInfo.model);
if (urlInfo.stream) canonical.stream = true; // gemini: the streaming flag lives in the URL path
  if (!canonical.model) return sendError(clientFormat, res, 400, 'missing "model"');
// Key card model whitelist (matched against the client-facing model name)
  if (urlInfo.userKey && Array.isArray(urlInfo.userKey.models) && urlInfo.userKey.models.length
      && !urlInfo.userKey.models.includes(canonical.model)) {
    return sendError(clientFormat, res, 403, '此卡密不允许使用模型: ' + canonical.model + ' (可用: ' + urlInfo.userKey.models.join(', ') + ')');
  }
// Key card branch whitelist (only listed instances are reachable)
  if (urlInfo.userKey && Array.isArray(urlInfo.userKey.branches) && urlInfo.userKey.branches.length) {
    const br = cfg._name || 'default';
    if (!urlInfo.userKey.branches.includes(br)) {
      return sendError(clientFormat, res, 403, '此卡密不允许访问分组: ' + br + ' (可用: ' + urlInfo.userKey.branches.join(', ') + ')');
    }
  }
// Card-level privacy overrides are applied earlier (inside redactDeep, ~line 2250); not repeated here


  const candidates = pickChannels(cfg, canonical.model, forcedChannelName(cfg, req));
  if (!candidates.length) return sendError(clientFormat, res, 503, 'no channel configured in config.json');

  stats.requests++;
// Request recording (optional, off by default): wraps res.write/res.end to capture what was actually sent to the client
  const reqId = randId('req');
// In-flight requests (reqId -> start time): lets the ball show "thinking"; auto-expires after 10 minutes
  stats._inflight = stats._inflight || new Map();
  for (const [k, t] of stats._inflight) if (Date.now() - t > 120000) stats._inflight.delete(k);
  stats._inflight.set(reqId, Date.now());
  const recCfg = (cfg.record && cfg.record.enable) ? cfg.record : null;
  const recState = { status: 0, chName: '' };
  let recChunks = null, recFinalized = false;
  const recordReq = (status, chName, inT, outT) => {
    recState.status = status; recState.chName = chName || '';
    stats.recent.push({ id: reqId, time: new Date().toISOString().slice(0, 19).replace('T', ' '), model: canonical.model, channel: chName || '', status, duration: Date.now() - t0, inputTokens: inT || 0, outputTokens: outT || 0, keyName: urlInfo.userKey ? (urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12)) : undefined });
    if (stats.recent.length > 200) stats.recent.shift();
  };
  const stream = canonical.stream;
  log('[req]', reqId, 'model=' + canonical.model, stream ? 'stream' : 'block',
    'tools=' + (Array.isArray(canonical.tools) ? canonical.tools.length : 0));
  const t0 = Date.now();
  const usageCapture = { input: 0, output: 0, cached: 0, reasoning: 0 };
const respDist = { reasoning: 0, text: 0, tool: 0 }; // response-side distribution (streaming via the writer hook, non-streaming filled before __settle)
// Time to first byte (TTFB): records the timestamp only, never rewrites content
  let firstWriteAt = 0;
  try {
    const __ow = res.write.bind(res), __oe = res.end.bind(res);
    res.write = (c, ...a) => { if (!firstWriteAt && c) firstWriteAt = Date.now(); return __ow(c, ...a); };
    res.end = (c, ...a) => { if (!firstWriteAt && c && typeof c !== 'function') firstWriteAt = Date.now(); return __oe(c, ...a); };
  } catch (_) {}
  function finalizeRecord() {
    if (!recCfg || recFinalized) return; recFinalized = true;
    try {
      const maxC = (recCfg.maxChars > 0 ? recCfg.maxChars : 200000);
      let resp = Buffer.concat(recChunks).toString('utf8');
      if (resp.length > maxC) resp = resp.slice(0, maxC) + '\n…[截断]';
      let reqTxt = ''; try { reqTxt = JSON.stringify(body); } catch (_) {}
      if (reqTxt.length > maxC) reqTxt = reqTxt.slice(0, maxC) + '…[截断]';
      writeRequestRecord(cfg, recCfg, {
        id: reqId, time: new Date().toISOString(), instance: instName(cfg), format: clientFormat,
        model: canonical.model, channel: recState.chName, status: recState.status,
        duration: Date.now() - t0, inputTokens: usageCapture.input || 0, outputTokens: usageCapture.output || 0,
        request: safeParse(reqTxt) || reqTxt, response: resp,
      });
    } catch (_) {}
  }
  if (recCfg) {
    recChunks = [];
    const ow = res.write.bind(res), oe = res.end.bind(res);
    res.write = (c, ...a) => { try { if (c) recChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); } catch (_) {} return ow(c, ...a); };
    res.end = (c, ...a) => {
      try { if (c && typeof c !== 'function') recChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); } catch (_) {}
      finalizeRecord();
      return oe(c, ...a);
    };
  }
  let attempt = 0;
  let lastErrStatus = 0;
  let lastErrMsg = '';

// Try candidates one by one; connection failures / retryable HTTP errors -> next candidate; non-retryable (e.g. 400) -> pass straight through
  const tryNext = () => {
    if (attempt >= candidates.length) {
// Every candidate failed
      stats.errors++;
      recordReq(lastErrStatus || 502, '', 0, 0);
      const msg = lastErrMsg || ('all ' + candidates.length + ' channels failed');
      return sendError(clientFormat, res, lastErrStatus || 502, msg);
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    const myCanonical = { ...canonical, model: pick.upstreamModel || canonical.model };
    const built = buildRequestForChannel(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req);
    attempt++;

// HTTP headers allow ASCII only; an apiKey with CJK/full-width characters makes node throw internally
    for (const [hk, hv] of Object.entries(built.headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        return sendError(clientFormat, res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请修改 config.json`);
      }
    }

    const ctx = {
      logMeta: [clientFormat + '>' + ch.type, 'model=' + canonical.model, 'ch=' + ch.name, 'proxy=' + (ch.proxy || '-'), stream ? 'stream' : 'block'].join(' '),
      t0, usageCapture, stats, reqId, respDist,
      logDone(status) {
// Settle inflight inside logDone: reqId/stats are guaranteed in scope here
        try { if (stats._inflight) stats._inflight.delete(reqId); } catch (_) {}
        log(ctx.logMeta, 'status=' + status, 'in=' + usageCapture.input, 'out=' + usageCapture.output,
          'ttfb=' + (firstWriteAt ? firstWriteAt - t0 : 0), 'ms=' + (Date.now() - t0));
        stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
        stats.byChannel[ch.name].inputTokens += usageCapture.input;
        stats.byChannel[ch.name].outputTokens += usageCapture.output;
// Key card usage stats + quota accumulation
        if (urlInfo.userKey) {
          const kn = urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12);
          stats.byKey = stats.byKey || {};
          stats.byKey[kn] = stats.byKey[kn] || { requests: 0, inputTokens: 0, outputTokens: 0 };
          stats.byKey[kn].inputTokens += usageCapture.input;
          stats.byKey[kn].outputTokens += usageCapture.output;
          urlInfo.userKey.usedTokens = (urlInfo.userKey.usedTokens || 0) + usageCapture.input + usageCapture.output;
          cfg._keyUsageDirty = true;
        }
        // Some reverse-proxy channels never send usage: fall back to the local estimate, otherwise the ball's context ring never moves
        const __cpt = Math.max(1, Number(cfg.charsPerToken) || 4);
        const __raw = analyzePrompt(canonical, __cpt);
        const __est = !usageCapture.input;
        const __inTok = usageCapture.input || Math.round(__raw.total * calibRatio(cfg, canonical.model));
calibUpdate(cfg, canonical.model, usageCapture.input, __raw.total); // self-calibration EMA (real/estimated)
const __pd = scaleDist(__raw.dist, __raw.total, usageCapture.input); // normalize to input when real usage exists
// ===== Token distribution + daily/byModel accumulation (2026-10-27) =====
        try {
          const __rd = respDist || { reasoning: 0, text: 0, tool: 0 };
          const __rdActual = usageCapture.reasoning ? usageCapture.reasoning : __rd.reasoning;
          const __textTok = Math.max(0, (usageCapture.output || 0) - __rdActual - __rd.tool);
          const __cacheSaved = usageCapture.cached || 0;
          stats.byModel = stats.byModel || {};
          const __bm = stats.byModel[canonical.model] = stats.byModel[canonical.model] || { requests: 0, inputTokens: 0, outputTokens: 0, cached: 0 };
          __bm.requests++; __bm.inputTokens += __inTok; __bm.outputTokens += usageCapture.output || 0; __bm.cached += __cacheSaved;
          const __day = new Date().toISOString().slice(0, 10);
          stats.daily = stats.daily || {};
          const __dd = stats.daily[__day] = stats.daily[__day] || { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cached: 0, dist: { tools: 0, system: 0, user: 0, history: 0, reasoning: 0, text: 0, tool: 0 } };
          __dd.requests++; if (status >= 400) __dd.errors++;
          __dd.inputTokens += __inTok; __dd.outputTokens += usageCapture.output || 0; __dd.cached += __cacheSaved;
          for (const __k of ['tools', 'system', 'user', 'history']) __dd.dist[__k] += __pd[__k] || 0;
          __dd.dist.reasoning += __rdActual; __dd.dist.text += __textTok; __dd.dist.tool += __rd.tool;
        } catch (__e) { try { logErr('[stat] 累加失败:', __e.message); } catch (_) {} }
        recordReq(status, ch.name, usageCapture.input, usageCapture.output);
      },
    };
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;
    if (urlInfo.userKey) {
      const kn = urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12);
      stats.byKey = stats.byKey || {};
      stats.byKey[kn] = stats.byKey[kn] || { requests: 0, inputTokens: 0, outputTokens: 0 };
      stats.byKey[kn].requests++;
    }

    // channel-level queueing delay (channel field delayMs, ms): each request waits before sending; concurrent requests on one channel serialize through the _gate chain at intervals (they never pile onto the upstream), easing 429 rate limits
    const delayMs = Math.min(120000, Number(ch.delayMs) || 0);
// Connection-level errors / HTML-faked-success same-channel retries (default cfg.connRetry=2, a fresh connection each time):
// socket hang up and friends happen before any response arrives, so retrying is safe and never double-bills
    let connRetries = 0;
    const maxConnRetry = Math.max(0, Number(cfg.connRetry) || 0);
// Same-channel retry budget for 429/5xx (per channel); defaults to 1 when unset
    let sameLeft = Math.max(0, Number(cfg.retrySame == null ? 1 : cfg.retrySame) || 0);
    const maxSame = sameLeft;
// Returns true = a same-channel retry or next-candidate switch was scheduled; false = out of options, caller proceeds to final failure
    const retrySameOrNext = (why) => {
      if (connRetries < maxConnRetry) {
        connRetries++;
        log('RETRY', ctx.logMeta, why, '→ 同渠道重试 (' + connRetries + '/' + maxConnRetry + ')');
        setTimeout(() => doSend(true), 400 * connRetries);
        return true;
      }
      if (attempt < candidates.length) {
        log('ERR', ctx.logMeta, why, '→ 切换渠道');
        tryNext();
        return true;
      }
      return false;
    };
    const doSend = (fresh) => upstreamRequest(cfg, ch, built.url, built.headers, built.bodyBuf, (err, upRes, upReq) => {
      if (err) {
        lastErrStatus = 502; lastErrMsg = 'upstream request failed: ' + err.message;
        if (isConnErr(err)) {
          if (retrySameOrNext(err.message)) return;
        } else {
          log('ERR', ctx.logMeta, err.message, attempt < candidates.length ? '→ 切换渠道' : '→ 无更多渠道');
          if (attempt < candidates.length) return tryNext();
        }
        stats.errors++;
        recordReq(502, ch.name, 0, 0);
        return sendError(clientFormat, res, 502, lastErrMsg);
      }

// Upstream fakes success with an HTML page (CDN challenge / relay failure page): treated as retryable; retry the same channel first, then switch
      const upCt = String(upRes.headers['content-type'] || '');
      if (upRes.statusCode < 400 && /text\/html/i.test(upCt)) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = 502;
          lastErrMsg = '渠道 ' + ch.name + ' 返回了 HTML 网页而非数据(content-type: ' + upCt + '): ' + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 200);
          if (retrySameOrNext('upstream returned HTML (content-type: ' + upCt + ')')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          return sendError(clientFormat, res, 502, lastErrMsg);
        });
        upRes.on('error', () => {
          if (retrySameOrNext('read HTML response failed')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          try { sendError(clientFormat, res, 502, lastErrMsg || 'upstream HTML response read failed'); } catch (_) {}
        });
        return;
      }

      if (upRes.statusCode >= 400 && SAME_RETRYABLE.has(upRes.statusCode)
          && (sameLeft > 0 || attempt < candidates.length)) {
// 429/5xx: backoff-retry on the same channel -> switch to the next candidate after the budget; other retryable errors switch immediately as before
        const sc = upRes.statusCode;
        const ra = parseInt(String(upRes.headers['retry-after'] || ''), 10);
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = sc;
          lastErrMsg = `渠道 ${ch.name} 返回 ${sc}: ` + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 300);
          if (sameLeft > 0) {
            sameLeft--;
            const wait = Math.min(15000, (!isNaN(ra) && ra > 0) ? ra * 1000 : 400 * Math.pow(2, maxSame - sameLeft - 1));
            stats.retries = (stats.retries || 0) + 1;
            log('RETRY', ctx.logMeta, 'status=' + sc, '→ 同渠道重试 ' + wait + 'ms (' + (maxSame - sameLeft) + '/' + maxSame + ')');
            setTimeout(() => doSend(true), wait);
            return;
          }
          log('RETRY', ctx.logMeta, 'status=' + sc, '→ 切换渠道 (' + (candidates.length - attempt) + ' 个剩余)');
          tryNext();
        });
        upRes.on('error', () => { tryNext(); });
        return;
      }

// * Responses passthrough downgrade (2026-10-16): when a client's /v1/responses passes through to upstream /v1/responses,
//   upstream replies 404/405 (that upstream has no Responses endpoint, e.g. old vLLM/some relays) -> automatically resend as
//   /v1/chat/completions (same channel) and converts the response back to responses format. Each channel degrades at most once.
//   Channels with a locked `path` never downgrade: the path is an explicit contract and must not be silently changed.
      if (clientApi === 'responses' && built.direct && ch.type === 'openai' && !ch.path
          && (upRes.statusCode === 404 || upRes.statusCode === 405)) {
        ctx.respDg = ctx.respDg || {};
        if (!ctx.respDg[ch.name]) {
          ctx.respDg[ch.name] = true;
          const sc = upRes.statusCode;
          const dgBody = Buffer.from(JSON.stringify(BUILD_BODY.openai(myCanonical, { addUsage: ch.addUsage })));
          const dgHeaders = { authorization: 'Bearer ' + ch.apiKey };
          if (stream) dgHeaders.accept = 'text/event-stream';
          const dgBuilt = { url: joinUrl(ch.baseUrl, '/v1/chat/completions'), headers: dgHeaders, bodyBuf: dgBody, direct: false, stream: !!stream, upApi: 'chat' };
upRes.resume(); // discard the original 404/405 body
          log('DOWNGRADE', ctx.logMeta, 'status=' + sc, '上游不支持 /v1/responses → 改 chat 转换重发');
          return upstreamRequest(cfg, ch, dgBuilt.url, dgHeaders, dgBody, (err2, upRes2, upReq2) => {
            if (err2) {
              lastErrStatus = 502; lastErrMsg = 'downgrade chat failed: ' + err2.message;
              log('ERR', ctx.logMeta, err2.message, '(downgrade chat)');
              stats.errors++;
              recordReq(502, ch.name, 0, 0);
              return sendError(clientFormat, res, 502, lastErrMsg);
            }
            if (upRes2.statusCode >= 400) {
// chat failed too (not a 404/405 passthrough; this was already a conversion path) -> pass through chat's error
              const c2 = [];
              upRes2.on('data', c => c2.push(c));
              upRes2.on('end', () => {
                stats.errors++;
                recordReq(upRes2.statusCode, ch.name, 0, 0);
                log('UPERR', ctx.logMeta, 'status=' + upRes2.statusCode, '(downgrade chat 也失败)');
                try {
                  res.writeHead(upRes2.statusCode, { 'Content-Type': upRes2.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
                  res.end(Buffer.concat(c2));
                } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
              });
              upRes2.on('error', () => { try { res.end(); } catch (_) {} });
              return;
            }
            handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes2, upReq2, dgBuilt, ctx, (why) => {
              lastErrStatus = 502; lastErrMsg = why;
              return retrySameOrNext(why);
            });
          }, undefined, undefined);
        }
      }

      if (upRes.statusCode >= 400) {
// Non-retryable error (e.g. 400) or last candidate -> pass the error through unchanged
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          stats.errors++;
          recordReq(upRes.statusCode, ch.name, 0, 0);
          log('UPERR', ctx.logMeta, 'status=' + upRes.statusCode, attempt > 1 ? '(已尝试 ' + attempt + ' 个渠道)' : '');
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
            res.end(Buffer.concat(chunks));
          } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
        });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }

      // success (2xx) -> normal handling; no more fallback from here (a non-JSON body faking success can still be retried via the hook)
      handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes, upReq, built, ctx, (why) => {
        lastErrStatus = 502; lastErrMsg = why;
        return retrySameOrNext(why);
      });
    }, undefined, fresh ? makeFreshAgents(cfg, ch) : undefined);
    if (delayMs > 0) {
      ch._gate = (ch._gate || Promise.resolve()).catch(() => {}).then(() => new Promise(r => setTimeout(r, delayMs)));
      ch._gate.then(() => { try { doSend(); } catch (e) { try { sendError(clientFormat, res, 500, 'upstream dispatch failed: ' + e.message); } catch (_) {} } });
    } else {
      doSend();
    }
  };
  tryNext();
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, instName, writeRequestRecord, postRequestRecord, handleUpstreamResponse, handleChat };
