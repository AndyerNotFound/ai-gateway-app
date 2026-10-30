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
const { poolRoute, BILLING_PATHS, GENERIC_BALANCE_PATHS, createInstancePool, poolLoadAll, setupModelSync, statsFlushFile, setupStatsFlush } = require('./pool');
const { sendError, corsHeaders, jsonErr, checkAuth, keyCreditsJSON, genApiKey, persistRuntimeCfg, availableBranches, collectJson, modelsResponse, sendJson, loadKeyUsage, makeGatewayApi } = require('./router');
const { VERSION, utf8, log, logErr } = require('./util');
const { balanceAggregate, pickBalanceChannel, fetchBalanceCached, fetchChannelBalance, setupProbe } = require('./upstream');
const { fetchUpstreamModels, syncModels } = require('./sync');
const { handleExtraEndpoint } = require('./passthrough');
const { handleChat } = require('./record');
const { applyDefaults } = require('./config');
const rt = require('./runtime');
const admin = require('./admin');
const { handleAdmin } = admin;
const state = require('./state');
const panelAuth = require('./panel-auth');
const hot = require('./hot');

// ================= HTTP service =================
const GEMINI_RE = /^\/v1(?:beta|alpha)?\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)$/;
// Any /v1/* path not handled by a conversion entry forwards verbatim to the openai channel (isPassthru → handleExtraEndpoint); always on.

async function handleHttp(cfg, req, res) {
  hot.track(req, res);
  const u = new URL(req.url, 'http://localhost');
  let p = u.pathname;

// ===== Multi-instance routing: compat port → /<inst>/ prefix → default =====
  if (state.CUR_POOL) {
    const r = poolRoute(state.CUR_POOL, req, p);
    if (r.error) { sendError('openai', res, r.status || 404, r.error); return; }
    cfg = r.cfg;
    p = r.path;
    if (r.name) req._branchName = r.name;
// Branch whitelist: a card with non-empty branches may only reach the instances in that list
    if (req._branchName) {
      const h = req.headers;
      const auth = h.authorization || '';
      const presented = (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '') || h['x-api-key'] || h['x-goog-api-key'] || u.searchParams.get('key') || '';
      if (presented) {
        for (const [, c] of state.CUR_POOL.instances) {
          const uk = (c.apiKeys || []).find(k => k.key && k.key === presented);
          if (uk && Array.isArray(uk.branches) && uk.branches.length && !uk.branches.includes(req._branchName)) {
            return sendError('openai', res, 403, '此卡密不允许访问分组: ' + req._branchName + ' (可用: ' + uk.branches.join(', ') + ')');
          }
        }
      }
    }
  }

  if (cfg.cors && req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }

// ===== Public route whitelist (2026-10-27): only /v1 /v1beta /auth /profile /admin pass (panel uses a one-time login link / session cookie) =====
// Everything else 404s: /health /status* /user /plugins /credits are all closed; re-add when needed
  const allowed = p === '/v1' || p.startsWith('/v1/')
    || p === '/v1beta' || p.startsWith('/v1beta/')
    || p === '/auth' || p.startsWith('/auth/')
    || p === '/profile' || p.startsWith('/profile/')
    || p === '/admin' || p.startsWith('/admin/');
  if (!allowed) return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);

// ===== Removed user-side endpoints (2026-10): keep them 404 instead of falling through as panel assets =====
  if (p === '/auth/login' || p === '/auth/register' || p === '/auth/me' || p === '/auth/profile'
      || p === '/auth/mykeys' || p.startsWith('/auth/mykeys-')) {
    return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);
  }

