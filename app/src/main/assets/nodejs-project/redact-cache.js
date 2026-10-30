/* redact-cache.js -- privacy filter: rule compilation + incremental chunk caching + streaming filter
 *
 * Core idea: every chat request resends the full context, and most of it
 * identical to the previous request. Content-defined chunking (CDC) + a content-hash cache skip parts already verified
 * clean parts; only unseen/modified chunks actually run the regex filtering.
 *
 * Multi-level splitting (user-specified):
 *   L1 whole-string hash -> on hit, return the original as-is (zero copy / zero regex / zero CDC)
 *   L2 large chunks: min 4K / max 64K / avg 16K
 *   L3 medium chunks: min 1K / max 4K / avg 2K   (recursed into when an L2 chunk misses)
 *   L4 small chunks: min 256 / max 1K / avg 512 (recursed into when an L3 chunk misses; below that, plain regex)
 *   -> local edits invalidate only the tiny chunks that actually changed; everything else still hits the cache
 *
 * Two key techniques (both required):
 * 1. buzhash rolling (fixed 64B window) instead of Gear (unbounded memory):
 *    insertions/deletions only shift cut points within a +/-64B window; misalignment propagates at most one chunk
 * 2. safe cut points: if a cut lands inside a token run, move it past the whole run first
 *    (secrets/JWTs/emails/IDs/card numbers have no length cap; a fixed window alone would miss splits);
 *    then inspect the OVERLAP characters around it; a regex match straddling the cut moves the cut past the match.
 *
 * Fast path: with no extra rules, scan the whole string once for "traits that could trigger a rule"
 * (secret prefixes / @ / digit runs / IPv4 shapes); with none of them, the original string is returned as-is --
 * Ordinary conversation runs no regex, computes no hash, touches no cache -- just one character scan.
 *
 * Content hash: two FNV-1a 32-bit hashes joined into 64 bits (fast; collision odds ~1e-10 at 50k entries)
 * Cache: CLEAN markers (capped at 100k) + dirty-chunk replacement results (capped at 2000, chunks <=32K only)
 * when a cut moves forward, the chunk hash keeps covering the full chunk (see pendingEnd in cutChunks),
 * guaranteeing "fingerprint == content"; an edited tail can never still hit the old chunk.
 *
 * if the extra regex config changes, results may differ -> auto-invalidation by fingerprint (or call reset())
 * (gateway.js's loadConfig() already calls reset())
 */
'use strict';

/* ---- buzhash random table: deterministically generated from a fixed seed ---- */
const BT = new Uint32Array(256);
{
  let seed = 0x12345678;
  for (let i = 0; i < 256; i++) {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    BT[i] = seed;
  }
}
const WINDOW = 64;          // buzhash rolling window (bytes): position-independent cut decisions
const OVERLAP = 128;        // safe-cut-point inspection window (characters)
const MAX_TOKEN_RUN = 16384; // how far a cut point may move to skip past a token run

/* ---- Multi-level CDC parameters (characters) ---- */
const LEVELS = [
  { min: 4096,  max: 65536, mask: 0x3fff }, // L2: avg 16K
  { min: 1024,  max: 4096,  mask: 0x7ff },  // L3: avg 2K
  { min: 256,   max: 1024,  mask: 0x1ff },  // L4: avg 512
];
const MIN_TOP = LEVELS[0].min;

/* ---- FNV-1a 32-bit seeds (two different seeds = two independent 32-bit hashes) ---- */
const F1_SEED = 0x811c9dc5;
const F2_SEED = 0x01000193;

