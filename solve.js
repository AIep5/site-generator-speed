// solve.js — a fast, dependency-free drop-in for makefun-site 1.0.0.
// Written from the vendor README specification plus black-box probing of
// the reference behaviour. Pure JavaScript, no WebAssembly, no native
// addons, no prebuilt binaries. Node 22 safe (no new syntax).

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const PATH_SEG = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FM_KEY = /^([a-z_]+):(.*)$/;
const TEMPLATE_NAME = /^[a-z0-9-]+$/;
const SLUG_VALUE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const FENCE_OPEN = /^```([A-Za-z0-9_+\\-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_OPEN = /^(#{1,6})[ \t]+/;
const HR_LINE = /^(---|\*\*\*)[ \t]*$/;
const BULLET_ITEM = /^[-*] /;
const ORDERED_ITEM = /^(\d{1,9})\. /;
const BLANK_LINE = /^[ \t]*$/;

function escapeHtml(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

function isLeap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

// The slug rule: NFKD, drop combining marks, lowercase, each run of
// non [a-z0-9] becomes one '-', none at either end, cut to 64 chars
// (a trailing '-' left by the cut is dropped), 'untitled' when empty.
function slugify(text) {
  const norm = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let s = norm.length > 64 ? norm.slice(0, 64) : norm;
  if (s.endsWith('-')) s = s.slice(0, -1);
  return s === '' ? 'untitled' : s;
}

function dateLong(d) {
  const y = d.slice(0, 4);
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  return day + ' ' + MONTHS[m - 1] + ' ' + y;
}

function trimEnds(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function validPathText(t) {
  if (t === '') return false;
  const parts = t.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (!PATH_SEG.test(parts[i])) return false;
  }
  return true;
}

// How a bad path is quoted in its error reason: double quotes,
// backslashes and control characters below 0x20 are escaped
// (\b \f \n \r \t short, the rest \u00XX); everything else, DEL
// included, stays raw.
function quotePathText(t) {
  let out = '"';
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else if (c >= 0xd800 && c <= 0xdbff && (i + 1 >= t.length || t.charCodeAt(i + 1) < 0xdc00 || t.charCodeAt(i + 1) > 0xdfff)) out += '\\u' + c.toString(16).padStart(4, '0');
    else if (c >= 0xdc00 && c <= 0xdfff && (i === 0 || t.charCodeAt(i - 1) < 0xd800 || t.charCodeAt(i - 1) > 0xdbff)) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += t[i];
  }
  return out + '"';
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

function parseQuoted(value, key) {
  // value starts with '"'. It must end with a '"' (and be at least 2 long);
  // the inside is scanned for bad escapes and stray quotes.
  if (value.length < 2 || value[value.length - 1] !== '"') {
    return { error: 'key "' + key + '": a quoted string is not closed' };
  }
  const inner = value.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\') {
      const nx = inner[i + 1];
      if (nx !== '"' && nx !== '\\') {
        return { error: 'key "' + key + '": a quoted string holds an escape other than \\" or \\\\' };
      }
      out += nx;
      i++;
    } else if (c === '"') {
      return { error: 'key "' + key + '": a quoted string holds a stray quote' };
    } else {
      out += c;
    }
  }
  return { value: out };
}

function parseStringValue(value, key) {
  if (value[0] === '"') return parseQuoted(value, key);
  if (value[0] === '[') {
    return { error: 'key "' + key + '": a bare string opens on [' };
  }
  return { value };
}

function parseDateValue(value, key) {
  if (!DATE_VALUE.test(value)) {
    return { error: 'key "' + key + '": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (m < 1 || m > 12) {
    return { error: 'key "' + key + '": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  let dim = DAYS_IN_MONTH[m - 1];
  if (m === 2 && isLeap(y)) dim = 29;
  if (d < 1 || d > dim) {
    return { error: 'key "' + key + '": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (value < '1970-01-01' || value > '2099-12-31') {
    return { error: 'key "' + key + '": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  return { value };
}

function parseTagsValue(value, key) {
  if (!value.startsWith('[') || !value.endsWith(']')) {
    return { error: 'key "' + key + '": not a list [a, b]' };
  }
  const inner = value.slice(1, -1);
  if (/^[ \t]*$/.test(inner)) return { value: [] };
  const parts = inner.split(',');
  const names = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const name = trimEnds(parts[i]);
    if (name === '' || name.indexOf('"') >= 0 || name.indexOf('[') >= 0 || name.indexOf(']') >= 0) {
      return { error: 'key "' + key + '": an empty tag, or one holding " [ or ]' };
    }
    names[i] = name;
  }
  return { value: names };
}

function parseKeyValue(key, value) {
  if (key === 'title' || key === 'summary') return parseStringValue(value, key);
  if (key === 'date') return parseDateValue(value, key);
  if (key === 'tags') return parseTagsValue(value, key);
  if (key === 'draft') {
    if (value === 'true') return { value: true };
    if (value === 'false') return { value: false };
    return { error: 'key "' + key + '": true or false' };
  }
  if (key === 'layout') {
    if (!TEMPLATE_NAME.test(value)) {
      return { error: 'key "' + key + '": not a template name' };
    }
    return { value };
  }
  if (key === 'slug') {
    if (value.length > 64 || !SLUG_VALUE.test(value)) {
      return { error: 'key "' + key + '": not a slug' };
    }
    return { value };
  }
  return { error: 'unknown key "' + key + '"' };
}

const KNOWN_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);

// Parses the front matter of lines (the whole file, split on '\n').
// Returns { data, closeIndex } or { refuse }.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { refuse: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close < 0) return { refuse: 'the front matter is not closed' };
  const data = {};
  const seen = new Set();
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    const n = i + 1;
    if (BLANK_LINE.test(line)) continue;
    if (line[0] === '#') continue;
    const m = FM_KEY.exec(line);
    if (!m) return { refuse: 'line ' + n + ' is not "key: value"' };
    const key = m[1];
    const rest = m[2];
    if (rest !== '' && rest[0] !== ' ') {
      return { refuse: 'line ' + n + ' is not "key: value"' };
    }
    if (!KNOWN_KEYS.has(key)) return { refuse: 'unknown key "' + key + '"' };
    if (seen.has(key)) return { refuse: 'key "' + key + '" is given twice' };
    seen.add(key);
    let value = rest === '' ? '' : rest.slice(1);
    value = value.replace(/[ \t]+$/, '');
    if (value === '') return { refuse: 'key "' + key + '" has no value' };
    const parsed = parseKeyValue(key, value);
    if (parsed.error) return { refuse: parsed.error };
    data[key] = parsed.value;
  }
  if (!seen.has('title')) return { refuse: 'no title' };
  return { data, closeIndex: close };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

// Node kinds: text, out, if, for, include.
// Parsing is a single scan with an explicit frame stack. A {% %} tag that
// stands alone on its line (only spaces/tabs beside it) takes the whole
// line, newline included, with it.

function parseTemplate(src) {
  // Phase A — scan the template left to right. Expression paths are
  // validated the moment their }} closes, so a bad path beats every
  // error that comes after it, and an unclosed {{ / {{{ / {% beats
  // every error that comes after it. Tag tokens are only recorded
  // here; their shapes and the block structure are checked in phase B.
  const toks = [];
  let i = 0;
  const n = src.length;
  let lineClean = true; // current line holds only spaces/tabs so far
  let lineSpaces = 0; // trailing spaces/tabs on the current line, in the last text token
  function addText(s) {
    if (s === '') return;
    const last = toks[toks.length - 1];
    if (last && last.t === 'text') last.s += s;
    else toks.push({ t: 'text', s });
    const idx = s.lastIndexOf('\n');
    const seg = idx < 0 ? (lineClean ? '' : null) : null;
    if (idx >= 0) {
      const tail = s.slice(idx + 1);
      if (/^[ \t]*$/.test(tail)) {
        lineClean = true;
        lineSpaces = tail.length;
      } else {
        lineClean = false;
        lineSpaces = 0;
      }
    } else if (lineClean) {
      if (/^[ \t]*$/.test(s)) {
        lineSpaces += s.length;
      } else {
        lineClean = false;
        lineSpaces = 0;
      }
    }
    void seg;
  }
  function markDirty() {
    lineClean = false;
    lineSpaces = 0;
  }

  while (i < n) {
    const pMustache = src.indexOf('{{', i);
    const pTag = src.indexOf('{%', i);
    let p = -1;
    let isTag = false;
    if (pMustache < 0 && pTag < 0) {
      addText(src.slice(i));
      break;
    }
    if (pTag >= 0 && (pMustache < 0 || pTag < pMustache)) {
      p = pTag;
      isTag = true;
    } else {
      p = pMustache;
    }
    if (p > i) addText(src.slice(i, p));

    if (!isTag) {
      const raw = src[p + 2] === '{';
      const openLen = raw ? 3 : 2;
      const closer = raw ? '}}}' : '}}';
      const close = src.indexOf(closer, p + openLen);
      if (close < 0) {
        return { error: raw ? 'a {{{ is not closed' : 'a {{ is not closed' };
      }
      const inner = src.slice(p + openLen, close).trim();
      if (!validPathText(inner)) {
        return { error: quotePathText(inner) + ' is not a path' };
      }
      toks.push({ t: 'out', path: inner.split('.'), raw });
      markDirty();
      i = close + closer.length;
      continue;
    }

    // {% ... %}
    const close = src.indexOf('%}', p + 2);
    if (close < 0) return { error: 'a {% is not closed' };
    const innerTrim = src.slice(p + 2, close).trim();

    // Standalone-tag check: only spaces/tabs on this line before the
    // tag, and only spaces/tabs up to the newline (or end) after it.
    let standalone = false;
    let afterEnd = close + 2;
    if (lineClean) {
      let j = close + 2;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j >= n || src[j] === '\n') {
        standalone = true;
        afterEnd = j + (j < n ? 1 : 0);
      }
    }
    if (standalone) {
      const last = toks[toks.length - 1];
      if (last && last.t === 'text' && lineSpaces > 0) {
        last.s = last.s.slice(0, last.s.length - lineSpaces);
        if (last.s === '') toks.pop();
      }
      lineClean = true;
      lineSpaces = 0;
    } else {
      markDirty();
    }
    toks.push({ t: 'tag', inner: innerTrim });
    i = afterEnd;
  }

  // Phase B — validate tags and build the block tree, in token order.
  const root = [];
  const stack = [{ kind: 'root', curList: root }];
  let cur = root;
  for (const tok of toks) {
    if (tok.t === 'text') {
      const last = cur[cur.length - 1];
      if (last && last.t === 'text') last.s += tok.s;
      else cur.push({ t: 'text', s: tok.s });
      continue;
    }
    if (tok.t === 'out') {
      cur.push({ t: 'out', path: tok.path, raw: tok.raw });
      continue;
    }
    const innerTrim = tok.inner;
    const top = stack[stack.length - 1];
    if (innerTrim === 'endif') {
      if (top.kind !== 'if') return { error: 'an endif with no open if' };
      stack.pop();
      const parent = stack[stack.length - 1];
      parent.curList.push(top.node);
      cur = parent.curList;
      continue;
    }
    if (innerTrim === 'endfor') {
      if (top.kind !== 'for') return { error: 'an endfor with no open for' };
      stack.pop();
      const parent = stack[stack.length - 1];
      parent.curList.push(top.node);
      cur = parent.curList;
      continue;
    }
    if (innerTrim === 'else') {
      if (top.kind !== 'if' || top.seenElse) {
        return { error: 'an else outside an if' };
      }
      top.seenElse = true;
      top.node.els = [];
      top.curList = top.node.els;
      cur = top.node.els;
      continue;
    }
    // Tag words are separated by exactly one space; anything else is
    // not a tag, including a word holding a tab or other whitespace.
    // A shape that fits but holds a bad path reports the path.
    const tokens = innerTrim.split(' ');
    if (tokens.some((w) => w === '' || /\s/.test(w))) {
      return { error: '{% ' + innerTrim + ' %} is not a tag' };
    }
    if (tokens[0] === 'for') {
      if (tokens.length === 4 && tokens[2] === 'in' && PATH_SEG.test(tokens[1])) {
        if (!validPathText(tokens[3])) {
          return { error: quotePathText(tokens[3]) + ' is not a path' };
        }
        const node = { t: 'for', vr: tokens[1], path: tokens[3].split('.'), body: [] };
        stack.push({ kind: 'for', node, curList: node.body });
        cur = node.body;
        continue;
      }
      return { error: '{% ' + innerTrim + ' %} is not a tag' };
    }
    if (tokens[0] === 'if') {
      let neg = false;
      let pathText = null;
      let shapeOk = false;
      if (tokens.length === 2) {
        if (tokens[1] === 'not') {
          neg = true;
          shapeOk = true;
        } else {
          pathText = tokens[1];
          shapeOk = true;
        }
      } else if (tokens.length === 3 && tokens[1] === 'not') {
        neg = true;
        pathText = tokens[2];
        shapeOk = true;
      }
      if (!shapeOk) {
        return { error: '{% ' + innerTrim + ' %} is not a tag' };
      }
      if (pathText !== null && !validPathText(pathText)) {
        return { error: quotePathText(pathText) + ' is not a path' };
      }
      const node = {
        t: 'if',
        path: pathText === null ? null : pathText.split('.'),
        not: neg,
        then: [],
        els: null,
      };
      stack.push({ kind: 'if', node, seenElse: false, curList: node.then });
      cur = node.then;
      continue;
    }
    const inc = /^include "([a-z0-9-]+)"$/.exec(innerTrim);
    if (inc) {
      cur.push({ t: 'include', name: inc[1] });
      continue;
    }
    return { error: '{% ' + innerTrim + ' %} is not a tag' };
  }

  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    return { error: 'a ' + top.kind + ' is not closed' };
  }
  return { nodes: root };
}

function ownProp(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

// Resolves a path: the first name comes from the innermost loop scope
// that binds it ('loop' reads the loop object before any element), else
// from the page's values; each following name is an own property.
function resolvePath(segs, env, scopes) {
  let v;
  let i = 0;
  const first = segs[0];
  for (let s = scopes.length - 1; s >= 0; s--) {
    const sc = scopes[s];
    if (first === 'loop') {
      v = sc.loop;
      i = 1;
      break;
    }
    if (first === sc.vr) {
      v = sc.val;
      i = 1;
      break;
    }
  }
  if (i === 0) {
    v = ownProp(env, first);
    i = 1;
  }
  for (; i < segs.length; i++) {
    if (v === null || v === undefined) return undefined;
    v = ownProp(v, segs[i]);
    if (v === undefined) return undefined;
  }
  return v;
}

function writeValue(v) {
  if (v === null || v === undefined) return '';
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number' || t === 'boolean') return String(v);
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += writeValue(v[i]);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function renderNodes(nodes, env, scopes, templates, depth, out) {
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    if (node.t === 'text') {
      out.push(node.s);
    } else if (node.t === 'out') {
      const v = resolvePath(node.path, env, scopes);
      const s = writeValue(v);
      out.push(node.raw ? s : escapeHtml(s));
    } else if (node.t === 'if') {
      let cond = node.path === null ? undefined : resolvePath(node.path, env, scopes);
      let ok = truthy(cond);
      if (node.not) ok = !ok;
      const branch = ok ? node.then : node.els;
      if (branch) renderNodes(branch, env, scopes, templates, depth, out);
    } else if (node.t === 'for') {
      const arr = resolvePath(node.path, env, scopes);
      if (Array.isArray(arr)) {
        for (let idx = 0; idx < arr.length; idx++) {
          const loop = {
            index: idx + 1,
            first: idx === 0,
            last: idx === arr.length - 1,
            length: arr.length,
          };
          scopes.push({ vr: node.vr, val: arr[idx], loop });
          renderNodes(node.body, env, scopes, templates, depth, out);
          scopes.pop();
        }
      }
    } else if (node.t === 'include') {
      if (depth < 8) {
        const tpl = templates[node.name];
        if (tpl && tpl.nodes) {
          renderNodes(tpl.nodes, env, scopes, templates, depth + 1, out);
        }
      }
    }
  }
}

function renderTemplate(tpl, env, templates) {
  const out = [];
  renderNodes(tpl.nodes, env, [], templates, 0, out);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

// Resolves one link target for the source at sourceDir (the source path's
// directory string). Returns { href, broken } and records broken links.
function makeLinkResolver(sourcePath, sourceDir, base, pageBySource, staticSet, brokenLines) {
  return function resolve(target) {
    const hashAt = target.indexOf('#');
    const pathPart = hashAt < 0 ? target : target.slice(0, hashAt);
    const frag = hashAt < 0 ? null : target.slice(hashAt + 1);
    if (pathPart === '') return { href: target, broken: false };
    if (pathPart[0] === '/' || SCHEME.test(pathPart)) {
      return { href: target, broken: false };
    }
    let p = sourceDir;
    const segs = pathPart.split('/');
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (p === '') return { href: target, broken: true };
        const slash = p.lastIndexOf('/');
        p = slash < 0 ? '' : p.slice(0, slash);
        continue;
      }
      p = p === '' ? seg : p + '/' + seg;
    }
    let href;
    if (pageBySource.has(p)) {
      href = pageBySource.get(p);
    } else if (staticSet.has(p)) {
      href = base + '/' + p;
    } else {
      return { href: target, broken: true };
    }
    if (frag !== null) href += '#' + frag;
    return { href, broken: false };
  };
}

// Inline parsing: one left-to-right pass with recursion into span contents.
// The resolver is consulted for every link; broken ones are recorded once
// per (source, target) pair by the caller-supplied set.
function renderInline(s, resolve, recordBroken) {
  let out = '';
  let i = 0;
  const n = s.length;
  // boundary: true when the character just before i was consumed as part
  // of a span or an escape, so a * here has no live * neighbour on its
  // left. Literal text (including stars left literal by a failed span)
  // clears it, except a failed ** pair, which is consumed as a unit.
  let boundary = true;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        out += escapeHtml(nx);
        i += 2;
        boundary = true;
      } else {
        out += '\\';
        i++;
        boundary = false;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        boundary = true;
      } else {
        out += '`';
        i++;
        boundary = false;
      }
      continue;
    }
    if (c === '*' && s[i + 1] === '*') {
      // Strong is a unit: the first unescaped ** after the opener
      // closes it. No closer, or an empty span, leaves both stars
      // literal and moves past the pair.
      let j = i + 2;
      let closer = -1;
      while (j + 1 < n) {
        if (s[j] === '\\' && ESCAPABLE.has(s[j + 1])) {
          j += 2;
          continue;
        }
        if (s[j] === '*' && s[j + 1] === '*') {
          closer = j;
          break;
        }
        j++;
      }
      if (closer < 0 || closer === i + 2) {
        out += '**';
        i += 2;
      } else {
        out += '<strong>' + renderInline(s.slice(i + 2, closer), resolve, recordBroken) + '</strong>';
        i = closer + 2;
      }
      boundary = true;
      continue;
    }
    if (c === '*') {
      // Emphasis: a single * is one with no live * beside it. A *
      // consumed by an escape or a span does not count on the left.
      const single = boundary || s[i - 1] !== '*';
      if (!single) {
        out += '*';
        i++;
        boundary = false;
        continue;
      }
      // Closer search: escape pairs and ** pairs are stepped over as
      // units and leave no live neighbour behind them.
      let j = i + 1;
      let closer = -1;
      let dead = false;
      while (j < n) {
        if (s[j] === '\\' && ESCAPABLE.has(s[j + 1])) {
          j += 2;
          dead = true;
          continue;
        }
        if (s[j] === '*' && s[j + 1] === '*') {
          j += 2;
          dead = true;
          continue;
        }
        if (s[j] === '*') {
          const leftOk = dead || s[j - 1] !== '*';
          const rightOk = j + 1 >= n || s[j + 1] !== '*';
          if (leftOk && rightOk && j > i + 1) {
            closer = j;
            break;
          }
          j++;
          dead = false;
          continue;
        }
        j++;
        dead = false;
      }
      if (closer < 0) {
        out += '*';
        i++;
        boundary = false;
      } else {
        out += '<em>' + renderInline(s.slice(i + 1, closer), resolve, recordBroken) + '</em>';
        i = closer + 1;
        boundary = true;
      }
      continue;
    }
    if (c === '[') {
      // A link: the first unescaped ] closes the text, ( must follow at
      // once, the next ) closes a target with no whitespace in it.
      let j = i + 1;
      let closeBracket = -1;
      while (j < n) {
        if (s[j] === '\\' && ESCAPABLE.has(s[j + 1])) {
          j += 2;
          continue;
        }
        if (s[j] === ']') {
          closeBracket = j;
          break;
        }
        j++;
      }
      if (closeBracket < 0 || s[closeBracket + 1] !== '(') {
        out += '[';
        i++;
        boundary = false;
        continue;
      }
      const closeParen = s.indexOf(')', closeBracket + 2);
      if (closeParen < 0) {
        out += '[';
        i++;
        boundary = false;
        continue;
      }
      const target = s.slice(closeBracket + 2, closeParen);
      if (target === '' || /[ \t\n]/.test(target)) {
        out += '[';
        i++;
        boundary = false;
        continue;
      }
      const r = resolve(target);
      if (r.broken) recordBroken(target);
      out += '<a href="' + escapeHtml(r.href) + '">' +
        renderInline(s.slice(i + 1, closeBracket), resolve, recordBroken) + '</a>';
      i = closeParen + 1;
      boundary = true;
      continue;
    }
    out += escapeHtml(c);
    i++;
    boundary = false;
  }
  return out;
}

