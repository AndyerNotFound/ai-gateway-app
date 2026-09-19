
















'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const admin = require('./admin');
const { handleAdmin } = admin;

const VERSION = '1.4.0';


function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log('[' + ts() + ']', ...a); }
function logErr(...a) { console.error('[' + ts() + ']', ...a); }
function randId(prefix) { return prefix + crypto.randomBytes(10).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }


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
  if (typeof v === 'string') return v.startsWith('data:') ? v : rpApplyText(v, rules); 
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = rpWalk(v[i], rules, depth + 1, skipModel); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (skipModel && k === 'model') continue; 
      v[k] = rpWalk(v[k], rules, depth + 1, skipModel);
    }
    return v;
  }
  return v;
}


let crypt = null; try { crypt = require('./crypt.js'); } catch (_) {}


const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,            
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      
  /\bAKIA[0-9A-Z]{16}/g,                  
  /\bAIza[0-9A-Za-z_-]{30,}/g,            
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          
  /\bhf_[A-Za-z0-9]{20,}/g,               
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     
];
const REDACT_FIELD_RE = /api[-_]?key|apikey|secret|password|passwd|token|authorization/i;
function redactText(s, extra) {
  for (const re of REDACT_PATTERNS) s = s.replace(re, '***');
  if (extra) for (const p of extra) { try { s = s.replace(new RegExp(p, 'g'), '***'); } catch (_) {} }
  return s;
}
function redactDeep(v, extra, depth) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') return v.startsWith('data:') ? v : redactText(v, extra); 
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = redactDeep(v[i], extra, depth + 1); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (typeof val === 'string' && val && REDACT_FIELD_RE.test(k)) v[k] = '***';
      else v[k] = redactDeep(val, extra, depth + 1);
    }
    return v;
  }
  return v;
}
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
  
  const m = /^(socks5h?|socks|http|https):\/\/(?:([^:@\/]+)(?::([^@\/]*))?@)?([^:\/@]+):(\d+)\/?$/i.exec(String(p).trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const o = { type: (scheme === 'http' || scheme === 'https') ? 'http' : 'socks5', host: m[4], port: Number(m[5]) };
  if (m[2] != null) o.username = decodeURIComponent(m[2]);
  if (m[3] != null && m[3] !== '') o.password = decodeURIComponent(m[3]);
  return o;
}

function applyDefaults(cfg) {
  cfg.listen = cfg.listen || {};
  cfg.listen.port = Number(cfg.listen.port || 16384);
  cfg.listen.host = String(cfg.listen.host || '0.0.0.0');
  cfg.gatewayKey = cfg.gatewayKey ? String(cfg.gatewayKey) : '';
  cfg.modelSync = cfg.modelSync && typeof cfg.modelSync === 'object' ? cfg.modelSync : {};
  cfg.modelSync.enable = cfg.modelSync.enable !== false; 
  cfg.modelSync.intervalHours = Math.max(1, Number(cfg.modelSync.intervalHours) || 24);
  cfg.maxBodyBytes = Number(cfg.maxBodyBytes || 64 * 1024 * 1024);
  cfg.connectTimeout = Number(cfg.connectTimeout || 15000);
  cfg.responseTimeout = Number(cfg.responseTimeout || 180000);
  cfg.cors = cfg.cors !== false;
  
  cfg.tls = cfg.tls || (cfg.listen && cfg.listen.tls) || {};
  if (cfg.tls.enable) {
    cfg.tls.cert = String(cfg.tls.cert || 'cert.pem');
    cfg.tls.key = String(cfg.tls.key || 'key.pem');
    cfg.tls.port = cfg.tls.port != null ? Number(cfg.tls.port) : null; 
  }
  cfg.adminKey = cfg.adminKey ? String(cfg.adminKey) : '';
  if (cfg.proxies && typeof cfg.proxies === 'object' && !Array.isArray(cfg.proxies)) {
    const norm = {};
    for (const [k, v] of Object.entries(cfg.proxies)) {
      const n = (v && typeof v === 'object') ? v : normalizeProxy(v);
      if (n) norm[k] = n; else logErr(`[config] 跳过无效代理 "${k}"`);
    }
    cfg.proxies = norm;
  } else cfg.proxies = {};
  cfg.channels = cfg.channels || [];
  return cfg;
}

function loadConfig(file) {
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
      apiKey: ch.apiKey != null ? String(ch.apiKey) : '',
      proxy: ch.proxy != null && ch.proxy !== '' ? String(ch.proxy) : null,
      insecure: !!ch.insecure,
      models: Array.isArray(ch.models) ? ch.models.map(String) : null,
      modelMap: (ch.modelMap && typeof ch.modelMap === 'object' && !Array.isArray(ch.modelMap)) ? ch.modelMap : null,
      default: !!ch.default,
      delayMs: Math.max(0, Number(ch.delayMs) || 0),
      addUsage: ch.addUsage !== false,
      anthropicVersion: ch.anthropicVersion ? String(ch.anthropicVersion) : null,
    });
    const last = cfg.channels[cfg.channels.length - 1];
    if (!/^[\x09\x20-\x7e]*$/.test(last.apiKey)) logErr(`⚠ [config] 渠道 "${last.name}" 的 apiKey 含中文/非ASCII字符(像占位符?), 请求会失败, 请填入真实 Key`);
    if (!last.apiKey) logErr(`⚠ [config] 渠道 "${last.name}" 没有填 apiKey`);
  }
  return cfg;
}


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












function openaiToCanonical(body, urlModel) {
  const messages = [];
  for (const m of (body.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    let role = m.role;
    if (role === 'developer') role = 'system';
    if (role === 'function') {
      messages.push({ role: 'tool', name: m.name, tool_call_id: 'call_fn_' + (m.name || ''), content: toText(m.content) });
      continue;
    }
    const out = { role, content: m.content == null ? '' : m.content };
    if (m.name != null) out.name = m.name;
    if (m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}' },
      }));
    }
    messages.push(out);
  }
  return {
    model: body.model || urlModel,
    stream: !!body.stream,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens != null ? body.max_tokens : body.max_completion_tokens,
    stop: normStop(body.stop),
    tools: (Array.isArray(body.tools) && body.tools.length) ? body.tools : undefined,
    tool_choice: body.tool_choice,
  };
}

function claudeToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: (t.input_schema && typeof t.input_schema === 'object') ? t.input_schema : { type: 'object' } },
  }));
  return out.length ? out : undefined;
}
function claudeChoiceToOpenAI(tc) {
  if (!tc || typeof tc !== 'object') return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}
function claudeToCanonical(body, urlModel) {
  const messages = [];
  if (body.system) {
    const s = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '');
    if (s) messages.push({ role: 'system', content: s });
  }
  for (const m of (body.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    const blocks = Array.isArray(m.content) ? m.content : (m.content == null ? [] : [{ type: 'text', text: String(m.content) }]);
    const textParts = [];
    const toolCalls = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') textParts.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image' && b.source) {
        const s = b.source;
        if (s.type === 'base64') textParts.push({ type: 'image_url', image_url: { url: `data:${s.media_type || 'image/png'};base64,${s.data || ''}` } });
        else if (s.type === 'url') textParts.push({ type: 'image_url', image_url: { url: s.url } });
      } else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id || randId('call_'), type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input == null ? {} : b.input) } });
      } else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string'
          ? b.content
          : (Array.isArray(b.content) ? b.content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n') : '');
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: c });
      }
      
    }
    if (m.role === 'assistant') {
      if (textParts.length || toolCalls.length) {
        const out = { role: 'assistant', content: textParts.length ? textParts : '' };
        if (toolCalls.length) out.tool_calls = toolCalls;
        messages.push(out);
      }
    } else if (textParts.length) {
      messages.push({ role: 'user', content: textParts });
    }
  }
  return {
    model: body.model || urlModel,
    stream: !!body.stream,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
    stop: normStop(body.stop_sequences),
    tools: claudeToolsToOpenAI(body.tools),
    tool_choice: claudeChoiceToOpenAI(body.tool_choice),
  };
}

