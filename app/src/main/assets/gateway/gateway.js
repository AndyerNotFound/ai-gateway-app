#!/usr/bin/env node
/**
 * ai-gateway — 通用 AI 本地网关 (Termux / Node.js, 零依赖)
 *
 * 功能:
 *   - 三种 API 格式入口自动识别: OpenAI Chat Completions / Gemini generateContent / Claude messages
 *   - 上游渠道三种格式: openai / gemini / claude, 任意入格式 × 任意出格式自动互转(请求+响应+流式SSE)
 *   - 同格式直通(请求体原样转发, 仅换模型名/鉴权), 跨格式走转换中枢
 *   - 出站支持 SOCKS5 / HTTP 代理(零依赖手写握手), 可按渠道指定代理或直连
 *   - 多实例: 每实例一份配置文件+端口, 互不干扰
 *   - 本地回环 + 局域网访问(监听地址可配)
 *
 * 用法: node gateway.js [配置文件路径] [端口覆盖]
 *   node gateway.js                      → 用同目录 config.json
 *   node gateway.js config.office.json   → 指定配置
 *   node gateway.js config.json 9000     → 指定配置+临时改端口
 */
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

const VERSION = '1.4.8';

/* ================= 小工具 ================= */
function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log('[' + ts() + ']', ...a); }
function logErr(...a) { console.error('[' + ts() + ']', ...a); }

const { StringDecoder } = require('string_decoder');
/* ★跨分块安全解码（2026-09-18）：多字节字符被 TCP 分块切断时，逐块 toString('utf8') 会解出
 *  U+FFFD 乱码（响应流/请求体都会中招，只取决于分块时机）。用法：const u8 = utf8(); buf += u8(chunk); */
function utf8() { const sd = new StringDecoder('utf8'); return (buf) => sd.write(buf); }

/* ★HTTP 响应头值只能是 Latin-1：渠道名若是中文(如 "Guili公益")，写进
 *  X-AI-Gateway-Channel 会让 res.writeHead() 抛 ERR_INVALID_CHAR；这里原本用
 *  `catch (_) { return; }` 把异常吞了 → 请求既不回客户端也不读上游，永久悬挂
 *  (2026-09-18 在 ai-gateway-core 上实测复现)。统一百分号编码，decodeURIComponent 可还原。 */
function hdrName(s) {
  const t = String(s == null ? '' : s);
  let out = '';
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp <= 0x7e) { out += ch; continue; }
    let b;
    if (cp < 0x800) b = [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
    else if (cp < 0x10000) b = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    else b = [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    for (const x of b) out += '%' + x.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
function randId(prefix) { return prefix + crypto.randomBytes(10).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }

/* ---- 文本替换(用户自定义正则规则, config.replace = {out:[{re,to,ci}],inc:[...]}) ---- */
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
  if (typeof v === 'string') return v.startsWith('data:') ? v : rpApplyText(v, rules); // data:URL 不动(护图片)
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = rpWalk(v[i], rules, depth + 1, skipModel); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (skipModel && k === 'model') continue; // 不动 model 字段, 保护路由
      v[k] = rpWalk(v[k], rules, depth + 1, skipModel);
    }
    return v;
  }
  return v;
}

/* ---- 内置 DSML 工具调用标记清洗(2026-10-15) ----
 * 现象: 部分模型(DeepSeek 与 NVIDIA NIM 上的衍生版等)会在正文里**额外**打印一份工具调用标记文本
 *   <｜DSML｜tool_calls> / <｜DSML｜invoke name="..."> / <｜DSML｜parameter name="...">…</…>
 *   上游同时也给出结构化 tool_calls → 客户端把这段内部标记当正文显示, 思考链与工具调用看着不连贯。
 * 做法: 正文/思考各自独立的极小状态机(按字段隔离 —— 一个字段里没闭合的标记绝不吃掉另一个字段的内容):
 *   ① 未吞吃: 只盯"最后一个还没闭合的 '<'"; 它可能是标记开头 → 暂缓发出(最多 DSML_TAG_MAX 字符),
 *      标签一旦闭合且不含 DSML 就原样吐出 → 普通文本逐字节透传, 无额外缓冲;
 *   ② 见到 DSML 起始标记(…calls> / …invoke …) → 进入吞吃态, 直到配对结束标记(…calls> 优先, …invoke> 兜底);
 *   ③ 吞吃态攒满 DSML_BLOCK_MAX 仍未见结束标记 → 判定"用户就是在讨论这个标记", **原样放回**(fail-open), 绝不吞正文;
 *   ④ 流结束时仍在吞吃态(标记被上游截断) → 丢弃: 内部标记绝不透给用户。
 * 代价: 无标记的普通响应只多一次 indexOf('<'), 零缓冲零延迟。
 */
const DSML_TAG_MAX = 256;      // 单个标签可信的最大长度(超了就当普通文本对待)
const DSML_WS_MAX = 1024;      // "块尾空白"最多暂缓多少字符(超了直接放行)
const DSML_BLOCK_MAX = 65536;  // 一个标记块最多吞吃多少字符(超过即 fail-open 放行)
/* 标记前缀方言(实测三种): ① ｜DSML｜ —— 含 DSML 字样; ② 完全裸写 <invoke …>; ③ 只剩竖线 <｜tool_calls>。
 *   ①② 靠标签名识别; ③ 要求"竖线在关键字之前", 避免把正文里 <div data-k="a|b"> 误判成标记。 */
const DSML_OPEN_CALLS = /<(?![\/])[^>]*DSML[^>]*(?:tool_)?calls>/i;         // ① 以 DSML 为准(防误吞正文)
const DSML_OPEN_CALLS_WEAK = /<(?![\/])[^>]*[｜|][^>]*(?:tool_)?calls>/i;   // ③ 缺 DSML 字样、只剩竖线前缀
const DSML_OPEN_INVOKE = /<(?![\/])(?:[^>]*[｜|][^>]*)?invoke\b[^>]*>/i;
/* ★结束标记/内部标签允许"无 DSML 前缀"的裸写法: 实测 deepseek-v4.1-flash(NIM) 只给外层标签带 ｜DSML｜,
 *   内层是 <invoke name="…"> / <parameter …> / </invoke> / </tool_calls> —— 早期版本按"必须带 DSML"找终止符,
 *   结果永远找不到, 一路吞到流末尾: 内容被删干净了, 却从没构成"块结束", 回填也就无从触发(2026-10-16 实测)。 */
const DSML_CLOSE_CALLS = /<\/(?:[^>]*[｜|][^>]*)?(?:tool_)?calls>/i;
const DSML_CLOSE_INVOKE = /<\/(?:[^>]*[｜|][^>]*)?invoke>/i;
const DSML_ANY_TAG = /<[^>]*DSML[^>]*>/i;
const DSML_BAR_KEY = /<[^>]*[｜|][^>]*(?:calls|invoke|parameter)\b/i;        // ③ 的通用识别(竖线+关键字)
const DSML_BLOCK_TAG = /<\/?(?:[^>]*[｜|][^>]*)?(?:invoke|parameter|tool_calls|calls)\b[^>]*>/i;   // 块内/块尾标签
const DSML_INVOKE_ANY = /<(?![\/])(?:[^>]*[｜|][^>]*)?invoke\b([^>]*)>([^]*?)<\/(?:[^>]*[｜|][^>]*)?invoke>/ig;
const DSML_PARAM_ANY = /<(?![\/])(?:[^>]*[｜|][^>]*)?parameter\b([^>]*)>([^]*?)<\/(?:[^>]*[｜|][^>]*)?parameter>/ig;
const DSML_ATTR_NAME = /name\s*=\s*[\"']([^\"']+)[\"']/i;
const DSML_CALLS_TAG = /<\/?[^>]*[｜|][^>]*(?:tool_)?calls>/ig;
/* 文本态调用 → [{name, arguments}]。值按原样取字符串; 若整段是 JSON 对象/数组则解析为对象
 * (MCP 工具有的期望对象参数)。解析不出来返回 null。 */
function dsmlParseCall(block) {
  if (!block) return null;
  /* ★不再强制要求块内出现 "DSML": 上游变体会写成裸 tag(tool_calls/invoke/parameter), 甚至整块只是 JSON。
   *   只要求"结构上像一次调用"(含 invoke/parameter/tool_calls 标签, 或有 name= 属性), 否则不碰。 */
  const _raw = String(block);
  if (!/<(?![\/])(?:[^>]*[｜|][^>]*)?(?:invoke|function|tool|call|parameter|tool_calls|calls)\b/i.test(_raw)
      && !/name\s*=\s*["']/.test(_raw)) return null;
  const body = String(block).replace(DSML_CALLS_TAG, '');
  const out = [];
  DSML_INVOKE_ANY.lastIndex = 0;
  let m;
  while ((m = DSML_INVOKE_ANY.exec(body))) {
    const nm = DSML_ATTR_NAME.exec(m[1] || '');
    if (!nm) continue;
    const inner = m[2] || '';
    const args = {};
    DSML_PARAM_ANY.lastIndex = 0;
    let p;
    while ((p = DSML_PARAM_ANY.exec(inner))) {
      const pn = DSML_ATTR_NAME.exec(p[1] || '');
      if (!pn) continue;
      let v = String(p[2] == null ? '' : p[2]).trim();
      const t0 = v.charAt(0);
      if (t0 === '{' || t0 === '[') { try { const j = JSON.parse(v); if (j && typeof j === 'object') v = j; } catch (_) {} }
      args[pn[1]] = v;
    }
    out.push({ name: nm[1], arguments: JSON.stringify(args) });
  }
  if (out.length) return out;
  return dsmlParseCallLoose(body);       // ② 宽松兜底: 缺 </invoke> / 自闭合 / 裸 JSON 形态
}
/* ② 宽松兜底 —— 专门对付"结构不完整"的上游变体(小概率出现, 实测会造成整块被丢弃=空白):
 *     a) 模型漏写 </invoke> 或用了自闭合 <invoke name="x"/> → 标准配对正则配不上;
 *     b) <parameter …> 同样可能漏写 </parameter>;
 *     c) 整块其实是 JSON: {"name":"x","arguments":{…}} / [{"name":…}] / {"tool_calls":[…]}
 *   这里不再要求成对闭合: 取块内第一个 invoke/function/tool/call 标签的 name= 当函数名, 其后所有 parameter 归它。 */
function dsmlParseCallLoose(body) {
  const args = dsmlLooseParams(body);
  const nameTag = /<(?![\/])(?:[^>]*[｜|][^>]*)?(?:invoke|function|tool|call)\b([^>]*)>/i.exec(body);
  let name = null;
  if (nameTag) { const nm = DSML_ATTR_NAME.exec(nameTag[1] || ''); if (nm) name = nm[1]; }
  if (name) return [{ name, arguments: JSON.stringify(args || {}) }];
  const jm = /\{[\s\S]*\}/.exec(body);
  if (jm) {
    try {
      let j = JSON.parse(jm[0]);
      if (j && !Array.isArray(j) && j.tool_calls) j = j.tool_calls;
      const arr = Array.isArray(j) ? j : (j && j.name ? [j] : null);
      if (arr && arr.length) {
        const o = [];
        for (const it of arr) {
          if (!it || !it.name) continue;
          const a = it.arguments != null ? it.arguments : (it.parameters != null ? it.parameters : (it.args != null ? it.args : {}));
          o.push({ name: String(it.name), arguments: typeof a === 'string' ? a : JSON.stringify(a || {}) });
        }
        if (o.length) return o;
      }
    } catch (_) {}
  }
  return null;
}
/* 宽松参数扫描: 不要求 </parameter> 闭合 —— 一个 <parameter …> 到下一个 <parameter 或块尾算它的值 */
function dsmlLooseParams(body) {
  const re = /<(?![\/])(?:[^>]*DSML[^>]*)?parameter\b([^>]*)>/ig;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ attrs: m[1] || '', start: m.index + m[0].length });
  if (!marks.length) return null;
  const args = {};
  for (let i = 0; i < marks.length; i++) {
    const pn = DSML_ATTR_NAME.exec(marks[i].attrs);
    if (!pn) continue;
    let end;
    if (i + 1 < marks.length) {
      const k = body.lastIndexOf('<', marks[i + 1].start);
      end = (k > marks[i].start) ? k : marks[i + 1].start;
    } else end = body.length;
    let v = body.slice(marks[i].start, end)
                  .replace(/<\/(?:[^>]*?)(?:parameter|invoke|tool_calls|calls)>/ig, '')
                  .trim();
    const t0 = v.charAt(0);
    if (t0 === '{' || t0 === '[') { try { const j = JSON.parse(v); if (j && typeof j === 'object') v = j; } catch (_) {} }
    args[pn[1]] = v;
  }
  return Object.keys(args).length ? args : null;
}
/* 回填闸: 函数名必须命中客户端本次声明的工具, 否则不回填(防"讨论 DSML 语法"被凭空造出一次调用) */
/* ★留证: 任何"吞掉了标记块却没回填"的情况都写一行到 log/dsml-miss.log
 *   (默认开; AGW_DSML_MISS_LOG=off 可关, 也可指定绝对路径)。写盘失败自动闭嘴, 不影响主流程。 */
let _dsmlMissOff = false;
function dsmlMissPath() {
  try {
    return process.env.AGW_DSML_MISS_LOG || (((typeof __dirname !== 'undefined') ? __dirname : '.') + '/log/dsml-miss.log');
  } catch (_) { return './log/dsml-miss.log'; }
}
function dsmlMissDump(reason, raw, extra) {
  try {
    if (_dsmlMissOff || process.env.AGW_DSML_MISS_LOG === 'off') return;
    const p = dsmlMissPath();
    try { fs.mkdirSync(p.replace(/\/[^\/]*$/, ''), { recursive: true }); } catch (_) {}
    fs.appendFileSync(p, JSON.stringify({
      t: new Date().toISOString(), reason, extra: extra == null ? null : String(extra),
      raw: String(raw == null ? '' : raw)
    }) + '\n');
  } catch (_) { _dsmlMissOff = true; }
}
function dsmlNormName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
/* 回填闸: 函数名优先命中客户端本次声明的工具(防"讨论 DSML 语法"被凭空造出一次调用)。
 *   ★2026-10-16 放宽(实测完全同名会因大小写/命名空间差异漏掉 → 整块静默丢失):
 *     完全同名 → 规范化同名 → 单调用兜底(宁可回填也不静默丢正文); 每次放宽/失败都留证。 */
function dsmlPickCall(calls, toolNames) {
  if (!calls || !calls.length) return null;
  if (!toolNames) return null;                                       // 客户端没声明工具 → 不凭空白造
  if (toolNames.size === 0) { dsmlMissDump('pick-no-declared-tools', calls.map(c => c.name).join(','), null); return null; }
  for (const c of calls) if (c && toolNames.has(c.name)) return c;
  for (const c of calls) {
    if (!c || !c.name) continue;
    const n = dsmlNormName(c.name);
    if (!n) continue;
    for (const t of toolNames) {
      const tn = dsmlNormName(t);
      if (tn && (n === tn || n.endsWith(tn) || tn.endsWith(n))) { dsmlMissDump('pick-normalized', c.name, '→ ' + t); return c; }
    }
  }
  if (calls.length === 1) {                                          // 单调用: 名字没对上, 也回填(否则 = 整块丢失)
    dsmlMissDump('pick-single-fallback', calls[0].name, 'declared=' + [...toolNames].join('|'));
    return calls[0];
  }
  dsmlMissDump('pick-rejected', calls.map(c => c.name).join('|'), 'declared=' + [...toolNames].join('|'));
  return null;
}
const DSML_TEXT_FIELD_RE = /^(content|text)$/;                              // 正文类字段
const DSML_THINK_FIELD_RE = /^(reasoning_content|reasoning|thinking)$/;     // 思考类字段

function dsmlNewState(canCall) { return { eat: null, held: '', pool: '', pend: '', polar: false, warned: false, canCall: !!canCall, call: null, openTag: '' }; }
function dsmlActive(st) { return !!(st && (st.pend || st.held || st.eat)); }
/* 喂一个内容片段 → 返回"现在就能发给客户端"的文本(可能为空: 被吞吃或被暂缓)
 * 状态字段:
 *   eat   非空 = 正在吞吃一个标记块('calls' | 'invoke')
 *   pool  已经吞掉、只为 fail-open 时原样放回的块内文本
 *   held  未闭合的标签尾巴(等后续片段把标签补全)
 *   pend  还没定性的尾巴(空白 [+ 半截结束标记]): 若跟着来的是 "</…calls>" 这种块尾, 就一起丢掉
 *   polar = 刚从"块内"出来且是靠内层结束标记兜底的 —— 此阶段才暂缓空白(等到看清是不是块尾)
 */
function dsmlFeed(st, s, final) {
  if (!st) return s == null ? '' : String(s);
  let out = '';
  let buf = st.pend + st.held + (s == null ? '' : String(s));
  st.pend = ''; st.held = '';
  let pos = 0, polarAt = -1;
  for (;;) {
    if (st.eat) {
      const scoped = buf.slice(pos);
      const prim = st.eat === 'calls' ? DSML_CLOSE_CALLS : DSML_CLOSE_INVOKE;
      let m = prim.exec(scoped), fb = false;
      if (!m && st.eat === 'calls') { m = DSML_CLOSE_INVOKE.exec(scoped); fb = !!m; } // 上游漏了外层结束标记时的兜底
      if (!m) {
        /* ★结束标记也会被上游切成多段(</ + ｜DSML｜ + tool_calls>), 吞吃态里必须留一段尾巴参与拼接 ——
         *   整段丢进 pool 的话结束标记永远拼不出来, 块会吃掉后面整条正文(实测复现)。 */
        const keep = Math.min(scoped.length, DSML_TAG_MAX);
        if (scoped.length > keep) st.pool += scoped.slice(0, scoped.length - keep);
        st.held = scoped.slice(scoped.length - keep);
        if (st.pool.length + st.held.length > DSML_BLOCK_MAX) {   // ③ fail-open: 原样放回, 不吞正文
          dsmlMissDump('oversize-failopen', (st.openTag || '') + st.pool + st.held);
          if (!st.warned) { st.warned = true; try { log('[dsml] 吞吃 ' + (st.pool.length + st.held.length) + ' 字符仍未见结束标记, 判定为正文, 原样放行'); } catch (_) {} }
          out += (st.openTag || '') + st.pool + st.held; st.pool = ''; st.held = ''; st.openTag = ''; st.eat = null;
        }
        break;
      }
      const blockTxt = (st.openTag || '') + st.pool + st.held + scoped.slice(0, m.index + m[0].length);
      if (st.canCall) {                                   // 正文里的标记块 → 先解析(回填要用), 再丢弃
        let cs = null;
        try { cs = dsmlParseCall(blockTxt); } catch (e) { dsmlMissDump('parse-throw', blockTxt, e && e.message); }
        if (cs) st.call = (st.call || []).concat(cs);
        else dsmlMissDump('block-unparsed', blockTxt, fb ? 'closed-by-</invoke>' : null);   // ★不静默丢: 留证
      }
      buf = scoped.slice(m.index + m[0].length);          // 整块(含结束标记)丢弃
      st.pool = ''; st.held = ''; st.openTag = ''; st.eat = null; st.polar = fb; pos = 0;
      if (fb) polarAt = out.length;
      continue;
    }
    let i = buf.indexOf('<', pos);
    const iF = buf.indexOf('＜', pos);
    if (iF >= 0 && (i < 0 || iF < i)) i = iF;    // ★全角左括号也算标签起点(防漏)
    if (i < 0) {
      const t = buf.slice(pos);
      const ws = st.polar ? (/[ \t\r\n]+$/.exec(t) || [''])[0] : '';
      if (ws && ws.length <= DSML_WS_MAX) { out += t.slice(0, t.length - ws.length); st.pend = ws; }
      else out += t;
      break;
    }
    const pre = buf.slice(pos, i);
    const j = buf.indexOf('>', i);
    if (j < 0) {
      const ws = st.polar ? (/[ \t\r\n]+$/.exec(pre) || [''])[0] : '';
      out += ws ? pre.slice(0, pre.length - ws.length) : pre;
      if (buf.length - i > DSML_TAG_MAX) { out += buf.slice(i); break; }   // 长不成标签 → 放行
      st.pend = ws;                                                      // 空白要排在标签前面
      st.held = buf.slice(i);                                            // 未闭合: 暂缓, 等后续片段补全
      break;
    }
    const tag = buf.slice(i, j + 1);
    const isDsml = DSML_ANY_TAG.test(tag) || DSML_BAR_KEY.test(tag) || DSML_BLOCK_TAG.test(tag);   // ★裸的 calls/invoke/parameter 也算标记(宁可误吞, 绝不让标记漏给客户端)
    if (isDsml && tag.charAt(1) === '/') {                 // 孤立的块结束标记 → 连同它前面的空白一起丢
      out += st.polar ? pre.replace(/[ \t\r\n]+$/, '') : pre;
      pos = j + 1;
      continue;
    }
    out += pre;
    if (!isDsml) {
      /* ② 全裸方言(<tool_calls> 连竖线都没有): 按设计不放行开始标记(怕吃掉正文里对格式的讨论), 但留证 */
      if (!st.bareWarn && /^<\/?(?:tool_)?calls>$/i.test(tag)) {
        st.bareWarn = true;
        dsmlMissDump('bare-open-tag-leak', buf.slice(i, i + 240), '无前缀开始标记(疑似②全裸方言)');
      }
      out += tag; pos = j + 1; continue;
    }   // 普通标签(<div>、"a < b") → 原样    // 普通标签(<div>、"a < b>") → 原样
    st.polar = false;
    if (DSML_OPEN_CALLS.test(tag) || DSML_OPEN_CALLS_WEAK.test(tag)) { st.eat = 'calls'; st.pool = ''; st.openTag = tag; pos = j + 1; continue; }
    if (DSML_OPEN_INVOKE.test(tag)) { st.eat = 'invoke'; st.pool = ''; st.openTag = tag; pos = j + 1; continue; }
    pos = j + 1; continue;                                 // 其它孤立的 DSML 标签 → 丢掉
  }
  if (st.polar && polarAt >= 0 && /\S/.test(out.slice(polarAt))) st.polar = false; // 已发出非空白内容 → 不再是"块尾阶段"
  if (final) {
    if (st.eat) {                                          // ④ 流结束时仍在块内(上游截断)
      const tail = (st.openTag || '') + st.pool + st.held;
      let cs = null;                                       // ★截断也别直接丢: 能拼出调用就回填(小概率变体的主要空白来源)
      try { cs = dsmlParseCall(tail); } catch (_) {}
      if (cs) st.call = (st.call || []).concat(cs);
      else if (tail.trim()) dsmlMissDump('truncated-drop', tail, 'len=' + tail.length);
      if (!st.warned) {
        st.warned = true;
        try { log('[dsml] 流结束标记块仍未闭合(上游截断), ' + (cs ? '已尽力回填 ' + cs.length + ' 个调用' : '已丢弃 ' + tail.length + ' 字符')); } catch (_) {}
      }
      st.pool = ''; st.held = ''; st.pend = ''; st.eat = null; st.openTag = '';
    } else {
      const orphan = st.pend + st.held;
      /* ★流结束时释放的"未闭合尾巴"若是标记族(<…calls/invoke/parameter 或含 ｜/|/＜), 绝不能当正文发出去 ——
       *   全角 ’＞’ 会让标签永远"未闭合", 收尾时把 <｜ calls> 原样漏给客户端(2026-10-16 用户实锤)。 */
      if (orphan && /(?:<|＜)[^]{0,80}(?:calls|invoke|parameter)\b|(?:<|＜)[^]{0,40}[｜|＜]/.test(orphan)) {
        dsmlMissDump('orphan-tag-released', orphan, 'hex=' + Buffer.from(orphan, 'utf8').toString('hex').slice(0, 300));
      } else if (orphan) out += orphan;                    // 未闭合的普通尾巴当正文发出(不丢字)
      st.pend = ''; st.held = '';
    }
  }
  return out;
}
/* 清洗后这条流式分块是否已经"什么都不剩"(没有 delta 内容、没有 finish_reason/usage/message) */
function dsmlChunkPayloadEmpty(j) {
  const cs = j && j.choices;
  if (!Array.isArray(cs) || !cs.length) return false;
  if (j.usage != null || j.error != null) return false;
  for (const c of cs) {
    if (!c || typeof c !== 'object') return false;
    if (c.finish_reason) return false;
    if (c.message) return false;
    const d = c.delta;
    if (d && typeof d === 'object' && Object.keys(d).length) return false;
  }
  return true;
}
/* 按字段路径(choices[0].delta.content 这种)各自一个状态机, 清洗响应对象里的正文/思考字段。
 * 只动白名单字段 —— role/id/model/finish_reason/tool 参数一律不碰。返回是否发生过改写。 */
function dsmlCleanRespObj(j, states, final, withReasoning) {
  let changed = false;
  const walk = (v, path, depth) => {
    if (v == null || depth > 8) return;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i], path + '[' + i + ']', depth + 1); return; }
    if (typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      const val = v[k];
      const p = path ? path + '.' + k : k;
      if (typeof val !== 'string') { walk(val, p, depth + 1); continue; }
      const isText = DSML_TEXT_FIELD_RE.test(k);
      const isThink = withReasoning && DSML_THINK_FIELD_RE.test(k);
      if (!isText && !isThink) continue;
      const st = states.get(p);
      if (val.indexOf('<') < 0 && !dsmlActive(st)) continue;   // 快路径: 没 '<' 且状态空闲 → 不建状态、不解析
      const s2 = st || dsmlNewState(isText);
      if (!st) states.set(p, s2);
      const nt = dsmlFeed(s2, val, final);
      if (nt !== val) {
        changed = true;
        /* ★清洗后只剩空白(整条 delta 就是标记 ± 换行) → 字段直接去掉。
         *   留着 content:"" 会让客户端在"思考"和"工具调用"之间多插一段空正文(2026-10-16 实测复现)。 */
        if (nt.trim() === '' && p.indexOf('.delta.') >= 0) delete v[k];
        else v[k] = nt;
      }
    }
  };
  walk(j, '', 0);
  return changed;
}
/* canonical 事件层清洗(跨格式转换路径): 正文/思考各自一个状态机, tool_* 事件原样透传 */
function wrapDsmlClean(writer, cleanText, cleanReasoning, opts) {
  const toolNames = (opts && opts.toolNames) || null;
  const onDiag = (opts && opts.onDiag) || null;
  const stText = cleanText ? dsmlNewState(true) : null;
  const stThink = cleanReasoning ? dsmlNewState(false) : null;
  const stat = { reasoning: 0, content: 0, emptied: 0, blocks: 0, structured: 0, finishIn: null, finishOut: null, backfill: null, dsmlSeen: false, names: [] };
  let pending = null, sawTool = false, diagDone = false;
  const collect = (st) => {
    if (st && st.call) {
      stat.blocks += st.call.length;
      for (const c of st.call) stat.names.push(c.name);
      pending = (pending || []).concat(st.call);
      st.call = null;
    }
  };
  const feed = (st, t) => {
    if (!st) return t == null ? '' : t;
    if ((t == null || t === '') && !dsmlActive(st)) return t == null ? '' : t;
    if (t && t.indexOf('<') < 0 && !dsmlActive(st)) return t;
    return dsmlFeed(st, t, false);
  };
  return {
    onEvent(ev) {
      if (!ev) return;
      if (ev.type === 'text') {
        const raw = ev.t == null ? '' : String(ev.t);
        if (raw && raw.indexOf('DSML') >= 0) stat.dsmlSeen = true;
        const t = feed(stText, ev.t);
        stat.content++;
        if (t !== raw) stat.emptied++;
        collect(stText);
        if (t) writer.onEvent({ type: 'text', t });
        return;
      }
      if (ev.type === 'reasoning') { stat.reasoning++; const t = feed(stThink, ev.t); if (t) writer.onEvent({ type: 'reasoning', t }); return; }
      if (ev.type === 'tool_start' || ev.type === 'tool_delta') { sawTool = true; stat.structured++; writer.onEvent(ev); return; }
      if (ev.type === 'end') {
        const t = stText ? dsmlFeed(stText, '', true) : '';
        collect(stText);
        if (t) writer.onEvent({ type: 'text', t });
        const r = stThink ? dsmlFeed(stThink, '', true) : '';
        if (r) writer.onEvent({ type: 'reasoning', t: r });
        stat.finishIn = ev.finish_reason || 'stop';
        if (pending && toolNames && !sawTool) {                     // ★回填
          const pick = dsmlPickCall(pending, toolNames);
          if (pick) {
            writer.onEvent({ type: 'tool_start', i: 0, id: randId('call_dsml_'), name: pick.name });
            writer.onEvent({ type: 'tool_delta', i: 0, s: pick.arguments });
            if (!ev.finish_reason || ev.finish_reason === 'stop') ev.finish_reason = 'tool_calls';
            stat.backfill = 'no-structured-call→tool_calls';
          } else stat.backfill = 'parsed-call-not-in-declared-tools';
        } else if (sawTool) stat.backfill = 'already-has-structured-call';
        pending = null;
        stat.finishOut = ev.finish_reason || 'stop';
        if (!diagDone) { diagDone = true; if (onDiag) onDiag(stat); }
        writer.onEvent(ev);
        return;
      }
      writer.onEvent(ev);
    },
  };
}
/* 直通路径改写管道(2026-10-15): 同时承载 inc 文本替换与内置 DSML 清洗
 * ★收尾(末行残留 + 状态机残留)全在本管道内做: 上游最后一行没有换行时也不会丢字(旧版先 res.end() 会丢)。
 * ★只在真的需要改写时才重新序列化那一行, 其余行逐字节原样透传。 */
