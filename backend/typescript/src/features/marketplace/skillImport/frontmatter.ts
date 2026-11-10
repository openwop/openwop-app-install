/**
 * ADR 1044 D7 — a strict, closed-world reader for SKILL.md frontmatter.
 *
 * Not the vendored bridge's parser: that one reads two levels of nesting, cannot
 * read OpenClaw's one-line JSON `metadata`, and turns what it cannot read into
 * silence. This one reads the YAML subset skill files use (block maps and
 * sequences, flow sequences, quoted and plain scalars, `|` / `>` block scalars,
 * JSON flow values) and REFUSES everything else — tabs, anchors, aliases, tags,
 * duplicate keys, unparseable flow values. A refusal names the line.
 */

import { refuse } from './refusal.js';

export type FmValue = string | boolean | null | FmValue[] | { [k: string]: FmValue };
export type FmMap = { [k: string]: FmValue };

interface Line { no: number; indent: number; text: string }

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*)|\s*)$/;
const MAX_DEPTH = 8;

function invalid(message: string, line?: number): never {
  throw refuse('frontmatter_invalid', line !== undefined ? `Frontmatter line ${line}: ${message}` : message, line !== undefined ? { line } : {});
}

/** Split a SKILL.md into its frontmatter block and its body. A file with no
 *  frontmatter is refused: `name` and `description` are required. */
export function splitSkillMd(text: string): { yaml: string; yamlStartLine: number; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) {
    // An empty frontmatter block (`---\n---`) is also a missing one.
    if (/^---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/.test(text)) invalid('the frontmatter block is empty; `name` and `description` are required.');
    invalid('SKILL.md must start with a YAML frontmatter block between two `---` lines.');
  }
  return { yaml: m[1]!, yamlStartLine: 2, body: m[2] ?? '' };
}

function toLines(yaml: string, firstLine: number): Line[] {
  const out: Line[] = [];
  yaml.split(/\r?\n/).forEach((raw, i) => {
    const no = firstLine + i;
    const lead = /^[ \t]*/.exec(raw)![0];
    if (lead.includes('\t')) invalid('tabs are not allowed in indentation.', no);
    const text = raw.slice(lead.length);
    out.push({ no, indent: lead.length, text });
  });
  return out;
}

const isSkippable = (l: Line): boolean => l.text.length === 0 || l.text.startsWith('#');

/** Strip a trailing ` # comment` from a plain scalar (YAML needs the space). */
function stripComment(s: string): string {
  const i = s.search(/\s#/);
  return (i === -1 ? s : s.slice(0, i)).trimEnd();
}

function parseQuoted(s: string, no: number): string {
  if (s.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(s);
      if (typeof v === 'string') return v;
    } catch { /* fall through */ }
    invalid('a double-quoted string is not closed or has an invalid escape.', no);
  }
  // single-quoted: '' is the only escape
  if (!/^'(?:[^']|'')*'$/.test(s)) invalid('a single-quoted string is not closed.', no);
  return s.slice(1, -1).replace(/''/g, "'");
}

function jsonToFm(v: unknown, no: number, depth: number): FmValue {
  if (depth > MAX_DEPTH) invalid('the value nests too deeply.', no);
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map((x) => jsonToFm(x, no, depth + 1));
  if (typeof v === 'object') {
    const out: FmMap = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = jsonToFm(x, no, depth + 1);
    return out;
  }
  return invalid('unsupported JSON value.', no);
}

/** A flow value on one line: JSON first; else a simple `[a, b, "c"]` sequence. */
function parseFlow(s: string, no: number, depth: number): FmValue {
  try {
    return jsonToFm(JSON.parse(s), no, depth);
  } catch { /* not JSON */ }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner.length === 0) return [];
    const items: string[] = [];
    let cur = '';
    let quote: string | null = null;
    for (const ch of inner) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === '[' || ch === '{') invalid('nested flow collections must be valid JSON.', no);
      if (ch === ',') { items.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (quote) invalid('a quoted string in a flow sequence is not closed.', no);
    items.push(cur.trim());
    return items.map((it) => {
      if (it.length === 0) invalid('a flow sequence has an empty item.', no);
      return parseScalar(it, no);
    });
  }
  return invalid('a `{…}` flow mapping must be valid JSON.', no);
}

function parseScalar(raw: string, no: number): FmValue {
  const s = raw.trim();
  if (s.startsWith('"') || s.startsWith("'")) return parseQuoted(s, no);
  if (/^[&*!]/.test(s)) invalid('anchors, aliases and tags are not supported.', no);
  if (/^[|>]/.test(s)) invalid('a block scalar indicator must stand alone after the key.', no);
  const plain = stripComment(s);
  if (plain === 'true') return true;
  if (plain === 'false') return false;
  if (plain === 'null' || plain === '~' || plain === '') return null;
  return plain;
}

