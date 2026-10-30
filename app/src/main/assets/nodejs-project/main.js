'use strict';
/*
 * Embedded gateway bootstrap (android / nodejs-mobile).
 *
 * nodejs-mobile is a plain Node runtime without `child_process` and `cluster`, while the gateway
 * modules require them at load time (admin.js for cloudflared, hot.js for the hot-restart master).
 * Both features are meaningless on a phone, so they are replaced with inert stubs before the
 * gateway is loaded. Everything else runs unmodified.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const LOG = path.join(DATA, 'embedded.log');

try { fs.mkdirSync(DATA, { recursive: true }); } catch (_) {}

function rotateLog() {
  try {
    const st = fs.statSync(LOG);
    if (st.size > 2 * 1024 * 1024) {
      const txt = fs.readFileSync(LOG, 'utf8');
      fs.writeFileSync(LOG, txt.slice(-1024 * 1024));
    }
  } catch (_) {}
}
function append(line) {
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}
function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch (_) { return String(a); }
}
for (const name of ['log', 'info', 'warn', 'error']) {
  const orig = console[name].bind(console);
  console[name] = (...args) => {
    append('[' + new Date().toISOString().slice(11, 19) + '] ' + args.map(fmt).join(' '));
    try { orig(...args); } catch (_) {}
  };
}
rotateLog();

function unsupported(what) {
  return new Error(what + ' is not available in the embedded Node runtime');
}
function asyncFail(what) {
  return function (...args) {
    const cb = args.reverse().find(a => typeof a === 'function');
    if (cb) process.nextTick(() => cb(unsupported(what)));
    return { on() { return this; }, once() { return this; }, kill() {}, stdin: null, stdout: null, stderr: null };
  };
}
const childProcessStub = {
  exec: asyncFail('child_process.exec'),
  execFile: asyncFail('child_process.execFile'),
  spawn: () => { throw unsupported('child_process.spawn'); },
  fork: () => { throw unsupported('child_process.fork'); },
  spawnSync: () => ({ status: 1, stdout: '', stderr: '', error: unsupported('child_process.spawnSync') }),
  execSync: () => { throw unsupported('child_process.execSync'); },
};
const clusterStub = {
  isPrimary: true, isMaster: true, isWorker: false, worker: null,
  on() { return this; }, once() { return this; }, fork() { throw unsupported('cluster.fork'); },
  setupPrimary() {}, setupMaster() {}, disconnect() {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const name = String(request).replace(/^node:/, '');
  if (name === 'child_process') return childProcessStub;
  if (name === 'cluster') return clusterStub;
  return origLoad.apply(this, arguments);
};

// Single-instance mode: the phone hosts exactly one config.json (no pool / cluster).
process.env.AGW_SINGLE = '1';
delete process.env.AGW_HOT;

process.on('uncaughtException', e => console.error('uncaughtException:', e && (e.stack || e.message) || e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e && (e.message || e) || e));

const configPath = path.join(DATA, 'config.json');
append('[' + new Date().toISOString() + '] embedded gateway boot v' + process.versions.node + ' config=' + configPath);

process.argv.push(configPath);
try {
  require('./gateway.js').main();
} catch (e) {
  console.error('gateway boot failed:', e && (e.stack || e.message) || e);
  process.exit(1);
}
