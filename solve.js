// A faster drop-in for makefun-site 1.0.0: builds the same static sites, byte for byte,
// with a hand-written single-pass Markdown scanner and a small compiled template engine.
// Pure Node stdlib, no network, no randomness, no clock. `run(input)` returns the output
// tree for one case: an object of output path -> file text.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const ENTITIES = {
  34: '&quot;',
  38: '&amp;',
  39: '&#39;',
  60: '&lt;',
  62: '&gt;',
};

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimSpacesTabs(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

const ESCAPE_TEST = /[&<>"']/;

function escapeStr(s) {
  if (!ESCAPE_TEST.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const e = ENTITIES[s.charCodeAt(i)];
    if (e !== undefined) {
      if (i > start) out += s.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function isNameStartCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameCode(c) {
  return isNameStartCode(c) || (c >= 48 && c <= 57);
}

function isEscapableCode(c) {
  // \ ` * _ [ ] ( ) # + - . ! >
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62
  );
}

// ---------------------------------------------------------------------------
// Slugs: NFKD, drop combining marks, A-Z lowered, each run of non [a-z0-9]
// becomes one '-', none at either end, cut to 64 chars with a trailing '-'
// at the cut dropped, 'untitled' when nothing is left.
// ---------------------------------------------------------------------------

const MARK_RE = /\p{M}/gu;

function makeSlug(text) {
  const norm = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let dashed = true; // pretend a dash is pending so nothing leads with one
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    if (c >= 97 && c <= 122) {
      out += norm[i];
      dashed = false;
    } else if (c >= 48 && c <= 57) {
      out += norm[i];
      dashed = false;
    } else if (c >= 65 && c <= 90) {
      out += String.fromCharCode(c + 32);
      dashed = false;
    } else if (!dashed) {
      out += '-';
      dashed = true;
    }
  }
  if (dashed && out.length > 0) out = out.slice(0, -1);
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(63) === 45) out = out.slice(0, -1);
  }
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(base, taken) {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let k = 2;
  while (taken.has(base + '-' + k)) k++;
  const s = base + '-' + k;
  taken.add(s);
  return s;
}

// A card's tags keep each slug once, first spelling kept.
function dedupeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    if (seen.has(t.slug)) continue;
    seen.add(t.slug);
    out.push(t);
  }
  return out;
}

function dateLong(dateStr) {  const month = +dateStr.slice(5, 7);
  const day = +dateStr.slice(8, 10);
  return day + ' ' + MONTHS[month - 1] + ' ' + dateStr.slice(0, 4);
}

