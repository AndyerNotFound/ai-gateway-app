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
const { logErr, log, toText, utf8 } = require('./util');
const state = require('./state');
const admin = require('./admin');

// ================= Channel routing / auth / errors / model list =================
/* ================= Channel routing / auth / errors / model list ================= */

//// collect all channels matching the model, rotating the start by the round-robin counter
// Returns [{ ch, upstreamModel }, ...] (rotated; the first one is for this round)
//// channel lock check: lockAt = when the lock starts, lockUntil = when it unlocks (0/empty = locked until manually unlocked)
function channelLocked(ch, now) {
  if (!ch) return false;
  const t = now || Date.now();
  const at = Number(ch.lockAt) || 0, until = Number(ch.lockUntil) || 0;
  if (!at && !until) return false;
if (at && t < at) return false;         // lock time not reached yet
if (until && t >= until) return false;  // past the unlock time
  return true;
}
function pickChannels(cfg, model, forceName) {
const chs = (cfg.channels || []).filter(c => !channelLocked(c)); // locked channels stay out of routing
  const candidates = [];
  // manual routing: x-agw-channel header > instance forceChannel > auto match. A hit pins the single channel; no rotation
  const forced = forceName ? String(forceName).trim() : '';
  if (forced) {
    const hit = chs.find(c => c.name === forced);
    if (hit) {
      const um = (hit.modelMap && model && Object.prototype.hasOwnProperty.call(hit.modelMap, model))
        ? String(hit.modelMap[model]) : (model || '');
      return [{ ch: hit, upstreamModel: um, forced: true }];
    }
    logErr('[route] 手动路由的渠道不存在, 退回自动匹配: ' + forced);
  }
// One-shot routing: the channel picked in the floating ball, cleared after one use, never persisted
  if (cfg._onceChannel) {
    const onceName = String(cfg._onceChannel);
    const hit = chs.find(c => c.name === onceName);
    cfg._onceChannel = null;
    if (hit) {
      const um = (hit.modelMap && model && Object.prototype.hasOwnProperty.call(hit.modelMap, model))
        ? String(hit.modelMap[model]) : (model || '');
      log('[route] 一次性路由命中: ' + onceName);
      return [{ ch: hit, upstreamModel: um, once: true }];
    }
    logErr('[route] 一次性路由的渠道已不存在, 走自动匹配: ' + onceName);
  }
  if (model) {
// 1) exact hit in modelMap
    for (const ch of chs) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
      }
    }
// 2) hit in the models list (avoids adding the same channel twice via modelMap)
    if (!candidates.length) {
      for (const ch of chs) {
        if (ch.models && ch.models.includes(model)) candidates.push({ ch, upstreamModel: model });
      }
    }
  }
// 3) no exact hit -> fall back to default channel(s) (possibly several) or all channels
  if (!candidates.length) {
    const defs = chs.filter(c => c.default);
    const pool = defs.length ? defs : chs;
    for (const ch of pool) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
// round-robin: a counter keyed by model decides the starting offset
  if (!cfg._rr) cfg._rr = {};
  const key = model || '__nomodel__';
  cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
  const rot = cfg._rr[key];
  return candidates.slice(rot).concat(candidates.slice(0, rot));
}

// Request/instance-level forced channel: the header wins (this request only), then instance config
function forcedChannelName(cfg, req) {
  const h = (req && req.headers) ? String(req.headers['x-agw-channel'] || '').trim() : '';
  if (h) return h;
  return cfg.forceChannel ? String(cfg.forceChannel) : '';
}

//// model-name glob matching (* = anything), case-insensitive
function globMatch(pat, str) {
  const esc = String(pat).split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try { return new RegExp('^' + esc + '$', 'i').test(String(str)); } catch (_) { return false; }
}

