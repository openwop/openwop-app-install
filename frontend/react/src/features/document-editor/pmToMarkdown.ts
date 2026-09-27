/**
 * ProseMirror-JSON → Markdown serializer (ADR 0334 Phase 4). Covers the Phase-1/2
 * schema (headings, paragraphs, bullet/ordered lists, blockquote, code block,
 * horizontal rule, hard break; bold/italic/strike/code/link marks). Export is
 * deliberately lossy + schema-bounded (the research §2 rule): underline has no
 * Markdown form and degrades to plain text. docx/PDF export is Phase 4b.
 */
import type { JSONContent } from '@tiptap/core';

interface Mark { type?: string; attrs?: Record<string, unknown> }

/** Escape Markdown-significant characters in PROSE text (never applied inside
 *  code spans/blocks) so literal `*`/`_`/`[`/backticks in the document don't
 *  re-parse as formatting on export (review of #1601, F1). */
function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]~])/g, '\\$1');
}

/** Serialize a text node's marks around its text (code innermost, link outermost). */
function serializeText(node: JSONContent): string {
  const marks = (node.marks ?? []) as Mark[];
  const has = (t: string) => marks.some((m) => m.type === t);
  const link = marks.find((m) => m.type === 'link');
  // A code span keeps its text VERBATIM (no escaping); pad with a space when
  // the content itself starts/ends with a backtick (the CommonMark rule).
  let text: string;
  if (has('code')) {
    const raw = node.text ?? '';
    const fence = '`'.repeat(Math.max(1, (raw.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0) + 1));
    const pad = raw.startsWith('`') || raw.endsWith('`') ? ' ' : '';
    text = `${fence}${pad}${raw}${pad}${fence}`;
  } else {
    text = escapeMd(node.text ?? '');
    if (has('bold')) text = `**${text}**`;
    if (has('italic')) text = `*${text}*`;
    // A pending deletion suggestion (6b-2) exports struck; a pending insertion
    // exports as plain text (the marks themselves aren't Markdown).
    if (has('strike') || has('deletion')) text = `~~${text}~~`;
  }
  // The link wraps LAST so a code+link run exports as [`code`](href) — the
  // old early-return dropped the link on code spans (review of #1601, F1).
  if (link) {
    const href = typeof link.attrs?.href === 'string' ? link.attrs.href : '';
    text = `[${text}](${href.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))})`;
  }
  return text;
}

/** Escape a leading BLOCK marker in paragraph prose so it doesn't re-parse as a
 *  heading / list / blockquote / thematic break on re-import (grade pass — the
 *  inline escaper handled `*_[]~` mid-line but a paragraph starting `1. `, `# `,
 *  `- `, `> `, `+ ` still round-tripped into a list/heading). CommonMark: a
 *  backslash before the marker char defeats the block rule. Only the FIRST
 *  significant token matters. */
function escapeBlockLead(line: string): string {
  // `#`/`>`/`-`/`+`/`*` at line start (optionally after ≤3 spaces): escape the char.
  const hb = line.match(/^(\s{0,3})([#>\-+*])(\s|$)/);
  if (hb) return `${hb[1]}\\${hb[2]}${line.slice((hb[1]?.length ?? 0) + 1)}`;
  // Ordered-list lead `<digits>.` or `<digits>)`: escape the delimiter.
  const ol = line.match(/^(\s{0,3})(\d{1,9})([.)])(\s|$)/);
  if (ol) return `${ol[1]}${ol[2]}\\${ol[3]}${line.slice((ol[1]?.length ?? 0) + (ol[2]?.length ?? 0) + 1)}`;
  return line;
}

/** Concatenate a block node's inline children. */
function serializeInline(node: JSONContent): string {
  return (node.content ?? []).map((child) => {
    if (child.type === 'text') return serializeText(child);
    if (child.type === 'hardBreak') return '  \n';
    return serializeInline(child);
  }).join('');
}

function serializeList(node: JSONContent, ordered: boolean, depth: number): string {
  const indent = '  '.repeat(depth);
  return (node.content ?? []).map((item, i) => {
    const marker = ordered ? `${i + 1}. ` : '- ';
    const parts: string[] = [];
    (item.content ?? []).forEach((child) => {
      if (child.type === 'bulletList') parts.push(serializeList(child, false, depth + 1));
      else if (child.type === 'orderedList') parts.push(serializeList(child, true, depth + 1));
      else parts.push(`${indent}${marker}${serializeInline(child)}`);
    });
    // The first paragraph shares the marker line; nested lists follow on new lines.
    if (parts.length && !parts[0]!.startsWith(indent + marker)) parts[0] = `${indent}${marker}${serializeInline(item.content?.[0] ?? {})}`;
    return parts.join('\n');
  }).join('\n');
}

function serializeBlock(node: JSONContent): string {
  switch (node.type) {
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      return `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${serializeInline(node)}`;
    }
    case 'paragraph':
      return escapeBlockLead(serializeInline(node));
    case 'bulletList':
      return serializeList(node, false, 0);
    case 'orderedList':
      return serializeList(node, true, 0);
    case 'blockquote':
      return (node.content ?? []).map(serializeBlock).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n');
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      // Verbatim text (never escaped) + a fence LONGER than any backtick run
      // inside it, so embedded ``` can't break out (review of #1601, F1).
      const raw = (node.content ?? []).map((c) => c.text ?? '').join('');
      const fence = '`'.repeat(Math.max(3, (raw.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0) + 1));
      return `${fence}${lang}\n${raw}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    case 'mathBlock': {
      // Concatenated, not a template literal, so the i18n money-format lint does
      // not read the LaTeX double-dollar delimiter as currency interpolation.
      const latex = typeof node.attrs?.latex === 'string' ? node.attrs.latex : '';
      return '$$' + latex + '$$';
    }
    case 'image': {
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
      return `![${alt}](${src})`;
    }
    case 'chartBlock': {
      // Emit the spec in a fenced block so the data survives the round-trip and
      // renders as an inert code block wherever raw charts aren't supported.
      const spec = typeof node.attrs?.spec === 'string' ? node.attrs.spec : '';
      return '```chart\n' + spec + '\n```';
    }
    case 'embedBlock': {
      // Fence the raw HTML rather than emitting it inline — it stays inert (never
      // executes) when the Markdown is rendered elsewhere.
      const html = typeof node.attrs?.html === 'string' ? node.attrs.html : '';
      return '```html\n' + html + '\n```';
    }
    case 'table': {
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => serializeInline(cell.content?.[0] ?? {}).replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const header = rows[0]!;
      const sep = header.map(() => '---');
      return [header, sep, ...rows.slice(1)].map((cols) => `| ${cols.join(' | ')} |`).join('\n');
    }
    default:
      return serializeInline(node);
  }
}

/** Serialize a full `{ type: 'doc' }` node to Markdown. */
export function pmToMarkdown(doc: JSONContent): string {
  const blocks = doc.content ?? [];
  return blocks.map(serializeBlock).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