function isLeapYear(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function validDate(v) {
  if (v.length !== 10) return false;
  if (v.charCodeAt(4) !== 45 || v.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = v.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = +v.slice(0, 4);
  const m = +v.slice(5, 7);
  const d = +v.slice(8, 10);
  if (m < 1 || m > 12) return false;
  const dim = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d < 1 || d > dim) return false;
  return v >= '1970-01-01' && v <= '2099-12-31';
}

// ---------------------------------------------------------------------------
// Templates: two passes. First the source is tokenised (text, escaped and raw
// interpolations, control tags); interpolation paths are validated while
// tokenising, so a bad path anywhere beats a bad tag anywhere. Then the tokens
// are parsed into a small tree of text / interpolation / if / for / include.
// ---------------------------------------------------------------------------

function validPath(p) {
  if (p === '') return false;
  const parts = p.split('.');
  for (const part of parts) {
    if (part === '') return false;
    if (!isNameStartCode(part.charCodeAt(0))) return false;
    for (let i = 1; i < part.length; i++) {
      if (!isNameCode(part.charCodeAt(i))) return false;
    }
  }
  return true;
}

function validName(s) {
  if (s === '') return false;
  if (!isNameStartCode(s.charCodeAt(0))) return false;
  for (let i = 1; i < s.length; i++) {
    if (!isNameCode(s.charCodeAt(i))) return false;
  }
  return true;
}

const INCLUDE_NAME_RE = /^"[a-z0-9-]+"$/;

// Token kinds: 0 text, 1 escaped {{ }}, 2 raw {{{ }}}, 3 control {% %}.
function tokeniseTemplate(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) tokens.push({ t: 0, s: src.slice(textStart, end) });
  };
  while (i < n) {
    const jInterp = src.indexOf('{{', i);
    const jTag = src.indexOf('{%', i);
    let j = -1;
    let isTag = false;
    if (jInterp === -1) {
      j = jTag;
      isTag = true;
    } else if (jTag === -1) {
      j = jInterp;
    } else if (jTag < jInterp) {
      j = jTag;
      isTag = true;
    } else {
      j = jInterp;
    }
    if (j === -1) break;
    if (!isTag) {
      if (src.charCodeAt(j + 2) === 123) {
        // {{{ ... }}} — closes at the first }}} or at }} followed by {{
        const cTriple = src.indexOf('}}}', j + 3);
        const cPair = src.indexOf('}}{{', j + 3);
        let close = -1;
        let adv = 0;
        if (cTriple !== -1 && (cPair === -1 || cTriple <= cPair)) {
          close = cTriple;
          adv = 3;
        } else if (cPair !== -1) {
          close = cPair;
          adv = 2;
        }
        if (close === -1) return { error: 'a {{{ is not closed' };
        const content = src.slice(j + 3, close).trim();
        if (!validPath(content)) return { error: JSON.stringify(content) + ' is not a path' };
        flushText(j);
        tokens.push({ t: 2, p: content.split('.') });
        i = close + adv;
        textStart = i;
      } else {
        const close = src.indexOf('}}', j + 2);
        if (close === -1) return { error: 'a {{ is not closed' };
        const content = src.slice(j + 2, close).trim();
        if (!validPath(content)) return { error: JSON.stringify(content) + ' is not a path' };
        flushText(j);
        tokens.push({ t: 1, p: content.split('.') });
        i = close + 2;
        textStart = i;
      }
    } else {
      const close = src.indexOf('%}', j + 2);
      if (close === -1) return { error: 'a {% is not closed' };
      // A {% %} tag alone on its line (only spaces/tabs beside it) takes the
      // whole line with it, its newline included.
      const lineStart = src.lastIndexOf('\n', j - 1) + 1;
      let beforeOk = true;
      for (let k = lineStart; k < j; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) {
          beforeOk = false;
          break;
        }
      }
      const lineEnd = src.indexOf('\n', close + 2);
      const afterEnd = lineEnd === -1 ? n : lineEnd;
      let afterOk = true;
      for (let k = close + 2; k < afterEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) {
          afterOk = false;
          break;
        }
      }
      if (beforeOk && afterOk) {
        flushText(lineStart);
        tokens.push({ t: 3, raw: src.slice(j, close + 2), inner: src.slice(j + 2, close) });
        i = lineEnd === -1 ? n : lineEnd + 1;
        textStart = i;
      } else {
        flushText(j);
        tokens.push({ t: 3, raw: src.slice(j, close + 2), inner: src.slice(j + 2, close) });
        i = close + 2;
        textStart = i;
      }
    }
  }
  flushText(n);
  return { tokens };
}

// Node kinds: 0 text, 1 escaped, 2 raw, 4 if, 5 for, 6 include.
function parseTemplateTokens(tokens) {
  const root = [];
  const stack = [];
  let cur = root;
  for (const tok of tokens) {
    if (tok.t === 0 || tok.t === 1 || tok.t === 2) {
      cur.push(tok);
      continue;
    }
    const inner = tok.inner.trim();
    const words = inner === '' ? [] : inner.split(/\s+/);
    const w0 = words[0];
    if (w0 === 'endif') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'if') return { error: 'an endif with no open if' };
      stack.pop();
      cur = stack.length > 0 ? stack[stack.length - 1].body : root;
    } else if (w0 === 'endfor') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'for') return { error: 'an endfor with no open for' };
      stack.pop();
      cur = stack.length > 0 ? stack[stack.length - 1].body : root;
    } else if (w0 === 'else') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'if' || top.node.els !== null) {
        return { error: 'an else outside an if' };
      }
      top.node.els = [];
      top.body = top.node.els;
      cur = top.body;
    } else if (w0 === 'if') {
      let not = false;
      let path;
      if (words.length === 2 && words[1] === 'not') {
        not = true;
        path = undefined;
      } else if (words.length === 2) {
        path = words[1];
      } else if (words.length === 3 && words[1] === 'not') {
        not = true;
        path = words[2];
      } else {
        return { error: tok.raw + ' is not a tag' };
      }
      if (path !== undefined && !validPath(path)) {
        return { error: JSON.stringify(path) + ' is not a path' };
      }
      const node = { t: 4, not, p: path === undefined ? null : path.split('.'), then: [], els: null };
      cur.push(node);
      stack.push({ kind: 'if', node, body: node.then });
      cur = node.then;
    } else if (w0 === 'for') {
      if (words.length !== 4 || words[2] !== 'in' || !validName(words[1])) {
        return { error: tok.raw + ' is not a tag' };
      }
      const path = words[3];
      if (!validPath(path)) return { error: JSON.stringify(path) + ' is not a path' };
      const node = { t: 5, v: words[1], p: path.split('.'), body: [] };
      cur.push(node);
      stack.push({ kind: 'for', node, body: node.body });
      cur = node.body;
    } else if (w0 === 'include') {
      if (words.length !== 2 || !INCLUDE_NAME_RE.test(words[1])) {
        return { error: tok.raw + ' is not a tag' };
      }
      cur.push({ t: 6, name: words[1].slice(1, -1) });
    } else {
      return { error: tok.raw + ' is not a tag' };
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return { error: top.kind === 'for' ? 'a for is not closed' : 'a if is not closed' };
  }
  return { nodes: root };
}

