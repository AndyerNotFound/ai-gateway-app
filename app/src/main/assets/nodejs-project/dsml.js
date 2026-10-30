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
const { log, randId, utf8, rpApplyText, rpWalk, safeParse, logErr } = require('./util');
const { SSEParser, serializeEvent, isDoneEvent, jsonish } = require('./sse');
const { cfgDirOf } = require('./router');

// ================= DSML tool-call parsing/scrubbing (formerly inlined in gateway.js) =================
const DSML_TAG_MAX = 256;      // max believable length of a single tag (longer = treat as plain text)
const DSML_WS_MAX = 1024;      // max trailing whitespace deferred (beyond that, just release)
const DSML_BLOCK_MAX = 65536;  // max characters swallowed per markup block (beyond that, fail open)
/* Markup prefix dialects (three observed): (1) the bar with DSML in it (2) fully bare <invoke ...> (3) only the bar left, like <|tool_calls>.
 *   (1)(2) are recognized by tag name; (3) requires "bar before the keyword" so content like <div data-k="a|b"> is not misread as markup. */
const DSML_OPEN_CALLS = /<(?![\/])[^>]*DSML[^>]*(?:tool_)?calls>/i;         // (1) DSML-bearing is authoritative (avoids eating content)
const DSML_OPEN_CALLS_WEAK = /<(?![\/])[^>]*[｜|][^>]*(?:tool_)?calls>/i;   // (3) no DSML text left, only the bar prefix
const DSML_OPEN_INVOKE = /<(?![\/])(?:[^>]*[｜|][^>]*)?invoke\b[^>]*>/i;
/* *Closing tags / inner tags may appear bare without the DSML prefix: verified that deepseek-v4.1-flash (NIM) only puts the bar on the outer tag,
 *   the inner layer is <invoke name="..."> / <parameter ...> / </invoke> / </tool_calls> -- earlier versions demanded a DSML marker on the terminator,
 *   the terminator was never found, everything got eaten to stream end: content was wiped clean yet never counted as a "block end", so backfill never fired (verified 2026-10-16). */
const DSML_CLOSE_CALLS = /<\/(?:[^>]*[｜|][^>]*)?(?:tool_)?calls>/i;
const DSML_CLOSE_INVOKE = /<\/(?:[^>]*[｜|][^>]*)?invoke>/i;
const DSML_ANY_TAG = /<[^>]*DSML[^>]*>/i;
const DSML_BAR_KEY = /<[^>]*[｜|][^>]*(?:calls|invoke|parameter)\b/i;        // generic (3) recognizer (bar + keyword)
const DSML_BLOCK_TAG = /<\/?(?:[^>]*[｜|][^>]*)?(?:invoke|parameter|tool_calls|calls)\b[^>]*>/i;   // in-block / block-end tag
const DSML_INVOKE_ANY = /<(?![\/])(?:[^>]*[｜|][^>]*)?invoke\b([^>]*)>([^]*?)<\/(?:[^>]*[｜|][^>]*)?invoke>/ig;
const DSML_PARAM_ANY = /<(?![\/])(?:[^>]*[｜|][^>]*)?parameter\b([^>]*)>([^]*?)<\/(?:[^>]*[｜|][^>]*)?parameter>/ig;
const DSML_ATTR_NAME = /name\s*=\s*[\"']([^\"']+)[\"']/i;
const DSML_CALLS_TAG = /<\/?[^>]*[｜|][^>]*(?:tool_)?calls>/ig;
/* Textual call -> [{name, arguments}]. Values are taken as raw strings; if the whole block is a JSON object/array it is parsed as such
 * (some MCP tools expect object arguments). Returns null when unparseable. */
function dsmlParseCall(block) {
  if (!block) return null;
/* *No longer strictly requires "DSML" inside a block: upstream variants emit bare tags (tool_calls/invoke/parameter), or even just JSON.
   *   requires only "structurally call-like" (invoke/parameter/tool_calls tags, or a name= attribute); otherwise untouched. */
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
return dsmlParseCallLoose(body);       // (2) loose fallback: missing </invoke> / self-closing / bare JSON shapes
}
/* (2) Loose fallback -- targets "structurally incomplete" upstream variants (rare, but they demonstrably cause whole blocks to be dropped = blank output):
 *     a) the model omits </invoke> or uses self-closing <invoke name="x"/> -> standard pairing regexes fail;
 *     b) <parameter ...> may likewise omit </parameter>;
 *     c) the whole block is actually JSON: {"name":"x","arguments":{...}} / [{"name":...}] / {"tool_calls":[...]}
 *   paired closing is no longer required: the first invoke/function/tool/call tag's name= in the block becomes the function name, and all parameters after it belong to it. */
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
/* Loose parameter scan: </parameter> is not required -- a parameter's value runs from one <parameter ...> to the next <parameter or the block end */
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
    const closeRe = /[<＜]\/(?:[^>＞]*[｜|])?parameter\s*[>＞]/ig;
    closeRe.lastIndex = marks[i].start;
    const cm = closeRe.exec(body);
    if (cm && cm.index < end) end = cm.index;
    let v = body.slice(marks[i].start, end)
                  .replace(/<\/(?:[^>]*?)(?:parameter|invoke|tool_calls|calls)>/ig, '')
                  .trim();
    const t0 = v.charAt(0);
    if (t0 === '{' || t0 === '[') { try { const j = JSON.parse(v); if (j && typeof j === 'object') v = j; } catch (_) {} }
    args[pn[1]] = v;
  }
  return Object.keys(args).length ? args : null;
}
/* Backfill gate: the function name must match a tool the client declared this round, otherwise no backfill (prevents "discussing DSML syntax" from conjuring a call) */
/* *Evidence: every case of "markup block eaten but not backfilled" writes a line to log/dsml-miss.log
 *   (on by default; AGW_DSML_MISS_LOG=off disables, or set an absolute path). Write failures silence it automatically without touching the main flow. */
