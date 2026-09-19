'use strict';





const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const http = require('http');
const zlib = require('zlib');


let crypt = null; try { crypt = require('./crypt.js'); } catch (_) {}
let DIR = path.join(os.homedir(), 'ai-gateway');
function setDir(dir) { DIR = dir; }
let upstreamModelsFn = null;
function setUpstreamModels(fn) { upstreamModelsFn = fn; } 
let syncFn = null;
function setSyncFn(fn) { syncFn = fn; } 
function cfgFile(name) {
  return name === 'default' ? path.join(DIR, 'config.json') : path.join(DIR, `config.${name}.json`);
}
function listInstances() {
  const out = [];
  if (fs.existsSync(path.join(DIR, 'config.json'))) out.push('default');
  try {
    for (const f of fs.readdirSync(DIR)) {
      const m = /^config\.(.+)\.json$/.exec(f);
      if (m) out.push(m[1]);
    }
  } catch (_) {}
  return out;
}
function loadCfg(name) {
  const f = cfgFile(name);
  if (!fs.existsSync(f)) return null;
  let raw = fs.readFileSync(f, 'utf8');
  if (crypt && crypt.isEncText(raw)) {
    const pass = crypt.loadPass();
    if (!pass) throw new Error('配置已加密但找不到密钥(.agwkey/AGW_CRYPT_PASS), 可用 node crypt.js test 检查');
    raw = crypt.decryptText(raw, pass);
  }
  return JSON.parse(raw);
}
function saveCfg(name, cfg) {
  let text = JSON.stringify(cfg, null, 2) + '\n';
  if (crypt) { const pass = crypt.loadPass(); if (pass) text = crypt.encryptText(text, pass); } 
  fs.writeFileSync(cfgFile(name), text);
}
function readLog(name, lines) {
  const f = path.join(DIR, 'log', `${name}.log`);
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
  const pf = path.join(DIR, '.run', `${name}.pid`);
  let pid = 0, running = false;
  if (fs.existsSync(pf)) {
    pid = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10) || 0;
    running = pidRunning(pid);
  }
  return { name, pid, running };
}


function runAgw(args) {
  return new Promise(resolve => {
    execFile('bash', [path.join(DIR, 'agw.sh'), ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
    });
  });
}


function scheduleRestart(cfg, name) {
  setTimeout(() => {
    if (name === currentName(cfg)) {
      try {
        const tmpScript = path.join(os.tmpdir() || DIR, '.agw-self-restart.sh');
        const agwPath = path.join(DIR, 'agw.sh');
        fs.writeFileSync(tmpScript, '#!/bin/bash\nsleep 1\nbash "' + agwPath + '" stop ' + name + ' 2>/dev/null\nsleep 1\nbash "' + agwPath + '" start ' + name + ' >> "' + path.join(DIR, 'log', name + '.log') + '" 2>&1\nrm -f "' + tmpScript + '"\n');
        fs.chmodSync(tmpScript, 0o755);
        const cp = exec('setsid bash "' + tmpScript + '" </dev/null >/dev/null 2>&1 &', { stdio: 'ignore' }, () => {});
        try { cp.unref(); } catch (_) {}
      } catch (_) {}
    } else {
      try { runAgw(['restart', name]); } catch (_) {}
    }
  }, 300);
}


function checkAdminAuth(cfg, req, query) {
  const key = cfg.adminKey;
  if (!key) return true; 
  const h = req.headers;
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer === key) return true;
  if (h['x-admin-key'] === key) return true;
  if (query && query.get('adminKey') === key) return true;
  
  const cookie = h.cookie || '';
  if (cookie.includes(`adminKey=${key}`)) return true;
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


function maskedChannels(cfg, reveal) {
  return (cfg.channels || []).map(c => ({
    name: c.name, type: c.type, baseUrl: c.baseUrl,
    proxy: c.proxy || null, models: c.models, modelMap: c.modelMap,
    default: c.default, hasKey: !!(c.apiKey && c.apiKey.length),
    keyPrefix: c.apiKey ? c.apiKey.slice(0, 4) + '***' : '',
    apiKey: reveal ? (c.apiKey || '') : undefined,
  }));
}


