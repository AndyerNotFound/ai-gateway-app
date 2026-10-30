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
const { logErr, VERSION, log } = require('./util');
const { getAgents } = require('./proxy');

// ================= Upstream request / thinking-chain condensing / balance passthrough =================
/* ================= Upstream request ================= */
function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  if (suffix === '/v1' && /\/v1$/.test(b)) return b;
  if (suffix === '/v1beta' && /\/v1beta$/.test(b)) return b;
  if (suffix.startsWith('/v1beta/') && /\/v1beta$/.test(b)) return b + suffix.slice(7);
  if (suffix.startsWith('/v1/') && /\/v1$/.test(b)) return b + suffix.slice(3);
  return b + suffix;
}

function upstreamRequest(cfg, ch, urlStr, headers, bodyBuf, cb, method, agentsOverride) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const agents = agentsOverride || getAgents(cfg, ch);
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

/* ================= Upstream balance passthrough (balance) =================
 * Target resolution (channel overrides win): ch.balanceUrl (relative paths joined to baseUrl) + ch.balancePath (dot path) + ch.balanceUnit
 *                          when unset, built-in presets are matched by baseUrl/channel name
 * Lookup implementation: reuses upstreamRequest -> channel proxy / insecure / timeouts; auth headers follow the channel type (claude/gemini/openai)
 * Consumers: (1) admin GET /admin/api/balance/:inst/:ch (invoked via admin.js injection, see setBalanceFn)
 *         (2) client GET /v1/dashboard/billing/{credit_grants,subscription} (OpenAI semantics)
 */