/* ---- Rules ---- */
const BASE_PATTERNS = [
/\bsk-[A-Za-z0-9_-]{10,}/g,            // OpenAI/DeepSeek/Anthropic style
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /\bAKIA[0-9A-Z]{16}/g,                  // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g,            // Google
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          // GitLab
  /\bhf_[A-Za-z0-9]{20,}/g,               // HuggingFace
/\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     // Bearer headers pasted into text
/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,                             // email address
/(?<!\d)1[3-9]\d{9}(?!\d)/g,                                                         // mainland China mobile number
/\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,  // national ID number
/(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?:[ -]?\d{1,3})?(?!\d)/g,                             // bank card (masked only if it passes Luhn)
/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g, // private IPv4
];
/* Minimal literal traits of the rules: at least one must be present for BASE_PATTERNS to possibly hit */
const PREFIX_HINTS = ['sk-', 'ghp_', 'gho_', 'ghu_', 'github_pat_', 'xox', 'AKIA', 'AIza', 'glpat-', 'hf_', 'Bearer'];
/* Fast-path trigger (a single character scan, an order of magnitude faster than regex):
 * Only the presence of @ / digit runs of 11+ (single spaces/hyphens allowed) / IPv4 shapes / secret prefixes
 * before regexes run. Scattered digits in ordinary prose never trigger it. */
function quickHit(s) {
  const n = s.length;
  let digits = 0, sep = 0, seg = 0, dots = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {                 // 0-9
      digits++; sep = 0; seg++;
      if (digits >= 11) return true;
    } else if ((c === 32 || c === 45) && digits > 0 && sep === 0) {
sep = 1; dots = 0; seg = 0;             // allow one space/hyphen between digit groups (card/phone numbers); IPs contain no spaces
    } else if (c === 46 && seg >= 1 && seg <= 3 && dots < 3) {  // .
      dots++; seg = 0;
    } else {
if (dots >= 3) return true;             // 1.2.3.4 shape
      if (c === 64) return true;              // @
      digits = 0; sep = 0; seg = 0; dots = 0;
    }
  }
  if (dots >= 3) return true;
  for (let i = 0; i < PREFIX_HINTS.length; i++) if (s.indexOf(PREFIX_HINTS[i]) !== -1) return true;
  return false;
}