function headingParts(line) {
  const m = HEADING_OPEN.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length).replace(/[ \t]+$/, '');
  if (rest === '') return null;
  return { level: m[1].length, text: rest };
}

function countWords(lines) {
  let count = 0;
  for (let li = 0; li < lines.length; li++) {
    const m = lines[li].match(/\S+/g);
    if (m) count += m.length;
  }
  return count;
}

// Renders one source body. Returns { html, excerpt, toc, readingMinutes }.
function renderBody(bodyLines, resolve, recordBroken) {
  const parts = [];
  const toc = [];
  const takenIds = new Set();
  let excerpt = '';
  let excerptDone = false;
  let i = 0;
  const n = bodyLines.length;

  function uniqueId(base) {
    let id = base;
    let k = 2;
    while (takenIds.has(id)) {
      id = base + '-' + k;
      k++;
    }
    takenIds.add(id);
    return id;
  }

  while (i < n) {
    const line = bodyLines[i];
    if (BLANK_LINE.test(line)) {
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const lang = fence[1];
      const body = [];
      let j = i + 1;
      while (j < n && !FENCE_CLOSE.test(bodyLines[j])) {
        body.push(bodyLines[j]);
        j++;
      }
      let s = '<pre><code';
      if (lang !== '') s += ' class="language-' + lang + '"';
      s += '>';
      for (let b = 0; b < body.length; b++) s += escapeHtml(body[b]) + '\n';
      s += '</code></pre>\n';
      parts.push(s);
      i = j < n ? j + 1 : j;
      continue;
    }
    const head = headingParts(line);
    if (head) {
      const inner = renderInline(head.text, resolve, recordBroken);
      const base = slugify(head.text);
      const id = uniqueId(base);
      parts.push('<h' + head.level + ' id="' + id + '">' + inner + '</h' + head.level + '>\n');
      if (head.level === 2 || head.level === 3) {
        toc.push({ level: head.level, id, html: inner });
      }
      i++;
      continue;
    }
    if (HR_LINE.test(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const collected = [];
      while (i < n && bodyLines[i][0] === '>') {
        let l = bodyLines[i].slice(1);
        if (l[0] === ' ' || l[0] === '\t') l = l.slice(1);
        l = trimEnds(l);
        if (l !== '') collected.push(l);
        i++;
      }
      if (collected.length > 0) {
        parts.push('<blockquote>\n<p>' + renderInline(collected.join('\n'), resolve, recordBroken) + '</p>\n</blockquote>\n');
      } else {
        parts.push('<blockquote>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = BULLET_ITEM.test(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (bullet || ordered) {
      const kind = bullet ? 'ul' : 'ol';
      const start = bullet ? 1 : Number(ordered[1]);
      const items = [];
      while (i < n) {
        const l = bodyLines[i];
        if (/^ {2,}\S/.test(l)) {
          items[items.length - 1] += '\n' + trimEnds(l);
          i++;
          continue;
        }
        if (bullet && BULLET_ITEM.test(l)) {
          items.push(trimEnds(l.slice(2)));
          i++;
          continue;
        }
        const om = !bullet ? ORDERED_ITEM.exec(l) : null;
        if (om) {
          items.push(trimEnds(l.slice(om[0].length)));
          i++;
          continue;
        }
        break;
      }
      let s = kind === 'ul' ? '<ul>\n' : (start === 1 ? '<ol>\n' : '<ol start="' + start + '">\n');
      for (let b = 0; b < items.length; b++) {
        s += '<li>' + renderInline(items[b], resolve, recordBroken) + '</li>\n';
      }
      s += kind === 'ul' ? '</ul>\n' : '</ol>\n';
      parts.push(s);
      continue;
    }
    // Paragraph: lines up to a blank line, fence, heading or break.
    const para = [trimEnds(line)];
    let j = i + 1;
    while (j < n) {
      const l = bodyLines[j];
      if (BLANK_LINE.test(l) || FENCE_OPEN.test(l) || headingParts(l) || HR_LINE.test(l)) break;
      para.push(trimEnds(l));
      j++;
    }
    const inner = renderInline(para.join('\n'), resolve, recordBroken);
    parts.push('<p>' + inner + '</p>\n');
    if (!excerptDone) { excerpt = inner; excerptDone = true; }
    i = j;
  }

  const words = countWords(bodyLines);
  const readingMinutes = Math.max(1, Math.ceil(words / 200));
  return { html: parts.join(''), excerpt, toc, readingMinutes };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function dirOf(path) {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function run(input) {
  const site = input.site || {};
  const templatesIn = input.templates || {};
  const files = input.files || [];

  const base = String(site.base_url === undefined ? '' : site.base_url).replace(/\/+$/, '');
  const siteData = { title: site.title, base_url: base };

  // Templates: parsed in code-unit order of name; every failure is
  // reported, whether or not the template is ever used.
  const templates = {};
  const templateLines = [];
  const names = Object.keys(templatesIn).sort();
  for (let ni = 0; ni < names.length; ni++) {
    const name = names[ni];
    const parsed = parseTemplate(String(templatesIn[name]));
    if (parsed.error) {
      templates[name] = { error: parsed.error };
      templateLines.push('template "' + name + '": ' + parsed.error);
    } else {
      templates[name] = parsed;
    }
  }

  // Split sources from statics; sources sorted by path in code-unit order.
  const sources = [];
  const statics = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (String(f.path).endsWith('.md')) sources.push(f);
    else statics.push(f);
  }
  sources.sort((a, b) => cmpStr(a.path, b.path));

  const refusedLines = [];
  const draftLines = [];
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const f = sources[si];
    const path = String(f.path);
    const content = String(f.content).replace(/\r\n?/g, '\n');
    const lines = content.split('\n');
    const fm = parseFrontMatter(lines);
    if (fm.refuse) {
      refusedLines.push('refused ' + path + ': ' + fm.refuse);
      continue;
    }
    if (path.startsWith('tags/')) {
      refusedLines.push('refused ' + path + ": tags/ is the generator's own");
      continue;
    }
    if (path.startsWith('page/')) {
      refusedLines.push('refused ' + path + ": page/ is the generator's own");
      continue;
    }
    const data = fm.data;
    const isPost = path.startsWith('posts/');
    if (isPost && data.date === undefined) {
      refusedLines.push('refused ' + path + ': a post needs a date');
      continue;
    }
    const layoutName = data.layout !== undefined ? data.layout : isPost ? 'post' : 'page';
    const layoutTpl = templates[layoutName];
    if (!layoutTpl || layoutTpl.error) {
      refusedLines.push('refused ' + path + ': layout "' + layoutName + '" is no template that parses');
      continue;
    }
    if (data.draft === true) {
      draftLines.push('draft ' + path);
      continue;
    }
    kept.push({
      path,
      dir: dirOf(path),
      isPost,
      fm: data,
      layoutName,
      bodyLines: lines.slice(fm.closeIndex + 1),
    });
  }

  // Slugs: unique in each output directory, in source order. A post's
  // directory is always `posts/`; a page keeps its source directory.
  // At the root the names posts, tags and page are already taken.
  const takenByDir = new Map();
  takenByDir.set('', new Set(['posts', 'tags', 'page']));
  for (let ki = 0; ki < kept.length; ki++) {
    const k = kept[ki];
    const outDir = k.isPost ? 'posts' : k.dir;
    let taken = takenByDir.get(outDir);
    if (!taken) {
      taken = new Set();
      takenByDir.set(outDir, taken);
    }
    const baseSlug = k.fm.slug !== undefined ? k.fm.slug : slugify(k.fm.title);
    let slug = baseSlug;
    let suffix = 2;
    while (taken.has(slug)) {
      slug = baseSlug + '-' + suffix;
      suffix++;
    }
    taken.add(slug);
    k.slug = slug;
    k.outPath = (outDir === '' ? '' : outDir + '/') + slug + '/index.html';
    k.url = base + '/' + (outDir === '' ? '' : outDir + '/') + slug + '/';
  }

  // Render every body now that page urls and static paths are known.
  const staticSet = new Set();
  for (let fi = 0; fi < statics.length; fi++) staticSet.add(String(statics[fi].path));
  const pageBySource = new Map();
  for (let ki = 0; ki < kept.length; ki++) pageBySource.set(kept[ki].path, kept[ki].url);

  const brokenSet = new Set();
  for (let ki = 0; ki < kept.length; ki++) {
    const k = kept[ki];
    const resolve = makeLinkResolver(k.path, k.dir, base, pageBySource, staticSet, brokenSet);
    const recordBroken = (target) => {
      brokenSet.add('broken-link ' + k.path + ' -> ' + target);
    };
    const rendered = renderBody(k.bodyLines, resolve, recordBroken);
    k.content = rendered.html;
    k.excerpt = rendered.excerpt;
    k.toc = rendered.toc;
    k.readingMinutes = rendered.readingMinutes;
  }

  // Collections: posts newest first, equal dates by slug in code-unit order.
  const posts = kept.filter((k) => k.isPost);
  posts.sort((a, b) => {
    const d = cmpStr(b.fm.date, a.fm.date);
    return d !== 0 ? d : cmpStr(a.slug, b.slug);
  });

  function linkObj(card) {
    return { title: card.title, url: card.url, date: card.date, date_long: card.date_long };
  }

  const cards = new Map();
  for (let ki = 0; ki < kept.length; ki++) {
    const k = kept[ki];
    const date = k.fm.date !== undefined ? k.fm.date : '';
    const card = {
      title: k.fm.title,
      url: k.url,
      date,
      date_long: date === '' ? '' : dateLong(date),
      summary: k.fm.summary !== undefined ? k.fm.summary : '',
      excerpt: k.excerpt,
      reading_minutes: k.readingMinutes,
      tags: [],
      slug: k.slug,
      content: k.content,
      toc: k.toc,
      newer: null,
      older: null,
      is_post: k.isPost,
    };
    cards.set(k, card);
  }
  for (let pi = 0; pi < posts.length; pi++) {
    const card = cards.get(posts[pi]);
    if (pi > 0) card.newer = linkObj(cards.get(posts[pi - 1]));
    if (pi < posts.length - 1) card.older = linkObj(cards.get(posts[pi + 1]));
  }

  // Tags: first spelling kept, walking the posts in collection order;
  // ordered by count desc, then slug asc.
  const tagMap = new Map();
  for (let pi = 0; pi < posts.length; pi++) {
    const post = posts[pi];
    const seenSlugs = new Set();
    const tagNames = post.fm.tags || [];
    for (let ti = 0; ti < tagNames.length; ti++) {
      const s = slugify(tagNames[ti]);
      if (seenSlugs.has(s)) continue;
      seenSlugs.add(s);
      let rec = tagMap.get(s);
      if (!rec) {
        rec = {
          name: tagNames[ti],
          slug: s,
          url: base + '/tags/' + s + '/',
          count: 0,
          posts: [],
        };
        tagMap.set(s, rec);
      }
      rec.count++;
      rec.posts.push(cards.get(post));
    }
  }
  const tagsArr = Array.from(tagMap.values());
  tagsArr.sort((a, b) => (b.count - a.count) || cmpStr(a.slug, b.slug));

  // Fill each card's tags from the global records.
  for (let ki = 0; ki < kept.length; ki++) {
    const k = kept[ki];
    const card = cards.get(k);
    const tagNames = k.fm.tags || [];
    const seenSlugs = new Set();
    for (let ti = 0; ti < tagNames.length; ti++) {
      const s = slugify(tagNames[ti]);
      if (seenSlugs.has(s)) continue;
      seenSlugs.add(s);
      const rec = tagMap.get(s);
      if (rec) {
        card.tags.push({ name: rec.name, slug: rec.slug, url: rec.url });
      } else {
        card.tags.push({ name: tagNames[ti], slug: s, url: '' });
      }
    }
  }

  // Index/tag/tags templates see the same tags and recent lists.
  const tagsForTemplates = tagsArr.map((t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.count,
  }));
  const recentCount = Number(site.recent);
  const recent = Number.isFinite(recentCount) && recentCount > 0
    ? posts.slice(0, Math.floor(recentCount)).map((p) => cards.get(p))
    : [];

  const out = {};

  // Source pages through their layouts.
  for (let ki = 0; ki < kept.length; ki++) {
    const k = kept[ki];
    const env = {
      page: cards.get(k),
      site: siteData,
      tags: tagsForTemplates,
      recent,
    };
    out[k.outPath] = renderTemplate(templates[k.layoutName], env, templates);
  }

  // Index pages.
  const indexTpl = templates.index;
  if (indexTpl && indexTpl.nodes) {
    let ppn = Number(site.per_page);
    let perPage;
    if (Number.isFinite(ppn) && ppn > 0) perPage = ppn;
    else if (site.per_page === undefined) perPage = NaN;
    else perPage = 1;
    let total = 0;
    if (Number.isFinite(perPage)) {
      total = posts.length === 0 ? 1 : Math.ceil(posts.length / perPage);
    }
    for (let p = 1; p <= total; p++) {
      const pagePosts = posts.slice((p - 1) * perPage, p * perPage)
        .map((x) => cards.get(x));
      const pager = {
        number: p,
        total,
        url: p === 1 ? base + '/' : base + '/page/' + p + '/',
        newer_url: p === 1 ? '' : p === 2 ? base + '/' : base + '/page/' + (p - 1) + '/',
        older_url: p === total ? '' : base + '/page/' + (p + 1) + '/',
      };
      const env = {
        posts: pagePosts,
        pager,
        site: siteData,
        tags: tagsForTemplates,
        recent,
      };
      const outPath = p === 1 ? 'index.html' : 'page/' + p + '/index.html';
      out[outPath] = renderTemplate(indexTpl, env, templates);
    }
  }

  // Tag pages.
  const tagTpl = templates.tag;
  if (tagTpl && tagTpl.nodes) {
    for (let ti = 0; ti < tagsArr.length; ti++) {
      const t = tagsArr[ti];
      const env = {
        tag: {
          name: t.name,
          slug: t.slug,
          url: t.url,
          count: t.count,
          posts: t.posts,
        },
        site: siteData,
        tags: tagsForTemplates,
        recent,
      };
      out['tags/' + t.slug + '/index.html'] = renderTemplate(tagTpl, env, templates);
    }
  }

  // Tags index.
  const tagsTpl = templates.tags;
  if (tagsTpl && tagsTpl.nodes) {
    out['tags/index.html'] = renderTemplate(tagsTpl, {
      site: siteData,
      tags: tagsForTemplates,
      recent,
    }, templates);
  }

  // Static files at their own paths, unless a built page — or an
  // earlier static — already has the path: one shadowed line per
  // colliding static, first write wins.
  const shadowedLines = [];
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    const p = String(f.path);
    if (Object.prototype.hasOwnProperty.call(out, p)) {
      shadowedLines.push('shadowed ' + p + ': a built page has its path');
    } else {
      out[p] = String(f.content);
    }
  }

  // Report: every line sorted in code-unit order, then the built line last.
  const reportLines = [];
  brokenSet.forEach((l) => reportLines.push(l));
  for (let i = 0; i < draftLines.length; i++) reportLines.push(draftLines[i]);
  for (let i = 0; i < refusedLines.length; i++) reportLines.push(refusedLines[i]);
  for (let i = 0; i < templateLines.length; i++) reportLines.push(templateLines[i]);
  for (let i = 0; i < shadowedLines.length; i++) reportLines.push(shadowedLines[i]);
  reportLines.sort();
  let pageCount = 0;
  for (let ki = 0; ki < kept.length; ki++) if (!kept[ki].isPost) pageCount++;
  reportLines.push(
    'built ' + pageCount + ' pages, ' + posts.length + ' posts, ' +
    tagsArr.length + ' tags and ' + statics.length + ' static files',
  );
  out['build-report.txt'] = reportLines.join('\n') + '\n';
  return out;
}