function currentName(cfg) {
  if (!cfg._configFile) return 'default';
  const base = path.basename(cfg._configFile, '.json');
  if (base === 'config') return 'default';
  return base.replace(/^config\./, '');
}



function proxyInstance(targetName, adminPath) {
  return new Promise(resolve => {
    const tc = loadCfg(targetName);
    if (!tc) return resolve(null);
    const port = (tc.listen || {}).port || 16384;
    const adminKey = tc.adminKey || '';
    const gwKey = tc.gatewayKey || '';
    const tryAdmin = () => {
      const opts = { host: '127.0.0.1', port, path: '/admin/api/' + adminPath, method: 'GET', timeout: 5000 };
      if (adminKey) opts.headers = { 'x-admin-key': adminKey };
      const r = http.request(opts, resp => {
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
          if (resp.statusCode === 200) { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }
          else if (!adminKey) { tryStatus(); } else { resolve(null); }
        });
      });
      r.on('error', () => { if (!adminKey) tryStatus(); else resolve(null); });
      r.on('timeout', () => { r.destroy(); if (!adminKey) tryStatus(); else resolve(null); });
      r.end();
    };
    const tryStatus = () => {
      const opts = { host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: 5000 };
      if (gwKey) opts.headers = { 'authorization': 'Bearer ' + gwKey };
      const r = http.request(opts, resp => {
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
          if (resp.statusCode === 200) { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }
          else { resolve(null); }
        });
      });
      r.on('error', () => resolve(null));
      r.on('timeout', () => { r.destroy(); resolve(null); });
      r.end();
    };
    tryAdmin();
  });
}