let _dsmlMissOff = false;
function dsmlMissPath() {
  try {
    return process.env.AGW_DSML_MISS_LOG || (((typeof __dirname !== 'undefined') ? __dirname : '.') + '/data/log/dsml-miss.log');
  } catch (_) { return './data/log/dsml-miss.log'; }
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
/* Backfill gate: the function name must match a tool the client declared this round (prevents "discussing DSML syntax" from conjuring a call).
 *   *2026-10-16 relaxation (verified: identical names still missed due to case/namespace differences -> whole blocks silently lost):
 *     fully identical names -> normalized names -> single-call fallback (prefer backfill over silently losing content); every relaxation/failure leaves evidence. */
function dsmlPickCall(calls, toolNames) {
  if (!calls || !calls.length) return null;
if (!toolNames) return null;                                       // no tools declared by the client -> conjure nothing
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
if (calls.length === 1) {                                          // single call: backfill even when the name misses (otherwise the whole block is lost)
    dsmlMissDump('pick-single-fallback', calls[0].name, 'declared=' + [...toolNames].join('|'));
    return calls[0];
  }
  dsmlMissDump('pick-rejected', calls.map(c => c.name).join('|'), 'declared=' + [...toolNames].join('|'));
  return null;
}
const DSML_TEXT_FIELD_RE = /^(content|text)$/;                              // content-type fields
const DSML_THINK_FIELD_RE = /^(reasoning_content|reasoning|thinking)$/;     // thinking-type fields

function dsmlNewState(canCall) { return { eat: null, held: '', pool: '', pend: '', polar: false, warned: false, canCall: !!canCall, call: null, openTag: '' }; }
function dsmlActive(st) { return !!(st && (st.pend || st.held || st.eat)); }
/* Feed a content fragment -> returns the text that can go to the client right now (may be empty: eaten or deferred)
 * State fields:
 *   eat   non-empty = currently swallowing a markup block ('calls' | 'invoke')
 *   pool  block text already swallowed, kept only to be returned verbatim on fail-open
 *   held  an unclosed tag tail (waiting for later fragments to complete it)
 *   pend  an unclassified tail (whitespace [+ half a closing tag]): dropped together if a block end like "</...calls>" follows
 *   polar = just exited a block, bailed out by an inner closing tag -- whitespace is deferred only in this phase (until it is clear whether this is a block end)
 */
/* At EOF an unclosed "<..." tail may be a truncated DSML tag.  Any classifier that guesses
 * from nearby words ("calls"/"invoke"/"parameter") eats ordinary prose such as
 * "if n < 16 the parameter is ignored" -- the exact character-loss bug this pipeline must not
 * reintroduce.  Only unmistakable markup prefixes are discarded here: DSML markers,
 * bar-prefixed tags and closing tags.  A bare "<invoke"/"<tool_calls" at EOF is released as
 * text, because it cannot be distinguished from prose; leaking a short tag fragment is
 * strictly better than losing a sentence. */
function dsmlOrphanIsMarkup(s) {
  const t = String(s == null ? '' : s).replace(/^[<＜]/, '');
  if (!t) return false;
  if (/^[｜|]?DSML(?:[｜|]|\b)/i.test(t)) return true;
  if (/^\/?[｜|](?:tool_calls|calls|invoke|parameter)\b/i.test(t)) return true;
  if (/^\/(?:tool_calls|calls|invoke|parameter)\b/i.test(t)) return true;
  return false;
}

/* A swallowed block at EOF is safe to discard only when nothing but markup tags
 * and whitespace is left.  If ordinary prose remains ("x <invoke> y z"), releasing
 * the whole tail is the only way to guarantee no character loss. */
function dsmlOrphanPureMarkup(s) {
  let t = String(s == null ? '' : s).replace(/^[<＜]/, '');
  t = t.replace(/^\//, '').replace(/^[｜|]/, '');
  const m = /^DSML[｜|]/i.exec(t);
  if (m) t = t.slice(m[0].length);
  if (t === '') return true;
  return /^[A-Za-z][A-Za-z0-9_.:-]*(?:\s+[A-Za-z_:][-A-Za-z0-9_.:]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+))*\s*\/?\s*$/.test(t);
}

function dsmlPureMarkup(s) {
  const t = String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/＜[^＞]*＞/g, '')
    .replace(/[<>＜＞｜|\s]/g, '');
  return t === '';
}