function parseBlockScalar(indicator: string, lines: Line[], start: number, parentIndent: number): { value: string; next: number } {
  if (!/^[|>][+-]?$/.test(indicator)) invalid('unsupported block scalar indicator.', lines[start - 1]?.no);
  const folded = indicator.startsWith('>');
  const keep = indicator.endsWith('+');
  const strip = indicator.endsWith('-');
  let i = start;
  const body: Line[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.text.length > 0 && l.indent <= parentIndent) break;
    body.push(l);
    i += 1;
  }
  const nonEmpty = body.filter((l) => l.text.length > 0);
  const base = nonEmpty.length > 0 ? Math.min(...nonEmpty.map((l) => l.indent)) : 0;
  const rows = body.map((l) => (l.text.length === 0 ? '' : ' '.repeat(l.indent - base) + l.text));
  let value: string;
  if (folded) {
    value = '';
    rows.forEach((r, idx) => {
      if (idx === 0) { value = r; return; }
      const prev = rows[idx - 1]!;
      value += r === '' || prev === '' || r.startsWith(' ') ? `\n${r}` : ` ${r}`;
    });
  } else {
    value = rows.join('\n');
  }
  if (strip) value = value.replace(/\n+$/, '');
  else if (!keep) value = value.replace(/\n+$/, '') + (value.length > 0 ? '\n' : '');
  return { value, next: i };
}

function parseNode(lines: Line[], start: number, indent: number, depth: number): { value: FmValue; next: number } {
  if (depth > MAX_DEPTH) invalid('the frontmatter nests too deeply.', lines[start]?.no);
  let i = start;
  while (i < lines.length && isSkippable(lines[i]!)) i += 1;
  if (i >= lines.length) return { value: null, next: i };
  const first = lines[i]!;
  if (first.indent !== indent) invalid('unexpected indentation.', first.no);
  if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(lines, i, indent, depth);
  return parseMap(lines, i, indent, depth);
}

function parseSeq(lines: Line[], start: number, indent: number, depth: number): { value: FmValue[]; next: number } {
  const out: FmValue[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isSkippable(l)) { i += 1; continue; }
    if (l.indent < indent) break;
    if (l.indent > indent) invalid('unexpected indentation in a list.', l.no);
    if (!(l.text === '-' || l.text.startsWith('- '))) break;
    const item = l.text.slice(1).trim();
    if (item.length === 0 || KEY_RE.test(item)) invalid('list items must be scalars or JSON values.', l.no);
    out.push(item.startsWith('[') || item.startsWith('{') ? parseFlow(item, l.no, depth + 1) : parseScalar(item, l.no));
    i += 1;
  }
  return { value: out, next: i };
}

function parseMap(lines: Line[], start: number, indent: number, depth: number): { value: FmMap; next: number } {
  const out: FmMap = {};
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isSkippable(l)) { i += 1; continue; }
    if (l.indent < indent) break;
    if (l.indent > indent) invalid('unexpected indentation.', l.no);
    const m = KEY_RE.exec(l.text);
    if (!m) invalid('expected `key: value`.', l.no);
    const key = m[1]!;
    if (Object.prototype.hasOwnProperty.call(out, key)) invalid(`duplicate key \`${key}\`.`, l.no);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid(`key \`${key}\` is not allowed.`, l.no);
    const rest = (m[2] ?? '').trim();
    i += 1;
    if (rest.length === 0 || rest.startsWith('#')) {
      // Nested block, or null when nothing deeper follows.
      let j = i;
      while (j < lines.length && isSkippable(lines[j]!)) j += 1;
      const nxt = lines[j];
      if (nxt && nxt.indent > indent) {
        const r = parseNode(lines, j, nxt.indent, depth + 1);
        out[key] = r.value; i = r.next;
      } else if (nxt && nxt.indent === indent && (nxt.text === '-' || nxt.text.startsWith('- '))) {
        // YAML allows a block sequence at the parent's indentation.
        const r = parseSeq(lines, j, indent, depth + 1);
        out[key] = r.value; i = r.next;
      } else {
        out[key] = null;
      }
      continue;
    }
    if (/^[|>]/.test(rest)) {
      const r = parseBlockScalar(stripComment(rest), lines, i, indent);
      out[key] = r.value; i = r.next;
      continue;
    }
    if (rest.startsWith('[') || rest.startsWith('{')) {
      out[key] = parseFlow(rest, l.no, depth + 1);
      continue;
    }
    let value = parseScalar(rest, l.no);
    // A plain scalar may continue on deeper-indented lines (folded with spaces).
    if (typeof value === 'string' && !rest.startsWith('"') && !rest.startsWith("'")) {
      while (i < lines.length && lines[i]!.text.length > 0 && lines[i]!.indent > indent && !lines[i]!.text.startsWith('#')) {
        value = `${value} ${stripComment(lines[i]!.text)}`;
        i += 1;
      }
    }
    out[key] = value;
  }
  return { value: out, next: i };
}

/** Parse the frontmatter YAML into a plain map. Refuses anything outside the subset. */
export function parseFrontmatter(yaml: string, firstLine = 2): FmMap {
  const lines = toLines(yaml, firstLine);
  const r = parseNode(lines, 0, 0, 0);
  for (let i = r.next; i < lines.length; i += 1) {
    if (!isSkippable(lines[i]!)) invalid('unexpected content.', lines[i]!.no);
  }
  if (r.value === null) invalid('the frontmatter block is empty; `name` and `description` are required.');
  if (typeof r.value !== 'object' || Array.isArray(r.value)) invalid('the frontmatter must be a mapping of keys to values.');
  return r.value;
}