const ID_SHAPE = /^[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/;

function luhn(d) {
  if (d.length < 13) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
/* Unified replacement callback: card numbers must pass Luhn (avoid masking every long number); ID-number shapes are masked directly */
function repl(m) {
  if (m.length >= 16 && /^[\d -]+$/.test(m)) {
    if (ID_SHAPE.test(m)) return '***';
    if (!luhn(m.replace(/\D/g, ''))) return m;
  }
  return '***';
}

/* ---- Compile & cache (keyed by the extra-rules fingerprint) ---- */
function extraFingerprint(extra) {
  if (!extra || !extra.length) return 0;
  let h = 0xdeadbeef;
  for (const p of extra) {
    if (typeof p !== 'string') continue;
    for (let i = 0; i < p.length; i++) h = (Math.imul(h ^ p.charCodeAt(i), 0x01000193)) >>> 0;
  }
  return h;
}
function buildMaster(extra) {
  const parts = BASE_PATTERNS.map(re => '(?:' + re.source + ')');
  if (extra) for (const p of extra) {
    if (typeof p !== 'string' || !p) continue;
    try { new RegExp(p); parts.push('(?:' + p + ')'); } catch (_) {}
  }
  return new RegExp(parts.join('|'), 'g');
}
let rulesCache = { key: null, re: null, hasExtra: false };
function getRules(extra) {
  const hasExtra = !!(extra && extra.length);
  const key = hasExtra ? extraFingerprint(extra) : 0;
  if (rulesCache.key !== key || !rulesCache.re || rulesCache.hasExtra !== hasExtra) {
    const prev = rulesCache.key;
    rulesCache = { key, re: buildMaster(hasExtra ? extra : null), hasExtra };
if (prev !== null) reset();   // rules changed -> the old cache (especially dirty-chunk results) must be invalidated
  }
  return rulesCache;
}
function plainRedact(s, rules) {
  if (!rules.hasExtra && !quickHit(s)) return s;
  return s.replace(rules.re, repl);
}

/* ---- Cache ---- */
const CLEAN = Symbol('clean');
const cleanCache = new Map();   // key(BigInt) → CLEAN
const dirtyCache = new Map();   // key(BigInt) -> replaced string
const CLEAN_MAX = 100000;
const DIRTY_MAX = 2000;
const DIRTY_MAX_LEN = 32768;    // results for dirty chunks longer than this are not cached (memory guard)
let cacheHits = 0, cacheMiss = 0;

function trimCache(map, max) {
  if (map.size <= max) return;
let del = map.size - max + (max >> 2); // evict below max with a 25% margin
  for (const k of map.keys()) { if (del-- <= 0) break; map.delete(k); }
}

/* Must be called whenever the (extra) config changes */
function reset() { cleanCache.clear(); dirtyCache.clear(); cacheHits = 0; cacheMiss = 0; }
function stats() { return { clean: cleanCache.size, dirty: dirtyCache.size, hits: cacheHits, miss: cacheMiss }; }

function keyOf(a, b) { return (BigInt(a) << 32n) | BigInt(b >>> 0); }
function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

/* Token-run characters: the common charset of keys/JWTs/emails/digit runs (includes @ so a whole email can be deferred) */
function isTok(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
         c === 45 || c === 46 || c === 95 || c === 126 || c === 43 || c === 64 || c === 37;
}

/* Safe cut point: (1) never inside a token run (2) never inside a regex match that straddles the cut.
 * Returns a cut point <= end. */
function safeCut(s, cutAt, end, rules) {
  let c = Math.min(cutAt, end);
  if (c <= 0 || c >= end) return c;
/* (1) Defer whole token runs (unbounded-length secrets are the easiest to miss here) */
  if (isTok(s.charCodeAt(c - 1)) || isTok(s.charCodeAt(c))) {
    const lim = Math.min(end, c + MAX_TOKEN_RUN);
    let e = c;
    while (e < lim && isTok(s.charCodeAt(e))) e++;
if (e > c && !(e >= lim && e < end)) c = e;  // over-long token: give up deferring, fall back to the regex window
    if (c >= end) return end;
  }
/* (2) A regex match straddling the cut point -> move it past the match end */
  for (let guard = 0; guard < 8; guard++) {
    const ws = Math.max(0, c - OVERLAP), we = Math.min(end, c + OVERLAP);
    const win = s.slice(ws, we);
if (!rules.hasExtra && !quickHit(win)) return c; // window has no sensitive traits; cut directly
    const off = c - ws;
    let moved = false;
    rules.re.lastIndex = 0;
    let m;
    while ((m = rules.re.exec(win)) !== null) {
      if (m[0].length === 0) { rules.re.lastIndex++; continue; }
      if (m.index < off && m.index + m[0].length > off) {
        c = ws + m.index + m[0].length;
        moved = true;
        break;
      }
    }
    if (!moved) return c;
  }
  return c;
}

/* Short strings (< top-level min): hash the whole string -> return the original on hit; otherwise run regex and cache the result */
function lookupShort(s, rules) {
  let f1 = F1_SEED, f2 = F2_SEED;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    f1 = Math.imul(f1 ^ c, 0x01000193) >>> 0;
    f2 = Math.imul(f2 ^ c, 0x01000193) >>> 0;
  }
  const key = keyOf(f1, f2);
  if (cleanCache.has(key)) { cacheHits++; return s; }
  const dirty = dirtyCache.get(key);
  if (dirty !== undefined) { cacheHits++; return dirty; }
  cacheMiss++;
  const out = plainRedact(s, rules);
  if (out === s) { cleanCache.set(key, CLEAN); return s; }
  if (s.length <= DIRTY_MAX_LEN) dirtyCache.set(key, out);
  trimCache(cleanCache, CLEAN_MAX);
  trimCache(dirtyCache, DIRTY_MAX);
  return out;
}

/* CDC-split [start, end) at this level (buzhash + safe cut points) while computing each chunk's dual FNV.
 * pendingEnd: after safeCut moves a cut point, the skipped characters keep counting into this chunk's hash/rolling window,
 * and the chunk lands only when complete -- guaranteeing chunk fingerprints cover the full chunk. */
function cutChunks(s, start, end, level, rules) {
  let h = 0;
  let cf1 = F1_SEED, cf2 = F2_SEED;
  let cs = start;
  let pendingEnd = -1;
  const chunks = [];
  const win = new Uint8Array(WINDOW);
  let wpos = 0, wcount = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    const b = c & 0xff;
    h = rotl32(h, 1) ^ BT[b];
    if (wcount >= WINDOW) h ^= rotl32(BT[win[wpos]], WINDOW);
    else wcount++;
    win[wpos] = b;
    wpos = (wpos + 1) % WINDOW;
    cf1 = Math.imul(cf1 ^ c, 0x01000193) >>> 0;
    cf2 = Math.imul(cf2 ^ c, 0x01000193) >>> 0;

    const pos = i + 1;
    if (pendingEnd > 0) {
      if (pos === pendingEnd) {
        chunks.push({ s: cs, e: pos, f1: cf1, f2: cf2 });
        cs = pos; cf1 = F1_SEED; cf2 = F2_SEED; pendingEnd = -1;
      }
      continue;
    }
    const size = pos - cs;
    if (size < level.min) continue;
    let cutAt = -1;
    if (size >= level.max) cutAt = pos;
    else if ((h & level.mask) === 0) cutAt = pos;
    if (cutAt <= 0) continue;
    const safe = safeCut(s, cutAt, end, rules);
if (safe >= end) { pendingEnd = end; continue; }        // never cuts before the block end
if (safe <= pos) {                                       // cut in place
      chunks.push({ s: cs, e: pos, f1: cf1, f2: cf2 });
      cs = pos; cf1 = F1_SEED; cf2 = F2_SEED;
    } else {
pendingEnd = safe;                                     // keep hashing up to safe
    }
  }
  if (pendingEnd > 0) { chunks.push({ s: cs, e: end, f1: cf1, f2: cf2 }); cs = end; }
  if (cs < end) chunks.push({ s: cs, e: end, f1: cf1, f2: cf2 });
  return chunks;
}

