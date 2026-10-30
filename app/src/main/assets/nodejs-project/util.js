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

// ================= Small utilities (formerly inlined in gateway.js) =================
const VERSION = '1.4.8';

/* ================= Small utilities ================= */
function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log('[' + ts() + ']', ...a); }
function logErr(...a) { console.error('[' + ts() + ']', ...a); }

const { StringDecoder } = require('string_decoder');
/* *Chunk-safe decoding (2026-09-18): when a multi-byte character is split across TCP chunks, per-chunk toString('utf8') produces
 *  U+FFFD mojibake (hits both response streams and request bodies; only chunk timing decides). Usage: const u8 = utf8(); buf += u8(chunk); */
function utf8() { const sd = new StringDecoder('utf8'); return (buf) => sd.write(buf); }

/*/* *HTTP header values must be Latin-1: a channel name containing CJK (e.g. a Chinese relay's name) written into
 *  X-AI-Gateway-Channel makes res.writeHead() throw ERR_INVALID_CHAR; this code used to
 *  swallow the throw with `catch (_) { return; }` -> the request neither answered the client nor read the upstream, hanging forever
 *  (reproduced on ai-gateway-core 2026-09-18). Percent-encode uniformly; decodeURIComponent restores it. */
function hdrName(s) {
  const t = String(s == null ? '' : s);
  let out = '';
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp <= 0x7e) { out += ch; continue; }
    let b;
    if (cp < 0x800) b = [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
    else if (cp < 0x10000) b = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    else b = [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    for (const x of b) out += '%' + x.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
function randId(prefix) { return prefix + crypto.randomBytes(10).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }

/* ---- Text replacement (user-defined regex rules, config.replace = {out:[{re,to,ci}],inc:[...]}) ---- */
function rpCompile(rules) {
  const out = [];
  for (const r of (rules || [])) {
    if (!r || !r.re) continue;
    try { out.push({ re: new RegExp(r.re, (r.ci ? 'i' : '') + 'g'), to: String(r.to == null ? '' : r.to) }); } catch (_) {}
  }
  return out;
}
function rpApplyText(s, rules) {
  for (const r of rules) s = s.replace(r.re, r.to);
  return s;
}
function rpWalk(v, rules, depth, skipModel) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') return v.startsWith('data:') ? v : rpApplyText(v, rules); // data:URL 不动(护图片)
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = rpWalk(v[i], rules, depth + 1, skipModel); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (skipModel && k === 'model') continue; // 不动 model 字段, 保护路由
      v[k] = rpWalk(v[k], rules, depth + 1, skipModel);
    }
    return v;
  }
  return v;
}

/* ---- Built-in DSML tool-call markup scrubbing (2026-10-15) ----
 * Symptom: some models (DeepSeek and derivatives on NVIDIA NIM etc.) additionally print tool-call markup text inside the content
 *   <｜DSML｜tool_calls> / <｜DSML｜invoke name="..."> / <｜DSML｜parameter name="...">…</…>
 *   the upstream also emitted structured tool_calls -> the client displayed the markup as content, making the chain and calls look disjointed.
 * Approach: tiny independent state machines for content/thinking (isolated per field -- unclosed markup in one field can never eat another field's content):
 *   (1) not eating: watch only "the last unclosed '<'"; it may start markup -> hold it back (at most DSML_TAG_MAX chars),
 *      once a tag closes without DSML inside, it is emitted verbatim -> plain text streams through byte-for-byte with no extra buffering;
 *   (2) on seeing a DSML opening tag (...calls> / ...invoke ...) -> enter the eating state until the matching closing tag (...calls> preferred, ...invoke> as fallback);
 *   (3) eating state fills past DSML_BLOCK_MAX with no closing tag -> decide "the user is simply discussing this markup" and **put it back verbatim** (fail open); content is never eaten;
 *   (4) still eating at stream end (markup truncated by the upstream) -> drop: internal markup never reaches the user.
 * Cost: a markup-free response pays one extra indexOf('<'); zero buffering, zero latency.
 */
function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('');
  }
  return '';
}
function normStop(v) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.length ? v.map(String) : undefined;
  return [String(v)];
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, VERSION, ts, log, logErr, utf8, hdrName, randId, nowSec, safeParse, rpCompile, rpApplyText, rpWalk, toText, normStop };