function geminiToCanonical(body, urlModel) {
  const messages = [];
  const sys = body.systemInstruction || body.system_instruction;
  if (sys && Array.isArray(sys.parts)) {
    const t = sys.parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    if (t) messages.push({ role: 'system', content: t });
  }
  let callSeq = 0;
  const lastName = {};
  for (const c of (body.contents || [])) {
    if (!c || !Array.isArray(c.parts)) continue;
    const role = c.role === 'model' ? 'assistant' : 'user';
    const textParts = [];
    const toolCalls = [];
    const toolMsgs = [];
    for (const p of c.parts) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.text === 'string') {
        if (!p.thought) textParts.push({ type: 'text', text: p.text });
      } else if (p.inlineData || p.inline_data) {
        const d = p.inlineData || p.inline_data;
        textParts.push({ type: 'image_url', image_url: { url: `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data || ''}` } });
      } else if (p.fileData || p.file_data) {
        const d = p.fileData || p.file_data;
        if (d.fileUri || d.file_uri) textParts.push({ type: 'image_url', image_url: { url: d.fileUri || d.file_uri } });
      } else if (p.functionCall || p.function_call) {
        const f = p.functionCall || p.function_call;
        const id = 'call_gm_' + (f.name || 'fn') + '_' + (callSeq++);
        toolCalls.push({ id, type: 'function', function: { name: f.name || '', arguments: JSON.stringify(f.args == null ? {} : f.args) } });
        lastName[f.name || ''] = id;
      } else if (p.functionResponse || p.function_response) {
        const f = p.functionResponse || p.function_response;
        toolMsgs.push({ role: 'tool', name: f.name || '', tool_call_id: lastName[f.name || ''] || ('call_gm_' + (f.name || '')), content: JSON.stringify(f.response == null ? {} : f.response) });
      }
    }
    if (role === 'assistant' && (textParts.length || toolCalls.length)) {
      const out = { role: 'assistant', content: textParts.length ? textParts : '' };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
    } else if (textParts.length) {
      messages.push({ role, content: textParts });
    }
    messages.push(...toolMsgs);
  }
  const g = body.generationConfig || body.generation_config || {};
  const tools = [];
  for (const t of (body.tools || [])) {
    if (!t || typeof t !== 'object') continue;
    const fds = t.functionDeclarations || t.function_declarations || [];
    for (const fd of fds) {
      tools.push({ type: 'function', function: { name: fd.name, description: fd.description || '', parameters: fd.parameters || fd.parametersJsonSchema || fd.parameters_json_schema || { type: 'object' } } });
    }
  }
  let tool_choice;
  const tcfg = (body.toolConfig && body.toolConfig.functionCallingConfig) || (body.tool_config && body.tool_config.function_calling_config);
  if (tcfg) {
    const mode = String(tcfg.mode || 'AUTO').toUpperCase();
    if (mode === 'ANY') tool_choice = (Array.isArray(tcfg.allowedFunctionNames) && tcfg.allowedFunctionNames.length === 1) ? { type: 'function', function: { name: tcfg.allowedFunctionNames[0] } } : 'required';
    else if (mode === 'NONE') tool_choice = 'none';
    else tool_choice = 'auto';
  }
  return {
    model: urlModel || body.model,
    stream: !!body.stream,
    messages,
    temperature: g.temperature,
    top_p: g.topP != null ? g.topP : g.top_p,
    max_tokens: g.maxOutputTokens != null ? g.maxOutputTokens : g.max_output_tokens,
    stop: normStop(g.stopSequences != null ? g.stopSequences : g.stop_sequences),
    tools: tools.length ? tools : undefined,
    tool_choice,
  };
}


function canonicalToOpenAIBody(c, opts = {}) {
  const messages = [];
  for (const m of (c.messages || [])) {
    if (m.role === 'assistant') {
      const content = typeof m.content === 'string' ? m.content : toText(m.content);
      const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length;
      const out = { role: 'assistant', content: content === '' && hasTools ? null : content };
      if (hasTools) out.tool_calls = m.tool_calls;
      if (m.name != null) out.name = m.name;
      messages.push(out);
    } else if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.tool_call_id || '', content: toText(m.content), ...(m.name ? { name: m.name } : {}) });
    } else if (m.role === 'system') {
      messages.push({ role: 'system', content: toText(m.content) });
    } else {
      let content = m.content;
      
      if (Array.isArray(content) && content.every(x => x && x.type === 'text')) {
        content = content.map(x => x.text || '').join('');
      }
      messages.push({ role: 'user', content: content == null ? '' : content });
    }
  }
  if (!messages.length) messages.push({ role: 'user', content: ' ' });
  const body = { model: c.model, messages, stream: !!c.stream };
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.max_tokens !== undefined) {
    if (/^o[0-9]/.test(String(c.model || ''))) body.max_completion_tokens = c.max_tokens;
    else body.max_tokens = c.max_tokens;
  }
  if (c.stop && c.stop.length) body.stop = c.stop;
  if (c.tools && c.tools.length) {
    body.tools = c.tools;
    if (c.tool_choice) body.tool_choice = c.tool_choice;
  }
  if (c.stream && opts.addUsage !== false) body.stream_options = { include_usage: true };
  return body;
}

function claudeFinish(reason) {
  return ({ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' })[reason] || 'end_turn';
}
function blocksToClaude(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  const out = [];
  for (const p of (content || [])) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
      const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(p.image_url.url);
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else out.push({ type: 'image', source: { type: 'url', url: p.image_url.url } });
    }
  }
  return out;
}
function canonicalToClaudeBody(c) {
  const turns = [];
  const pushTurn = (role, blocks) => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const m of (c.messages || [])) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      pushTurn('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: toText(m.content) }]);
    } else if (m.role === 'assistant') {
      const blocks = blocksToClaude(m.content);
      for (const tc of (m.tool_calls || [])) {
        let input = {};
        if (tc.function && typeof tc.function.arguments === 'string') {
          const p = safeParse(tc.function.arguments);
          if (p !== undefined && p !== null) input = (typeof p === 'object' && !Array.isArray(p)) ? p : { value: p };
        }
        blocks.push({ type: 'tool_use', id: tc.id || randId('toolu_'), name: (tc.function && tc.function.name) || '', input });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' });
      pushTurn('assistant', blocks);
    } else {
      pushTurn('user', blocksToClaude(m.content));
    }
  }
  if (!turns.length) turns.push({ role: 'user', content: [{ type: 'text', text: ' ' }] });
  const sysParts = (c.messages || []).filter(m => m.role === 'system').map(m => toText(m.content)).filter(Boolean);
  const body = {
    model: c.model,
    messages: turns,
    max_tokens: c.max_tokens != null ? Number(c.max_tokens) : 4096,
    stream: !!c.stream,
  };
  if (sysParts.length) body.system = sysParts.join('\n');
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.stop && c.stop.length) body.stop_sequences = c.stop;
  if (c.tools && c.tools.length) {
    body.tools = c.tools.map(t => ({
      name: t.function && t.function.name,
      description: (t.function && t.function.description) || '',
      input_schema: (t.function && t.function.parameters && typeof t.function.parameters === 'object') ? t.function.parameters : { type: 'object' },
    }));
    if (c.tool_choice === 'auto') body.tool_choice = { type: 'auto' };
    else if (c.tool_choice === 'required') body.tool_choice = { type: 'any' };
    else if (c.tool_choice === 'none') {  }
    else if (c.tool_choice && typeof c.tool_choice === 'object' && c.tool_choice.function) body.tool_choice = { type: 'tool', name: c.tool_choice.function.name };
  }
  return body;
}