function compileTemplate(src) {
  const tok = tokeniseTemplate(src);
  if (tok.error) return { error: tok.error };
  return parseTemplateTokens(tok.tokens);
}

// ---------------------------------------------------------------------------
// Template rendering. A scope is { root, frames, templates, depth }.
// frames: innermost-last loop frames { name, val, loop }.
// ---------------------------------------------------------------------------

function resolvePath(ctx, parts) {
  const first = parts[0];
  const frames = ctx.frames;
  let v;
  let found = false;
  for (let f = frames.length - 1; f >= 0; f--) {
    const fr = frames[f];
    if (first === 'loop') {
      v = fr.loop;
      found = true;
      break;
    }
    if (first === fr.name) {
      v = fr.val;
      found = true;
      break;
    }
  }
  if (!found) {
    v = Object.prototype.hasOwnProperty.call(ctx.root, first) ? ctx.root[first] : undefined;
  }
  for (let k = 1; k < parts.length; k++) {
    if (v === null || v === undefined) return undefined;
    const key = parts[k];
    if (
      (typeof v === 'object' || typeof v === 'function' || typeof v === 'string') &&
      Object.prototype.hasOwnProperty.call(v, key)
    ) {
      v = v[key];
    } else {
      return undefined;
    }
  }
  return v;
}

function isTruthy(v) {
  if (!v) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function writeValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += writeValue(v[k]);
    }
    return s;
  }
  return '';
}

function renderNodes(nodes, ctx, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    if (node.t === 0) {
      out.push(node.s);
    } else if (node.t === 1) {
      out.push(escapeStr(writeValue(resolvePath(ctx, node.p))));
    } else if (node.t === 2) {
      out.push(writeValue(resolvePath(ctx, node.p)));
    } else if (node.t === 4) {
      const v = node.p === null ? undefined : resolvePath(ctx, node.p);
      let ok = isTruthy(v);
      if (node.not) ok = !ok;
      renderNodes(ok ? node.then : node.els || EMPTY_NODES, ctx, out);
    } else if (node.t === 5) {
      const v = resolvePath(ctx, node.p);
      if (Array.isArray(v)) {
        const loop = { index: 0, first: false, last: false, length: v.length };
        const frame = { name: node.v, val: undefined, loop };
        ctx.frames.push(frame);
        for (let k = 0; k < v.length; k++) {
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === v.length - 1;
          frame.val = v[k];
          renderNodes(node.body, ctx, out);
        }
        ctx.frames.pop();
      }
    } else if (node.t === 6) {
      if (ctx.depth < 8) {
        const tpl = ctx.templates.get(node.name);
        if (tpl !== undefined) {
          ctx.depth++;
          renderNodes(tpl, ctx, out);
          ctx.depth--;
        }
      }
    }
  }
}

const EMPTY_NODES = [];

function renderTemplate(nodes, root, templates) {
  const out = [];
  renderNodes(nodes, { root, frames: [], templates, depth: 0 }, out);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

function parseQuoted(v) {
  // v opens on '"' and is at least 2 chars with a closing '"' at its end.
  if (v.length < 2 || v.charCodeAt(v.length - 1) !== 34) {
    return { error: 'a quoted string is not closed' };
  }
  const body = v.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 92) {
      const nx = body.charCodeAt(i + 1);
      if (nx !== 34 && nx !== 92) {
        return { error: 'a quoted string holds an escape other than \\" or \\\\' };
      }
      out += String.fromCharCode(nx);
      i++;
    } else if (c === 34) {
      return { error: 'a quoted string holds a stray quote' };
    } else {
      out += body[i];
    }
  }
  return { value: out };
}

const FM_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);
const SLUG_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LAYOUT_NAME_RE = /^[a-z0-9-]+$/;

