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
const { normalizeProxy } = require('./config');
const { logErr } = require('./util');

// ================= Proxy layer (SOCKS5 / HTTP CONNECT, hand-written, zero deps) =================
/* ================= Proxy layer (SOCKS5 / HTTP CONNECT, hand-written, zero deps) ================= */
function dialTcp(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let done = false;
    const fail = (e) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} reject(e); } };
    sock.once('connect', () => { if (!done) { done = true; sock.setTimeout(0); resolve(sock); } });
    sock.once('error', fail);
    if (timeout) sock.setTimeout(timeout, () => fail(new Error(`connect timeout (${host}:${port})`)));
  });
}

/** Fixed-length/delimited reads on a raw socket (handshake phase only; detached after the handshake) */
function makeReader(sock) {
  const st = { buf: Buffer.alloc(0), waiters: [] };
  function pump() {
    while (st.waiters.length) {
      const w = st.waiters[0];
      if (w.need >= 0) {
        if (st.buf.length >= w.need) {
          st.waiters.shift();
          const out = st.buf.subarray(0, w.need);
          st.buf = st.buf.subarray(w.need);
          w.resolve(out);
        } else return;
      } else {
        const i = st.buf.indexOf(w.seq);
        if (i >= 0) {
          st.waiters.shift();
          const out = st.buf.subarray(0, i + w.seq.length);
          st.buf = st.buf.subarray(i + w.seq.length);
          w.resolve(out);
        } else return;
      }
    }
  }
  function failAll(e) { while (st.waiters.length) st.waiters.shift().reject(e); }
  const onData = (c) => { st.buf = Buffer.concat([st.buf, c]); pump(); };
  const onEnd = () => failAll(new Error('connection closed by proxy/peer during handshake'));
  const onError = (e) => failAll(e);
  sock.on('data', onData); sock.on('end', onEnd); sock.on('error', onError);
  return {
    read(n) { return new Promise((resolve, reject) => { st.waiters.push({ need: n, resolve, reject }); pump(); }); },
    readUntil(seq) { return new Promise((resolve, reject) => { st.waiters.push({ need: -1, seq: Buffer.from(seq), resolve, reject }); pump(); }); },
    detach() { sock.removeListener('data', onData); sock.removeListener('end', onEnd); sock.removeListener('error', onError); },
  };
}

async function socks5Connect(sock, proxy, host, port, r) {
  const hasAuth = proxy.username != null && proxy.username !== '';
  sock.write(Buffer.from([5, hasAuth ? 2 : 1, ...(hasAuth ? [0, 2] : [0])]));
  const m = await r.read(2);
  if (m[0] !== 5) throw new Error('socks5: bad version byte ' + m[0]);
  if (m[1] === 2) {
    if (!hasAuth) throw new Error('socks5: proxy requires username/password');
    const u = Buffer.from(proxy.username), pw = Buffer.from(proxy.password || '');
    if (u.length > 255 || pw.length > 255) throw new Error('socks5: credential too long');
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
    const a = await r.read(2);
    if (a[1] !== 0) throw new Error('socks5: auth failed (status ' + a[1] + ')');
  } else if (m[1] !== 0) {
    throw new Error('socks5: no acceptable auth method (proxy chose ' + m[1] + ')');
  }
  const hb = Buffer.from(host);
  if (hb.length > 255) throw new Error('socks5: host too long');
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([(port >> 8) & 255, port & 255])]));
  const head = await r.read(4);
  if (head[0] !== 5) throw new Error('socks5: bad reply version');
  if (head[1] !== 0) {
    const REPS = { 1: 'general failure', 2: 'not allowed by ruleset', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };
    throw new Error('socks5: CONNECT failed: ' + (REPS[head[1]] || 'reply ' + head[1]));
  }
  const atyp = head[3];
  if (atyp === 1) await r.read(6);
  else if (atyp === 3) { const l = await r.read(1); await r.read(l[0] + 2); }
  else if (atyp === 4) await r.read(18);
  else throw new Error('socks5: bad address type ' + atyp);
}

async function httpConnect(sock, proxy, host, port, r) {
  const auth = (proxy.username != null && proxy.username !== '')
    ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.username + ':' + (proxy.password || '')).toString('base64') + '\r\n' : '';
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const head = await r.readUntil('\r\n\r\n');
  const line = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
  const status = parseInt(line.split(' ')[1] || '0', 10);
  if (!(status >= 200 && status < 300)) throw new Error('http proxy: CONNECT rejected: ' + line);
}

