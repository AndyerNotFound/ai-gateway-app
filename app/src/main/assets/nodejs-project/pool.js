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
const { syncModels } = require('./sync');
const { logErr, log } = require('./util');
const { instName } = require('./record');
const { sendError, loadKeyUsage, makeGatewayApi } = require('./router');
const { loadConfig } = require('./config');
const { setupProbe } = require('./upstream');
const state = require('./state');
const rt = require('./runtime');
const panelAuth = require('./panel-auth');

// ================= Multi-instance pool (one process hosts every config*.json) =================
//   - main port = default instance's listen.port, routes /<instance>/ prefixes; no prefix = default
//   - plaintext instances keep their own compat port (old clients, no prefix needed)
//   - TLS instances listen nowhere themselves: only the main port's HTTPS + /<instance>/ reaches them
//   - config saves and instance create/rename/delete/start/stop all apply hot, no restart
const INST_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
// Reserved first path segments: never routed as an instance name (avoids clashing with API/admin endpoints)
const RESERVED_PATHS = new Set(['v1', 'v1beta', 'v1alpha', 'admin', 'health', 'status', 'favicon.ico', 'robots.txt', 'credits', 'auth', 'plugins', 'user', 'dashboard']);
// Upstream balance passthrough (OpenAI-semantics billing endpoints): accepts both with and without the /v1 prefix (some old clients configure base without /v1)
// Aliases cover common clients/relay tools' balance paths; a hit routes through fetchBalanceCached for the upstream account balance
const BILLING_PATHS = new Set([
// Official OpenAI dashboard billing (common with third-party clients/relay panels)
  '/v1/dashboard/billing/credit_grants', '/dashboard/billing/credit_grants',
  '/v1/dashboard/billing/subscription', '/dashboard/billing/subscription',
// Generic aliases (balance-path variants of one-api/new-api/relay panels/AI clients)
  '/v1/credits', '/credits',
  '/v1/balance', '/balance',
  '/v1/user/balance', '/user/balance',
  '/v1/user/remain', '/user/remain',
  '/v1/user/remain/points', '/user/remain/points',
  '/v1/quota', '/quota',
  '/v1/billing/usage', '/billing/usage',
  '/v1/usage', '/usage',
  '/v1/wallet', '/wallet',
  '/v1/dashboard/billing/usage', '/dashboard/billing/usage',
]);
// These paths return the "generic balance shape" (with total_remain / balance / data.*, compatible with any per-client JSON-key config);
// The rest (the two OpenAI dashboard endpoints) keep the official shape
const GENERIC_BALANCE_PATHS = new Set([
  '/v1/credits', '/credits',
  '/v1/balance', '/balance',
  '/v1/user/balance', '/user/balance',
  '/v1/user/remain', '/user/remain',
  '/v1/user/remain/points', '/user/remain/points',
  '/v1/quota', '/quota',
  '/v1/billing/usage', '/billing/usage',
  '/v1/usage', '/usage',
  '/v1/wallet', '/wallet',
  '/v1/dashboard/billing/usage', '/dashboard/billing/usage',
]);

function setupModelSync(cfg) {
  teardownModelSync(cfg);
  if (!(cfg.modelSync && cfg.modelSync.enable !== false)) return;
  const min = Number(cfg.modelSync.intervalMin) > 0 ? Number(cfg.modelSync.intervalMin) : Math.max(1, Number(cfg.modelSync.intervalHours) || 24) * 60;
  const run = () => syncModels(cfg).catch(e => logErr('[sync:' + instName(cfg) + '] 定时任务出错:', e.message));
cfg._syncTimer0 = setTimeout(run, 30000); // first sync 30s after boot; never blocks startup
  cfg._syncTimer = setInterval(run, Math.max(60, min) * 1000);
}
function teardownModelSync(cfg) {
  if (cfg._syncTimer0) { clearTimeout(cfg._syncTimer0); cfg._syncTimer0 = null; }
  if (cfg._syncTimer) { clearInterval(cfg._syncTimer); cfg._syncTimer = null; }
}

function createInstancePool(dir) {
  const pool = {
    dir,
    instances: new Map(),  // name → cfg
    servers: new Map(),    // "http:16384" → { server, port, tls, name }
    portOwner: new Map(),  // port → name
    mainPort: 0,
    mainTlsPort: 0,
    mainHost: '0.0.0.0',
    tlsOnly: new Set(),    // instances that listen nowhere themselves (reachable only via main port + /<name>/)
  };
  pool.reload = (name) => poolLoadInstance(pool, name);
  pool.removeInst = (name) => poolRemoveInstance(pool, name);
  pool.renameInst = (a, b) => poolRenameInstance(pool, a, b);
  return pool;
}