function geminiFinish(reason) {
  return ({ stop: 'STOP', length: 'MAX_TOKENS', tool_calls: 'STOP', content_filter: 'SAFETY' })[reason] || 'STOP';
}
function blocksToGeminiParts(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }];
  const out = [];
  for (const p of (content || [])) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ text: p.text });
    else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
      const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(p.image_url.url);
      if (m) out.push({ inlineData: { mimeType: m[1], data: m[2] } });
      else out.push({ fileData: { fileUri: p.image_url.url } });
    }
  }
  return out;
}
function canonicalToGeminiBody(c) {
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const nameById = {};
  const sysParts = [];
  for (const m of (c.messages || [])) {
    if (m.role === 'system') { const s = toText(m.content); if (s) sysParts.push(s); continue; }
    if (m.role === 'tool') {
      const nm = m.name || nameById[m.tool_call_id] || 'function';
      let resp = safeParse(toText(m.content));
      if (resp === undefined || resp === null) resp = { result: '' };
      if (typeof resp !== 'object' || Array.isArray(resp)) resp = { result: resp };
      push('user', [{ functionResponse: { name: nm, response: resp } }]);
    } else if (m.role === 'assistant') {
      const parts = blocksToGeminiParts(m.content);
      for (const tc of (m.tool_calls || [])) {
        const nm = (tc.function && tc.function.name) || '';
        nameById[tc.id] = nm;
        let args = safeParse((tc.function && tc.function.arguments) || '{}');
        if (args === undefined || args === null) args = {};
        parts.push({ functionCall: { name: nm, args: (typeof args === 'object' && !Array.isArray(args)) ? args : { value: args } } });
      }
      push('model', parts);
    } else {
      push('user', blocksToGeminiParts(m.content));
    }
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: ' ' }] });
  const body = { contents };
  if (sysParts.length) body.systemInstruction = { parts: [{ text: sysParts.join('\n') }] };
  const gc = {};
  if (c.temperature !== undefined) gc.temperature = c.temperature;
  if (c.top_p !== undefined) gc.topP = c.top_p;
  if (c.max_tokens !== undefined) gc.maxOutputTokens = c.max_tokens;
  if (c.stop && c.stop.length) gc.stopSequences = c.stop;
  if (Object.keys(gc).length) body.generationConfig = gc;
  if (c.tools && c.tools.length) {
    body.tools = [{
      functionDeclarations: c.tools.map(t => ({
        name: t.function && t.function.name,
        description: (t.function && t.function.description) || '',
        parameters: (t.function && t.function.parameters) || { type: 'object' },
      })),
    }];
    let mode, allowed;
    if (c.tool_choice === 'auto') mode = 'AUTO';
    else if (c.tool_choice === 'required') mode = 'ANY';
    else if (c.tool_choice === 'none') mode = 'NONE';
    else if (c.tool_choice && typeof c.tool_choice === 'object' && c.tool_choice.function) { mode = 'ANY'; allowed = [c.tool_choice.function.name]; }
    if (mode) body.toolConfig = { functionCallingConfig: { mode, ...(allowed ? { allowedFunctionNames: allowed } : {}) } };
  }
  return body;
}


function openaiRespToCanonical(j) {
  const choice = (j.choices && j.choices[0]) || {};
  const msg = choice.message || {};
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) text = msg.content.filter(p => p && p.type === 'text').map(p => p.text || '').join('');
  const usage = j.usage || {};
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map(tc => ({
    id: tc.id, type: 'function',
    function: { name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}' },
  })) : undefined;
  return {
    text,
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : (typeof msg.reasoning === 'string' ? msg.reasoning : undefined),
    tool_calls: toolCalls,
    finish_reason: ({ stop: 'stop', length: 'length', tool_calls: 'tool_calls', content_filter: 'content_filter', function_call: 'tool_calls' })[choice.finish_reason] || 'stop',
    usage: { input: usage.prompt_tokens != null ? usage.prompt_tokens : 0, output: usage.completion_tokens != null ? usage.completion_tokens : 0 },
  };
}
function claudeRespToCanonical(j) {
  let text = '';
  const reasoningParts = [];
  const toolCalls = [];
  for (const b of (j.content || [])) {
    if (!b) continue;
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'thinking') reasoningParts.push(b.thinking || '');
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input == null ? {} : b.input) } });
  }
  const usage = j.usage || {};
  return {
    text,
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: ({ end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' })[j.stop_reason] || 'stop',
    usage: { input: usage.input_tokens != null ? usage.input_tokens : 0, output: usage.output_tokens != null ? usage.output_tokens : 0 },
  };
}
function geminiRespToCanonical(j) {
  const cand = (j.candidates && j.candidates[0]) || {};
  let text = '';
  const reasoningParts = [];
  const toolCalls = [];
  for (const p of ((cand.content && cand.content.parts) || [])) {
    if (!p) continue;
    if (typeof p.text === 'string') {
      if (p.thought) reasoningParts.push(p.text);
      else text += p.text;
    } else if (p.functionCall || p.function_call) {
      const f = p.functionCall || p.function_call;
      toolCalls.push({ id: randId('call_'), type: 'function', function: { name: f.name || '', arguments: JSON.stringify(f.args == null ? {} : f.args) } });
    }
  }
  const u = j.usageMetadata || j.usage_metadata || {};
  const fr = String(cand.finishReason || cand.finish_reason || 'STOP').toUpperCase();
  let finish = ({ STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', PROHIBITED_CONTENT: 'content_filter', BLOCKLIST: 'content_filter', SPII: 'content_filter' })[fr] || 'stop';
  if (toolCalls.length) finish = 'tool_calls';
  return {
    text,
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: finish,
    usage: { input: u.promptTokenCount != null ? u.promptTokenCount : (u.prompt_token_count || 0), output: u.candidatesTokenCount != null ? u.candidatesTokenCount : (u.candidates_token_count || 0) },
  };
}


function canonicalToOpenAIResp(cresp, model) {
  const message = { role: 'assistant', content: cresp.text === '' ? null : cresp.text };
  if (cresp.reasoning) message.reasoning_content = cresp.reasoning;
  if (cresp.tool_calls && cresp.tool_calls.length) message.tool_calls = cresp.tool_calls;
  if (cresp.text === '' && !(message.tool_calls || []).length) message.content = '';
  return {
    id: randId('chatcmpl-'), object: 'chat.completion', created: nowSec(), model,
    choices: [{ index: 0, message, finish_reason: cresp.finish_reason }],
    usage: { prompt_tokens: cresp.usage.input, completion_tokens: cresp.usage.output, total_tokens: cresp.usage.input + cresp.usage.output },
  };
}
function canonicalToClaudeResp(cresp, model) {
  const content = [];
  if (cresp.reasoning) content.push({ type: 'thinking', thinking: cresp.reasoning });
  if (cresp.text !== '') content.push({ type: 'text', text: cresp.text });
  for (const tc of (cresp.tool_calls || [])) {
    let input = safeParse(tc.function.arguments);
    if (input === undefined || input === null) input = {};
    content.push({ type: 'tool_use', id: tc.id || randId('toolu_'), name: tc.function.name, input: (typeof input === 'object' && !Array.isArray(input)) ? input : { value: input } });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: randId('msg_'), type: 'message', role: 'assistant', model,
    content,
    stop_reason: claudeFinish(cresp.finish_reason), stop_sequence: null,
    usage: { input_tokens: cresp.usage.input, output_tokens: cresp.usage.output },
  };
}
function canonicalToGeminiResp(cresp, model) {
  const parts = [];
  if (cresp.reasoning) parts.push({ text: cresp.reasoning, thought: true });
  if (cresp.text !== '') parts.push({ text: cresp.text });
  for (const tc of (cresp.tool_calls || [])) {
    let args = safeParse(tc.function.arguments);
    if (args === undefined || args === null) args = {};
    parts.push({ functionCall: { name: tc.function.name, args: (typeof args === 'object' && !Array.isArray(args)) ? args : { value: args } } });
  }
  if (!parts.length) parts.push({ text: '' });
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: geminiFinish(cresp.finish_reason), index: 0 }],
    usageMetadata: { promptTokenCount: cresp.usage.input, candidatesTokenCount: cresp.usage.output, totalTokenCount: cresp.usage.input + cresp.usage.output },
    modelVersion: model,
  };
}


class SSEDecoder {
  constructor(onData) { this.onData = onData; this.buf = ''; this.lines = []; }
  push(s) {
    this.buf += s;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.handleLine(line.replace(/\r$/, ''));
    }
  }
  handleLine(l) {
    if (l === '') { this.flushEvent(); return; }
    if (l.startsWith(':')) return;
    if (l.startsWith('data:')) this.lines.push(l.slice(5).replace(/^ /, ''));
  }
  flushEvent() {
    if (this.lines.length) {
      const d = this.lines.join('\n');
      this.lines = [];
      this.onData(d);
    }
  }
  end() { this.flushEvent(); }
}