/* Prose after the last DSML-family tag belongs to the client.  Do not anchor on
 * arbitrary "<...>" spans: a sentence like "当 n < 16 且 m > 3 时" contains both
 * brackets and would otherwise be mistaken for a tag. */
function dsmlTagIsFamily(tag) {
  const n = String(tag).replace(/＜/g, '<').replace(/＞/g, '>');
  if (/(?:DSML|[｜|])/i.test(n)) return true;
  return /^<\/?(?:invoke|parameter|tool_calls|calls)\b/i.test(n);
}
function dsmlTrailingProse(s) {
  const t = String(s == null ? '' : s);
  const re = /[<＜][^<>＜＞]*[>＞]/g;
  let m, last = null;
  while ((m = re.exec(t)) !== null) if (dsmlTagIsFamily(m[0])) last = m;
  if (!last) return '';
  const after = t.slice(last.index + last[0].length);
  if (!after.trim()) return '';
  const tag = last[0].replace(/＜/g, '<').replace(/＞/g, '>');
  if (/^<(?!\/)(?:[^>]*[｜|])?parameter\b/i.test(tag)) return '';
  return after;
}

/* A complete block is safe to drop only when it contains no ordinary text outside
 * <parameter> elements (and outside an unclosed parameter value). */
function dsmlBlockHasProse(block) {
  let t = String(block == null ? '' : block);
  t = t.replace(/[<＜](?!\/)(?:[^>＞]*[｜|])?parameter\b[^>＞]*[>＞][\s\S]*?[<＜]\/(?:[^>＞]*[｜|])?parameter\s*[>＞]/gi, '');
  t = t.replace(/[<＜](?!\/)(?:[^>＞]*[｜|])?parameter\b[^>＞]*[>＞][\s\S]*$/i, '');
  t = t.replace(/[<＜][^<>＜＞]*[>＞]/g, '').replace(/[<>＜＞｜|\s]/g, '');
  return t !== '';
}

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
/* *Closing tags also arrive split across chunks (</ + bar + tool_calls>); the eating state must keep a tail fragment for reassembly --
         *   the whole segment went into pool, the closing tag could never be reassembled and the block ate all following content (reproduced). */
        const keep = Math.min(scoped.length, DSML_TAG_MAX);
        if (scoped.length > keep) st.pool += scoped.slice(0, scoped.length - keep);
        st.held = scoped.slice(scoped.length - keep);
if (st.pool.length + st.held.length > DSML_BLOCK_MAX) {   // (3) fail open: put back verbatim, never eat content
          dsmlMissDump('oversize-failopen', (st.openTag || '') + st.pool + st.held);
          if (!st.warned) { st.warned = true; try { log('[dsml] 吞吃 ' + (st.pool.length + st.held.length) + ' 字符仍未见结束标记, 判定为正文, 原样放行'); } catch (_) {} }
          out += (st.openTag || '') + st.pool + st.held; st.pool = ''; st.held = ''; st.openTag = ''; st.eat = null;
        }
        break;
      }
      const blockTxt = (st.openTag || '') + st.pool + st.held + scoped.slice(0, m.index + m[0].length);
