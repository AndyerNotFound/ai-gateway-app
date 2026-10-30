'use strict';
/**
 * ai-gateway plugin manager (phase 1: gateway core)
 * Responsibilities: scan installed plugins / activate each instance's server.js / dispatch /plugins routes / data persistence / scheduled tasks
 * Design in docs/PLUGIN-DESIGN.md. Plugin code is shared globally (plugins/<id>/); data is isolated per instance (plugins-data/<inst>/<id>.json).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const http = require('http');
const https = require('https');

/** Minimal tar extraction (files/dirs only, path-traversal safe). Plugin packages use .tar.gz (zero-dep, cross-platform). */
function untar(tarBuf, destDir) {
  let off = 0;
  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.slice(off, off + 512);
    let name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
if (!name) break; // empty block = end
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = header.slice(156, 157).toString('utf8');
    off += 512;
    const content = tarBuf.slice(off, off + size);
    off += Math.ceil(size / 512) * 512;
    const safe = path.normalize(name).replace(/^([/\\])+/, '').replace(/(\.\.[/\\])+/g, '');
    if (!safe) continue;
    const dest = path.join(destDir, safe);
    if (type === '5') { fs.mkdirSync(dest, { recursive: true }); continue; }
    if (type === '0' || type === '\0' || type === '') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
  }
}