class UpstreamStreamParser {
  constructor(format, emit) {
    this.format = format;
    this.emit = emit;
    this.finished = false;
    this.finishReason = undefined;
    this.usage = null;
    this.toolIdx = 0;
  }
  handle(j) {
    const evs = [];
    if (this.format === 'openai') {
      const ch = (j.choices && j.choices[0]) || {};
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) evs.push({ type: 'text', t: d.content });
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) evs.push({ type: 'reasoning', t: d.reasoning_content });
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index != null ? tc.index : this.toolIdx;
          const fname = (tc.function && tc.function.name) || '';
          if (tc.id || fname) evs.push({ type: 'tool_start', i, id: tc.id || ('call_' + fname), name: fname });
          if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) evs.push({ type: 'tool_delta', i, s: tc.function.arguments });
          if (tc.index != null && tc.index >= this.toolIdx) this.toolIdx = tc.index + 1;
        }
      }
      if (j.usage) this.usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
      if (ch.finish_reason) this.finishReason = ({ stop: 'stop', length: 'length', tool_calls: 'tool_calls', content_filter: 'content_filter', function_call: 'tool_calls' })[ch.finish_reason] || 'stop';
    } else if (this.format === 'claude') {
      const t = j.type;
      if (t === 'message_start') {
        const u = (j.message && j.message.usage) || {};
        this.usage = { input: u.input_tokens || 0, output: (this.usage && this.usage.output) || 0 };
        evs.push({ type: 'start', usage: { input: this.usage.input } });
      } else if (t === 'content_block_start') {
        const b = j.content_block || {};
        if (b.type === 'tool_use') evs.push({ type: 'tool_start', i: this.toolIdx++, id: b.id || randId('toolu_'), name: b.name || '' });
      } else if (t === 'content_block_delta') {
        const d = j.delta || {};
        if (d.type === 'text_delta' && d.text) evs.push({ type: 'text', t: d.text });
        else if (d.type === 'thinking_delta' && d.thinking) evs.push({ type: 'reasoning', t: d.thinking });
        else if (d.type === 'input_json_delta' && d.partial_json) evs.push({ type: 'tool_delta', i: Math.max(0, this.toolIdx - 1), s: d.partial_json });
      } else if (t === 'message_delta') {
        const d = j.delta || {};
        if (d.stop_reason) this.finishReason = ({ end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' })[d.stop_reason] || 'stop';
        if (j.usage && j.usage.output_tokens != null) this.usage = { input: (this.usage && this.usage.input) || 0, output: j.usage.output_tokens };
      }
      
    } else { 
      const cand = (j.candidates && j.candidates[0]) || {};
      for (const p of ((cand.content && cand.content.parts) || [])) {
        if (!p) continue;
        if (typeof p.text === 'string') {
          evs.push(p.thought ? { type: 'reasoning', t: p.text } : { type: 'text', t: p.text });
        } else if (p.functionCall || p.function_call) {
          const f = p.functionCall || p.function_call;
          const i = this.toolIdx++;
          evs.push({ type: 'tool_start', i, id: 'call_gm_' + i, name: f.name || '' });
          evs.push({ type: 'tool_delta', i, s: JSON.stringify(f.args == null ? {} : f.args) });
        }
      }
      const u = j.usageMetadata || j.usage_metadata;
      if (u) this.usage = { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0 };
      const fr = cand.finishReason || cand.finish_reason;
      if (fr) this.finishReason = ({ STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter' })[String(fr).toUpperCase()] || 'stop';
    }
    for (const e of evs) this.emit(e);
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.emit({ type: 'end', finish_reason: this.finishReason || 'stop', usage: this.usage || { input: 0, output: 0 } });
  }
}


function sseData(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function sseEvent(res, ev, obj) { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(obj) + '\n\n'); }

function makeWriter(format, res, model, opts = {}) {
  if (format === 'openai') {
    const id = randId('chatcmpl-');
    const created = nowSec();
    let firstChunk = true;
    const chunk = (delta, finish_reason) => {
      sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish_reason || null }] });
    };
    return {
      onEvent(ev) {
        if (ev.type === 'text') {
          if (firstChunk) { chunk({ role: 'assistant', content: '' }); firstChunk = false; }
          chunk({ content: ev.t });
        } else if (ev.type === 'reasoning') {
          if (firstChunk) { chunk({ role: 'assistant', content: '' }); firstChunk = false; }
          chunk({ reasoning_content: ev.t });
        } else if (ev.type === 'tool_start') {
          chunk({ tool_calls: [{ index: ev.i, id: ev.id, type: 'function', function: { name: ev.name, arguments: '' } }] });
        } else if (ev.type === 'tool_delta') {
          chunk({ tool_calls: [{ index: ev.i, function: { arguments: ev.s } }] });
        } else if (ev.type === 'end') {
          chunk({}, ev.finish_reason);
          const u = ev.usage || { input: 0, output: 0 };
          sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output } });
          res.write('data: [DONE]\n\n');
          res.end();
        }
      },
    };
  }

  if (format === 'claude') {
    const id = randId('msg_');
    let started = false, sawAny = false, nextBlock = 0, open = null;
    const usage = { input: 0, output: 0 };
    const ensureStart = () => {
      if (started) return;
      started = true;
      sseEvent(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1 } } });
      sseEvent(res, 'ping', { type: 'ping' });
    };
    const closeOpen = () => { if (open) { sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: open.idx }); open = null; } };
    const ensure = (kind, tool) => {
      if (open && open.kind === kind && (kind !== 'tool' || open.i === tool.i)) return open;
      closeOpen();
      const idx = nextBlock++;
      if (kind === 'text') sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      else if (kind === 'thinking') sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
      else sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
      open = { kind, idx, i: tool ? tool.i : undefined };
      return open;
    };
    return {
      onEvent(ev) {
        if (ev.type === 'start') {
          if (ev.usage && ev.usage.input) usage.input = ev.usage.input;
          ensureStart();
        } else if (ev.type === 'text') {
          sawAny = true; ensureStart();
          const b = ensure('text');
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'text_delta', text: ev.t } });
        } else if (ev.type === 'reasoning') {
          sawAny = true; ensureStart();
          const b = ensure('thinking');
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'thinking_delta', thinking: ev.t } });
        } else if (ev.type === 'tool_start') {
          sawAny = true; ensureStart();
          ensure('tool', { id: ev.id, name: ev.name, i: ev.i });
        } else if (ev.type === 'tool_delta') {
          ensureStart();
          const b = ensure('tool', { id: '', name: '', i: ev.i });
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'input_json_delta', partial_json: ev.s } });
        } else if (ev.type === 'end') {
          ensureStart();
          closeOpen();
          if (!sawAny) {
            const idx = nextBlock++;
            sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
            sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
          }
          const u = ev.usage || { input: 0, output: 0 };
          if (u.input) usage.input = u.input;
          usage.output = u.output;
          sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: claudeFinish(ev.finish_reason), stop_sequence: null }, usage: { output_tokens: u.output } });
          sseEvent(res, 'message_stop', { type: 'message_stop' });
          res.end();
        }
      },
    };
  }

  
  const isArray = !!opts.geminiArray;
  let firstArray = true;
  let toolBuf = null;
  const writeChunk = (obj) => {
    if (isArray) {
      if (firstArray) { res.write('[' + JSON.stringify(obj)); firstArray = false; }
      else res.write(',' + JSON.stringify(obj));
    } else sseData(res, obj);
  };
  const flushTool = () => {
    if (!toolBuf) return;
    let args = safeParse(toolBuf.s || '{}');
    if (args === undefined || args === null) args = {};
    writeChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: toolBuf.name, args: (typeof args === 'object' && !Array.isArray(args)) ? args : { value: args } } }] }, index: 0 }] });
    toolBuf = null;
  };
  return {
    onEvent(ev) {
      if (ev.type === 'text') {
        flushTool();
        writeChunk({ candidates: [{ content: { role: 'model', parts: [{ text: ev.t }] }, index: 0 }] });
      } else if (ev.type === 'reasoning') {
        flushTool();
        writeChunk({ candidates: [{ content: { role: 'model', parts: [{ text: ev.t, thought: true }] }, index: 0 }] });
      } else if (ev.type === 'tool_start') {
        flushTool();
        toolBuf = { i: ev.i, id: ev.id, name: ev.name, s: '' };
      } else if (ev.type === 'tool_delta') {
        if (toolBuf && toolBuf.i === ev.i) toolBuf.s += ev.s;
      } else if (ev.type === 'end') {
        flushTool();
        const u = ev.usage || { input: 0, output: 0 };
        writeChunk({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: geminiFinish(ev.finish_reason), index: 0 }], usageMetadata: { promptTokenCount: u.input, candidatesTokenCount: u.output, totalTokenCount: u.input + u.output } });
        if (isArray) { if (firstArray) res.write('[]'); else res.write(']'); }
        res.end();
      }
    },
  };
}