if (st.canCall) {                                   // markup block inside content -> parse first (backfill needs it), then drop
        let cs = null;
        try { cs = dsmlParseCall(blockTxt); } catch (e) { dsmlMissDump('parse-throw', blockTxt, e && e.message); }
        if (cs && !dsmlBlockHasProse(blockTxt)) st.call = (st.call || []).concat(cs);
        else {
          dsmlMissDump(cs ? 'block-prose-failopen' : 'block-unparsed', blockTxt, fb ? 'closed-by-</invoke>' : null);
out += blockTxt;                                  // fail open: an unparseable block / a block with prose is never silently eaten
        }
} else out += blockTxt;                             // thinking fields never parse calls; keep their text
buf = scoped.slice(m.index + m[0].length);          // drop the whole block (closing tag included)
      st.pool = ''; st.held = ''; st.openTag = ''; st.eat = null; st.polar = fb; pos = 0;
      if (fb) polarAt = out.length;
      continue;
    }
    let i = buf.indexOf('<', pos);
    const iF = buf.indexOf('＜', pos);
if (iF >= 0 && (i < 0 || iF < i)) i = iF;    // *full-width opening bracket also counts as a tag start (leak prevention)
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
if (buf.length - i > DSML_TAG_MAX) { out += buf.slice(i); break; }   // cannot grow into a tag -> release
st.pend = ws;                                                      // whitespace must precede the tag
st.held = buf.slice(i);                                            // unclosed: defer until later fragments complete it
      break;
    }
    const tag = buf.slice(i, j + 1);
const isDsml = DSML_ANY_TAG.test(tag) || DSML_BAR_KEY.test(tag) || DSML_BLOCK_TAG.test(tag);   // *bare calls/invoke/parameter count as markup (prefer over-eating; markup must never leak to the client)
    if (isDsml && (tag.charAt(1) === '/' || tag.charAt(1) === '／')) {   // 孤立的块结束标记 → 连同它前面的空白一起丢
      const normTag = tag.replace(/＜/g, '<').replace(/＞/g, '>').replace(/／/g, '/');
      if (!/^<\/(?:[^>]*[｜|][^>]*)?(?:tool_calls|calls|invoke|parameter)\s*>$/i.test(normTag)) {
        out += pre + tag; pos = j + 1; continue;           // "</invoke 温度 >" is prose, not a closing tag
      }
      out += st.polar ? pre.replace(/[ \t\r\n]+$/, '') : pre;
      pos = j + 1;
      continue;
    }
    out += pre;
    if (!isDsml) {
/* (2) Fully bare dialect (<tool_calls> without even a bar): by design the opening tag is not let through (to avoid eating content that discusses the format), but evidence is kept */
      if (!st.bareWarn && /^<\/?(?:tool_)?calls>$/i.test(tag)) {
        st.bareWarn = true;
        dsmlMissDump('bare-open-tag-leak', buf.slice(i, i + 240), '无前缀开始标记(疑似②全裸方言)');
      }
      out += tag; pos = j + 1; continue;
}   // ordinary tags (<div>, "a < b") -> verbatim    // ordinary tags (<div>, "a < b>") -> verbatim
    st.polar = false;
    if (DSML_OPEN_CALLS.test(tag) || DSML_OPEN_CALLS_WEAK.test(tag)) { st.eat = 'calls'; st.pool = ''; st.openTag = tag; pos = j + 1; continue; }
    if (DSML_OPEN_INVOKE.test(tag)) { st.eat = 'invoke'; st.pool = ''; st.openTag = tag; pos = j + 1; continue; }
pos = j + 1; continue;                                 // other stray DSML tags -> drop
  }