// Read an instance's TLS certificate (cached; returns null + warning on failure)
function readTlsCfg(cfg) {
  if (!(cfg.tls && cfg.tls.enable)) return null;
  if (cfg._tlsCache) return cfg._tlsCache;
  const base = path.dirname(cfg._configFile || process.cwd());
  const certPath = path.isAbsolute(cfg.tls.cert) ? cfg.tls.cert : path.join(base, String(cfg.tls.cert || 'cert.pem'));
  const keyPath = path.isAbsolute(cfg.tls.key) ? cfg.tls.key : path.join(base, String(cfg.tls.key || 'key.pem'));
  try {
    cfg._tlsCache = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  } catch (e) {
    logErr('[pool] 实例 ' + instName(cfg) + ' TLS 证书读取失败(' + e.message + '), 该实例 HTTPS 端口跳过');
    return null;
  }
  return cfg._tlsCache;
}

// Compute the desired port map. One entry per instance, never a plaintext twin:
//   - default: a single listener on listen.port (HTTPS when tls.enable, else plaintext; tls.port is ignored)
//   - a TLS instance: no listener of its own, only mainPort + /<name>/; a broken certificate fails closed
//   - a plaintext instance: keeps its compat port
function poolDesiredPorts(pool) {
  const d = new Map(); // key → { name, port, tls, tlsCfg, main }
  pool.tlsOnly = new Set();
  const def = pool.instances.get('default');
  if (!def) return d;
  const mainPort = def.listen.port;
  pool.mainPort = mainPort;
  pool.mainTlsPort = 0;
  const defWantsTls = !!(def.tls && def.tls.enable);
  const defTls = readTlsCfg(def);
  if (defTls) {
    d.set('https:' + mainPort, { name: 'default', port: mainPort, tls: true, tlsCfg: defTls, main: true });
    pool.mainTlsPort = mainPort;
  } else {
    d.set('http:' + mainPort, { name: 'default', port: mainPort, tls: false, main: true });
    if (defWantsTls) logErr('[pool] 主端口 ' + mainPort + ' 已开启 TLS 但证书读取失败 → 退回明文; 开启 TLS 的实例将无法访问');
  }
  // TLS instances never get their own port
  for (const [name, cfg] of pool.instances) {
    if (name === 'default' || cfg._disabled) continue;
    if (cfg.tls && cfg.tls.enable) {
      pool.tlsOnly.add(name);
      if (!readTlsCfg(cfg)) logErr('[pool] 实例 ' + name + ' 已开启 TLS 但证书读取失败 → 不监听自身端口(仅经主端口访问)');
      continue;
    }
    const p = cfg.listen.port;
    if (p && p !== mainPort && !d.has('http:' + p) && !d.has('https:' + p)) d.set('http:' + p, { name, port: p, tls: false });
  }
  return d;
}

// Diff target ports against actual listeners and add/remove servers (port changes apply instantly on hot reload)
function poolReconcilePorts(pool) {
  const desired = poolDesiredPorts(pool);
  for (const [key, srv] of [...pool.servers]) {
    if (!desired.has(key)) {
      pool.servers.delete(key);
      try { srv.server.close(); } catch (_) {}
      log('[pool] 端口 ' + srv.port + (srv.tls ? '(https)' : '') + ' 已关闭 (' + srv.name + ')');
    }
  }
  for (const [key, dd] of desired) {
    if (pool.servers.has(key)) continue;
    let server;
    try {
      server = dd.tls ? https.createServer({ cert: dd.tlsCfg.cert, key: dd.tlsCfg.key }, poolHandler) : http.createServer(poolHandler);
    } catch (e) { logErr('[pool] 创建服务失败 ' + key + ': ' + e.message); continue; }
    server.on('error', e => logErr('[pool] 端口 ' + dd.port + ' 监听错误: ' + e.message));
    if (dd.tls) server.on('tlsClientError', (err) => log('[tls] 握手失败 :' + dd.port + ' (' + dd.name + ') ' + (err.code || err.reason || '') + ' ' + String(err.message || '').slice(0, 120)));
    try {
      server.listen(dd.port, pool.mainHost, () => {
        log('[pool] 监听 ' + (dd.tls ? 'https' : 'http') + ' :' + dd.port + (dd.main ? ' (主端口)' : ' → 实例 ' + dd.name));
      });
    } catch (e) { logErr('[pool] 端口 ' + dd.port + ' 监听失败: ' + e.message); continue; }
    pool.servers.set(key, { server, server0: server, port: dd.port, tls: dd.tls, name: dd.name });
  }
  pool.portOwner = new Map();
  for (const dd of desired.values()) pool.portOwner.set(dd.port, dd.name);
}