function pickChannels(cfg, model) {
  const chs = cfg.channels || [];
  const candidates = [];
  if (model) {
    
    for (const ch of chs) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
      }
    }
    
    if (!candidates.length) {
      for (const ch of chs) {
        if (ch.models && ch.models.includes(model)) candidates.push({ ch, upstreamModel: model });
      }
    }
  }
  
  if (!candidates.length) {
    const defs = chs.filter(c => c.default);
    const pool = defs.length ? defs : chs;
    for (const ch of pool) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
  
  if (!cfg._rr) cfg._rr = {};
  const key = model || '__nomodel__';
  cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
  const rot = cfg._rr[key];
  return candidates.slice(rot).concat(candidates.slice(0, rot));
}


function pickChannel(cfg, model) {
  const cs = pickChannels(cfg, model);
  return cs.length ? cs[0] : null;
}

function checkAuth(cfg, req, query) {
  if (!cfg.gatewayKey) return true;
  const h = req.headers;
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const k = cfg.gatewayKey;
  if (bearer === k) return true;
  if (h['x-api-key'] === k) return true;
  if (h['x-goog-api-key'] === k) return true;
  if (query && query.get('key') === k) return true;
  return false;
}

let CUR_CFG = null;
function corsHeaders() {
  if (!CUR_CFG || !CUR_CFG.cors) return {};
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
}

function jsonErr(res, e) {
  try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e && e.message) || String(e) })); } catch (_) {}
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
  
  return { object: 'list', data: ms.map(m => ({ id: m, object: 'model', type: 'model', created: 1700000000, owned_by: 'ai-gateway', display_name: m })) };
}


function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  if (suffix.startsWith('/v1beta/') && /\/v1beta$/.test(b)) return b + suffix.slice(7);
  if (suffix.startsWith('/v1/') && /\/v1$/.test(b)) return b + suffix.slice(3);
  return b + suffix;
}

function upstreamRequest(cfg, ch, urlStr, headers, bodyBuf, cb, method) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const agents = getAgents(cfg, ch);
  const mod = isHttps ? https : http;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    method: method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuf ? bodyBuf.length : 0,
      'User-Agent': 'ai-gateway/' + VERSION,
      ...headers,
    },
    agent: isHttps ? agents.https : agents.http,
  };
  let settled = false;
  const req = mod.request(opts, (upRes) => { if (!settled) { settled = true; cb(null, upRes, req); } });
  req.setTimeout(cfg.responseTimeout, () => req.destroy(new Error('upstream idle timeout (' + Math.round(cfg.responseTimeout / 1000) + 's)')));
  req.once('error', (e) => { if (!settled) { settled = true; cb(e, null, req); } });
  if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
  req.end();
  return req;
}


const TO_CANON = { openai: openaiToCanonical, claude: claudeToCanonical, gemini: geminiToCanonical };


function fetchUpstreamModels(cfg, ch) {
  return new Promise((resolve, reject) => {
    const base = String(ch.baseUrl || '').replace(/\/+$/, '');
    let url; const headers = {};
    try {
      if (ch.type === 'openai') {
        url = joinUrl(base, '/v1/models');   
        if (ch.apiKey) headers.authorization = 'Bearer ' + ch.apiKey;
      } else if (ch.type === 'claude') {
        url = joinUrl(base, '/v1/models');
        if (ch.apiKey) { headers['x-api-key'] = ch.apiKey; headers['anthropic-version'] = ch.anthropicVersion || '2023-06-01'; }
      } else if (ch.type === 'gemini') {
        url = joinUrl(base, '/v1beta/models');
        if (ch.apiKey) headers['x-goog-api-key'] = ch.apiKey;
      } else return reject(new Error('未知渠道类型: ' + ch.type));
      if (!base) return reject(new Error('渠道未配置 Base URL'));
      if (ch.apiKey && !/^[\x09\x20-\x7e]*$/.test(ch.apiKey)) return reject(new Error('渠道 apiKey 含非 ASCII 字符(可能残留了中文占位符), 请先在渠道设置里修正'));
    } catch (e) { return reject(e); }
    upstreamRequest({ ...cfg, responseTimeout: 20000 }, ch, url, headers, Buffer.alloc(0), (err, upRes) => {
      if (err) return reject(new Error('连接上游失败: ' + err.message));
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (upRes.statusCode >= 400) return reject(new Error('上游返回 ' + upRes.statusCode + ': ' + redactText(txt.slice(0, 200))));
        let ids = [];
        try {
          const j = JSON.parse(txt);
          if (Array.isArray(j.data)) ids = j.data.map(x => x && (x.id || x.name)).filter(Boolean);
          else if (Array.isArray(j.models)) ids = j.models.map(x => String(x.name || x.id || '').replace(/^models\//, '')).filter(Boolean);
          else if (Array.isArray(j)) ids = j.map(x => typeof x === 'string' ? x : (x && (x.id || x.name))).filter(Boolean);
          else throw new Error('无法识别的返回格式');
        } catch (e) { return reject(new Error('解析模型列表失败: ' + e.message)); }
        resolve([...new Set(ids.map(String))]);
      });
      upRes.on('error', e => reject(new Error('读取响应失败: ' + e.message)));
    }, 'GET');
  });
}

let _syncing = false;
async function syncModels(cfg) {
  if (_syncing) return { busy: true };
  _syncing = true;
  const bn = cfg._configFile ? path.basename(cfg._configFile, '.json') : 'config';
  const inst = bn === 'config' ? 'default' : bn.replace(/^config\./, '');
  let added = 0, chCount = 0, fails = 0;
  let fileCfg = null;
  try {
    let raw = fs.readFileSync(cfg._configFile, 'utf8');
    if (crypt && crypt.isEncText(raw)) { const p = crypt.loadPass(); if (p) raw = crypt.decryptText(raw, p); }
    fileCfg = JSON.parse(raw);
  } catch (e) { logErr('[sync] 读配置失败(仅更新内存):', e.message); }
  for (const ch of (cfg.channels || [])) {
    if (!ch.baseUrl) continue;
    chCount++;
    try {
      const ids = await fetchUpstreamModels(cfg, ch);
      ch.models = Array.isArray(ch.models) ? ch.models : [];
      let n = 0;
      for (const id of ids) if (!ch.models.includes(id)) { ch.models.push(id); n++; added++; }
      if (n && fileCfg) { const fc = (fileCfg.channels || []).find(c => c.name === ch.name); if (fc) fc.models = ch.models; }
      log('[sync]', inst + '/' + ch.name, '拉到', ids.length, '新增', n, '共', ch.models.length);
    } catch (e) { fails++; log('[sync]', inst + '/' + ch.name, '失败:', e.message); }
  }
  if (fileCfg && added > 0) {
    try { admin.saveCfg(inst, fileCfg); log('[sync]', inst, '已落盘, 共新增', added); }
    catch (e) { logErr('[sync] 落盘失败:', e.message); }
  }
  _syncing = false;
  return { instance: inst, channels: chCount, added, fails };
}

const UP_RESP = { openai: openaiRespToCanonical, claude: claudeRespToCanonical, gemini: geminiRespToCanonical };
const BUILD_BODY = { openai: canonicalToOpenAIBody, claude: canonicalToClaudeBody, gemini: canonicalToGeminiBody };


const RETRYABLE = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529]);


