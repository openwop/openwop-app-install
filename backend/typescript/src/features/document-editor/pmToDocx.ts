/**
 * ProseMirror-JSON → .docx serializer (ADR 0334 Phase 4b-2). Server-authoritative
 * export: the export route serializes the SAVED canvas via this mapper (docx.js —
 * generation-first, no round-trip promise; the research §2 rule). Covers
 * headings, paragraphs, bold/italic/strike/code/link marks, bullet/ordered lists,
 * blockquote, code block, and tables. Images are skipped in v1 (the src is a
 * media-token URL; embedding bytes → a Media fetch, deferred). Lossy + bounded.
 */
import { Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import type { PMNode } from './pmToMarkdown.js';

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

interface Mark { type?: string; attrs?: Record<string, unknown> }

/** A text node → a docx run (wrapped in a hyperlink when it carries a link mark). */
function textRun(node: PMNode): TextRun | ExternalHyperlink {
  const marks = (node.marks ?? []) as Mark[];
  const has = (t: string) => marks.some((m) => m.type === t);
  const run = new TextRun({
    text: node.text ?? '',
    bold: has('bold') || undefined,
    italics: has('italic') || undefined,
    strike: has('strike') || undefined,
    ...(has('code') ? { font: 'Courier New' } : {}),
  });
  const link = marks.find((m) => m.type === 'link');
  if (link && typeof link.attrs?.href === 'string') {
    return new ExternalHyperlink({ children: [run], link: link.attrs.href });
  }
  return run;
}

function inlineRuns(node: PMNode): (TextRun | ExternalHyperlink)[] {
  return (node.content ?? []).flatMap((child) => {
    if (child.type === 'text') return [textRun(child)];
    if (child.type === 'hardBreak') return [new TextRun({ break: 1 })];
    return inlineRuns(child);
  });
}

function listParagraphs(node: PMNode, ordered: boolean, level: number): Paragraph[] {
  const out: Paragraph[] = [];
  (node.content ?? []).forEach((item, i) => {
    (item.content ?? []).forEach((child) => {
      if (child.type === 'bulletList') out.push(...listParagraphs(child, false, level + 1));
      else if (child.type === 'orderedList') out.push(...listParagraphs(child, true, level + 1));
      else {
        // Ordered lists get a manual "N." prefix (docx numbering config is v2);
        // bullets use the native bullet.
        const children = inlineRuns(child);
        out.push(new Paragraph(ordered
          ? { children: [new TextRun({ text: `${i + 1}. ` }), ...children], indent: { left: 360 * (level + 1) } }
          : { children, bullet: { level } }));
      }
    });
  });
  return out;
}

function blockToDocx(node: PMNode): (Paragraph | Table)[] {
  switch (node.type) {
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? Math.min(6, Math.max(1, node.attrs.level)) : 1;
      return [new Paragraph({ heading: HEADINGS[level - 1], children: inlineRuns(node) })];
    }
    case 'paragraph': return [new Paragraph({ children: inlineRuns(node) })];
    case 'bulletList': return listParagraphs(node, false, 0);
    case 'orderedList': return listParagraphs(node, true, 0);
    case 'blockquote': return (node.content ?? []).map((child) => new Paragraph({ children: inlineRuns(child), indent: { left: 480 } }));
    case 'codeBlock': return [new Paragraph({ children: [new TextRun({ text: (node.content ?? []).map((c) => c.text ?? '').join(''), font: 'Courier New' })] })];
    case 'horizontalRule': return [new Paragraph({ children: [new TextRun({ text: '———' })] })];
    // Charts + sandboxed embeds are interactive; .docx gets an italic placeholder
    // (the live block survives in the of-record PM-JSON and the Markdown export).
    case 'chartBlock': return [new Paragraph({ children: [new TextRun({ text: '[Chart]', italics: true })] })];
    case 'embedBlock': return [new Paragraph({ children: [new TextRun({ text: '[Embedded content]', italics: true })] })];
    case 'table': {
      const rows = (node.content ?? []).map((row) => new TableRow({
        children: (row.content ?? []).map((cell) => new TableCell({ children: (cell.content ?? []).flatMap(blockToDocx).filter((b): b is Paragraph => b instanceof Paragraph) })),
      }));
      return rows.length ? [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })] : [];
    }
    default: {
      const runs = inlineRuns(node);
      return runs.length ? [new Paragraph({ children: runs })] : [];
    }
  }
}

/** Serialize a `{ type: 'doc' }` node to a .docx Buffer. */
export async function pmToDocx(doc: PMNode, opts: { title?: string } = {}): Promise<Buffer> {
  const children = (doc.content ?? []).flatMap(blockToDocx);
  const document = new Document({
    title: opts.title,
    sections: [{ children: children.length ? children : [new Paragraph({ children: [] })] }],
  });
  return Packer.toBuffer(document);
}