/* ---- DSML 诊断日志(碰一下 <实例目录>/.dsml-diag 才记; 只记"形状", 不记正文) ----
 * 目的: 排查"文本态调用/空分块/回填有没有发生"——记录每轮响应的字段块数、是否见到 DSML、
 * 解析出的函数名、结构化调用数、finish 进出值、是否回填。不写任何正文内容。 */
let dsmlDiagCache = { t: 0, on: false, file: null };
function dsmlDiagOn(cfg) {
  if (Date.now() - dsmlDiagCache.t < 5000) return dsmlDiagCache.on;
  let on = false, file = null;
  try {
    const dir = cfgDirOf(cfg);
    on = fs.existsSync(path.join(dir, '.dsml-diag'));
    file = path.join(dir, 'log', 'dsml-diag.log');
  } catch (_) {}
  dsmlDiagCache = { t: Date.now(), on: on, file: file };
  return on;
}
function dsmlDiag(cfg, rec) {
  try {
    if (!dsmlDiagOn(cfg) || !dsmlDiagCache.file) return;
    fs.mkdirSync(path.dirname(dsmlDiagCache.file), { recursive: true });   // 没有 log 目录时建出来, 否则静默失败
    fs.appendFileSync(dsmlDiagCache.file, JSON.stringify(Object.assign({ t: new Date().toISOString() }, rec)) + '\n');
  } catch (_) {}
}

function makeDirectPipe(res, rpInc, dsmlOn, dsmlThink, isStream, opts) {
  const u8 = utf8();
  const states = new Map();
  const toolNames = (opts && opts.toolNames) || null;   // 客户端本次声明的工具名(回填必须命中它)
  const onDiag = (opts && opts.onDiag) || null;
  let buf = '', lastObj = null, closed = false, pending = null, sawDone = false, ring = [], wireLogged = false;
  const stat = { reasoning: 0, content: 0, emptied: 0, blocks: 0, structured: 0, finishIn: null, finishOut: null, backfill: null, dsmlSeen: false, names: [] };
  const anyActive = () => { for (const st of states.values()) if (dsmlActive(st)) return true; return false; };
  /* 以最后一条分块为模板造一条 tool_calls 分块发出去 */
  const writeEvent = (deltaObj, ci) => {
    try {
      const t = lastObj ? JSON.parse(JSON.stringify(lastObj)) : { object: 'chat.completion.chunk', choices: [] };
      delete t.usage;
      t.choices = [{ index: ci || 0, delta: deltaObj, finish_reason: null }];
      res.write('data: ' + JSON.stringify(t) + '\n\n');
    } catch (_) {}
  };
  const emitCalls = (calls, ci) => {
    for (let k = 0; k < calls.length; k++) {
      const c = calls[k];
      writeEvent({ tool_calls: [{ index: k, id: randId('call_dsml_'), type: 'function', function: { name: c.name, arguments: '' } }] }, ci);
      writeEvent({ tool_calls: [{ index: k, function: { arguments: c.arguments } }] }, ci);
    }
  };
  const collect = () => {
    let out = null;
    for (const st of states.values()) if (st.call) { out = (out || []).concat(st.call); st.call = null; }
    if (out) { stat.blocks += out.length; for (const c of out) stat.names.push(c.name); pending = (pending || []).concat(out); }
  };
  const lineOut = (line) => {
    let out = rpInc.length ? rpApplyText(line, rpInc) : line;
    if (dsmlOn && out.length >= 6 && out.slice(0, 6) === 'data: ') {
      const bodyTxt = out.slice(6);
      if (bodyTxt === '[DONE]') sawDone = true;
      ring.push(bodyTxt); if (ring.length > 12) ring.shift();   // ★留证环: 截断/孤儿标记时把最后几个上游载荷一起落盘
      /* ★线缆采样: 每流第一条带 calls/invoke/parameter 字样的上游载荷原文+hex 落盘 ——
       *   用于抓"客户端能看到的漏网标记"的确切字节(全角括号/特殊前缀等变体), 2026-10-16 */
      if (!wireLogged && bodyTxt.length < 3000 && /calls\b|invoke\b|parameter\b/i.test(bodyTxt)) {
        wireLogged = true;
        dsmlMissDump('wire-chunk-sample', bodyTxt, 'hex=' + Buffer.from(bodyTxt, 'utf8').toString('hex').slice(0, 500));
      }
      /* ★快路径: 只在"可能有标记/需要判断结构化调用"的分块上解析 JSON。
       *   早期版本只认 '<' → 携带 tool_calls/finish_reason 的分块被跳过, 导致
       *   闸门失效(重复回填) + 上游的 finish=stop 先发出去(实测, 2026-10-16)。 */
      if (bodyTxt !== '[DONE]' && (anyActive() || bodyTxt.indexOf('<') >= 0
          || bodyTxt.indexOf('tool_calls') >= 0 || bodyTxt.indexOf('finish_reason') >= 0 || bodyTxt.indexOf('"usage"') >= 0)) {
        const j = safeParse(bodyTxt);
        if (j && typeof j === 'object') {
          lastObj = j;
          let dirty = false;
          try { dirty = dsmlCleanRespObj(j, states, false, dsmlThink); } catch (_) {}
          if (dirty) { stat.emptied++; if (/DSML/i.test(bodyTxt)) stat.dsmlSeen = true; }
          collect();
          const chs = Array.isArray(j.choices) ? j.choices : [];
          for (let ci = 0; ci < chs.length; ci++) {
            const ch = chs[ci] || {};
            const d = ch.delta || {};
            if (d && typeof d === 'object') {
              if ('reasoning_content' in d || 'reasoning' in d) stat.reasoning++;
              if ('content' in d) stat.content++;
            }
            if (Array.isArray(d.tool_calls) && d.tool_calls.length) stat.structured++;
            if (ch.finish_reason) {
              stat.finishIn = ch.finish_reason;
              if (pending && toolNames && !stat.structured) {          // ★回填: 该响应没有结构化调用时才用文本态调用顶替
                const pick = dsmlPickCall(pending, toolNames);
                if (pick) {
                  try { emitCalls([pick], ci); } catch (_) {}
                  if (ch.finish_reason === 'stop') { ch.finish_reason = 'tool_calls'; dirty = true; }
                  stat.backfill = 'no-structured-call→tool_calls';
                } else stat.backfill = 'parsed-call-not-in-declared-tools';
              } else if (stat.structured) stat.backfill = 'already-has-structured-call';
              pending = null;
              stat.finishOut = ch.finish_reason;
            }
          }
          if (dirty) {
            if (dsmlChunkPayloadEmpty(j)) return;                      // 整条分块就是被清掉的标记 → 不发
            out = 'data: ' + JSON.stringify(j);
          }
        }
      }
    }
    try { res.write(out + '\n'); } catch (_) {}
  };
  return {
    push(c) {
      try {
        const s2 = u8(c);
        if (!isStream) { buf += s2; return; }
        buf += s2;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) lineOut(l);
      } catch (e) { logErr('[dsml] 流式改写失败:', e.message); }
    },
    end() {
      if (closed) return; closed = true;
      try {
        let tail = buf; buf = '';
        if (rpInc.length) tail = rpApplyText(tail, rpInc);
        if (dsmlOn && tail) {
          if (isStream) {                                   /* 末行残留(上游没给结尾换行) */
            const bodyTxt = tail.slice(0, 6) === 'data: ' ? tail.slice(6) : null;
            const j = (bodyTxt && bodyTxt !== '[DONE]') ? safeParse(bodyTxt) : undefined;
            if (j && typeof j === 'object') {
              lastObj = j;
              let dirty = false;
              try { dirty = dsmlCleanRespObj(j, states, false, dsmlThink); } catch (_) {}
              collect();
              if (dirty) tail = dsmlChunkPayloadEmpty(j) ? '' : 'data: ' + JSON.stringify(j);
            }
          } else {                                          /* 非流式: 整份 JSON 一次清洗 + 回填 */
            const j = safeParse(tail);
            if (j && typeof j === 'object') {
              lastObj = j;
              let dirty = false;
              try { dirty = dsmlCleanRespObj(j, states, true, dsmlThink); } catch (_) {}
              collect();
              stat.content++;
              const msg = (Array.isArray(j.choices) && j.choices[0] && j.choices[0].message) || null;
              if (msg && pending && toolNames && !(Array.isArray(msg.tool_calls) && msg.tool_calls.length)) {
                const pick = dsmlPickCall(pending, toolNames);
                if (pick) {
                  msg.tool_calls = [{ id: randId('call_dsml_'), type: 'function', function: { name: pick.name, arguments: pick.arguments } }];
                  if (!j.choices[0].finish_reason || j.choices[0].finish_reason === 'stop') j.choices[0].finish_reason = 'tool_calls';
                  stat.finishIn = stat.finishIn || 'stop';
                  stat.finishOut = j.choices[0].finish_reason;
                  stat.backfill = 'no-structured-call→tool_calls';
                  dirty = true;
                }
              }
              pending = null;
              if (dirty) tail = JSON.stringify(j);
            }
          }
        }
        if (tail) { try { res.write(tail); } catch (_) {} }
        if (dsmlOn && isStream) {
          if (pending && toolNames && !stat.structured) {              /* 流末尾没等到 finish 分块 → 补发调用 */
            const pick = dsmlPickCall(pending, toolNames);
            if (pick) {
              try {
                emitCalls([pick], 0);
                const fin = Object.assign({}, lastObj || {});
                delete fin.usage;
                fin.choices = [{ index: 0, delta: {}, finish_reason: 'tool_calls' }];
                res.write('data: ' + JSON.stringify(fin) + '\n\n');
              } catch (_) {}
              stat.backfill = stat.backfill || 'end-of-stream→tool_calls';
              stat.finishOut = stat.finishOut || 'tool_calls';
            }
          }
          pending = null;
          const wasActive = anyActive();                                  /* ★流结束时状态机还挂着(截断/孤儿标记) → 把最后几个上游载荷与 finish_reason 留证 */
          const extra = [];                                            /* 暂缓的未闭合标签补一条 delta, 不丢字 */
          for (const st of states.values()) { const t = dsmlFeed(st, '', true); if (t) extra.push(t); }
          if (wasActive) {
            const fin = (lastObj && lastObj.choices && lastObj.choices[0]) ? lastObj.choices[0].finish_reason : null;
            dsmlMissDump('pipe-final-active', 'finish_reason=' + String(fin) + ' lastObj=' + String(lastObj && JSON.stringify(lastObj)).slice(0, 300) + '\n---lastN---\n' + ring.join('\n'), 'seenDone=' + sawDone);
          }
          if (extra.length && lastObj && Array.isArray(lastObj.choices) && lastObj.choices[0]) {
            for (const t of extra) {
              const tmpl = JSON.parse(JSON.stringify(lastObj));
              tmpl.choices = [{ index: 0, delta: { content: t }, finish_reason: null }];
              try { res.write('data: ' + JSON.stringify(tmpl) + '\n'); } catch (_) {}
            }
          }
        }
        if (onDiag) onDiag(stat);
      } catch (e) { logErr('[dsml] 收尾失败:', e.message); }
      if (isStream && !sawDone) { try { res.write('data: [DONE]\n\n'); } catch (_) {} }   // ★上游断流/被掐时也补 [DONE], 客户端才不把它当"未完成"
      try { res.end(); } catch (_) {}
    },
  };
}