function buildRequestForChannel(cfg, ch, clientFormat, canonical, body, urlInfo, req) {
  const direct = clientFormat === ch.type;
  const stream = canonical.stream;
  const upstreamModel = canonical.model; 
  let url, headers = {}, bodyBuf;
  if (direct) {
    if (ch.type === 'openai') {
      url = joinUrl(ch.baseUrl, '/v1/chat/completions');
      body.model = upstreamModel;
      headers.authorization = 'Bearer ' + ch.apiKey;
    } else if (ch.type === 'claude') {
      url = joinUrl(ch.baseUrl, '/v1/messages');
      body.model = upstreamModel;
      headers['x-api-key'] = ch.apiKey;
      headers['anthropic-version'] = ch.anthropicVersion || req.headers['anthropic-version'] || '2023-06-01';
    } else {
      const action = stream ? 'streamGenerateContent' : 'generateContent';
      url = joinUrl(ch.baseUrl, '/v1beta/models/' + encodeURIComponent(upstreamModel) + ':' + action) + (stream && urlInfo.altSse ? '?alt=sse' : '');
      headers['x-goog-api-key'] = ch.apiKey;
    }
    bodyBuf = Buffer.from(JSON.stringify(body));
  } else {
    const uc = { ...canonical, model: upstreamModel };
    if (ch.type === 'openai') {
      url = joinUrl(ch.baseUrl, '/v1/chat/completions');
      bodyBuf = Buffer.from(JSON.stringify(BUILD_BODY.openai(uc, { addUsage: ch.addUsage })));
      headers.authorization = 'Bearer ' + ch.apiKey;
    } else if (ch.type === 'claude') {
      url = joinUrl(ch.baseUrl, '/v1/messages');
      bodyBuf = Buffer.from(JSON.stringify(BUILD_BODY.claude(uc)));
      headers['x-api-key'] = ch.apiKey;
      headers['anthropic-version'] = ch.anthropicVersion || '2023-06-01';
    } else {
      const action = stream ? 'streamGenerateContent' : 'generateContent';
      url = joinUrl(ch.baseUrl, '/v1beta/models/' + encodeURIComponent(upstreamModel) + ':' + action) + (stream ? '?alt=sse' : '');
      bodyBuf = Buffer.from(JSON.stringify(BUILD_BODY.gemini(uc)));
      headers['x-goog-api-key'] = ch.apiKey;
    }
  }
  if (stream) headers.accept = 'text/event-stream';
  return { url, headers, bodyBuf, direct, stream };
}



function instName(cfg) {
  const bn = cfg._configFile ? path.basename(cfg._configFile, '.json') : 'config';
  return bn === 'config' ? 'default' : bn.replace(/^config\./, '');
}

function writeRequestRecord(cfg, recCfg, rec) {
  const line = JSON.stringify(rec);
  if (recCfg.server) { postRequestRecord(recCfg.server, line); return; }
  try {
    const dir = path.join(path.dirname(cfg._configFile || process.cwd()), 'log');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'requests-' + instName(cfg) + '.jsonl');
    
    try {
      const st = fs.statSync(f);
      if (st.size > 5 * 1024 * 1024) {
        const txt = fs.readFileSync(f, 'utf8');
        const cut = txt.indexOf('\n', Math.max(0, txt.length - 2 * 1024 * 1024));
        fs.writeFileSync(f, cut >= 0 ? txt.slice(cut + 1) : txt.slice(-2 * 1024 * 1024));
      }
    } catch (_) {}
    fs.appendFileSync(f, line + '\n');
  } catch (e) { logErr('请求记录写入失败:', e.message); }
}
function postRequestRecord(server, line) {
  try {
    const u = new URL(server);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(line) },
    }, (resp) => { resp.resume(); });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => logErr('请求记录上报失败:', e.message));
    r.end(line);
  } catch (e) { logErr('请求记录服务器地址无效:', e.message); }
}

function handleUpstreamResponse(cfg, ch, clientFormat, canonical, body, urlInfo, req, res, upRes, built, ctx) {
  const { direct, stream } = built;
  const { logMeta, t0, usageCapture, stats } = ctx;
  const rpInc = (cfg.replace && Array.isArray(cfg.replace.inc)) ? rpCompile(cfg.replace.inc) : [];

  if (direct) {
    const ct = upRes.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json');
    try {
      res.writeHead(upRes.statusCode, { 'Content-Type': ct, 'X-AI-Gateway-Channel': ch.name, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    } catch (_) { return; }
    if (stream) {
      const parser = new UpstreamStreamParser(ch.type, () => {});
      const dec = new SSEDecoder((data) => { try { if (data !== '[DONE]') parser.handle(JSON.parse(data)); } catch (_) {} });
      upRes.on('data', c => { try { dec.push(c.toString('utf8')); } catch (_) {} });
      upRes.on('end', () => { dec.end(); parser.finish(); usageCapture.input = parser.usage ? parser.usage.input : 0; usageCapture.output = parser.usage ? parser.usage.output : 0; ctx.logDone(upRes.statusCode); });
      upRes.on('error', () => { try { res.end(); } catch (_) {} });
    } else {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const j = safeParse(Buffer.concat(chunks).toString('utf8'));
        if (j) { const cr = UP_RESP[ch.type](j); usageCapture.input = cr.usage.input; usageCapture.output = cr.usage.output; }
        ctx.logDone(upRes.statusCode);
      });
      upRes.on('error', () => { try { res.end(); } catch (_) {} });
    }
    if (rpInc.length) {
      
      let buf = '';
      upRes.on('data', c => {
        try {
          buf += c.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) res.write(rpApplyText(line, rpInc) + '\n');
        } catch (_) {}
      });
      upRes.on('end', () => { try { if (buf) res.write(rpApplyText(buf, rpInc)); res.end(); } catch (_) {} });
      upRes.on('error', () => { try { res.end(); } catch (_) {} });
    } else {
      upRes.pipe(res);
    }
    return;
  }

  
  if (stream) {
    const isArrayStream = clientFormat === 'gemini' && !urlInfo.altSse;
    try {
      res.writeHead(200, {
        'Content-Type': isArrayStream ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-AI-Gateway-Channel': ch.name, 'Access-Control-Allow-Origin': '*',
      });
    } catch (_) { return; }
    const writer = makeWriter(clientFormat, res, canonical.model, { geminiArray: isArrayStream });
    const parser = new UpstreamStreamParser(ch.type, ev => {
      try { if (rpInc.length) rpWalk(ev, rpInc, 0, false); writer.onEvent(ev); } catch (e) { logErr('writer error:', e.message); }
    });
    const dec = new SSEDecoder((data) => {
      if (data === '[DONE]') { parser.finish(); return; }
      try { parser.handle(JSON.parse(data)); } catch (e) { logErr('bad SSE data (first 200 chars):', String(data).slice(0, 200)); }
    });
    upRes.on('data', c => { try { dec.push(c.toString('utf8')); } catch (_) {} });
    upRes.on('end', () => {
      dec.end(); parser.finish();
      usageCapture.input = parser.usage ? parser.usage.input : 0;
      usageCapture.output = parser.usage ? parser.usage.output : 0;
      ctx.logDone(200);
    });
    upRes.on('error', (e) => { logErr('upstream stream error:', e.message); try { res.end(); } catch (_) {} });
  } else {
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', () => {
      const txt = Buffer.concat(chunks).toString('utf8');
      const j = safeParse(txt);
      if (!j) {
        stats.errors++;
        return sendError(clientFormat, res, 502, 'upstream returned non-JSON: ' + redactText(txt.slice(0, 200), cfg.redact && cfg.redact.extra));
      }
      const cresp = UP_RESP[ch.type](j);
      usageCapture.input = cresp.usage.input;
      usageCapture.output = cresp.usage.output;
      let out;
      if (clientFormat === 'openai') out = canonicalToOpenAIResp(cresp, canonical.model);
      else if (clientFormat === 'claude') out = canonicalToClaudeResp(cresp, canonical.model);
      else out = canonicalToGeminiResp(cresp, canonical.model);
      if (rpInc.length) rpWalk(out, rpInc, 0, false);
      try {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-AI-Gateway-Channel': ch.name, ...corsHeaders() });
        res.end(JSON.stringify(out));
      } catch (_) {}
      ctx.logDone(200);
    });
    upRes.on('error', () => { try { res.end(); } catch (_) {} });
  }
}