/** Download URL -> Buffer (follows redirects, 30s timeout, 50MB default cap) */
function downloadBuf(url, maxBytes = 50 * 1024 * 1024, redirects = 5) {
  return new Promise((resolve, reject) => {
    let lib;
    try { lib = url.startsWith('https') ? https : http; } catch (e) { return reject(e); }
    const req = lib.get(url, { timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(downloadBuf(new URL(res.headers.location, url).href, maxBytes, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; let len = 0;
      res.on('data', c => { len += c.length; if (len > maxBytes) { req.destroy(); reject(new Error('文件过大(>50MB)')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
  });
}

class PluginManager {
/** @param gwDir ai-gateway root dir; @param logFn logger */
  constructor(gwDir, logFn) {
    this.gwDir = gwDir;
    this.pluginsDir = path.join(gwDir, 'plugins');
    this.dataDir = path.join(gwDir, 'data', 'plugins-data');
    this.log = logFn || ((...a) => console.log('[plugins]', ...a));
    /** installed: id -> {manifest, dir} */
    this.installed = new Map();
    /** active: `${inst}/${id}` -> state */
    this.active = new Map();
    this.ensureDirs();
  }

  ensureDirs() {
    try { fs.mkdirSync(this.pluginsDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch {}
  }

/** Scan the plugins/ directory and register installed plugins (without activating) */
  scanInstalled() {
    this.installed.clear();
    if (!fs.existsSync(this.pluginsDir)) return;
    for (const d of fs.readdirSync(this.pluginsDir)) {
      const pdir = path.join(this.pluginsDir, d);
      const mf = path.join(pdir, 'manifest.json');
      try {
        if (!fs.statSync(pdir).isDirectory() || !fs.existsSync(mf)) continue;
        const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
        if (!manifest.id) manifest.id = d;
        if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) { this.log('插件 id 非法, 跳过:', d); continue; }
        this.installed.set(manifest.id, { manifest, dir: pdir });
      } catch (e) { this.log('插件 manifest 解析失败:', d, e.message); }
    }
  }

/** Activates the plugins enabled in an instance's cfg.plugins. See makeCtx for gatewayApi. */
  activateInstance(instName, cfg, gatewayApi) {
this.deactivateInstance(instName); // hot-reload safety: stop the instance's old set (including disabled ones) before activating the new config
    this.scanInstalled();
    const list = Array.isArray(cfg.plugins) ? cfg.plugins : [];
    for (const pc of list) {
      if (!pc || !pc.enable || !pc.id) continue;
      if (!this.installed.has(pc.id)) { this.log(`[${instName}] 插件未安装:`, pc.id); continue; }
      try { this.activateOne(instName, pc.id, pc, cfg, gatewayApi); }
      catch (e) { this.log(`[${instName}] 插件 ${pc.id} 激活异常:`, e.message); }
    }
  }

  activateOne(instName, pluginId, pluginCfg, cfg, gatewayApi) {
    const key = instName + '/' + pluginId;
this.deactivateByKey(key); // stop before re-activating
    const inst = this.installed.get(pluginId);
    if (!inst) return;
    const { manifest, dir } = inst;
    const state = {
      key, instName, pluginId, manifest, dir,
      routes: new Map(), timers: [],
      data: this.loadData(instName, pluginId),
      dirty: false, cfg: pluginCfg.config || {},
    };
    const saveTimer = setInterval(() => this.flushData(state), 30000);
    if (saveTimer.unref) saveTimer.unref();
    state.timers.push(saveTimer);

    const serverFile = path.join(dir, 'server.js');
    if (manifest.hasServer && fs.existsSync(serverFile)) {
      const ctx = this.makeCtx(state, cfg, gatewayApi);
      state.ctx = ctx;
      try {
delete require.cache[require.resolve(serverFile)]; // a fresh module object per instance
        const mod = require(serverFile);
        state.module = mod;
        if (mod && typeof mod.activate === 'function') mod.activate(ctx);
        this.log(`[${instName}] 插件已激活: ${pluginId} v${manifest.version || '?'} (路由${state.routes.size}条)`);
      } catch (e) {
        this.log(`[${instName}] 插件 ${pluginId} 激活失败:`, e.stack || e.message);
      }
    }
    this.active.set(key, state);
  }

/** ctx factory: every capability a plugin may use */
  makeCtx(state, cfg, gatewayApi) {
    const self = this;
    const perms = new Set(state.manifest.permissions || []);
    return {
      id: state.pluginId,
      instanceName: state.instName,
      config: state.cfg,
/** Registers the endpoint /plugins/<id><path> */
      registerRoute(method, p, handler) {
        if (!p.startsWith('/')) p = '/' + p;
        state.routes.set(method.toUpperCase() + ' ' + p, handler);
      },
/** Plugin-private KV (auto-persisted to plugins-data/<inst>/<id>.json) */
      data: {
        get: k => state.data[k],
        set: (k, v) => { state.data[k] = v; state.dirty = true; },
        del: k => { delete state.data[k]; state.dirty = true; },
        all: () => state.data,
      },
/** Scheduled tasks (cleaned up automatically on disable) */
      cron(ms, fn) {
        const t = setInterval(() => { try { fn(); } catch (e) { self.log(`[${state.pluginId}] cron:`, e.message); } }, ms);
        if (t.unref) t.unref();
        state.timers.push(t);
      },
/** hook (reserved; phase 1 implements beforeRequest/afterResponse registration) */
      hook(name, fn) {
        state.hooks = state.hooks || {};
        (state.hooks[name] = state.hooks[name] || []).push(fn);
      },
/** Gateway capabilities (sensitive items gated by permissions) */
      gateway: {
        instanceName: state.instName,
/** Look up a key record by card token (lets plugins verify the caller's identity) */
        findKey: token => (gatewayApi && gatewayApi.findKey) ? gatewayApi.findKey(token) : null,
/** Add quota to a key card (requires gateway:grantQuota permission) */
        grantQuota: (keyId, tokens) => {
          if (!perms.has('gateway:grantQuota')) { self.log(`[${state.pluginId}] grantQuota 被拒: 未声明权限`); return false; }
          return (gatewayApi && gatewayApi.grantQuota) ? gatewayApi.grantQuota(keyId, tokens) : false;
        },
      },
      log: (...a) => self.log(`[${state.pluginId}]`, ...a),
    };
  }

// ---------- Data persistence ----------
  dataFile(instName, pluginId) {
    const safe = s => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dataDir, safe(instName), safe(pluginId) + '.json');
  }
  loadData(instName, pluginId) {
    const f = this.dataFile(instName, pluginId);
    if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
    return {};
  }
  flushData(state) {
    if (!state || !state.dirty) return;
    try {
      const f = this.dataFile(state.instName, state.pluginId);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(state.data, null, 2));
      state.dirty = false;
    } catch (e) { this.log('插件数据落盘失败:', e.message); }
  }
  flushAll() { for (const [, s] of this.active) this.flushData(s); }

// ---------- Disable ----------
  deactivateByKey(key) {
    const state = this.active.get(key);
    if (!state) return;
    for (const t of state.timers) { try { clearInterval(t); } catch {} }
    this.flushData(state);
    if (state.module && typeof state.module.deactivate === 'function') {
      try { state.module.deactivate(); } catch (e) { this.log(`[${key}] deactivate:`, e.message); }
    }
    this.active.delete(key);
  }
  deactivateInstance(instName) {
    for (const key of [...this.active.keys()]) if (key.startsWith(instName + '/')) this.deactivateByKey(key);
  }

// ---------- Queries ----------
/** Plugin list for one instance (with run status) */
  listForInstance(instName, cfg) {
    this.scanInstalled();
    const cfgMap = new Map((Array.isArray(cfg.plugins) ? cfg.plugins : []).map(p => [p.id, p]));
    const out = [];
    for (const [id, inst] of this.installed) {
      const pc = cfgMap.get(id);
      const running = this.active.has(instName + '/' + id);
      out.push({
        id, name: inst.manifest.name || id, version: inst.manifest.version || '?',
        author: inst.manifest.author || '', description: inst.manifest.description || '',
        icon: inst.manifest.icon || null, hasServer: !!inst.manifest.hasServer,
        hasUserPage: !!inst.manifest.userPage, hasAdminPage: !!inst.manifest.adminPage,
        userPage: inst.manifest.userPage || null, adminPage: inst.manifest.adminPage || null,
        enable: pc ? !!pc.enable : false, running,
        config: pc ? (pc.config || {}) : {},
      });
    }
    return out;
  }
/** Plugins visible to users (enabled + has userPage) */
  userPlugins(instName, cfg) {
    return this.listForInstance(instName, cfg).filter(p => p.enable && p.running && p.hasUserPage)
      .map(p => ({ id: p.id, name: p.name, icon: p.icon, description: p.description, userPage: p.userPage }));
  }

// ---------- Install / uninstall / configure ----------
  /**
   * Installs a plugin package (.tar.gz) from a Buffer. Verify SHA256 (optional) -> extract -> validate manifest -> move to plugins/<id>.
   * Returns {id, manifest}. Errors when the id already exists (uninstall first to update).
   */
  installPackage(buf, expectedSha256) {
// SHA256 check (enforced only when provided)
    const crypto = require('crypto');
    const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
    if (expectedSha256 && actualSha !== String(expectedSha256).toLowerCase()) {
      throw new Error(`SHA256 不匹配! 期望 ${expectedSha256} 实际 ${actualSha} —— 安装已中止(可能被篡改)`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-pkg-'));
    try {
      const tarBuf = zlib.gunzipSync(buf); // .tar.gz
      untar(tarBuf, tmp);
// Locate manifest.json (root dir, or the single first-level subdirectory)
      let root = tmp;
      if (!fs.existsSync(path.join(root, 'manifest.json'))) {
        const subs = fs.readdirSync(tmp).filter(d => fs.statSync(path.join(tmp, d)).isDirectory());
        if (subs.length === 1 && fs.existsSync(path.join(tmp, subs[0], 'manifest.json'))) root = path.join(tmp, subs[0]);
      }
      const mfPath = path.join(root, 'manifest.json');
      if (!fs.existsSync(mfPath)) throw new Error('包内找不到 manifest.json（不是合法的插件包）');
      const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      if (!manifest.id || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) throw new Error('manifest.id 缺失或非法（只能小写字母/数字/连字符）');
      if (manifest.hasServer && !fs.existsSync(path.join(root, 'server.js'))) throw new Error('manifest 声明 hasServer 但缺少 server.js');
      const dest = path.join(this.pluginsDir, manifest.id);
      if (fs.existsSync(dest)) throw new Error(`插件已存在: ${manifest.id}（更新请先卸载旧版）`);
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      fs.renameSync(root, dest);
      this.scanInstalled();
      return { id: manifest.id, manifest, sha256: actualSha };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

/** Download from a URL and install */
  async installFromUrl(url, sha256) {
    const buf = await downloadBuf(url);
    return this.installPackage(buf, sha256);
  }

/** Uninstall a plugin (first disables it on every instance). keepData=true keeps its data */
  removePlugin(pluginId, keepData) {
    for (const key of [...this.active.keys()]) if (key.endsWith('/' + pluginId)) this.deactivateByKey(key);
    const dir = path.join(this.pluginsDir, pluginId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (!keepData) {
      try {
        for (const inst of fs.readdirSync(this.dataDir)) {
          const f = this.dataFile(inst, pluginId);
          if (fs.existsSync(f)) fs.rmSync(f, { force: true });
        }
      } catch {}
    }
    this.scanInstalled();
    return true;
  }

/** Read a plugin's configSchema + current config (lets the admin panel render its settings form) */
  configSchema(instName, pluginId, cfg) {
    const inst = this.installed.get(pluginId);
    if (!inst) return null;
    const pc = (Array.isArray(cfg.plugins) ? cfg.plugins : []).find(p => p.id === pluginId);
    return { schema: inst.manifest.configSchema || [], config: pc ? (pc.config || {}) : {} };
  }

// ---------- HTTP dispatch ----------
/** Handles /plugins[/<id>[/<path...>]]. Called after the main route has resolved the instance cfg. */
  async handle(cfg, req, res, u, p, body) {
    const instName = req._branchName || 'default';
    const segs = p.split('/').filter(Boolean); // ['plugins', ...]
    const json = (code, obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(s);
    };

// GET /plugins -> returns the plugin center page (HTML) to browsers, JSON to API callers
    if (segs.length === 1) {
      if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' });
      const list = this.userPlugins(instName, cfg);
      const accept = String(req.headers.accept || '');
      if (accept.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderPluginIndex(list, instName));
      }
      return json(200, { ok: true, plugins: list });
    }
// GET /plugins/required -> admin-configured recommended plugins (first-login prompt)
    if (segs[1] === 'required') {
      if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' });
      return json(200, { ok: true, required: cfg.requiredPlugins || [] });
    }

    const pluginId = segs[1];
    const subPath = '/' + segs.slice(2).join('/');
    const state = this.active.get(instName + '/' + pluginId);
    if (!state) return json(404, { error: `插件未启用: ${pluginId}` });

// 1) check API routes registered by server.js first
    const handler = state.routes.get(req.method.toUpperCase() + ' ' + subPath);
    if (handler) {
      const params = {
        query: Object.fromEntries(u.searchParams),
        body: tryJson(body),
        rawBody: body,
        headers: req.headers,
// Convenience: fetch the caller's key card (Bearer/x-api-key/?key=)
        token: (() => {
          const a = req.headers.authorization || '';
          if (a.startsWith('Bearer ')) return a.slice(7).trim();
          return req.headers['x-api-key'] || u.searchParams.get('key') || '';
        })(),
      };
      try { await handler(req, res, params); }
      catch (e) { this.log(`[${pluginId}] ${subPath} 处理异常:`, e.stack || e.message); if (!res.headersSent) json(500, { error: '插件内部错误: ' + e.message }); }
      return;
    }

// 2) static pages/assets (pages/ and plugin root files, path-traversal safe)
    const rel = subPath.replace(/^\/+/, '') || state.manifest.userPage || 'index.html';
    const filePath = path.normalize(path.join(state.dir, rel));
    if (!filePath.startsWith(state.dir)) { res.writeHead(403); return res.end('Forbidden'); }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(fs.readFileSync(filePath));
    }
    json(404, { error: `插件路由不存在: ${pluginId}${subPath}` });
  }
}

function tryJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

/** Plugin center page (browser hits /plugins): card grid, click to open a plugin. Instance prefix is derived server-side to avoid relative-path ambiguity. */
function renderPluginIndex(list, instName) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = (instName === 'default' ? '' : '/' + encodeURIComponent(instName)) + '/plugins/';
  const cards = list.map(p => {
    const href = base + p.id + '/' + (p.userPage || 'pages/user.html');
    const icon = p.icon
      ? `<img class="icon" src="${esc(base + p.id + '/' + p.icon)}" alt="">`
      : `<div class="icon emoji">🧩</div>`;
    return `<a class="card" href="${esc(href)}">${icon}<div class="name">${esc(p.name)}</div><div class="desc">${esc(p.description || '')}</div><div class="open">打开 →</div></a>`;
  }).join('\n');
  const empty = `<div class="empty">🧩<br><br>还没有启用的插件<br><span>请管理员在插件管理里安装并启用</span></div>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>插件中心${instName === 'default' ? '' : ' · ' + esc(instName)}</title>
<style>
  *{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#121212;color:#e8eaed;margin:0;padding:20px}
  header{max-width:880px;margin:8px auto 22px;display:flex;align-items:center;gap:12px}
  header h1{font-size:22px;margin:0}
  header .inst{font-size:12px;color:#9aa0a6;background:#1e1e1e;padding:4px 12px;border-radius:20px}
  .grid{max-width:880px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
  .card{background:#1e1e1e;border-radius:20px;padding:22px;text-decoration:none;color:inherit;display:flex;flex-direction:column;transition:.15s;box-shadow:0 2px 10px rgba(0,0,0,.35)}
  .card:hover{background:#262626;transform:translateY(-2px)}
  .icon{font-size:38px;width:56px;height:56px;display:flex;align-items:center;justify-content:center;background:#2a2a2a;border-radius:16px;margin-bottom:14px}
  img.icon{object-fit:cover}
  .name{font-size:17px;font-weight:600;margin-bottom:6px}
  .desc{font-size:13px;color:#9aa0a6;line-height:1.5;flex:1}
  .open{margin-top:14px;font-size:13px;color:#8ab4f8;font-weight:600}
  .empty{max-width:880px;margin:60px auto;text-align:center;color:#9aa0a6;font-size:16px;line-height:2}
  .empty span{font-size:13px;color:#666}
</style></head><body>
<header><h1>🧩 插件中心</h1><span class="inst">${esc(instName)}</span></header>
<div class="grid">${list.length ? cards : empty}</div>
</body></html>`;
}

module.exports = { PluginManager, downloadBuf };