function dsmlExtractCall(t) {  // 非流式/跨格式: 从一段完整文本里抽取文本态调用
  if (typeof t !== 'string' || t.indexOf('DSML') < 0) return null;
  const st = dsmlNewState(true);
  try { dsmlFeed(st, t, true); } catch (_) {}
  return st.call || null;
}
function dsmlCleanText(t) {   // 非流式/跨格式: 一次性清洗一段文本(整段喂入 = final)
  return dsmlFeed(dsmlNewState(), t, true);
}

/* ---- 配置加解密(可选, 由 crypt.js 提供) ---- */
let crypt = null; try { crypt = require('./crypt.js'); } catch (_) {}
let PLUGINS = null; try { PLUGINS = new (require('./plugins.js').PluginManager)(__dirname, (...a) => log(...a)); } catch (e) { logErr('插件管理器初始化失败:', e && e.message); }
const redactCache = require('./redact-cache.js'); // CDC 增量分块缓存: 干净内容只算 hash, 命中跳过正则

/* ---- 隐私过滤: 请求体里的密钥/token 替换为 *** ---- */
const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,            // OpenAI/DeepSeek/Anthropic 风格
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /\bAKIA[0-9A-Z]{16}/g,                  // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g,            // Google
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          // GitLab
  /\bhf_[A-Za-z0-9]{20,}/g,               // HuggingFace
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     // 文本里粘贴的 Bearer 头
];
const REDACT_FIELD_RE = /api[-_]?key|apikey|secret|password|passwd|token|authorization/i;
function redactText(s, extra) {
  return redactCache.redactSmart(s, extra);
}
function redactDeep(v, extra, depth) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') return v.startsWith('data:') ? v : redactText(v, extra); // 跳过 data:URL(图片/音频)
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

/* ================= 配置加载 ================= */
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
  // 字符串: socks5://user:pass@host:port 或 http://host:port
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
  // 卡密列表规整
  cfg.apiKeys = Array.isArray(cfg.apiKeys) ? cfg.apiKeys.filter(k => k && k.key) : [];
  // 用户表规整(账密登录: uid+密码 → 返回该用户的卡密)
  cfg.users = Array.isArray(cfg.users) ? cfg.users.filter(u => u && u.uid && u.passwordHash) : [];
  // 卡密长度(8-128, 默认24; 不含 sk- 前缀)
  cfg.keyLength = Math.min(128, Math.max(8, Number(cfg.keyLength) || 24));
  // 注册开关(默认关; 公网中转站才开)
  cfg.registration = cfg.registration && typeof cfg.registration === 'object' ? cfg.registration : {};
  cfg.registration.enable = !!cfg.registration.enable;
  cfg.registration.defaultQuota = Math.max(0, Number(cfg.registration.defaultQuota) || 0);
  cfg.registration.minPasswordLen = Math.min(64, Math.max(4, Number(cfg.registration.minPasswordLen) || 8));
  // 人机验证: none(默认) | turnstile(Cloudflare免费)
  cfg.registration.captchaProvider = cfg.registration.captchaProvider === 'turnstile' ? 'turnstile' : 'none';
  cfg.registration.captchaSecret = String(cfg.registration.captchaSecret || '');
  cfg.registration.captchaSiteKey = String(cfg.registration.captchaSiteKey || '');
  // 邮箱验证(可选, 默认关): {enable, smtp:{host,port,user,pass,from}}
  cfg.registration.emailVerify = cfg.registration.emailVerify && typeof cfg.registration.emailVerify === 'object' ? cfg.registration.emailVerify : {};
  cfg.registration.emailVerify.enable = !!cfg.registration.emailVerify.enable;
  // 成功率探测规整(默认关闭, 减少token消耗)
  cfg.probe = cfg.probe && typeof cfg.probe === 'object' ? cfg.probe : {};
  cfg.probe.enable = !!cfg.probe.enable;
  cfg.probe.intervalMin = Math.max(1, Number(cfg.probe.intervalMin) || 10);
  if (!cfg.probe.mode) cfg.probe.mode = 'models';
  cfg.modelSync = cfg.modelSync && typeof cfg.modelSync === 'object' ? cfg.modelSync : {};
  cfg.modelSync.enable = cfg.modelSync.enable !== false; // 默认开
  cfg.modelSync.intervalHours = Math.max(1, Number(cfg.modelSync.intervalHours) || 24);
  cfg.maxBodyBytes = Number(cfg.maxBodyBytes || 64 * 1024 * 1024);
  cfg.connectTimeout = Number(cfg.connectTimeout || 15000);
  cfg.responseTimeout = Number(cfg.responseTimeout || 180000);
  // 连接级错误(socket hang up 等)的同渠道重试次数, 默认 2; 0 = 关闭
  if (cfg.connRetry === undefined) cfg.connRetry = 2;
  cfg.cors = cfg.cors !== false;
  // 内置 DSML 工具调用标记清洗(默认开; dsmlClean:false 关闭; dsmlClean.reasoning:false 只清正文不清思考)
  const __dc = (cfg.dsmlClean && typeof cfg.dsmlClean === 'object') ? cfg.dsmlClean : {};
  cfg.dsmlClean = { enable: cfg.dsmlClean === false ? false : __dc.enable !== false, reasoning: __dc.reasoning !== false, backfill: __dc.backfill !== false };
  // TLS 配置解析
  cfg.tls = cfg.tls || (cfg.listen && cfg.listen.tls) || {};
  if (cfg.tls.enable) {
    cfg.tls.cert = String(cfg.tls.cert || 'cert.pem');
    cfg.tls.key = String(cfg.tls.key || 'key.pem');
    cfg.tls.port = cfg.tls.port != null ? Number(cfg.tls.port) : null; // null=与HTTP同端口(纯HTTPS)
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
  // 思考链精简: enable 时拦截推理模型的 reasoning 内容, 精简后再发给客户端(不展示完整思维链)
  // mode: truncate=按段截取开头(零延迟实时) / summarize=用便宜模型逐段总结(有延迟)
  cfg.thinkingSummary = cfg.thinkingSummary && typeof cfg.thinkingSummary === 'object' ? cfg.thinkingSummary : { enable: false };
  cfg.thinkingSummary.enable = !!cfg.thinkingSummary.enable;
  cfg.thinkingSummary.mode = cfg.thinkingSummary.mode === 'summarize' ? 'summarize' : 'truncate';
  cfg.thinkingSummary.maxCharsPerSegment = Math.max(10, Number(cfg.thinkingSummary.maxCharsPerSegment) || 80);
  cfg.thinkingSummary.summarizeBaseUrl = String(cfg.thinkingSummary.summarizeBaseUrl || '').trim(); // OpenAI 兼容端点, 如 https://api.deepseek.com 或 http://127.0.0.1:16392
  cfg.thinkingSummary.summarizeApiKey = String(cfg.thinkingSummary.summarizeApiKey || '').trim();   // 对应 apiKey(指向另一 gateway 实例时填该实例 gatewayKey)
  cfg.thinkingSummary.summarizeModel = String(cfg.thinkingSummary.summarizeModel || '').trim();     // 模型名
  cfg.thinkingSummary.summarizePrompt = String(cfg.thinkingSummary.summarizePrompt || '').trim() || '用一句话中文概括以下思考片段:';
  cfg.thinkingSummary.maxSegments = Math.max(1, Number(cfg.thinkingSummary.maxSegments) || 12);
  // OpenAI 扩展端点: enable=对外启用 /v1/responses 与 /v1/* 兜底透传端点(含 images/embeddings/audio/files/batches/vector_stores 等),
  // 并允许 OpenAI 渠道上游走 Responses API; upstreamResponses=全局默认上游用 /v1/responses(渠道级 useResponses 可覆盖)
  // 2026-10-16: 默认开启(不再需要手动配开关); 显式设 enable:false 可整体关闭
  cfg.openaiExtras = cfg.openaiExtras && typeof cfg.openaiExtras === 'object' ? cfg.openaiExtras : {};
  cfg.openaiExtras.enable = cfg.openaiExtras.enable === undefined ? true : !!cfg.openaiExtras.enable;
  cfg.openaiExtras.upstreamResponses = !!cfg.openaiExtras.upstreamResponses;
  // 余额聚合的汇率口径: cfg.balanceFx = { base:'CNY', rates:{ CNY:1, USD:7.2 } }  (1 <币种> = X <base>)
  // ⚠️ 不内置任何汇率(写死会过期出错数), 未配置 rates[unit] 的币种不计入合计、单独标注 no_rate
  cfg.balanceFx = (cfg.balanceFx && typeof cfg.balanceFx === 'object') ? cfg.balanceFx : {};
  cfg.balanceFx.base = String(cfg.balanceFx.base || 'CNY').trim() || 'CNY';
  cfg.balanceFx.rates = (cfg.balanceFx.rates && typeof cfg.balanceFx.rates === 'object') ? cfg.balanceFx.rates : {};
  if (!(Number(cfg.balanceFx.rates[cfg.balanceFx.base]) > 0)) cfg.balanceFx.rates[cfg.balanceFx.base] = 1;
  return cfg;
}

// 思考链截断(同步, 零延迟): 按行分段, 每段保留开头 maxChars 字; 长行按步长切成多块各取开头
function truncateReasoning(text, maxChars) {
  if (!text) return '';
  const out = [];
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    if (rawLine.length <= maxChars) { out.push(rawLine); continue; }
    const step = maxChars * 2;
    for (let i = 0; i < rawLine.length && out.length < 60; i += step) {
      const c = rawLine.slice(i, i + maxChars);
      out.push(c + (i + maxChars < rawLine.length ? '…' : ''));
    }
  }
  return out.join('\n');
}

// 规整 summarize 端点 URL 为完整 chat completions 路径(支持填 base / 带 /v1 / 完整路径)
function normalizeSummarizeUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v1$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

// 调用一个 OpenAI 兼容端点做单轮文本生成(供 summarize 用); 返回文本或 null
function callUpstreamText(cfg, baseUrl, apiKey, model, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const url = normalizeSummarizeUrl(baseUrl);
    if (!url || !model || !prompt) return resolve(null);
    if (apiKey && !/^[\x09\x20-\x7e]*$/.test(apiKey)) return resolve(null); // 非 ASCII key 拒绝
    const headers = { authorization: 'Bearer ' + (apiKey || '') };
    const bodyBuf = Buffer.from(JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] }));
    const sub = { ...cfg, responseTimeout: Math.min(timeoutMs || 30000, 60000) };
    const tmpCh = { proxy: null, insecure: false }; // 直连, 不走渠道代理
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      upstreamRequest(sub, tmpCh, url, headers, bodyBuf, (err, upRes) => {
        if (err) return finish(null);
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          if (upRes.statusCode >= 400) return finish(null);
          let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return finish(null); }
          try { const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content; finish(typeof c === 'string' ? c : ''); }
          catch (e) { finish(null); }
        });
        upRes.on('error', () => finish(null));
      });
    } catch (e) { finish(null); }
  });
}

// 思考链总结(异步): 按段拆分后用配置的 OpenAI 兼容端点逐段总结成一句, 拼成精简链
async function summarizeReasoningText(reasoning, tsCfg, ch, cfg) {
  if (!reasoning) return '';
  const baseUrl = String(tsCfg.summarizeBaseUrl || '').trim();
  const apiKey = String(tsCfg.summarizeApiKey || '').trim();
  const model = String(tsCfg.summarizeModel || '').trim();
  if (!baseUrl || !model) return truncateReasoning(reasoning, Number(tsCfg.maxCharsPerSegment) || 80); // 未配端点则降级截断
  const segs = reasoning.split('\n').map(s => s.trim()).filter(Boolean);
  // 合并过短的相邻段, 减少调用次数(累计约 200 字一段)
  const merged = [];
  let cur = '';
  for (const s of segs) {
    if ((cur ? cur.length + 1 + s.length : s.length) < 200) cur = cur ? cur + '\n' + s : s;
    else { if (cur) merged.push(cur); cur = s; }
  }
  if (cur) merged.push(cur);
  const list = merged.slice(0, Number(tsCfg.maxSegments) || 12);
  if (!list.length) return '';
  const prompt = String(tsCfg.summarizePrompt || '用一句话中文概括以下思考片段:');
  const results = await Promise.all(list.map(seg =>
    callUpstreamText(cfg, baseUrl, apiKey, model, prompt + '\n\n' + seg, 30000).catch(() => '')
  ));
  return results.filter(Boolean).map(s => '• ' + String(s).trim()).join('\n');
}

// 思考链精简中间件: 包在 makeWriter 产出的 writer 外, 拦截 reasoning 事件
// truncate=实时行缓冲截取(零延迟); summarize=缓冲整段后异步总结(promise chain 串行, end 事件会等总结完)
function wrapThinkingSummary(writer, tsCfg, ch, cfg) {
  if (!tsCfg || !tsCfg.enable) return writer;
  const mode = tsCfg.mode === 'summarize' ? 'summarize' : 'truncate';
  const maxChars = Math.max(10, Number(tsCfg.maxCharsPerSegment) || 80);

  if (mode === 'truncate') {
  // truncate 模式: 实时行缓冲截取(零延迟), 每个输出块之间用双换行分隔
    let lineBuf = '', saw = false, done = false, needSep = false;
    const emit = (t) => { if (needSep) writer.onEvent({ type: 'reasoning', t: '\n\n' }); writer.onEvent({ type: 'reasoning', t }); needSep = true; };
    const emitSeg = (line) => {
      line = line || '';
      if (!line.trim()) return;
      if (line.length <= maxChars) { emit(line); return; }
      const step = maxChars * 2;
      for (let i = 0; i < line.length; i += step) {
        const c = line.slice(i, i + maxChars);
        emit(c + (i + maxChars < line.length ? '…' : ''));
      }
    };
    return {
      onEvent(ev) {
        if (ev.type === 'reasoning') {
          saw = true;
          lineBuf += ev.t;
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop(); // 末行可能不完整, 留缓冲
          for (const ln of lines) emitSeg(ln);
        } else {
          if (saw && !done) { done = true; if (lineBuf) emitSeg(lineBuf); lineBuf = ''; }
          writer.onEvent(ev);
        }
      }
    };
  }

  // summarize 模式: 边收思考边分段总结边流式输出(每段独立 promise, 谁回来谁先 flush)
  // 顺序保证: 所有 reasoning 必须在第一个 text 前 flush——正文到达时若还有总结在飞, hold 住正文等完成(超时10s兜底强制放行, 迟到总结丢弃)
  // 防护: 思考阶段结束后再有 reasoning 不再当思考喂给总结(防正文混入)
  let buf = '', saw = false, closed = false, reasoningClosed = false, textFlushed = false;
  let pending = 0;
  let pendingEnd = null; // pending 为 0 时需发出的 end 事件
  let textQ = null;      // 正文 hold 队列(非 null = 正在等总结)
  const flushEnd = () => { if (pendingEnd && pending === 0) { const e = pendingEnd; pendingEnd = null; closed = true; writer.onEvent(e); } };
  const releaseText = () => {
    if (!textQ) return;
    const q = textQ; textQ = null; textFlushed = true;
    for (const e of q) writer.onEvent(e);
  };
  const dispatch = (seg) => {
    pending++;
    summarizeOneSegment(seg, tsCfg, cfg).then(s => {
      if (s && !closed && !textFlushed) writer.onEvent({ type: 'reasoning', t: s });
    }).catch(() => {}).then(() => {
      pending--;
      if (pending === 0) releaseText();
      flushEnd();
    });
  };
  return {
    onEvent(ev) {
      if (ev.type === 'reasoning') {
        if (reasoningClosed) { if (textQ) textQ.push(ev); else writer.onEvent(ev); return; } // 思考已结束, 后续 reasoning 当正文透传(正文在 hold 则排队保持顺序)
        saw = true;
        buf += ev.t;
        while (buf.length >= 200) { const seg = buf.slice(0, 200); buf = buf.slice(200); dispatch(seg); }
      } else if (ev.type === 'text') {
        // 第一个 text: 思考阶段结束, 剩余尾巴派最后一段总结, 然后 hold 正文等总结齐
        if (saw && buf && !reasoningClosed) { const tail = buf; buf = ''; reasoningClosed = true; dispatch(tail); }
        else if (!saw) reasoningClosed = true;
        if (textQ) { textQ.push(ev); }
        else if (pending > 0 && !textFlushed) {
          textQ = [ev];
          setTimeout(releaseText, 10000); // 超时兜底: 总结模型挂了也最多等 10s
        } else writer.onEvent(ev);
      } else if (ev.type === 'end') {
        // end 可能早于总结到达: 若正文在 hold, end 也排队(必须排在正文后)
        if (textQ) { textQ.push(ev); }
        else { pendingEnd = ev; flushEnd(); }
      } else {
        writer.onEvent(ev);
      }
    }
  };
}

// 流式总结: 单段异步调模型总结, 返回 "• 总结结果\n"; 模型失败/返回空时回退截断(保底不丢思考内容, 不带省略号保持格式统一)
async function summarizeOneSegment(text, tsCfg, cfg) {
  const baseUrl = String(tsCfg.summarizeBaseUrl || '').trim();
  const apiKey = String(tsCfg.summarizeApiKey || '').trim();
  const model = String(tsCfg.summarizeModel || '').trim();
  const maxChars = Math.max(10, Number(tsCfg.maxCharsPerSegment) || 80);
  if (!baseUrl || !model || !text) return null;
  const prompt = String(tsCfg.summarizePrompt || '用一句话中文概括以下思考片段:');
  // 回退: 简单截取开头(单块, 无省略号), 保持 "• " 格式与正常总结一致
  const fallbackText = text.slice(0, maxChars).replace(/\n+/g, ' ').trim();
  const fallback = fallbackText ? '• ' + fallbackText + '\n' : null;
  try {
    const s = await callUpstreamText(cfg, baseUrl, apiKey, model, prompt + '\n\n' + text, 30000);
    if (s && String(s).trim()) return '• ' + String(s).trim() + '\n';
    // 模型返回空 → 回退截断, 不吞思考(记日志方便排查哪些段没总结成功)
    logErr('[thinkingSummary] 模型返回空, 回退截断(' + text.length + '字)');
    return fallback || null;
  } catch (e) {
    logErr('[thinkingSummary] 单段总结失败, 回退截断:', e.message);
    return fallback || null;
  }
}

function loadConfig(file) {
  redactCache.reset(); // 配置可能变了 extra 正则, 隐私过滤缓存必须作废
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
      useResponses: ch.useResponses === undefined ? undefined : !!ch.useResponses,
      probe: !!ch.probe,
      addUsage: ch.addUsage !== false,
      anthropicVersion: ch.anthropicVersion ? String(ch.anthropicVersion) : null,
      // 余额透传(渠道级覆盖内置预设) —— 必须进白名单, 否则运行态拿不到, persistRuntimeCfg 落盘时还会把配置文件里的值抹掉
      balanceUrl: ch.balanceUrl ? String(ch.balanceUrl) : null,
      balancePath: ch.balancePath ? String(ch.balancePath) : null,
      balanceUnit: ch.balanceUnit ? String(ch.balanceUnit) : null,
    });
    const last = cfg.channels[cfg.channels.length - 1];
    if (!/^[\x09\x20-\x7e]*$/.test(last.apiKey)) logErr(`⚠ [config] 渠道 "${last.name}" 的 apiKey 含中文/非ASCII字符(像占位符?), 请求会失败, 请填入真实 Key`);
    if (!last.apiKey) logErr(`⚠ [config] 渠道 "${last.name}" 没有填 apiKey`);
  }
  return cfg;
}

