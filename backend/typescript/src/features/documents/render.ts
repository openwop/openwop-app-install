/**
 * Markdown → PDF renderer (ADR 0057). Pure-JS: `markdown-it` parses to a token
 * stream, `pdfkit` lays it out — NO headless Chromium (light image, deterministic).
 * Good-not-pixel-perfect by design: block-level styling (headings, paragraphs,
 * lists, code, blockquotes, rules, table fallback); inline markup is flattened to
 * clean text. One shared module so the sync route and the workflow node render
 * identically.
 */

import MarkdownIt from 'markdown-it';
import PDFDocument from 'pdfkit';
import pptxgen from 'pptxgenjs';
import type Token from 'markdown-it/lib/token.mjs';

/** Flatten an inline token to plain text (drops markup, keeps text + inline code). */
function inlineText(tok: Token | undefined): string {
  if (!tok) return '';
  if (!tok.children || tok.children.length === 0) return tok.content;
  return tok.children
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content)
    .join('');
}

/** Render Markdown to PDF bytes. Deterministic; no network, no provider. */
export async function renderMarkdownToPdf(markdown: string, opts: { title?: string } = {}): Promise<Buffer> {
  const md = new MarkdownIt(); // tables enabled by default
  const tokens = md.parse(markdown ?? '', {});

  const doc = new PDFDocument({ margin: 54, size: 'LETTER', info: { Title: opts.title ?? 'Document' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  if (opts.title) {
    doc.font('Helvetica-Bold').fontSize(20).text(opts.title);
    doc.moveDown(0.6);
  }

  const listStack: Array<{ ordered: boolean; idx: number }> = [];
  let inBlockquote = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const level = Number(t.tag.slice(1)) || 3;
        const size = level === 1 ? 18 : level === 2 ? 15 : 13;
        doc.moveDown(0.4).font('Helvetica-Bold').fontSize(size).text(inlineText(tokens[i + 1]));
        doc.moveDown(0.2);
        i += 2; // skip inline + heading_close
        break;
      }
      case 'paragraph_open': {
        const text = inlineText(tokens[i + 1]);
        if (inBlockquote) {
          doc.font('Helvetica-Oblique').fontSize(11).text(text, { indent: 18, paragraphGap: 4 });
        } else if (listStack.length === 0) {
          doc.font('Helvetica').fontSize(11).text(text, { paragraphGap: 4 });
        } else {
          // list-item paragraph is emitted by list_item_open; skip the duplicate.
        }
        i += 2;
        break;
      }
      case 'bullet_list_open': listStack.push({ ordered: false, idx: 0 }); break;
      case 'ordered_list_open': listStack.push({ ordered: true, idx: 0 }); break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        listStack.pop();
        doc.moveDown(0.2);
        break;
      case 'list_item_open': {
        const top = listStack[listStack.length - 1];
        if (top) top.idx += 1;
        const marker = top?.ordered ? `${top.idx}. ` : '• ';
        // list_item_open, paragraph_open, inline → the item's text
        const inline = tokens[i + 2];
        const text = inline && inline.type === 'inline' ? inlineText(inline) : '';
        doc.font('Helvetica').fontSize(11).text(marker + text, { indent: 18 * listStack.length });
        while (i < tokens.length && tokens[i].type !== 'list_item_close') i++;
        break;
      }
      case 'blockquote_open': inBlockquote = true; doc.moveDown(0.2); break;
      case 'blockquote_close': inBlockquote = false; doc.moveDown(0.2); break;
      case 'fence':
      case 'code_block':
        doc.font('Courier').fontSize(9).text(t.content.replace(/\n$/, ''), { indent: 8 });
        doc.font('Helvetica').fontSize(11).moveDown(0.3);
        break;
      case 'hr': {
        doc.moveDown(0.3);
        const y = doc.y;
        doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor('#cccccc').stroke();
        doc.moveDown(0.3);
        break;
      }
      case 'table_open': {
        const rows: string[] = [];
        i++;
        while (i < tokens.length && tokens[i].type !== 'table_close') {
          if (tokens[i].type === 'tr_open') {
            const cells: string[] = [];
            i++;
            while (i < tokens.length && tokens[i].type !== 'tr_close') {
              if (tokens[i].type === 'inline') cells.push(inlineText(tokens[i]));
              i++;
            }
            rows.push(cells.join('   |   '));
          }
          i++;
        }
        doc.font('Courier').fontSize(9);
        for (const r of rows) doc.text(r);
        doc.font('Helvetica').fontSize(11).moveDown(0.3);
        break;
      }
      default:
        break;
    }
  }

  doc.end();
  return done;
}