if (st.polar && polarAt >= 0 && /\S/.test(out.slice(polarAt))) st.polar = false; // non-whitespace emitted -> no longer in the "block-end phase"
  if (final) {
if (st.eat) {                                          // (4) block still open at EOF: parse calls, drop pure markup, release prose
      const tail = (st.openTag || '') + st.pool + st.held;
let cs = null;                                       // *never discard on truncation either: backfill whenever a call can be assembled (the main blank-output source among rare variants)
      if (st.canCall) { try { cs = dsmlParseCall(tail); } catch (_) {} }
      const prose = dsmlTrailingProse(tail);
      const head = prose ? tail.slice(0, tail.length - prose.length) : tail;
      const insideProse = dsmlBlockHasProse(head);
      const hasProse = dsmlBlockHasProse(tail);
      const hasParam = /[<＜](?!\/)(?:[^>＞]*[｜|])?parameter\b/i.test(head);
      if (cs && !insideProse && (!prose || hasParam)) {
        st.call = (st.call || []).concat(cs);
        if (prose) out += prose;
      } else if (tail.trim() && !hasProse) dsmlMissDump('truncated-drop', tail, 'len=' + tail.length);
      else if (tail.trim()) {
        out += tail;
        dsmlMissDump('truncated-released', tail, 'len=' + tail.length);
      }
      if (!st.warned) {
        st.warned = true;
        try { log('[dsml] 流结束标记块仍未闭合(上游截断), ' + (cs && !insideProse ? '已尽力回填 ' + cs.length + ' 个调用' : (hasProse ? '正文原样放行 ' + tail.length + ' 字符' : '已丢弃 ' + tail.length + ' 字符'))); } catch (_) {}
      }
      st.pool = ''; st.held = ''; st.pend = ''; st.eat = null; st.openTag = '';
    } else {
      const orphan = st.pend + st.held;
/* *If the "unclosed tail" released at stream end belongs to the markup family (<...calls/invoke/parameter, or containing full/half-width bars), it must never be emitted as content --
       *   full-width '>' keeps a tag "unclosed" forever, leaking <| calls> verbatim to the client at finalization (user-confirmed 2026-10-16). */
      if (orphan && dsmlOrphanIsMarkup(orphan) && dsmlOrphanPureMarkup(orphan)) {
        dsmlMissDump('orphan-tag-released', orphan, 'hex=' + Buffer.from(orphan, 'utf8').toString('hex').slice(0, 300));
} else if (orphan) out += orphan;                    // an unclosed ordinary tail goes out as content (no loss)
      st.pend = ''; st.held = '';
    }
  }
  return out;
}
/* Whether the streaming chunk is left with "nothing at all" after scrubbing (no delta content, no finish_reason/usage/message) */
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
/* One state machine per field path (e.g. choices[0].delta.content); scrubs content/thinking fields in the response object.
 * Only whitelisted fields are touched -- role/id/model/finish_reason/tool args are never modified. Returns whether any rewrite happened. */
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
      if (val.indexOf('<') < 0 && val.indexOf('＜') < 0 && !dsmlActive(st)) continue;   // 快路径: 没 '<' 且状态空闲 → 不建状态、不解析
      const s2 = st || dsmlNewState(isText);
      if (!st) { s2.think = !isText; states.set(p, s2); }
      const nt = dsmlFeed(s2, val, final);
      if (nt !== val) {
        changed = true;
/* *If only whitespace remains after scrubbing (the whole delta was markup +/- newlines) -> drop the field entirely.
         *   keeping content:"" made clients insert an empty content segment between thinking and tool calls (reproduced 2026-10-16). */
        if (nt === '' && p.indexOf('.delta.') >= 0) delete v[k];
        else v[k] = nt;
      }
    }
  };
  walk(j, '', 0);
  return changed;
}
/* Passthrough rewrite pipe (2026-10-15): carries both inc text replacement and built-in DSML scrubbing
 * *finalization (trailing partial line + state-machine residue) happens entirely inside this pipe: no bytes are lost even when the upstream's last line lacks a newline (the old res.end()-first version lost them).
 * *only the line that truly needs a rewrite is re-serialized; every other line passes through byte-for-byte. */
/* ---- DSML diagnostics log (records only while <instance-dir>/.dsml-diag exists; logs "shape" only, never content) ----
 * Purpose: diagnosing whether textual calls / empty chunks / backfill happened -- logs per response the field chunk count, whether DSML was seen,
 * the parsed function name, structured call count, finish in/out values, and whether backfill ran. No content is ever written. */
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
fs.mkdirSync(path.dirname(dsmlDiagCache.file), { recursive: true });   // create the log dir when missing, otherwise the write fails silently
    fs.appendFileSync(dsmlDiagCache.file, JSON.stringify(Object.assign({ t: new Date().toISOString() }, rec)) + '\n');
  } catch (_) {}
}