const BALANCE_PRESETS = [
  { keys: ['api.deepseek.com', 'deepseek'], url: '/user/balance', path: 'balance_infos.0.total_balance', unit: 'CNY' },
  { keys: ['api.siliconflow.cn', 'siliconflow.cn'], url: '/v1/user/info', path: 'data.balance', unit: 'CNY' },
  { keys: ['api.siliconflow.com', 'siliconflow.com'], url: '/v1/user/info', path: 'data.balance', unit: 'USD' },
  { keys: ['api.openai.com', 'openai.com'], url: '/dashboard/billing/credit_grants', path: 'total_available', unit: 'USD' },
  { keys: ['open.bigmodel.cn', 'bigmodel'], url: '/api/paas/v4/user/info', path: 'data.balance', unit: 'CNY' },
];
function presetForChannel(ch) {
  const base = String(ch.baseUrl || '').toLowerCase();
  const name = String(ch.name || '').toLowerCase();
  return BALANCE_PRESETS.find(p => p.keys.some(k => base.includes(k) || name.includes(k))) || null;
}
//// a channel's balance target: {url, path, unit} -- null when none (not configured and no preset)
function balanceTarget(ch) {
  const p = presetForChannel(ch);
  const url = ch.balanceUrl || (p && p.url);
  const path = ch.balancePath || (p && p.path);
  if (!url || !path) return null;
  return { url: String(url), path: String(path), unit: String(ch.balanceUnit || (p && p.unit) || '') };
}
function balanceAuthHeaders(ch) {
  const t = String(ch.type || '').toLowerCase();
  if (t === 'claude') return { 'x-api-key': ch.apiKey || '', 'anthropic-version': '2023-06-01' };
  if (t === 'gemini') return { 'x-goog-api-key': ch.apiKey || '' };
  return { authorization: 'Bearer ' + (ch.apiKey || '') };
}
function digPath(obj, dotPath) {
  let cur = obj;
/* Support indexed paths like balance_infos[1].total_balance */
  const keys = String(dotPath || '').replace(/\[(\d+)\]/g, '.$1').split('.');
  for (const k of keys) {
    if (cur == null) return undefined;
    if (k === '') continue;
    cur = cur[/^\d+$/.test(k) ? Number(k) : k];
  }
  return cur;
}
function resolveBalanceUrl(ch, t) {
  const raw = String(t.url || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = String(ch.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('渠道 ' + ch.name + ' 未配置 baseUrl, 无法拼接相对余额接口地址: ' + raw);
  return base + (raw.startsWith('/') ? raw : '/' + raw);
}
//// look up a channel balance -> cb({ok, balance, unit, url, status, error, raw?}); never throws (internal errors become a 500-shaped result)
function fetchChannelBalance(cfg, ch, cb) {
  let done = false;
  const fin = (o) => { if (!done) { done = true; cb(o); } };
  try {
    const t = balanceTarget(ch);
    if (!t) return fin({ ok: false, status: 400, error: '该渠道无余额接口预设, 请在渠道配置填 balanceUrl + balancePath(点路径)' });
    let url;
    try { url = resolveBalanceUrl(ch, t); } catch (e) { return fin({ ok: false, status: 400, error: e.message }); }
    try { new URL(url); } catch (e) { return fin({ ok: false, status: 400, error: '余额接口地址无效: ' + url }); }
    const sub = { ...cfg, responseTimeout: Math.max(1000, (Number(cfg.balanceTimeoutSec) || 15) * 1000) };
    upstreamRequest(sub, ch, url, balanceAuthHeaders(ch), null, (err, upRes) => {
      if (err) return fin({ ok: false, status: /timeout/i.test(err.message) ? 504 : 502, error: '余额查询失败: ' + err.message });
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (upRes.statusCode >= 400) return fin({ ok: false, status: 502, upstream: upRes.statusCode, error: '上游返回 ' + upRes.statusCode + ': ' + txt.slice(0, 200) });
        let j; try { j = JSON.parse(txt); } catch (e) { return fin({ ok: false, status: 502, error: '上游响应非 JSON', raw: txt.slice(0, 300) }); }
        const v = digPath(j, t.path);
/* Multi-currency: surfaced when the upstream returns balance_infos (DeepSeek carries both CNY/USD) */
        let amounts;
        if (Array.isArray(j.balance_infos)) {
          const list = j.balance_infos
            .map(b => ({ unit: String((b && b.currency) || ''), value: String((b && b.total_balance) == null ? '' : b.total_balance) }))
            .filter(x => x.value !== '');
          if (list.length > 1) amounts = list;
        }
/* Fallback when the value path misses but the upstream carries balance_infos, so it does not fail outright */
        if (v === undefined && !amounts) return fin({ ok: false, status: 502, error: '余额路径 ' + t.path + ' 在上游响应中不存在', raw: txt.slice(0, 300) });
        fin({
          ok: true,
          balance: v === undefined ? amounts[0].value : v,
          unit: v === undefined ? amounts[0].unit : t.unit,
          url, upstream: upRes.statusCode,
          ...(amounts ? { amounts } : {})
        });
      });
      upRes.on('error', e => fin({ ok: false, status: 502, error: '读取上游响应失败: ' + e.message }));
    }, 'GET');
  } catch (e) {
    fin({ ok: false, status: 500, error: '余额查询异常: ' + e.message });
  }
}
// Client endpoints: a short cache (default 30s) absorbs client polling; only successful results are cached
const _balanceCache = new Map();
function balanceCacheTtl(cfg) {
  const v = Number(cfg.balanceCacheSec);
  return isFinite(v) && v >= 0 ? v : 30;
}
function balanceCacheKey(cfg, ch) {
  const sig = crypto.createHash('sha256').update(String(ch.apiKey || '') + '|' + String(ch.baseUrl || '') + '|' + String(ch.balanceUrl || '')).digest('hex').slice(0, 12);
  return (cfg._name || 'default') + '|' + ch.name + '|' + sig;
}
function fetchBalanceCached(cfg, ch, cb) {
  const ttl = balanceCacheTtl(cfg);
  const key = balanceCacheKey(cfg, ch);
  if (ttl > 0) {
    const hit = _balanceCache.get(key);
    if (hit && Date.now() - hit.at < ttl * 1000) return cb(hit.res, true);
  }
  fetchChannelBalance(cfg, ch, (r) => {
    if (ttl > 0 && r.ok) {
      _balanceCache.set(key, { at: Date.now(), res: r });
      if (_balanceCache.size > 256) { const it = _balanceCache.keys(); for (let i = 0; i < 64; i++) { const k = it.next(); if (k.done) break; _balanceCache.delete(k.value); } }
    }
    cb(r, false);
  });
}
// Client endpoint channel pick: card channels whitelist (filters only when set) -> balance-target channels first -> default first
function balanceChannelList(cfg, uk) {
  const wl = uk && Array.isArray(uk.channels) && uk.channels.length ? uk.channels : null;
  const list = (cfg.channels || []).filter(c => !c._disabled && (!wl || wl.includes(c.name)));
  return { all: list, usable: list.filter(c => !!balanceTarget(c)) };
}
function pickBalanceChannel(cfg, uk) {
  const { all, usable } = balanceChannelList(cfg, uk);
  const pool2 = usable.length ? usable : all;
  return pool2.find(c => c.default) || pool2[0] || null;
}
//// FX: 1 <unit> = ? <base>; the base currency is always 1; unset -> null (excluded from totals)
function balanceFxRate(cfg, unit) {
  const fx = cfg.balanceFx || {};
  const base = fx.base || 'CNY';
  const u = String(unit || '').trim() || base;
  if (u === base) return 1;
  const r = Number((fx.rates || {})[u]);
  return isFinite(r) && r > 0 ? r : null;
}
// Multi-channel aggregation: concurrently query all visible channels (those without a balance endpoint report ok:false, no request) -> convert to base currency and sum
//   channels: [{channel, total_remain, unit, ok, error?, remain_base?, no_rate?}]
//   total_remain = sum of remain_base (only channels with an FX rate); partial = some channel failed/unconfigured; unit = fx.base
function balanceAggregate(cfg, uk, cb) {
  const { all, usable } = balanceChannelList(cfg, uk);
  if (!usable.length) return cb({ ok: false, status: 503, error: '本实例没有可查询余额的渠道(可在渠道配置里填 balanceUrl + balancePath)' });
  const fx = cfg.balanceFx || {};
  const base = fx.base || 'CNY';
  const results = [];
  let left = all.length;
  const done = () => {
    let sum = 0, anyRate = false, partial = false, okCount = 0;
    const noRateUnits = [];
    const channels = all.map((c, i) => {
      const r = results[i];
      if (!r || !r.ok) {
        partial = true;
        return { channel: c.name, ok: false, error: (r && r.error) || '查询失败' };
      }
      okCount++;
      const n = Number(r.balance);
      const v = isFinite(n) ? n : null;
      const unit = r.unit || '';
      const rate = balanceFxRate(cfg, unit);
      const item = { channel: c.name, ok: true, total_remain: v, unit };
      if (v != null && rate != null) {
        const conv = Math.round(v * rate * 10000) / 10000;
        item.remain_base = conv;
        sum += conv; anyRate = true;
      } else if (rate == null) {
        item.no_rate = true; partial = true;
        if (!noRateUnits.includes(unit)) noRateUnits.push(unit);
      }
      return item;
    });
    const total = anyRate ? Math.round(sum * 10000) / 10000 : null;
    log('[balance] 聚合', '渠道=' + all.length, 'ok=' + okCount, 'base=' + base, 'total=' + total, partial ? '(partial)' : '');
    cb({ ok: true, aggregate: true, total_remain: total, unit: base, channels, partial, ok_count: okCount, ...(noRateUnits.length ? { unconverted_units: noRateUnits } : {}) });
  };
  all.forEach((c, i) => {
    if (!balanceTarget(c)) {
      results[i] = { ok: false, error: '该渠道无余额接口预设, 请在渠道配置填 balanceUrl + balancePath(点路径)' };
      if (--left === 0) done();
      return;
    }
    try {
      fetchBalanceCached(cfg, c, (r) => { results[i] = r; if (--left === 0) done(); });
    } catch (e) { results[i] = { ok: false, error: e.message }; if (--left === 0) done(); }
  });
}

