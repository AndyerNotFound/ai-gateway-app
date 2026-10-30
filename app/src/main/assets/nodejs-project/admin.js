'use strict';
/**
 * ai-gateway Web admin panel (Material Design 3 style)
 * Referenced by gateway.js; provides the admin UI under each instance's /admin path
 * The admin API requires a panel session cookie, a local admin token, or the optional webToken
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const http = require('http');
const zlib = require('zlib');
const crypto2 = require('crypto');
const https2 = require('https');
const panelAuth = require('./panel-auth');
const { VERSION, utf8 } = require('./util');

// cloudflared tunnel global state
let tunnelProc = null, tunnelUrl = '', tunnelLog = [], tunnelTimer = null, tunnelNext = null;

// DIR prefers the current instance's config directory, falling back to ~/ai-gateway
let crypt = null; try { crypt = require('./crypt.js'); } catch (_) {}
let DIR = path.join(os.homedir(), 'ai-gateway');
function setDir(dir) { DIR = dir; }
const CORE = __dirname; // code root: static assets and scripts
const DATA = () => DIR; // data root: config*/ball*/log/.run/plugins-data (injected by gateway setDir)
const MRUN = () => path.join(DIR, '.run');
const MLOG = () => path.join(DIR, 'log');
let upstreamModelsFn = null;
function setUpstreamModels(fn) { upstreamModelsFn = fn; } // injected by gateway: ch -> Promise<model id array>
let syncFn = null;
function setSyncFn(fn) { syncFn = fn; } // injected by gateway: (instance?) -> Promise<sync summary>
//// channel balance lookup implementation: injected by gateway (cfg, ch, cb) -- uses the channel proxy/insecure; see gateway.js fetchChannelBalance
let BALANCE_FN = null;
function setBalanceFn(fn) { BALANCE_FN = fn; }
// Multi-instance pool (single-process mode), injected by gateway; null = single-instance run
let POOL = null;
function setPool(p) { POOL = p; }
//// plugin manager: injected by gateway
let PLUGINS = null;
function setPlugins(p) { PLUGINS = p; }
// Instance name/path reserved-word validation (kept in sync with gateway.js)
const INST_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED_PATHS = new Set(['v1', 'v1beta', 'v1alpha', 'admin', 'health', 'status', 'favicon.ico', 'robots.txt', 'dashboard']);
//// hot-reload an instance's config (pool mode); throws on failure
function hotReload(name) {
  if (!POOL) return false;
  POOL.reload(name);
  return true;
}
function cfgFile(name) {
  return name === 'default' ? path.join(DATA(), 'config.json') : path.join(DATA(), `config.${name}.json`);
}
function listInstances() {
  const out = [];
  if (fs.existsSync(path.join(DATA(), 'config.json'))) out.push('default');
  try {
    for (const f of fs.readdirSync(DATA())) {
      const m = /^config\.(.+)\.json$/.exec(f);
      if (m && m[1] !== 'example') out.push(m[1]);
    }
  } catch (_) {}
  return out;
}
/* ---- Derived key cache (performance / never caches plaintext) ----
 * Background: configs are AGWENC1-encrypted on disk. Decryption cost is 100% scrypt key derivation (~51.7ms measured),
 *       AES-GCM decryption itself takes ~0.015ms. loadCfg is called repeatedly on the hot path, and scryptSync
 *       is synchronous -> it would monopolize the event loop and freeze concurrent AI forwarding.
 * Scheme: cache only the 32-byte scrypt-derived key; no plaintext is ever kept in memory.
 *       even on a hit it really decrypts every time (read the latest file -> AES-GCM -> JSON.parse), so the content is always current,
 *       hence no "stale cache" problem and no content/mtime comparisons needed.
 * Invalidation signature = first 16 hex chars of sha256(passphrase) + the file's salt:
 *       - file re-encrypted (salt changed) -> signature changes -> re-derive
 *       - crypt.js changepass -> the signature changes -> re-derive
 *       - if the signature is ever wrong -> AES-GCM auth fails loudly; wrong data is never returned silently
 * Memory: 27 files x 32 bytes = 864 bytes (vs ~106KB for caching plaintext).
 */
const _keyCache = new Map();
function cfgCacheClear() { _keyCache.clear(); }
function _passSig(pass) {
  return crypto2.createHash('sha256').update(String(pass)).digest('hex').slice(0, 16);
}
function loadCfg(name) {
  const f = cfgFile(name);
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, 'utf8');
  let plain = raw;
  if (crypt && crypt.isEncText(raw)) {
    const pass = crypt.loadPass();
    if (!pass) throw new Error('配置已加密但找不到密钥(.agwkey/AGW_CRYPT_PASS), 可用 node crypt.js test 检查');
    const b = Buffer.from(raw.slice(crypt.MAGIC.length), 'base64');
    const salt = b.subarray(0, 16);
    const sig = _passSig(pass) + ':' + Buffer.from(salt).toString('hex');
    let e = _keyCache.get(f);
    if (!e || e.sig !== sig) {
      e = { sig, key: crypt.deriveKey(pass, salt) };
      _keyCache.set(f, e);
    }
    // AES-GCM decrypt with the cached derived key (ciphertext layout: salt[16] | iv[12] | tag[16] | ct)
    const iv = b.subarray(16, 28), tag = b.subarray(28, 44), ct = b.subarray(44);
    const d = crypto2.createDecipheriv('aes-256-gcm', e.key, iv);
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  const c = JSON.parse(plain);
  c._configFile = f;
  c._name = name;
  return c;
}
/* Custom privacy-filter rules: accepts an array or newline text; keeps only compilable regexes (max 50) */
function normalizeRedactExtra(v) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/\r?\n/) : []);
  const out = [];
  for (const x of arr) {
    const p = String(x == null ? '' : x).trim();
    if (!p || p.length > 500) continue;
    try { new RegExp(p); } catch (_) { continue; }
    out.push(p);
    if (out.length >= 50) break;
  }
  return out;
}
function maskRedactCfg(c) {
  const r = (c && c.redact) || {};
  return {
    enable: r.enable !== false,
    response: !!r.response,
    extra: Array.isArray(r.extra) ? r.extra.filter(x => typeof x === 'string') : [],
  };
}
function saveCfg(name, cfg) {
  const f = cfgFile(name);
  // Internal runtime fields (_configFile/_name) must never be persisted into config.json.
  const clean = { ...cfg };
  for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];
  // Legacy multi-user data must never be written back (removed 2026-10).
  delete clean.users;
  delete clean.registration;
  const plain = JSON.stringify(clean, null, 2) + '\n';
  let text = plain;
if (crypt) { const pass = crypt.loadPass(); if (pass) text = crypt.encryptText(plain, pass); } // with a passphrase, everything is encrypted on write (fresh salt each time)
  fs.writeFileSync(f, text, { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch (_) {}
_keyCache.delete(f); // salt changed; force re-derivation on next read (~51ms each)
}
function readLog(name, lines) {
// Single-process mode: all instances share one gateway.log
  const f = path.join(MLOG(), POOL ? 'gateway.log' : `${name}.log`);
  if (!fs.existsSync(f)) return '(无日志)';
  const txt = fs.readFileSync(f, 'utf8');
  const arr = txt.split('\n');
  return arr.slice(Math.max(0, arr.length - lines)).join('\n');
}
function pidRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}
function getInstanceStatus(name) {
  const pf = path.join(MRUN(), `${name}.pid`);
  let pid = 0, running = false;
  if (fs.existsSync(pf)) {
    pid = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10) || 0;
    running = pidRunning(pid);
  }
  return { name, pid, running };
}

//// run an agw.sh command (non-blocking, returns a promise)
function runAgw(args) {
  return new Promise(resolve => {
    execFile('bash', [path.join(CORE, 'agw.sh'), ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
    });
  });
}

// Auto-restart after saving config (300ms so the response flushes first; agw.sh restart is a hot worker swap)
function scheduleRestart(cfg, name) {
  setTimeout(() => {
    if (name === currentName(cfg)) {
      try {
        const tmpScript = path.join(os.tmpdir() || CORE, '.agw-self-restart.sh');
        const agwPath = path.join(CORE, 'agw.sh');
        fs.writeFileSync(tmpScript, '#!/bin/bash\nsleep 1\nbash "' + agwPath + '" restart >> "' + path.join(MLOG(), name + '.log') + '" 2>&1\nrm -f "' + tmpScript + '"\n');
        fs.chmodSync(tmpScript, 0o755);
        const cp = exec('setsid bash "' + tmpScript + '" </dev/null >/dev/null 2>&1 &', { stdio: 'ignore' }, () => {});
        try { cp.unref(); } catch (_) {}
      } catch (_) {}
    } else {
      try { runAgw(['restart', name]); } catch (_) {}
    }
  }, 300);
}