async function dialViaProxy(proxy, targetHost, targetPort, timeout) {
  const sock = await dialTcp(proxy.host, proxy.port, timeout);
  try {
    sock.setNoDelay(true);
    const r = makeReader(sock);
    if (proxy.type === 'socks5') await socks5Connect(sock, proxy, targetHost, targetPort, r);
    else if (proxy.type === 'http') await httpConnect(sock, proxy, targetHost, targetPort, r);
    else throw new Error('unknown proxy type: ' + proxy.type);
    r.detach();
    return sock;
  } catch (e) {
    try { sock.destroy(); } catch (_) {}
    e.message = `[proxy ${proxy.type}://${proxy.host}:${proxy.port}] ` + e.message;
    throw e;
  }
}

/* ================= Agent cache ================= */
let directAgents = null;
function getDirectAgents() {
  if (!directAgents) {
    const o = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 16 };
    directAgents = { http: new http.Agent(o), https: new https.Agent(o) };
  }
  return directAgents;
}

class HttpTunnelAgent extends http.Agent {
  constructor(proxy, opts) { super(opts); this.proxy = proxy; }
  createConnection(options, cb) {
    let settled = false;
    const once = (e, s) => { if (!settled) { settled = true; cb(e, s); } };
    dialViaProxy(this.proxy, options.host, Number(options.port || 80), this.proxy._timeout || 15000)
      .then(s => once(null, s)).catch(once);
  }
}
class HttpsTunnelAgent extends https.Agent {
  constructor(proxy, insecure, opts) { super(opts); this.proxy = proxy; this.insecure = !!insecure; }
  createConnection(options, cb) {
    const host = options.host;
    const port = Number(options.port || 443);
    let settled = false;
    const once = (e, s) => { if (!settled) { settled = true; cb(e, s); } };
    dialViaProxy(this.proxy, host, port, this.proxy._timeout || 15000).then(raw => {
      raw.setNoDelay(true);
      const t = tls.connect({
        socket: raw,
        servername: options.servername || host,
        rejectUnauthorized: !this.insecure,
        ALPNProtocols: ['http/1.1'],
      }, () => once(null, t));
      t.once('error', (e) => { try { t.destroy(); } catch (_) {} once(e); });
    }).catch(once);
  }
}

const agentCache = new Map();
function getAgents(cfg, ch) {
  const raw = ch.proxy ? cfg.proxies[ch.proxy] : null;
  const proxy = (raw && typeof raw === 'object' && raw.type) ? raw : (ch.proxy ? normalizeProxy(ch.proxy) : null);
  if (ch.proxy && !proxy) logErr(`[config] 渠道 ${ch.name} 引用的代理 "${ch.proxy}" 不存在, 回落直连`);
  if (proxy) proxy._timeout = cfg.connectTimeout;
  const key = proxy ? `px:${proxy.type}:${proxy.host}:${proxy.port}:${ch.insecure ? 1 : 0}` : ('direct:' + (ch.insecure ? 'insecure' : 'std'));
  let a = agentCache.get(key);
  if (!a) {
    const o = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 16 };
    if (proxy) {
      a = { http: new HttpTunnelAgent(proxy, o), https: new HttpsTunnelAgent(proxy, ch.insecure, o) };
    } else if (ch.insecure) {
      a = { http: getDirectAgents().http, https: new https.Agent({ ...o, rejectUnauthorized: false }) };
    } else {
      a = getDirectAgents();
    }
    agentCache.set(key, a);
  }
  return a;
}

// Connection-level error test: peer closed early / unreachable etc., before any response arrives -> same-channel retry is safe (never double-bills)
function isConnErr(e) {
  const m = String((e && e.message) || e || '');
  return /socket hang up|ECONNRESET|EPIPE|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENOTFOUND/i.test(m);
}

//// build a one-shot Agent (keepAlive off, not cached): gives same-channel retries a brand-new connection,
// Sidestep keep-alive sockets the upstream already closed; never destroys the shared pool, so other in-flight requests are unaffected
function makeFreshAgents(cfg, ch) {
  const raw = ch.proxy ? cfg.proxies[ch.proxy] : null;
  const proxy = (raw && typeof raw === 'object' && raw.type) ? raw : (ch.proxy ? normalizeProxy(ch.proxy) : null);
  if (proxy) proxy._timeout = cfg.connectTimeout;
  const o = { keepAlive: false, maxSockets: 4 };
  if (proxy) return { http: new HttpTunnelAgent(proxy, o), https: new HttpsTunnelAgent(proxy, ch.insecure, o) };
  if (ch.insecure) return { http: new http.Agent(o), https: new https.Agent({ ...o, rejectUnauthorized: false }) };
  return { http: new http.Agent(o), https: new https.Agent(o) };
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, dialTcp, makeReader, socks5Connect, httpConnect, dialViaProxy, directAgents, getDirectAgents, HttpTunnelAgent, HttpsTunnelAgent, agentCache, getAgents, isConnErr, makeFreshAgents };