function handleChat(cfg, clientFormat, req, res, urlInfo, bodyStr) {
  const stats = cfg._stats;
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch (e) { return sendError(clientFormat, res, 400, 'invalid JSON body: ' + e.message); }
  if (!body || typeof body !== 'object') return sendError(clientFormat, res, 400, 'request body must be a JSON object');
  
  if (!(cfg.redact && cfg.redact.enable === false)) body = redactDeep(body, cfg.redact && cfg.redact.extra, 0);
  
  const rpOutRules = (cfg.replace && Array.isArray(cfg.replace.out)) ? rpCompile(cfg.replace.out) : [];
  if (rpOutRules.length) body = rpWalk(body, rpOutRules, 0, true);

  const canonical = TO_CANON[clientFormat](body, urlInfo.model);
  if (urlInfo.stream) canonical.stream = true; 
  if (!canonical.model) return sendError(clientFormat, res, 400, 'missing "model"');

  const candidates = pickChannels(cfg, canonical.model);
  if (!candidates.length) return sendError(clientFormat, res, 503, 'no channel configured in config.json');

  stats.requests++;
  
  const reqId = randId('req');
  const recCfg = (cfg.record && cfg.record.enable) ? cfg.record : null;
  const recState = { status: 0, chName: '' };
  let recChunks = null, recFinalized = false;
  const recordReq = (status, chName, inT, outT) => {
    recState.status = status; recState.chName = chName || '';
    stats.recent.push({ id: reqId, time: new Date().toISOString().slice(0, 19).replace('T', ' '), model: canonical.model, channel: chName || '', status, duration: Date.now() - t0, inputTokens: inT || 0, outputTokens: outT || 0 });
    if (stats.recent.length > 200) stats.recent.shift();
  };
  const stream = canonical.stream;
  const t0 = Date.now();
  const usageCapture = { input: 0, output: 0 };
  function finalizeRecord() {
    if (!recCfg || recFinalized) return; recFinalized = true;
    try {
      const maxC = (recCfg.maxChars > 0 ? recCfg.maxChars : 200000);
      let resp = Buffer.concat(recChunks).toString('utf8');
      if (resp.length > maxC) resp = resp.slice(0, maxC) + '\n…[截断]';
      let reqTxt = ''; try { reqTxt = JSON.stringify(body); } catch (_) {}
      if (reqTxt.length > maxC) reqTxt = reqTxt.slice(0, maxC) + '…[截断]';
      writeRequestRecord(cfg, recCfg, {
        id: reqId, time: new Date().toISOString(), instance: instName(cfg), format: clientFormat,
        model: canonical.model, channel: recState.chName, status: recState.status,
        duration: Date.now() - t0, inputTokens: usageCapture.input || 0, outputTokens: usageCapture.output || 0,
        request: safeParse(reqTxt) || reqTxt, response: resp,
      });
    } catch (_) {}
  }
  if (recCfg) {
    recChunks = [];
    const ow = res.write.bind(res), oe = res.end.bind(res);
    res.write = (c, ...a) => { try { if (c) recChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); } catch (_) {} return ow(c, ...a); };
    res.end = (c, ...a) => {
      try { if (c && typeof c !== 'function') recChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); } catch (_) {}
      finalizeRecord();
      return oe(c, ...a);
    };
  }
  let attempt = 0;
  let lastErrStatus = 0;
  let lastErrMsg = '';

  
  const tryNext = () => {
    if (attempt >= candidates.length) {
      
      stats.errors++;
      recordReq(lastErrStatus || 502, '', 0, 0);
      const msg = lastErrMsg || ('all ' + candidates.length + ' channels failed');
      return sendError(clientFormat, res, lastErrStatus || 502, msg);
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    const myCanonical = { ...canonical, model: pick.upstreamModel || canonical.model };
    const built = buildRequestForChannel(cfg, ch, clientFormat, myCanonical, body, urlInfo, req);
    attempt++;

    
    for (const [hk, hv] of Object.entries(built.headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        return sendError(clientFormat, res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请修改 config.json`);
      }
    }

    const ctx = {
      logMeta: [clientFormat + '>' + ch.type, 'model=' + canonical.model, 'ch=' + ch.name, 'proxy=' + (ch.proxy || '-'), stream ? 'stream' : 'block'].join(' '),
      t0, usageCapture, stats,
      logDone(status) {
        log(ctx.logMeta, 'status=' + status, 'in=' + usageCapture.input, 'out=' + usageCapture.output, 'ms=' + (Date.now() - t0));
        stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
        stats.byChannel[ch.name].inputTokens += usageCapture.input;
        stats.byChannel[ch.name].outputTokens += usageCapture.output;
        recordReq(status, ch.name, usageCapture.input, usageCapture.output);
      },
    };
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;

    
    const delayMs = Math.min(120000, Number(ch.delayMs) || 0);
    const doSend = () => upstreamRequest(cfg, ch, built.url, built.headers, built.bodyBuf, (err, upRes) => {
      if (err) {
        lastErrStatus = 502; lastErrMsg = 'upstream request failed: ' + err.message;
        log('ERR', ctx.logMeta, err.message, attempt < candidates.length ? '→ 切换渠道' : '→ 无更多渠道');
        if (attempt < candidates.length) return tryNext();
        stats.errors++;
        recordReq(502, ch.name, 0, 0);
        return sendError(clientFormat, res, 502, lastErrMsg);
      }

      if (upRes.statusCode >= 400 && RETRYABLE.has(upRes.statusCode) && attempt < candidates.length) {
        
        const sc = upRes.statusCode;
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = sc;
          lastErrMsg = `渠道 ${ch.name} 返回 ${sc}: ` + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 300);
          log('RETRY', ctx.logMeta, 'status=' + sc, '→ 切换渠道 (' + (candidates.length - attempt) + ' 个剩余)');
          tryNext();
        });
        upRes.on('error', () => { tryNext(); });
        return;
      }

      if (upRes.statusCode >= 400) {
        
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          stats.errors++;
          recordReq(upRes.statusCode, ch.name, 0, 0);
          log('UPERR', ctx.logMeta, 'status=' + upRes.statusCode, attempt > 1 ? '(已尝试 ' + attempt + ' 个渠道)' : '');
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': ch.name, ...corsHeaders() });
            res.end(Buffer.concat(chunks));
          } catch (_) {}
        });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }

      
      handleUpstreamResponse(cfg, ch, clientFormat, myCanonical, body, urlInfo, req, res, upRes, built, ctx);
    });
    if (delayMs > 0) {
      ch._gate = (ch._gate || Promise.resolve()).catch(() => {}).then(() => new Promise(r => setTimeout(r, delayMs)));
      ch._gate.then(() => { try { doSend(); } catch (e) { try { sendError(clientFormat, res, 500, 'upstream dispatch failed: ' + e.message); } catch (_) {} } });
    } else {
      doSend();
    }
  };
  tryNext();
}


const GEMINI_RE = /^\/v1(?:beta|alpha)?\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)$/;

async function handleHttp(cfg, req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (cfg.cors && req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }

  if (req.method === 'GET' && p === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, version: VERSION, uptime: Math.round(process.uptime()) }));
  }
  if (req.method === 'GET' && p === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, version: VERSION, startedAt: cfg._stats.startedAt, uptime: Math.round(process.uptime()),
      listen: cfg.listen, configFile: cfg._configFile,
      channels: cfg.channels.map(c => ({ name: c.name, type: c.type, baseUrl: c.baseUrl, proxy: c.proxy || null, models: c.models, modelMap: c.modelMap, default: c.default, delayMs: c.delayMs || 0 })),
      proxies: Object.entries(cfg.proxies).map(([k, v]) => ({ name: k, type: v.type, host: v.host, port: v.port })),
      stats: { requests: cfg._stats.requests, errors: cfg._stats.errors, byChannel: cfg._stats.byChannel },
    }));
  }

  
  if (p === '/admin' || p === '/admin/' || p.startsWith('/admin/api/') || p.startsWith('/admin/m3')) {
    
    
    if (req.method === 'POST' || req.method === 'DELETE') {
      let adminBody = '';
      req.on('data', c => { adminBody += c.toString('utf8'); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { handleAdmin(cfg, req, res, u, p, adminBody).catch(e => jsonErr(res, e)); });
      req.on('error', () => {});
    } else {
      return handleAdmin(cfg, req, res, u, p, '');
    }
    return;
  }
  if (req.method === 'GET' && (p === '/v1/models' || p === '/v1beta/models')) {
    const fmt = p === '/v1beta/models' ? 'gemini' : 'openai';
    if (!checkAuth(cfg, req, u.searchParams)) return sendError(fmt, res, 401, 'invalid gateway key');
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(modelsResponse(cfg, fmt)));
  }

  if (req.method !== 'POST') return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);

  let clientFormat = null;
  const urlInfo = { model: null, altSse: false };
  if (p === '/v1/chat/completions' || p === '/chat/completions') clientFormat = 'openai';
  else if (p === '/v1/messages' || p === '/messages') clientFormat = 'claude';
  else {
    const m = GEMINI_RE.exec(p);
    if (m) {
      clientFormat = 'gemini';
      urlInfo.model = decodeURIComponent(m[1]);
      urlInfo.altSse = u.searchParams.get('alt') === 'sse';
      urlInfo.stream = m[2] === 'streamGenerateContent';
      if (m[2] === 'countTokens') return sendError('gemini', res, 501, 'countTokens is not supported by this gateway');
    }
  }
  if (!clientFormat) return sendError('openai', res, 404, 'unknown endpoint: ' + p + ' (支持: /v1/chat/completions | /v1/messages | /v1beta/models/{model}:generateContent|:streamGenerateContent)');

  if (!checkAuth(cfg, req, u.searchParams)) return sendError(clientFormat, res, 401, 'invalid gateway key');

  let bodyStr = '';
  let size = 0;
  let aborted = false;
  req.on('data', c => {
    if (aborted) return;
    size += c.length;
    if (size > cfg.maxBodyBytes) {
      aborted = true;
      req.destroy();
      sendError(clientFormat, res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)');
      return;
    }
    bodyStr += c.toString('utf8');
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      handleChat(cfg, clientFormat, req, res, urlInfo, bodyStr);
    } catch (e) {
      logErr('chat crash:', e);
      sendError(clientFormat, res, 500, 'internal: ' + e.message);
    }
  });
  req.on('error', () => {});
}

function startServer(cfg, opts = {}) {
  CUR_CFG = cfg;
  applyDefaults(cfg);
  admin.setDir(cfg._configFile ? path.dirname(cfg._configFile) : path.join(os.homedir(), 'ai-gateway'));
  admin.setUpstreamModels(ch => fetchUpstreamModels(cfg, ch));
  admin.setSyncFn(() => syncModels(cfg));
  if (cfg.modelSync && cfg.modelSync.enable !== false) {
    const hrs = Math.max(1, Number(cfg.modelSync.intervalHours) || 24);
    const run = () => syncModels(cfg).catch(e => logErr('[sync] 定时任务出错:', e.message));
    setTimeout(run, 30000); 
    setInterval(run, hrs * 3600 * 1000);
  }
  cfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] };
  const handler = (req, res) => {
    handleHttp(cfg, req, res).catch(e => {
      logErr('handler crash:', e);
      sendError('openai', res, 500, 'internal: ' + (e && e.message));
    });
  };
  const host = opts.host || cfg.listen.host;
  const port = opts.port != null ? opts.port : cfg.listen.port;

  
  let tlsCfg = null;
  if (cfg.tls && cfg.tls.enable) {
    const certPath = path.isAbsolute(cfg.tls.cert) ? cfg.tls.cert : path.join(path.dirname(cfg._configFile || process.cwd()), cfg.tls.cert);
    const keyPath = path.isAbsolute(cfg.tls.key) ? cfg.tls.key : path.join(path.dirname(cfg._configFile || process.cwd()), cfg.tls.key);
    try {
      tlsCfg = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
        port: cfg.tls.port,
      };
    } catch (e) {
      logErr(`⚠ TLS 已启用但证书读取失败: ${e.message}`);
      logErr(`  cert: ${certPath}`);
      logErr(`  key:  ${keyPath}`);
      logErr(`  请先运行 ~/ai-gateway/gen-cert.sh 生成证书, 或在 config.json 中设置 "tls": {"enable": false}`);
      logErr(`  本次将以纯 HTTP 模式启动`);
    }
  }

  if (!tlsCfg) {
    
    const server = http.createServer(handler);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeAllListeners('error');
        const realPort = server.address().port;
        log(`ai-gateway v${VERSION} 就绪: http://${host === '0.0.0.0' ? '127.0.0.1(本机)/局域网IP' : host}:${realPort}  配置: ${cfg._configFile}`);
        for (const ch of cfg.channels) log(`  渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
        for (const [k, v] of Object.entries(cfg.proxies)) log(`  代理 ${k} = ${v.type}://${v.host}:${v.port}${v.username ? ' (带认证)' : ''}`);
        resolve({ server, port: realPort, host, cfg });
      });
    });
  }

  
  const httpsPort = tlsCfg.port != null ? tlsCfg.port : port;
  const dualMode = tlsCfg.port != null && tlsCfg.port !== port;

  return new Promise((resolve, reject) => {
    const results = { servers: [], ports: [], cfg };

    const logReady = () => {
      log(`ai-gateway v${VERSION} 就绪 (配置: ${cfg._configFile}):`);
      for (const [p, scheme] of results.ports) {
        log(`  ${scheme}://${host === '0.0.0.0' ? '127.0.0.1(本机)/局域网IP' : host}:${p}`);
      }
      for (const ch of cfg.channels) log(`  渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
      for (const [k, v] of Object.entries(cfg.proxies)) log(`  代理 ${k} = ${v.type}://${v.host}:${v.port}${v.username ? ' (带认证)' : ''}`);
    };

    let pending = dualMode ? 2 : 1;
    const onReady = (server, p, scheme) => {
      results.servers.push(server);
      results.ports.push([p, scheme]);
      if (--pending === 0) { logReady(); resolve({ servers: results.servers, ports: results.ports, server: results.servers[0], port: results.ports[0][0], host, cfg }); }
    };
    const onErr = (e) => reject(e);

    
    const httpsServer = https.createServer({ cert: tlsCfg.cert, key: tlsCfg.key }, handler);
    httpsServer.once('error', onErr);
    httpsServer.listen(httpsPort, host, () => {
      httpsServer.removeAllListeners('error');
      onReady(httpsServer, httpsServer.address().port, 'https');
    });

    
    if (dualMode) {
      const httpServer = http.createServer(handler);
      httpServer.once('error', onErr);
      httpServer.listen(port, host, () => {
        httpServer.removeAllListeners('error');
        onReady(httpServer, httpServer.address().port, 'http');
      });
    }
  });
}


function main() {
  const args = process.argv.slice(2);
  let configPath = path.join(__dirname, 'config.json');
  let portOverride;
  for (const a of args) {
    if (/^\d+$/.test(a)) portOverride = Number(a);
    else configPath = a;
  }
  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    logErr('配置加载失败:', e.message);
    process.exit(1);
  }
  if (!cfg.channels.length) logErr('⚠ 配置里没有任何有效渠道, 请求会返回 503');
  process.on('unhandledRejection', e => logErr('unhandledRejection:', (e && e.message) || e));
  process.on('uncaughtException', e => logErr('uncaughtException:', (e && e.message) || e));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  startServer(cfg, { port: portOverride }).catch(e => { logErr('启动失败:', e.message); process.exit(1); });
}

if (require.main === module) main();

module.exports = {
  VERSION, loadConfig, normalizeProxy, joinUrl, pickChannel, pickChannels, collectModels, RETRYABLE,
  openaiToCanonical, claudeToCanonical, geminiToCanonical,
  canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody,
  openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical,
  canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp,
  SSEDecoder, UpstreamStreamParser, makeWriter, claudeFinish, geminiFinish,
  socks5Connect, httpConnect, dialViaProxy, makeReader,
  startServer, checkAuth,
};