/** Collect every markdown table as rows-of-cells (in document order). */
function extractTables(tokens: readonly Token[]): string[][][] {
  const tables: string[][][] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'table_open') continue;
    const rows: string[][] = [];
    i++;
    while (i < tokens.length && tokens[i].type !== 'table_close') {
      if (tokens[i].type === 'tr_open') {
        const cells: string[] = [];
        i++;
        while (i < tokens.length && tokens[i].type !== 'tr_close') {
          if (tokens[i].type === 'inline') cells.push(inlineText(tokens[i]));
          i++;
        }
        rows.push(cells);
      }
      i++;
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Render Markdown to CSV (the `sheet` format). Emits every markdown table (blank
 * line between multiple); when the doc has no table, falls back to a one-column
 * sheet of its non-empty lines. CSV opens directly in Excel/Sheets — zero deps;
 * xlsx is a future upgrade (ADR 0057 open question).
 */
export function renderMarkdownToCsv(markdown: string): Buffer {
  const md = new MarkdownIt();
  const tables = extractTables(md.parse(markdown ?? '', {}));
  let rows: string[][];
  if (tables.length > 0) {
    rows = [];
    tables.forEach((t, idx) => {
      if (idx > 0) rows.push([]); // blank separator row
      rows.push(...t);
    });
  } else {
    rows = (markdown ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0).map((l) => [l]);
  }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  return Buffer.from(csv, 'utf8');
}

/**
 * Render Markdown to a PPTX deck (the `slides` format). Each top-level heading
 * (h1/h2) starts a new slide; paragraphs and list items under it become bullets.
 * A heading-less doc becomes a single titled slide. Pure-JS (pptxgenjs); rough by
 * design — a quick deck skeleton, not a designed presentation.
 */
export async function renderMarkdownToPptx(markdown: string, opts: { title?: string } = {}): Promise<Buffer> {
  const md = new MarkdownIt();
  const tokens = md.parse(markdown ?? '', {});
  const pptx = new pptxgen();
  interface Slide { title: string; bullets: string[] }
  const deck: Slide[] = [];
  let cur: Slide | null = null;
  const open = (title: string): Slide => { const s: Slide = { title, bullets: [] }; deck.push(s); cur = s; return s; };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      const level = Number(t.tag.slice(1)) || 3;
      const heading = inlineText(tokens[i + 1]);
      if (level <= 2) open(heading);
      else (cur ?? open(opts.title ?? 'Document')).bullets.push(heading);
      i += 2;
    } else if (t.type === 'paragraph_open') {
      const text = inlineText(tokens[i + 1]);
      const slide = cur ?? open(opts.title ?? 'Document');
      if (text.trim()) slide.bullets.push(text);
      i += 2;
    } else if (t.type === 'inline') {
      // list-item / table-cell inline text → bullets
      const slide = cur ?? open(opts.title ?? 'Document');
      const text = inlineText(t);
      if (text.trim()) slide.bullets.push(text);
    }
  }
  if (deck.length === 0) open(opts.title ?? 'Document');

  for (const s of deck) {
    const slide = pptx.addSlide();
    slide.addText(s.title || (opts.title ?? 'Document'), { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 24, bold: true });
    if (s.bullets.length) {
      slide.addText(s.bullets.map((b) => ({ text: b, options: { bullet: true } })), { x: 0.6, y: 1.3, w: 8.8, h: 5, fontSize: 14 });
    }
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}