//// rough prompt token estimate: only for the hard limit's upfront block, not real tokenization
// CJK counts ~1 token per character; everything else ~1 token per charsPerToken characters (default 4)
const CJK_RE = /[\u3000-\u9fff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/g;
// Allocation-free CJK counting (range check equivalent to the old CJK_RE): avoids match-array allocation on large contexts
function countCjk(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) ||
        (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) n++;
  }
  return n;
}
//// rough token estimate (not real tokenization): CJK ~1 token per char, others ~1 token per cpt chars
function tokOf(str, cpt) {
  str = String(str || '');
  if (!str) return 0;
  const cjk = countCjk(str);
  return Math.ceil(cjk + (str.length - cjk) / cpt);
}

// Request-side single scan (2026-10-27 refactor): total + distribution (tools/system/user/history) in one pass
// history = assistant/tool turns, kept separate from system (the prompt), so you can tell prompt bloat from history bloat
function analyzePrompt(canonical, charsPerToken) {
  const cpt = Math.max(1, Number(charsPerToken) || 4);
  const dist = { tools: 0, system: 0, user: 0, history: 0 };
  const msgs = Array.isArray(canonical && canonical.messages) ? canonical.messages : [];
  if (Array.isArray(canonical && canonical.tools)) dist.tools = tokOf(JSON.stringify(canonical.tools), cpt);
  for (const m of msgs) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') { dist.system += tokOf(toText(m.content), cpt) + 4; continue; }
    if (m.role === 'user') { dist.user += tokOf(toText(m.content), cpt) + 4; continue; }
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) { const fn = (tc && tc.function) || {}; dist.history += tokOf(fn.name, cpt) + tokOf(fn.arguments, cpt); }
    dist.history += tokOf(toText(m.content), cpt) + 4;
  }
  dist.history += Math.ceil(msgs.length * 0.5);
  return { total: dist.tools + dist.system + dist.user + dist.history, dist };
}
// Backward compatible with old callers
function estimatePromptTokens(canonical, charsPerToken) { return analyzePrompt(canonical, charsPerToken).total; }
function estimatePromptDist(canonical, charsPerToken) { return analyzePrompt(canonical, charsPerToken).dist; }

// ---- Self-calibration (2026-10-27): per-model EMA of real input / local estimate, stored in byModel[n].estRatio with stats ----
const EST_RATIO_MIN = 0.1, EST_RATIO_MAX = 10, EST_EMA_A = 0.2;
function calibRatio(cfg, model) {
  const bm = cfg && cfg._stats && cfg._stats.byModel && cfg._stats.byModel[model];
  const r = bm && Number(bm.estRatio);
  return (r >= EST_RATIO_MIN && r <= EST_RATIO_MAX) ? r : 1;
}
function calibUpdate(cfg, model, actual, rawEst) {
  if (!(actual > 0) || !(rawEst > 0)) return;
  const stats = cfg._stats = cfg._stats || {};
  stats.byModel = stats.byModel || {};
  const bm = stats.byModel[model] = stats.byModel[model] || { requests: 0, inputTokens: 0, outputTokens: 0, cached: 0 };
  const r = Math.min(EST_RATIO_MAX, Math.max(EST_RATIO_MIN, actual / rawEst));
  bm.estRatio = bm.estRatio ? bm.estRatio * (1 - EST_EMA_A) + r * EST_EMA_A : r;
}
//// with real usage, normalize the distribution to the real input so the three parts sum to it (consistent convention)
function scaleDist(dist, rawTotal, actualInput) {
  if (!(actualInput > 0) || !(rawTotal > 0)) return dist;
  const f = actualInput / rawTotal, out = {};
  for (const k in dist) out[k] = Math.round(dist[k] * f);
  return out;
}

// Backward compatibility: return the first candidate
function pickChannel(cfg, model) {
  const cs = pickChannels(cfg, model);
  return cs.length ? cs[0] : null;
}