/* Process one chunk recursively: cache hit -> skip; miss -> drill into the smaller level; regex runs only at the bottom.
 * Returns { text, allClean } */
function processChunk(s, start, end, rules, li) {
  const len = end - start;
  if (li >= LEVELS.length || len < LEVELS[li].min) {
    const sub = (start === 0 && end === s.length) ? s : s.slice(start, end);
    const out = plainRedact(sub, rules);
    return { text: out, allClean: out === sub };
  }
  const level = LEVELS[li];
  const chunks = cutChunks(s, start, end, level, rules);
  let allClean = true;
  const parts = [];
  for (const c of chunks) {
    const k = keyOf(c.f1, c.f2);
    if (cleanCache.has(k)) { cacheHits++; parts.push(s.slice(c.s, c.e)); continue; }
    const dirty = dirtyCache.get(k);
    if (dirty !== undefined) { cacheHits++; parts.push(dirty); allClean = false; continue; }
    cacheMiss++;
    const sub = processChunk(s, c.s, c.e, rules, li + 1);
    if (sub.allClean) {
      cleanCache.set(k, CLEAN);
parts.push(s.slice(c.s, c.e)); // zero copy
    } else {
      allClean = false;
      if ((c.e - c.s) <= DIRTY_MAX_LEN && sub.text.length <= DIRTY_MAX_LEN) dirtyCache.set(k, sub.text);
      parts.push(sub.text);
    }
  }
  trimCache(cleanCache, CLEAN_MAX);
  trimCache(dirtyCache, DIRTY_MAX);
  return { text: parts.join(''), allClean };
}

/* ---- Public API: text filter ---- */
function redactSmart(s, extra) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const rules = getRules(extra);
if (!rules.hasExtra && !quickHit(s)) return s; // fast path: zero overhead for ordinary text
  const len = s.length;
  if (len < MIN_TOP) return lookupShort(s, rules);