function makeDirectPipe(res, rpInc, dsmlOn, dsmlThink, isStream, opts) {
  const u8 = utf8();
  const states = new Map();
  const toolNames = (opts && opts.toolNames) || null;
  const onDiag = (opts && opts.onDiag) || null;
  const isSSE = !!(opts && opts.isSSE != null ? opts.isSSE : isStream);
  const appendDone = !(opts && opts.appendDone === false);
  const cleanDSML = !!dsmlOn && !isStream;   // stream-process cleaning removed: never scrub a stream
  let buf = '';
  let lastObj = null;
  let closed = false;
  let finished = false;
  let pending = null;
  let sawDone = false;
  let ring = [];
  let wireLogged = false;
  let lastWriteOk = true;
  let claudeTextIdx = null;
  let claudeThinkIdx = null;
  let lastEventName = '';
  let lastEventId = null;
  const stat = { reasoning: 0, content: 0, emptied: 0, blocks: 0, structured: 0, finishIn: null, finishOut: null, backfill: null, dsmlSeen: false, names: [] };

  const write = (s) => {
    if (finished || !s) return true;
    try { lastWriteOk = res.write(s); } catch (_) { finished = true; lastWriteOk = true; }
    return lastWriteOk;
  };
  const anyActive = () => { for (const st of states.values()) if (dsmlActive(st)) return true; return false; };
  const clone = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return null; } };
  const openaiShaped = () => !!(lastObj && Array.isArray(lastObj.choices));

  const writeEventObj = (obj, ev, eventName) => {
    const en = eventName || (ev && ev.event) || lastEventName;
    const id = ev && ev.id != null ? ev.id : lastEventId;
    write(serializeEvent({ event: en, id: id, retry: ev && ev.retry }, [JSON.stringify(obj)]));
  };
  const writeEventDelta = (deltaObj, ci, ev, finishReason) => {
    if (!openaiShaped()) return;
    const t = clone(lastObj);
    if (!t) return;
    delete t.usage;
    t.choices = [{ index: ci || 0, delta: deltaObj, finish_reason: finishReason || null }];
    writeEventObj(t, ev);
  };
  const emitCalls = (calls, ci, ev) => {
    if (!openaiShaped()) { stat.backfill = stat.backfill || 'unsupported-format'; return; }
    for (let k = 0; k < calls.length; k++) {
      const c = calls[k];
      writeEventDelta({ tool_calls: [{ index: k, id: randId('call_dsml_'), type: 'function', function: { name: c.name, arguments: '' } }] }, ci, ev);
      writeEventDelta({ tool_calls: [{ index: k, function: { arguments: c.arguments } }] }, ci, ev);
    }
  };
  const collect = () => {
    let out = null;
    for (const st of states.values()) if (st.call) { out = (out || []).concat(st.call); st.call = null; }
    if (out) { stat.blocks += out.length; for (const c of out) stat.names.push(c.name); pending = (pending || []).concat(out); }
  };
  const emitDeferred = (text, thinking, ev) => {
    if (!text) return;
    const last = lastObj;
    if (last && Array.isArray(last.choices)) {
      writeEventDelta(thinking ? { reasoning_content: text } : { content: text }, 0, ev);
      return;
    }
    if (last && typeof last === 'object' && (last.type || claudeTextIdx != null || claudeThinkIdx != null)) {
      const idx = thinking ? (claudeThinkIdx != null ? claudeThinkIdx : 0) : (claudeTextIdx != null ? claudeTextIdx : 0);
      const delta = thinking ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text: text };
      writeEventObj({ type: 'content_block_delta', index: idx, delta: delta }, ev, 'content_block_delta');
      return;
    }
    if (last && Array.isArray(last.candidates)) {
      const part = thinking ? { text: text, thought: true } : { text: text };
      writeEventObj({ candidates: [{ content: { role: 'model', parts: [part] }, index: 0 }] }, ev);
      return;
    }
    write(serializeEvent({ event: (ev && ev.event) || lastEventName, id: (ev && ev.id) || lastEventId }, [JSON.stringify({ content: text })]));
  };
  const finishOf = (j) => {
    if (!j || typeof j !== 'object') return null;
    if (Array.isArray(j.choices)) {
      for (let i = 0; i < j.choices.length; i++) {
        const c = j.choices[i];
        if (c && c.finish_reason) return { kind: 'openai', index: i, value: c.finish_reason, choice: c };
      }
    }
    if (j.type === 'message_delta' && j.delta && j.delta.stop_reason) return { kind: 'claude', value: j.delta.stop_reason };
    if (j.type === 'message_stop') return { kind: 'claude', value: 'stop' };
    if (Array.isArray(j.candidates)) {
      for (let i = 0; i < j.candidates.length; i++) {
        const c = j.candidates[i];
        if (c && (c.finishReason || c.finish_reason)) return { kind: 'gemini', index: i, value: c.finishReason || c.finish_reason };
      }
    }
    return null;
  };
  const flushStates = (ev) => {
    const extra = [];
    for (const st of states.values()) {
      const t = dsmlFeed(st, '', true);
      if (t) extra.push({ t: t, think: !!st.think });
    }
    collect();
    for (const x of extra) emitDeferred(x.t, x.think, ev);
  };
  const wireSample = (bodyTxt) => {
    if (wireLogged || !cleanDSML || bodyTxt.length >= 3000 || !/calls\b|invoke\b|parameter\b/i.test(bodyTxt)) return;
    wireLogged = true;
    dsmlMissDump('wire-chunk-sample', bodyTxt, 'hex=' + Buffer.from(bodyTxt, 'utf8').toString('hex').slice(0, 500));
  };

  const handleSSEEvent = (ev) => {
    if (!ev) return;
    if (!ev.dataLines || !ev.dataLines.length) { write(ev.raw || serializeEvent(ev, [])); return; }
    if (isDoneEvent(ev)) { sawDone = true; return; }
    lastEventName = ev.event || lastEventName;
    if (ev.id != null) lastEventId = ev.id;
    ring.push(ev.data); if (ring.length > 12) ring.shift();
    wireSample(ev.data);
    const j = safeParse(ev.data);
    if (!j || typeof j !== 'object') {
      if (ev.dataLines.length > 1) {
        let each = true;
        for (const l of ev.dataLines) { const t = l.trim(); if (t !== '' && t !== '[DONE]' && !jsonish(t)) { each = false; break; } }
        if (each) {
          for (const l of ev.dataLines) {
            if (l.trim() === '') continue;
            handleSSEEvent({ event: ev.event, data: l, dataLines: [l], id: ev.id, retry: ev.retry, raw: '' });
          }
          return;
        }
      }
      const lines = rpInc.length ? ev.dataLines.map(l => rpApplyText(l, rpInc)) : ev.dataLines;
      write(serializeEvent({ event: ev.event, id: ev.id, retry: ev.retry }, lines));
      return;
    }
    lastObj = j;
    if (j.type === 'content_block_start') {
      const bt = j.content_block && j.content_block.type;
      if (bt === 'text') claudeTextIdx = j.index;
      else if (bt === 'thinking') claudeThinkIdx = j.index;
    } else if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.type === 'text_delta') claudeTextIdx = j.index;
      else if (j.delta.type === 'thinking_delta') claudeThinkIdx = j.index;
    }
    if (cleanDSML && j.type === 'content_block_stop' && anyActive()) flushStates(ev);
    let dirty = false;
    if (rpInc.length) { try { rpWalk(j, rpInc, 0, true); dirty = true; } catch (_) {} }
    let dsmlDirty = false;
    if (cleanDSML) {
      try { dsmlDirty = dsmlCleanRespObj(j, states, false, dsmlThink); } catch (_) {}
      if (dsmlDirty) { stat.emptied++; if (/DSML/i.test(ev.data)) stat.dsmlSeen = true; }
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
      }
      const fin = finishOf(j);
      if (fin && anyActive()) flushStates(ev);
      if (fin) {
        stat.finishIn = stat.finishIn || fin.value;
        if (fin.kind === 'openai' && pending && toolNames && !stat.structured) {
          const pick = dsmlPickCall(pending, toolNames);
          if (pick) {
            emitCalls([pick], fin.index, ev);
            if (fin.choice.finish_reason === 'stop') { fin.choice.finish_reason = 'tool_calls'; dirty = true; }
            stat.backfill = 'no-structured-call→tool_calls';
          } else stat.backfill = 'parsed-call-not-in-declared-tools';
        } else if (stat.structured) stat.backfill = 'already-has-structured-call';
        pending = null;
        stat.finishOut = fin.choice ? fin.choice.finish_reason : fin.value;
      }
    }
    if (dirty || dsmlDirty) {
      if (dsmlDirty && dsmlChunkPayloadEmpty(j)) return;
      writeEventObj(j, ev);
    } else {
      write(ev.raw || serializeEvent(ev, ev.dataLines));
    }
  };

  const parser = new SSEParser({
    onEvent: handleSSEEvent,
    onComment: (raw) => write(raw),
  });

  const handleNonStreamEnd = () => {
    const j = safeParse(buf);
    if (!j || typeof j !== 'object') {
      let out = buf;
      if (rpInc.length) out = rpApplyText(out, rpInc);
      if (out) write(out);
      return;
    }
    lastObj = j;
    let dirty = false;
    if (rpInc.length) { try { rpWalk(j, rpInc, 0, true); dirty = true; } catch (_) {} }
    if (cleanDSML) {
      try {
        if (dsmlCleanRespObj(j, states, true, dsmlThink)) dirty = true;
      } catch (_) {}
      collect();
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
    }
    if (dirty) write(JSON.stringify(j));
    else write(buf);
  };

  const handleGenericStreamEnd = () => {
    if (buf) {
      let tail = buf;
      buf = '';
      if (rpInc.length) tail = rpApplyText(tail, rpInc);
      if (/^\s*data:\s*\[DONE\]\s*$/.test(tail)) sawDone = true;
      write(tail);
    }
  };

  return {
    push(c) {
      if (finished) return true;
      try {
        if (!isStream) { buf += u8(c); return true; }
        if (!isSSE) {
          buf += u8(c);
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const l of lines) {
            const out = rpInc.length ? rpApplyText(l, rpInc) : l;
            if (/^\s*data:\s*\[DONE\]\s*$/.test(out)) sawDone = true;
            write(out + '\n');
          }
          return lastWriteOk;
        }
        parser.push(c);
        return lastWriteOk;
      } catch (e) { logErr('[sse] 流式改写失败:', e.message); return true; }
    },
    end() {
      if (closed) return;
      closed = true;
      try {
        if (!isStream) { handleNonStreamEnd(); }
        else if (!isSSE) { handleGenericStreamEnd(); if (appendDone && !sawDone) write('data: [DONE]\n\n'); }
        else {
          parser.end();
          if (cleanDSML) {
            const wasActive = anyActive();
            if (wasActive) flushStates(null);
            if (pending && toolNames && !stat.structured && openaiShaped()) {
              const pick = dsmlPickCall(pending, toolNames);
              if (pick) {
                emitCalls([pick], 0, null);
                writeEventDelta({}, 0, null, 'tool_calls');
                stat.backfill = stat.backfill || 'end-of-stream→tool_calls';
                stat.finishOut = stat.finishOut || 'tool_calls';
              }
            }
            pending = null;
            if (wasActive) {
              const fin = lastObj && lastObj.choices && lastObj.choices[0] ? lastObj.choices[0].finish_reason : null;
              dsmlMissDump('pipe-final-active', 'finish_reason=' + String(fin) + ' lastObj=' + String(lastObj && JSON.stringify(lastObj)).slice(0, 300) + '\n---lastN---\n' + ring.join('\n'), 'seenDone=' + sawDone);
            }
          }
          if (appendDone || sawDone) write('data: [DONE]\n\n');
        }
        if (onDiag) onDiag(stat);
      } catch (e) { logErr('[dsml] 收尾失败:', e.message); }
      finished = true;
      try { res.end(); } catch (_) {}
    },
  };
}