/* ---- Helper: collect a JSON body ---- */
function collectJson(req, res, cb) {
  let body = '';
const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
  req.on('data', c => { body += u8(c); if (body.length > 262144) req.destroy(); });
  req.on('end', () => { let j; try { j = JSON.parse(body || '{}'); } catch (_) { return sendError('openai', res, 400, 'bad json'); } cb(j); });
  req.on('error', () => {});
}
// Instances a key card may reach (empty = all)
function availableBranches(cfg, userKey) {
  const all = state.CUR_POOL ? [...state.CUR_POOL.instances.keys()].filter(n => { const c = state.CUR_POOL.instances.get(n); return c && !c._disabled; }) : [cfg._name || 'default'];
if (!userKey) return all; // admin/keyless: everything
  const b = userKey.branches || [];
  return b.length ? all.filter(n => b.includes(n)) : all;
}

/* ---- Key card generation (configurable length 8-128, base64url charset) ---- */
function genApiKey(len) {
  const n = Math.min(128, Math.max(8, Number(len) || 24));
  const bytes = Math.ceil(n * 3 / 4) + 2;
  return 'sk-' + crypto.randomBytes(bytes).toString('base64url').slice(0, n);
}

/* ---- Persist runtime config (strips _-prefixed runtime fields; reuses admin.saveCfg) ---- */
function persistRuntimeCfg(cfg) {
  try {
    const clean = JSON.parse(JSON.stringify(cfg, (k, v) => (k && k[0] === '_') ? undefined : v));
    admin.saveCfg(cfg._name || 'default', clean);
  } catch (e) { logErr('[persist] 配置落盘失败:', e.message); }
}

// Key card balance JSON (/credits response)
function keyCreditsJSON(uk) {
  const quota = Number(uk.quotaTokens) || 0;
  const used = Number(uk.usedTokens) || 0;
  return {
    name: uk.name || '', uid: uk.uid || '',
    quotaTokens: quota, usedTokens: used,
    remainingTokens: quota > 0 ? Math.max(0, quota - used) : null,
    unlimited: quota <= 0,
    expiresAt: uk.expiresAt || '',
    models: uk.models || [],
  };
}

// Auth: returns {ok, admin, userKey, status, error}
//  - admin=true: gatewayKey matched (or keyless no-auth mode)
//  - userKey: matched an apiKeys card (quota/expiry/disabled/model whitelist checked here)
function checkAuth(cfg, req, query) {
  const h = req.headers;
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const presented = bearer || h['x-api-key'] || h['x-goog-api-key'] || (query && query.get('key')) || '';
  if (cfg.gatewayKey && presented && presented === cfg.gatewayKey) return { ok: true, admin: true };
  const keys = cfg.apiKeys || [];
  if (keys.length && presented) {
    const uk = keys.find(k => k.key && k.key === presented);
    if (uk) {
      if (uk.enable === false) return { ok: false, status: 401, error: 'key 已禁用' };
      if (uk.expiresAt) {
        const t = new Date(uk.expiresAt).getTime();
        if (!isNaN(t) && t < Date.now()) return { ok: false, status: 401, error: 'key 已过期 (' + uk.expiresAt + ')' };
      }
      if (uk.quotaTokens > 0 && (uk.usedTokens || 0) >= uk.quotaTokens)
        return { ok: false, status: 429, error: '额度已用尽 (' + (uk.usedTokens || 0) + '/' + uk.quotaTokens + ' tokens)' };
      return { ok: true, userKey: uk };
    }
  }
  // no gatewayKey and no card = keyless (backward compatible)
  if (!cfg.gatewayKey && !keys.length) return { ok: true, admin: true };
  return { ok: false, status: 401, error: 'invalid key' };
}