function processFmLine(line, n, fm) {
  if (isBlankLine(line)) return null;
  if (line.charCodeAt(0) === 35) return null; // comment opens on #
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 97 && c <= 122) || c === 95) k++;
    else break;
  }
  if (
    k === 0 ||
    k >= line.length ||
    line.charCodeAt(k) !== 58 ||
    (k + 1 < line.length && line.charCodeAt(k + 1) !== 32)
  ) {
    return 'line ' + n + ' is not "key: value"';
  }
  const key = line.slice(0, k);
  let value;
  if (k + 1 >= line.length) {
    // "key:" with nothing after it is a key with no value.
    value = '';
  } else if (line.charCodeAt(k + 1) === 32) {
    value = line.slice(k + 2);
  } else {
    return 'line ' + n + ' is not "key: value"';
  }
  let ve = value.length;
  while (ve > 0 && (value.charCodeAt(ve - 1) === 32 || value.charCodeAt(ve - 1) === 9)) ve--;
  value = value.slice(0, ve);
  if (!FM_KEYS.has(key)) return 'unknown key "' + key + '"';
  if (Object.prototype.hasOwnProperty.call(fm, key)) {
    return 'key "' + key + '" is given twice';
  }
  if (value === '') return 'key "' + key + '" has no value';
  if (key === 'title' || key === 'summary') {
    if (value.charCodeAt(0) === 34) {
      const parsed = parseQuoted(value);
      if (parsed.error) return 'key "' + key + '": ' + parsed.error;
      fm[key] = parsed.value;
    } else if (value.charCodeAt(0) === 91) {
      return 'key "' + key + '": a bare string opens on [';
    } else {
      fm[key] = value;
    }
    return null;
  }
  if (key === 'date') {
    if (!validDate(value)) {
      return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    }
    fm.date = value;
    return null;
  }
  if (key === 'tags') {
    if (value.charCodeAt(0) !== 91 || value.charCodeAt(value.length - 1) !== 93) {
      return 'key "tags": not a list [a, b]';
    }
    const inner = value.slice(1, -1);
    if (inner === '') {
      fm.tags = [];
      return null;
    }
    const items = inner.split(',');
    for (let i = 0; i < items.length; i++) {
      items[i] = trimSpacesTabs(items[i]);
      const it = items[i];
      if (
        it === '' ||
        it.indexOf('"') !== -1 ||
        it.indexOf('[') !== -1 ||
        it.indexOf(']') !== -1
      ) {
        return 'key "tags": an empty tag, or one holding " [ or ]';
      }
    }
    fm.tags = items;
    return null;
  }
  if (key === 'draft') {
    if (value !== 'true' && value !== 'false') return 'key "draft": true or false';
    fm.draft = value === 'true';
    return null;
  }
  if (key === 'layout') {
    if (!LAYOUT_NAME_RE.test(value)) return 'key "layout": not a template name';
    fm.layout = value;
    return null;
  }
  // slug
  if (!SLUG_KEY_RE.test(value) || value.length > 64) return 'key "slug": not a slug';
  fm.slug = value;
  return null;
}

// Parses one .md source. Returns { fm, body } or { refusal }.
function parseSource(content) {
  let nl = content.indexOf('\n');
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  if (firstLine !== '---') return { refusal: 'no front matter' };
  const fm = {};
  let pos = nl === -1 ? content.length : nl + 1;
  let lineNo = 1;
  let closed = false;
  let bodyStart = content.length;
  while (pos <= content.length) {
    let eol = content.indexOf('\n', pos);
    if (eol === -1) eol = content.length;
    const line = content.slice(pos, eol);
    lineNo++;
    if (line === '---') {
      closed = true;
      bodyStart = eol === content.length ? content.length : eol + 1;
      break;
    }
    const err = processFmLine(line, lineNo, fm);
    if (err) return { refusal: err };
    pos = eol + 1;
    if (pos > content.length) break;
  }
  if (!closed) return { refusal: 'the front matter is not closed' };
  if (fm.title === undefined) return { refusal: 'no title' };
  return { fm, body: content.slice(bodyStart) };
}

// ---------------------------------------------------------------------------
// Markdown: line-based blocks, single-pass inline scanner.
// ---------------------------------------------------------------------------

function fenceLang(line) {
  if (
    line.charCodeAt(0) !== 96 ||
    line.charCodeAt(1) !== 96 ||
    line.charCodeAt(2) !== 96
  ) {
    return null;
  }
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 95 ||
      c === 43 ||
      c === 45
    ) {
      j++;
    } else {
      break;
    }
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (
    line.charCodeAt(0) !== 96 ||
    line.charCodeAt(1) !== 96 ||
    line.charCodeAt(2) !== 96
  ) {
    return false;
  }
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingInfo(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  if (j === 0 || j > 6) return null;
  if (j >= line.length) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let k = j;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  let e = line.length;
  while (e > k && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e <= k) return null;
  return { level: j, text: line.slice(k, e) };
}

function isThematicBreak(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Returns { ordered, start, markerLen } or null.
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 45 || c0 === 42) {
    if (line.charCodeAt(1) === 32) return { ordered: false, start: 0, markerLen: 2 };
    return null;
  }
  if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      return { ordered: true, start: parseInt(line.slice(0, j), 10), markerLen: j + 2 };
    }
  }
  return null;
}

// A continuation line: two or more spaces, then a non-space, non-tab.
function listContinuation(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2) return null;
  if (j >= line.length) return null;
  const c = line.charCodeAt(j);
  if (c === 32 || c === 9) return null;
  return trimSpacesTabs(line);
}