/* ================= 代理连接层 (SOCKS5 / HTTP CONNECT, 零依赖手写) ================= */
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

/** 在裸 socket 上做定长/定界读取(仅握手阶段用, 握手完 detach) */
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

/* ================= Agent 缓存 ================= */
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

// 连接级错误判定: 对端提前断开/连不上等, 发生在收到任何响应之前 → 同渠道重试安全(不会重复计费)
function isConnErr(e) {
  const m = String((e && e.message) || e || '');
  return /socket hang up|ECONNRESET|EPIPE|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENOTFOUND/i.test(m);
}

// 构造一次性 Agent (keepAlive 关闭, 不进缓存): 供同渠道重试用全新连接,
// 避开已被上游悄悄关闭的 keep-alive 尸体 socket; 不 destroy 共享池, 不影响其他在途请求
function makeFreshAgents(cfg, ch) {
  const raw = ch.proxy ? cfg.proxies[ch.proxy] : null;
  const proxy = (raw && typeof raw === 'object' && raw.type) ? raw : (ch.proxy ? normalizeProxy(ch.proxy) : null);
  if (proxy) proxy._timeout = cfg.connectTimeout;
  const o = { keepAlive: false, maxSockets: 4 };
  if (proxy) return { http: new HttpTunnelAgent(proxy, o), https: new HttpsTunnelAgent(proxy, ch.insecure, o) };
  if (ch.insecure) return { http: new http.Agent(o), https: new https.Agent({ ...o, rejectUnauthorized: false }) };
  return { http: new http.Agent(o), https: new https.Agent(o) };
}

/* ================= 入口解析: 客户端格式 → canonical =================
 * canonical request: {
 *   model, stream,
 *   messages: [{ role:'system'|'user'|'assistant'|'tool',
 *                content: string | [{type:'text',text}|{type:'image_url',image_url:{url}}],
 *                name?, tool_call_id?, tool_calls?: [{id,type:'function',function:{name,arguments:string}}] }],
 *   temperature?, top_p?, max_tokens?, stop?, tools?(OpenAI形), tool_choice?(OpenAI形) }
 * canonical resp: { text, reasoning?, tool_calls?, finish_reason:'stop'|'length'|'tool_calls'|'content_filter', usage:{input,output} }
 * canonical 事件: {type:'start',usage?} {type:'text',t} {type:'reasoning',t}
 *                {type:'tool_start',i,id,name} {type:'tool_delta',i,s} {type:'end',finish_reason,usage}
 * ================================================================ */
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
      // thinking / document / server_tool_use 等其余 block 类型忽略
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

/* ================= OpenAI Responses API 转换 ================= */
// 上游 Responses 流式事件解析(响应输出 → canonical 事件)
class ResponsesStreamParser {
  constructor(emit) { this.emit = emit; this.finished = false; this.finishReason = undefined; this.usage = null; this.toolIdx = 0; }
  handle(j) {
    const evs = [];
    switch (j.type) {
      case 'response.output_text.delta':
        if (typeof j.delta === 'string' && j.delta) evs.push({ type: 'text', t: j.delta });
        break;
      case 'response.output_item.added': {
        const item = j.item || {};
        if (item.type === 'function_call') {
          const i = this.toolIdx++;
          evs.push({ type: 'tool_start', i, id: item.id || item.call_id || ('call_' + (item.name || '')), name: item.name || '' });
        }
        break;
      }
      case 'response.function_call_arguments.delta':
        if (typeof j.delta === 'string' && j.delta) evs.push({ type: 'tool_delta', i: Math.max(0, this.toolIdx - 1), s: j.delta });
        break;
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const r = j.response || {};
        const st = String(r.status || j.type.replace('response.', ''));
        if (st === 'incomplete') this.finishReason = 'length';
        else if (st === 'failed') this.finishReason = 'content_filter';
        else this.finishReason = 'stop';
        const u = r.usage || j.usage;
        if (u) this.usage = { input: u.input_tokens || 0, output: u.output_tokens || 0 };
        break;
      }
      default: break;
    }
    for (const e of evs) this.emit(e);
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.emit({ type: 'end', finish_reason: this.finishReason || 'stop', usage: this.usage || { input: 0, output: 0 } });
  }
}

// Responses content 数组 → 通用 content(multi-modal 数组, 纯文本则简化字符串)
function responsesContentToContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
      if (typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    } else if (p.type === 'input_image' && p.image_url) {
      out.push({ type: 'image_url', image_url: typeof p.image_url === 'string' ? { url: p.image_url } : p.image_url });
    } else if (p.type === 'input_file' && (p.file_url || p.filename)) {
      const u = typeof p.file_url === 'string' ? p.file_url : '';
      if (u) out.push({ type: 'image_url', image_url: { url: u } });
    }
  }
  if (!out.length) return '';
  return (out.length === 1 && out[0].type === 'text') ? out[0].text : out;
}

// 客户端 Responses 请求 → canonical (input/instructions → messages)
function responsesToCanonical(body, urlModel) {
  const messages = [];
  const instructions = body.instructions;
  if (typeof instructions === 'string' && instructions) messages.push({ role: 'system', content: instructions });
  else if (Array.isArray(instructions)) {
    const txt = instructions.filter(p => p && typeof p.text === 'string').map(p => p.text).join('');
    if (txt) messages.push({ role: 'system', content: txt });
  }
  const rawInput = typeof body.input === 'string' ? [body.input] : (Array.isArray(body.input) ? body.input : []);
  for (const item of rawInput) {
    if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant', content: '',
        tool_calls: [{ id: item.call_id || item.id || randId('call_'), type: 'function',
          function: { name: item.name || '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments == null ? {} : item.arguments) } }],
      });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output == null ? {} : item.output) });
    } else if (item.type === 'message' || item.role) {
      let role = item.role || 'user';
      if (role === 'developer') role = 'system';
      if (role === 'system' && messages.length && messages[0].role === 'system') {
        messages[0].content = toText(messages[0].content) + '\n' + toText(responsesContentToContent(item.content));
        continue;
      }
      messages.push({ role, content: responsesContentToContent(item.content) });
    }
    // reasoning / 其它类型忽略
  }
  let tools;
  if (Array.isArray(body.tools) && body.tools.length) {
    tools = body.tools.map(t => (t && t.type === 'function') ? {
      type: 'function', function: { name: t.name, description: t.description || '', parameters: (t.parameters && typeof t.parameters === 'object') ? t.parameters : { type: 'object' } },
    } : t);
  }
  let tool_choice;
  if (typeof body.tool_choice === 'string') tool_choice = body.tool_choice;
  else if (body.tool_choice && body.tool_choice.type === 'function' && body.tool_choice.name) tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  return {
    model: body.model || urlModel,
    stream: !!body.stream,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_output_tokens != null ? body.max_output_tokens : body.max_tokens,
    stop: normStop(body.stop),
    tools,
    tool_choice,
  };
}

// canonical → 上游 Responses 请求体 (system → instructions, messages → input items)
function canonicalToResponsesBody(c) {
  const instructions = [];
  const input = [];
  for (const m of (c.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      const t = toText(m.content);
      if (t) instructions.push(t);
    } else if (m.role === 'assistant') {
      const parts = [];
      if (typeof m.content === 'string') { if (m.content) parts.push({ type: 'output_text', text: m.content }); }
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (!p) continue;
          if (p.type === 'text' && typeof p.text === 'string') parts.push({ type: 'output_text', text: p.text });
          else if (p.type === 'image_url' && p.image_url && p.image_url.url) parts.push({ type: 'input_image', image_url: p.image_url.url });
        }
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          input.push({ type: 'function_call', call_id: tc.id || randId('call_'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}' });
        }
      }
      if (parts.length) input.push({ type: 'message', role: 'assistant', content: parts });
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id || '', output: toText(m.content) });
    } else {
      const content = (typeof m.content === 'string') ? m.content : (Array.isArray(m.content) ? m.content.map(p => {
        if (!p) return null;
        if (p.type === 'text' && typeof p.text === 'string') return { type: 'input_text', text: p.text };
        if (p.type === 'image_url' && p.image_url && p.image_url.url) return { type: 'input_image', image_url: p.image_url.url };
        return null;
      }).filter(Boolean) : '');
      input.push({ type: 'message', role: 'user', content: content === '' ? ' ' : content });
    }
  }
  const body = { model: c.model, input: input.length ? input : [' '], stream: !!c.stream };
  if (instructions.length) body.instructions = instructions.join('\n');
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.max_tokens !== undefined) body.max_output_tokens = c.max_tokens;
  if (c.stop && c.stop.length) body.stop = c.stop;
  if (c.tools && c.tools.length) {
    body.tools = c.tools.map(t => (t && t.type === 'function') ? {
      type: 'function', name: t.function.name, description: t.function.description || '',
      parameters: (t.function.parameters && typeof t.function.parameters === 'object') ? t.function.parameters : { type: 'object' },
    } : t);
    if (c.tool_choice) {
      if (c.tool_choice === 'required' || c.tool_choice === 'none' || c.tool_choice === 'auto') body.tool_choice = c.tool_choice;
      else if (c.tool_choice.type === 'function' && c.tool_choice.function) body.tool_choice = { type: 'function', name: c.tool_choice.function.name };
      else body.tool_choice = 'auto';
    }
  }
  return body;
}

/* ================= 出口构建: canonical → 上游格式 ================= */
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
      // 纯文本数组扁平化为字符串(最大兼容 OpenAI 兼容站); 含图片则保留数组
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
    else if (c.tool_choice === 'none') { /* Claude 无 none 语义, 保留 tools 默认 auto */ }
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

/* ================= 上游响应(JSON) → canonical ================= */
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

/* ================= canonical → 客户端格式响应(JSON) ================= */
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

// 上游 Responses 非流式响应 → canonical 响应 (output 数组解析)
function responsesRespToCanonical(j) {
  let text = '';
  const reasoningParts = [];
  const toolCalls = [];
  for (const item of (j.output || [])) {
    if (!item) continue;
    if (item.type === 'message') {
      for (const p of (item.content || [])) {
        if (p && p.type === 'output_text' && typeof p.text === 'string') text += p.text;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.id || item.call_id || randId('call_'), type: 'function', function: { name: item.name || '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments == null ? {} : item.arguments) } });
    } else if (item.type === 'reasoning') {
      const sums = (item.summary || []).filter(s => s && s.type === 'summary_text' && typeof s.text === 'string').map(s => s.text);
      if (sums.length) reasoningParts.push(sums.join('\n'));
    }
  }
  const usage = j.usage || {};
  const st = String(j.status || 'completed');
  let finish = 'stop';
  if (st === 'incomplete') finish = 'length';
  else if (st === 'failed') finish = 'content_filter';
  if (toolCalls.length) finish = 'tool_calls';
  return {
    text,
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: finish,
    usage: { input: usage.input_tokens != null ? usage.input_tokens : 0, output: usage.output_tokens != null ? usage.output_tokens : 0 },
  };
}

// canonical 响应 → 客户端 Responses 非流式响应
function canonicalToResponsesResp(cresp, model) {
  const output = [];
  if (cresp.reasoning) {
    output.push({ type: 'reasoning', id: randId('rs_'), summary: [{ type: 'summary_text', text: cresp.reasoning }] });
  }
  if (cresp.tool_calls && cresp.tool_calls.length) {
    for (const tc of cresp.tool_calls) {
      output.push({ type: 'function_call', id: randId('fc_'), call_id: tc.id || randId('call_'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}', status: 'completed' });
    }
  }
  const content = cresp.text !== '' ? [{ type: 'output_text', text: cresp.text, annotations: [] }] : [];
  output.push({ type: 'message', id: randId('msg_'), status: 'completed', role: 'assistant', content });
  const finStatus = (cresp.finish_reason === 'length' || cresp.finish_reason === 'content_filter') ? 'incomplete' : 'completed';
  return {
    id: randId('resp_'), object: 'response', created_at: nowSec(), status: finStatus, model, output,
    incomplete_details: cresp.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null,
    instructions: null, metadata: {}, parallel_tool_calls: true,
    usage: { input_tokens: cresp.usage.input, output_tokens: cresp.usage.output, total_tokens: cresp.usage.input + cresp.usage.output },
    error: null,
  };
}

/* ================= SSE 解码 + 上游流 → canonical 事件 ================= */
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
      // message_stop / ping / error: end 统一在 finish() 发
    } else { // gemini
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

/* ================= canonical 事件 → 客户端流式写出 ================= */
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

  // gemini: alt=sse 时 SSE 格式, 否则 JSON 数组分块流
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

/* ================= canonical 事件 → 客户端 Responses 流式 SSE ================= */
function makeResponsesWriter(res, model) {
  const respId = randId('resp_');
  const msgId = randId('msg_');
  const created = nowSec();
  let started = false, nextOutIdx = 0, msgOutIdx = null, msgText = '';
  let curReasoning = null, curTool = null;
  const outputArr = [];
  const usage = { input: 0, output: 0 };
  const baseResp = (status) => ({ id: respId, object: 'response', created_at: created, status: status || 'in_progress', model, output: [], incomplete_details: null, instructions: null, metadata: {}, parallel_tool_calls: true, temperature: null, top_p: null, max_output_tokens: null, tools: [], tool_choice: 'auto', usage: null, error: null });
  const ensureStart = () => {
    if (started) return;
    started = true;
    sseData(res, { type: 'response.created', response: baseResp('in_progress') });
    sseData(res, { type: 'response.in_progress', response: baseResp('in_progress') });
  };
  const ensureMsg = () => {
    if (msgOutIdx != null) return;
    msgOutIdx = nextOutIdx++;
    sseData(res, { type: 'response.output_item.added', output_index: msgOutIdx, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    sseData(res, { type: 'response.content_part.added', item_id: msgId, output_index: msgOutIdx, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  };
  const finishItems = () => {
    if (msgOutIdx != null) {
      const part = { type: 'output_text', text: msgText, annotations: [] };
      sseData(res, { type: 'response.output_text.done', item_id: msgId, output_index: msgOutIdx, content_index: 0, part });
      sseData(res, { type: 'response.content_part.done', item_id: msgId, output_index: msgOutIdx, content_index: 0, part });
      sseData(res, { type: 'response.output_item.done', output_index: msgOutIdx, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: msgText !== '' ? [part] : [] } });
      outputArr.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: msgText !== '' ? [part] : [] });
      msgOutIdx = null;
    }
    if (curReasoning) {
      const part = { type: 'summary_text', text: curReasoning.text };
      sseData(res, { type: 'response.reasoning_summary_text.done', item_id: curReasoning.id, output_index: curReasoning.outIdx, part });
      sseData(res, { type: 'response.output_item.done', output_index: curReasoning.outIdx, item: { id: curReasoning.id, type: 'reasoning', status: 'completed', summary: curReasoning.text ? [part] : [] } });
      outputArr.push({ id: curReasoning.id, type: 'reasoning', status: 'completed', summary: curReasoning.text ? [part] : [] });
      curReasoning = null;
    }
    if (curTool) {
      sseData(res, { type: 'response.output_item.done', output_index: curTool.outIdx, item: { id: curTool.id, type: 'function_call', status: 'completed', call_id: curTool.callId, name: curTool.name, arguments: curTool.args } });
      outputArr.push({ id: curTool.id, type: 'function_call', status: 'completed', call_id: curTool.callId, name: curTool.name, arguments: curTool.args });
      curTool = null;
    }
  };
  return {
    onEvent(ev) {
      if (ev.type === 'text') {
        ensureStart(); ensureMsg(); msgText += ev.t;
        sseData(res, { type: 'response.output_text.delta', item_id: msgId, output_index: msgOutIdx, content_index: 0, delta: ev.t });
      } else if (ev.type === 'reasoning') {
        ensureStart();
        if (!curReasoning) {
          curReasoning = { id: randId('rs_'), outIdx: nextOutIdx++, text: '' };
          sseData(res, { type: 'response.output_item.added', output_index: curReasoning.outIdx, item: { id: curReasoning.id, type: 'reasoning', status: 'in_progress', summary: [] } });
        }
        curReasoning.text += ev.t;
        sseData(res, { type: 'response.reasoning_summary_text.delta', item_id: curReasoning.id, output_index: curReasoning.outIdx, delta: ev.t });
      } else if (ev.type === 'tool_start') {
        ensureStart();
        curTool = { id: randId('fc_'), callId: ev.id || randId('call_'), name: ev.name || '', outIdx: nextOutIdx++, args: '' };
        sseData(res, { type: 'response.output_item.added', output_index: curTool.outIdx, item: { id: curTool.id, type: 'function_call', status: 'in_progress', call_id: curTool.callId, name: curTool.name, arguments: '' } });
      } else if (ev.type === 'tool_delta') {
        if (curTool && curTool.outIdx != null) {
          curTool.args += ev.s;
          sseData(res, { type: 'response.function_call_arguments.delta', item_id: curTool.id, output_index: curTool.outIdx, delta: ev.s });
        }
      } else if (ev.type === 'end') {
        ensureStart();
        finishItems();
        const u = ev.usage || { input: 0, output: 0 };
        usage.input = u.input || 0; usage.output = u.output || 0;
        const finStatus = ev.finish_reason === 'length' ? 'incomplete' : (ev.finish_reason === 'content_filter' ? 'failed' : 'completed');
        const full = baseResp(finStatus);
        full.output = outputArr;
        full.incomplete_details = finStatus === 'incomplete' ? { reason: 'max_output_tokens' } : null;
        full.usage = { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output };
        if (finStatus === 'failed') full.error = { code: 'server_error', message: 'upstream finished with content_filter' };
        sseData(res, { type: 'response.' + finStatus, response: full });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  };
}

/* ================= 渠道路由 / 鉴权 / 错误 / 模型列表 ================= */

// 收集所有匹配该 model 的候选渠道, 按 round-robin 计数器旋转起始位置
// 返回 [{ ch, upstreamModel }, ...] (已旋转, 第一个该本轮使用)
function pickChannels(cfg, model) {
  const chs = cfg.channels || [];
  const candidates = [];
  if (model) {
    // 1) modelMap 精确命中
    for (const ch of chs) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
      }
    }
    // 2) models 列表命中 (避免和 modelMap 重复加入同一渠道)
    if (!candidates.length) {
      for (const ch of chs) {
        if (ch.models && ch.models.includes(model)) candidates.push({ ch, upstreamModel: model });
      }
    }
  }
  // 3) 没有任何精确命中 → 用 default 渠道 (可多个) 或全部渠道兜底
  if (!candidates.length) {
    const defs = chs.filter(c => c.default);
    const pool = defs.length ? defs : chs;
    for (const ch of pool) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
  // round-robin: 用 model 做 key 的计数器决定起始偏移
  if (!cfg._rr) cfg._rr = {};
  const key = model || '__nomodel__';
  cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
  const rot = cfg._rr[key];
  return candidates.slice(rot).concat(candidates.slice(0, rot));
}

// 向后兼容: 返回第一个候选
function pickChannel(cfg, model) {
  const cs = pickChannels(cfg, model);
  return cs.length ? cs[0] : null;
}

/* ---- 小工具: 收集 JSON body ---- */
function collectJson(req, res, cb) {
  let body = '';
  const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
  req.on('data', c => { body += u8(c); if (body.length > 262144) req.destroy(); });
  req.on('end', () => { let j; try { j = JSON.parse(body || '{}'); } catch (_) { return sendError('openai', res, 400, 'bad json'); } cb(j); });
  req.on('error', () => {});
}
// 卡密可访问的实例分支列表(空=全部)
function availableBranches(cfg, userKey) {
  const all = CUR_POOL ? [...CUR_POOL.instances.keys()].filter(n => { const c = CUR_POOL.instances.get(n); return c && !c._disabled; }) : [cfg._name || 'default'];
  if (!userKey) return all; // 管理员/免密: 全部
  const b = userKey.branches || [];
  return b.length ? all.filter(n => b.includes(n)) : all;
}

/* ---- 卡密生成(长度可配 8-128, 字符集 base64url) ---- */
function genApiKey(len) {
  const n = Math.min(128, Math.max(8, Number(len) || 24));
  const bytes = Math.ceil(n * 3 / 4) + 2;
  return 'sk-' + crypto.randomBytes(bytes).toString('base64url').slice(0, n);
}

/* ---- 运行时配置落盘(剔除 _ 开头的运行时字段, 复用 admin.saveCfg) ---- */
function persistRuntimeCfg(cfg) {
  try {
    const clean = JSON.parse(JSON.stringify(cfg, (k, v) => (k && k[0] === '_') ? undefined : v));
    admin.saveCfg(cfg._name || 'default', clean);
  } catch (e) { logErr('[persist] 配置落盘失败:', e.message); }
}

/* ---- 用户密码(scrypt) ---- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const h = crypto.scryptSync(String(pw), salt, 32);
  return 'scrypt:' + salt + ':' + h.toString('base64url');
}
function verifyPassword(pw, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt:')) return false;
    const [, salt, h] = stored.split(':');
    const calc = crypto.scryptSync(String(pw), salt, 32);
    return crypto.timingSafeEqual(calc, Buffer.from(h, 'base64url'));
  } catch (_) { return false; }
}
// 卡密余额 JSON(/credits 响应 + login 复用)
function keyCreditsJSON(uk) {
  const quota = Number(uk.quotaTokens) || 0;
  const used = Number(uk.usedTokens) || 0;
  return {
    name: uk.name || '', uid: uk.uid || '',
    quotaTokens: quota, usedTokens: used,
    remainingTokens: quota > 0 ? Math.max(0, quota - used) : null,
    unlimited: quota <= 0,
    expiresAt: uk.expiresAt || '',
    models: uk.models || [],
  };
}

// 认证: 返回 {ok, admin, userKey, status, error}
//  - admin=true: gatewayKey 匹配(或无密钥配置的免密模式)
//  - userKey: 命中 apiKeys 卡密(限额/过期/禁用/模型白名单在此校验)
function checkAuth(cfg, req, query) {
  const h = req.headers;
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const presented = bearer || h['x-api-key'] || h['x-goog-api-key'] || (query && query.get('key')) || '';
  if (cfg.gatewayKey && presented && presented === cfg.gatewayKey) return { ok: true, admin: true };
  const keys = cfg.apiKeys || [];
  if (keys.length && presented) {
    const uk = keys.find(k => k.key && k.key === presented);
    if (uk) {
      if (uk.enable === false) return { ok: false, status: 401, error: 'key 已禁用' };
      if (uk.expiresAt) {
        const t = new Date(uk.expiresAt).getTime();
        if (!isNaN(t) && t < Date.now()) return { ok: false, status: 401, error: 'key 已过期 (' + uk.expiresAt + ')' };
      }
      if (uk.quotaTokens > 0 && (uk.usedTokens || 0) >= uk.quotaTokens)
        return { ok: false, status: 429, error: '额度已用尽 (' + (uk.usedTokens || 0) + '/' + uk.quotaTokens + ' tokens)' };
      return { ok: true, userKey: uk };
    }
  }
  // 无 gatewayKey 且无卡密 = 免密(向后兼容)
  if (!cfg.gatewayKey && !keys.length) return { ok: true, admin: true };
  return { ok: false, status: 401, error: 'invalid key' };
}

/* ---- 卡密用量持久化(log/keyusage-<实例>.json, 30s 脏检查落盘) ---- */
function cfgDirOf(cfg) { return cfg._configFile ? path.dirname(cfg._configFile) : process.cwd(); }
function keyUsageFile(cfg) { return path.join(cfgDirOf(cfg), 'log', 'keyusage-' + (cfg._name || 'default') + '.json'); }
function loadKeyUsage(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(keyUsageFile(cfg), 'utf8'));
    for (const k of (cfg.apiKeys || [])) {
      const rec = j[k.key];
      if (rec && typeof rec.usedTokens === 'number') k.usedTokens = rec.usedTokens;
    }
  } catch (_) {}
}
function saveKeyUsage(cfg) {
  if (!(cfg.apiKeys || []).length) return;
  const j = {};
  for (const k of cfg.apiKeys) j[k.key] = { usedTokens: k.usedTokens || 0, name: k.name || '' };
  try { fs.mkdirSync(path.dirname(keyUsageFile(cfg)), { recursive: true }); fs.writeFileSync(keyUsageFile(cfg), JSON.stringify(j, null, 1)); } catch (_) {}
}
// 30 秒脏检查落盘(所有实例)
setInterval(() => {
  const cfgs = CUR_POOL ? [...CUR_POOL.instances.values()] : (CUR_CFG ? [CUR_CFG] : []);
  for (const c of cfgs) if (c._keyUsageDirty) { c._keyUsageDirty = false; saveKeyUsage(c); }
}, 30000).unref();

/* ---- 插件 gatewayApi 工厂: 给插件暴露受限的网关能力 ---- */
function makeGatewayApi(cfg) {
  return {
    // 按卡密 token 查 key 记录（插件校验调用者身份用）
    findKey: (token) => (cfg.apiKeys || []).find(k => k && k.key && k.key === token) || null,
    // 给卡密加额度: 用减用量的方式实现(走 keyusage 落盘, 无需动 config)
    grantQuota: (keyId, tokens) => {
      const k = (cfg.apiKeys || []).find(x => x && x.key === keyId);
      if (!k || !(tokens > 0)) return false;
      k.usedTokens = Math.max(0, (k.usedTokens || 0) - tokens);
      cfg._keyUsageDirty = true;
      return true;
    },
  };
}

let CUR_CFG = null;
function corsHeaders() {
  if (!CUR_CFG || !CUR_CFG.cors) return {};
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
}

function jsonErr(res, e) {
  try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e && e.message) || String(e) })); } catch (_) {}
}