/*/* ================= Success-rate probing (probe) =================
 * cfg.probe = { enable:false, intervalMin:10, mode:'models'|'chat' }; channel-level: ch.probe=true
 * mode=models probes for free; mode=chat spends tokens; results in cfg._stats.probe */
function probeOnce(cfg, ch) {
  const st = cfg._stats.probe = cfg._stats.probe || {};
  const rec = st[ch.name] = st[ch.name] || { total: 0, ok: 0, lastAt: '', lastOk: '', lastErr: '' };
  rec.total++;
  rec.lastAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const mode = (cfg.probe && cfg.probe.mode) || 'models';
  const done = (ok_, err) => {
    if (ok_) { rec.ok++; rec.lastOk = rec.lastAt; rec.lastErr = ''; }
    else rec.lastErr = String(err || 'failed').slice(0, 120);
  };
  try {
    if (mode === 'chat') {
      const model = (ch.models && ch.models[0]) || 'default';
      const body = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }));
      upstreamRequest(cfg, ch, joinUrl(ch.baseUrl, '/chat/completions'), {}, body, (err, upRes) => {
        if (err) return done(false, err.message);
        upRes.resume();
        done(upRes.statusCode < 500, 'HTTP ' + upRes.statusCode);
      }, 'POST');
    } else {
      upstreamRequest(cfg, ch, joinUrl(ch.baseUrl, '/models'), {}, null, (err, upRes) => {
        if (err) return done(false, err.message);
        upRes.resume();
        done(upRes.statusCode < 500, 'HTTP ' + upRes.statusCode);
      }, 'GET');
    }
  } catch (e) { done(false, e.message); }
}
function probeRound(cfg) {
  if (!cfg.probe || !cfg.probe.enable || cfg._disabled) return;
  for (const ch of cfg.channels || []) {
    if (!ch.probe) continue;
    try { probeOnce(cfg, ch); } catch (_) {}
  }
}
function setupProbe(cfg) {
  if (cfg._probeTimer) { clearInterval(cfg._probeTimer); cfg._probeTimer = null; }
  if (!cfg.probe || !cfg.probe.enable) return;
  const iv = Math.max(1, Number(cfg.probe.intervalMin) || 10) * 60000;
  cfg._probeTimer = setInterval(() => probeRound(cfg), iv);
  cfg._probeTimer.unref();
// Probe once 20s after boot (no waiting for the first period)
  setTimeout(() => probeRound(cfg), 20000).unref();
  log('[probe] 成功率探测已开启: 间隔', Math.max(1, Number(cfg.probe.intervalMin) || 10), '分钟, 模式', cfg.probe.mode || 'models');
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, joinUrl, upstreamRequest, BALANCE_PRESETS, presetForChannel, balanceTarget, balanceAuthHeaders, digPath, resolveBalanceUrl, fetchChannelBalance, _balanceCache, balanceCacheTtl, balanceCacheKey, fetchBalanceCached, balanceChannelList, pickBalanceChannel, balanceFxRate, balanceAggregate, probeOnce, probeRound, setupProbe };