function findStrongClose(s, from, to) {
  let j = from;
  while (j < to) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < to && isEscapableCode(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c === 42 && j + 1 < to && s.charCodeAt(j + 1) === 42) return j;
    j++;
  }
  return -1;
}

function findEmClose(s, from, to) {
  let j = from;
  while (j < to) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < to && isEscapableCode(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c === 42) {
      // A ** pair is not an emphasis closer: skip both of its stars.
      if (j + 1 < to && s.charCodeAt(j + 1) === 42) {
        j += 2;
        continue;
      }
      if (j > from) return j;
    }
    j++;
  }
  return -1;
}

function resolveLinkTarget(target, ctx) {
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return target; // /... or #... kept as written
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    // scheme: letters, digits, +, -, . then ':'
    let k = 1;
    while (k < target.length) {
      const c = target.charCodeAt(k);
      if (c === 58) return target;
      if (
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 43 ||
        c === 45 ||
        c === 46
      ) {
        k++;
      } else {
        break;
      }
    }
  }
  const hash = target.indexOf('#');
  const pathPart = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? null : target.slice(hash + 1);
  const parts = [];
  if (ctx.srcDir !== '') {
    const segs = ctx.srcDir.split('/');
    for (let i = 0; i < segs.length; i++) parts.push(segs[i]);
  }
  const segs = pathPart.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const resolved = parts.join('/');
  const pageUrl = ctx.pagesBySource.get(resolved);
  let href = null;
  if (pageUrl !== undefined) {
    href = pageUrl;
  } else if (ctx.statics.has(resolved)) {
    href = ctx.base + '/' + resolved;
  }
  if (href === null) {
    const key = ctx.srcPath + '\0' + target;
    if (!ctx.brokenSeen.has(key)) {
      ctx.brokenSeen.add(key);
      ctx.report.push('broken-link ' + ctx.srcPath + ' -> ' + target);
    }
    return target;
  }
  return frag === null ? href : href + '#' + frag;
}

function tryLink(s, i, b, ctx) {
  let j = i + 1;
  while (j < b) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < b && isEscapableCode(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c === 93) break;
    j++;
  }
  if (j >= b) return null;
  if (j + 1 >= b || s.charCodeAt(j + 1) !== 40) return null;
  const k = s.indexOf(')', j + 2);
  if (k === -1 || k >= b) return null;
  const target = s.slice(j + 2, k);
  if (target.length === 0) return null;
  for (let t = 0; t < target.length; t++) {
    const c = target.charCodeAt(t);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) return null;
  }
  return { href: resolveLinkTarget(target, ctx), textStart: i + 1, textEnd: j, end: k + 1 };
}