/* ---- Key card usage persistence (log/keyusage-<inst>.json, dirty-check flush every 30s) ---- */
function cfgDirOf(cfg) { return cfg._configFile ? path.dirname(cfg._configFile) : process.cwd(); }
function keyUsageFile(cfg) { return path.join(cfgDirOf(cfg), 'log', 'keyusage-' + (cfg._name || 'default') + '.json'); }
function loadKeyUsage(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(keyUsageFile(cfg), 'utf8'));
    for (const k of (cfg.apiKeys || [])) {
      const rec = j[k.key];
      if (rec && typeof rec.usedTokens === 'number') k.usedTokens = rec.usedTokens;
    }
  } catch (_) {}
}
function saveKeyUsage(cfg) {
  if (!(cfg.apiKeys || []).length) return;
  const j = {};
  for (const k of cfg.apiKeys) j[k.key] = { usedTokens: k.usedTokens || 0, name: k.name || '' };
  try { fs.mkdirSync(path.dirname(keyUsageFile(cfg)), { recursive: true }); fs.writeFileSync(keyUsageFile(cfg), JSON.stringify(j, null, 1)); } catch (_) {}
}
// dirty-check flush every 30s (all instances)
setInterval(() => {
  const cfgs = state.CUR_POOL ? [...state.CUR_POOL.instances.values()] : (state.CUR_CFG ? [state.CUR_CFG] : []);
  for (const c of cfgs) if (c._keyUsageDirty) { c._keyUsageDirty = false; saveKeyUsage(c); }
}, 30000).unref();

/* ---- Plugin gatewayApi factory: exposes restricted gateway capabilities to plugins ---- */
function makeGatewayApi(cfg) {
  return {
    // look up a key record by card token (lets plugins verify the caller's identity)
    findKey: (token) => (cfg.apiKeys || []).find(k => k && k.key && k.key === token) || null,
    // add card quota: implemented by reducing usedTokens (persisted via keyusage; config untouched)
    grantQuota: (keyId, tokens) => {
      const k = (cfg.apiKeys || []).find(x => x && x.key === keyId);
      if (!k || !(tokens > 0)) return false;
      k.usedTokens = Math.max(0, (k.usedTokens || 0) - tokens);
      cfg._keyUsageDirty = true;
      return true;
    },
  };
}

function corsHeaders() {
  if (!state.CUR_CFG || !state.CUR_CFG.cors) return {};
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
}

function jsonErr(res, e) {
  try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e && e.message) || String(e) })); } catch (_) {}
}

function sendJson(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
    res.end(JSON.stringify(obj));
  } catch (_) { try { res.end(); } catch (_) {} }
}

function sendError(format, res, status, message, code) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  let body;
  if (format === 'claude') body = { type: 'error', error: { type: 'api_error', message } };
  else if (format === 'gemini') body = { error: { code: status, message, status: code || 'INTERNAL' } };
  else body = { error: { message, type: 'gateway_error', code: code || String(status) } };
  try {
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify(body));
  } catch (_) { try { res.end(); } catch (_) {} }
}

function collectModels(cfg) {
  const set = [];
  for (const ch of (cfg.channels || [])) {
    if (ch.models) for (const m of ch.models) if (!set.includes(m)) set.push(m);
    if (ch.modelMap) for (const m of Object.keys(ch.modelMap)) if (!set.includes(m)) set.push(m);
  }
  return set;
}
function modelsResponse(cfg, format) {
  const ms = collectModels(cfg);
  if (format === 'gemini') {
    return { models: ms.map(m => ({ name: 'models/' + m, displayName: m, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] })) };
  }
// openai and claude fields merged so both SDKs can read it
  return { object: 'list', data: ms.map(m => ({ id: m, object: 'model', type: 'model', created: 1700000000, owned_by: 'ai-gateway', display_name: m })) };
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, state, admin, pickChannels, channelLocked, forcedChannelName, globMatch, CJK_RE, countCjk, tokOf, analyzePrompt, estimatePromptTokens, estimatePromptDist, EST_RATIO_MIN, calibRatio, calibUpdate, scaleDist, pickChannel, collectJson, availableBranches, genApiKey, persistRuntimeCfg, keyCreditsJSON, checkAuth, cfgDirOf, keyUsageFile, loadKeyUsage, saveKeyUsage, makeGatewayApi, corsHeaders, jsonErr, sendJson, sendError, collectModels, modelsResponse };