// ===== Web admin panel (/admin + /admin/api/*) =====
// /auth/* is the panel itself: the one-time login link plus the static assets under m3/
  const isAuthFile = p.startsWith('/auth/');
  if (p === '/admin' || p === '/admin/' || p.startsWith('/admin/api/')
      || p === '/auth' || p === '/auth/' || isAuthFile
      || /^\/auth\/[A-Za-z0-9_-]{16,128}\/[A-Za-z0-9_-]{8,256}\/?$/.test(p)) {
    // admin pages need no upfront body collection; handleAdmin handles it internally
// but POST/DELETE bodies must be collected first
    if (req.method === 'POST' || req.method === 'DELETE') {
      let adminBody = '';
const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
      req.on('data', c => { adminBody += u8(c); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { handleAdmin(cfg, req, res, u, p, adminBody).catch(e => jsonErr(res, e)); });
      req.on('error', () => {});
    } else {
      return handleAdmin(cfg, req, res, u, p, '');
    }
    return;
  }
// ===== Accessible branch list (card auth, filtered by branches) =====
  if (p === '/v1/branches' && req.method === 'GET') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({ branches: availableBranches(cfg, authR.userKey) }));
  }

  if (req.method === 'GET' && (p === '/v1/models' || p === '/v1beta/models')) {
    const fmt = p === '/v1beta/models' ? 'gemini' : 'openai';
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError(fmt, res, authR.status || 401, authR.error || 'invalid key');
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(modelsResponse(cfg, fmt)));
  }

// ===== Upstream balance passthrough (OpenAI semantics, recognizable by third-party clients) =====
//   GET /v1/dashboard/billing/credit_grants -> credit_summary (total_available = upstream balance)
//   GET /v1/dashboard/billing/subscription  -> billing_subscription (hard/soft_limit_usd = upstream balance)
//   ?ch=<channel> picks a channel (default when omitted); key cards may only pick channels from their own channels whitelist
  if (req.method === 'GET' && BILLING_PATHS.has(p)) {
    const t0 = Date.now();
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    const isGrants = p.endsWith('credit_grants');
    const uk = authR.userKey || null;
    const want = String(u.searchParams.get('ch') || u.searchParams.get('channel') || '').trim();
    let ch = null;
    if (want) {
      ch = (cfg.channels || []).find(c => c.name === want) || null;
      if (!ch) return sendError('openai', res, 404, '渠道不存在: ' + want);
      const cardWl = uk && Array.isArray(uk.channels) && uk.channels.length ? uk.channels : null;
      const allowed = !!authR.admin || !cardWl || cardWl.includes(want);
      if (!allowed) return sendError('openai', res, 403, '此卡密不允许查询渠道余额: ' + want);
    } else if (GENERIC_BALANCE_PATHS.has(p)) {
// Multi-channel aggregation (generic balance alias): concurrently query every visible channel with a balance target -> convert to base currency and sum
      return balanceAggregate(cfg, uk, (agg) => {
        if (!agg.ok) return sendError('openai', res, agg.status || 503, agg.error);
        return sendJson(res, 200, {
          ...agg,
          data: { total_remain: agg.total_remain, unit: agg.unit, channels: agg.channels, partial: agg.partial, ok_count: agg.ok_count },
        });
      });
    } else {
      ch = pickBalanceChannel(cfg, uk);
      if (!ch) return sendError('openai', res, 503, '本实例没有可查询余额的渠道(可在渠道配置里填 balanceUrl + balancePath)');
    }
    const finish = (r, cached) => {
      if (!r.ok) {
        log('UPERR', '[balance]', ch.name, (isGrants ? 'credit_grants' : 'subscription'), 'status=' + (r.status || 502), r.error || '');
        return sendError('openai', res, r.status || 502, r.error || 'balance query failed');
      }
      log('[balance]', ch.name, (isGrants ? 'credit_grants' : 'subscription'), 'channel=' + ch.name, 'unit=' + (r.unit || '-'), 'ms=' + (Date.now() - t0) + (cached ? ' (cached)' : ''));
      const num = Number(r.balance);
      const avail = isFinite(num) ? num : null;
      const common = { channel: ch.name, balance: r.balance, unit: r.unit || '', upstream_url: r.url };
// Generic balance shape: compatible with any client's "balance path + JSON key" config (provides total_remain / balance / remaining / total_available)
      if (GENERIC_BALANCE_PATHS.has(p)) {
        const generic = { total_remain: avail, balance: r.balance, total_available: avail, total_granted: avail, total_used: 0, remaining: avail, unit: r.unit || '', channel: ch.name };
        return sendJson(res, 200, { ...generic, data: { ...generic, upstream_url: r.url } });
      }
      if (isGrants) return sendJson(res, 200, { object: 'credit_summary', total_granted: avail, total_used: 0, total_available: avail, grants: { object: 'list', data: [] }, ...common });
      return sendJson(res, 200, {
        object: 'billing_subscription', has_payment_method: true, canceled: false, canceled_at: null, delinquent: null,
        access_until: Math.floor(Date.now() / 1000) + 31536000,
        soft_limit_usd: avail, hard_limit_usd: avail, system_hard_limit_usd: avail,
        plan: { title: 'ai-gateway', id: 'ai-gateway' }, account_name: ch.name, ...common,
      });
    };
    try {
      fetchBalanceCached(cfg, ch, finish);
    } catch (e) {
      logErr('[balance] 查询异常:', e.message);
      sendError('openai', res, 500, 'balance query failed: ' + e.message);
    }
    return;
  }