function sendJson(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
    res.end(JSON.stringify(obj));
  } catch (_) { try { res.end(); } catch (_) {} }
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
  // openai 与 claude 字段合并, 两边 SDK 都能读
  return { object: 'list', data: ms.map(m => ({ id: m, object: 'model', type: 'model', created: 1700000000, owned_by: 'ai-gateway', display_name: m })) };
}

/* ================= 上游请求 ================= */
function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
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

/* ================= 上游余额透传(balance) =================
 * 目标解析(渠道级覆盖优先): ch.balanceUrl(相对路径按 baseUrl 拼接) + ch.balancePath(点路径) + ch.balanceUnit
 *                          未配则按 baseUrl/渠道名 命中内置预设
 * 查询实现: 复用 upstreamRequest → 走渠道 proxy / insecure / 超时; 认证头按渠道类型(claude/gemini/openai)
 * 使用方: ① 管理端 GET /admin/api/balance/:inst/:ch (admin.js 注入调用, 见 setBalanceFn)
 *         ② 客户端 GET /v1/dashboard/billing/{credit_grants,subscription} (OpenAI 语义)
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
// 渠道的余额目标: {url, path, unit} — 无(未配且无预设) 返回 null
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
  for (const k of String(dotPath || '').split('.')) {
    if (cur == null) return undefined;
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
// 查渠道余额 → cb({ok, balance, unit, url, status, error, raw?}); 永不抛(内部异常转 500 结果)
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
        if (v === undefined) return fin({ ok: false, status: 502, error: '余额路径 ' + t.path + ' 在上游响应中不存在', raw: txt.slice(0, 300) });
        fin({ ok: true, balance: v, unit: t.unit, url, upstream: upRes.statusCode });
      });
      upRes.on('error', e => fin({ ok: false, status: 502, error: '读取上游响应失败: ' + e.message }));
    }, 'GET');
  } catch (e) {
    fin({ ok: false, status: 500, error: '余额查询异常: ' + e.message });
  }
}
// 客户端端点用: 短缓存(默认 30s) 抵消客户端轮询; 只缓存成功结果
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
// 客户端端点选渠道: 卡密 channels 白名单(有才过滤) → 有余额目标的优先 → default 优先
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
// 汇率: 1 <unit> = ? <base>; 基准币种恒为 1; 未配置 → null(不计入合计)
function balanceFxRate(cfg, unit) {
  const fx = cfg.balanceFx || {};
  const base = fx.base || 'CNY';
  const u = String(unit || '').trim() || base;
  if (u === base) return 1;
  const r = Number((fx.rates || {})[u]);
  return isFinite(r) && r > 0 ? r : null;
}
// 多渠道聚合: 并发查全部「可见」渠道(没配余额接口的标 ok:false 不发请求) → 按汇率折算到 base 币种求和
//   channels: [{channel, total_remain, unit, ok, error?, remain_base?, no_rate?}]
//   total_remain = Σ remain_base(只计有汇率的); partial=有渠道失败/未配; unit=fx.base
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

/* ================= 成功率探测(probe) =================
 * cfg.probe = { enable:false, intervalMin:10, mode:'models'|'chat' }; 渠道级: ch.probe=true
 * mode=models 免费探活; mode=chat 花token; 结果在 cfg._stats.probe */
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
  // 启动后 20 秒先探一轮(不等首个周期)
  setTimeout(() => probeRound(cfg), 20000).unref();
  log('[probe] 成功率探测已开启: 间隔', Math.max(1, Number(cfg.probe.intervalMin) || 10), '分钟, 模式', cfg.probe.mode || 'models');
}

/* ================= 模型同步(自动) ================= */
const TO_CANON = { openai: openaiToCanonical, claude: claudeToCanonical, gemini: geminiToCanonical };

