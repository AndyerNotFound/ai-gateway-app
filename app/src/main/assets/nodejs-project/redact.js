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
const { logErr } = require('./util');

// ================= Redaction (redact) =================
const redactCache = require('./redact-cache.js'); // CDC 增量分块缓存: 干净内容只算 hash, 命中跳过正则

/* ---- Privacy filter: replace secrets/tokens in the request body with *** ---- */
const REDACT_PATTERNS = [
/\bsk-[A-Za-z0-9_-]{10,}/g,            // OpenAI/DeepSeek/Anthropic style
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /\bAKIA[0-9A-Z]{16}/g,                  // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g,            // Google
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          // GitLab
  /\bhf_[A-Za-z0-9]{20,}/g,               // HuggingFace
/\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     // Bearer headers pasted into text
];
const REDACT_FIELD_RE = /api[-_]?key|apikey|secret|password|passwd|token|authorization/i;
function redactText(s, extra) {
  return redactCache.redactSmart(s, extra);
}
/* Response-direction filter switch (instance redact.enable is the ceiling, further ANDed with redact.response;
 * a card's redact=false mirrors the request direction, disabling it per card) */
function respRedactOn(cfg, urlInfo) {
  if (!(cfg && cfg.redact && cfg.redact.enable !== false && cfg.redact.response)) return false;
  return !(urlInfo && urlInfo.userKey && urlInfo.userKey.redact === false);
}
function redactDeep(v, extra, depth) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') return v.startsWith('data:') ? v : redactText(v, extra); // 跳过 data:URL(图片/音频)
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = redactDeep(v[i], extra, depth + 1); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (depth === 0 && k === 'model') continue;   // 不动模型名, 保护路由
      const val = v[k];
      if (typeof val === 'string' && val && REDACT_FIELD_RE.test(k)) v[k] = '***';
      else v[k] = redactDeep(val, extra, depth + 1);
    }
    return v;
  }
  return v;
}
/* Streaming response filter: text/thinking/tool args buffered separately; secrets split across chunks are still caught;
 * Only tail tokens that might still grow are held back; everything else streams as it arrives. */
function wrapRedactWriter(baseWriter, extra) {
  const textF = redactCache.createStreamFilter(extra);
  const reasF = redactCache.createStreamFilter(extra);
  const toolFs = new Map();
  let done = false;
  const send = (ev) => { try { baseWriter.onEvent(ev); } catch (e) { logErr('redact writer error:', e.message); } };
  const flushText = () => { const o = textF.flush(); if (o) send({ type: 'text', t: o }); };
  const flushReas = () => { const o = reasF.flush(); if (o) send({ type: 'reasoning', t: o }); };
  const flushTools = () => {
    const keys = [...toolFs.keys()].sort((a, b) => a - b);
    for (const i of keys) { const o = toolFs.get(i).flush(); if (o) send({ type: 'tool_delta', i, s: o }); }
    toolFs.clear();
  };
  const flushAll = () => { flushText(); flushReas(); flushTools(); };
  return {
    onEvent(ev) {
      if (!ev || !ev.type || done) return;
      if (ev.type === 'text') { const o = textF.push(ev.t); if (o) send({ type: 'text', t: o }); return; }
      if (ev.type === 'reasoning') { const o = reasF.push(ev.t); if (o) send({ type: 'reasoning', t: o }); return; }
      if (ev.type === 'tool_delta') {
        let f = toolFs.get(ev.i);
        if (!f) { f = redactCache.createStreamFilter(extra); toolFs.set(ev.i, f); }
        const o = f.push(ev.s); if (o) send({ type: 'tool_delta', i: ev.i, s: o });
        return;
      }
      if (ev.type === 'end') { done = true; flushAll(); send(ev); return; }
      flushText(); flushReas(); send(ev);   // start/tool_start/usage: flush buffers first to preserve event order
    },
  };
}
module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, redactCache, REDACT_PATTERNS, REDACT_FIELD_RE, redactText, respRedactOn, redactDeep, wrapRedactWriter };
