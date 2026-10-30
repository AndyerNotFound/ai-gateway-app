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
const { pickChannels, forcedChannelName, sendError, corsHeaders } = require('./router');
const { log, hdrName, logErr } = require('./util');
const { upstreamRequest, joinUrl } = require('./upstream');
const { isConnErr, makeFreshAgents } = require('./proxy');
const { RETRYABLE } = require('./sync');
const { redactText } = require('./redact');

// ================= Extended OpenAI endpoint passthrough =================
/* ================= Extended OpenAI endpoint passthrough (images/embeddings/audio/completions/moderations) ================= */
// OpenAI-type channels only: forwards verbatim (JSON endpoints apply modelMap renames; multipart stays a Buffer), responses pass through; basic failover included
function handleExtraEndpoint(cfg, req, res, pathname, bodyBuf, contentType, method) {
  const stats = cfg._stats;
  let model = '';
  let parsed = null;
  if (contentType && contentType.startsWith('application/json')) {
    try { parsed = JSON.parse(bodyBuf.toString('utf8')); model = (parsed && parsed.model) || ''; } catch (_) {}
  }
  const candidates = pickChannels(cfg, model || undefined, forcedChannelName(cfg, req)).filter(c => c.ch.type === 'openai');
  if (!candidates.length) {
    stats.errors++;
    return sendError('openai', res, 503, 'no openai channel for extended endpoint ' + pathname + ' (扩展端点只支持 openai 类型渠道)');
  }
  stats.requests++;
  log('[extra]', pathname, 'model=' + (model || '-'));
  let attempt = 0;
  let lastErr = '';
  const tryNext = () => {
    if (attempt >= candidates.length) {
      stats.errors++;
      return sendError('openai', res, 502, lastErr || ('all ' + candidates.length + ' channels failed'));
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    attempt++;
    const headers = { authorization: 'Bearer ' + ch.apiKey };
    if (contentType) headers['Content-Type'] = contentType;
    for (const hk of ['openai-beta', 'openai-organization', 'openai-project']) {
      const hv = req.headers[hk];
      if (typeof hv === 'string' && hv) headers[hk] = hv;
    }
    for (const [hk, hv] of Object.entries(headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        stats.errors++;
        return sendError('openai', res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请修改 config.json`);
      }
    }
    let outBody = bodyBuf;
    if (parsed) {
      if (pick.upstreamModel && parsed.model !== undefined && parsed.model !== pick.upstreamModel) {
        parsed.model = pick.upstreamModel;
        outBody = Buffer.from(JSON.stringify(parsed));
      }
    }
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;
    log('[extra]', pathname, 'model=' + (model || '-'), 'ch=' + ch.name);
    let connRetries = 0;
    const maxConnRetry = Math.max(0, Number(cfg.connRetry) || 0);
    const sendBody = (method === 'GET' || method === 'HEAD') ? Buffer.alloc(0) : outBody;
    const targetPath = ch.path || pathname;   // channel path lock: exact override, client path/query ignored
    const doSend = (fresh) => upstreamRequest(cfg, ch, joinUrl(ch.baseUrl, targetPath), headers, sendBody, (err, upRes) => {
      if (err) {
        lastErr = 'upstream request failed: ' + err.message;
        if (isConnErr(err) && connRetries < maxConnRetry) {
          connRetries++;
          log('RETRY', '[extra]', pathname, err.message, '→ 同渠道重试 (' + connRetries + '/' + maxConnRetry + ')');
          return setTimeout(() => doSend(true), 400 * connRetries);
        }
        log('ERR', '[extra]', pathname, err.message, attempt < candidates.length ? '→ 切换渠道' : '→ 无更多渠道');
        if (attempt < candidates.length) return tryNext();
        stats.errors++;
        return sendError('openai', res, 502, lastErr);
      }
      if (upRes.statusCode >= 400 && RETRYABLE.has(upRes.statusCode) && attempt < candidates.length) {
        const sc = upRes.statusCode;
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErr = '渠道 ' + ch.name + ' 返回 ' + sc + ': ' + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 300);
          log('RETRY', '[extra]', pathname, 'status=' + sc, '→ 切换渠道 (' + (candidates.length - attempt) + ' 个剩余)');
          tryNext();
        });
        upRes.on('error', () => tryNext());
        return;
      }
      if (upRes.statusCode >= 400) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          stats.errors++;
          log('UPERR', '[extra]', pathname, 'status=' + upRes.statusCode);
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || contentType || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
            res.end(Buffer.concat(chunks));
          } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
        });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }
      // success -> passthrough (streaming/binary/audio included)
      try {
        res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || contentType || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders(), 'Cache-Control': 'no-cache' });
      } catch (e) { logErr('[resp] 响应头下发失败, 已中断该请求:', e.message); try { res.end(); } catch (_) {} try { upRes.resume(); } catch (_) {} return; }
      upRes.pipe(res);
    }, method, fresh ? makeFreshAgents(cfg, ch) : undefined);
    doSend();
  };
  tryNext();
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, handleExtraEndpoint };