// Fallback passthrough decision: any /v1/* not owned by a conversion entry -> forwards verbatim to the openai channel
// (fixed gateway behavior: files/batches/vector_stores/images/embeddings/audio/completions/moderations etc. always pass through)
  const isConvEndpoint = (q) => (
    q === '/v1/chat/completions' || q === '/chat/completions' ||
    q === '/v1/messages' || q === '/messages' ||
    q === '/v1/responses' || GEMINI_RE.test(q)
  );
  const isPassthru = p.startsWith('/v1/') && !isConvEndpoint(p);

  // unknown non-POST endpoint: if the path looks like a balance/usage query, log one line (to add aliases later); passthrough paths go through
  if (req.method !== 'POST' && !isPassthru) {
    if (/balance|quota|credit|billing|usage|wallet|cost|spend|money/i.test(p)) {
      log('[balance] 未命中的余额系路径:', req.method, p, '(可补进 BILLING_PATHS 别名)');
    }
    return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);
  }

  let clientFormat = null;
  let clientApi = 'chat';
  const urlInfo = { model: null, altSse: false };
  if (p === '/v1/chat/completions' || p === '/chat/completions') clientFormat = 'openai';
  else if (p === '/v1/messages' || p === '/messages') clientFormat = 'claude';
  else if (p === '/v1/responses') {
    clientFormat = 'openai';
    clientApi = 'responses';
  } else {
    const m = GEMINI_RE.exec(p);
    if (m) {
      clientFormat = 'gemini';
      urlInfo.model = decodeURIComponent(m[1]);
      urlInfo.altSse = u.searchParams.get('alt') === 'sse';
      urlInfo.stream = m[2] === 'streamGenerateContent';
      if (m[2] === 'countTokens') return sendError('gemini', res, 501, 'countTokens is not supported by this gateway');
    }
  }
// OpenAI fallback passthrough: any /v1/* (not handled by the conversion entries above) forwards verbatim to the openai channel
// Preserves method (GET/POST/PUT/PATCH/DELETE), query, multipart, binary/streaming
  if (!clientFormat && isPassthru) {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    const ct = req.headers['content-type'] || '';
    const chunks = [];
    let size = 0, aborted = false;
    req.on('data', c => {
      if (aborted) return;
      size += c.length;
      if (size > cfg.maxBodyBytes) { aborted = true; req.destroy(); sendError('openai', res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)'); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) handleExtraEndpoint(cfg, req, res, p + (u.search || ''), Buffer.concat(chunks), ct, req.method); });
    req.on('error', () => {});
    return;
  }
  if (!clientFormat) return sendError('openai', res, 404, 'unknown endpoint: ' + p + ' (支持: /v1/chat/completions | /v1/messages | /v1beta/models/{model}:generateContent|:streamGenerateContent; 其余 /v1/* 原样透传到 openai 渠道)');

  const authR = checkAuth(cfg, req, u.searchParams);
  if (!authR.ok) return sendError(clientFormat, res, authR.status || 401, authR.error || 'invalid key');
  urlInfo.userKey = authR.userKey || null;

  let bodyStr = '';
  let size = 0;
  let aborted = false;
  const u8chat = utf8();
  req.on('data', c => {
    if (aborted) return;
    size += c.length;
    if (size > cfg.maxBodyBytes) {
      aborted = true;
      req.destroy();
      sendError(clientFormat, res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)');
      return;
    }
    bodyStr += u8chat(c);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr);
    } catch (e) {
      logErr('chat crash:', e);
      sendError(clientFormat, res, 500, 'internal: ' + e.message);
    }
  });
  req.on('error', () => {});
}