function poolHandler(req, res) {
  require('./server').handleHttp(state.CUR_CFG, req, res).catch(e => {
    logErr('handler crash:', e);
    sendError('openai', res, 500, 'internal: ' + (e && e.message));
  });
}

// Load/hot-reload one instance; returns cfg or null (config file missing)
// ===== Scheduled stats persistence (2026-10-27) =====
function statsFlushFile(cfg) {
  const dir = path.join(path.dirname(cfg._configFile || process.cwd()));
  return path.join(dir, 'stats-' + instName(cfg) + '.json');
}
function flushStats(cfg) {
  try {
    const st = cfg._stats; if (!st) return;
    const dir = path.dirname(statsFlushFile(cfg));
    fs.mkdirSync(dir, { recursive: true });
    const snap = {
      savedAt: new Date().toISOString(),
      since: st.startedAt, requests: st.requests || 0, errors: st.errors || 0, retries: st.retries || 0,
      byChannel: st.byChannel || {}, byKey: st.byKey || {}, byModel: st.byModel || {}, daily: st.daily || {},
    };
    const tmp = statsFlushFile(cfg) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 1));
    fs.renameSync(tmp, statsFlushFile(cfg));
  } catch (e) { try { logErr('[stats-flush] 失败:', e.message); } catch (_) {} }
}
function setupStatsFlush(cfg) {
  if (cfg._statsFlushTimer) { clearInterval(cfg._statsFlushTimer); cfg._statsFlushTimer = null; }
  const min = Number(cfg.statsFlushMin);
if (!min || min <= 0) return; // 0/unset = off
  const ms = Math.max(0.2, min) * 60 * 1000;
  cfg._statsFlushTimer = setInterval(() => flushStats(cfg), ms);
  if (cfg._statsFlushTimer.unref) cfg._statsFlushTimer.unref();
}

function poolLoadInstance(pool, name) {
  const old = pool.instances.get(name);
  if (old) teardownModelSync(old);
  if (old && old._probeTimer) { clearInterval(old._probeTimer); }
  const f = path.join(pool.dir, name === 'default' ? 'config.json' : 'config.' + name + '.json');
  if (!fs.existsSync(f)) {
    if (old) { pool.instances.delete(name); poolReconcilePorts(pool); }
    return null;
  }
  const cfg = loadConfig(f);
  cfg._name = name;
  cfg._disabled = !!cfg.disabled;
  try {
    if (!old) panelAuth.ensure(cfg, name);
    else {
      const panelState = panelAuth.read(cfg, name);
      if (panelState) cfg._panelAuth = panelState;
      else panelAuth.init(cfg, name);
      if (old._webSess) cfg._webSess = old._webSess;
      if (old._webSessPend) cfg._webSessPend = old._webSessPend;
    }
  } catch (e) { logErr('[panel] 初始化实例 ' + name + ' 登录状态失败: ' + e.message); }
loadKeyUsage(cfg); // read key card usage back
  // hot reload inherits the old cfg's usedTokens (keeps the larger value so user quotas never reset to zero)
  if (old && Array.isArray(old.apiKeys)) {
    const oldMap = {}; for (const k of old.apiKeys) oldMap[k.key] = k.usedTokens || 0;
    for (const k of (cfg.apiKeys || [])) k.usedTokens = Math.max(k.usedTokens || 0, oldMap[k.key] || 0);
  }
cfg._stats = (old && old._stats) || { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] }; // hot reload keeps stats
if (!old) { // cold start: restore history from data/stats-<inst>.json (fallback for stats lost across restarts)
    try {
      const sf = statsFlushFile(cfg);
      if (fs.existsSync(sf)) {
        const j = JSON.parse(fs.readFileSync(sf, 'utf8'));
        cfg._stats.requests = j.requests || 0; cfg._stats.errors = j.errors || 0; cfg._stats.retries = j.retries || 0;
        cfg._stats.byChannel = j.byChannel || {}; cfg._stats.byKey = j.byKey || {};
        cfg._stats.byModel = j.byModel || {}; cfg._stats.daily = j.daily || {};
        cfg._stats.startedAt = j.since || cfg._stats.startedAt;
        log('[stats] ' + name + ' 已从磁盘恢复统计: ' + (j.requests || 0) + ' 请求');
      }
    } catch (_) {}
  }
  setupStatsFlush(cfg);
  pool.instances.set(name, cfg);
  setupModelSync(cfg);
  setupProbe(cfg);
  if (rt.PLUGINS) { try { rt.PLUGINS.activateInstance(name, cfg, makeGatewayApi(cfg)); } catch (e) { logErr('[plugins] 激活失败 ' + name + ': ' + e.message); } }
  poolReconcilePorts(pool);
  return cfg;
}