// 拉取渠道上游的模型列表(供管理面板"获取模型列表"用; 服务端发起, 用真实 apiKey, 走渠道代理)
function fetchUpstreamModels(cfg, ch) {
  return new Promise((resolve, reject) => {
    const base = String(ch.baseUrl || '').replace(/\/+$/, '');
    let url; const headers = {};
    try {
      if (ch.type === 'openai') {
        url = joinUrl(base, '/v1/models');   // 与网关聊天路径同约定: baseUrl 不含 /v1, 由这里补
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
// 自动同步本实例各渠道的模型列表(定期/手动): 拉上游 /models, 合并进 ch.models(只增不减), 内存+磁盘都更新
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

// 可重试的上游错误: 鉴权失败(换 key 重试)/限流/服务端错误/超时
const RETRYABLE = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529]);

// OpenAI 扩展端点/透传是否启用 (默认开启; 仅显式 enable:false 关闭) — 2026-10-16
function openaiExtrasOn(cfg) {
  const oe = (cfg && cfg.openaiExtras) || {};
  return oe.enable !== false;
}

// OpenAI 渠道是否用 Responses API 上游
//  - 渠道级 useResponses 显式设置优先
//  - Responses 客户端(/v1/responses) 默认直通上游 /v1/responses (2026-10-16)
//  - 其余(chat 客户端) 跟随全局 upstreamResponses(默认 false)
function chUsesResponses(cfg, ch, clientApi) {
  if (ch.type !== 'openai') return false;
  if (!openaiExtrasOn(cfg)) return false;
  const oe = cfg.openaiExtras || {};
  if (ch.useResponses !== undefined) return !!ch.useResponses;
  if (clientApi === 'responses') return true;
  return !!oe.upstreamResponses;
}

// 为指定渠道构建上游请求的 url / headers / body
function buildRequestForChannel(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req) {
  // 思考链精简开启时, 即使同格式也走 canonical 转换路径(否则直通管道会绕过精简);
  // 客户端 API(chat/responses) 与上游 API(chat/responses) 不一致时也必须走转换中枢
  const upApi = chUsesResponses(cfg, ch, clientApi) ? 'responses' : 'chat';
  const direct = clientFormat === ch.type && clientApi === upApi && !(cfg.thinkingSummary && cfg.thinkingSummary.enable);
  const stream = canonical.stream;
  const upstreamModel = canonical.model; // 已被调用方改写为该渠道的上游模型名
  let url, headers = {}, bodyBuf;
  if (direct) {
    if (ch.type === 'openai') {
      url = joinUrl(ch.baseUrl, upApi === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      body.model = upstreamModel;
      if (body && typeof body === 'object' && ch.maxTokens && body.max_tokens == null && body.max_completion_tokens == null) {
        body.max_tokens = Number(ch.maxTokens);   // ★渠道级输出上限(缺省时注入): 思考型模型默认上限小, 思考耗尽预算会在标记中途被截断(2026-10-16 实测)
      }
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
      url = joinUrl(ch.baseUrl, upApi === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      if (ch.maxTokens && uc.max_tokens == null && uc.max_completion_tokens == null) uc.max_tokens = Number(ch.maxTokens);   // ★同上: 转换路径也注入
      bodyBuf = Buffer.from(JSON.stringify(upApi === 'responses' ? canonicalToResponsesBody(uc) : BUILD_BODY.openai(uc, { addUsage: ch.addUsage })));
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
  return { url, headers, bodyBuf, direct, stream, upApi };
}

// 处理上游成功响应(2xx): 直通或跨格式转换. 提取自原 handleChat.
/* ================= 请求记录 (config.record: {enable, server, maxChars}) ================= */
function instName(cfg) {
  if (cfg._name) return cfg._name;
  const bn = cfg._configFile ? path.basename(cfg._configFile, '.json') : 'config';
  return bn === 'config' ? 'default' : bn.replace(/^config\./, '');
}
// 写一条记录: 配了 server 就 POST JSON 过去(异步, 不阻塞响应), 否则追加到本机 log/requests-<实例>.jsonl
function writeRequestRecord(cfg, recCfg, rec) {
  const line = JSON.stringify(rec);
  if (recCfg.server) { postRequestRecord(recCfg.server, line); return; }
  try {
    const dir = path.join(path.dirname(cfg._configFile || process.cwd()), 'log');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'requests-' + instName(cfg) + '.jsonl');
    // 简单轮转: 超过 5MB 时只保留尾部约 2MB (按行截断, 不截断 JSON)
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

function handleUpstreamResponse(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, res, upRes, upReq, built, ctx, retryHook) {
  const { direct, stream, upApi } = built;
  const { logMeta, t0, usageCapture, stats } = ctx;
  const rpInc = (cfg.replace && Array.isArray(cfg.replace.inc)) ? rpCompile(cfg.replace.inc) : [];
  const dsmlOn = !!(cfg.dsmlClean && cfg.dsmlClean.enable);        // 内置 DSML 标记清洗(默认开)
  const dsmlThink = !!(cfg.dsmlClean && cfg.dsmlClean.reasoning); // 思考字段是否也清
  /* ★DSML 清洗只对"能按事件解析"的响应生效: SSE 流 与 非流式 JSON。
   *   Gemini 的 JSON 数组流(content-type: application/json)不解析 —— 要解析就得整份缓冲,
   *   会把"边收边发"退化成"收完再发"(打字机效果直接没了)。那条链路维持原样。 */
  /* 回填闸: 只有"函数名命中客户端本次声明的工具"才把文本态调用还原成结构化调用 */
  const dsmlBackfill = !!(cfg.dsmlClean && cfg.dsmlClean.backfill);
  const dsmlToolNames = (() => {
    if (!dsmlBackfill) return null;
    const arr = (canonical && Array.isArray(canonical.tools)) ? canonical.tools : [];
    const set = new Set();
    for (const t of arr) { const n = t && t.function && t.function.name; if (n) set.add(String(n)); }
    return set.size ? set : null;
  })();
  const dsmlOpts = {
    toolNames: dsmlToolNames,
    onDiag: (rec) => dsmlDiag(cfg, Object.assign({ ch: ch.name, model: canonical && canonical.model, fmt: clientFormat, stream: !!stream, direct: !!direct }, rec)),
  };
  const ctSse = /event-stream/i.test(String(upRes.headers['content-type'] || ''));
  const dsmlPipe = dsmlOn && (ctSse || !stream);
  const isResponsesUp = ch.type === 'openai' && upApi === 'responses';

  /* ★★统一结算 + 收尾加固（2026-09-18，与 ai-gateway-core 同源）
   * 事故：direct 流式分支的 `upRes.on('end')` 直接裸调 `ctx.logDone()`。它一旦抛错，EventEmitter
   * 的 emit 循环就中断 —— `upRes.pipe(res)` 的 onend 不会被调用，于是**下游永远等不到结束标记**、
   * 统计里留下「1 次请求 / 0 token」的幽灵记录（core 侧表现为请求挂 9 分钟不结算）。
   * 现在：①结算只做一次；②结算异常绝不影响下游收尾；③流中断也要结算。 */
  let __settled = false;
  const __settle = (status, why) => {
    if (__settled) return;
    __settled = true;
    if (why) logErr('[settle]', why, 'status=' + status);
    try { ctx.logDone(status); } catch (e) { logErr('[settle] logDone 失败:', e.message); }
  };

  /* ★客户端断开(点停止 / 关页面 / 弱网断): 立即取消上游请求。
   *   之前完全没有这条通道 —— 用户按停止后上游继续生成到自然结束或 180s 超时, 表现为"停止按钮没效果/卡死"。 */
  let clientGone = false;
  const killUp = () => {
    if (clientGone) return; clientGone = true;
    try { if (upReq) upReq.destroy(); } catch (_) {}
    try { if (upRes) upRes.destroy(); } catch (_) {}
  };
  res.on('close', () => { if (!res.writableEnded) killUp(); });
  req.on('aborted', () => killUp());
  res.on('error', () => {});   // ★吃掉"对已结束/已断开响应写入"的流错误: 客户端断开瞬间的 write-after-end 曾以 uncaughtException 打死整个网关进程(2026-10-16 实测)

  if (direct) {
    const ct = upRes.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json');
    try {
      res.writeHead(upRes.statusCode, { 'Content-Type': ct, 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    } catch (e) {
      /* ★不能静默 return：报头下发失败时，客户端收不到任何东西、上游响应也无人读取，
       *  请求会永久悬挂。改为明确报错 + 释放上游连接。 */
      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    if (stream) {
      const parser = isResponsesUp ? new ResponsesStreamParser(() => {}) : new UpstreamStreamParser(ch.type, () => {});
      const dec = new SSEDecoder((data) => { try { if (data !== '[DONE]') parser.handle(JSON.parse(data)); } catch (_) {} });
      const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
      upRes.on('data', c => { try { dec.push(u8(c)); } catch (_) {} });
      upRes.on('end', () => {
        try {
          dec.end(); parser.finish();
          usageCapture.input = parser.usage ? parser.usage.input : 0;
          usageCapture.output = parser.usage ? parser.usage.output : 0;
          __settle(upRes.statusCode);
        } catch (e) { logErr('[stream] 结算失败，仍强制给下游收尾:', e.message); }
        /* ★有改写管道(inc 替换 / DSML 清洗)时, 收尾交给管道 —— 它得先冲掉末行残留与状态机残留;
         *   这里先 res.end() 会让管道尾部写入变成 write after end(实测尾部丢字, 2026-10-15)。 */
        if (!rpInc.length && !dsmlPipe) { try { res.end(); } catch (_) {} }
      });
      upRes.on('error', (e) => { if (!rpInc.length && !dsmlPipe) { try { res.end(); } catch (_) {} } __settle(502, '上游流中断(' + e.message + ')'); });
    } else {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const j = safeParse(Buffer.concat(chunks).toString('utf8'));
        if (j) { const cr = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j); usageCapture.input = cr.usage.input; usageCapture.output = cr.usage.output; }
        __settle(upRes.statusCode);
      });
      upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游中断(非流式): ' + e.message); });
    }
    /* ★DSML 清洗只对"能按事件解析"的响应生效: SSE 流 与 非流式 JSON(条件见函数开头 dsmlPipe)。 */
    if (rpInc.length || dsmlPipe) {
      /* 统一改写管道(2026-10-15): inc 文本替换 + 内置 DSML 标记清洗
       *   - 逐行改写, 不需要改写的行原样透传(同格式直通尽量零损耗);
       *   - DSML 状态机按字段隔离, 只动 content/text 与 reasoning_content/reasoning/thinking;
       *   - 收尾(末行残留 + 状态机残留)与 res.end() 都在管道内, 详见 makeDirectPipe。 */
      const pipe = makeDirectPipe(res, rpInc, dsmlPipe, dsmlThink, stream, dsmlOpts);
      let upEnded = false;
      const finishPipe = () => { if (upEnded) return; upEnded = true; try { pipe.end(); } catch (_) {} };
      upRes.on('data', c => pipe.push(c));
      upRes.on('end', finishPipe);
      upRes.on('close', finishPipe);                          // ★上游连接被重置/掐断(没发 end) → 强制在管道内收尾, 下游不再悬挂
      upRes.on('error', (e) => { __settle(502, '上游中断(改写管道): ' + e.message); finishPipe(); });   // 错误也走管道收尾(补 [DONE]), 不提前 res.end()
    } else {
      upRes.on('close', () => { if (!res.writableEnded) { try { res.end(); } catch (_) {} } });   // 裸直通同样兜住上游断流
      upRes.pipe(res);
    }
    return;
  }

  // 跨格式转换
  if (stream) {
    const isArrayStream = clientFormat === 'gemini' && !urlInfo.altSse;
    try {
      res.writeHead(200, {
        'Content-Type': isArrayStream ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*',
      });
    } catch (e) {
      /* ★不能静默 return：报头下发失败时，客户端收不到任何东西、上游响应也无人读取，
       *  请求会永久悬挂。改为明确报错 + 释放上游连接。 */
      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    const baseWriter = (clientFormat === 'openai' && clientApi === 'responses') ? makeResponsesWriter(res, canonical.model) : makeWriter(clientFormat, res, canonical.model, { geminiArray: isArrayStream });
    /* DSML 清洗放在最内层(紧贴 writer): 正文/思考在变成客户端格式前就已干净,
     * 也不会把内部标记喂给 thinkingSummary 的总结模型。 */
    const writer = wrapThinkingSummary(dsmlOn ? wrapDsmlClean(baseWriter, true, dsmlThink, dsmlOpts) : baseWriter, cfg.thinkingSummary, ch, cfg);
    const parser = isResponsesUp ? new ResponsesStreamParser(ev => {
      try { if (rpInc.length) rpWalk(ev, rpInc, 0, false); writer.onEvent(ev); } catch (e) { logErr('writer error:', e.message); }
    }) : new UpstreamStreamParser(ch.type, ev => {
      try { if (rpInc.length) rpWalk(ev, rpInc, 0, false); writer.onEvent(ev); } catch (e) { logErr('writer error:', e.message); }
    });
    const dec = new SSEDecoder((data) => {
      if (data === '[DONE]') { parser.finish(); return; }
      try { parser.handle(JSON.parse(data)); } catch (e) { logErr('bad SSE data (first 200 chars):', String(data).slice(0, 200)); }
    });
    const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
    upRes.on('data', c => { try { dec.push(u8(c)); } catch (_) {} });
    let upStreamDone = false;
    const upStreamFinal = () => {
      if (upStreamDone) return; upStreamDone = true;
      try {
        dec.end(); parser.finish();
        usageCapture.input = parser.usage ? parser.usage.input : 0;
        usageCapture.output = parser.usage ? parser.usage.output : 0;
        __settle(200);
      } catch (e) { logErr('[stream] 转换路径结算失败，仍强制收尾:', e.message); }
      try { res.end(); } catch (_) {}
    };
    upRes.on('end', upStreamFinal);
    upRes.on('close', upStreamFinal);                         // ★上游断流(连接重置, 没发 end)也强制收尾
    upRes.on('error', (e) => { logErr('upstream stream error:', e.message); try { res.end(); } catch (_) {} __settle(502, '上游流中断(转换): ' + e.message); });
  } else {
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', async () => {
      const txt = Buffer.concat(chunks).toString('utf8');
      const j = safeParse(txt);
      if (!j) {
        // 上游 200 但正文不是 JSON(HTML 错误页等, content-type 也可能伪装成 json): 可重试
        const why = 'upstream returned non-JSON: ' + redactText(txt.slice(0, 200), cfg.redact && cfg.redact.extra);
        if (retryHook && retryHook(why)) return;
        stats.errors++;
        return sendError(clientFormat, res, 502, why);
      }
      const cresp = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j);
      usageCapture.input = cresp.usage.input;
      usageCapture.output = cresp.usage.output;
      if (dsmlOn) {   /* 非流式: 整段一次性清洗(final=true: 未闭合的标记块丢弃, 暂缓的尾巴补回) + 文本态调用回填 */
        try {
          if (typeof cresp.text === 'string') {
            const cand = dsmlExtractCall(cresp.text);
            cresp.text = dsmlCleanText(cresp.text);
            const hasStructured = Array.isArray(cresp.tool_calls) && cresp.tool_calls.length;
            const pick = (!hasStructured && cand) ? dsmlPickCall(cand, dsmlToolNames) : null;
            if (pick) {
              cresp.tool_calls = [{ id: randId('call_dsml_'), type: 'function', function: { name: pick.name, arguments: pick.arguments } }];
              if (!cresp.finish_reason || cresp.finish_reason === 'stop') cresp.finish_reason = 'tool_calls';
              dsmlDiag(cfg, { ch: ch.name, model: canonical && canonical.model, fmt: clientFormat, stream: false, direct: false, content: 1, emptied: cand ? 1 : 0, blocks: cand ? cand.length : 0, names: (cand || []).map(c => c.name), backfill: 'no-structured-call→tool_calls', finishIn: 'stop', finishOut: cresp.finish_reason });
            } else if (cand && hasStructured) {
              dsmlDiag(cfg, { ch: ch.name, model: canonical && canonical.model, fmt: clientFormat, stream: false, direct: false, blocks: cand.length, names: cand.map(c => c.name), backfill: 'already-has-structured-call' });
            }
          }
          if (dsmlThink && typeof cresp.reasoning === 'string') cresp.reasoning = dsmlCleanText(cresp.reasoning);
        } catch (e) { logErr('[dsml] 非流式清洗失败:', e.message); }
      }
      if (cfg.thinkingSummary && cfg.thinkingSummary.enable && cresp.reasoning) {
        try {
          if (cfg.thinkingSummary.mode === 'summarize') { const s = await summarizeReasoningText(cresp.reasoning, cfg.thinkingSummary, ch, cfg); if (s) cresp.reasoning = s; }
          else cresp.reasoning = truncateReasoning(cresp.reasoning, cfg.thinkingSummary.maxCharsPerSegment);
        } catch (e) { logErr('[thinkingSummary] 非流式精简失败:', e.message); }
      }
      let out;
      if (clientFormat === 'openai') out = clientApi === 'responses' ? canonicalToResponsesResp(cresp, canonical.model) : canonicalToOpenAIResp(cresp, canonical.model);
      else if (clientFormat === 'claude') out = canonicalToClaudeResp(cresp, canonical.model);
      else out = canonicalToGeminiResp(cresp, canonical.model);
      if (rpInc.length) rpWalk(out, rpInc, 0, false);
      try {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
        res.end(JSON.stringify(out));
      } catch (e) { logErr('[resp] 响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
      __settle(200);
    });
    upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游中断(转换/非流式): ' + e.message); });
  }
}

function handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr) {
  const stats = cfg._stats;
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch (e) { return sendError(clientFormat, res, 400, 'invalid JSON body: ' + e.message); }
  if (!body || typeof body !== 'object') return sendError(clientFormat, res, 400, 'request body must be a JSON object');
  // 隐私过滤: 转发前把请求体里的密钥/token 替换为 ***
  // 管理端总开关 redact.enable(实例级, 默认开) 是上限; 用户卡可 redact=false 覆盖关闭
  const redactInstOn = !(cfg.redact && cfg.redact.enable === false);
  let redactOn = redactInstOn;
  if (redactInstOn && urlInfo.userKey && urlInfo.userKey.redact === false) redactOn = false; // 用户端关
  if (redactOn) body = redactDeep(body, cfg.redact && cfg.redact.extra, 0);
  // 文本替换(发送方向): config.replace.out 规则作用于请求文本(model 字段与 data:URL 跳过)
  const rpOutRules = (cfg.replace && Array.isArray(cfg.replace.out)) ? rpCompile(cfg.replace.out) : [];
  if (rpOutRules.length) body = rpWalk(body, rpOutRules, 0, true);

  const canonical = (clientApi === 'responses') ? responsesToCanonical(body, urlInfo.model) : TO_CANON[clientFormat](body, urlInfo.model);
  if (urlInfo.stream) canonical.stream = true; // gemini: 流式标志在 URL 路径里
  if (!canonical.model) return sendError(clientFormat, res, 400, 'missing "model"');
  // 卡密模型白名单(按客户端请求的对外模型名判定)
  if (urlInfo.userKey && Array.isArray(urlInfo.userKey.models) && urlInfo.userKey.models.length
      && !urlInfo.userKey.models.includes(canonical.model)) {
    return sendError(clientFormat, res, 403, '此卡密不允许使用模型: ' + canonical.model + ' (可用: ' + urlInfo.userKey.models.join(', ') + ')');
  }
  // 卡密分支白名单(只允许访问指定实例)
  if (urlInfo.userKey && Array.isArray(urlInfo.userKey.branches) && urlInfo.userKey.branches.length) {
    const br = cfg._name || 'default';
    if (!urlInfo.userKey.branches.includes(br)) {
      return sendError(clientFormat, res, 403, '此卡密不允许访问分组: ' + br + ' (可用: ' + urlInfo.userKey.branches.join(', ') + ')');
    }
  }
  // 卡级隐私过滤覆盖在 redactDeep 前已应用(2250行附近), 此处不再重复

  const candidates = pickChannels(cfg, canonical.model);
  if (!candidates.length) return sendError(clientFormat, res, 503, 'no channel configured in config.json');

  stats.requests++;
  // 请求记录(可选, 默认关闭): 包一层 res.write/res.end 捕获实际发给客户端的响应正文
  const reqId = randId('req');
  const recCfg = (cfg.record && cfg.record.enable) ? cfg.record : null;
  const recState = { status: 0, chName: '' };
  let recChunks = null, recFinalized = false;
  const recordReq = (status, chName, inT, outT) => {
    recState.status = status; recState.chName = chName || '';
    stats.recent.push({ id: reqId, time: new Date().toISOString().slice(0, 19).replace('T', ' '), model: canonical.model, channel: chName || '', status, duration: Date.now() - t0, inputTokens: inT || 0, outputTokens: outT || 0, keyName: urlInfo.userKey ? (urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12)) : undefined });
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

  // 逐个候选渠道尝试, 连接失败或可重试的 HTTP 错误 → 切下一个; 不可重试错误(如 400) → 直接透传
  const tryNext = () => {
    if (attempt >= candidates.length) {
      // 全部候选都失败了
      stats.errors++;
      recordReq(lastErrStatus || 502, '', 0, 0);
      const msg = lastErrMsg || ('all ' + candidates.length + ' channels failed');
      return sendError(clientFormat, res, lastErrStatus || 502, msg);
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    const myCanonical = { ...canonical, model: pick.upstreamModel || canonical.model };
    const built = buildRequestForChannel(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req);
    attempt++;

    // HTTP 头只允许 ASCII, 中文/全角字符的 apiKey 会让 node 抛内部错误
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
        // 卡密用量统计 + 额度累计
        if (urlInfo.userKey) {
          const kn = urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12);
          stats.byKey = stats.byKey || {};
          stats.byKey[kn] = stats.byKey[kn] || { requests: 0, inputTokens: 0, outputTokens: 0 };
          stats.byKey[kn].inputTokens += usageCapture.input;
          stats.byKey[kn].outputTokens += usageCapture.output;
          urlInfo.userKey.usedTokens = (urlInfo.userKey.usedTokens || 0) + usageCapture.input + usageCapture.output;
          cfg._keyUsageDirty = true;
        }
        recordReq(status, ch.name, usageCapture.input, usageCapture.output);
      },
    };
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;
    if (urlInfo.userKey) {
      const kn = urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12);
      stats.byKey = stats.byKey || {};
      stats.byKey[kn] = stats.byKey[kn] || { requests: 0, inputTokens: 0, outputTokens: 0 };
      stats.byKey[kn].requests++;
    }

    // 渠道级排队延迟(渠道字段 delayMs, 毫秒): 每个请求发出前先等待; 同一渠道的并发请求经 _gate 链按间隔串行发出(并发也撞不到上游), 缓解 429 限流
    const delayMs = Math.min(120000, Number(ch.delayMs) || 0);
    // 连接级错误 / HTML 冒充成功的同渠道重试(默认 cfg.connRetry=2 次, 每次换全新连接):
    // socket hang up 等错误发生在收到任何响应之前, 重试安全不会重复计费
    let connRetries = 0;
    const maxConnRetry = Math.max(0, Number(cfg.connRetry) || 0);
    // 返回 true = 已安排同渠道重试或切换下一候选; false = 没招了, 调用方走最终失败
    const retrySameOrNext = (why) => {
      if (connRetries < maxConnRetry) {
        connRetries++;
        log('RETRY', ctx.logMeta, why, '→ 同渠道重试 (' + connRetries + '/' + maxConnRetry + ')');
        setTimeout(() => doSend(true), 400 * connRetries);
        return true;
      }
      if (attempt < candidates.length) {
        log('ERR', ctx.logMeta, why, '→ 切换渠道');
        tryNext();
        return true;
      }
      return false;
    };
    const doSend = (fresh) => upstreamRequest(cfg, ch, built.url, built.headers, built.bodyBuf, (err, upRes, upReq) => {
      if (err) {
        lastErrStatus = 502; lastErrMsg = 'upstream request failed: ' + err.message;
        if (isConnErr(err)) {
          if (retrySameOrNext(err.message)) return;
        } else {
          log('ERR', ctx.logMeta, err.message, attempt < candidates.length ? '→ 切换渠道' : '→ 无更多渠道');
          if (attempt < candidates.length) return tryNext();
        }
        stats.errors++;
        recordReq(502, ch.name, 0, 0);
        return sendError(clientFormat, res, 502, lastErrMsg);
      }

      // 上游拿 HTML 网页冒充成功(CDN 验证页/中转站故障页): 视为可重试错误, 先重试本渠道再换渠道
      const upCt = String(upRes.headers['content-type'] || '');
      if (upRes.statusCode < 400 && /text\/html/i.test(upCt)) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = 502;
          lastErrMsg = '渠道 ' + ch.name + ' 返回了 HTML 网页而非数据(content-type: ' + upCt + '): ' + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 200);
          if (retrySameOrNext('upstream returned HTML (content-type: ' + upCt + ')')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          return sendError(clientFormat, res, 502, lastErrMsg);
        });
        upRes.on('error', () => {
          if (retrySameOrNext('read HTML response failed')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          try { sendError(clientFormat, res, 502, lastErrMsg || 'upstream HTML response read failed'); } catch (_) {}
        });
        return;
      }

      if (upRes.statusCode >= 400 && RETRYABLE.has(upRes.statusCode) && attempt < candidates.length) {
        // 可重试错误 & 还有候选 → 排空响应体后切换
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

      // ★ Responses 直通降级 (2026-10-16): 客户端 /v1/responses 直通上游 /v1/responses 时,
      //   上游返回 404/405(该上游不支持 Responses 端点, 如旧版 vLLM/部分中转) → 自动改发
      //   /v1/chat/completions(同一渠道), 响应照常转回 responses 格式。每个渠道只降级一次。
      if (clientApi === 'responses' && built.direct && ch.type === 'openai'
          && (upRes.statusCode === 404 || upRes.statusCode === 405)) {
        ctx.respDg = ctx.respDg || {};
        if (!ctx.respDg[ch.name]) {
          ctx.respDg[ch.name] = true;
          const sc = upRes.statusCode;
          const dgBody = Buffer.from(JSON.stringify(BUILD_BODY.openai(myCanonical, { addUsage: ch.addUsage })));
          const dgHeaders = { authorization: 'Bearer ' + ch.apiKey };
          if (stream) dgHeaders.accept = 'text/event-stream';
          const dgBuilt = { url: joinUrl(ch.baseUrl, '/v1/chat/completions'), headers: dgHeaders, bodyBuf: dgBody, direct: false, stream: !!stream, upApi: 'chat' };
          upRes.resume(); // 丢弃原 404/405 body
          log('DOWNGRADE', ctx.logMeta, 'status=' + sc, '上游不支持 /v1/responses → 改 chat 转换重发');
          return upstreamRequest(cfg, ch, dgBuilt.url, dgHeaders, dgBody, (err2, upRes2, upReq2) => {
            if (err2) {
              lastErrStatus = 502; lastErrMsg = 'downgrade chat failed: ' + err2.message;
              log('ERR', ctx.logMeta, err2.message, '(downgrade chat)');
              stats.errors++;
              recordReq(502, ch.name, 0, 0);
              return sendError(clientFormat, res, 502, lastErrMsg);
            }
            if (upRes2.statusCode >= 400) {
              // chat 也失败(非 404/405 直通, 本来就是转换路径) → 透传 chat 的错误
              const c2 = [];
              upRes2.on('data', c => c2.push(c));
              upRes2.on('end', () => {
                stats.errors++;
                recordReq(upRes2.statusCode, ch.name, 0, 0);
                log('UPERR', ctx.logMeta, 'status=' + upRes2.statusCode, '(downgrade chat 也失败)');
                try {
                  res.writeHead(upRes2.statusCode, { 'Content-Type': upRes2.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
                  res.end(Buffer.concat(c2));
                } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
              });
              upRes2.on('error', () => { try { res.end(); } catch (_) {} });
              return;
            }
            handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes2, upReq2, dgBuilt, ctx, (why) => {
              lastErrStatus = 502; lastErrMsg = why;
              return retrySameOrNext(why);
            });
          }, undefined, undefined);
        }
      }

      if (upRes.statusCode >= 400) {
        // 不可重试错误(如 400) 或已是最后候选 → 原样透传错误
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          stats.errors++;
          recordReq(upRes.statusCode, ch.name, 0, 0);
          log('UPERR', ctx.logMeta, 'status=' + upRes.statusCode, attempt > 1 ? '(已尝试 ' + attempt + ' 个渠道)' : '');
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
            res.end(Buffer.concat(chunks));
          } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
        });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }

      // 成功(2xx) → 正常处理, 从此不可回退(正文非 JSON 冒充成功时仍可经 hook 重试)
      handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes, upReq, built, ctx, (why) => {
        lastErrStatus = 502; lastErrMsg = why;
        return retrySameOrNext(why);
      });
    }, undefined, fresh ? makeFreshAgents(cfg, ch) : undefined);
    if (delayMs > 0) {
      ch._gate = (ch._gate || Promise.resolve()).catch(() => {}).then(() => new Promise(r => setTimeout(r, delayMs)));
      ch._gate.then(() => { try { doSend(); } catch (e) { try { sendError(clientFormat, res, 500, 'upstream dispatch failed: ' + e.message); } catch (_) {} } });
    } else {
      doSend();
    }
  };
  tryNext();
}