/* L1: whole-string dual FNV (cheap scan); on hit, return the original reference */
  let f1 = F1_SEED, f2 = F2_SEED;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    f1 = Math.imul(f1 ^ c, 0x01000193) >>> 0;
    f2 = Math.imul(f2 ^ c, 0x01000193) >>> 0;
  }
  const allKey = keyOf(f1, f2);
  if (cleanCache.has(allKey)) { cacheHits++; return s; }

  const res2 = processChunk(s, 0, len, rules, 0);
  if (res2.allClean) { cleanCache.set(allKey, CLEAN); return s; }
  return res2.text;
}

/* ---- Public API: streaming response filter ----
 * Buffer streaming text and release only the prefix that later fragments cannot possibly turn into a sensitive string.
 * Tail token runs (secrets/JWTs/emails/digit runs) and the partial prefix are held back together, so a secret is never
 * an SSE fragment split in half slipping through unmasked. */
const HOLD = 16;         // minimum hold-back characters (covers the longest prefix github_pat_ at 11 + margin)
const MAX_STREAM_HOLD = 16384;

function digitGroupEnd(buf, k, n) {
  const isD = c => c >= 48 && c <= 57;
  const isSep = c => isD(c) || c === 32 || c === 45;
  if (!((k > 0 && isD(buf.charCodeAt(k - 1))) || (k < n && isD(buf.charCodeAt(k))))) return k;
  let a = k, b = k;
  while (a > 0 && isSep(buf.charCodeAt(a - 1))) a--;
  while (b < n && isSep(buf.charCodeAt(b))) b++;
  const seg = buf.slice(a, b);
  let digits = 0;
  for (let i = 0; i < seg.length; i++) { const c = seg.charCodeAt(i); if (c >= 48 && c <= 57) digits++; }
return digits >= 11 ? b : k;   // phone/ID/card numbers (spaces/hyphens allowed as separators)
}

function streamFlushLen(buf) {
  const n = buf.length;
  if (n <= HOLD) return 0;
  let k = n - HOLD;
/* Cut point lands inside a sensitive run -> move past its end; the whole run goes to the next round */
  for (let guard = 0; guard < 3; guard++) {
    let moved = false;
    if (isTok(buf.charCodeAt(k - 1)) && isTok(buf.charCodeAt(k))) {
      let e = k;
      while (e < n && isTok(buf.charCodeAt(e))) e++;
      k = e; moved = true;
    }
    const d = digitGroupEnd(buf, k, n);
    if (d > k) { k = d; moved = true; }
    if (k >= n) {
      if (n <= MAX_STREAM_HOLD) return 0;
      k = n - MAX_STREAM_HOLD;
      break;
    }
    if (!moved) break;
  }
/* Sensitive prefix seen but its token not yet complete: hold back everything from that prefix on */
  for (let i = 0; i < PREFIX_HINTS.length; i++) {
    const idx = buf.lastIndexOf(PREFIX_HINTS[i], n - 1);
    if (idx >= 0 && idx < k && n - idx <= MAX_STREAM_HOLD) k = idx;
  }
  if (n - k > MAX_STREAM_HOLD) k = n - MAX_STREAM_HOLD;
  if (k > 0 && k < n) {
    const a = buf.charCodeAt(k - 1), b = buf.charCodeAt(k);
if (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) k = Math.min(n, k + 1); // never split a surrogate pair
  }
  return Math.max(0, Math.min(k, n));
}

function createStreamFilter(extra) {
  let buf = '';
  return {
    push(t) {
      if (t == null) return '';
      buf += String(t);
      const k = streamFlushLen(buf);
      if (k <= 0) return '';
      const out = redactSmart(buf.slice(0, k), extra);
      buf = buf.slice(k);
      return out;
    },
    flush() {
      if (!buf) return '';
      const out = redactSmart(buf, extra);
      buf = '';
      return out;
    },
    pending() { return buf.length; },
  };
}

module.exports = {
  redactSmart, createStreamFilter, reset, stats,
  LEVELS, MIN_CHUNK: MIN_TOP,
  _internals: { safeCut, streamFlushLen, luhn, quickHit, MAX_TOKEN_RUN, OVERLAP },
};