async function handleAdmin(cfg, req, res, u, p, bodyStr) {
  
  if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) {
    return textRes(res, 200, adminHTML(cfg), 'text/html; charset=utf-8');
  }

  
  if (req.method === 'GET' && (p === '/admin/m3' || p === '/admin/m3/')) {
    const f = path.join(DIR, 'm3', 'index.html');
    if (!fs.existsSync(f)) return textRes(res, 404, 'M3 面板未找到, 请把 index.html 放到 ' + path.join(DIR, 'm3'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', 'Access-Control-Allow-Origin': '*' });
    return res.end(fs.readFileSync(f, 'utf8'));
  }
  if (req.method === 'GET' && p === '/admin/m3/app.js') {
    const f = path.join(DIR, 'm3', 'app.js');
    if (!fs.existsSync(f)) return textRes(res, 404, 'app.js 未找到');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', 'Access-Control-Allow-Origin': '*' });
    return res.end(fs.readFileSync(f, 'utf8'));
  }

  
  if (req.method === 'GET' && (p === '/admin/m3/v2' || p === '/admin/m3/v2/')) {
    const f = path.join(DIR, 'm3', 'v2', 'index.html');
    if (!fs.existsSync(f)) return textRes(res, 404, 'M3 v2 面板未找到: ' + f);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', 'Access-Control-Allow-Origin': '*' });
    return res.end(fs.readFileSync(f, 'utf8'));
  }

  
  
  if (req.method === 'GET' && p.startsWith('/admin/m3/')) {
    let rel;
    try { rel = decodeURIComponent(p.slice('/admin/m3/'.length)); } catch (e) { rel = ''; }
    const root = path.join(DIR, 'm3');
    const f = path.join(root, rel);
    if (rel && !rel.includes('\0') && f.startsWith(root + path.sep)
        && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = path.extname(f).toLowerCase();
      const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.map': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
        '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
      let buf = fs.readFileSync(f);
      const hdr = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        
        'Cache-Control': ext === '.html' ? 'no-store, no-cache, must-revalidate' : 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*', 'Vary': 'Accept-Encoding',
      };
      
      if (buf.length > 1024 && ['.js', '.mjs', '.css', '.json', '.map'].includes(ext)
          && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        buf = zlib.gzipSync(buf, { level: 9 });
        hdr['Content-Encoding'] = 'gzip';
      }
      hdr['Content-Length'] = buf.length;
      res.writeHead(200, hdr);
      return res.end(buf);
    }
  }

  
  if (!p.startsWith('/admin/api/')) return null; 

  if (!checkAdminAuth(cfg, req, u.searchParams)) {
    return jsonRes(res, 401, { error: '需要管理密码 (adminKey)' });
  }

  const api = p.slice('/admin/api/'.length);

  
  if (req.method === 'GET' && api === 'instances') {
    const insts = listInstances().map(name => {
      const st = getInstanceStatus(name);
      let port = 0, tlsOn = false, chCount = 0;
      try { const c = loadCfg(name); port = (c.listen || {}).port || 16384; tlsOn = !!(c.tls && c.tls.enable); chCount = (c.channels || []).length; } catch (_) {}
      return { ...st, port, tlsOn, chCount };
    });
    return jsonRes(res, 200, { instances: insts, current: currentName(cfg) });
  }

  
  if (req.method === 'GET' && api.startsWith('config/')) {
    const name = decodeURIComponent(api.slice('config/'.length));
    const reveal = !!(u.searchParams && u.searchParams.get('reveal') === '1');
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    return jsonRes(res, 200, {
      name, port: (c.listen || {}).port || 16384, host: (c.listen || {}).host || '0.0.0.0',
      gatewayKey: reveal ? (c.gatewayKey || '') : (c.gatewayKey ? '(已设)' : ''),
      adminKey: reveal ? (c.adminKey || '') : (c.adminKey ? '(已设)' : ''),
      tls: c.tls || { enable: false },
      redact: c.redact || { enable: true },
      replace: c.replace || { out: [], inc: [] },
      record: c.record || { enable: false, server: '' },
      modelSync: c.modelSync || { enable: true, intervalHours: 24 },
      proxies: c.proxies || {},
      channels: maskedChannels(c, reveal),
    });
  }

  
  if (req.method === 'POST' && api.startsWith('config/')) {
    const name = decodeURIComponent(api.slice('config/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data;
    try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    
    if (data.port != null) { c.listen = c.listen || {}; c.listen.port = Number(data.port); }
    if (data.host != null) { c.listen = c.listen || {}; c.listen.host = data.host; }
    if (data.gatewayKey !== undefined) c.gatewayKey = data.gatewayKey;
    if (data.adminKey !== undefined) c.adminKey = data.adminKey;
    if (data.tls !== undefined) c.tls = data.tls;
    if (data.redact !== undefined && data.redact && typeof data.redact === 'object') c.redact = data.redact;
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
      };
    }
    
    if (data.record !== undefined && data.record && typeof data.record === 'object') {
      c.record = {
        enable: !!data.record.enable,
        server: String(data.record.server || '').trim(),
        maxChars: Number(data.record.maxChars) > 0 ? Number(data.record.maxChars) : 200000,
      };
    }
    if (data.proxies !== undefined) c.proxies = data.proxies;
    if (Array.isArray(data.channels)) {
      
      const oldMap = {};
      for (const ch of (c.channels || [])) oldMap[ch.name] = ch.apiKey;
      c.channels = data.channels.map(ch => {
        const out = { ...ch };
        if (!out.apiKey && oldMap[out.name] !== undefined) out.apiKey = oldMap[out.name];
        if (!out.apiKey) out.apiKey = '';
        return out;
      });
    }
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    jsonRes(res, 200, { ok: true, restarting: true });
    scheduleRestart(cfg, name);
    return;
  }

  
  if (req.method === 'POST' && api.startsWith('instance-create/')) {
    const name = decodeURIComponent(api.slice('instance-create/'.length));
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return jsonRes(res, 400, { error: '实例名只能含字母/数字/中划线/下划线, 最长32字符' });
    if (name === 'default') return jsonRes(res, 400, { error: 'default 是主实例, 请直接编辑' });
    if (fs.existsSync(cfgFile(name))) return jsonRes(res, 409, { error: '实例 ' + name + ' 已存在' });
    let data;
    try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const port = Number(data.port);
    if (!port || port < 1024 || port > 65535) return jsonRes(res, 400, { error: 'HTTP 端口范围 1024-65535' });
    const tls = (data.tls && typeof data.tls === 'object') ? data.tls : { enable: false };
    if (tls.enable) {
      const tport = Number(tls.port);
      if (!tport || tport < 1024 || tport > 65535) return jsonRes(res, 400, { error: 'HTTPS 端口范围 1024-65535' });
      if (!tls.cert || !tls.key) return jsonRes(res, 400, { error: '启用 HTTPS 需要证书路径(tls.cert/tls.key)' });
    }
    const cfg = {
      listen: { port, host: data.host || '0.0.0.0' },
      tls,
      adminKey: typeof data.adminKey === 'string' ? data.adminKey : '',
      gatewayKey: '',
      channels: [], proxies: {}, modelMap: {}, models: [],
      routing: { maxRetry: 2, timeoutSec: 120, cooldownSec: 30 },
    };
    try { saveCfg(name, cfg); } catch (e) { return jsonRes(res, 500, { error: '创建失败: ' + e.message }); }
    return jsonRes(res, 200, { ok: true });
  }

  
  if (req.method === 'POST' && api.startsWith('channel/')) {
    const name = decodeURIComponent(api.slice('channel/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let ch;
    try { ch = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    if (!ch.name) return jsonRes(res, 400, { error: '需要渠道名' });
    
    const existing = (c.channels || []).find(x => x.name === ch.name);
    if (existing && (!ch.apiKey || ch.apiKey.includes('***'))) ch.apiKey = existing.apiKey;
    if (ch.default) { for (const x of (c.channels || [])) x.default = false; }
    c.channels = (c.channels || []).filter(x => x.name !== ch.name);
    if (!ch.apiKey) ch.apiKey = '';
    c.channels.push(ch);
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    jsonRes(res, 200, { ok: true, restarting: true });
    scheduleRestart(cfg, name);
    return;
  }

  
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
      jsonRes(res, 200, { ok: true, restarting: true });
      scheduleRestart(cfg, name);
      return;
    }
    return jsonRes(res, 404, { error: '渠道不存在' });
  }

  
  if (req.method === 'DELETE' && api.startsWith('instance/')) {
    const name = decodeURIComponent(api.slice('instance/'.length));
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return jsonRes(res, 400, { error: '实例名非法' });
    if (name === 'default') return jsonRes(res, 400, { error: 'default 是主实例, 不能删除' });
    if (name === currentName(cfg)) return jsonRes(res, 400, { error: '不能删除承载面板的实例' });
    if (!fs.existsSync(cfgFile(name))) return jsonRes(res, 404, { error: '实例不存在' });
    await runAgw(['stop', name]); 
    try { fs.unlinkSync(cfgFile(name)); } catch (e) { return jsonRes(res, 500, { error: '删除配置失败: ' + e.message }); }
    try { fs.unlinkSync(path.join(DIR, 'log', name + '.log')); } catch (e) {}
    try { fs.unlinkSync(path.join(DIR, '.run', name + '.pid')); } catch (e) {}
    return jsonRes(res, 200, { ok: true });
  }

  
  if (req.method === 'POST' && api === 'sync-models') {
    if (!syncFn) return jsonRes(res, 501, { error: '网关未提供同步能力' });
    try {
      const r = await syncFn();
      return jsonRes(res, 200, Object.assign({ ok: true }, r));
    } catch (e) { return jsonRes(res, 502, { error: e.message }); }
  }

  
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

  
  if (req.method === 'POST' && api.startsWith('action/')) {
    const parts = api.slice('action/'.length).split('/');
    const name = decodeURIComponent(parts[0]);
    const action = parts[1];
    if (!['start', 'stop', 'restart'].includes(action)) return jsonRes(res, 400, { error: '未知操作' });
    
    
    if (name === currentName(cfg) && (action === 'stop' || action === 'restart')) {
      jsonRes(res, 200, { ok: true, output: action + ' ' + name + ' (自我' + (action==='restart'?'重启':'停止') + ', 稍候生效, 请刷新页面)', self: true });
      
      const tmpScript = path.join(os.tmpdir() || DIR, '.agw-self-' + action + '.sh');
      const agwPath = path.join(DIR, 'agw.sh');
      if (action === 'restart') {
        fs.writeFileSync(tmpScript, '#!/bin/bash\nsleep 1\nbash "' + agwPath + '" stop ' + name + ' 2>/dev/null\nsleep 1\nbash "' + agwPath + '" start ' + name + ' >> "' + path.join(DIR, 'log', name + '.log') + '" 2>&1\nrm -f "' + tmpScript + '"\n');
      } else {
        fs.writeFileSync(tmpScript, '#!/bin/bash\nsleep 1\nbash "' + agwPath + '" stop ' + name + ' 2>/dev/null\nrm -f "' + tmpScript + '"\n');
      }
      fs.chmodSync(tmpScript, 0o755);
      
      const cp = exec('setsid bash "' + tmpScript + '" </dev/null >/dev/null 2>&1 &', { stdio: 'ignore' }, () => {});
      try { cp.unref(); } catch (e) {}
      return;
    }
    const r = await runAgw([action, name]);
    return jsonRes(res, 200, { ok: r.ok, output: (r.stdout + r.stderr).trim() });
  }

  
  
  if (req.method === 'POST' && api === 'shutdown-all') {
    jsonRes(res, 200, { ok: true, message: '正在关闭所有实例...' });
    const myPid = process.pid;
    setTimeout(() => {
      for (const name of listInstances()) {
        if (name === currentName(cfg)) continue; 
        try {
          const pid = parseInt(fs.readFileSync(path.join(DIR, '.run', name + '.pid'), 'utf8').trim(), 10);
          if (pid && pid !== myPid) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} }
        } catch (e) {}
      }
      
      setTimeout(() => { try { process.kill(myPid, 'SIGTERM'); } catch (e) {} }, 1000);
    }, 500);
    return;
  }

  
  
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
    const port = (target.listen || {}).port || 16384;
    const gwKey = target.gatewayKey || '';
    const opts = { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (gwKey) opts.headers['authorization'] = 'Bearer ' + gwKey;
    const up = http.request(opts, upRes => {
      res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
      upRes.pipe(res);
    });
    up.on('error', (e) => { try { jsonRes(res, 502, { error: '目标实例不可达(端口 ' + port + '): ' + e.message }); } catch (_) {} });
    up.write(bodyOut);
    up.end();
    return;
  }

  
  if (req.method === 'GET' && api.startsWith('logs/')) {
    const name = decodeURIComponent(api.slice('logs/'.length));
    const lines = parseInt(u.searchParams.get('lines') || '50', 10) || 50;
    return textRes(res, 200, readLog(name, lines), 'text/plain; charset=utf-8');
  }

  
  if (req.method === 'GET' && api === 'stats') {
    const inst = u.searchParams.get('instance') || currentName(cfg);
    if (inst === currentName(cfg)) {
      return jsonRes(res, 200, {
        requests: cfg._stats.requests, errors: cfg._stats.errors,
        byChannel: cfg._stats.byChannel, startedAt: cfg._stats.startedAt,
        uptime: Math.round(process.uptime()),
      });
    }
    const j = await proxyInstance(inst, 'stats');
    if (!j) return jsonRes(res, 404, { error: '无法获取实例 ' + inst + ' 的统计(可能未运行或无adminKey)' });
    const st = j.stats ? j.stats : j;
    return jsonRes(res, 200, { requests: st.requests || 0, errors: st.errors || 0, byChannel: st.byChannel || {}, startedAt: j.startedAt, uptime: j.uptime || 0 });
  }

  
  if (req.method === 'GET' && api.startsWith('requests/')) {
    const inst = decodeURIComponent(api.slice('requests/'.length));
    if (inst === currentName(cfg)) {
      return jsonRes(res, 200, cfg._stats.recent || []);
    }
    const j = await proxyInstance(inst, 'requests/' + inst);
    if (!j) return jsonRes(res, 200, []);
    return jsonRes(res, 200, Array.isArray(j) ? j : (j.recent || []));
  }

  
  if (req.method === 'GET' && api.startsWith('record-body/')) {
    const name = decodeURIComponent(api.slice('record-body/'.length));
    const id = (u.searchParams && u.searchParams.get('id')) || '';
    if (!id) return jsonRes(res, 400, { error: '缺少 id 参数' });
    const f = path.join(DIR, 'log', 'requests-' + name + '.jsonl');
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
const adminKey = new URLSearchParams(location.search).get('adminKey') || (document.cookie.match(/adminKey=([^;]+)/)||[])[1] || '';
const hdr = { 'x-admin-key': adminKey, 'Content-Type': 'application/json' };
let curTab='instances', curInst='\${instName}';

// 如果没密码, 弹框输入并写 cookie
if(!adminKey){
  const input = prompt('请输入管理密码 (adminKey):');
  if(input){
    document.cookie = 'adminKey='+input+';path=/;max-age=86400';
    location.search = '?adminKey='+encodeURIComponent(input);
  } else {
    document.querySelector('.m3').innerHTML='<div class="card"><h2>需要管理密码</h2><p>请在 URL 加 ?adminKey=你的密码</p><p class="muted">或在 config.json 里设 "adminKey"</p></div>';
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
        \${i.tlsOn?'<span class="tls">TLS</span>':''}
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
    html+='<div class="field row"><div class="f"><label>管理密码 (adminKey)</label><input id="ed-adminkey" type="text" value="'+(c.adminKey||'')+'" placeholder="'+(c.adminKey?'(已设,留空不改)':'空=关闭管理面板')+'"></div></div>';
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
  const ak=document.getElementById('ed-adminkey').value;
  if(ak&&!ak.includes('已设'))data.adminKey=ak;
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
    <div class="field"><label>apiKey \${ch.keyPrefix?'('+ch.keyPrefix+', 留空不改)':''}</label><input id="ch-apikey" type="text" value="" placeholder="\${ch.keyPrefix?'留空=保持原key':'粘贴密钥'}"></div>
    <div class="field"><label>代理</label><select id="ch-proxy"><option value="" \${!ch.proxy?'selected':''}>直连</option></select><span class="hint" id="proxy-hint"></span></div>
    <div class="field"><label>模型列表 (逗号分隔, 客户端发啥就用啥)</label><textarea class="models" id="ch-models">\${(ch.models||[]).join(', ')} </textarea>
      <span class="hint">或用 modelMap 改名(下方), 二选一</span></div>
    <div class="field"><label>modelMap (JSON, 统一名→真实名)</label><textarea class="models" id="ch-modelmap">\${ch.modelMap?JSON.stringify(ch.modelMap,null,0):''}</textarea>
      <span class="hint">多源轮询时用这个, 客户端只看到统一名</span></div>
    <div class="field"><label><input type="checkbox" id="ch-default" \${ch.default?'checked':''} style="width:auto;margin-right:6px">设为 default (兜底渠道)</label></div>
    <div class="flex" style="margin-top:16px"><button class="btn" onclick="saveChannel()">保存</button><button class="btn outline" onclick="closeModal()">取消</button></div>\`;
  document.getElementById('modal-bg').classList.add('show');
  // 填充代理选项
  api('GET','config/'+curInst).then(c=>{const sel=document.getElementById('ch-proxy');Object.keys(c.proxies||{}).forEach(p=>{const o=document.createElement('option');o.value=p;o.textContent=p;if(ch.proxy===p)o.selected=true;sel.appendChild(o)})});
}
async function saveChannel(){
  const ch={name:document.getElementById('ch-name').value.trim(),type:document.getElementById('ch-type').value,
    baseUrl:document.getElementById('ch-baseurl').value.trim(),
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
  try{const r=await fetch('/admin/api/logs/'+name+'?lines='+lines+'&adminKey='+adminKey);
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

module.exports = { handleAdmin, checkAdminAuth, setDir, setUpstreamModels, setSyncFn, saveCfg };
