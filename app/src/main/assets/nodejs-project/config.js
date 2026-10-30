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
const { redactCache } = require('./redact');
let crypt = null; try { crypt = require('./crypt.js'); } catch (_) {}

// ================= Config loading =================
/* ================= Config loading ================= */
function normalizeProxy(p) {
  if (!p) return null;
  if (typeof p === 'object') {
    const o = { type: String(p.type || 'socks5').toLowerCase(), host: String(p.host || ''), port: Number(p.port) };
    if (o.type === 'socks' || o.type === 'socks5h') o.type = 'socks5';
    if (p.username != null && p.username !== '') o.username = String(p.username);
    if (p.password != null && p.password !== '') o.password = String(p.password);
    if (!o.host || !o.port) return null;
    return o;
  }
// String: socks5://user:pass@host:port or http://host:port
  const m = /^(socks5h?|socks|http|https):\/\/(?:([^:@\/]+)(?::([^@\/]*))?@)?([^:\/@]+):(\d+)\/?$/i.exec(String(p).trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const o = { type: (scheme === 'http' || scheme === 'https') ? 'http' : 'socks5', host: m[4], port: Number(m[5]) };
  if (m[2] != null) o.username = decodeURIComponent(m[2]);
  if (m[3] != null && m[3] !== '') o.password = decodeURIComponent(m[3]);
  return o;
}

/* Channel-level path lock: exact upstream path appended to baseUrl.
 * Empty/absent = automatic (dialect-specific endpoint or client-path passthrough).
 * A path must start with '/', and is not allowed to be a full URL. */
function normalizeChannelPath(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) { logErr('[config] 渠道 path 不能是完整 URL, 已忽略: ' + s); return null; }
  if (s.charAt(0) !== '/') s = '/' + s;
  return s;
}