// Shared by inlineRange: safe to share across its (same-string) recursive
// calls, because every call sets lastIndex before its first exec and the loop
// re-sets it after any nested call returns.
const INLINE_RE = /[\\`*\[&<>"']/g;

function inlineRange(out, s, a, b, ctx) {
  let i = a;
  let start = a;
  // Jump straight to the next special char instead of scanning every char:
  // most text is plain, so the native regex does the skipping for us.
  INLINE_RE.lastIndex = a;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null && m.index < b) {
    i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      const d = i + 1 < b ? s.charCodeAt(i + 1) : -1;
      if (d !== -1 && isEscapableCode(d)) {
        if (i > start) out.push(s.slice(start, i));
        out.push(d === 62 ? '&gt;' : String.fromCharCode(d));
        i += 2;
        start = i;
      } else {
        i++;
      }
    } else if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<code>');
        out.push(escapeStr(s.slice(i + 1, j)));
        out.push('</code>');
        i = j + 1;
        start = i;
      } else {
        i++;
      }
    } else if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findStrongClose(s, i + 2, b);
        if (j !== -1 && j > i + 2) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<strong>');
          inlineRange(out, s, i + 2, j, ctx);
          out.push('</strong>');
          i = j + 2;
          start = i;
        } else {
          i += 2;
        }
      } else {
        const j = findEmClose(s, i + 1, b);
        if (j !== -1) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<em>');
          inlineRange(out, s, i + 1, j, ctx);
          out.push('</em>');
          i = j + 1;
          start = i;
        } else {
          i++;
        }
      }
    } else if (c === 91) {
      const link = tryLink(s, i, b, ctx);
      if (link !== null) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<a href="');
        out.push(escapeStr(link.href));
        out.push('">');
        inlineRange(out, s, link.textStart, link.textEnd, ctx);
        out.push('</a>');
        i = link.end;
        start = i;
      } else {
        i++;
      }
    } else {
      // An escapable HTML char (& < > " '): only these reach here.
      if (i > start) out.push(s.slice(start, i));
      out.push(ENTITIES[c]);
      i++;
      start = i;
    }
    INLINE_RE.lastIndex = i;
  }
  if (start < b) out.push(s.slice(start, b));
}

// Word count, allocation-free: a word is a maximal run of non-whitespace.
// Whitespace lookup table (the exact set the reference counts): avoids a
// ~20-way OR-chain per character.
const WS = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS[c] = 1;

function countWords(body) {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < body.length; i++) {
    if (WS[body.charCodeAt(i)]) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return words;
}

// Renders one body to HTML. Returns { html, excerpt, toc }.
function renderBody(body, ctx, slugify) {
  const lines = body.split('\n');
  const n = lines.length;
  const parts = [];
  const toc = [];
  const headingTaken = new Set();
  let excerpt = '';
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      parts.push(
        lang === ''
          ? '<pre><code>'
          : '<pre><code class="language-' + lang + '">',
      );
      while (i < n && !isFenceClose(lines[i])) {
        parts.push(escapeStr(lines[i]));
        parts.push('\n');
        i++;
      }
      if (i < n) i++;
      parts.push('</code></pre>\n');
      continue;
    }
    const head = headingInfo(line);
    if (head !== null) {
      i++;
      const id = uniqueSlug(slugify(head.text), headingTaken);
      if (head.level === 2 || head.level === 3) {
        // TOC needs the heading's HTML as a string.
        const tmp = [];
        inlineRange(tmp, head.text, 0, head.text.length, ctx);
        const hHtml = tmp.join('');
        parts.push('<h' + head.level + ' id="' + id + '">' + hHtml + '</h' + head.level + '>\n');
        toc.push({ level: head.level, id, html: hHtml });
      } else {
        parts.push('<h' + head.level + ' id="' + id + '">');
        inlineRange(parts, head.text, 0, head.text.length, ctx);
        parts.push('</h' + head.level + '>\n');
      }
      continue;
    }
    if (isThematicBreak(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const qLines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32 || t.charCodeAt(0) === 9) t = t.slice(1);
        t = trimSpacesTabs(t);
        if (t !== '') qLines.push(t);
        i++;
      }
      if (qLines.length > 0) {
        const inner = qLines.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineRange(parts, inner, 0, inner.length, ctx);
        parts.push('</p>\n</blockquote>\n');
      } else {
        parts.push('<blockquote>\n</blockquote>\n');
      }
      continue;
    }
    const ls = listStart(line);
    if (ls !== null) {
      const items = [];
      let curText = trimSpacesTabs(line.slice(ls.markerLen));
      i++;
      while (i < n) {
        const l = lines[i];
        const next = listStart(l);
        if (next !== null && next.ordered === ls.ordered) {
          items.push(curText);
          curText = trimSpacesTabs(l.slice(next.markerLen));
          i++;
          continue;
        }
        const cont = listContinuation(l);
        if (cont !== null) {
          curText += '\n' + cont;
          i++;
          continue;
        }
        break;
      }
      items.push(curText);
      parts.push(ls.ordered && ls.start !== 1 ? '<ol start="' + ls.start + '">\n' : ls.ordered ? '<ol>\n' : '<ul>\n');
      for (let m = 0; m < items.length; m++) {
        parts.push('<li>');
        inlineRange(parts, items[m], 0, items[m].length, ctx);
        parts.push('</li>\n');
      }
      parts.push(ls.ordered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    // Paragraph: this line plus following lines up to a blank line, a fence,
    // a heading or a thematic break. List and blockquote lines are absorbed.
    const pLines = [trimSpacesTabs(line)];
    i++;
    while (i < n) {
      const l = lines[i];
      if (
        isBlankLine(l) ||
        fenceLang(l) !== null ||
        headingInfo(l) !== null ||
        isThematicBreak(l)
      ) {
        break;
      }
      pLines.push(trimSpacesTabs(l));
      i++;
    }
    const inner = pLines.join('\n');
    if (excerpt === '') {
      // The first paragraph's HTML is the excerpt: build it as a string.
      const tmp = [];
      inlineRange(tmp, inner, 0, inner.length, ctx);
      const pHtml = tmp.join('');
      excerpt = pHtml;
      parts.push('<p>' + pHtml + '</p>\n');
    } else {
      parts.push('<p>');
      inlineRange(parts, inner, 0, inner.length, ctx);
      parts.push('</p>\n');
    }
  }
  return { html: parts.join(''), excerpt, toc };
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export function run(input) {
  const site = input.site || {};
  const templatesIn = input.templates || {};
  const filesIn = input.files || [];
  let base = String(site.base_url === undefined ? '' : site.base_url);
  while (base.length > 0 && base.charCodeAt(base.length - 1) === 47) {
    base = base.slice(0, -1);
  }
  let perPage = Number(site.per_page);
  if (!(perPage > 0)) perPage = 1;
  const recentN = Number(site.recent);

  const slugMemo = new Map();
  const slugify = (s) => {
    let v = slugMemo.get(s);
    if (v === undefined) {
      v = makeSlug(s);
      slugMemo.set(s, v);
    }
    return v;
  };

  const report = [];

  // Templates, parsed in code-unit order of name.
  const compiled = new Map();
  const templateNames = Object.keys(templatesIn).sort();
  for (const name of templateNames) {
    const c = compileTemplate(templatesIn[name]);
    if (c.error) {
      report.push('template "' + name + '": ' + c.error);
    } else {
      compiled.set(name, c.nodes);
    }
  }

  // Files sorted by path in code-unit order.
  const files = filesIn.slice().sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });

  const built = [];
  const statics = [];
  const staticPaths = new Set();
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      // Only ~5% of sources have CR/LF: skip the copy for the rest.
      const raw = f.content;
      const content = raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n');
      const parsed = parseSource(content);
      if (parsed.refusal) {
        report.push('refused ' + f.path + ': ' + parsed.refusal);
        continue;
      }
      const fm = parsed.fm;
      const isPost = f.path.startsWith('posts/');
      if (f.path.startsWith('tags/')) {
        report.push('refused ' + f.path + ": tags/ is the generator's own");
        continue;
      }
      if (f.path.startsWith('page/')) {
        report.push('refused ' + f.path + ": page/ is the generator's own");
        continue;
      }
      if (isPost && fm.date === undefined) {
        report.push('refused ' + f.path + ': a post needs a date');
        continue;
      }
      const layoutName = fm.layout || (isPost ? 'post' : 'page');
      if (!compiled.has(layoutName)) {
        report.push(
          'refused ' + f.path + ': layout "' + layoutName + '" is no template that parses',
        );
        continue;
      }
      if (fm.draft === true) {
        report.push('draft ' + f.path);
        continue;
      }
      const slash = f.path.lastIndexOf('/');
      // A post's directory is always posts/, whatever year folder its source
      // sits in; a page's directory is its source's directory.
      const dir = isPost ? 'posts' : slash === -1 ? '' : f.path.slice(0, slash);
      built.push({
        path: f.path,
        dir,
        srcDir: slash === -1 ? '' : f.path.slice(0, slash),
        isPost,
        fm,
        layoutName,
        body: parsed.body,
        slug: '',
        url: '',
        outPath: '',
        content: '',
        excerpt: '',
        toc: null,
        reading: 1,
        card: null,
      });
    } else {
      statics.push(f);
      staticPaths.add(f.path);
    }
  }

  // Permalinks: slugs unique per directory in source order.
  const takenByDir = new Map();
  for (const rec of built) {
    let taken = takenByDir.get(rec.dir);
    if (!taken) {
      taken = new Set();
      if (rec.dir === '') {
        taken.add('posts');
        taken.add('tags');
        taken.add('page');
      }
      takenByDir.set(rec.dir, taken);
    }
    const baseSlug = rec.fm.slug || slugify(rec.fm.title);
    rec.slug = uniqueSlug(baseSlug, taken);
    rec.url = base + '/' + (rec.dir === '' ? '' : rec.dir + '/') + rec.slug + '/';
    rec.outPath = (rec.dir === '' ? '' : rec.dir + '/') + rec.slug + '/index.html';
  }

  // Link targets: built pages by source path, and static file paths.
  const pagesBySource = new Map();
  for (const rec of built) pagesBySource.set(rec.path, rec.url);
  const brokenSeen = new Set();
  const linkCtxBase = { pagesBySource, statics: staticPaths, base, report, brokenSeen };

  // Render every body once; the excerpt reuses the first paragraph's HTML and
  // the TOC is built during the same heading pass. One shared link context,
  // retargeted per body (rendering is sequential).
  const linkCtx = { ...linkCtxBase, srcPath: '', srcDir: '' };
  for (const rec of built) {
    linkCtx.srcPath = rec.path;
    linkCtx.srcDir = rec.srcDir;
    const rendered = renderBody(rec.body, linkCtx, slugify);
    rec.content = rendered.html;
    rec.excerpt = rendered.excerpt;
    rec.toc = rendered.toc;
    rec.reading = Math.max(1, Math.ceil(countWords(rec.body) / 200));
  }

  // Collections: posts newest date first, equal dates by slug.
  const posts = built.filter((r) => r.isPost);
  posts.sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });

  // Tags: each slug once, first spelling kept, walking posts in collection order.
  // One pass: a post joins each of its tags' lists once (duplicate spellings
  // sharing a slug count once).
  const tagBySlug = new Map();
  for (const p of posts) {
    const tags = p.fm.tags || [];
    const seen = new Set();
    for (const name of tags) {
      const s = slugify(name);
      if (seen.has(s)) continue;
      seen.add(s);
      let t = tagBySlug.get(s);
      if (t === undefined) {
        t = {
          name,
          slug: s,
          url: base + '/tags/' + s + '/',
          count: 0,
          posts: [],
        };
        tagBySlug.set(s, t);
      }
      t.posts.push(p);
    }
  }
  for (const t of tagBySlug.values()) t.count = t.posts.length;
  const tagsOrdered = [...tagBySlug.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });

  const linkOf = (p) => ({
    title: p.fm.title,
    url: p.url,
    date: p.fm.date || '',
    date_long: p.fm.date ? dateLong(p.fm.date) : '',
  });

  const cardOf = (rec) => {
    if (rec.card) return rec.card;
    const card = {
      title: rec.fm.title,
      url: rec.url,
      date: rec.fm.date || '',
      date_long: rec.fm.date ? dateLong(rec.fm.date) : '',
      summary: rec.fm.summary || '',
      excerpt: rec.excerpt,
      reading_minutes: rec.reading,
      tags: dedupeTags((rec.fm.tags || []).map((name) => {
        const s = slugify(name);
        const t = tagBySlug.get(s);
        return t
          ? { name: t.name, slug: s, url: t.url }
          : { name, slug: s, url: '' };
      })),
    };
    rec.card = card;
    return card;
  };

  // newer / older links for posts.
  const newerOf = new Map();
  const olderOf = new Map();
  for (let i = 0; i < posts.length; i++) {
    newerOf.set(posts[i], i > 0 ? linkOf(posts[i - 1]) : null);
    olderOf.set(posts[i], i < posts.length - 1 ? linkOf(posts[i + 1]) : null);
  }

  const siteVal = { title: site.title, base_url: base };
  const tagsVal = tagsOrdered.map((t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.count,
  }));
  const recentVal = posts.slice(0, recentN).map((p) => cardOf(p));

  const out = Object.create(null);

  // Every page through its layout.
  for (const rec of built) {
    const nodes = compiled.get(rec.layoutName);
    const card = cardOf(rec);
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: rec.slug,
      content: rec.content,
      toc: rec.toc,
      newer: rec.isPost ? newerOf.get(rec) : null,
      older: rec.isPost ? olderOf.get(rec) : null,
      is_post: rec.isPost,
    };
    out[rec.outPath] = renderTemplate(nodes, {
      site: siteVal,
      tags: tagsVal,
      recent: recentVal,
      page,
    }, compiled);
  }

  // Index pages.
  const indexNodes = compiled.get('index');
  if (indexNodes !== undefined) {
    const total = Math.max(1, Math.ceil(posts.length / perPage));
    for (let n = 1; n <= total; n++) {
      const pagePosts = posts.slice((n - 1) * perPage, n * perPage).map((p) => cardOf(p));
      const pager = {
        number: n,
        total,
        url: n === 1 ? base + '/' : base + '/page/' + n + '/',
        newer_url: n > 1 ? (n === 2 ? base + '/' : base + '/page/' + (n - 1) + '/') : '',
        older_url: n < total ? base + '/page/' + (n + 1) + '/' : '',
      };
      out[n === 1 ? 'index.html' : 'page/' + n + '/index.html'] = renderTemplate(
        indexNodes,
        { site: siteVal, tags: tagsVal, recent: recentVal, posts: pagePosts, pager },
        compiled,
      );
    }
  }

  // Tag pages and the tags index.
  const tagNodes = compiled.get('tag');
  if (tagNodes !== undefined) {
    for (const t of tagsOrdered) {
      const tagVal = {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.count,
        posts: t.posts.map((p) => cardOf(p)),
      };
      out['tags/' + t.slug + '/index.html'] = renderTemplate(
        tagNodes,
        { site: siteVal, tags: tagsVal, recent: recentVal, tag: tagVal },
        compiled,
      );
    }
  }
  const tagsNodes = compiled.get('tags');
  if (tagsNodes !== undefined) {
    out['tags/index.html'] = renderTemplate(
      tagsNodes,
      { site: siteVal, tags: tagsVal, recent: recentVal },
      compiled,
    );
  }

  // Static files, unless a built page has their path.
  let staticCount = 0;
  for (const f of statics) {
    staticCount++;
    if (Object.prototype.hasOwnProperty.call(out, f.path)) {
      report.push('shadowed ' + f.path + ': a built page has its path');
    } else {
      out[f.path] = f.content;
    }
  }

  const pageCount = built.length - posts.length;
  report.sort();
  out['build-report.txt'] =
    report.map((l) => l + '\n').join('') +
    'built ' +
    pageCount +
    ' pages, ' +
    posts.length +
    ' posts, ' +
    tagsOrdered.length +
    ' tags and ' +
    staticCount +
    ' static files\n';
  return out;
}
