// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as makefun-site, byte for byte, on every input; built for speed:
//   - templates are compiled once per build into straight-line render functions
//     (no AST walk, no per-node dispatch, no per-render scope spreads),
//   - Markdown inline runs are escaped in bulk instead of one regex per character,
//   - the lexer short-circuits on each line's first character,
//   - front matter is found with indexOf scans instead of splitting the whole source,
//   - slugify has an ASCII fast path and a cache.
// Node 22 standard library only; no imports at all.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const NEEDS_ESCAPE = /[&<>"']/;

function escapeHtml(text) {
  if (!NEEDS_ESCAPE.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// ---------------------------------------------------------------- slugs

const SLUG_MAX = 64;
const slugCache = new Map();

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (isAscii(text)) {
    out = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let s = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s.slice(0, SLUG_MAX).replace(/-+$/, '');
  }
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

function isAscii(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace, counted without allocating. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // JavaScript's \s: \t \n \v \f \r space, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * Same messages and order as the reference; found with indexOf scans so the body is never split and re-joined.
 */
function parseFrontMatter(text) {
  // The first line must be exactly "---".
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line: a line that is exactly "---".
  let closeStart = -1;
  let closeEnd = -1;
  let pos = 4; // just past the opening "---\n" (or the whole text when it is exactly "---")
  if (text === '---') return { error: 'the front matter is not closed' };
  while (pos <= text.length) {
    const eol = text.indexOf('\n', pos);
    const lineEnd = eol === -1 ? text.length : eol;
    if (text.slice(pos, lineEnd) === '---') {
      closeStart = pos;
      closeEnd = eol === -1 ? text.length : eol + 1;
      break;
    }
    if (eol === -1) break;
    pos = eol + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1; // the opening "---" is line 1
  let p = 4;
  while (p < closeStart) {
    const eol = text.indexOf('\n', p);
    const lineEnd = eol === -1 ? closeStart : eol;
    const line = text.slice(p, lineEnd);
    lineNo++;
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = eol === -1 ? closeStart : eol + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;

const trimLine = (line) => {
  const n = line.length;
  if (n === 0) return line;
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(n - 1);
  if (c0 !== 32 && c0 !== 9 && c1 !== 32 && c1 !== 9) return line;
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
};

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null; // not '#'
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 35) return headingOf(line) !== null; // '#'
  if (c === 96) return FENCE_OPEN.test(line); // '`'
  if (c === 45 || c === 42) return HR.test(line); // '-' or '*'
  return isBlank(line);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const SPECIAL = /[\\`*[]/g;

/** `s` rendered inline; `env.link(target)` is a link's href. Same output as the reference, scanned in bulk. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(s);
    const next = m === null ? n : m.index;
    if (next > i) out += escapeHtml(s.slice(i, next));
    if (m === null) break;
    const c = s[next];
    if (c === '\\') {
      if (next + 1 < n && ESCAPABLE.has(s[next + 1])) {
        out += escapeHtml(s[next + 1]);
        i = next + 2;
      } else {
        out += '\\';
        i = next + 1;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', next + 1);
      if (j > next + 1) {
        out += `<code>${escapeHtml(s.slice(next + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i = next + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[next + 1] === '*') {
        const j = findUnescaped(s, '**', next + 2);
        if (j > next + 2) {
          out += `<strong>${inline(s.slice(next + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i = next + 2;
        }
        continue;
      }
      const j = findSingleStar(s, next + 1);
      if (j > next + 1) {
        out += `<em>${inline(s.slice(next + 1, j), env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i = next + 1;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', next + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(next + 1, k), env)}</a>`;
      i = mm + 1;
      continue;
    }
    out += '[';
    i = next + 1;
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * One pass over the lines; blocks are rendered as they are scanned.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let i = 0;
  // The current line's bounds. One reused pair: every caller reads the line and its end before the next call.
  const _la = ['', 0];
  const lineAt = (p) => {
    const e = src.indexOf('\n', p);
    if (e === -1) {
      _la[0] = src.slice(p);
      _la[1] = n;
    } else {
      _la[0] = src.slice(p, e);
      _la[1] = e + 1;
    }
    return _la;
  };
  while (i < n) {
    const [line, ni] = lineAt(i);
    if (isBlank(line)) {
      i = ni;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // Fence.
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i = ni;
        while (i < n) {
          const [l2, ni2] = lineAt(i);
          if (FENCE_CLOSE.test(l2)) {
            i = ni2;
            break;
          }
          body.push(l2);
          i = ni2;
        }
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        let code = '';
        for (const l of body) code += `${escapeHtml(l)}\n`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    }
    // Heading.
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i = ni;
        continue;
      }
    }
    // Thematic break.
    if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        blocks.push('<hr>');
        i = ni;
        continue;
      }
    }
    // Blockquote.
    if (c0 === 62) {
      const body = [];
      while (i < n) {
        const [l2, ni2] = lineAt(i);
        if (l2.charCodeAt(0) !== 62) break;
        body.push(l2.replace(/^> ?/, ''));
        i = ni2;
      }
      const lines = body.map(trimLine).filter((l) => l !== '');
      blocks.push(lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(lines.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    // List.
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bullet = BULLET.exec(line);
      const ordered = bullet === null ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED : BULLET;
        const items = [];
        while (i < n) {
          const [l2, ni2] = lineAt(i);
          const mm = marker.exec(l2);
          if (mm !== null) {
            items.push([trimLine(isOrdered ? mm[2] : mm[1])]);
            i = ni2;
          } else if (/^ {2,}\S/.test(l2)) {
            items[items.length - 1].push(trimLine(l2));
            i = ni2;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
        let html = `${open}\n`;
        for (const item of items) html += `<li>${inline(item.join('\n'), env)}</li>\n`;
        blocks.push(`${html}</${tag}>`);
        continue;
      }
    }
    // Paragraph: this line and the lines after it up to a blank line, a fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i = ni;
    while (i < n) {
      const [l2, ni2] = lineAt(i);
      if (endsParagraph(l2)) break;
      body.push(trimLine(l2));
      i = ni2;
    }
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template runtime helpers (same semantics as the reference renderer) ---

/** The own property `seg` of object `v`, or undefined. */
function get(v, seg) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, seg) ? v[seg] : undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// --- template compiler: an AST becomes one straight-line render function ---

/** A JS expression for `path` under the current loop bindings (innermost last: {name, expr}). */
function pathExpr(path, bindings) {
  let base;
  for (let i = bindings.length - 1; i >= 0; i--) {
    if (bindings[i].name === path[0]) {
      base = bindings[i].expr;
      break;
    }
  }
  // Otherwise the first name reads off the one scope object: every consumer treats a missing
  // name exactly like one holding undefined, so a plain property read is the reference's lookup.
  if (base === undefined) base = `__sc[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) base = `get(${base}, ${JSON.stringify(path[k])})`;
  return base;
}

function genNodes(nodes, bindings, id, constant) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      code += `__o += ${JSON.stringify(n.text)};\n`;
    } else if (n.kind === 'var') {
      code += `__o += esc(text(${pathExpr(n.path, bindings)}));\n`;
    } else if (n.kind === 'raw') {
      code += `__o += text(${pathExpr(n.path, bindings)});\n`;
    } else if (n.kind === 'if') {
      code += `if (truthy(${pathExpr(n.path, bindings)}) !== ${n.not}) {\n`;
      code += genNodes(n.then, bindings, id, constant);
      code += '}';
      if (n.else !== null) {
        code += ` else {\n`;
        code += genNodes(n.else, bindings, id, constant);
        code += '}';
      }
      code += '\n';
    } else if (n.kind === 'for') {
      const u = id.next++;
      const nm = JSON.stringify(n.name);
      code += `{\nconst __xs${u} = ${pathExpr(n.path, bindings)};\n`;
      code += `if (Array.isArray(__xs${u})) {\n`;
      code += `const __sv${u} = __sc[${nm}];\nconst __svl${u} = __sc.loop;\n`;
      code += `const __lp${u} = { index: 0, first: false, last: false, length: __xs${u}.length };\n__sc.loop = __lp${u};\n`;
      code += `for (let __k${u} = 0; __k${u} < __xs${u}.length; __k${u}++) {\n`;
      // When the loop variable is itself named "loop", the loop object wins, as in the reference's frame literal.
      if (n.name !== 'loop') code += `__sc[${nm}] = __xs${u}[__k${u}];\n`;
      code += `__lp${u}.index = __k${u} + 1; __lp${u}.first = __k${u} === 0; __lp${u}.last = __k${u} === __xs${u}.length - 1;\n`;
      code += genNodes(n.body, [...bindings, { name: n.name, expr: `__sc[${nm}]` }, { name: 'loop', expr: `__lp${u}` }], id, constant);
      code += `}\n__sc[${nm}] = __sv${u};\n__sc.loop = __svl${u};\n}\n}\n`;
    } else if (n.kind === 'include') {
      if (constant.has(n.name)) {
        code += `__o += memo(${JSON.stringify(n.name)}, __sc, D);\n`;
      } else {
        code += `{ const __t = tpl.get(${JSON.stringify(n.name)}); if (__t !== undefined && D < ${INCLUDE_DEPTH}) __o += __t(__sc, D + 1, H); }\n`;
      }
    }
  }
  return code;
}

/** The names a template reads that no for loop of its own binds, following its includes. A name read only inside a for body, where the loop variable or `loop` binds it, is not free. The bound set starts empty, so this is a safe over-approximation: a template it calls constant really is. */
const CONSTANT_NAMES = new Set(['site', 'tags', 'recent']);
function templateFreeNames(name, parsed, visiting) {
  const nodes = parsed.get(name);
  if (nodes === undefined || visiting.has(name)) return new Set();
  visiting.add(name);
  const out = new Set();
  const walk = (ns, bound) => {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        if (n.kind === 'if') {
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        }
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        const inner = new Set(bound);
        inner.add(n.name);
        inner.add('loop');
        walk(n.body, inner);
      } else if (n.kind === 'include') {
        for (const x of templateFreeNames(n.name, parsed, visiting)) out.add(x);
      }
    }
  };
  walk(nodes, new Set());
  visiting.delete(name);
  return out;
}

/** A template's AST compiled into `fn(__sc, D, H)`: __sc the one scope object (a missing name reads as undefined, exactly like the reference's lookup), D the include depth. `constant` names the templates rendered once per build (see build). */
function compileTemplate(nodes, constant) {
  const id = { next: 0 };
  const body = `const {get: get, text: text, truthy: truthy, esc: esc, tpl: tpl, memo: memo} = H;\nlet __o = '';\n${genNodes(nodes, [], id, constant)}return __o;\n`;
  return new Function('__sc', 'D', 'H', body);
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s, card) {
  // For a post the card already holds the shared fields; for a page they are computed here.
  const c = card ?? {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
function build(input) {
  // Templates, parsed and compiled once; one that does not parse is reported and left out.
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // A template that reads only the site, its tags and its recent posts gives the same output on every page,
  // so it is rendered once per build and the string reused. The names it reads are followed through its includes.
  const constant = new Set();
  for (const name of parsed.keys()) {
    const free = templateFreeNames(name, parsed, new Set());
    if ([...free].every((n) => CONSTANT_NAMES.has(n))) constant.add(name);
  }
  const compiled = new Map();
  for (const [name, nodes] of parsed) compiled.set(name, compileTemplate(nodes, constant));
  // The memo for those templates: the cached string is valid only while the scope still holds this build's
  // site, tags and recent posts, and only for the include depth it was rendered at.
  const memoCache = new Map();
  const memo = (name, sc, D) => {
    if (D >= INCLUDE_DEPTH) return '';
    const fn = compiled.get(name);
    if (fn === undefined) return '';
    if (sc.site === site && sc.tags === allTags && sc.recent === recent) {
      const key = `${name}\0${D}`;
      const hit = memoCache.get(key);
      if (hit !== undefined) return hit;
      const out = fn(sc, D + 1, H);
      memoCache.set(key, out);
      return out;
    }
    return fn(sc, D + 1, H);
  };
  const H = { get, text: textOf, truthy, esc: escapeHtml, tpl: compiled, memo };
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!compiled.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources.length = 0;
  sources.push(...kept);

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const rootVars = { site, tags: allTags, recent };
  // One scope object for the whole build: the page's own values are set fresh on every render
  // (a name left over from an earlier render reads as undefined, which the templates treat like a missing one).
  const scope = rootVars;
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    scope.page = vars.page;
    scope.posts = vars.posts;
    scope.pager = vars.pager;
    scope.tag = vars.tag;
    return fn(scope, 0, H);
  };
  const output = {};
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, s.post ? cards.get(s) : undefined) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, faster. */
export function run(input) {
  return build(input);
}