/* ================= 扩展 OpenAI 端点直通(images/embeddings/audio/completions/moderations) ================= */
// 只支持 openai 类型渠道: 原样转发(JSON 端点应用 modelMap 改名; multipart 原样 Buffer), 响应透传; 带简单的故障切换
function handleExtraEndpoint(cfg, req, res, pathname, bodyBuf, contentType, method) {
  const stats = cfg._stats;
  let model = '';
  let parsed = null;
  if (contentType && contentType.startsWith('application/json')) {
    try { parsed = JSON.parse(bodyBuf.toString('utf8')); model = (parsed && parsed.model) || ''; } catch (_) {}
  }
  const candidates = pickChannels(cfg, model || undefined).filter(c => c.ch.type === 'openai');
  if (!candidates.length) {
    stats.errors++;
    return sendError('openai', res, 503, 'no openai channel for extended endpoint ' + pathname + ' (扩展端点只支持 openai 类型渠道)');
  }
  stats.requests++;
  let attempt = 0;
  let lastErr = '';
  const tryNext = () => {
    if (attempt >= candidates.length) {
      stats.errors++;
      return sendError('openai', res, 502, lastErr || ('all ' + candidates.length + ' channels failed'));
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    attempt++;
    const headers = { authorization: 'Bearer ' + ch.apiKey };
    if (contentType) headers['Content-Type'] = contentType;
    for (const hk of ['openai-beta', 'openai-organization', 'openai-project']) {
      const hv = req.headers[hk];
      if (typeof hv === 'string' && hv) headers[hk] = hv;
    }
    for (const [hk, hv] of Object.entries(headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        stats.errors++;
        return sendError('openai', res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请修改 config.json`);
      }
    }
    let outBody = bodyBuf;
    if (parsed) {
      if (pick.upstreamModel && parsed.model !== undefined && parsed.model !== pick.upstreamModel) {
        parsed.model = pick.upstreamModel;
        outBody = Buffer.from(JSON.stringify(parsed));
      }
    }
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;
    log('[extra]', pathname, 'model=' + (model || '-'), 'ch=' + ch.name);
    let connRetries = 0;
    const maxConnRetry = Math.max(0, Number(cfg.connRetry) || 0);
    const sendBody = (method === 'GET' || method === 'HEAD') ? Buffer.alloc(0) : outBody;
    const doSend = (fresh) => upstreamRequest(cfg, ch, joinUrl(ch.baseUrl, pathname), headers, sendBody, (err, upRes) => {
      if (err) {
        lastErr = 'upstream request failed: ' + err.message;
        if (isConnErr(err) && connRetries < maxConnRetry) {
          connRetries++;
          log('RETRY', '[extra]', pathname, err.message, '→ 同渠道重试 (' + connRetries + '/' + maxConnRetry + ')');
          return setTimeout(() => doSend(true), 400 * connRetries);
        }
        log('ERR', '[extra]', pathname, err.message, attempt < candidates.length ? '→ 切换渠道' : '→ 无更多渠道');
        if (attempt < candidates.length) return tryNext();
        stats.errors++;
        return sendError('openai', res, 502, lastErr);
      }
      if (upRes.statusCode >= 400 && RETRYABLE.has(upRes.statusCode) && attempt < candidates.length) {
        const sc = upRes.statusCode;
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErr = '渠道 ' + ch.name + ' 返回 ' + sc + ': ' + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 300);
          log('RETRY', '[extra]', pathname, 'status=' + sc, '→ 切换渠道 (' + (candidates.length - attempt) + ' 个剩余)');
          tryNext();
        });
        upRes.on('error', () => tryNext());
        return;
      }
      if (upRes.statusCode >= 400) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          stats.errors++;
          log('UPERR', '[extra]', pathname, 'status=' + upRes.statusCode);
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || contentType || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
            res.end(Buffer.concat(chunks));
          } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
        });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }
      // 成功 → 透传(含流式/二进制/音频)
      try {
        res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || contentType || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders(), 'Cache-Control': 'no-cache' });
      } catch (e) { logErr('[resp] 响应头下发失败, 已中断该请求:', e.message); try { res.end(); } catch (_) {} try { upRes.resume(); } catch (_) {} return; }
      upRes.pipe(res);
    }, method, fresh ? makeFreshAgents(cfg, ch) : undefined);
    doSend();
  };
  tryNext();
}

/* ================= HTTP 服务 ================= */
const GEMINI_RE = /^\/v1(?:beta|alpha)?\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)$/;
// 注: 旧的 EXTRA_OPENAI_ENDPOINTS 固定白名单(9 个端点)已废弃。
//     2026-10-16 起改为「/v1/* 兜底透传」: 任意未命中转换入口的 /v1/* 路径都原样转发到 openai 渠道
//     (覆盖 files/batches/vector_stores/fine_tuning/images/embeddings/audio/completions/moderations 等),
//     由 handleHttp 中的 isPassthru 判定 + handleExtraEndpoint 执行。

async function handleHttp(cfg, req, res) {
  const u = new URL(req.url, 'http://localhost');
  let p = u.pathname;

  // ===== 多实例路由(单进程模式): 兼容端口直达 / 主端口 /实例名/ 前缀 / default =====
  if (CUR_POOL) {
    const r = poolRoute(CUR_POOL, req, p);
    if (r.error) { sendError('openai', res, r.status || 404, r.error); return; }
    cfg = r.cfg;
    p = r.path;
    if (r.name) req._branchName = r.name;
    // 全局分支白名单: 卡在任何实例注册过且 branches 非空, 只能访问白名单内的实例
    // (在目标实例认证前拦截, 防止目标实例免密时绕过)
    if (req._branchName) {
      const h = req.headers;
      const auth = h.authorization || '';
      const presented = (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '') || h['x-api-key'] || h['x-goog-api-key'] || u.searchParams.get('key') || '';
      if (presented) {
        for (const [, c] of CUR_POOL.instances) {
          const uk = (c.apiKeys || []).find(k => k.key && k.key === presented);
          if (uk && Array.isArray(uk.branches) && uk.branches.length && !uk.branches.includes(req._branchName)) {
            return sendError('openai', res, 403, '此卡密不允许访问分组: ' + req._branchName + ' (可用: ' + uk.branches.join(', ') + ')');
          }
        }
      }
    }
  }

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
      openaiExtras: cfg.openaiExtras || { enable: true, upstreamResponses: false },
      channels: cfg.channels.map(c => ({ name: c.name, type: c.type, baseUrl: c.baseUrl, proxy: c.proxy || null, models: c.models, modelMap: c.modelMap, default: c.default, delayMs: c.delayMs || 0, useResponses: c.useResponses === undefined ? undefined : !!c.useResponses })),
      proxies: Object.entries(cfg.proxies).map(([k, v]) => ({ name: k, type: v.type, host: v.host, port: v.port })),
      stats: { requests: cfg._stats.requests, errors: cfg._stats.errors, byChannel: cfg._stats.byChannel, byKey: cfg._stats.byKey || {} },
      probe: Object.fromEntries(Object.entries(cfg._stats.probe || {}).map(([k, v]) => [k, { rate: v.total ? Math.round(v.ok / v.total * 100) : null, total: v.total, lastOk: v.lastOk, lastErr: v.lastErr }])),
    }));
  }

  // ===== Web 管理面板 (/admin + /admin/api/*) =====
  if (p === '/admin' || p === '/admin/' || p.startsWith('/admin/api/') || p.startsWith('/admin/m3')) {
    // 管理页面不需要收集 body 前置处理, handleAdmin 内部自行处理
    // 但 POST/DELETE 的 body 需要先收集
    if (req.method === 'POST' || req.method === 'DELETE') {
      let adminBody = '';
      const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
      req.on('data', c => { adminBody += u8(c); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { handleAdmin(cfg, req, res, u, p, adminBody).catch(e => jsonErr(res, e)); });
      req.on('error', () => {});
    } else {
      return handleAdmin(cfg, req, res, u, p, '');
    }
    return;
  }
  // ===== 用户端网页: GET /user (不需鉴权, 登录在页面内完成) =====
  if (req.method === 'GET' && (p === '/user' || p === '/user/')) {
    const f = path.join(__dirname, 'user.html');
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      return jsonErr(res, { error: '用户端页面未找到, 请把 user.html 放到网关目录: ' + f }, 404);
    }
  }
  // ===== 插件端点: /plugins[/<id>[/<path...>]] =====
  if (PLUGINS && (p === '/plugins' || p.startsWith('/plugins/'))) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      PLUGINS.handle(cfg, req, res, u, p, '').catch(e => jsonErr(res, e));
    } else {
      let pbody = '';
      const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
      req.on('data', c => { pbody += u8(c); if (pbody.length > 8 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { PLUGINS.handle(cfg, req, res, u, p, pbody).catch(e => jsonErr(res, e)); });
      req.on('error', () => {});
    }
    return;
  }

  // ===== 卡密余额查询(用户端): GET /credits, 带卡密认证 =====
  if (req.method === 'GET' && p === '/credits') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    if (authR.userKey) return res.end(JSON.stringify(keyCreditsJSON(authR.userKey)));
    return res.end(JSON.stringify({ admin: true, unlimited: true })); // 管理员主key
  }

  // ===== 账密登录(用户端): POST /auth/login {uid, password} → 返回该用户卡密+余额 =====
  if (req.method === 'POST' && p === '/auth/login') {
    let body = '';
    const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
    req.on('data', c => { body += u8(c); if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const uid = String(j.uid || '').trim();
        const user = (cfg.users || []).find(x => x.uid === uid);
        if (!user || !verifyPassword(j.password || '', user.passwordHash))
          return sendError('openai', res, 401, 'UID 或密码错误');
        const myKeys = (cfg.apiKeys || []).filter(k => k.uid === uid);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({
          ok: true, uid: user.uid, name: user.name || '',
          keys: myKeys.map(k => ({ key: k.key, ...keyCreditsJSON(k) })),
        }));
      } catch (e) { sendError('openai', res, 400, 'bad json'); }
    });
    req.on('error', () => {});
    return;
  }

  // ===== 注册(用户端, 管理端可开关): POST /auth/register {uid, password, captchaToken?, email?} =====
  if (req.method === 'POST' && p === '/auth/register') {
    let body = '';
    const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
    req.on('data', c => { body += u8(c); if (body.length > 65536) req.destroy(); });
    req.on('end', async () => {
      try {
        const reg = cfg.registration || {};
        if (!reg.enable) return sendError('openai', res, 403, '该服务器未开放注册');
        const j = JSON.parse(body || '{}');
        const uid = String(j.uid || '').trim();
        const pw = String(j.password || '');
        if (!/^[A-Za-z0-9_-]{3,32}$/.test(uid)) return sendError('openai', res, 400, 'UID 需 3-32 位字母/数字/下划线');
        if (pw.length < (reg.minPasswordLen || 8)) return sendError('openai', res, 400, '密码至少 ' + (reg.minPasswordLen || 8) + ' 位');
        if ((cfg.users || []).some(x => x.uid === uid)) return sendError('openai', res, 409, 'UID 已被注册');
        // 人机验证(turnstile)
        if (reg.captchaProvider === 'turnstile') {
          if (!reg.captchaSecret) return sendError('openai', res, 500, '管理端未配置 captchaSecret');
          const token = String(j.captchaToken || '');
          if (!token) return sendError('openai', res, 400, '缺少人机验证');
          const okT = await new Promise(resolve => {
            const postData = 'secret=' + encodeURIComponent(reg.captchaSecret) + '&response=' + encodeURIComponent(token);
            const rq = https.request({
              hostname: 'challenges.cloudflare.com', path: '/turnstile/v0/siteverify', method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
              timeout: 10000,
            }, (r2) => {
              let d = ''; r2.on('data', c => d += c); r2.on('end', () => {
                try { resolve(!!JSON.parse(d).success); } catch (_) { resolve(false); }
              });
            });
            rq.on('error', () => resolve(false));
            rq.on('timeout', () => { rq.destroy(); resolve(false); });
            rq.write(postData); rq.end();
          });
          if (!okT) return sendError('openai', res, 403, '人机验证失败');
        }
        // 邮箱字段(验证逻辑: 开 emailVerify 时先存 unverified, 简化版先只记录)
        const email = String(j.email || '').trim();
        if (reg.emailVerify && reg.emailVerify.enable && !email) return sendError('openai', res, 400, '需要邮箱');
        // 创建用户
        cfg.users = cfg.users || [];
        cfg.users.push({
          uid, name: uid, passwordHash: hashPassword(pw),
          note: email ? ('email:' + email) : '', createdAt: new Date().toISOString(),
        });
        // 自动发一张默认卡
        cfg.apiKeys = cfg.apiKeys || [];
        const nk = {
          key: genApiKey(cfg.keyLength), name: uid, enable: true,
          quotaTokens: reg.defaultQuota || 0, usedTokens: 0,
          models: [], channels: [], uid, note: '注册自动发卡', createdAt: new Date().toISOString(),
        };
        cfg.apiKeys.push(nk);
        persistRuntimeCfg(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ ok: true, uid, key: nk.key, quotaTokens: nk.quotaTokens }));
        log('[auth] 新用户注册:', uid);
      } catch (e) { sendError('openai', res, 400, 'bad json'); }
    });
    req.on('error', () => {});
    return;
  }

  // ===== 用户端自助(主卡认证): /auth/me /auth/profile /auth/mykeys =====
  if (p === '/auth/me' && req.method === 'GET') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
    if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密(非管理员key)');
    const uk = authR.userKey;
    const user = uk.uid ? (cfg.users || []).find(x => x.uid === uk.uid) : null;
    const myKeys = uk.uid ? (cfg.apiKeys || []).filter(k => k.uid === uk.uid) : [uk];
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({
      ok: true, uid: uk.uid || '', name: (user && user.name) || uk.name || '',
      nickname: (user && user.nickname) || '', avatar: (user && user.avatar) || '',
      mainKey: uk.key,
      keys: myKeys.map(k => ({ key: k.key, name: k.name, ...keyCreditsJSON(k), branches: k.branches || [], isMain: k.key === uk.key })),
      branches: availableBranches(cfg, uk),
    }));
  }
  if (p === '/auth/profile' && req.method === 'POST') {
    collectJson(req, res, (j) => {
      const authR = checkAuth(cfg, req, u.searchParams);
      if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
      if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密');
      const uk = authR.userKey;
      if (uk.uid) {
        const user = (cfg.users || []).find(x => x.uid === uk.uid);
        if (user) {
          if (j.nickname !== undefined) user.nickname = String(j.nickname).slice(0, 64);
          if (j.name !== undefined) user.name = String(j.name).slice(0, 64);
          if (j.avatar !== undefined) user.avatar = String(j.avatar).slice(0, 300);
          persistRuntimeCfg(cfg);
        }
      }
      // 卡的显示名也可改
      if (j.cardName !== undefined) { uk.name = String(j.cardName).slice(0, 64); persistRuntimeCfg(cfg); }
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  // 我的卡密: GET列表 / POST新建子卡 / DELETE删子卡 / POST update改子卡
  if (p === '/auth/mykeys') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
    if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密');
    const uk = authR.userKey;
    if (req.method === 'GET') {
      const myKeys = uk.uid ? (cfg.apiKeys || []).filter(k => k.uid === uk.uid) : [uk];
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      return res.end(JSON.stringify({ keys: myKeys.map(k => ({ key: k.key, name: k.name, ...keyCreditsJSON(k), branches: k.branches || [], redact: k.redact == null ? null : !!k.redact, isMain: k.key === uk.key })) }));
    }
    if (req.method === 'POST') {
      collectJson(req, res, (j) => {
        // 子卡: 父卡的子集(模型/分支白名单不能超过父卡; 额度不能超过父卡剩余)
        const parentModels = uk.models || [], parentBranches = uk.branches || [];
        const models = Array.isArray(j.models) ? j.models.map(String).filter(m => !parentModels.length || parentModels.includes(m)) : [];
        const branches = Array.isArray(j.branches) ? j.branches.map(String).filter(b => !parentBranches.length || parentBranches.includes(b)) : [];
        let quota = Math.max(0, Number(j.quotaTokens) || 0);
        if (uk.quotaTokens > 0) {
          const remaining = uk.quotaTokens - (uk.usedTokens || 0);
          if (quota <= 0 || quota > remaining) quota = remaining; // 不超过父卡剩余
        }
        const nk = {
          key: genApiKey(cfg.keyLength), name: String(j.name || uk.name || '子卡').slice(0, 64),
          enable: true, quotaTokens: quota, usedTokens: 0, uid: uk.uid || '',
          models, branches, channels: [], note: String(j.note || '用户自助').slice(0, 200),
          createdAt: new Date().toISOString(),
        };
        cfg.apiKeys = cfg.apiKeys || [];
        cfg.apiKeys.push(nk);
        persistRuntimeCfg(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ ok: true, key: nk }));
      });
      return;
    }
  }
  if (p === '/auth/mykeys-update' && req.method === 'POST') {
    collectJson(req, res, (j) => {
      const authR = checkAuth(cfg, req, u.searchParams);
      if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
      if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密');
      const uk = authR.userKey;
      const target = (cfg.apiKeys || []).find(k => k.key === j.key && (k.uid ? k.uid === uk.uid : k.key === uk.key));
      if (!target) return sendError('openai', res, 404, '卡密不存在或不属于你');
      if (j.name !== undefined) target.name = String(j.name).slice(0, 64);
      if (j.models !== undefined) {
        const pm = uk.models || [];
        target.models = Array.isArray(j.models) ? j.models.map(String).filter(m => !pm.length || pm.includes(m)) : [];
      }
      if (j.branches !== undefined) {
        const pb = uk.branches || [];
        target.branches = Array.isArray(j.branches) ? j.branches.map(String).filter(b => !pb.length || pb.includes(b)) : [];
      }
      if (j.redact !== undefined) target.redact = (j.redact == null) ? null : !!j.redact;
      if (j.quotaTokens !== undefined && target.key !== uk.key) {
        let q = Math.max(0, Number(j.quotaTokens) || 0);
        if (uk.quotaTokens > 0) q = Math.min(q, uk.quotaTokens - (uk.usedTokens || 0));
        target.quotaTokens = q;
      }
      persistRuntimeCfg(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (p === '/auth/mykeys-delete' && req.method === 'POST') {
    collectJson(req, res, (j) => {
      const authR = checkAuth(cfg, req, u.searchParams);
      if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
      if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密');
      const uk = authR.userKey;
      if (j.key === uk.key) return sendError('openai', res, 400, '不能删除主卡');
      const before = (cfg.apiKeys || []).length;
      cfg.apiKeys = (cfg.apiKeys || []).filter(k => !(k.key === j.key && k.uid === uk.uid));
      if (cfg.apiKeys.length < before) persistRuntimeCfg(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true, deleted: before - cfg.apiKeys.length }));
    });
    return;
  }

  // ===== 可访问分支列表(卡密认证, 按 branches 过滤) =====
  if (p === '/v1/branches' && req.method === 'GET') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({ branches: availableBranches(cfg, authR.userKey) }));
  }

  // ===== 注册开关状态(用户端查询, 决定是否显示注册入口) =====
  if (req.method === 'GET' && p === '/auth/register') {
    const reg = cfg.registration || {};
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({
      enable: !!reg.enable,
      captchaProvider: reg.captchaProvider || 'none',
      captchaSiteKey: reg.captchaSiteKey || '',
      minPasswordLen: reg.minPasswordLen || 8,
      emailRequired: !!(reg.emailVerify && reg.emailVerify.enable),
    }));
  }

  if (req.method === 'GET' && (p === '/v1/models' || p === '/v1beta/models')) {
    const fmt = p === '/v1beta/models' ? 'gemini' : 'openai';
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError(fmt, res, authR.status || 401, authR.error || 'invalid key');
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(modelsResponse(cfg, fmt)));
  }

  // ===== 上游余额透传(OpenAI 语义, 第三方客户端可直接识别) =====
  //   GET /v1/dashboard/billing/credit_grants → credit_summary(total_available=上游余额)
  //   GET /v1/dashboard/billing/subscription  → billing_subscription(hard/soft_limit_usd=上游余额)
  //   ?ch=<渠道名> 指定渠道(不传=默认渠道); 卡密只能用自己 channels 白名单里的渠道指定
  if (req.method === 'GET' && BILLING_PATHS.has(p)) {
    const t0 = Date.now();
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    const isGrants = p.endsWith('credit_grants');
    const uk = authR.userKey || null;
    const want = String(u.searchParams.get('ch') || u.searchParams.get('channel') || '').trim();
    let ch = null;
    if (want) {
      ch = (cfg.channels || []).find(c => c.name === want) || null;
      if (!ch) return sendError('openai', res, 404, '渠道不存在: ' + want);
      const cardWl = uk && Array.isArray(uk.channels) && uk.channels.length ? uk.channels : null;
      const allowed = !!authR.admin || !cardWl || cardWl.includes(want);
      if (!allowed) return sendError('openai', res, 403, '此卡密不允许查询渠道余额: ' + want);
    } else if (GENERIC_BALANCE_PATHS.has(p)) {
      // 多渠道聚合(通用余额别名): 全部「可见且有余额目标」渠道并发查 → 按汇率折算到 base 币种求和
      return balanceAggregate(cfg, uk, (agg) => {
        if (!agg.ok) return sendError('openai', res, agg.status || 503, agg.error);
        return sendJson(res, 200, {
          ...agg,
          data: { total_remain: agg.total_remain, unit: agg.unit, channels: agg.channels, partial: agg.partial, ok_count: agg.ok_count },
        });
      });
    } else {
      ch = pickBalanceChannel(cfg, uk);
      if (!ch) return sendError('openai', res, 503, '本实例没有可查询余额的渠道(可在渠道配置里填 balanceUrl + balancePath)');
    }
    const finish = (r, cached) => {
      if (!r.ok) {
        log('UPERR', '[balance]', ch.name, (isGrants ? 'credit_grants' : 'subscription'), 'status=' + (r.status || 502), r.error || '');
        return sendError('openai', res, r.status || 502, r.error || 'balance query failed');
      }
      log('[balance]', ch.name, (isGrants ? 'credit_grants' : 'subscription'), 'channel=' + ch.name, 'unit=' + (r.unit || '-'), 'ms=' + (Date.now() - t0) + (cached ? ' (cached)' : ''));
      const num = Number(r.balance);
      const avail = isFinite(num) ? num : null;
      const common = { channel: ch.name, balance: r.balance, unit: r.unit || '', upstream_url: r.url };
      // 通用余额形态: 兼容各家客户端「余额获取路径 + JSON 键」配置(键名 total_remain / balance / remaining / total_available 都给)
      if (GENERIC_BALANCE_PATHS.has(p)) {
        const generic = { total_remain: avail, balance: r.balance, total_available: avail, total_granted: avail, total_used: 0, remaining: avail, unit: r.unit || '', channel: ch.name };
        return sendJson(res, 200, { ...generic, data: { ...generic, upstream_url: r.url } });
      }
      if (isGrants) return sendJson(res, 200, { object: 'credit_summary', total_granted: avail, total_used: 0, total_available: avail, grants: { object: 'list', data: [] }, ...common });
      return sendJson(res, 200, {
        object: 'billing_subscription', has_payment_method: true, canceled: false, canceled_at: null, delinquent: null,
        access_until: Math.floor(Date.now() / 1000) + 31536000,
        soft_limit_usd: avail, hard_limit_usd: avail, system_hard_limit_usd: avail,
        plan: { title: 'ai-gateway', id: 'ai-gateway' }, account_name: ch.name, ...common,
      });
    };
    try {
      fetchBalanceCached(cfg, ch, finish);
    } catch (e) {
      logErr('[balance] 查询异常:', e.message);
      sendError('openai', res, 500, 'balance query failed: ' + e.message);
    }
    return;
  }

  // 兜底透传路径判定: 任意 /v1/* 且不属于转换中枢接管的入口 → 原样转发到 openai 渠道
  // (2026-10-16 新增: 默认开启, 覆盖 files/batches/vector_stores/images/embeddings/audio/completions/moderations 等)
  const isConvEndpoint = (q) => (
    q === '/v1/chat/completions' || q === '/chat/completions' ||
    q === '/v1/messages' || q === '/messages' ||
    q === '/v1/responses' || GEMINI_RE.test(q)
  );
  const isPassthru = openaiExtrasOn(cfg) && p.startsWith('/v1/') && !isConvEndpoint(p);

  // 未知非 POST 端点: 若是「看起来像查余额/用量」的路径, 记一行日志(方便将来补齐别名); 透传路径放行
  if (req.method !== 'POST' && !isPassthru) {
    if (/balance|quota|credit|billing|usage|wallet|cost|spend|money/i.test(p)) {
      log('[balance] 未命中的余额系路径:', req.method, p, '(可补进 BILLING_PATHS 别名)');
    }
    return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);
  }

  let clientFormat = null;
  let clientApi = 'chat';
  const urlInfo = { model: null, altSse: false };
  if (p === '/v1/chat/completions' || p === '/chat/completions') clientFormat = 'openai';
  else if (p === '/v1/messages' || p === '/messages') clientFormat = 'claude';
  else if (p === '/v1/responses') {
    if (!openaiExtrasOn(cfg)) return sendError('openai', res, 404, 'unknown endpoint: ' + p + ' (OpenAI 扩展端点已关闭: openaiExtras.enable=false)');
    clientFormat = 'openai';
    clientApi = 'responses';
  } else {
    const m = GEMINI_RE.exec(p);
    if (m) {
      clientFormat = 'gemini';
      urlInfo.model = decodeURIComponent(m[1]);
      urlInfo.altSse = u.searchParams.get('alt') === 'sse';
      urlInfo.stream = m[2] === 'streamGenerateContent';
      if (m[2] === 'countTokens') return sendError('gemini', res, 501, 'countTokens is not supported by this gateway');
    }
  }
  // OpenAI 兜底透传: 任意 /v1/* (未命中上面的转换入口) 原样转发到 openai 渠道
  // 保留方法(GET/POST/PUT/PATCH/DELETE)、query、multipart、二进制/流式
  if (!clientFormat && isPassthru) {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    const ct = req.headers['content-type'] || '';
    const chunks = [];
    let size = 0, aborted = false;
    req.on('data', c => {
      if (aborted) return;
      size += c.length;
      if (size > cfg.maxBodyBytes) { aborted = true; req.destroy(); sendError('openai', res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)'); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) handleExtraEndpoint(cfg, req, res, p + (u.search || ''), Buffer.concat(chunks), ct, req.method); });
    req.on('error', () => {});
    return;
  }
  if (!clientFormat) return sendError('openai', res, 404, 'unknown endpoint: ' + p + ' (支持: /v1/chat/completions | /v1/messages | /v1beta/models/{model}:generateContent|:streamGenerateContent; 其余 /v1/* 原样透传到 openai 渠道)');

  const authR = checkAuth(cfg, req, u.searchParams);
  if (!authR.ok) return sendError(clientFormat, res, authR.status || 401, authR.error || 'invalid key');
  urlInfo.userKey = authR.userKey || null;

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
      handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr);
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
  const cfgDir = cfg._configFile ? path.dirname(cfg._configFile) : path.join(os.homedir(), 'ai-gateway');
  admin.setDir(cfgDir);
  if (PLUGINS) admin.setPlugins(PLUGINS);

  // ===== 多实例模式: 单进程托管目录下全部 config*.json, 主端口路径路由 + 实例原端口兼容监听 =====
  if (opts.multi) {
    const pool = createInstancePool(cfgDir);
    CUR_POOL = pool;
    pool.mainHost = opts.host || cfg.listen.host;
    admin.setPool(pool);
    admin.setUpstreamModels((ch, inst) => fetchUpstreamModels((inst && pool.instances.get(inst)) || cfg, ch));
    admin.setSyncFn((inst) => syncModels((inst && pool.instances.get(inst)) || cfg));
    admin.setBalanceFn((c, ch, cb) => fetchChannelBalance(c, ch, cb));
    poolLoadAll(pool, cfg);
    log(`ai-gateway v${VERSION} 就绪 (多实例单进程模式):`);
    log(`  主端口 ${pool.mainHost}:${pool.mainPort}${pool.mainTlsPort ? ' (https:' + pool.mainTlsPort + ')' : ''}  →  /实例名/v1/... 访问对应实例, 无前缀 = default`);
    for (const [name, c] of pool.instances) {
      const ports = [];
      for (const srv of pool.servers.values()) if (srv.name === name) ports.push((srv.tls ? 'https:' : '') + srv.port);
      log(`  实例 ${name}${c._disabled ? ' [已停用]' : ''}: ${c.channels.length} 渠道${ports.length ? ', 端口 ' + ports.join(',') : ''}`);
      for (const ch of c.channels) log(`    渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
    }
    return Promise.resolve({ pool, port: pool.mainPort, host: pool.mainHost, cfg });
  }

  // ===== 单实例模式(独立运行/测试) =====
  admin.setUpstreamModels(ch => fetchUpstreamModels(cfg, ch));
  admin.setSyncFn(() => syncModels(cfg));
  admin.setBalanceFn((c, ch, cb) => fetchChannelBalance(c, ch, cb));
  setupModelSync(cfg);
  loadKeyUsage(cfg);
  setupProbe(cfg);
  if (PLUGINS) { try { PLUGINS.activateInstance(cfg._name || 'default', cfg, makeGatewayApi(cfg)); } catch (e) { logErr('[plugins] 激活失败: ' + e.message); } }
  cfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] };
  const handler = (req, res) => {
    handleHttp(cfg, req, res).catch(e => {
      logErr('handler crash:', e);
      sendError('openai', res, 500, 'internal: ' + (e && e.message));
    });
  };
  const host = opts.host || cfg.listen.host;
  const port = opts.port != null ? opts.port : cfg.listen.port;

  // 检查 TLS 证书是否可用
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
    // 纯 HTTP 模式
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

  // TLS 模式: 如果 tls.port 独立指定 → HTTP + HTTPS 双开; 否则纯 HTTPS
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

    // HTTPS 服务器
    const httpsServer = https.createServer({ cert: tlsCfg.cert, key: tlsCfg.key }, handler);
    httpsServer.once('error', onErr);
    httpsServer.listen(httpsPort, host, () => {
      httpsServer.removeAllListeners('error');
      onReady(httpsServer, httpsServer.address().port, 'https');
    });

    // HTTP 服务器(双开模式)
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


/* ================= 多实例池 (单进程托管全部实例) ================= */
// 一个进程加载目录下所有 config*.json:
//   - 主端口(default 实例 listen.port)按 /实例名/ 路径前缀路由到对应实例, 无前缀路径归 default
//   - 各实例原有 listen.port / tls.port 继续监听(兼容旧客户端, 直达该实例无需路径前缀)
//   - 配置保存 / 实例增删改 / 启停 全部热生效, 无需重启进程
const INST_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
// 路径第一段保留字: 永不按实例名路由(避免与 API/管理端点打架)
const RESERVED_PATHS = new Set(['v1', 'v1beta', 'v1alpha', 'admin', 'health', 'status', 'favicon.ico', 'robots.txt', 'credits', 'auth', 'plugins', 'user', 'dashboard']);
// 上游余额透传(OpenAI 语义计费端点): 带/不带 /v1 前缀都认(部分老客户端把 base 配成不带 /v1 的域名)
// 别名尽量覆盖常见客户端/中转工具的「查余额」路径; 命中即走 fetchBalanceCached 查上游账户余额
const BILLING_PATHS = new Set([
  // OpenAI 官方 dashboard billing(第三方客户端/中转面板常见)
  '/v1/dashboard/billing/credit_grants', '/dashboard/billing/credit_grants',
  '/v1/dashboard/billing/subscription', '/dashboard/billing/subscription',
  // 通用别名(one-api/new-api/中转面板/各 AI 客户端 的「余额获取路径」变体)
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
// 这些路径返回「通用余额形态」(带 total_remain / balance / data.*, 兼容各家「JSON 键」配置);
// 其余(OpenAI dashboard 两个)保持官方形状
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
let CUR_POOL = null;

function setupModelSync(cfg) {
  teardownModelSync(cfg);
  if (!(cfg.modelSync && cfg.modelSync.enable !== false)) return;
  const hrs = Math.max(1, Number(cfg.modelSync.intervalHours) || 24);
  const run = () => syncModels(cfg).catch(e => logErr('[sync:' + instName(cfg) + '] 定时任务出错:', e.message));
  cfg._syncTimer0 = setTimeout(run, 30000); // 启动 30 秒后首次同步, 不阻塞启动
  cfg._syncTimer = setInterval(run, hrs * 3600 * 1000);
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
  };
  pool.reload = (name) => poolLoadInstance(pool, name);
  pool.removeInst = (name) => poolRemoveInstance(pool, name);
  pool.renameInst = (a, b) => poolRenameInstance(pool, a, b);
  return pool;
}

// 读取实例 TLS 证书(带缓存; 失败返回 null 并警告)
function readTlsCfg(cfg) {
  if (!(cfg.tls && cfg.tls.enable)) return null;
  if (cfg._tlsCache) return cfg._tlsCache;
  const base = path.dirname(cfg._configFile || process.cwd());
  const certPath = path.isAbsolute(cfg.tls.cert) ? cfg.tls.cert : path.join(base, String(cfg.tls.cert || 'cert.pem'));
  const keyPath = path.isAbsolute(cfg.tls.key) ? cfg.tls.key : path.join(base, String(cfg.tls.key || 'key.pem'));
  try {
    cfg._tlsCache = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), port: cfg.tls.port };
  } catch (e) {
    logErr('[pool] 实例 ' + instName(cfg) + ' TLS 证书读取失败(' + e.message + '), 该实例 HTTPS 端口跳过');
    return null;
  }
  return cfg._tlsCache;
}

// 计算当前应该监听的端口集合: 主端口(default) + 各启用实例的兼容端口
function poolDesiredPorts(pool) {
  const d = new Map(); // key → { name, port, tls, tlsCfg, main }
  const def = pool.instances.get('default');
  if (!def) return d;
  const mainPort = def.listen.port;
  pool.mainPort = mainPort;
  pool.mainTlsPort = 0;
  const defTls = readTlsCfg(def);
  if (defTls && (defTls.port == null || Number(defTls.port) === Number(mainPort))) {
    // 主端口纯 HTTPS（tls.port 留空或与主端口相同）
    d.set('https:' + mainPort, { name: 'default', port: mainPort, tls: true, tlsCfg: defTls, main: true });
    pool.mainTlsPort = mainPort;
  } else {
    d.set('http:' + mainPort, { name: 'default', port: mainPort, tls: false, main: true });
    if (defTls && defTls.port != null && defTls.port !== mainPort) {
      d.set('https:' + defTls.port, { name: 'default', port: defTls.port, tls: true, tlsCfg: defTls, main: true });
      pool.mainTlsPort = defTls.port;
    }
  }
  // 各启用实例的兼容端口(禁用实例不开)
  for (const [name, cfg] of pool.instances) {
    if (name === 'default' || cfg._disabled) continue;
    const p = cfg.listen.port;
    const tc = readTlsCfg(cfg);
    // 同端口纯 HTTPS: tls.port 留空, 或显式等于 listen.port
    const pureHttps = !!(tc && (tc.port == null || Number(tc.port) === Number(p)));
    if (p && p !== mainPort && !d.has('http:' + p) && !d.has('https:' + p)) {
      if (pureHttps) d.set('https:' + p, { name, port: p, tls: true, tlsCfg: tc });
      else d.set('http:' + p, { name, port: p, tls: false });
    }
    if (!pureHttps && tc && tc.port != null && tc.port !== mainPort && !d.has('http:' + tc.port) && !d.has('https:' + tc.port))
      d.set('https:' + tc.port, { name, port: tc.port, tls: true, tlsCfg: tc });
  }
  return d;
}

// 对比目标端口与实际监听, 增删 server (热加载时端口变化即时生效)
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
  handleHttp(CUR_CFG, req, res).catch(e => {
    logErr('handler crash:', e);
    sendError('openai', res, 500, 'internal: ' + (e && e.message));
  });
}

