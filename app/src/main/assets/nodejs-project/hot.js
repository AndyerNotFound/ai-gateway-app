'use strict';
// Hot restart (AGW_HOT=1): a long-lived master owns every listen socket and swaps the serving worker.
// The replacement worker starts first, then the old worker stops accepting (cluster disconnect),
// lets its in-flight responses finish and exits. A crashing worker still drops whatever was streaming
// at that instant — a socket cannot be handed to another process.
const cluster = require('cluster');
const fs = require('fs');
const path = require('path');
const { log, logErr } = require('./util');

const ENABLED = process.env.AGW_HOT === '1';
const DRAIN_MAX_SEC = Math.max(1, Number(process.env.AGW_DRAIN_MAX) || 600);   // hard ceiling for the drain
const READY_TIMEOUT_MS = Math.max(3000, Number(process.env.AGW_READY_TIMEOUT) || 30000);
const FLUSH_TIMEOUT_MS = 5000;   // how long we wait for the old worker to persist stats before forking anyway

let draining = false;
let active = 0;
let quietTicks = 0;
let serversOf = () => [];
let onFlush = () => {};
let flushedForHandoff = false;

// In-flight counter, once per request at the top of handleHttp.
function track(req, res) {
  active++;
  let done = false;
  const fin = () => { if (done) return; done = true; active--; };
  res.on('finish', fin);
  res.on('close', fin);
  if (draining && !res.headersSent) { try { res.setHeader('Connection', 'close'); } catch (_) {} }
}

function isDraining() { return draining; }

// ================= master =================
function primary(runDir) {
  if (!runDir) runDir = path.join(__dirname, 'data', '.run');
  fs.mkdirSync(runDir, { recursive: true });
  const workerPidFile = path.join(runDir, 'worker.pid');
  cluster.setupPrimary({ exec: path.join(__dirname, 'gateway.js'), args: process.argv.slice(2), silent: false, windowsHide: true });

  let serving = null, pending = null, readyTimer = null, flushTimer = null, stopping = false;

  const writeWorkerPid = (pid) => { try { fs.writeFileSync(workerPidFile, String(pid)); } catch (_) {} };
  const forkWorker = (why) => {
    const w = cluster.fork();
    log('[hot] 拉起 worker ' + w.process.pid + (why ? ' (' + why + ')' : ''));
    return w;
  };
  const clearTimers = () => {
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  };

  cluster.on('message', (w, msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'agw:flushed') {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pending || !serving) return;
      log('[hot] 旧 worker ' + w.process.pid + ' 已落盘统计, 开始拉起新 worker');
      pending = forkWorker('handoff');
      readyTimer = setTimeout(() => {
        if (!pending) return;
        logErr('[hot] 新 worker ' + pending.process.pid + ' 未在 ' + Math.round(READY_TIMEOUT_MS / 1000) + 's 内就绪, 放弃本次换血 (旧 worker 继续服务)');
        try { pending.process.kill('SIGTERM'); } catch (_) {}
        pending = null; readyTimer = null;
      }, READY_TIMEOUT_MS);
      return;
    }
    if (msg.t !== 'agw:ready') return;
    if (w !== pending) { log('[hot] 忽略非待命 worker ' + w.process.pid + ' 的就绪信号'); return; }
    clearTimers();
    const old = serving;
    serving = w; pending = null;
    writeWorkerPid(w.process.pid);
    log('[hot] worker ' + w.process.pid + ' 就绪' + (old ? ' → 通知旧 worker ' + old.process.pid + ' 排水退出' : ''));
    if (old) { try { old.send({ t: 'agw:drain' }); } catch (_) { try { old.process.kill('SIGTERM'); } catch (_) {} } }
  });

  cluster.on('exit', (w, code, signal) => {
    if (stopping) return;
    const who = w.process.pid + ' (code=' + code + ' signal=' + signal + ')';
    if (w === pending) { logErr('[hot] 待命 worker ' + who + ' 在就绪前退出'); pending = null; clearTimers(); }
    if (w === serving) { logErr('[hot] 服务中 worker ' + who + ' 已退出'); serving = null; }
    if (!serving && !pending) { logErr('[hot] 没有可用 worker, 自动拉起'); pending = forkWorker('respawn'); }
  });

  const hotRestart = (why) => {
    if (stopping) return;
    if (pending) { log('[hot] 换血进行中, 忽略重复请求'); return; }
    if (!serving) { log('[hot] 当前无服务 worker, 直接拉起'); pending = forkWorker(why); return; }
    log('[hot] 开始热重启 (' + why + '): 先让旧 worker 落盘统计, 再拉起新 worker');
    try { serving.send({ t: 'agw:flush' }); } catch (_) { serving = null; pending = forkWorker('boot'); return; }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (pending || !serving) return;
      log('[hot] 旧 worker 落盘超时, 继续换血');
      pending = forkWorker('handoff');
    }, FLUSH_TIMEOUT_MS);
  };

  process.on('SIGUSR2', () => hotRestart('SIGUSR2'));
  const shutdown = (sig) => {
    stopping = true;
    clearTimers();
    log('[hot] master 收到 ' + sig + ', 停止全部 worker 并退出');
    for (const id of Object.keys(cluster.workers || {})) { try { cluster.workers[id].process.kill('SIGTERM'); } catch (_) {} }
    const t = setTimeout(() => process.exit(0), 1500);
    if (t.unref) t.unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log('[hot] 热重启模式已启用: master pid ' + process.pid + ' 持有监听句柄, 升级时只换 worker');
  pending = forkWorker('boot');
}

// ================= worker =================
function worker(getServers, flush) {
  serversOf = typeof getServers === 'function' ? getServers : () => [];
  onFlush = typeof flush === 'function' ? flush : () => {};
  process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'agw:flush') {
      try { onFlush(); } catch (e) { logErr('[hot] 落盘统计失败: ' + e.message); }
      flushedForHandoff = true;
      try { if (process.send) process.send({ t: 'agw:flushed' }); } catch (_) {}
      return;
    }
    if (m.t === 'agw:drain') startDrain();
  });
  process.on('disconnect', () => { if (!draining) { log('[hot] 与 master 断开, worker 退出'); process.exit(0); } });
}

// Called once every port is listening: only then may the master retire the old worker
function ready() {
  if (!ENABLED) return;
  try { if (process.send) process.send({ t: 'agw:ready' }); } catch (_) {}
}

function startDrain() {
  if (draining) return;
  draining = true;
  log('[hot] 收到换血指令: 停止接新连接, 在途 ' + active + ' 个请求跑完后退出');
  try { if (cluster.worker) cluster.worker.disconnect(); } catch (e) { logErr('[hot] disconnect 失败: ' + e.message); }
  const t0 = Date.now();
  const timer = setInterval(() => {
    for (const s of serversOf()) { try { if (s && typeof s.closeIdleConnections === 'function') s.closeIdleConnections(); } catch (_) {} }
    if (active <= 0) quietTicks++; else quietTicks = 0;
    const overtime = Date.now() - t0 > DRAIN_MAX_SEC * 1000;
    if (quietTicks >= 2 || overtime) {
      clearInterval(timer);
      if (overtime && active > 0) logErr('[hot] 排水超时 ' + DRAIN_MAX_SEC + 's (剩余 ' + active + ' 个请求), 强制退出');
      else log('[hot] 排水完成, worker ' + process.pid + ' 退出');
      if (!flushedForHandoff) { try { onFlush(); } catch (_) {} }
      process.exit(0);
    }
  }, 250);
}

module.exports = { ENABLED, primary, worker, ready, track, isDraining, cluster };
