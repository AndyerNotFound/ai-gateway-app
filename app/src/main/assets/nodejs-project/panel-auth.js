'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_TTL_MS = 15 * 60 * 1000;

function instName(cfg, explicit) {
  if (explicit) return String(explicit);
  if (cfg && cfg._name) return String(cfg._name);
  if (cfg && cfg._configFile) {
    const base = path.basename(cfg._configFile, '.json');
    return base === 'config' ? 'default' : base.replace(/^config\./, '');
  }
  return 'default';
}

function dataDir(cfg) {
  if (cfg && cfg._configFile) return path.dirname(cfg._configFile);
  return path.join(__dirname, 'data');
}

function stateFile(cfg, inst) {
  return path.join(dataDir(cfg), '.run', 'panel-' + instName(cfg, inst) + '.json');
}

function random(n) {
  return crypto.randomBytes(n).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (_) { return false; }
}

function read(cfg, inst) {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(cfg, inst), 'utf8'));
    if (!st || typeof st !== 'object' || !st.sid) return null;
    return st;
  } catch (_) {
    return null;
  }
}

function write(cfg, inst, st) {
  const file = stateFile(cfg, inst);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  if (cfg && typeof cfg === 'object') { cfg._panelAuth = st; if (st.sessions) cfg._panelAuthSessions = st.sessions; }
  return st;
}

function init(cfg, inst) {
  const now = Date.now();
  return write(cfg, inst, {
    v: 1,
    sid: random(24),
    adminToken: random(32),
    tokenHash: '',
    tokenExp: 0,
    issuedAt: 0,
    usedAt: 0,
    createdAt: now,
    revokedAt: 0,
    sessions: {},
  });
}

function ensure(cfg, inst) {
  const st = read(cfg, inst) || init(cfg, inst);
  if (!st.adminToken) {
    st.adminToken = random(32);
    write(cfg, inst, st);
  }
  return st;
}

function issue(cfg, inst, ttlMs) {
  const st = ensure(cfg, inst);
  const token = random(32);
  st.tokenHash = hashToken(token);
  st.tokenExp = Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : TOKEN_TTL_MS);
  st.issuedAt = Date.now();
  st.usedAt = 0;
  write(cfg, inst, st);
  return { sid: st.sid, token, exp: st.tokenExp };
}

function verify(cfg, inst, sid, token) {
  const st = read(cfg, inst);
  if (!st || !st.tokenHash || st.usedAt || !st.tokenExp || Date.now() > Number(st.tokenExp)) return false;
  if (!safeEqual(st.sid, sid) || !safeEqual(st.tokenHash, hashToken(token))) return false;
  st.usedAt = Date.now();
  write(cfg, inst, st);
  return true;
}

function revoke(cfg, inst) {
  const st = ensure(cfg, inst);
  st.sid = random(24);
  st.tokenHash = '';
  st.tokenExp = 0;
  st.issuedAt = 0;
  st.usedAt = 0;
  st.revokedAt = Date.now();
  return write(cfg, inst, st);
}

function sessionsOf(cfg, inst) {
  const st = read(cfg, inst);
  const map = (st && typeof st.sessions === 'object') ? st.sessions : {};
  if (cfg && typeof cfg === 'object') cfg._panelAuthSessions = map;
  return map;
}
function sessionsSave(cfg, inst) {
  const st = read(cfg, inst) || init(cfg, inst);
  const map = (cfg && typeof cfg === 'object' && cfg._panelAuthSessions) || st.sessions || {};
  st.sessions = map;
  write(cfg, inst, st);
}
function tokenState(st, now) {
  if (!st || !st.tokenHash) return 'none';
  if (st.usedAt) return 'used';
  if (!st.tokenExp || (now || Date.now()) > Number(st.tokenExp)) return 'expired';
  return 'valid';
}

module.exports = {
  TOKEN_TTL_MS,
  sessionsOf,
  sessionsSave,
  instName,
  stateFile,
  read,
  init,
  ensure,
  issue,
  verify,
  revoke,
  tokenState,
};