function applyDefaults(cfg) {
  delete cfg.openaiExtras;   // parameter removed: extended endpoints / Responses are fixed on
  cfg.listen = cfg.listen || {};
  cfg.listen.port = Number(cfg.listen.port || 16384);
  cfg.listen.host = String(cfg.listen.host || '0.0.0.0');
  cfg.gatewayKey = cfg.gatewayKey ? String(cfg.gatewayKey) : '';
// Key card list normalization
  cfg.apiKeys = Array.isArray(cfg.apiKeys) ? cfg.apiKeys.filter(k => k && k.key) : [];
  // Multi-user support was removed (2026-10-30): drop the legacy credential table and the
  // self-registration settings so they are never written back to disk.
  delete cfg.users;
  delete cfg.registration;
  // Old-token grace removed: a revoked webToken must stop working immediately.
  delete cfg.webTokenPrev;
  delete cfg.webTokenPrevUntil;
// Privacy filter: enable is the instance master switch; response filters the response direction; extra is custom regexes (string array)
  cfg.redact = (cfg.redact && typeof cfg.redact === 'object') ? cfg.redact : {};
  cfg.redact.enable = cfg.redact.enable !== false;
  cfg.redact.response = !!cfg.redact.response;
  cfg.redact.extra = Array.isArray(cfg.redact.extra) ? cfg.redact.extra.filter(p => typeof p === 'string' && p) : [];
// Key card length (8-128, default 24; sk- prefix excluded)
  cfg.keyLength = Math.min(128, Math.max(8, Number(cfg.keyLength) || 24));
  // success-rate probe normalization (off by default to save tokens)
  cfg.probe = cfg.probe && typeof cfg.probe === 'object' ? cfg.probe : {};
  cfg.probe.enable = !!cfg.probe.enable;
  cfg.probe.intervalMin = Math.max(1, Number(cfg.probe.intervalMin) || 10);
  if (!cfg.probe.mode) cfg.probe.mode = 'models';
  cfg.modelSync = cfg.modelSync && typeof cfg.modelSync === 'object' ? cfg.modelSync : {};
cfg.modelSync.enable = cfg.modelSync.enable !== false; // on by default
  cfg.modelSync.intervalHours = Math.max(1, Number(cfg.modelSync.intervalHours) || 24);
cfg.modelSync.intervalMin = Number(cfg.modelSync.intervalMin) > 0 ? Number(cfg.modelSync.intervalMin) : null; // loop: fetch=<minutes>
  // admin profile (agw admin profile)
  const __ap = (cfg.adminProfile && typeof cfg.adminProfile === "object") ? cfg.adminProfile : {};
  cfg.adminProfile = { name: String(__ap.name || ""), avatar: String(__ap.avatar || ""), profile: String(__ap.profile || ""), other: String(__ap.other || "") };
  const __panel = (cfg.panel && typeof cfg.panel === 'object') ? cfg.panel : {};
  cfg.panel = { openBrowser: __panel.openBrowser !== false };
cfg.adminExpireAt = Number(cfg.adminExpireAt) > 0 ? Number(cfg.adminExpireAt) : 0; // panel session expiry (agw admin expire)
  cfg.maxBodyBytes = Number(cfg.maxBodyBytes || 64 * 1024 * 1024);
  cfg.connectTimeout = Number(cfg.connectTimeout || 15000);
  cfg.responseTimeout = Number(cfg.responseTimeout || 180000);
// Same-channel retry count for connection-level errors (socket hang up etc.), default 2; 0 = off
  if (cfg.connRetry === undefined) cfg.connRetry = 2;
  cfg.cors = cfg.cors !== false;
// Built-in DSML tool-call markup scrubbing for non-streaming JSON (on by default; dsmlClean:false disables; dsmlClean.reasoning:false scrubs content only, not thinking)
  const __dc = (cfg.dsmlClean && typeof cfg.dsmlClean === 'object') ? cfg.dsmlClean : {};
  cfg.dsmlClean = { enable: cfg.dsmlClean === false ? false : __dc.enable !== false, reasoning: __dc.reasoning !== false, backfill: __dc.backfill !== false };
// TLS config parsing
  cfg.tls = cfg.tls || (cfg.listen && cfg.listen.tls) || {};
  if (cfg.tls.enable) {
    cfg.tls.cert = String(cfg.tls.cert || 'cert.pem');
    cfg.tls.key = String(cfg.tls.key || 'key.pem');
cfg.tls.port = null; // legacy field, ignored: one entry per instance -- HTTPS on listen.port, never a plaintext twin
    delete cfg.tls.port;
  }
// Migration: adminKey is deprecated and merges into webToken (the single admin credential)
  if (cfg.adminKey && !cfg.webToken) { cfg.webToken = String(cfg.adminKey); }
  delete cfg.adminKey;
  cfg.webToken = cfg.webToken ? String(cfg.webToken) : '';
  if (cfg.proxies && typeof cfg.proxies === 'object' && !Array.isArray(cfg.proxies)) {
    const norm = {};
    for (const [k, v] of Object.entries(cfg.proxies)) {
      const n = (v && typeof v === 'object') ? v : normalizeProxy(v);
      if (n) norm[k] = n; else logErr(`[config] 跳过无效代理 "${k}"`);
    }
    cfg.proxies = norm;
  } else cfg.proxies = {};
  cfg.channels = cfg.channels || [];
// Balance aggregation FX convention: cfg.balanceFx = { base:'CNY', rates:{ CNY:1, USD:7.2 } }  (1 <currency> = X <base>)
// no built-in FX rates (hardcoding them goes stale); currencies without rates[unit] are excluded from totals and tagged no_rate
  cfg.balanceFx = (cfg.balanceFx && typeof cfg.balanceFx === 'object') ? cfg.balanceFx : {};
  cfg.balanceFx.base = String(cfg.balanceFx.base || 'CNY').trim() || 'CNY';
  cfg.balanceFx.rates = (cfg.balanceFx.rates && typeof cfg.balanceFx.rates === 'object') ? cfg.balanceFx.rates : {};
  if (!(Number(cfg.balanceFx.rates[cfg.balanceFx.base]) > 0)) cfg.balanceFx.rates[cfg.balanceFx.base] = 1;
  return cfg;
}