//// admin auth
/* ---- TOTP (RFC 6238, SHA1, 30s window, 6 digits) ---- */
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = String(s || '').toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of s) {
    val = (val << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function base32Encode(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(val >> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
function totpCode(secretB32, offsetStep = 0) {
  try {
    const key = base32Decode(secretB32);
    if (!key.length) return null;
    const counter = Math.floor(Date.now() / 1000 / 30) + offsetStep;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto2.createHmac('sha1', key).update(buf).digest();
    const o = h[h.length - 1] & 0xf;
    const code = ((h[o] & 0x7f) << 24 | (h[o + 1] & 0xff) << 16 | (h[o + 2] & 0xff) << 8 | (h[o + 3] & 0xff)) % 1000000;
    return String(code).padStart(6, '0');
  } catch (_) { return null; }
}
function totpVerify(secretB32, code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (const off of [-1, 0, 1]) if (totpCode(secretB32, off) === c) return true;
  return false;
}

//// admin auth: panel session cookie / runtime admin token / optional webToken
const WEB_TOKEN_GRACE_MS = 5 * 60 * 1000;
// Session cookie name is port-scoped: cookies are not isolated per port, and several gateways may run
// side by side on 127.0.0.1 -- a fixed name would let one login overwrite another instance's session.
function sessCookieName(cfg) {
  const port = Number((cfg && cfg.listen && cfg.listen.port) || 0);
  return port ? 'agwSID_' + port : 'agwSID';
}
function panelStateOf(cfg) {
  try { return panelAuth.read(cfg, cfg._name || currentName(cfg)); } catch (_) { return null; }
}
function checkAdminAuth(cfg, req, query, opts = {}) {
// Panel session expiry: clears all sessions at the deadline and persists the reset
  if (cfg.adminExpireAt > 0 && Date.now() >= cfg.adminExpireAt) {
    cfg.adminExpireAt = 0;
    if (cfg._webSess) cfg._webSess.clear();
    if (cfg._webSessPend) cfg._webSessPend.clear();
    try { panelAuth.revoke(cfg, cfg._name || currentName(cfg)); } catch (_) {}
    try { const nm = cfg._name || currentName(cfg); const disk = loadCfg(nm); if (disk) { disk.adminExpireAt = 0; saveCfg(nm, disk); } } catch (_) {}
  }
  const h = (req && req.headers) || {};
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const supplied = [bearer, h['x-agw-token'], query && query.get('key')].filter(Boolean);
  const panelState = panelStateOf(cfg);
  let mainOk = false;

// Optional long-lived API token (kept for scripts; the panel itself only accepts a login session)
  if (!opts.panel) {
    const validTokens = [];
    if (cfg.webToken) validTokens.push(cfg.webToken);
    if (cfg.webTokenPrev && Number(cfg.webTokenPrevUntil) > Date.now()) validTokens.push(cfg.webTokenPrev);
    if (validTokens.some(t => supplied.includes(t))) mainOk = true;
    if (!mainOk && cfg.webToken && (h.cookie || '').includes(`agwWeb=${cfg.webToken}`)) mainOk = true;
    if (!mainOk && panelState && panelState.adminToken && supplied.includes(panelState.adminToken)) mainOk = true;
  }

// Browser session cookie issued by a valid one-time login link
  const sessMap = cfg._webSess || panelAuth.sessionsOf(cfg, cfg._name || currentName(cfg));
  if (!mainOk && sessMap) {
    // Prefer the port-scoped cookie name; fall back to the legacy fixed name only when the
    // scoped one is absent. A single alternation would match whichever name sorts first in the
    // Cookie header (browsers keep a stale legacy agwSID around), locking the user out.
    const ck = String(h.cookie || '');
    const names = [sessCookieName(cfg)];
    if (sessCookieName(cfg) !== 'agwSID') names.push('agwSID');
    for (const nm of names) {
      const m = ck.match(new RegExp('(?:^|;\\s*)' + nm + '=([A-Za-z0-9_-]{16,})'));
      if (!m) continue;
      const ent = sessMap.get ? sessMap.get(m[1]) : sessMap[m[1]];
      if (typeof ent === 'number') {
        if (ent > Date.now()) { mainOk = true; break; }
      } else if (ent && Number(ent.exp) > Date.now()) {
        if (!ent.panelSid || (panelState && ent.panelSid === panelState.sid)) { mainOk = true; break; }
      }
    }
  }

  if (!mainOk) return false;

// ---- Second factor (validated only when configured) ----
  const aa = cfg.adminAuth || {};
  const needSecond = !!(aa.secondKey || aa.totpSecret);
  if (!needSecond) return true;
  if (aa.secondKey && (h['x-admin-key2'] === aa.secondKey || (query && query.get('adminKey2') === aa.secondKey))) return true;
  if (aa.totpSecret && totpVerify(aa.totpSecret, h['x-totp'] || (query && query.get('totp')))) return true;
  return false;
}

function jsonRes(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
  res.end(body);
}
function textRes(res, status, text, ct) {
  res.writeHead(status, { 'Content-Type': ct || 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
  res.end(text);
}

// Merge rules for the three balance-passthrough fields (one convention, reused by config save and single-channel save):
//   key absent from the body (undefined) -> inherit the old value; explicit empty string/null -> clear (never stores "")
const BALANCE_KEYS = ['balanceUrl', 'balancePath', 'balanceUnit', 'warnBelow'];
function mergeBalanceFields(out, prev) {
  for (const k of BALANCE_KEYS) {
    if (out[k] === undefined) { if (prev && prev[k] !== undefined) out[k] = prev[k]; }
    else if (out[k] === '' || out[k] === null) delete out[k];
  }
  return out;
}

function normalizeChannelPath(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return null;
  if (s.charAt(0) !== '/') s = '/' + s;
  return s;
}

// Extract masked channel info from the config (the key never leaves)
function maskedChannels(cfg, reveal) {
  return (cfg.channels || []).map(c => ({
    name: c.name, type: c.type, baseUrl: c.baseUrl, path: normalizeChannelPath(c.path),
    proxy: c.proxy || null, models: c.models, modelMap: c.modelMap,
    default: c.default, hasKey: !!(c.apiKey && c.apiKey.length),
    useResponses: c.useResponses === undefined ? undefined : !!c.useResponses, delayMs: c.delayMs || 0, probe: !!c.probe,
    insecure: !!c.insecure, addUsage: c.addUsage !== false, anthropicVersion: c.anthropicVersion || null,
    lockAt: c.lockAt || null, lockUntil: c.lockUntil || null, transcreet: c.transcreet || null,
// Balance passthrough config (non-sensitive, panel-editable; default = built-in presets)
    balanceUrl: c.balanceUrl || null, balancePath: c.balancePath || null, balanceUnit: c.balanceUnit || null,
    warnBelow: c.warnBelow || null,
    keyPrefix: c.apiKey ? c.apiKey.slice(0, 4) + '***' : '',
    apiKey: reveal ? (c.apiKey || '') : undefined,
  }));
}

//// current instance name (config.json -> 'default', config.xxx.json -> 'xxx')
function currentName(cfg) {
  if (!cfg._configFile) return 'default';
  const base = path.basename(cfg._configFile, '.json');
  if (base === 'config') return 'default';
  return base.replace(/^config\./, '');
}

//// proxy over local loopback to the target instance for JSON (cross-instance stats/requests)
//// always go through /admin/api/<path> (with the target's webToken or local panel admin token)
function proxyInstance(targetName, adminPath) {
  return new Promise(resolve => {
    const tc = loadCfg(targetName);
    if (!tc) return resolve(null);
    // when the target instance has TLS on (including same-port pure HTTPS), the local loopback must use https
    const tcTls = tc.tls || {};
    const main = loadCfg('default');
    const mainPort = Number((main && main.listen || {}).port) || 16384;
    // A TLS instance has no listener of its own: it lives behind the main port's HTTPS + /<name>/ prefix
    const useTls = !!tcTls.enable;
    const viaMain = targetName !== 'default' && (useTls || Number((tc.listen || {}).port || 16384) === mainPort);
    const port = viaMain ? mainPort : ((tc.listen || {}).port || 16384);
    const mod = (viaMain ? !!((main || {}).tls && main.tls.enable) : useTls) ? https2 : http;
const tlsOpt = mod === https2 ? { rejectUnauthorized: false } : {}; // loopback targets are signed by the private CA
    const targetPanel = panelAuth.read(tc, targetName);
    const webToken = (targetPanel && targetPanel.adminToken) || tc.webToken || '';
    const prefix = viaMain ? '/' + encodeURIComponent(targetName) : '';
    const tryAdmin = () => {
      const opts = Object.assign({ host: '127.0.0.1', port, path: prefix + '/admin/api/' + adminPath, method: 'GET', timeout: 5000 }, tlsOpt);
      if (webToken) opts.headers = { 'x-agw-token': webToken };
      const r = mod.request(opts, resp => {
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
          if (resp.statusCode === 200) { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }
          else resolve(null);
        });
      });
      r.on('error', () => resolve(null));
      r.on('timeout', () => { r.destroy(); resolve(null); });
      r.end();
    };
    tryAdmin();
  });
}

/* ====================== Handle admin requests ====================== */
// cfg = current instance config, req, res, u = URL object, p = pathname, bodyStr = request body
/* ====================== Floating ball config whitelist ======================
 * The APP-side floating ball's look/labels are written by POST /admin/api/ball/<inst> into ball.<inst>.json,
 * The APP polls GET /admin/api/ball/<inst> every 60s and does nothing at all when the hash is unchanged.
 * Anything outside the whitelist gets 400: better to error than to carry keys the APP does not recognize and silently ignores.
 */
const BALL = (() => {
  const NUM = {
    sizeDp: [40, 88], gaugeWidth: [60, 200], panelDp: [240, 340],
    shape: [0, 3], pill: [0, 2], chip: [0, 3], rowsMask: [0, 63],
    dimSec: [1, 30], dimAlpha: [10, 100], balanceWarnBelow: [0, 1000000],
    scale: [0.8, 1.3]
  };
  const FLAG = ['snap', 'dim', 'blur', 'lock', 'balanceRow', 'pinExpanded'];
  const STR = { rowsOrder: /^[0-9,]{0,40}$/, iconUri: /^.{0,300}$/ };
  const COLOR = ['gaugeColor', 'bg'];
  // structured ball UI description: rings / ringStyle / rows / bubble / on / radial
  const OBJ_KEYS = ['ringStyle', 'bubble', 'radial', 'perform', 'noti'];
  const TONES = ['ok', 'warn', 'danger', 'info', 'muted', 'primary'];
  const ALL = () => [].concat(Object.keys(NUM), FLAG, Object.keys(STR), COLOR, ['phrases'], OBJ_KEYS);

  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const isStr = (v, lo, hi) => typeof v === 'string' && v.length >= lo && v.length <= hi;
  const actOk = a => isObj(a) && isStr(a.type, 1, 24);

/** content_* group = one panel row: {order, label, data, text} */
  function contentGroup(k, v) {
    if (!isObj(v)) return { error: k + ' 必须是对象' };
    const o = {};
    if (v.order !== undefined) {
      const n = Number(v.order);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { error: k + '.order 需在 0..99' };
      o.order = n;
    }
    if (v.label !== undefined) {
      if (!isStr(v.label, 1, 24)) return { error: k + '.label 需为 1..24 字符串' };
      o.label = v.label;
    }
    if (v.data !== undefined) {
      if (!isStr(v.data, 1, 64)) return { error: k + '.data 需为 1..64 字符串' };
      o.data = v.data;
    }
    if (v.text !== undefined) {
      if (!isStr(v.text, 0, 200)) return { error: k + '.text 需为 ≤200 字符串' };
      o.text = v.text;
    }
    return { value: o };
  }

/** radial_* group = one button */
  function radialItem(k, v) {
    if (!isObj(v)) return { error: k + ' 必须是对象' };
    const o = {};
    if (v.order !== undefined) {
      const n = Number(v.order);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { error: k + '.order 需在 0..99' };
      o.order = n;
    }
    if (!isStr(v.label, 1, 8)) return { error: k + '.label 必填 (1..8 字)' };
    o.label = v.label;
    if (v.tone !== undefined) {
      if (!TONES.includes(v.tone)) return { error: k + '.tone 只能是 ' + TONES.join('/') };
      o.tone = v.tone;
    }
    if (!actOk(v.do)) return { error: k + '.do 需形如 {type:"..."}' };
    o.do = v.do;
    return { value: o };
  }

/** touch_* group = one gesture */
  function touchItem(k, v) {
    if (!isObj(v)) return { error: k + ' 必须是对象' };
    const o = {};
    if (v.order !== undefined) {
      const n = Number(v.order);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { error: k + '.order 需在 0..99' };
      o.order = n;
    }
    if (!['click', 'double', 'long', 'long_hold'].includes(v.on)) {
      return { error: k + '.on 只能是 click/double/long/long_hold' };
    }
    o.on = v.on;
    if (v.on === 'long_hold') {
      const n = Number(v.hold);
      if (!(n >= 100 && n <= 2000)) return { error: k + '.hold 需在 100..2000 毫秒' };
      o.hold = n;
      return { value: o };
    }
    if (!(actOk(v.do) || (Array.isArray(v.do) && v.do.length && v.do.every(actOk)))) {
      return { error: k + '.do 需动作对象或动作数组' };
    }
    o.do = v.do;
    return { value: o };
  }

/** chain_* group = one chained rule: condition like when, do is an action array, delay is the inter-segment wait */
  function chainGroup(k, v) {
    const base = whenCond(k, v);
    if (base.error) return base;
    if (!Array.isArray(v.do) || !v.do.length || v.do.length > 8) return { error: k + '.do 必须是 1..8 条动作的数组' };
    if (!v.do.every(actOk)) return { error: k + '.do 每项需形如 {type:"..."}' };
    const o = base.value;
    o.do = v.do;
    if (v.delay !== undefined) {
      const n = Number(v.delay);
      if (!(n >= 0 && n <= 60)) return { error: k + '.delay 需在 0..60 秒' };
      o.delay = n;
    }
    return { value: o };
  }

/** when_* group = one event rule: {order, on, lt/gt/eq/match, do, cooldown} */
  const EV_ACTS = ['expand', 'collapse', 'toggle', 'menu', 'reload', 'open', 'copy', 'toast',
    'mute', 'intent', 'sequence', 'bubble', 'notify'];
  function whenCond(k, v) {
    if (!isObj(v)) return { error: k + ' 必须是对象' };
    const o = {};
    if (!isStr(v.on, 1, 24)) return { error: k + '.on 必填 (事件名, 1..24)' };
    o.on = v.on;
    if (v.order !== undefined) {
      const n = Number(v.order);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { error: k + '.order 需在 0..99' };
      o.order = n;
    }
    if (v.field !== undefined) {
      if (!isStr(v.field, 1, 16)) return { error: k + '.field 需为字符串' };
      o.field = v.field;
    }
    for (const nk of ['lt', 'gt']) {
      if (v[nk] === undefined) continue;
      const n = Number(v[nk]);
      if (!Number.isFinite(n)) return { error: k + '.' + nk + ' 必须是数字' };
      o[nk] = n;
    }
    for (const sk of ['eq', 'match']) {
      if (v[sk] === undefined) continue;
      if (!isStr(v[sk], 1, 64)) return { error: k + '.' + sk + ' 需为 1..64 字符串' };
      o[sk] = v[sk];
    }
    if (v.cooldown !== undefined) {
      const n = Number(v.cooldown);
      if (!Number.isFinite(n) || n < 0 || n > 86400) return { error: k + '.cooldown 需在 0..86400 秒' };
      o.cooldown = n;
    }
    if (v.label !== undefined) {
      if (!isStr(v.label, 1, 24)) return { error: k + '.label 需为 1..24 字符串' };
      o.label = v.label;
    }
    return { value: o };
  }

/** when_* = condition + single action */
  function whenGroup(k, v) {
    const r = whenCond(k, v);
    if (r.error) return r;
    if (!isObj(v.do)) return { error: k + '.do 必须是动作对象' };
    if (!EV_ACTS.includes(v.do.type)) return { error: k + '.do.type 只允许 ' + EV_ACTS.join('/') };
    const o = r.value;
    o.do = v.do;
    return { value: o };
  }

/** ring_* group = one ring: {order, data, color} */
  function ringGroup(name, v) {
    if (!isObj(v)) return { error: name + ' 必须是对象' };
    if (!Number.isFinite(Number(v.order))) return { error: name + '.order 必须是数字' };
    if (!isStr(v.data, 1, 80)) return { error: name + '.data 需 1..80 字符' };
    if (v.color !== undefined) {
      const okHex = typeof v.color === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v.color);
      if (!okHex && !TONES.includes(v.color)) return { error: name + '.color 需语义色或 #RRGGBB' };
    }
    return { value: { order: Number(v.order), data: v.data, color: v.color || 'primary' } };
  }

/** New four groups: perform / thing / bubble / content / touch */
  function structured2(k, v) {
    if (k === 'perform') {
      if (!isObj(v)) return { error: 'perform 必须是对象' };
      const R = { zoom: [0.5, 2], roll: [0, 3600], side: [0, 3600], dark: [0, 3600], lock: [0, 1] };
      for (const n of Object.keys(R)) {
        if (v[n] !== undefined && !(Number(v[n]) >= R[n][0] && Number(v[n]) <= R[n][1]))
          return { error: 'perform.' + n + ' 需在 ' + R[n][0] + '..' + R[n][1] };
      }
      if (v.alpha !== undefined) {
        const okNum = Number.isFinite(Number(v.alpha)) && Number(v.alpha) >= 0 && Number(v.alpha) <= 100;
        const okHex = typeof v.alpha === 'string' && /^#([0-9a-fA-F]{2}|[0-9a-fA-F]{8})$/.test(v.alpha);
        if (!okNum && !okHex) return { error: 'perform.alpha 需 0..100 或 #RRGGBBAA' };
      }
      if (v.icon !== undefined && !isStr(v.icon, 1, 300)) return { error: 'perform.icon 需 1..300 字符' };
      return { value: v };
    }
    if (k === 'bubble' || k === 'content') {
      if (!isObj(v)) return { error: k + ' 必须是对象' };
      if (v.order !== undefined && !Number.isFinite(Number(v.order))) return { error: k + '.order 必须是数字' };
      if (v.data !== undefined && !isStr(v.data, 1, 80)) return { error: k + '.data 需 1..80 字符' };
      if (v.text !== undefined) {
        const arr = Array.isArray(v.text);
        if (arr ? !v.text.every(t => isStr(t, 0, 160)) : !isStr(v.text, 0, 160))
          return { error: k + '.text 需字符串或字符串数组（每条 ≤160）' };
      }
      return { value: v };
    }
    if (k === 'thing') {
      if (!isObj(v)) return { error: 'thing 必须是对象' };
      for (const key of ['click', 'double', 'long', 'context_warn', 'balance_warn']) {
        if (v[key] === undefined) continue;
        const list = Array.isArray(v[key]) ? v[key] : [v[key]];
        if (list.length > 8) return { error: 'thing.' + key + ' 最多 8 个动作' };
        for (const a of list) if (!actOk(a)) return { error: 'thing.' + key + ' 的动作需形如 {type:"..."}' };
      }
      if (v.long_hold !== undefined && !(Number(v.long_hold) >= 100 && Number(v.long_hold) <= 2000))
        return { error: 'thing.long_hold 需在 100..2000 ms' };
      return { value: v };
    }
    if (k === 'touch') {
      const list = Array.isArray(v) ? v : null;
      if (!list) return { error: 'touch 必须是字符串数组（声明可用的手势名）' };
      if (list.length > 12) return { error: 'touch 最多 12 项' };
      for (const t of list) if (!isStr(t, 1, 24)) return { error: 'touch 每项需 1..24 字符' };
      return { value: list };
    }
    return { error: '未知组 ' + k };
  }

  function structured(k, v) {
    if (k === 'perform') return structured2('perform', v);
    if (k === 'ringStyle') {
      if (!isObj(v)) return { error: 'ringStyle 必须是对象' };
      if (v.mode !== undefined && !['ring', 'bars'].includes(v.mode)) return { error: 'ringStyle.mode 只能是 ring/bars' };
      if (v.side !== undefined && !['left', 'right'].includes(v.side)) return { error: 'ringStyle.side 只能是 left/right' };
      for (const n of ['stroke', 'gap']) {
        if (v[n] !== undefined && !(Number(v[n]) >= 0.5 && Number(v[n]) <= 8)) return { error: 'ringStyle.' + n + ' 需在 0.5..8' };
      }
      return { value: v };
    }
    if (k === 'bubble') {
      if (!isObj(v)) return { error: 'bubble 必须是对象' };
      const o = {};
      if (v.order !== undefined) o.order = Number(v.order);
      if (v.data !== undefined) { if (!isStr(v.data, 1, 64)) return { error: 'bubble.data 需 1..64 字符' }; o.data = v.data; }
      if (v.text !== undefined) {
        if (!(isStr(v.text, 0, 200) || (Array.isArray(v.text) && v.text.length <= 4 && v.text.every(x => isStr(x, 0, 120))))) {
          return { error: 'bubble.text 需字符串或 ≤4 条字符串数组' };
        }
        o.text = v.text;
      }
      return { value: o };
    }
    if (k === 'radial') {
      if (!isObj(v)) return { error: 'radial 必须是对象' };
      const o = {};
      if (v.radius !== undefined) {
        const n = Number(v.radius);
        if (!(n >= 40 && n <= 160)) return { error: 'radial.radius 需在 40..160' };
        o.radius = n;
      }
      return { value: o };
    }
    if (k === 'noti') {
      if (!isObj(v)) return { error: 'noti 必须是对象' };
      const o = {};
      if (v.name !== undefined) { if (!isStr(v.name, 1, 24)) return { error: 'noti.name 需 1..24 字符' }; o.name = v.name; }
      if (v.text !== undefined) { if (!isStr(v.text, 0, 200)) return { error: 'noti.text 需 ≤200 字符' }; o.text = v.text; }
      if (v.time !== undefined) { if (!isStr(v.time, 0, 32)) return { error: 'noti.time 需 ≤32 字符' }; o.time = v.time; }
      if (v.silence !== undefined) { o.silence = Number(v.silence) ? 1 : 0; }
      return { value: o };
    }
    return { error: '未知键 ' + k };
  }

/** ring_* orders must be unique */
  function orderClash(obj, skipKey) {
    const seen = new Map();
    for (const k of Object.keys(obj)) {
      if (k === skipKey) continue;
      if (!/^ring_/.test(k)) continue;
      const o = obj[k] && obj[k].order;
      if (o === undefined) continue;
      if (seen.has(o)) return 'order=' + o + ' 在 ' + seen.get(o) + ' 与 ' + k + ' 重复';
      seen.set(o, k);
    }
    return null;
  }

  function validate(src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return { error: 'look 必须是对象' };
    const out = {};
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (k in NUM) {
        const n = Number(v), lo = NUM[k][0], hi = NUM[k][1];
        if (!Number.isFinite(n) || n < lo || n > hi) return { error: k + ' 需在 ' + lo + '..' + hi };
        out[k] = n;
      } else if (FLAG.includes(k)) {
        if (typeof v !== 'boolean') return { error: k + ' 必须是布尔' };
        out[k] = v;
      } else if (k in STR) {
        if (typeof v !== 'string' || !STR[k].test(v)) return { error: k + ' 格式不合法' };
        out[k] = v;
      } else if (COLOR.includes(k)) {
        const okHex = typeof v === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
        if (!okHex && v !== 0 && v !== '0') return { error: k + ' 需为 "#RRGGBB" / "#AARRGGBB" / 0' };
        out[k] = v;
      } else if (k === 'phrases') {
        if (!Array.isArray(v) || v.length > 40) return { error: 'phrases 必须是 ≤40 条的数组' };
        if (!v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 40)) return { error: 'phrases 每条 1..40 字符' };
        out[k] = v;
      } else if (/^ring_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = ringGroup(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^content_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = contentGroup(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^radial_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = radialItem(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^touch_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = touchItem(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^chain_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = chainGroup(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^when_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = whenGroup(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (k === 'when') {
        if (!Array.isArray(v) || v.length > 12) return { error: 'when 必须是 ≤12 条的数组' };
        const arr = [];
        for (let i = 0; i < v.length; i++) {
          const r = whenGroup('when[' + i + ']', v[i]);
          if (r.error) return { error: r.error };
          arr.push(r.value);
        }
        out[k] = arr;
      } else if (OBJ_KEYS.includes(k)) {
        const r = structured(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else {
        return { error: '未知键 ' + k, allowed: ALL() };
      }
    }
    return { value: out };
  }
  const hashOf = o => require('crypto').createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12);
  return { validate, keys: ALL, hashOf, orderClash };
})();

async function handleAdmin(cfg, req, res, u, p, bodyStr) {
// /admin page (built-in HTML)
  if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) {
    return textRes(res, 200, adminHTML(cfg), 'text/html; charset=utf-8');
  }

// /auth -- M3 admin panel entry: a valid panel session cookie; new links use /auth/<session-id>/<token>
// The normal entry is the one-time link printed by: agw web login
  const m3KeyOk = () => checkAdminAuth(cfg, req, u.searchParams, { panel: true });
// A successful login issues a separate HttpOnly browser session cookie; the path token itself is one-shot.
  const issueWebSess = () => {
    const now = Date.now();
    const panelState = panelStateOf(cfg);
    // Prefer the persistent per-instance sessions map (survives hot restarts / worker swaps);
    // fall back to the in-memory map only when the state file is unavailable.
    const sessMap = panelAuth.sessionsOf(cfg, cfg._name || currentName(cfg)) || (cfg._webSess = cfg._webSess || new Map());
    const set = (k, v) => { if (sessMap.set) sessMap.set(k, v); else sessMap[k] = v; };
    const del = (k) => { if (sessMap.delete) sessMap.delete(k); else delete sessMap[k]; };
    for (const [k, v] of (sessMap.entries ? sessMap : Object.entries(sessMap))) {
      const exp = typeof v === 'number' ? v : Number(v && v.exp) || 0;
      const stale = v && v.panelSid && (!panelState || v.panelSid !== panelState.sid);
      if (exp <= now || stale) del(k);
    }
    if (Object.keys(sessMap).length >= 64 || (sessMap.size != null && sessMap.size >= 64)) del(sessMap.keys ? sessMap.keys().next().value : Object.keys(sessMap)[0]);
    const sid = require('crypto').randomBytes(32).toString('base64url');
    set(sid, { exp: now + 7 * 864e5, panelSid: panelState ? panelState.sid : '' });
    try { panelAuth.sessionsSave(cfg, cfg._name || currentName(cfg)); } catch (_) {}
    const secure = !!(req.socket && req.socket.encrypted) || ((req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
    return `${sessCookieName(cfg)}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`;
  };
  const withSess = () => ({
    'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', 'Access-Control-Allow-Origin': '*',
  });
  const authDeny = () => textRes(res, 401, '<!doctype html><meta charset="utf-8"><title>401</title>'
    + '<body style="font-family:sans-serif;background:#1c1b1f;color:#e6e1e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
    + '<div>⚠️ 需要登录: 请在服务器执行 <code>agw web login</code> 获取一次性登录链接</div></body>', 'text/html; charset=utf-8');

// /auth/<session-id>/<token> -- one-time link generated by agw web login.
// The session-id is regenerated whenever the gateway starts; the token is regenerated by every login command.
  const pm = (req.method === 'GET') && p.match(/^\/auth\/([A-Za-z0-9_-]{16,128})\/([A-Za-z0-9_-]{8,256})\/?$/);
  if (pm) {
    const [, sid, tok] = pm;
    const okLink = panelAuth.verify(cfg, cfg._name || currentName(cfg), sid, tok);
    // One-time link consumed (or already used): switch to the cookie session. Redirect to /auth so a
    // refresh hits the session-cookie path instead of re-verifying the one-time token -> no 401 on F5.
    // An already-used link still goes through when the browser holds a valid session cookie.
    if (!okLink && !checkAdminAuth(cfg, req, u.searchParams, { panel: true })) return textRes(res, 401, '<!doctype html><meta charset="utf-8"><title>401</title>'
      + '<body style="font-family:sans-serif;background:#1c1b1f;color:#e6e1e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
      + '<div>⚠️ Login link invalid or already used; run <code>agw web login</code> again on the server</div></body>', 'text/html; charset=utf-8');
    res.writeHead(302, { 'Location': '/auth', 'Cache-Control': 'no-store', 'Set-Cookie': issueWebSess() });
    return res.end();
  }

// /auth (the panel itself; visit with ?key=<access token>; also issues a session cookie)
  if (req.method === 'GET' && (p === '/auth' || p === '/auth/')) {
    if (!m3KeyOk()) return authDeny();
    const f = path.join(CORE, 'm3', 'index.html');
    if (!fs.existsSync(f)) return textRes(res, 404, 'M3 面板未找到, 请把 index.html 放到 ' + path.join(CORE, 'm3'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', ...withSess() });
    return res.end(fs.readFileSync(f, 'utf8'));
  }
// /auth/<static> -- vendor JS / fonts etc. (nothing sensitive, no token check, browser-cache friendly)
// Safety: must stay inside the m3 directory (no .. traversal) and must be a file
  if (req.method === 'GET' && p.startsWith('/auth/')) {
    let rel;
    try { rel = decodeURIComponent(p.slice('/auth/'.length)); } catch (e) { rel = ''; }
    const root = path.join(CORE, 'm3');
    const f = path.join(root, rel);
    if (rel && !rel.includes('\0') && f.startsWith(root + path.sep)
        && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = path.extname(f).toLowerCase();
      const isApp = rel === 'app.js' || rel === 'app.css'; // 面板本体: 不缓存, 改完刷新即生效
      const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.map': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
        '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
      let buf = fs.readFileSync(f);
      const hdr = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
// The panel itself is never cached; vendor assets cache for a day (large and content-named)
        'Cache-Control': (ext === '.html' || isApp) ? 'no-store, no-cache, must-revalidate' : 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*', 'Vary': 'Accept-Encoding',
      };
      if (isApp) { hdr['Pragma'] = 'no-cache'; hdr['Expires'] = '0'; }
      // text assets >1KB when the client supports it -> gzip (the 288KB component bundle shrinks to ~56KB)
      if (buf.length > 1024 && ['.js', '.mjs', '.css', '.json', '.map'].includes(ext)
          && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        buf = zlib.gzipSync(buf, { level: 9 });
        hdr['Content-Encoding'] = 'gzip';
      }
      hdr['Content-Length'] = buf.length;
      res.writeHead(200, hdr);
      return res.end(buf);
    }
    // missing file / traversal attempt: explicit 404, never null (callers would not write a response and the request would hang)
    return textRes(res, 404, '面板资源不存在: ' + rel);
  }
  if (p.startsWith('/auth/')) return textRes(res, 405, '不支持的方法: ' + req.method + ' ' + p);

// Everything below is /admin/api/* -> requires panel session cookie / local admin token / optional webToken
  if (!p.startsWith('/admin/api/')) return null; // 不是管理路由, 交给后续

  if (!checkAdminAuth(cfg, req, u.searchParams)) {
    return jsonRes(res, 401, { error: '认证失败：App 请使用 default 实例的 config.webToken（不是 agw web login 的一次性链接）' });
  }

  const api = p.slice('/admin/api/'.length);

// POST /admin/api/web-token/rotate -- rotate the long-lived API token; old token stays valid for 5 min
  if (api === 'web-token/rotate') {
    if (req.method !== 'POST') return jsonRes(res, 405, { error: '只支持 POST' });
    const nm = cfg._name || currentName(cfg);
    const oldToken = String(cfg.webToken || '');
    if (!oldToken) return jsonRes(res, 409, { error: '当前 webToken 为空，无法轮换；请先在配置中设置一个 token' });
    const newToken = require('crypto').randomBytes(24).toString('base64url');
    const prevUntil = Date.now() + WEB_TOKEN_GRACE_MS;
    try {
      const disk = loadCfg(nm);
      if (!disk) return jsonRes(res, 404, { error: '实例不存在' });
      disk.webTokenPrev = oldToken;
      disk.webTokenPrevUntil = prevUntil;
      disk.webToken = newToken;
      saveCfg(nm, disk);
    } catch (e) {
      return jsonRes(res, 500, { error: '轮换失败: ' + e.message });
    }
    cfg.webTokenPrev = oldToken;
    cfg.webTokenPrevUntil = prevUntil;
    cfg.webToken = newToken;
    return jsonRes(res, 200, { ok: true, webToken: newToken, prevUntil });
  }

// POST /admin/api/web-expired -- log out every panel session (agw admin expire)
  if (api === 'web-expired') {
    let j = {}; try { j = JSON.parse(bodyStr || '{}'); } catch (_) {}
    const sid = String(j.sid || '');
    if (sid) {
      if (cfg._webSess) cfg._webSess.delete(sid);
      if (cfg._webSessPend) cfg._webSessPend.delete(sid);
      return jsonRes(res, 200, { ok: true, sid });
    }
    if (cfg._webSess) cfg._webSess.clear();
    if (cfg._webSessPend) cfg._webSessPend.clear();
    try { panelAuth.revoke(cfg, cfg._name || currentName(cfg)); } catch (_) {}
    return jsonRes(res, 200, { ok: true, cleared: true });
  }
// POST /admin/api/admin-expire {at|sid|0} -- schedule/immediate panel-session logout (agw admin expire -t/-w/-d)
  if (api === 'admin-expire') {
    let j = {}; try { j = JSON.parse(bodyStr || '{}'); } catch (_) {}
    if (j.sid) {
      if (cfg._webSess) cfg._webSess.delete(String(j.sid));
      if (cfg._webSessPend) cfg._webSessPend.delete(String(j.sid));
      return jsonRes(res, 200, { ok: true, sid: String(j.sid) });
    }
    const nm = cfg._name || currentName(cfg);
    const at = Number(j.at) || 0;
    if (cfg._expTimer) { clearTimeout(cfg._expTimer); cfg._expTimer = null; }
    if (!at) {
      cfg.adminExpireAt = 0;
      try { const disk = loadCfg(nm); if (disk) { disk.adminExpireAt = 0; saveCfg(nm, disk); } } catch (_) {}
      return jsonRes(res, 200, { ok: true, at: 0 });
    }
    const fire = () => {
      cfg.adminExpireAt = 0;
      if (cfg._webSess) cfg._webSess.clear();
      if (cfg._webSessPend) cfg._webSessPend.clear();
      try { panelAuth.revoke(cfg, cfg._name || currentName(cfg)); } catch (_) {}
      try { const disk = loadCfg(nm); if (disk) { disk.adminExpireAt = 0; saveCfg(nm, disk); } } catch (_) {}
    };
    cfg.adminExpireAt = at;
    if (at <= Date.now()) fire();
    else cfg._expTimer = setTimeout(fire, at - Date.now());
    try { const disk = loadCfg(nm); if (disk) { disk.adminExpireAt = at; saveCfg(nm, disk); } } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    return jsonRes(res, 200, { ok: true, at });
  }
// POST /admin/api/web-session -- retired: agw web login now writes the login state directly to disk
  if (api === 'web-session') {
    return jsonRes(res, 410, { error: 'web-session 已停用, 请使用 agw web login' });
  }

// GET /admin/api/web-sessions -- panel session overview (active sessions / scheduled logout)
  if (api === 'web-sessions') {
    if (req.method !== 'GET') return jsonRes(res, 405, { error: '只支持 GET' });
    const now = Date.now();
    const panelState = panelStateOf(cfg);
    const dump = (m) => {
      const out = [];
      if (m) for (const [sid, v] of m) {
        const exp = typeof v === 'number' ? v : Number(v && v.exp) || 0;
        const stale = v && v.panelSid && (!panelState || v.panelSid !== panelState.sid);
        if (exp > now && !stale) out.push({ sid, exp });
        else m.delete(sid);
      }
      return out.sort((x, y) => y.exp - x.exp);
    };
    return jsonRes(res, 200, {
      ok: true, now,
      sessions: dump(cfg._webSess),
      pending: [],
      adminExpireAt: Number(cfg.adminExpireAt) || 0,
    });
  }

// GET /admin/api/mdu -- Material You wallpaper primary color (color-bridge)
  // bridge contract: outputs #RRGGBB / {"primary":"#RRGGBB"} / {"tokens":{"primary":"#RRGGBB"}}
  // source order: (1) config.mduCmd or env AGW_MDU_CMD (2) DIR/mdu.json (periodically written by the bridge)
// commands come from this instance's config; only an authenticated admin can trigger them (2.5s timeout)
  if (api === 'mdu') {
    if (req.method !== 'GET') return jsonRes(res, 405, { error: '只支持 GET' });
    const pickHex = (v) => {
      const m = String(v == null ? '' : v).match(/#?([0-9a-f]{6})\b/i);
      return m ? '#' + m[1].toUpperCase() : '';
    };
    const parseHex = (raw) => {
      let j = null; try { j = JSON.parse(raw); } catch (_) {}
      if (j && typeof j === 'object') {
        const hex = pickHex(j.primary || (j.tokens && j.tokens.primary) || (j.colors && j.colors.primary));
        if (hex) return hex;
      }
      return pickHex(raw);
    };
    const mduFile = path.join(DATA(), 'mdu.json');
    const fromFile = () => {
      try { return fs.existsSync(mduFile) ? parseHex(fs.readFileSync(mduFile, 'utf8')) : ''; } catch (_) { return ''; }
    };
    const reply = (hex, source) => jsonRes(res, 200, { ok: true, tokens: { primary: hex }, source });
    const fail = (hint) => jsonRes(res, 503, { ok: false, error: '取色桥不可用: ' + hint });
    const cmd = String(cfg.mduCmd || process.env.AGW_MDU_CMD || '').trim();
    if (!cmd) {
      const hex = fromFile();
      if (hex) return reply(hex, 'file');
      return fail('未配置 mduCmd(或 AGW_MDU_CMD), 也没有 ' + mduFile);
    }
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('sh', ['-c', cmd], { timeout: 2500, maxBuffer: 64 * 1024 },
          (e, so) => (e ? reject(e) : resolve(String(so || ''))));
      });
      const hex = parseHex(out) || fromFile();
      if (hex) return reply(hex, 'cmd');
      return fail('命令输出里没有 #RRGGBB: ' + String(out).trim().slice(0, 120));
    } catch (e) {
      const hex = fromFile();
      if (hex) return reply(hex, 'file');
      return fail(e.message);
    }
  }

// ===== SDUI pages (hand-written JSON; get rendering working before data sources) =====
  // GET /admin/api/ui            → { pages: ["demo","requests"] }
// GET /admin/api/ui/<name>     -> returns DIR/ui/<name>.json verbatim
  // filename whitelist [a-z0-9_-]{1,32}: rejects every traversal attempt
  if (api === 'ui' || api.startsWith('ui/')) {
    if (req.method !== 'GET') return jsonRes(res, 405, { error: '只支持 GET' });
    const dir = path.join(CORE, 'ui');
    if (api === 'ui') {
      let pages = [];
      try {
        pages = fs.readdirSync(dir).filter(f => /^[a-z0-9_-]{1,32}\.json$/.test(f)).map(f => f.slice(0, -5)).sort();
      } catch (e) {}
      return jsonRes(res, 200, { ok: 1, pages, dir });
    }
    const name = decodeURIComponent(api.slice('ui/'.length));
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) return jsonRes(res, 400, { error: '页面名只允许 a-z0-9_-' });
    const f = path.join(dir, name + '.json');
    if (!fs.existsSync(f)) return jsonRes(res, 404, { error: '页面不存在: ' + name + ' (找 ' + f + ')' });
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return jsonRes(res, 500, { error: 'JSON 解析失败: ' + e.message }); }
    return jsonRes(res, 200, j);
  }

// ===== Floating-ball appearance/label hot config =====
  // GET  /admin/api/ball/<inst> → { ok, inst, hash, look:{...}, src:[...] }
// POST /admin/api/ball/<inst> -> writes ball.<inst>.json after whitelist validation; {clear:true} deletes the file
  // files live under DIR and are read per request: edits apply instantly, no gateway restart, no app rebuild
// POST /admin/api/ball-trigger -> deliver an event to the APP immediately (via rish am broadcast)
  if (api === 'ball-trigger') {
    if (req.method !== 'POST') return jsonRes(res, 405, { error: '只支持 POST' });
    let b = {};
    try { b = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'body 必须是 JSON' }); }
    const on = String(b.on || '');
    if (!/^[a-zA-Z0-9_]{1,24}$/.test(on)) return jsonRes(res, 400, { error: '事件名只能是 1..24 位字母数字下划线' });
    const q = x => "'" + String(x).replace(/'/g, "'\\''") + "'";
    let cmd = 'am broadcast -n com.aigateway.app/.overlay.EventReceiver -a com.aigateway.app.EVENT --es k ' + q(on);
    for (const k of ['pct', 'temp', 'vol', 'ssid', 'pkg', 'title', 'text', 'time', 'silence', 'charging']) {
      if (b[k] === undefined || b[k] === null || b[k] === '') continue;
      cmd += ' --es ' + k + ' ' + q(String(b[k]).slice(0, 200));
    }
    const rish = path.join(os.homedir(), 'Shizuku', 'rish');
    if (!fs.existsSync(rish)) return jsonRes(res, 500, { error: '找不到 ' + rish });
    return execFile(rish, ['-c', cmd], { timeout: 8000 }, (err, so, se) => {
      if (err) return jsonRes(res, 500, { error: '广播失败: ' + String(se || err.message).slice(0, 200) });
      return jsonRes(res, 200, { ok: 1, on });
    });
  }

  if (/^ball\/[^/]+$/.test(api)) {
    const name = decodeURIComponent(api.slice('ball/'.length));
    const fInst = path.join(DATA(), 'ball.' + name + '.json');
    const fGlob = path.join(DATA(), 'ball.json');
    const readBall = f => {
      try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { return null; }
    };
    if (req.method === 'GET') {
      const parts = [fGlob, fInst].map(readBall).filter(o => o && typeof o === 'object');
      const look = Object.assign({}, ...parts);
      return jsonRes(res, 200, {
        ok: 1, inst: name, hash: BALL.hashOf(look), look,
        src: [fGlob, fInst].filter(f => fs.existsSync(f)).map(f => path.basename(f))
      });
    }
    if (req.method === 'POST') {
      let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
      if (!loadCfg(name)) return jsonRes(res, 404, { error: '实例不存在: ' + name });
      if (data.clear) {
        try { fs.unlinkSync(fInst); } catch (e) {}
        return jsonRes(res, 200, { ok: 1, cleared: true, inst: name });
      }
      const r = BALL.validate(data.look !== undefined ? data.look : data);
      if (r.error) return jsonRes(res, 400, { error: r.error, allowed: BALL.keys() });
      const clash = BALL.orderClash(r.value);
      if (clash) return jsonRes(res, 400, { error: 'ring order 冲突: ' + clash });
      fs.writeFileSync(fInst, JSON.stringify(r.value, null, 2));
      return jsonRes(res, 200, { ok: 1, inst: name, saved: r.value, file: path.basename(fInst) });
    }
    return jsonRes(res, 405, { error: '只支持 GET/POST' });
  }


// GET /admin/api/instances -- status of all instances
  if (req.method === 'GET' && api === 'instances') {
    const insts = listInstances().map(name => {
      let port = 0, tlsOn = false, chCount = 0, running = false, disabled = false, loadError = false, pid = 0;
// order matters: in single-process mode the pool already holds in-memory configs — read those directly,
//    loadCfg would decrypt every config file (~1.8s) and scryptSync would block the event loop, slowing forwarding
      const inst = POOL ? POOL.instances.get(name) : null;
      if (inst) {
        running = !inst._disabled;
        pid = process.pid;
        port = inst.listen.port; tlsOn = !!(inst.tls && inst.tls.enable);
        chCount = inst.channels.length; disabled = !!inst._disabled;
      } else if (POOL) {
        // not in the pool (not started / failed to load) -> read the file as fallback, keeping the display identical to before the change
        loadError = true; pid = process.pid;
        try { const c = loadCfg(name); port = (c.listen || {}).port || 16384; tlsOn = !!(c.tls && c.tls.enable); chCount = (c.channels || []).length; disabled = !!c.disabled; } catch (_) {}
      } else {
        try { const c = loadCfg(name); port = (c.listen || {}).port || 16384; tlsOn = !!(c.tls && c.tls.enable); chCount = (c.channels || []).length; disabled = !!c.disabled; } catch (_) { loadError = true; }
        const st = getInstanceStatus(name);
        running = st.running; pid = st.pid;
      }
      const mainOnly = tlsOn && name !== 'default';
      return { name, pid, running, disabled, loadError, port, tlsOn, chCount,
        mainOnly,
        pathPrefix: name === 'default' ? '' : ('/' + name) };
    });
    const out = { instances: insts, current: currentName(cfg) };
    if (POOL) { out.multi = true; out.mainPort = POOL.mainPort; }
    return jsonRes(res, 200, out);
  }

// ===== Plugin management =====
// GET /admin/api/plugins/:inst -- installed plugin list + status + recommended plugins
  if (req.method === 'GET' && /^plugins\/[^/]+$/.test(api)) {
    const name = decodeURIComponent(api.slice('plugins/'.length));
    if (!PLUGINS) return jsonRes(res, 500, { error: '插件系统未初始化' });
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    return jsonRes(res, 200, { plugins: PLUGINS.listForInstance(name, c), requiredPlugins: c.requiredPlugins || [] });
  }

// POST /admin/api/plugins-install/:inst -- {url|localPath, sha256?} install a plugin (.tar.gz)
  if (req.method === 'POST' && api.startsWith('plugins-install/')) {
    const name = decodeURIComponent(api.slice('plugins-install/'.length));
    if (!PLUGINS) return jsonRes(res, 500, { error: '插件系统未初始化' });
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    try {
      let result;
      if (data.localPath) result = PLUGINS.installPackage(fs.readFileSync(data.localPath), data.sha256);
      else if (data.url) result = await PLUGINS.installFromUrl(data.url, data.sha256);
      else return jsonRes(res, 400, { error: '需要 url 或 localPath（.tar.gz 插件包）' });
      c.plugins = Array.isArray(c.plugins) ? c.plugins : [];
      if (!c.plugins.find(p => p.id === result.id)) c.plugins.push({ id: result.id, enable: true, version: result.manifest.version || '?', config: {} });
      saveCfg(name, c); hotReload(name);
      return jsonRes(res, 200, { ok: true, id: result.id, name: result.manifest.name, version: result.manifest.version, sha256: result.sha256 });
    } catch (e) { return jsonRes(res, 400, { error: e.message }); }
  }

// POST /admin/api/plugins-remove/:inst -- {id, keepData?} uninstall
  if (req.method === 'POST' && api.startsWith('plugins-remove/')) {
    const name = decodeURIComponent(api.slice('plugins-remove/'.length));
    if (!PLUGINS) return jsonRes(res, 500, { error: '插件系统未初始化' });
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    if (!data.id) return jsonRes(res, 400, { error: '缺少插件 id' });
    PLUGINS.removePlugin(data.id, !!data.keepData);
    c.plugins = (c.plugins || []).filter(p => p.id !== data.id);
    saveCfg(name, c); hotReload(name);
    return jsonRes(res, 200, { ok: true });
  }

// POST /admin/api/plugins-enable/:inst -- {id, enable} enable/disable
  if (req.method === 'POST' && api.startsWith('plugins-enable/')) {
    const name = decodeURIComponent(api.slice('plugins-enable/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    let pc = (c.plugins || []).find(p => p.id === data.id);
    if (!pc) {
      // plugins dropped into plugins/ manually but never registered: auto-register, then set the enabled state
      if (!PLUGINS || !PLUGINS.installed.has(data.id)) return jsonRes(res, 404, { error: '插件未安装: ' + data.id });
      c.plugins = Array.isArray(c.plugins) ? c.plugins : [];
      pc = { id: data.id, enable: false, version: (PLUGINS.installed.get(data.id).manifest.version || '?'), config: {} };
      c.plugins.push(pc);
    }
    pc.enable = !!data.enable;
    saveCfg(name, c); hotReload(name);
    return jsonRes(res, 200, { ok: true, enable: pc.enable });
  }

// GET/POST /admin/api/plugins-config/:inst/:id -- read/write plugin settings
  if (api.startsWith('plugins-config/')) {
    const rest = api.slice('plugins-config/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return jsonRes(res, 400, { error: '路径应为 plugins-config/:inst/:id' });
    const name = decodeURIComponent(rest.slice(0, slash));
    const pid = decodeURIComponent(rest.slice(slash + 1));
    if (!PLUGINS) return jsonRes(res, 500, { error: '插件系统未初始化' });
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    if (req.method === 'GET') {
      const sc = PLUGINS.configSchema(name, pid, c);
      if (!sc) return jsonRes(res, 404, { error: '插件未安装: ' + pid });
      return jsonRes(res, 200, { id: pid, schema: sc.schema, config: sc.config });
    }
    if (req.method === 'POST') {
      let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
      const pc = (c.plugins || []).find(p => p.id === pid);
      if (!pc) return jsonRes(res, 404, { error: '插件未安装: ' + pid });
      pc.config = (data && typeof data.config === 'object' && data.config) ? data.config : {};
      saveCfg(name, c); hotReload(name);
      return jsonRes(res, 200, { ok: true });
    }
    return jsonRes(res, 405, { error: 'Method Not Allowed' });
  }

// POST /admin/api/plugins-required/:inst -- {requiredPlugins:[{id,name,...}]} set the first-login recommendations
  if (req.method === 'POST' && api.startsWith('plugins-required/')) {
    const name = decodeURIComponent(api.slice('plugins-required/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    c.requiredPlugins = Array.isArray(data.requiredPlugins) ? data.requiredPlugins : [];
    saveCfg(name, c); hotReload(name);
    return jsonRes(res, 200, { ok: true, requiredPlugins: c.requiredPlugins });
  }

// GET /admin/api/plugins-index?url=<indexUrl> -- fetch a custom index's plugin list (browse)
  if (req.method === 'GET' && api === 'plugins-index') {
    const indexUrl = u.searchParams && u.searchParams.get('url');
    if (!indexUrl) return jsonRes(res, 400, { error: '缺少 url 参数' });
    try {
      const { downloadBuf } = require('./plugins.js');
      const buf = await downloadBuf(indexUrl, 2 * 1024 * 1024);
      const idx = JSON.parse(buf.toString('utf8'));
      return jsonRes(res, 200, { name: idx.name || '', plugins: idx.plugins || [] });
    } catch (e) { return jsonRes(res, 400, { error: '索引拉取失败: ' + e.message }); }
  }

// GET /admin/api/config/:name -- read an instance's config (with ?reveal=1 secrets come back in plaintext for panel editing)
  if (req.method === 'GET' && api.startsWith('config/')) {
    const name = decodeURIComponent(api.slice('config/'.length));
    const reveal = !!(u.searchParams && u.searchParams.get('reveal') === '1');
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    return jsonRes(res, 200, {
      name, port: (c.listen || {}).port || 16384, host: (c.listen || {}).host || '0.0.0.0',
      gatewayKey: reveal ? (c.gatewayKey || '') : (c.gatewayKey ? '(已设)' : ''),
      webToken: reveal ? (c.webToken || '') : (c.webToken ? '(已设)' : ''),
      panel: { openBrowser: !(c.panel && c.panel.openBrowser === false) },
      tls: c.tls || { enable: false },
      redact: maskRedactCfg(c),
      replace: c.replace || { out: [], inc: [] },
      record: c.record || { enable: false, server: '' },
      probe: c.probe || { enable: false, intervalMin: 10, mode: 'models' },
      keyLength: c.keyLength || 24,
      modelSync: c.modelSync || { enable: true, intervalHours: 24 },
      proxies: c.proxies || {},
      channels: maskedChannels(c, reveal),
      forceChannel: c.forceChannel || null,
    });
  }

// POST /admin/api/config/:name -- save config (wholesale replace of channels/port etc.)
  if (req.method === 'POST' && api.startsWith('config/')) {
    const name = decodeURIComponent(api.slice('config/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data;
    try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
// Only some fields are editable; apiKey keeps its value (the client sends only a keyPrefix, never the secret)
    if (data.port != null) { c.listen = c.listen || {}; c.listen.port = Number(data.port); }
    if (data.host != null) { c.listen = c.listen || {}; c.listen.host = data.host; }
    if (data.gatewayKey !== undefined) c.gatewayKey = data.gatewayKey;
    if (data.webToken !== undefined) {
      const nextToken = String(data.webToken || '');
      const oldToken = String(c.webToken || '');
      if (nextToken !== oldToken) {
        if (nextToken && oldToken) {
          c.webTokenPrev = oldToken;
          c.webTokenPrevUntil = Date.now() + WEB_TOKEN_GRACE_MS;
        } else {
          delete c.webTokenPrev;
          delete c.webTokenPrevUntil;
        }
        c.webToken = nextToken;
      }
    }
    if (data.panel !== undefined && data.panel && typeof data.panel === 'object') {
      c.panel = { ...(c.panel || {}), openBrowser: data.panel.openBrowser !== false };
    }
    if (data.tls !== undefined) {
      c.tls = (data.tls && typeof data.tls === 'object') ? data.tls : { enable: false };
      if (c.tls.enable) delete c.tls.port;
    }
    if (data.redact !== undefined && data.redact && typeof data.redact === 'object') {
// merge, don't replace: a panel that sends only {enable} must not wipe the extra rules
      const next = Object.assign({}, c.redact || {}, data.redact);
      next.enable = next.enable !== false;
      next.response = !!next.response;
      next.extra = normalizeRedactExtra(next.extra);
      c.redact = next;
    }
    if (data.replace !== undefined && data.replace && typeof data.replace === 'object') {
      const rp = data.replace;
      c.replace = {
        out: Array.isArray(rp.out) ? rp.out.filter(r => r && r.re).map(r => ({ re: String(r.re), to: String(r.to == null ? '' : r.to), ci: !!r.ci })) : [],
        inc: Array.isArray(rp.inc) ? rp.inc.filter(r => r && r.re).map(r => ({ re: String(r.re), to: String(r.to == null ? '' : r.to), ci: !!r.ci })) : [],
      };
    }
    if (data.modelSync !== undefined && data.modelSync && typeof data.modelSync === 'object') {
      c.modelSync = {
        enable: data.modelSync.enable !== false,
        intervalHours: Math.max(1, Number(data.modelSync.intervalHours) || 24),
        intervalMin: Number(data.modelSync.intervalMin) > 0 ? Number(data.modelSync.intervalMin) : null,
      };
    }
// Key card length (8-128)
    if (data.keyLength !== undefined) c.keyLength = Math.min(128, Math.max(8, Number(data.keyLength) || 24));
    // success-rate probe config
    if (data.probe !== undefined && data.probe && typeof data.probe === 'object') {
      c.probe = {
        enable: !!data.probe.enable,
        intervalMin: Math.max(1, Number(data.probe.intervalMin) || 10),
        mode: data.probe.mode === 'chat' ? 'chat' : 'models',
      };
    }
// Request recording: enable switch + collector server address (empty = local JSONL file)
    if (data.record !== undefined && data.record && typeof data.record === 'object') {
      c.record = {
        enable: !!data.record.enable,
        server: String(data.record.server || '').trim(),
        maxChars: Number(data.record.maxChars) > 0 ? Number(data.record.maxChars) : 200000,
      };
    }
    if (data.proxies !== undefined) c.proxies = data.proxies;
    if (Array.isArray(data.channels)) {
// Preserve apiKey: a submitted channel with hasKey but no apiKey inherits the old value
      const oldMap = {};
      const oldChans = {};
      for (const ch of (c.channels || [])) { oldMap[ch.name] = ch.apiKey; oldChans[ch.name] = ch; }
      c.channels = data.channels.map(ch => {
        const out = { ...ch };
        if (!out.apiKey && oldMap[out.name] !== undefined) out.apiKey = oldMap[out.name];
        if (!out.apiKey) out.apiKey = '';
        mergeBalanceFields(out, oldChans[out.name]);
        if (out.path === undefined) { if (oldChans[out.name] && oldChans[out.name].path !== undefined) out.path = oldChans[out.name].path; }
        out.path = normalizeChannelPath(out.path);
        if (!out.path) delete out.path;
        return out;
      });
    }
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (POOL) {
      try { hotReload(name); return jsonRes(res, 200, { ok: true, hotReload: true }); }
      catch (e) { return jsonRes(res, 200, { ok: true, hotReload: false, warn: '配置已保存但热重载失败: ' + e.message }); }
    }
    jsonRes(res, 200, { ok: true, restarting: true });
    scheduleRestart(cfg, name);
    return;
  }

// POST /admin/api/instance-create/:name -- create an instance (writes config.<name>.json; effective immediately in pool mode)
  if (req.method === 'POST' && api.startsWith('instance-create/')) {
    const name = decodeURIComponent(api.slice('instance-create/'.length));
    if (!INST_NAME_RE.test(name)) return jsonRes(res, 400, { error: '实例名只能含字母/数字/中划线/下划线, 最长32字符' });
    if (RESERVED_PATHS.has(name) || name === 'example') return jsonRes(res, 400, { error: '实例名 ' + name + ' 是保留字(与 API 路径冲突), 请换一个' });
    if (name === 'default') return jsonRes(res, 400, { error: 'default 是主实例, 请直接编辑' });
    if (fs.existsSync(cfgFile(name))) return jsonRes(res, 409, { error: '实例 ' + name + ' 已存在' });
    let data;
    try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const port = Number(data.port);
    if (!port || port < 1024 || port > 65535) return jsonRes(res, 400, { error: 'HTTP 端口范围 1024-65535' });
    const tls = (data.tls && typeof data.tls === 'object') ? data.tls : { enable: false };
    if (tls.enable) {
      if (!tls.cert || !tls.key) return jsonRes(res, 400, { error: '启用 HTTPS 需要证书路径(tls.cert/tls.key)' });
      delete tls.port;
    }
    const cfg = {
      listen: { port, host: data.host || '0.0.0.0' },
      tls,
      webToken: typeof data.webToken === 'string' ? data.webToken : '',
      gatewayKey: '',
      channels: Array.isArray(data.channels) ? data.channels : [], proxies: {}, modelMap: {}, models: [],
      routing: { maxRetry: 2, timeoutSec: 120, cooldownSec: 30 },
    };
    try { saveCfg(name, cfg); } catch (e) { return jsonRes(res, 500, { error: '创建失败: ' + e.message }); }
    if (POOL) {
      try { hotReload(name); } catch (e) { return jsonRes(res, 500, { error: '实例已创建但加载失败: ' + e.message }); }
      return jsonRes(res, 200, { ok: true, hotReload: true, url: '/' + name + '/v1' });
    }
    return jsonRes(res, 200, { ok: true });
  }

// POST /admin/api/channel/:name -- add/edit a single channel
  if (req.method === 'POST' && api.startsWith('channel/')) {
    const name = decodeURIComponent(api.slice('channel/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let ch;
    try { ch = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    if (!ch.name) return jsonRes(res, 400, { error: '需要渠道名' });
    // rename support: oldName present and different from the new name = rename the channel (atomic replace, apiKey kept)
    const oldName = ch.oldName ? String(ch.oldName) : '';
    delete ch.oldName;
let prevCh = null; // the previous channel object: inherits fields absent from the body (the balance trio)
    if (oldName && oldName !== ch.name) {
      if ((c.channels || []).some(x => x.name === ch.name)) return jsonRes(res, 409, { error: '渠道名 ' + ch.name + ' 已被占用' });
      const target = (c.channels || []).find(x => x.name === oldName);
      if (!target) return jsonRes(res, 404, { error: '原渠道不存在: ' + oldName });
      prevCh = target;
      if (!ch.apiKey || ch.apiKey.includes('***')) ch.apiKey = target.apiKey || '';
      if (ch.default) { for (const x of c.channels) x.default = false; }
      c.channels = (c.channels || []).filter(x => x.name !== oldName);
      c.channels.push(ch);
    } else {
// When editing (same name exists) without a submitted apiKey, keep the old one
      const existing = (c.channels || []).find(x => x.name === ch.name);
      prevCh = existing || null;
      if (existing && (!ch.apiKey || ch.apiKey.includes('***'))) ch.apiKey = existing.apiKey;
      if (ch.default) { for (const x of (c.channels || [])) x.default = false; }
      c.channels = (c.channels || []).filter(x => x.name !== ch.name);
      if (!ch.apiKey) ch.apiKey = '';
      c.channels.push(ch);
    }
// Balance passthrough three fields: omitted by panel/App (undefined) = inherit, explicit empty string = clear -- prevents "one channel edit wipes the balance config"
    mergeBalanceFields(ch, prevCh);
// Channel path lock follows the same rule: omitted = inherit, explicit empty = clear
    if (ch.path === undefined) { if (prevCh && prevCh.path !== undefined) ch.path = prevCh.path; }
    else if (ch.path === '' || ch.path === null) delete ch.path;
    else {
      if (/^https?:\/\//i.test(String(ch.path).trim())) return jsonRes(res, 400, { error: 'path 必须是路径, 不能是完整 URL' });
      ch.path = normalizeChannelPath(ch.path);
      if (!ch.path) delete ch.path;
    }
    ch.path = normalizeChannelPath(ch.path);
    if (!ch.path) delete ch.path;
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (POOL) {
      try { hotReload(name); return jsonRes(res, 200, { ok: true, hotReload: true }); }
      catch (e) { return jsonRes(res, 200, { ok: true, hotReload: false, warn: '已保存但热重载失败: ' + e.message }); }
    }
    jsonRes(res, 200, { ok: true, restarting: true });
    scheduleRestart(cfg, name);
    return;
  }

// GET/POST /admin/api/route-once/:name -- one-shot routing: affects only the next request, never persisted, self-clearing after use
  if (api.startsWith('route-once/')) {
    const name = decodeURIComponent(api.slice('route-once/'.length));
    const live = POOL ? POOL.instances.get(name) : (name === currentName(cfg) ? cfg : null);
    if (!live) return jsonRes(res, 404, { error: '实例未在运行: ' + name });
    if (req.method === 'GET') return jsonRes(res, 200, { ok: true, channel: live._onceChannel || null });
    let b;
    try { b = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const ch = b.channel ? String(b.channel) : null;
    if (ch && !(live.channels || []).some(x => x.name === ch)) return jsonRes(res, 404, { error: '渠道不存在: ' + ch });
    live._onceChannel = ch;
    return jsonRes(res, 200, { ok: true, channel: ch });
  }

// GET/POST /admin/api/route/:name -- manual routing (persistent): pin to a channel; empty channel = back to auto
  if (api.startsWith('route/')) {
    const name = decodeURIComponent(api.slice('route/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    if (req.method === 'GET') return jsonRes(res, 200, { ok: true, channel: c.forceChannel || null });
    let b;
    try { b = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const ch = b.channel ? String(b.channel) : null;
    if (ch && !(c.channels || []).some(x => x.name === ch)) return jsonRes(res, 404, { error: '渠道不存在: ' + ch });
    if (ch) c.forceChannel = ch; else delete c.forceChannel;
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    const live = POOL ? POOL.instances.get(name) : null;
    if (live) {
      if (ch) live.forceChannel = ch; else delete live.forceChannel;
      return jsonRes(res, 200, { ok: true, channel: ch, applied: 'live' });
    }
    if (POOL) {
      try { hotReload(name); return jsonRes(res, 200, { ok: true, channel: ch, applied: 'reload' }); }
      catch (e) { return jsonRes(res, 200, { ok: true, channel: ch, warn: '已保存但热重载失败: ' + e.message }); }
    }
    jsonRes(res, 200, { ok: true, channel: ch, applied: 'saved' });
    return;
  }

// DELETE /admin/api/channel/:name/:chname -- delete a channel
  if (req.method === 'DELETE' && api.startsWith('channel/')) {
    const parts = api.slice('channel/'.length).split('/');
    const name = decodeURIComponent(parts[0]);
    const chname = decodeURIComponent(parts.slice(1).join('/'));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    const before = (c.channels || []).length;
    c.channels = (c.channels || []).filter(x => x.name !== chname);
    if (c.channels.length < before) {
      saveCfg(name, c);
      if (POOL) {
        try { hotReload(name); return jsonRes(res, 200, { ok: true, hotReload: true }); }
        catch (e) { return jsonRes(res, 200, { ok: true, hotReload: false, warn: '已保存但热重载失败: ' + e.message }); }
      }
      jsonRes(res, 200, { ok: true, restarting: true });
      scheduleRestart(cfg, name);
      return;
    }
    return jsonRes(res, 404, { error: '渠道不存在' });
  }

// DELETE /admin/api/instance/:name -- delete an instance (stops the process first, then removes config/log/pid; default and the panel host cannot be deleted)
  if (req.method === 'DELETE' && api.startsWith('instance/')) {
    const name = decodeURIComponent(api.slice('instance/'.length));
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return jsonRes(res, 400, { error: '实例名非法' });
    if (name === 'default') return jsonRes(res, 400, { error: 'default 是主实例, 不能删除' });
    if (name === currentName(cfg)) return jsonRes(res, 400, { error: '不能删除承载面板的实例' });
    if (!fs.existsSync(cfgFile(name))) return jsonRes(res, 404, { error: '实例不存在' });
    if (POOL) { try { POOL.removeInst(name); } catch (_) {} }
    else { await runAgw(['stop', name]); } // 旧多进程模式: 运行中先停止
    try { fs.unlinkSync(cfgFile(name)); } catch (e) { return jsonRes(res, 500, { error: '删除配置失败: ' + e.message }); }
cfgCacheClear(); // file deleted; clear the cache to avoid leftovers
    try { fs.unlinkSync(path.join(MLOG(), name + '.log')); } catch (e) {}
    try { fs.unlinkSync(path.join(MRUN(), name + '.pid')); } catch (e) {}
    return jsonRes(res, 200, { ok: true });
  }

// ============ Admin second-factor config ============
// GET /admin/api/admin-auth/:inst -- second-factor status (never returns the secret itself)
  if (req.method === 'GET' && api.startsWith('admin-auth/')) {
    const name = decodeURIComponent(api.slice('admin-auth/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    const aa = c.adminAuth || {};
    return jsonRes(res, 200, {
      hasWebToken: !!c.webToken,
      secondKeySet: !!aa.secondKey,
      totpEnabled: !!aa.totpSecret,
profile: c.adminProfile || {},       // admin profile (agw admin profile)
expireAt: c.adminExpireAt || 0,      // panel session expiry (agw admin expire)
    });
  }

// POST /admin/api/admin-auth/:inst -- configure {secondKey?, totpAction?: 'enable'|'disable'}
  if (req.method === 'POST' && api.startsWith('admin-auth/')) {
    const name = decodeURIComponent(api.slice('admin-auth/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    c.adminAuth = c.adminAuth && typeof c.adminAuth === 'object' ? c.adminAuth : {};
    if (data.secondKey !== undefined) c.adminAuth.secondKey = String(data.secondKey || '');
    let newTotp = null;
    if (data.totpAction === 'enable') {
      newTotp = base32Encode(crypto2.randomBytes(20));
      c.adminAuth.totpSecret = newTotp;
    } else if (data.totpAction === 'disable') {
      delete c.adminAuth.totpSecret;
    }
    if (!c.adminAuth.secondKey && !c.adminAuth.totpSecret) delete c.adminAuth;
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (POOL) { try { hotReload(name); } catch (_) {} }
    const out = { ok: true, secondKeySet: !!((c.adminAuth || {}).secondKey), totpEnabled: !!((c.adminAuth || {}).totpSecret) };
    if (newTotp) {
      out.totpSecret = newTotp;
      out.otpauthUrl = 'otpauth://totp/ai-gateway-' + encodeURIComponent(name) + '?secret=' + newTotp + '&issuer=ai-gateway';
    }
    return jsonRes(res, 200, out);
  }

// ============ Key card management ============
// GET /admin/api/keys/:inst -- key card list (fully visible to admins, including usage)
  if (req.method === 'GET' && api.startsWith('keys/')) {
    const name = decodeURIComponent(api.slice('keys/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    // in-pool usage counts come from memory (disk lags)
    const live = POOL && POOL.instances.get(name);
    const liveMap = {};
    if (live && Array.isArray(live.apiKeys)) for (const k of live.apiKeys) liveMap[k.key] = k.usedTokens || 0;
    const keys = (c.apiKeys || []).map(k => ({
      key: k.key, name: k.name || '', enable: k.enable !== false,
      quotaTokens: Number(k.quotaTokens) || 0,
      usedTokens: liveMap[k.key] !== undefined ? liveMap[k.key] : (Number(k.usedTokens) || 0),
      models: k.models || [], channels: k.channels || [], branches: k.branches || [],
      redact: k.redact == null ? null : !!k.redact,
      expiresAt: k.expiresAt || '', note: k.note || '', createdAt: k.createdAt || '',
    }));
    return jsonRes(res, 200, { keys, gatewayKeySet: !!c.gatewayKey });
  }

// POST /admin/api/keys/:inst -- issue a card {name, quotaTokens, models, channels, expiresAt, note} -> returns the full key
  if (req.method === 'POST' && /^keys\/[^/]+$/.test(api)) {
    const name = decodeURIComponent(api.slice('keys/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const klen = Math.min(128, Math.max(8, Number(c.keyLength) || 24));
    const key = 'sk-' + crypto2.randomBytes(Math.ceil(klen * 3 / 4) + 2).toString('base64url').slice(0, klen);
    c.apiKeys = Array.isArray(c.apiKeys) ? c.apiKeys : [];
    const nk = {
      key,
      name: String(data.name || '').trim().slice(0, 64),
      enable: true,
      quotaTokens: Math.max(0, Number(data.quotaTokens) || 0),
      usedTokens: 0,
      models: Array.isArray(data.models) ? data.models.map(s => String(s).trim()).filter(Boolean) : [],
      channels: Array.isArray(data.channels) ? data.channels.map(s => String(s).trim()).filter(Boolean) : [],
      branches: Array.isArray(data.branches) ? data.branches.map(s => String(s).trim()).filter(Boolean) : [],
      expiresAt: String(data.expiresAt || '').trim(),
      note: String(data.note || '').trim().slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    c.apiKeys.push(nk);
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (POOL) { try { hotReload(name); } catch (_) {} }
    return jsonRes(res, 200, { ok: true, key: nk });
  }

// POST /admin/api/keys-update/:inst -- edit a key card {key, enable?, quotaTokens?, addQuota?, resetUsage?, name?, models?, channels?, expiresAt?, note?}
  if (req.method === 'POST' && api.startsWith('keys-update/')) {
    const name = decodeURIComponent(api.slice('keys-update/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const k = (c.apiKeys || []).find(x => x.key === data.key);
    if (!k) return jsonRes(res, 404, { error: '卡密不存在' });
    if (data.enable !== undefined) k.enable = !!data.enable;
    if (data.quotaTokens !== undefined) k.quotaTokens = Math.max(0, Number(data.quotaTokens) || 0);
    if (data.name !== undefined) k.name = String(data.name).trim().slice(0, 64);
    if (data.models !== undefined) k.models = Array.isArray(data.models) ? data.models.map(s => String(s).trim()).filter(Boolean) : [];
    if (data.channels !== undefined) k.channels = Array.isArray(data.channels) ? data.channels.map(s => String(s).trim()).filter(Boolean) : [];
    if (data.branches !== undefined) k.branches = Array.isArray(data.branches) ? data.branches.map(s => String(s).trim()).filter(Boolean) : [];
    if (data.redact !== undefined) k.redact = (data.redact == null) ? null : !!data.redact;
    if (data.expiresAt !== undefined) k.expiresAt = String(data.expiresAt || '').trim();
    if (data.note !== undefined) k.note = String(data.note).trim().slice(0, 200);
// In-memory adjustments (usage/quota); memory wins over disk
    const live = POOL && POOL.instances.get(name);
    const lk = live && (live.apiKeys || []).find(x => x.key === data.key);
    if (data.resetUsage) { k.usedTokens = 0; if (lk) lk.usedTokens = 0; }
    if (data.addQuota) { k.quotaTokens = (Number(k.quotaTokens) || 0) + Math.max(0, Number(data.addQuota) || 0); }
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (POOL) { try { hotReload(name); } catch (_) {} }
    return jsonRes(res, 200, { ok: true, hotReload: !!POOL });
  }

// DELETE /admin/api/keys/:inst/:key -- delete a key card
  if (req.method === 'DELETE' && api.startsWith('keys/')) {
    const rest = api.slice('keys/'.length);
    const idx = rest.indexOf('/');
    if (idx > 0) {
      const name = decodeURIComponent(rest.slice(0, idx));
      const key = decodeURIComponent(rest.slice(idx + 1));
      const c = loadCfg(name);
      if (!c) return jsonRes(res, 404, { error: '实例不存在' });
      const before = (c.apiKeys || []).length;
      c.apiKeys = (c.apiKeys || []).filter(x => x.key !== key);
      if (c.apiKeys.length < before) {
        try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
        if (POOL) { try { hotReload(name); } catch (_) {} }
        return jsonRes(res, 200, { ok: true });
      }
      return jsonRes(res, 404, { error: '卡密不存在' });
    }
  }

// ============ Channel balance proxy lookup ============
// Implementation injected by gateway.js (setBalanceFn): uses the channel proxy/insecure/timeouts; presets + channel-level balanceUrl/balancePath/balanceUnit overrides
// GET /admin/api/balance/:inst/:ch -- proxy-lookup a channel balance (uses the channel apiKey)
  if (req.method === 'GET' && api.startsWith('balance/')) {
    const rest = api.slice('balance/'.length);
    const idx = rest.indexOf('/');
    if (idx < 0) return jsonRes(res, 400, { error: '路径应为 balance/<实例>/<渠道>' });
    const name = decodeURIComponent(rest.slice(0, idx));
    const chName = decodeURIComponent(rest.slice(idx + 1));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    const ch = (c.channels || []).find(x => x.name === chName);
    if (!ch) return jsonRes(res, 404, { error: '渠道不存在' });
    if (!BALANCE_FN) return jsonRes(res, 500, { error: '余额查询未就绪(网关未注入实现, 请重启网关)' });
    return BALANCE_FN(c, ch, (r) => {
      if (r && r.ok) return jsonRes(res, 200, { ok: true, channel: ch.name, balance: r.balance, unit: r.unit || '', url: r.url, ...(Array.isArray(r.amounts) && r.amounts.length > 1 ? { amounts: r.amounts } : {}) });
      jsonRes(res, (r && r.status) || 502, { error: (r && r.error) || '余额查询失败', ...(r && r.raw ? { raw: r.raw } : {}) });
    });
  }

// ============ cloudflared public tunnel (free temporary domain) ============
  if (api === 'tunnel' || api.startsWith('tunnel?')) {
    const mainPort = () => (POOL && POOL.mainPort) || (cfg.listen && cfg.listen.port) || 16384;
    const doStart = () => {
      if (tunnelProc) return { ok: true, url: tunnelUrl, running: true, already: true };
      tunnelUrl = ''; tunnelLog = [];
      try {
        const { spawn } = require('child_process');
        const originTls = !!(cfg.tls && cfg.tls.enable);
        const origin = (originTls ? 'https://127.0.0.1:' : 'http://127.0.0.1:') + mainPort();
        const cfArgs = ['tunnel', '--url', origin, '--no-autoupdate'];
        if (originTls) cfArgs.push('--no-tls-verify');
        tunnelProc = spawn('cloudflared', cfArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { tunnelProc = null; return { error: 'cloudflared 启动失败(未安装?): ' + e.message }; }
      const u8c = utf8();
      let lineBuf = '';
      const onData = (buf) => {
        lineBuf += u8c(buf);
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop();
        for (const line of lines) {
          tunnelLog.push(line.trim().slice(0, 300)); if (tunnelLog.length > 60) tunnelLog.shift();
          const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (m && !tunnelUrl) tunnelUrl = m[0];
        }
      };
      tunnelProc.stdout.on('data', onData);
      tunnelProc.stderr.on('data', onData);
      tunnelProc.on('exit', () => { tunnelProc = null; tunnelUrl = ''; });
      tunnelProc.on('error', (e) => { tunnelLog.push('spawn error: ' + e.message); tunnelProc = null; });
      return { ok: true, starting: true };
    };
    const doStop = () => {
      if (tunnelProc) { try { tunnelProc.kill('SIGTERM'); } catch (_) {} tunnelProc = null; }
      tunnelUrl = '';
      return { ok: true };
    };
    if (req.method === 'GET') {
      return jsonRes(res, 200, { running: !!tunnelProc, url: tunnelUrl, log: tunnelLog.slice(-12), next: tunnelNext });
    }
    if (req.method === 'POST') {
      let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
      if (data.action === 'cancel') {
        if (tunnelTimer) clearTimeout(tunnelTimer);
        tunnelTimer = null; tunnelNext = null;
        return jsonRes(res, 200, { ok: true, cancelled: true });
      }
      if (data.action !== 'start' && data.action !== 'stop') return jsonRes(res, 400, { error: 'action 应为 start/stop/cancel' });
      const at = Number(data.at) || 0;
      if (at > Date.now()) {
        if (tunnelTimer) clearTimeout(tunnelTimer);
        tunnelNext = { action: data.action, at };
        tunnelTimer = setTimeout(() => {
          tunnelTimer = null; tunnelNext = null;
          try { data.action === 'start' ? doStart() : doStop(); }
          catch (e) { tunnelLog.push('scheduled ' + data.action + ' 失败: ' + e.message); }
        }, at - Date.now());
        return jsonRes(res, 200, { ok: true, scheduled: data.action, at });
      }
      const r = data.action === 'start' ? doStart() : doStop();
      return jsonRes(res, r.error ? 500 : 200, r);
    }
  }

// POST /admin/api/probe/:inst -- run a probe round immediately on channels with probe enabled
  if (req.method === 'POST' && /^probe\/[^/]+$/.test(api)) {
    const name = decodeURIComponent(api.slice('probe/'.length));
    const tc = POOL && POOL.instances.get(name);
    if (!tc) return jsonRes(res, 404, { error: '实例未在运行: ' + name });
    if (!tc.probe || !tc.probe.enable) return jsonRes(res, 400, { error: '该实例未开启探测 (配置 probe.enable)' });
    const gw = require('./gateway.js');
    if (gw.probeRound) gw.probeRound(tc);
    return jsonRes(res, 200, { ok: true, probe: tc._stats.probe || {}, debug: (tc.channels || []).map(c => ({ name: c.name, probe: !!c.probe })) });
  }

// POST /admin/api/instance-rename/:name -- rename an instance (hot in single-process mode; body {newName})
  if (req.method === 'POST' && api.startsWith('instance-rename/')) {
    const name = decodeURIComponent(api.slice('instance-rename/'.length));
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const newName = String(data.newName || '').trim();
    if (name === 'default') return jsonRes(res, 400, { error: 'default 是主实例, 不能改名' });
    if (!INST_NAME_RE.test(newName)) return jsonRes(res, 400, { error: '新实例名只能含字母/数字/中划线/下划线, 最长32字符' });
    if (RESERVED_PATHS.has(newName)) return jsonRes(res, 400, { error: '「' + newName + '」是保留名(与 API 路径冲突), 不能用作实例名' });
    if (newName === name) return jsonRes(res, 400, { error: '新旧名称相同' });
    if (!fs.existsSync(cfgFile(name))) return jsonRes(res, 404, { error: '实例不存在: ' + name });
    if (fs.existsSync(cfgFile(newName))) return jsonRes(res, 409, { error: '实例名已存在: ' + newName });
// 1) rename the config file (content untouched; works for encrypted files too)
    try { fs.renameSync(cfgFile(name), cfgFile(newName)); }
    catch (e) { return jsonRes(res, 500, { error: '重命名配置文件失败: ' + e.message }); }
cfgCacheClear(); // the file name changed -> cache keys are stale; clear to avoid cross-contamination
// 2) also rename log/pid/key-usage files (best effort)
    try { fs.renameSync(path.join(MLOG(), name + '.log'), path.join(MLOG(), newName + '.log')); } catch (_) {}
    try { fs.renameSync(path.join(MRUN(), name + '.pid'), path.join(MRUN(), newName + '.pid')); } catch (_) {}
    try { fs.renameSync(path.join(MLOG(), 'keyusage-' + name + '.json'), path.join(MLOG(), 'keyusage-' + newName + '.json')); } catch (_) {}
// 3) single-process mode: hot rename inside the pool (effective immediately; old port closed, new port listening)
    if (POOL) {
      try { POOL.renameInst(name, newName); }
catch (e) { /* cold-load when not in the pool */ try { POOL.reload(newName); } catch (_) {} }
      return jsonRes(res, 200, { ok: true, hotReload: true, name: newName, url: '/' + newName + '/v1' });
    }
    jsonRes(res, 200, { ok: true, name: newName, restarting: true });
    scheduleRestart(cfg, newName);
    return;
  }

// POST /admin/api/sync-models[?instance=X] -- sync channel model lists immediately for the given instance (default = the hosting instance)
  if (req.method === 'POST' && api === 'sync-models') {
    if (!syncFn) return jsonRes(res, 501, { error: '网关未提供同步能力' });
    let inst = (u.searchParams && u.searchParams.get('instance')) || '';
    if (!inst && bodyStr) { try { const bj = JSON.parse(bodyStr); inst = bj.instance || ''; } catch (_) {} }
    if (inst && POOL && !POOL.instances.has(inst)) return jsonRes(res, 404, { error: '实例不存在: ' + inst });
    try {
      const r = await syncFn(inst || undefined);
      return jsonRes(res, 200, Object.assign({ ok: true }, r));
    } catch (e) { return jsonRes(res, 502, { error: e.message }); }
  }

// POST /admin/api/channel-models/:inst -- fetch a channel's upstream model list (server-side fetch: avoids browser CORS, uses the real apiKey and channel proxy)
  if (req.method === 'POST' && api.startsWith('channel-models/')) {
    const inst = decodeURIComponent(api.slice('channel-models/'.length));
    const c = loadCfg(inst);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data;
    try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const ch = data.name ? (c.channels || []).find(x => x.name === data.name) : null;
    const type = data.type || (ch && ch.type) || 'openai';
    const baseUrl = String(data.baseUrl || (ch && ch.baseUrl) || '').trim();
    const apiKey = String(data.apiKey || (ch && ch.apiKey) || '').trim();
    const proxy = String(data.proxy || (ch && ch.proxy) || '-');
    if (!baseUrl) return jsonRes(res, 400, { error: 'Base URL 为空, 无法拉取模型列表' });
    if (!upstreamModelsFn) return jsonRes(res, 501, { error: '当前网关版本未提供拉取能力, 请升级 gateway.js' });
    upstreamModelsFn({ type, baseUrl, apiKey, proxy, anthropicVersion: ch && ch.anthropicVersion })
      .then(models => jsonRes(res, 200, { models }))
      .catch(e => jsonRes(res, 502, { error: e.message }));
    return;
  }

  // POST /admin/api/action/:name/:action — start/stop/restart
  if (req.method === 'POST' && api.startsWith('action/')) {
    const parts = api.slice('action/'.length).split('/');
    const name = decodeURIComponent(parts[0]);
    const action = parts[1];
    if (!['start', 'stop', 'restart'].includes(action)) return jsonRes(res, 400, { error: '未知操作' });
// ===== Single-process multi-instance mode: start/stop = hot load/detach, instant, no setsid restart script =====
    if (POOL) {
      if (action === 'stop' && name === 'default') return jsonRes(res, 400, { error: 'default 是主实例(主端口所在), 不能停止; 要全停用 shutdown-all' });
      if (action === 'stop') {
        if (!POOL.instances.has(name)) return jsonRes(res, 404, { error: '实例未在运行: ' + name });
        POOL.removeInst(name);
        return jsonRes(res, 200, { ok: true, hot: true, output: '实例 ' + name + ' 已从池中摘除(配置保留, start 可恢复)' });
      }
// both start and restart (re)load
      const c = POOL.reload(name);
      if (!c) return jsonRes(res, 404, { error: '实例配置不存在: ' + name });
      return jsonRes(res, 200, { ok: true, hot: true, output: (action === 'start' ? '已加载' : '已热重载') + '实例 ' + name + ' (' + c.channels.length + ' 渠道)' });
    }
    // the target is this very instance: stop/restart would kill our own process (response cut off + start may never run)
// -> reply to the client first, then run stop/start in a fully detached setsid child (leaves the parent's process group; survives the parent's death)
    if (name === currentName(cfg) && (action === 'stop' || action === 'restart')) {
      jsonRes(res, 200, { ok: true, output: action + ' ' + name + ' (自我' + (action==='restart'?'重启':'停止') + ', 稍候生效, 请刷新页面)', self: true });
// Write a temp script: setsid + nohup so it escapes the process group and finishes even if the parent dies
      const tmpScript = path.join(os.tmpdir() || CORE, '.agw-self-' + action + '.sh');
      const agwPath = path.join(CORE, 'agw.sh');
      if (action === 'restart') {
        fs.writeFileSync(tmpScript, '#!/bin/bash\nsleep 1\nbash "' + agwPath + '" stop ' + name + ' 2>/dev/null\nsleep 1\nbash "' + agwPath + '" start ' + name + ' >> "' + path.join(MLOG(), name + '.log') + '" 2>&1\nrm -f "' + tmpScript + '"\n');
      } else {
        fs.writeFileSync(tmpScript, '#!/bin/bash\nsleep 1\nbash "' + agwPath + '" stop ' + name + ' 2>/dev/null\nrm -f "' + tmpScript + '"\n');
      }
      fs.chmodSync(tmpScript, 0o755);
// setsid opens a new session, stdio ignored, unref -- the script keeps running after the parent is killed
      const cp = exec('setsid bash "' + tmpScript + '" </dev/null >/dev/null 2>&1 &', { stdio: 'ignore' }, () => {});
      try { cp.unref(); } catch (e) {}
      return;
    }
    const r = await runAgw([action, name]);
    return jsonRes(res, 200, { ok: r.ok, output: (r.stdout + r.stderr).trim() });
  }

// POST /admin/api/shutdown-all -- shut down all instances (including itself; the panel dies with it)
  // process.kill each instance pid directly (others first, itself last), no bash child (so a dying parent cannot interrupt the children)
  if (req.method === 'POST' && api === 'shutdown-all') {
// Single-process mode: one process hosts all instances; shutdown = this process exits
    if (POOL) {
      jsonRes(res, 200, { ok: true, message: '单进程模式: 正在关闭网关进程(所有实例随之停止)...' });
      setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch (e) {} }, 500);
      return;
    }
    jsonRes(res, 200, { ok: true, message: '正在关闭所有实例...' });
    const myPid = process.pid;
    setTimeout(() => {
      for (const name of listInstances()) {
if (name === currentName(cfg)) continue; // kill ourselves last
        try {
          const pid = parseInt(fs.readFileSync(path.join(MRUN(), name + '.pid'), 'utf8').trim(), 10);
          if (pid && pid !== myPid) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} }
        } catch (e) {}
      }
// kill ourselves after 1s (leaves other instances time to exit gracefully)
      setTimeout(() => { try { process.kill(myPid, 'SIGTERM'); } catch (e) {} }, 1000);
    }, 500);
    return;
  }

// POST /admin/api/chat -- chat test (proxies to the target instance's /v1/chat/completions, injects gatewayKey automatically, streaming passes through)
// body may carry instance to pick the target (the panel's top-bar selection); default = this instance
  if (req.method === 'POST' && api === 'chat') {
    let target = cfg, bodyOut = bodyStr || '{}';
    try {
      const bj = JSON.parse(bodyOut);
      const inst = bj.instance;
      delete bj.instance;
      bodyOut = JSON.stringify(bj);
      if (inst && inst !== currentName(cfg)) {
        const tc = loadCfg(inst);
        if (!tc) return jsonRes(res, 404, { error: '实例不存在: ' + inst });
        target = tc;
      }
    } catch (e) { return jsonRes(res, 500, { error: '读取目标实例配置失败: ' + e.message }); }
    let port = (target.listen || {}).port || 16384;
    let apiPath = '/v1/chat/completions';
    const gwKey = target.gatewayKey || '';
// Single-process mode: hit the main port's /<instance>/ prefix directly (old instance ports may no longer be open)
    if (POOL) {
      port = POOL.mainPort;
      const tname = target._name || currentName(target);
      if (tname && tname !== 'default') apiPath = '/' + tname + '/v1/chat/completions';
    }
    // TLS instances have no listener of their own: the request goes to the main port over HTTPS + /<name>/
    const chatTls = ((POOL ? cfg : target).tls) || {};
    const chatUseTls = POOL ? !!(cfg.tls && cfg.tls.enable) : !!chatTls.enable;
    const opts = { host: '127.0.0.1', port, path: apiPath, method: 'POST', headers: { 'Content-Type': 'application/json' } };
if (chatUseTls) opts.rejectUnauthorized = false; // signed by the private CA
    if (gwKey) opts.headers['authorization'] = 'Bearer ' + gwKey;
    const up = (chatUseTls ? https2 : http).request(opts, upRes => {
      res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
      upRes.pipe(res);
    });
    up.on('error', (e) => { try { jsonRes(res, 502, { error: '目标实例不可达(端口 ' + port + '): ' + e.message }); } catch (_) {} });
    up.write(bodyOut);
    up.end();
    return;
  }

// GET /admin/api/logs/:name -- read logs
  if (req.method === 'GET' && api.startsWith('logs/')) {
    const name = decodeURIComponent(api.slice('logs/'.length));
    const lines = parseInt(u.searchParams.get('lines') || '50', 10) || 50;
    return textRes(res, 200, readLog(name, lines), 'text/plain; charset=utf-8');
  }

  function inflightOf(c) {
    const m = c && c._stats && c._stats._inflight;
    if (!m || !m.size) return 0;
    const now = Date.now();
    let n = 0;
for (const [, t] of m) if (now - t < 120000) n++;   // unsettled for 2 minutes counts as dirty
    return n;
  }

// Instance dashboard fields (for CLI commands like agw inst/admin; the old /status was removed)
function dashOf(c) {
  return {
    version: VERSION, listen: c.listen,
    channels: (c.channels || []).map(ch => ({ name: ch.name, type: ch.type, models: (ch.models || []).length })),
    probe: Object.fromEntries(Object.entries(c._stats.probe || {}).map(([k, v]) => [k, { rate: v.total ? Math.round(v.ok / v.total * 100) : null, total: v.total, lastOk: v.lastOk, lastErr: v.lastErr }])),
  };
}

// GET /admin/api/stats?instance=X -- live instance stats (cross-instance local proxy supported)
  if (req.method === 'GET' && api === 'stats') {
    const inst = u.searchParams.get('instance') || currentName(cfg);
    if (inst === currentName(cfg)) {
      return jsonRes(res, 200, Object.assign(dashOf(cfg), {
        requests: cfg._stats.requests, inflight: inflightOf(cfg), errors: cfg._stats.errors,
        byChannel: cfg._stats.byChannel, byKey: cfg._stats.byKey || {}, byModel: cfg._stats.byModel || {}, daily: cfg._stats.daily || {}, startedAt: cfg._stats.startedAt,
        uptime: Math.round(process.uptime()),
      }));
    }
// Single-process mode: read the pool directly, no HTTP loopback
    if (POOL) {
      const tc = POOL.instances.get(inst);
      if (!tc) return jsonRes(res, 404, { error: '实例未在运行: ' + inst });
      return jsonRes(res, 200, Object.assign(dashOf(tc), { requests: tc._stats.requests, inflight: inflightOf(tc), errors: tc._stats.errors, retries: tc._stats.retries || 0, onceChannel: tc._onceChannel || null, byChannel: tc._stats.byChannel, byKey: tc._stats.byKey || {}, startedAt: tc._stats.startedAt, uptime: Math.round(process.uptime()) }));
    }
    const j = await proxyInstance(inst, 'stats');
    if (!j) return jsonRes(res, 404, { error: '无法获取实例 ' + inst + ' 的统计(可能未运行或无可用管理令牌)' });
    const st = j.stats ? j.stats : j;
    return jsonRes(res, 200, Object.assign({ requests: st.requests || 0, errors: st.errors || 0, byChannel: st.byChannel || {}, startedAt: j.startedAt, uptime: j.uptime || 0 }, { version: j.version, listen: j.listen, channels: j.channels, probe: j.probe }));
  }

// GET /admin/api/requests/:name -- request log (ring buffer, cross-instance proxy supported)
  if (req.method === 'GET' && api.startsWith('requests/')) {
    const inst = decodeURIComponent(api.slice('requests/'.length));
    if (inst === currentName(cfg)) {
      return jsonRes(res, 200, cfg._stats.recent || []);
    }
// Single-process mode: read the pool directly
    if (POOL) {
      const tc = POOL.instances.get(inst);
      if (!tc) return jsonRes(res, 200, []);
      return jsonRes(res, 200, tc._stats.recent || []);
    }
    const j = await proxyInstance(inst, 'requests/' + inst);
    if (!j) return jsonRes(res, 200, []);
    return jsonRes(res, 200, Array.isArray(j) ? j : (j.recent || []));
  }

// GET /admin/api/record-body/:name?id=req_xxx -- look up a request/response body by id in the local JSONL record file
  if (req.method === 'GET' && api.startsWith('record-body/')) {
    const name = decodeURIComponent(api.slice('record-body/'.length));
    const id = (u.searchParams && u.searchParams.get('id')) || '';
    if (!id) return jsonRes(res, 400, { error: '缺少 id 参数' });
    const f = path.join(MLOG(), 'requests-' + name + '.jsonl');
    if (!fs.existsSync(f)) return jsonRes(res, 404, { error: '没有记录文件 (该实例未开启本地记录, 或记录正发往远程服务器)' });
    const needle = '"id":"' + id + '"';
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (ln && ln.indexOf(needle) !== -1) {
        try { return jsonRes(res, 200, { ok: true, record: JSON.parse(ln) }); }
        catch (_) { return jsonRes(res, 500, { error: '记录解析失败' }); }
      }
    }
    return jsonRes(res, 404, { error: '找不到该请求的正文记录 (该请求发生时可能未开启记录, 或记录文件已轮转)' });
  }

  return jsonRes(res, 404, { error: '未知 API: ' + api });
}

/* ====================== MD3-style HTML ====================== */
function adminHTML(cfg) {
  const instName = cfg._configFile ? path.basename(cfg._configFile, '.json').replace(/^config\./, '') : 'default';
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Gateway 管理</title>
<style>
:root{--md-primary:#6750A4;--md-on-primary:#fff;--md-primary-container:#EADDFF;--md-on-primary-container:#21005D;--md-surface:#1C1B1F;--md-surface-dim:#141218;--md-surface-container:#211F26;--md-surface-container-high:#2B2930;--md-surface-container-highest:#36343B;--md-on-surface:#E6E1E5;--md-on-surface-variant:#CAC4D0;--md-outline:#49454F;--md-error:#F2B8B5;--md-success:#B5E8C5;--md-warning:#F9C8A0;--md-radius:16px;--md-radius-sm:12px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Roboto,system-ui,sans-serif;background:var(--md-surface-dim);color:var(--md-on-surface);font-size:14px;-webkit-font-smoothing:antialiased}
.m3{padding:16px;max-width:1100px;margin:0 auto}
.topbar{display:flex;align-items:center;gap:12px;padding:8px 0 20px;flex-wrap:wrap}
.topbar h1{font-size:22px;font-weight:500;color:var(--md-primary-container);display:flex;align-items:center;gap:8px}
.topbar .ver{font-size:12px;color:var(--md-on-surface-variant);background:var(--md-surface-container);padding:2px 8px;border-radius:20px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.chip{background:var(--md-surface-container);color:var(--md-on-surface-variant);border:none;padding:6px 14px;border-radius:20px;font-size:13px;cursor:pointer;transition:.2s}
.chip:hover{background:var(--md-surface-container-high)}
.chip.active{background:var(--md-primary);color:var(--md-on-primary)}
.card{background:var(--md-surface-container);border-radius:var(--md-radius);padding:16px;margin-bottom:12px}
.card h2{font-size:16px;font-weight:500;margin-bottom:12px;color:var(--md-on-surface)}
.grid{display:grid;gap:12px}
@media(min-width:700px){.grid-2{grid-template-columns:1fr 1fr}.grid-3{grid-template-columns:1fr 1fr 1fr}}
.inst-row{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--md-surface-container-high);border-radius:var(--md-radius-sm);margin-bottom:8px;flex-wrap:wrap}
.inst-row .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot.on{background:var(--md-success);box-shadow:0 0 6px #4CAF50}.dot.off{background:#666}
.inst-row .nm{font-weight:500;min-width:90px}
.inst-row .pt{color:var(--md-on-surface-variant);font-size:12px;font-family:monospace}
.inst-row .tls{font-size:11px;background:var(--md-primary-container);color:var(--md-on-primary-container);padding:1px 6px;border-radius:4px}
.inst-row .acts{margin-left:auto;display:flex;gap:6px}
.btn{background:var(--md-primary);color:var(--md-on-primary);border:none;padding:7px 16px;border-radius:20px;font-size:13px;cursor:pointer;transition:.2s;font-family:inherit}
.btn:hover{filter:brightness(1.15);box-shadow:0 1px 4px rgba(0,0,0,.4)}
.btn.sm{padding:5px 12px;font-size:12px;border-radius:16px}
.btn.outline{background:transparent;border:1px solid var(--md-outline);color:var(--md-on-surface)}
.btn.outline:hover{background:var(--md-surface-container-highest)}
.btn.danger{background:#B3261E}.btn.warn{background:#7D5700}
.btn:disabled{opacity:.4;cursor:not-allowed}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:8px 10px;text-align:left;border-bottom:1px solid var(--md-outline)}
th{color:var(--md-on-surface-variant);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
td.mono{font-family:monospace;font-size:12px}
.tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;margin-right:4px}
.tag.openai{background:#10A37F;color:#fff}.tag.claude{background:#D97757;color:#fff}.tag.gemini{background:#4285F4;color:#fff}
.tag.rr{background:var(--md-warning);color:#3D2700}
.tag.direct{color:var(--md-on-surface-variant)}.tag.proxy{color:var(--md-primary-container)}
.stat-big{font-size:28px;font-weight:600;color:var(--md-primary-container)}
.stat-lbl{font-size:12px;color:var(--md-on-surface-variant)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}
.stat-box{background:var(--md-surface-container-high);border-radius:var(--md-radius-sm);padding:12px 16px}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:100;padding:16px}
.modal-bg.show{display:flex}
.modal{background:var(--md-surface-container);border-radius:var(--md-radius);padding:24px;max-width:520px;width:100%;max-height:90vh;overflow-y:auto}
.modal h2{margin-bottom:16px}
.field{margin-bottom:14px}
.field label{display:block;font-size:12px;color:var(--md-on-surface-variant);margin-bottom:4px}
.field input,.field select,.field textarea{width:100%;background:var(--md-surface-container-high);border:1px solid var(--md-outline);color:var(--md-on-surface);padding:10px 12px;border-radius:var(--md-radius-sm);font-size:14px;font-family:inherit}
.field input:focus,.field select:focus,.field textarea:focus{outline:none;border-color:var(--md-primary)}
.field.row{display:flex;gap:12px}
.field.row .f{flex:1}
.logbox{background:#0d0d0f;border:1px solid var(--md-outline);border-radius:var(--md-radius-sm);padding:12px;font-family:monospace;font-size:12px;max-height:400px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;color:#b0b0b0}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--md-surface-container-highest);color:var(--md-on-surface);padding:12px 24px;border-radius:24px;box-shadow:0 4px 20px rgba(0,0,0,.5);z-index:200;display:none;font-size:14px}
.toast.show{display:block}
.toast.err{border:1px solid var(--md-error)}
.flex{display:flex;gap:8px;align-items:center}
.muted{color:var(--md-on-surface-variant);font-size:12px}
textarea.models{height:60px;resize:vertical}
.hint{font-size:11px;color:var(--md-on-surface-variant);margin-top:4px}
a{color:var(--md-primary-container)}
</style>
</head>
<body>
<div class="m3">
  <div class="topbar">
    <h1>🤖 AI Gateway</h1>
    <span class="ver">管理面板</span>
    <div class="chips">
      <button class="chip" data-tab="instances" onclick="switchTab('instances')">实例</button>
      <button class="chip" data-tab="config" onclick="switchTab('config')">配置</button>
      <button class="chip" data-tab="stats" onclick="switchTab('stats')">统计</button>
      <button class="chip" data-tab="logs" onclick="switchTab('logs')">日志</button>
    </div>
  </div>

  <div id="tab-instances">
    <div class="card"><h2>实例列表</h2><div id="inst-list" class="grid"><p class="muted">加载中...</p></div></div>
  </div>

  <div id="tab-config" style="display:none">
    <div class="card">
      <h2>配置编辑 — <select id="cfg-inst-select" onchange="loadConfigEditor()" style="background:var(--md-surface-container-high);border:1px solid var(--md-outline);color:var(--md-on-surface);padding:6px;border-radius:8px;font-size:14px"></select></h2>
      <div id="cfg-editor"><p class="muted">选择实例...</p></div>
    </div>
  </div>

  <div id="tab-stats" style="display:none">
    <div class="card"><h2>实时统计 (当前实例: \${instName})</h2>
      <div class="stat-grid" id="stat-grid"><p class="muted">加载中...</p></div>
      <div id="stat-channels" style="margin-top:16px"></div>
    </div>
  </div>

  <div id="tab-logs" style="display:none">
    <div class="card"><h2>日志查看 — <select id="log-inst-select" onchange="loadLog()" style="background:var(--md-surface-container-high);border:1px solid var(--md-outline);color:var(--md-on-surface);padding:6px;border-radius:8px;font-size:14px"></select>
      <button class="btn sm" onclick="loadLog()">刷新</button>
      <span class="muted" style="margin-left:8px">最近 <input id="log-lines" type="number" value="80" style="width:60px;background:var(--md-surface-container-high);border:1px solid var(--md-outline);color:var(--md-on-surface);padding:4px;border-radius:6px"> 行</span>
    </h2>
      <div id="log-box" class="logbox">选择实例...</div>
    </div>
  </div>
</div>

<div class="modal-bg" id="modal-bg" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal-content"></div>
</div>
<div class="toast" id="toast"></div>

<script>
const adminKey = new URLSearchParams(location.search).get('key') || (document.cookie.match(/agwWeb=([^;]+)/)||[])[1] || '';
const hdr = { 'x-agw-token': adminKey, 'Content-Type': 'application/json' };
let curTab='instances', curInst='\${instName}';

// With no password set, prompt for one and store the cookie
if(!adminKey){
  const input = prompt('请输入访问令牌 (可选的管理 API webToken; 面板登录请用 agw web login):');
  if(input){
    document.cookie = 'agwWeb='+input+';path=/;max-age=86400';
    location.search = '?key='+encodeURIComponent(input);
  } else {
    document.querySelector('.m3').innerHTML='<div class="card"><h2>需要访问令牌</h2><p>请在服务器执行 agw web login 获取一次性登录链接</p></div>';
  }
}

function toast(msg, isErr){const t=document.getElementById('toast');t.textContent=msg;t.className='toast show'+(isErr?' err':'');setTimeout(()=>t.className='toast',isErr?4000:2000)}
async function api(method, path, body){
  const opt={method,headers:hdr};
  if(body)opt.body=JSON.stringify(body);
  const r=await fetch('/admin/api/'+path,opt);
  const txt=await r.text();
  try{const j=JSON.parse(txt);if(!r.ok)throw new Error(j.error||'错误');return j}catch(e){if(e instanceof SyntaxError)throw new Error(txt.slice(0,500));throw e}
}
function switchTab(t){
  curTab=t;document.querySelectorAll('[id^=tab-]').forEach(e=>e.style.display='none');
  document.getElementById('tab-'+t).style.display='';
  document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active',c.dataset.tab===t));
  if(t==='instances')loadInstances();
  if(t==='config')initConfigTab();
  if(t==='stats')loadStats();
  if(t==='logs')initLogTab();
}
function instDot(on){return '<span class="dot '+(on?'on':'off')+'"></span>'}
async function loadInstances(){
  try{
    const {instances}=await api('GET','instances');
    document.getElementById('inst-list').innerHTML=instances.map(i=>\`
      <div class="inst-row">\${instDot(i.running)}
        <span class="nm">\${i.name}</span>
        <span class="pt">port:\${i.port}</span>
        \${i.tlsOn?'<span class="tls">TLS</span>':''}\${i.mainOnly?'<span class="tls">仅主端口</span>':''}
        <span class="muted">\${i.chCount} 渠道</span>
        <div class="acts">
          <button class="btn sm" onclick="doAction('\${i.name}','restart')">重启</button>
          <button class="btn sm outline" onclick="doAction('\${i.name}','start')" \${i.running?'disabled':''}>启动</button>
          <button class="btn sm outline" onclick="doAction('\${i.name}','stop')" \${!i.running?'disabled':''}>停止</button>
          <button class="btn sm outline" onclick="curInst='\${i.name}';switchTab('config')">配置</button>
        </div>
      </div>\`).join('');
  }catch(e){toast(e.message,true)}
}
async function doAction(name,action){
  toast(action+' '+name+'...');
  try{const r=await api('POST','action/'+name+'/'+action);toast(r.output.split('\\n').slice(-2).join(' ')||'完成');setTimeout(loadInstances,800)}
  catch(e){toast(e.message,true)}
}
function initConfigTab(){
  api('GET','instances').then(({instances})=>{
    const sel=document.getElementById('cfg-inst-select');
    sel.innerHTML=instances.map(i=>\`<option value="\${i.name}" \${i.name===curInst?'selected':''}>\${i.name} (\${i.running?'运行':'停止'})</option>\`).join('');
    loadConfigEditor();
  });
}
async function loadConfigEditor(){
  const sel=document.getElementById('cfg-inst-select');
  curInst=sel.value;
  try{
    const c=await api('GET','config/'+curInst);
    let html='<div class="field row"><div class="f"><label>端口</label><input id="ed-port" type="number" value="'+c.port+'"></div>';
    html+='<div class="f"><label>网关密码</label><input id="ed-gwkey" type="text" value="'+(c.gatewayKey||'')+'" placeholder="空=不校验"></div></div>';
    html+='<div class="field row"><div class="f"><label>访问令牌 (webToken)</label><input id="ed-webtoken" type="text" value="'+(c.webToken||'')+'" placeholder="'+(c.webToken?'(已设,留空不改)':'空=不启用 API 令牌')+'"></div></div>';
    html+='<div class="flex" style="margin:8px 0"><button class="btn sm" onclick="saveSettings()">💾 保存设置</button><button class="btn sm outline" onclick="doAction(&#39;'+curInst+'&#39;,&#39;restart&#39;)">⟳ 保存后重启</button></div>';
    html+='<hr style="border:0;border-top:1px solid var(--md-outline);margin:16px 0">';
    html+='<h2 style="display:flex;align-items:center">渠道 <button class="btn sm" style="margin-left:auto" onclick="openChannelModal()">+ 添加渠道</button></h2>';
    if(!c.channels.length)html+='<p class="muted">无渠道</p>';
    else html+='<table><tr><th>名称</th><th>类型</th><th>地址</th><th>代理</th><th>模型</th><th></th></tr>'+c.channels.map(ch=>{
      const models=(ch.modelMap?Object.keys(ch.modelMap).map(m=>m+(ch.modelMap[m]!==m?'→'+ch.modelMap[m]:'')):(ch.models||[])).join(', ');
      return '<tr><td class="mono">'+ch.name+(ch.default?' <span class="tag rr">default</span>':'')+'<br><span class="muted">'+(ch.keyPrefix||'无key')+'</span></td>'+
        '<td><span class="tag '+ch.type+'">'+ch.type+'</span></td>'+
        '<td class="mono" style="max-width:200px;word-break:break-all">'+ch.baseUrl+'</td>'+
        '<td class="mono">'+(ch.proxy||'<span class="muted">直连</span>')+'</td>'+
        '<td class="mono" style="max-width:250px;word-break:break-all">'+models+'</td>'+
        '<td><button class="btn sm outline" onclick="openChannelModal('+JSON.stringify(ch).replace(/'/g,'&#39;')+')">编辑</button> <button class="btn sm danger" onclick="delChannel(&#39;'+ch.name+'&#39;)">删</button></td></tr>';
    }).join('')+'</table>';
    if(c.proxies&&Object.keys(c.proxies).length){html+='<h2 style="margin-top:16px">代理</h2><table>'+Object.entries(c.proxies).map(([k,v])=>'<tr><td class="mono">'+k+'</td><td>'+v.type+'</td><td class="mono">'+v.host+':'+v.port+'</td></tr>').join('')+'</table>'}
    document.getElementById('cfg-editor').innerHTML=html;
  }catch(e){document.getElementById('cfg-editor').innerHTML='<p style="color:var(--md-error)">'+e.message+'</p>'}
}
async function saveSettings(){
  const data={port:Number(document.getElementById('ed-port').value),gatewayKey:document.getElementById('ed-gwkey').value};
  const ak=document.getElementById('ed-webtoken').value;
  if(ak&&!ak.includes('已设'))data.webToken=ak;
  try{await api('POST','config/'+curInst,data);toast('设置已保存, 建议重启生效')}
  catch(e){toast(e.message,true)}
}
function openChannelModal(ch){
  ch=ch||{name:'',type:'openai',baseUrl:'',apiKey:'',proxy:null,models:[],modelMap:null,default:false};
  document.getElementById('modal-content').innerHTML=\`
    <h2>\${ch.name?'编辑':'添加'}渠道</h2>
    <div class="field"><label>渠道名</label><input id="ch-name" value="\${ch.name||''}"></div>
    <div class="field"><label>类型</label><select id="ch-type"><option value="openai" \${ch.type==='openai'?'selected':''}>openai</option><option value="gemini" \${ch.type==='gemini'?'selected':''}>gemini</option><option value="claude" \${ch.type==='claude'?'selected':''}>claude</option></select></div>
    <div class="field"><label>baseUrl</label><input id="ch-baseurl" value="\${ch.baseUrl||''}" placeholder="https://api.xxx.com"></div>
    <div class="field"><label>path (可选: 精确锁定上游路径, 如 /v1/chat/completions)</label><input id="ch-path" value="\${ch.path||''}" placeholder="留空=自动"></div>
    <div class="field"><label>apiKey \${ch.keyPrefix?'('+ch.keyPrefix+', 留空不改)':''}</label><input id="ch-apikey" type="text" value="" placeholder="\${ch.keyPrefix?'留空=保持原key':'粘贴密钥'}"></div>
    <div class="field"><label>代理</label><select id="ch-proxy"><option value="" \${!ch.proxy?'selected':''}>直连</option></select><span class="hint" id="proxy-hint"></span></div>
    <div class="field"><label>模型列表 (逗号分隔, 客户端发啥就用啥)</label><textarea class="models" id="ch-models">\${(ch.models||[]).join(', ')} </textarea>
      <span class="hint">或用 modelMap 改名(下方), 二选一</span></div>
    <div class="field"><label>modelMap (JSON, 统一名→真实名)</label><textarea class="models" id="ch-modelmap">\${ch.modelMap?JSON.stringify(ch.modelMap,null,0):''}</textarea>
      <span class="hint">多源轮询时用这个, 客户端只看到统一名</span></div>
    <div class="field"><label><input type="checkbox" id="ch-default" \${ch.default?'checked':''} style="width:auto;margin-right:6px">设为 default (兜底渠道)</label></div>
    <div class="flex" style="margin-top:16px"><button class="btn" onclick="saveChannel()">保存</button><button class="btn outline" onclick="closeModal()">取消</button></div>\`;
  document.getElementById('modal-bg').classList.add('show');
// Fill the proxy options
  api('GET','config/'+curInst).then(c=>{const sel=document.getElementById('ch-proxy');Object.keys(c.proxies||{}).forEach(p=>{const o=document.createElement('option');o.value=p;o.textContent=p;if(ch.proxy===p)o.selected=true;sel.appendChild(o)})});
}
async function saveChannel(){
  const ch={name:document.getElementById('ch-name').value.trim(),type:document.getElementById('ch-type').value,
    baseUrl:document.getElementById('ch-baseurl').value.trim(),
    path:document.getElementById('ch-path').value.trim(),
    proxy:document.getElementById('ch-proxy').value||null,
    default:document.getElementById('ch-default').checked};
  const ak=document.getElementById('ch-apikey').value.trim();
  if(ak)ch.apiKey=ak;
  const models=document.getElementById('ch-models').value.trim();
  if(models)ch.models=models.split(',').map(s=>s.trim()).filter(Boolean);
  const mm=document.getElementById('ch-modelmap').value.trim();
  if(mm){try{ch.modelMap=JSON.parse(mm)}catch(e){return toast('modelMap JSON 格式错误',true)}}
  if(!ch.name)return toast('渠道名不能为空',true);
  if(!ch.baseUrl)return toast('baseUrl 不能为空',true);
  try{await api('POST','channel/'+curInst,ch);closeModal();toast('渠道已保存');loadConfigEditor()}
  catch(e){toast(e.message,true)}
}
async function delChannel(name){
  if(!confirm('删除渠道 "'+name+'"?'))return;
  try{await api('DELETE','channel/'+curInst+'/'+name);toast('已删除');loadConfigEditor()}catch(e){toast(e.message,true)}
}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function closeModal(){document.getElementById('modal-bg').classList.remove('show')}
async function loadStats(){
  try{
    const s=await api('GET','stats');
    document.getElementById('stat-grid').innerHTML=\`
      <div class="stat-box"><div class="stat-big">\${s.requests}</div><div class="stat-lbl">总请求</div></div>
      <div class="stat-box"><div class="stat-big">\${s.errors}</div><div class="stat-lbl">错误</div></div>
      <div class="stat-box"><div class="stat-big">\${s.uptime}</div><div class="stat-lbl">运行秒</div></div>\`;
    const chs=Object.entries(s.byChannel||{});
    document.getElementById('stat-channels').innerHTML=chs.length?'<h2 style="margin-bottom:8px">各渠道统计</h2><table><tr><th>渠道</th><th>请求</th><th>入token</th><th>出token</th></tr>'+chs.map(([n,d])=>'<tr><td class="mono">'+n+'</td><td>'+d.requests+'</td><td>'+d.inputTokens+'</td><td>'+d.outputTokens+'</td></tr>').join('')+'</table>':'<p class="muted">暂无请求</p>';
  }catch(e){toast(e.message,true)}
}
function initLogTab(){
  api('GET','instances').then(({instances})=>{
    const sel=document.getElementById('log-inst-select');
    sel.innerHTML=instances.map(i=>'<option value="'+i.name+'" '+(i.name===curInst?'selected':'')+'>'+i.name+'</option>').join('');
    loadLog();
  });
}
async function loadLog(){
  const name=document.getElementById('log-inst-select').value;
  const lines=document.getElementById('log-lines').value||80;
  try{const r=await fetch('/admin/api/logs/'+name+'?lines='+lines+'&key='+encodeURIComponent(adminKey));
    document.getElementById('log-box').textContent=await r.text()}
  catch(e){toast(e.message,true)}
}
if(adminKey){
  switchTab('instances');
  setInterval(()=>{if(curTab==='instances')loadInstances();if(curTab==='stats')loadStats()},5000);
}
</script>
</body>
</html>`;
}

module.exports = { handleAdmin, checkAdminAuth, setDir, setUpstreamModels, setSyncFn, setBalanceFn, setPool, setPlugins, saveCfg, totpCode, totpVerify, base32Encode };