function startServer(cfg, opts = {}) {
  state.CUR_CFG = cfg;
  applyDefaults(cfg);
  const cfgDir = cfg._configFile ? path.dirname(cfg._configFile) : path.join(os.homedir(), 'ai-gateway');
  admin.setDir(cfgDir);
  if (rt.PLUGINS) admin.setPlugins(rt.PLUGINS);

// ===== Multi-instance mode: one process hosts all config*.json in the dir; main-port path routing + compatibility listening on instance ports =====
  if (opts.multi) {
    const pool = createInstancePool(cfgDir);
    state.CUR_POOL = pool;
    pool.mainHost = opts.host || cfg.listen.host;
    admin.setPool(pool);
    admin.setUpstreamModels((ch, inst) => fetchUpstreamModels((inst && pool.instances.get(inst)) || cfg, ch));
    admin.setSyncFn((inst) => syncModels((inst && pool.instances.get(inst)) || cfg));
    admin.setBalanceFn((c, ch, cb) => fetchChannelBalance(c, ch, cb));
    poolLoadAll(pool, cfg);
    log(`ai-gateway v${VERSION} 就绪 (多实例单进程模式):`);
    log(`  主端口 ${pool.mainHost}:${pool.mainPort}${pool.mainTlsPort ? ' (https:' + pool.mainTlsPort + ')' : ''}  →  /实例名/v1/... 访问对应实例, 无前缀 = default`);
    for (const [name, c] of pool.instances) {
      const ports = [];
      for (const srv of pool.servers.values()) if (srv.name === name) ports.push((srv.tls ? 'https:' : '') + srv.port);
      log(`  实例 ${name}${c._disabled ? ' [已停用]' : ''}: ${c.channels.length} 渠道${ports.length ? ', 端口 ' + ports.join(',') : ''}`);
      for (const ch of c.channels) log(`    渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
    }
    return Promise.resolve({ pool, port: pool.mainPort, host: pool.mainHost, cfg });
  }

// ===== Single-instance mode =====
  try { panelAuth.ensure(cfg); } catch (e) { logErr('[panel] 初始化登录状态失败: ' + e.message); }
  admin.setUpstreamModels(ch => fetchUpstreamModels(cfg, ch));
  admin.setSyncFn(() => syncModels(cfg));
  admin.setBalanceFn((c, ch, cb) => fetchChannelBalance(c, ch, cb));
  setupModelSync(cfg);
  loadKeyUsage(cfg);
  setupProbe(cfg);
  if (rt.PLUGINS) { try { rt.PLUGINS.activateInstance(cfg._name || 'default', cfg, makeGatewayApi(cfg)); } catch (e) { logErr('[plugins] 激活失败: ' + e.message); } }
  cfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, retries: 0, byChannel: {}, recent: [] };
try { // cold-start restore
    const sf = statsFlushFile(cfg);
    if (fs.existsSync(sf)) {
      const j = JSON.parse(fs.readFileSync(sf, 'utf8'));
      cfg._stats.requests = j.requests || 0; cfg._stats.errors = j.errors || 0; cfg._stats.retries = j.retries || 0;
      cfg._stats.byChannel = j.byChannel || {}; cfg._stats.byKey = j.byKey || {};
      cfg._stats.byModel = j.byModel || {}; cfg._stats.daily = j.daily || {};
      cfg._stats.startedAt = j.since || cfg._stats.startedAt;
    }
  } catch (_) {}
  setupStatsFlush(cfg);
  const handler = (req, res) => {
    handleHttp(cfg, req, res).catch(e => {
      logErr('handler crash:', e);
      sendError('openai', res, 500, 'internal: ' + (e && e.message));
    });
  };
  const host = opts.host || cfg.listen.host;
  const port = opts.port != null ? opts.port : cfg.listen.port;

  let tlsCfg = null;  // populated only when TLS is on and the certificate actually loads
  if (cfg.tls && cfg.tls.enable) {
    const certPath = path.isAbsolute(cfg.tls.cert) ? cfg.tls.cert : path.join(path.dirname(cfg._configFile || process.cwd()), cfg.tls.cert);
    const keyPath = path.isAbsolute(cfg.tls.key) ? cfg.tls.key : path.join(path.dirname(cfg._configFile || process.cwd()), cfg.tls.key);
    try {
      tlsCfg = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      };
    } catch (e) {
      logErr(`⚠ TLS 已启用但证书读取失败: ${e.message}`);
      logErr(`  cert: ${certPath}`);
      logErr(`  key:  ${keyPath}`);
      logErr(`  请先运行 ~/ai-gateway/gen-cert.sh 生成证书, 或在 config.json 中设置 "tls": {"enable": false}`);
      logErr(`  (TLS 开启后该实例只在 listen.port 上提供 HTTPS, 不再有明文入口)`);
      logErr(`  本次将以纯 HTTP 模式启动`);
    }
  }

  if (!tlsCfg) {
    // pure HTTP mode
    const server = http.createServer(handler);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeAllListeners('error');
        const realPort = server.address().port;
        log(`ai-gateway v${VERSION} 就绪: http://${host === '0.0.0.0' ? '127.0.0.1(本机)/局域网IP' : host}:${realPort}  配置: ${cfg._configFile}`);
        for (const ch of cfg.channels) log(`  渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
        for (const [k, v] of Object.entries(cfg.proxies)) log(`  代理 ${k} = ${v.type}://${v.host}:${v.port}${v.username ? ' (带认证)' : ''}`);
        resolve({ server, port: realPort, host, cfg });
      });
    });
  }

  // TLS serves pure HTTPS on listen.port (tls.port is ignored: one entry per instance)
  const httpsPort = port;

  return new Promise((resolve, reject) => {
    const results = { servers: [], ports: [], cfg };

    const logReady = () => {
      log(`ai-gateway v${VERSION} 就绪 (配置: ${cfg._configFile}):`);
      for (const [p, scheme] of results.ports) {
        log(`  ${scheme}://${host === '0.0.0.0' ? '127.0.0.1(本机)/局域网IP' : host}:${p}`);
      }
      for (const ch of cfg.channels) log(`  渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
      for (const [k, v] of Object.entries(cfg.proxies)) log(`  代理 ${k} = ${v.type}://${v.host}:${v.port}${v.username ? ' (带认证)' : ''}`);
    };

    let pending = 1;
    const onReady = (server, p, scheme) => {
      results.servers.push(server);
      results.ports.push([p, scheme]);
      if (--pending === 0) { logReady(); resolve({ servers: results.servers, ports: results.ports, server: results.servers[0], port: results.ports[0][0], host, cfg }); }
    };
    const onErr = (e) => reject(e);

    const httpsServer = https.createServer({ cert: tlsCfg.cert, key: tlsCfg.key }, handler);
    httpsServer.once('error', onErr);
    httpsServer.on('tlsClientError', (err) => log('[tls] 握手失败 :' + httpsPort + ' ' + (err.code || err.reason || '') + ' ' + String(err.message || '').slice(0, 120)));
    httpsServer.listen(httpsPort, host, () => {
      httpsServer.removeAllListeners('error');
      onReady(httpsServer, httpsServer.address().port, 'https');
    });
  });
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, rt, admin, state, GEMINI_RE, handleHttp, startServer };