function dsmlExtractCall(t) {  // non-streaming/cross-format: extract textual calls from a complete text
  if (typeof t !== 'string' || t.indexOf('DSML') < 0) return null;
  const st = dsmlNewState(true);
  try { dsmlFeed(st, t, true); } catch (_) {}
  return st.call || null;
}
function dsmlCleanText(t) {   // non-streaming/cross-format: scrub a whole text at once (full input = final)
  return dsmlFeed(dsmlNewState(true), t, true);
}

/* ---- Config encryption (optional, provided by crypt.js) ---- */
module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, DSML_TAG_MAX, DSML_WS_MAX, DSML_BLOCK_MAX, DSML_OPEN_CALLS, DSML_OPEN_CALLS_WEAK, DSML_OPEN_INVOKE, DSML_CLOSE_CALLS, DSML_CLOSE_INVOKE, DSML_ANY_TAG, DSML_BAR_KEY, DSML_BLOCK_TAG, DSML_INVOKE_ANY, DSML_PARAM_ANY, DSML_ATTR_NAME, DSML_CALLS_TAG, dsmlParseCall, dsmlParseCallLoose, dsmlLooseParams, _dsmlMissOff, dsmlMissPath, dsmlMissDump, dsmlNormName, dsmlPickCall, DSML_TEXT_FIELD_RE, DSML_THINK_FIELD_RE, dsmlNewState, dsmlActive, dsmlFeed, dsmlChunkPayloadEmpty, dsmlCleanRespObj, dsmlDiagCache, dsmlDiagOn, dsmlDiag, makeDirectPipe, dsmlExtractCall, dsmlCleanText };