//// thinking-chain truncation (sync, zero latency): split by lines, keep the first maxChars of each; long lines are cut into strides, each keeping its head
function loadConfig(file) {
redactCache.reset(); // the config may have changed extra regexes; the privacy-filter cache must be invalidated
  let raw = fs.readFileSync(file, 'utf8');
  if (crypt && crypt.isEncText(raw)) {
    const pass = crypt.loadPass();
    if (!pass) throw new Error('配置已加密但找不到密钥: 请设置环境变量 AGW_CRYPT_PASS, 或确保 ' + crypt.KEY_FILE() + ' 存在且有效 (可用 node crypt.js test 检查)');
    raw = crypt.decryptText(raw, pass);
  }
  const cfg = JSON.parse(raw);
  cfg._configFile = path.resolve(file);
  applyDefaults(cfg);

  const proxiesIn = cfg.proxies || cfg.proxyList || {};
  cfg.proxies = {};
  for (const [k, v] of Object.entries(proxiesIn)) {
    const n = (v && typeof v === 'object') ? v : normalizeProxy(v);
    if (n) cfg.proxies[k] = n; else logErr(`[config] 跳过无效代理 "${k}"`);
  }

  const TYPES = ['openai', 'gemini', 'claude'];
  const channelsIn = cfg.channels || cfg.channelList || [];
  cfg.channels = [];
  let i = 0;
  for (const ch of channelsIn) {
    i++;
    if (!ch || !TYPES.includes(String(ch.type || '').toLowerCase())) { logErr(`[config] 渠道 #${i} type 无效(应为 openai/gemini/claude), 跳过`); continue; }
    if (!ch.baseUrl) { logErr(`[config] 渠道 "${ch.name || i}" 缺 baseUrl, 跳过`); continue; }
    cfg.channels.push({
      name: String(ch.name || ('channel-' + i)),
      type: String(ch.type).toLowerCase(),
      baseUrl: String(ch.baseUrl).replace(/\/+$/, ''),
      path: normalizeChannelPath(ch.path),
      apiKey: ch.apiKey != null ? String(ch.apiKey) : '',
      proxy: ch.proxy != null && ch.proxy !== '' ? String(ch.proxy) : null,
      insecure: !!ch.insecure,
      models: Array.isArray(ch.models) ? ch.models.map(String) : null,
      modelMap: (ch.modelMap && typeof ch.modelMap === 'object' && !Array.isArray(ch.modelMap)) ? ch.modelMap : null,
      default: !!ch.default,
      delayMs: Math.max(0, Number(ch.delayMs) || 0),
      // channel locking (loop: chan lock/unlock) and DSML scrub override (loop: chan edit transcreet)
lockAt: Number(ch.lockAt) > 0 ? Number(ch.lockAt) : null,   // when the lock starts (ms epoch)
lockUntil: Number(ch.lockUntil) > 0 ? Number(ch.lockUntil) : null, // when it auto-unlocks (ms epoch; empty = manual unlock)
      transcreet: ['on', 'off', 'res-only'].includes(String(ch.transcreet || '').toLowerCase()) ? String(ch.transcreet).toLowerCase() : null,
      useResponses: ch.useResponses === undefined ? undefined : !!ch.useResponses,
      probe: !!ch.probe,
      addUsage: ch.addUsage !== false,
      anthropicVersion: ch.anthropicVersion ? String(ch.anthropicVersion) : null,
// Balance passthrough (channel-level overrides of built-in presets) -- must be whitelisted, otherwise the runtime cannot see it and persistRuntimeCfg wipes the value from the config file
      balanceUrl: ch.balanceUrl ? String(ch.balanceUrl) : null,
      balancePath: ch.balancePath ? String(ch.balancePath) : null,
      balanceUnit: ch.balanceUnit ? String(ch.balanceUnit) : null,
// Balance warning threshold (channel-level, display only, not interpreted by the gateway): "5" or "CNY=5,USD=1"
      warnBelow: ch.warnBelow == null || ch.warnBelow === '' ? null
        : (typeof ch.warnBelow === 'string' ? String(ch.warnBelow) : JSON.stringify(ch.warnBelow)),
    });
    const last = cfg.channels[cfg.channels.length - 1];
    if (!/^[\x09\x20-\x7e]*$/.test(last.apiKey)) logErr(`⚠ [config] 渠道 "${last.name}" 的 apiKey 含中文/非ASCII字符(像占位符?), 请求会失败, 请填入真实 Key`);
    if (!last.apiKey) logErr(`⚠ [config] 渠道 "${last.name}" 没有填 apiKey`);
  }
  return cfg;
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, crypt, normalizeProxy, applyDefaults, loadConfig };