function poolLoadAll(pool, defaultCfg) {
  defaultCfg._name = 'default';
  defaultCfg._disabled = !!defaultCfg.disabled;
  try { panelAuth.ensure(defaultCfg, 'default'); } catch (e) { logErr('[panel] 初始化 default 登录状态失败: ' + e.message); }
  defaultCfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, retries: 0, byChannel: {}, recent: [] };
  setupStatsFlush(defaultCfg);
  pool.instances.set('default', defaultCfg);
  setupModelSync(defaultCfg);
  if (rt.PLUGINS) { try { rt.PLUGINS.activateInstance('default', defaultCfg, makeGatewayApi(defaultCfg)); } catch (e) { logErr('[plugins] default 激活失败: ' + e.message); } }
  let files = [];
  try { files = fs.readdirSync(pool.dir); } catch (_) {}
  for (const f of files.sort()) {
    const m = /^config\.([A-Za-z0-9_-]{1,32})\.json$/.exec(f);
    if (!m || m[1] === 'example' || pool.instances.has(m[1])) continue;
    try { poolLoadInstance(pool, m[1]); log('[pool] 实例 ' + m[1] + ' 已加载 (' + (pool.instances.get(m[1]).channels.length) + ' 渠道)'); }
    catch (e) { logErr('[pool] 实例 ' + m[1] + ' 配置加载失败: ' + e.message); }
  }
  poolReconcilePorts(pool);
}

function poolRemoveInstance(pool, name) {
  const old = pool.instances.get(name);
  if (old) teardownModelSync(old);
  if (rt.PLUGINS) { try { rt.PLUGINS.deactivateInstance(name); } catch (_) {} }
  pool.instances.delete(name);
  poolReconcilePorts(pool);
}

function poolRenameInstance(pool, oldName, newName) {
  const cfg = pool.instances.get(oldName);
  if (!cfg) return false;
  pool.instances.delete(oldName);
  cfg._name = newName;
  cfg._configFile = path.join(pool.dir, 'config.' + newName + '.json');
  try { panelAuth.ensure(cfg, newName); } catch (e) { logErr('[panel] 重命名后初始化登录状态失败: ' + e.message); }
  pool.instances.set(newName, cfg);
  poolReconcilePorts(pool);
  return true;
}

// A TLS instance must not be reachable over a plaintext listener (no silent downgrade)
function tlsBlocked(pool, name, req) {
  if (!pool.tlsOnly || !pool.tlsOnly.has(name)) return null;
  if (req.socket && req.socket.encrypted) return null;
  return { error: '实例 ' + name + ' 已开启 TLS: 只能通过主端口 HTTPS 的 /' + name + '/ 访问 (请给 default 也开启 TLS)', status: 400 };
}

// Request routing: compat ports bind directly by port; main port routes by /<instance>/ prefix; otherwise default
function poolRoute(pool, req, p) {
  const lp = req.socket && req.socket.localPort;
  if (lp && lp !== pool.mainPort && lp !== pool.mainTlsPort) {
    const name = pool.portOwner.get(lp);
    if (name) {
      const cfg = pool.instances.get(name);
      if (cfg) {
        if (cfg._disabled) return { error: '实例已停用: ' + name, status: 503 };
        return { cfg, path: p, name, via: 'port' };
      }
    }
    return { error: '端口 ' + lp + ' 没有对应的实例', status: 404 };
  }
  const m = /^\/([A-Za-z0-9_-]{1,32})(?=\/|$)/.exec(p);
  if (m && !RESERVED_PATHS.has(m[1])) {
    const name = m[1];
    const cfg = pool.instances.get(name);
    if (!cfg) return { error: '未知实例: ' + name + ' (可用实例: ' + [...pool.instances.keys()].join(', ') + ')', status: 404 };
    if (cfg._disabled) return { error: '实例已停用: ' + name, status: 503 };
    const blk = tlsBlocked(pool, name, req);
    if (blk) return blk;
    const rest = p.slice(name.length + 1) || '/';
    return { cfg, path: rest, name, via: 'path' };
  }
  const cfg = pool.instances.get('default');
  if (!cfg) return { error: 'default 实例不存在', status: 503 };
  return { cfg, path: p, name: 'default', via: 'default' };
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, state, rt, INST_NAME_RE, RESERVED_PATHS, BILLING_PATHS, GENERIC_BALANCE_PATHS, setupModelSync, teardownModelSync, createInstancePool, readTlsCfg, poolDesiredPorts, poolReconcilePorts, poolHandler, statsFlushFile, flushStats, setupStatsFlush, poolLoadInstance, poolLoadAll, poolRemoveInstance, poolRenameInstance, poolRoute, tlsBlocked };
