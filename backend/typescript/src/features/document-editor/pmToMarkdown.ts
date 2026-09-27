/**
 * ProseMirror-JSON → Markdown serializer (ADR 0334 4b, backend twin of the FE
 * `frontend/react/src/features/document-editor/pmToMarkdown.ts`). Used server-side
 * for authoritative export (of-record, no client-content trust): the export route
 * serializes the SAVED canvas then feeds `renderMarkdownToPdf` (ADR 0057). Kept
 * TipTap-free (a local node shape, not `@tiptap/core`'s `JSONContent`) so the
 * backend needs no editor dependency. Both twins are unit-tested; keep them in
 * step (same node/mark coverage). Lossy + schema-bounded by design.
 */

export interface PMNode {
  type?: string;
  content?: PMNode[];
  text?: string;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

function serializeText(node: PMNode): string {
  let text = node.text ?? '';
  const marks = node.marks ?? [];
  const has = (t: string) => marks.some((m) => m.type === t);
  if (has('code')) return `\`${text}\``;
  if (has('bold')) text = `**${text}**`;
  if (has('italic')) text = `*${text}*`;
  if (has('strike') || has('deletion')) text = `~~${text}~~`; // 6b-2: pending deletion exports struck
  const link = marks.find((m) => m.type === 'link');
  if (link) {
    const href = typeof link.attrs?.href === 'string' ? link.attrs.href : '';
    text = `[${text}](${href})`;
  }
  return text;
}

function serializeInline(node: PMNode): string {
  return (node.content ?? []).map((child) => {
    if (child.type === 'text') return serializeText(child);
    if (child.type === 'hardBreak') return '  \n';
    return serializeInline(child);
  }).join('');
}

function serializeList(node: PMNode, ordered: boolean, depth: number): string {
  const indent = '  '.repeat(depth);
  return (node.content ?? []).map((item, i) => {
    const marker = ordered ? `${i + 1}. ` : '- ';
    const parts: string[] = [];
    (item.content ?? []).forEach((child) => {
      if (child.type === 'bulletList') parts.push(serializeList(child, false, depth + 1));
      else if (child.type === 'orderedList') parts.push(serializeList(child, true, depth + 1));
      else parts.push(`${indent}${marker}${serializeInline(child)}`);
    });
    if (parts.length && !parts[0]!.startsWith(indent + marker)) parts[0] = `${indent}${marker}${serializeInline(item.content?.[0] ?? {})}`;
    return parts.join('\n');
  }).join('\n');
}

function serializeBlock(node: PMNode): string {
  switch (node.type) {
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      return `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${serializeInline(node)}`;
    }
    case 'paragraph': return serializeInline(node);
    case 'bulletList': return serializeList(node, false, 0);
    case 'orderedList': return serializeList(node, true, 0);
    case 'blockquote': return (node.content ?? []).map(serializeBlock).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n');
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      return `\`\`\`${lang}\n${serializeInline(node)}\n\`\`\``;
    }
    case 'horizontalRule': return '---';
    case 'mathBlock': { const latex = typeof node.attrs?.latex === 'string' ? node.attrs.latex : ''; return '$$' + latex + '$$'; }
    case 'chartBlock': { const spec = typeof node.attrs?.spec === 'string' ? node.attrs.spec : ''; return '```chart\n' + spec + '\n```'; }
    case 'embedBlock': { const html = typeof node.attrs?.html === 'string' ? node.attrs.html : ''; return '```html\n' + html + '\n```'; }
    case 'image': {
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
      return `![${alt}](${src})`;
    }
    case 'table': {
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => serializeInline(cell.content?.[0] ?? {}).replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const header = rows[0]!;
      const sep = header.map(() => '---');
      return [header, sep, ...rows.slice(1)].map((cols) => `| ${cols.join(' | ')} |`).join('\n');
    }
    default: return serializeInline(node);
  }
}

/** Serialize a `{ type: 'doc' }` node (or any object with a `content` array). */
export function pmToMarkdown(doc: PMNode): string {
  const blocks = doc.content ?? [];
  return blocks.map(serializeBlock).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