// 加载/热重载一个实例; 返回 cfg 或 null(配置文件不存在)
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
  loadKeyUsage(cfg); // 读回卡密用量
  // 热重载继承旧 cfg 的 usedTokens(取大值, 防清零用户额度)
  if (old && Array.isArray(old.apiKeys)) {
    const oldMap = {}; for (const k of old.apiKeys) oldMap[k.key] = k.usedTokens || 0;
    for (const k of (cfg.apiKeys || [])) k.usedTokens = Math.max(k.usedTokens || 0, oldMap[k.key] || 0);
  }
  cfg._stats = (old && old._stats) || { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] }; // 热重载保留统计
  pool.instances.set(name, cfg);
  setupModelSync(cfg);
  setupProbe(cfg);
  if (PLUGINS) { try { PLUGINS.activateInstance(name, cfg, makeGatewayApi(cfg)); } catch (e) { logErr('[plugins] 激活失败 ' + name + ': ' + e.message); } }
  poolReconcilePorts(pool);
  return cfg;
}

function poolLoadAll(pool, defaultCfg) {
  defaultCfg._name = 'default';
  defaultCfg._disabled = !!defaultCfg.disabled;
  defaultCfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] };
  pool.instances.set('default', defaultCfg);
  setupModelSync(defaultCfg);
  if (PLUGINS) { try { PLUGINS.activateInstance('default', defaultCfg, makeGatewayApi(defaultCfg)); } catch (e) { logErr('[plugins] default 激活失败: ' + e.message); } }
  let files = [];
  try { files = fs.readdirSync(pool.dir); } catch (_) {}
  for (const f of files.sort()) {
    const m = /^config\.([A-Za-z0-9_-]{1,32})\.json$/.exec(f);
    if (!m || pool.instances.has(m[1])) continue;
    try { poolLoadInstance(pool, m[1]); log('[pool] 实例 ' + m[1] + ' 已加载 (' + (pool.instances.get(m[1]).channels.length) + ' 渠道)'); }
    catch (e) { logErr('[pool] 实例 ' + m[1] + ' 配置加载失败: ' + e.message); }
  }
  poolReconcilePorts(pool);
}

function poolRemoveInstance(pool, name) {
  const old = pool.instances.get(name);
  if (old) teardownModelSync(old);
  if (PLUGINS) { try { PLUGINS.deactivateInstance(name); } catch (_) {} }
  pool.instances.delete(name);
  poolReconcilePorts(pool);
}

function poolRenameInstance(pool, oldName, newName) {
  const cfg = pool.instances.get(oldName);
  if (!cfg) return false;
  pool.instances.delete(oldName);
  cfg._name = newName;
  cfg._configFile = path.join(pool.dir, 'config.' + newName + '.json');
  pool.instances.set(newName, cfg);
  poolReconcilePorts(pool);
  return true;
}

// 请求路由: 兼容端口按端口绑定直达, 主端口按 /实例名/ 路径前缀, 否则 default
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
    const rest = p.slice(name.length + 1) || '/';
    return { cfg, path: rest, name, via: 'path' };
  }
  const cfg = pool.instances.get('default');
  if (!cfg) return { error: 'default 实例不存在', status: 503 };
  return { cfg, path: p, name: 'default', via: 'default' };
}

/* ================= main ================= */
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
  process.on('SIGTERM', () => { const cs = CUR_POOL ? [...CUR_POOL.instances.values()] : [cfg]; for (const c of cs) { try { saveKeyUsage(c); } catch (_) {} } try { PLUGINS && PLUGINS.flushAll(); } catch (_) {} process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
  // 默认多实例单进程模式(托管目录下全部 config*.json); AGW_SINGLE=1 或显式端口参数时退回单实例
  const multi = portOverride == null && process.env.AGW_SINGLE !== '1';
  startServer(cfg, { port: portOverride, multi }).catch(e => { logErr('启动失败:', e.message); process.exit(1); });
}

if (require.main === module) main();

module.exports = {
  VERSION, loadConfig, normalizeProxy, joinUrl, pickChannel, pickChannels, collectModels, RETRYABLE,
  openaiToCanonical, claudeToCanonical, geminiToCanonical,
  canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody,
  openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical,
  canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp,
  responsesToCanonical, canonicalToResponsesBody, responsesRespToCanonical, canonicalToResponsesResp,
  ResponsesStreamParser, makeResponsesWriter, chUsesResponses, buildRequestForChannel,
  SSEDecoder, UpstreamStreamParser, makeWriter, claudeFinish, geminiFinish,
  socks5Connect, httpConnect, dialViaProxy, makeReader,
  truncateReasoning, summarizeReasoningText, wrapThinkingSummary, callUpstreamText,
  startServer, checkAuth,
  balanceTarget, presetForChannel, fetchChannelBalance, fetchBalanceCached, pickBalanceChannel, BALANCE_PRESETS,
  balanceChannelList, balanceAggregate, balanceFxRate,
  createInstancePool, poolLoadAll, poolLoadInstance, poolRemoveInstance, poolRenameInstance, poolRoute,
  RESERVED_PATHS, INST_NAME_RE,
  loadKeyUsage, saveKeyUsage, keyUsageFile,
  hashPassword, verifyPassword, keyCreditsJSON, genApiKey,
  probeRound, probeOnce, setupProbe,
};
