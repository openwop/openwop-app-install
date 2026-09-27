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

/**
 * Render Markdown to an HTML string (ADR 0350 Phase 3 — "promote to rich
 * document"). GFM tables via markdown-it defaults; the HTML is consumed ONLY by
 * the frontend's `generateJSON(html, documentExtensions())`, which drops any
 * unknown/script markup — so raw HTML in the markdown cannot survive into the
 * canvas. Deterministic; no network, no provider. `html: false` keeps
 * markdown-it from passing embedded HTML through verbatim.
 */
export function markdownToHtml(markdown: string): string {
  const md = new MarkdownIt({ html: false, linkify: true });
  return md.render(markdown ?? '');
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

/** CWE-1236 (DOCT-2) — a cell beginning `=` / `+` / `-` / `@` / tab / CR
 *  executes as a formula when this CSV "opens directly in Excel/Sheets" (see
 *  below), and sheet content can be model-authored (every documents agent tool
 *  declares `contentTrust:'untrusted'` — a prompt-injected agent reaches the
 *  operator's spreadsheet). Neutralize with the spreadsheet text-literal
 *  apostrophe. Ordinary signed numbers (`-42`, `+3.5`) are data, not formulas,
 *  and pass through unmangled. */
function neutralizeFormulaTrigger(v: string): string {
  if (!/^[=@\t\r+-]/.test(v)) return v;
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(v)) return v; // an ordinary signed number
  return `'${v}`;
}

function csvCell(raw: string): string {
  const v = neutralizeFormulaTrigger(raw);
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

// ── ADR 0400 — DOCX export (P1) ──────────────────────────────────────────────

/** Host-resolved image bytes for an export embed (already tenant-checked). */
export interface ResolvedExportImage {
  data: Buffer;
  /** 'png' | 'jpg' | 'gif' — what the OOXML part declares. */
  kind: 'png' | 'jpg' | 'gif';
  width: number;
  height: number;
}

/** Resolves a markdown image src to embeddable bytes, or null when the src is
 *  not embeddable (external URL, foreign tenant, unsupported type). The
 *  SERVICE owns the tenant check; the walker never fetches (SSRF posture —
 *  the slides-export image rule). */
export type ExportImageResolver = (src: string) => Promise<ResolvedExportImage | null>;

/** Minimal raster header probe (png/jpeg/gif) — pure-JS pixel dimensions for
 *  the OOXML transform (docx requires explicit width/height). */
export function probeImageDims(data: Buffer): { kind: 'png' | 'jpg' | 'gif'; width: number; height: number } | null {
  if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { kind: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length > 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return { kind: 'gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    // JPEG: scan segments for a SOFn frame header.
    let off = 2;
    while (off + 9 < data.length) {
      if (data[off] !== 0xff) { off++; continue; }
      const marker = data[off + 1] ?? 0;
      const len = data.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { kind: 'jpg', width: data.readUInt16BE(off + 7), height: data.readUInt16BE(off + 5) };
      }
      off += 2 + len;
    }
  }
  return null;
}

/** Scale image dims to fit the printable width (~6.5in at 96dpi ≈ 624px). */
function fitImage(width: number, height: number): { width: number; height: number } {
  const MAX_W = 624;
  if (width <= MAX_W || width <= 0) return { width, height };
  const scale = MAX_W / width;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Render Markdown to DOCX bytes via the `docx` document model (ADR 0400 P1) —
 * a peer of the pdfkit walker over the SAME markdown-it token stream, but with
 * REAL inline runs (bold/italic/strike/code/links), real list numbering, real
 * tables, embedded host images (via `resolveImage`), and real footnotes
 * (`markdown-it-footnote` → docx footnotes). Math (`$…$`) degrades to
 * TeX-as-text (OMML out of scope — the ADR 0400 fidelity matrix). External
 * image URLs become linked text, never fetched. Deterministic; no network.
 *
 * NOTE: a second DOCX writer exists — `document-editor/pmToDocx.ts` (ADR 0334
 * 4b-2) serializes ProseMirror JSON (a different SoT). Disjoint inputs, same
 * output format; this one owns markdown→DOCX (the ADR 0400 correction note).
 */
export async function renderMarkdownToDocx(markdown: string, opts: { title?: string; resolveImage?: ExportImageResolver } = {}): Promise<Buffer> {
  const {
    Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel, ImageRun,
    Table, TableRow, TableCell, WidthType, FootnoteReferenceRun,
  } = await import('docx');
  const footnotePlugin = (await import('markdown-it-footnote')).default;
  const md = new MarkdownIt();
  footnotePlugin(md);
  const tokens = md.parse(markdown ?? '', {});

  const HEADING_LEVELS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as const;
  type Child = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  type Run = InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink> | InstanceType<typeof ImageRun> | InstanceType<typeof FootnoteReferenceRun>;

  interface MarkState { bold?: boolean; italics?: boolean; strike?: boolean; href?: string }
  const footnoteParagraphs = new Map<number, InstanceType<typeof Paragraph>[]>();

  /** Inline token → runs, honoring nested mark state (async: images resolve). */
  const inlineRuns = async (inline: Token | undefined): Promise<Run[]> => {
    if (!inline?.children) {
      return inline?.content ? [new TextRun({ text: inline.content })] : [];
    }
    const runs: Run[] = [];
    const state: MarkState = {};
    let linkRuns: Run[] | null = null;
    const push = (r: Run): void => { (linkRuns ?? runs).push(r); };
    for (const c of inline.children) {
      switch (c.type) {
        case 'text': push(new TextRun({ text: c.content, bold: state.bold, italics: state.italics, strike: state.strike })); break;
        case 'code_inline': push(new TextRun({ text: c.content, font: 'Courier New' })); break;
        case 'strong_open': state.bold = true; break;
        case 'strong_close': delete state.bold; break;
        case 'em_open': state.italics = true; break;
        case 'em_close': delete state.italics; break;
        case 's_open': state.strike = true; break;
        case 's_close': delete state.strike; break;
        case 'link_open': {
          state.href = String(c.attrGet('href') ?? '');
          linkRuns = [];
          break;
        }
        case 'link_close': {
          if (linkRuns && state.href) {
            const children = linkRuns.filter((r): r is InstanceType<typeof TextRun> => r instanceof TextRun);
            runs.push(new ExternalHyperlink({ children, link: state.href }));
          } else if (linkRuns) {
            runs.push(...linkRuns);
          }
          linkRuns = null;
          delete state.href;
          break;
        }
        case 'image': {
          const src = String(c.attrGet('src') ?? '');
          const alt = c.content || 'image';
          const resolved = opts.resolveImage ? await opts.resolveImage(src) : null;
          if (resolved) {
            const dims = fitImage(resolved.width, resolved.height);
            push(new ImageRun({ data: resolved.data, type: resolved.kind, transformation: dims }));
          } else {
            // External / unresolvable image: linked text, never fetched.
            push(new TextRun({ text: `[${alt}]`, italics: true }));
          }
          break;
        }
        case 'footnote_ref': {
          const id = (c.meta as { id?: number } | null)?.id;
          if (typeof id === 'number') push(new FootnoteReferenceRun(id + 1));
          break;
        }
        case 'softbreak':
        case 'hardbreak': push(new TextRun({ break: 1 })); break;
        default: break;
      }
    }
    if (linkRuns) runs.push(...linkRuns);
    return runs;
  };

  const children: Child[] = [];
  const listStack: Array<{ ordered: boolean }> = [];
  let inBlockquote = false;
  let footnoteTarget: InstanceType<typeof Paragraph>[] | null = null;
  const emit = (p: Child): void => {
    if (footnoteTarget) { if (p instanceof Paragraph) footnoteTarget.push(p); return; }
    children.push(p);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const level = Math.min(6, Math.max(1, Number(t.tag.slice(1)) || 3));
        emit(new Paragraph({ heading: HEADING_LEVELS[level - 1], children: await inlineRuns(tokens[i + 1]) }));
        i += 2;
        break;
      }
      case 'paragraph_open': {
        const runs = await inlineRuns(tokens[i + 1]);
        const level = listStack.length;
        if (level > 0) {
          const top = listStack[level - 1];
          emit(new Paragraph({
            children: runs,
            ...(top?.ordered
              ? { numbering: { reference: 'owp-ordered', level: Math.min(8, level - 1) } }
              : { bullet: { level: Math.min(8, level - 1) } }),
          }));
        } else if (inBlockquote) {
          emit(new Paragraph({ children: runs, indent: { left: 400 }, style: 'IntenseQuote' }));
        } else {
          emit(new Paragraph({ children: runs }));
        }
        i += 2;
        break;
      }
      case 'bullet_list_open': listStack.push({ ordered: false }); break;
      case 'ordered_list_open': listStack.push({ ordered: true }); break;
      case 'bullet_list_close':
      case 'ordered_list_close': listStack.pop(); break;
      case 'blockquote_open': inBlockquote = true; break;
      case 'blockquote_close': inBlockquote = false; break;
      case 'fence':
      case 'code_block': {
        const lines = t.content.replace(/\n$/, '').split('\n');
        emit(new Paragraph({
          children: lines.flatMap((line, idx) => [new TextRun({ text: line, font: 'Courier New', size: 18, ...(idx > 0 ? { break: 1 } : {}) })]),
        }));
        break;
      }
      case 'hr': emit(new Paragraph({ thematicBreak: true })); break;
      case 'table_open': {
        const rows: InstanceType<typeof TableRow>[] = [];
        let header = false;
        i++;
        for (; i < tokens.length && tokens[i].type !== 'table_close'; i++) {
          const tt = tokens[i];
          if (tt.type === 'thead_open') header = true;
          else if (tt.type === 'thead_close') header = false;
          else if (tt.type === 'tr_open') {
            const cells: InstanceType<typeof TableCell>[] = [];
            for (i++; i < tokens.length && tokens[i].type !== 'tr_close'; i++) {
              if (tokens[i].type === 'inline') {
                const runs = await inlineRuns(tokens[i]);
                cells.push(new TableCell({
                  children: [new Paragraph({ children: header ? runs.map((r) => r) : runs })],
                }));
              }
            }
            rows.push(new TableRow({ children: cells, tableHeader: header }));
          }
        }
        emit(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        break;
      }
      case 'footnote_open': {
        const id = (t.meta as { id?: number } | null)?.id;
        footnoteTarget = [];
        if (typeof id === 'number') footnoteParagraphs.set(id + 1, footnoteTarget);
        break;
      }
      case 'footnote_close': footnoteTarget = null; break;
      default: break;
    }
  }

  const footnotes: Record<number, { children: InstanceType<typeof Paragraph>[] }> = {};
  for (const [id, paras] of footnoteParagraphs) footnotes[id] = { children: paras };

  const doc = new Document({
    title: opts.title ?? 'Document',
    numbering: {
      config: [{
        reference: 'owp-ordered',
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: 'decimal' as const,
          text: `%${level + 1}.`,
          alignment: 'start' as const,
        })),
      }],
    },
    ...(Object.keys(footnotes).length > 0 ? { footnotes } : {}),
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

// ── ADR 0400 — EPUB3 export (P2) ─────────────────────────────────────────────

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Split markdown into chapters on h1/h2 boundaries, fence-aware (a `#` line
 *  inside a code fence never starts a chapter). A heading-less doc is one
 *  chapter. Pure. */
export function splitMarkdownChapters(markdown: string): Array<{ title: string; markdown: string }> {
  const lines = (markdown ?? '').split('\n');
  const chapters: Array<{ title: string; lines: string[] }> = [];
  let cur: { title: string; lines: string[] } | null = null;
  let fenceMarker: string | null = null;
  for (const line of lines) {
    // R0400-2 — track WHICH fence style opened, so a ``` block containing ~~~
    // (or vice versa) never flips the state mid-fence.
    const fence = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (fenceMarker === null) fenceMarker = fence[0] ?? null;
      else if (fenceMarker === fence[0]) fenceMarker = null;
    }
    const inFence = fenceMarker !== null;
    const m = !inFence ? line.match(/^(#{1,2})\s+(.*)$/) : null;
    if (m) {
      cur = { title: (m[2] ?? '').trim() || 'Chapter', lines: [line] };
      chapters.push(cur);
      continue;
    }
    if (!cur) { cur = { title: '', lines: [] }; chapters.push(cur); }
    cur.lines.push(line);
  }
  return chapters
    .filter((c) => c.title || c.lines.some((l) => l.trim().length > 0))
    .map((c, i) => ({ title: c.title || (i === 0 ? 'Start' : `Chapter ${i + 1}`), markdown: c.lines.join('\n') }));
}

/**
 * Render Markdown to an EPUB3 (ADR 0400 P2) — an in-memory zip of XHTML
 * chapters (split on h1/h2), an OPF package, and a nav doc, via `jszip`. Own
 * markdown-it instance with `xhtmlOut` (EPUB content documents are XHTML —
 * the shared `markdownToHtml` emits HTML5 void tags; ADR correction note).
 * Host images embed into the zip tenant-checked via `resolveImage`; external
 * URLs degrade to their alt text as a link (never fetched). `modifiedAt` comes
 * from the immutable version (no wall-clock — determinism). Math stays as
 * literal `$…$` text (TeX→MathML needs a converter dep — deferred with the
 * DOCX OMML question; ADR correction note).
 */
/** A markdown-it plugin recognizing `$$…$$` math and rendering it to MathML via
 *  temml (ADR 0400 EPUB-MathML follow-through). DISPLAY math only — `$$` is
 *  unambiguous (single `$` money like `$5` never matches), the rule runs before
 *  `escape` so `$$` survives, and it never fires inside code (markdown-it's
 *  backtick/fence rules capture those spans first). Unparseable TeX falls back
 *  to the literal `$$…$$` text, so a bad formula never breaks the document. */
function mathDollarPlugin(temml: { renderToString(tex: string, o?: { displayMode?: boolean; xml?: boolean; throwOnError?: boolean }): string }): (md: MarkdownIt) => void {
  return (md) => {
    md.inline.ruler.before('escape', 'owp_math', (state, silent) => {
      if (state.src.slice(state.pos, state.pos + 2) !== '$$') return false;
      const end = state.src.indexOf('$$', state.pos + 2);
      if (end < 0) return false;
      const content = state.src.slice(state.pos + 2, end);
      if (!content.trim()) return false;
      if (!silent) {
        const token = state.push('owp_math', 'math', 0);
        token.content = content.trim();
        token.markup = '$$';
      }
      state.pos = end + 2;
      return true;
    });
    md.renderer.rules.owp_math = (tokens, idx) => {
      const tex = tokens[idx]?.content ?? '';
      try {
        return temml.renderToString(tex, { displayMode: true, xml: true, throwOnError: true });
      } catch {
        // Literal fallback — never break the doc on a malformed formula.
        return `$$${md.utils.escapeHtml(tex)}$$`;
      }
    };
  };
}

/**
 * EPUB-DET-1 — pin every ZIP entry's timestamp before generating.
 *
 * JSZip stamps each entry with `new Date()` at write time, so two exports from
 * IDENTICAL inputs differ whenever they straddle a second boundary. ADR 0400's own
 * tests claim "same inputs ⇒ identical bytes"; that was true only because both
 * generations usually land in the same second. Caught 2026-08-01 by a full-suite
 * failure (`Buffer.compare` → -1) that passed 21/21 in isolation.
 *
 * Applied ONCE over `zip.files` rather than as a `{date}` on each of the 12
 * `zip.file(...)` call sites: a missed call site silently reintroduces the defect,
 * and any entry added later is covered here for free.
 */
// Typed STRUCTURALLY: `JSZip` is dynamically imported inside each generator, so the
// nominal type is not in module scope — and this only needs the entry map anyway.
function pinZipTimestamps(zip: { files: Record<string, { date: Date }> }, isoish: string): void {
  const d = new Date(isoish);
  const pinned = Number.isNaN(d.getTime()) ? new Date(0) : d;
  for (const entry of Object.values(zip.files)) entry.date = pinned;
}

export async function renderMarkdownToEpub(markdown: string, opts: { title?: string; identifier?: string; modifiedAt?: string; resolveImage?: ExportImageResolver } = {}): Promise<Buffer> {
  const { default: JSZip } = await import('jszip');
  const { default: temml } = await import('temml');
  const md = new MarkdownIt({ html: false, linkify: true, xhtmlOut: true });
  md.use(mathDollarPlugin(temml));
  const zip = new JSZip();
  const title = opts.title ?? 'Document';
  const identifier = opts.identifier ?? `urn:openwop:doc:${title.replace(/\W+/g, '-').toLowerCase()}`;
  // EPUB3 requires dcterms:modified; the version's own timestamp keeps the
  // bytes deterministic per immutable version (never a live clock read).
  const modified = (opts.modifiedAt ?? '1970-01-01T00:00:00Z').replace(/\.\d+Z$/, 'Z');

  // mimetype MUST be the first entry and STORED (uncompressed).
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`);

  const chapters = splitMarkdownChapters(markdown);
  const images: Array<{ path: string; mediaType: string }> = [];
  const seenImages = new Map<string, string>(); // src → zip path

  const embedImages = async (html: string): Promise<string> => {
    const srcs = [...html.matchAll(/<img[^>]*\bsrc="([^"]+)"[^>]*\/?>(?:<\/img>)?/g)];
    let out = html;
    for (const match of srcs) {
      const tag = match[0];
      const src = match[1] ?? '';
      const altMatch = tag.match(/\balt="([^"]*)"/);
      const alt = altMatch?.[1] ?? 'image';
      let path = seenImages.get(src);
      if (!path) {
        const resolved = opts.resolveImage ? await opts.resolveImage(src) : null;
        if (resolved) {
          path = `images/img${images.length + 1}.${resolved.kind === 'jpg' ? 'jpeg' : resolved.kind}`;
          const mediaType = resolved.kind === 'jpg' ? 'image/jpeg' : `image/${resolved.kind}`;
          zip.file(`EPUB/${path}`, resolved.data);
          images.push({ path, mediaType });
          seenImages.set(src, path);
        }
      }
      out = out.replace(tag, path
        ? `<img src="${xmlEscape(path)}" alt="${xmlEscape(alt)}"/>`
        : `<a href="${xmlEscape(src)}">[${xmlEscape(alt)}]</a>`);
    }
    return out;
  };

  const chapterMeta: Array<{ id: string; file: string; title: string; hasMath: boolean }> = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    if (!ch) continue;
    const body = await embedImages(md.render(ch.markdown));
    const file = `chapter${i + 1}.xhtml`;
    // EPUB3 wants the `mathml` manifest property on content docs that carry it.
    chapterMeta.push({ id: `ch${i + 1}`, file, title: ch.title, hasMath: body.includes('<math') });
    zip.file(`EPUB/${file}`, `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${xmlEscape(ch.title)}</title></head>
<body>
${body}</body>
</html>
`);
  }

  const navItems = chapterMeta.map((c) => `      <li><a href="${c.file}">${xmlEscape(c.title)}</a></li>`).join('\n');
  zip.file('EPUB/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${xmlEscape(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${xmlEscape(title)}</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>
`);

  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...chapterMeta.map((c) => `    <item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"${c.hasMath ? ' properties="mathml"' : ''}/>`),
    ...images.map((img, i) => `    <item id="img${i + 1}" href="${img.path}" media-type="${img.mediaType}"/>`),
  ].join('\n');
  const spine = chapterMeta.map((c) => `    <itemref idref="${c.id}"/>`).join('\n');
  zip.file('EPUB/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${xmlEscape(identifier)}</dc:identifier>
    <dc:title>${xmlEscape(title)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${xmlEscape(modified)}</meta>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`);

  pinZipTimestamps(zip, modified);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>;
}

// ── ADR 0400 — ODT export (P3) ───────────────────────────────────────────────

/**
 * Render Markdown to ODT (ADR 0400 P3) — a templated OpenDocument text: no
 * mature pure-JS ODT writer exists, so we emit `content.xml`/`styles.xml`/
 * `manifest.xml`/`mimetype` directly from the SAME markdown-it token stream
 * (fence/table/list walk mirrors the DOCX walker) and zip with `jszip`
 * (mimetype first, STORED — the ODF package rule). Fidelity per the ADR
 * matrix: real headings/lists/tables/code/quote/footnotes; images embed
 * approximately sized; math drops to text. Deterministic; no network.
 */
export async function renderMarkdownToOdt(markdown: string, opts: { title?: string; resolveImage?: ExportImageResolver } = {}): Promise<Buffer> {
  const { default: JSZip } = await import('jszip');
  const footnotePlugin = (await import('markdown-it-footnote')).default;
  const md = new MarkdownIt();
  footnotePlugin(md);
  const tokens = md.parse(markdown ?? '', {});

  const pictures: Array<{ path: string; mediaType: string }> = [];
  const zip = new JSZip();
  const footnoteBodies = new Map<number, string[]>(); // id → ODF paragraph XML

  /** Inline children → ODF text spans (marks via named styles). */
  const inlineOdf = async (inline: Token | undefined): Promise<string> => {
    if (!inline?.children) return xmlEscape(inline?.content ?? '');
    let out = '';
    const stack: string[] = [];
    const open = (style: string): void => { out += `<text:span text:style-name="${style}">`; stack.push(style); };
    const close = (): void => { if (stack.pop()) out += '</text:span>'; };
    for (const c of inline.children) {
      switch (c.type) {
        case 'text': out += xmlEscape(c.content); break;
        case 'code_inline': out += `<text:span text:style-name="OwpCode">${xmlEscape(c.content)}</text:span>`; break;
        case 'strong_open': open('OwpBold'); break;
        case 'em_open': open('OwpItalic'); break;
        case 's_open': open('OwpStrike'); break;
        case 'strong_close':
        case 'em_close':
        case 's_close': close(); break;
        case 'link_open': out += `<text:a xlink:type="simple" xlink:href="${xmlEscape(String(c.attrGet('href') ?? ''))}">`; break;
        case 'link_close': out += '</text:a>'; break;
        case 'softbreak':
        case 'hardbreak': out += '<text:line-break/>'; break;
        case 'image': {
          const src = String(c.attrGet('src') ?? '');
          const alt = c.content || 'image';
          const resolved = opts.resolveImage ? await opts.resolveImage(src) : null;
          if (resolved) {
            const path = `Pictures/img${pictures.length + 1}.${resolved.kind === 'jpg' ? 'jpeg' : resolved.kind}`;
            zip.file(path, resolved.data);
            pictures.push({ path, mediaType: resolved.kind === 'jpg' ? 'image/jpeg' : `image/${resolved.kind}` });
            // ~96dpi → cm; width capped at 16.5cm (A4 printable), aspect kept.
            const wCm = Math.min(16.5, resolved.width / 96 * 2.54);
            const hCm = resolved.width > 0 ? wCm * (resolved.height / resolved.width) : 1;
            out += `<draw:frame draw:name="${xmlEscape(alt)}" text:anchor-type="as-char" svg:width="${wCm.toFixed(3)}cm" svg:height="${hCm.toFixed(3)}cm"><draw:image xlink:href="${xmlEscape(path)}" xlink:type="simple"/></draw:frame>`;
          } else {
            out += `<text:span text:style-name="OwpItalic">[${xmlEscape(alt)}]</text:span>`;
          }
          break;
        }
        case 'footnote_ref': {
          const id = (c.meta as { id?: number } | null)?.id;
          if (typeof id === 'number') {
            out += `<text:note text:note-class="footnote" text:id="ftn${id + 1}"><text:note-citation>${id + 1}</text:note-citation><text:note-body>__OWP_FOOTNOTE_${id + 1}__</text:note-body></text:note>`;
          }
          break;
        }
        default: break;
      }
    }
    while (stack.length > 0) close();
    return out;
  };

  let body = '';
  const listStack: Array<{ ordered: boolean }> = [];
  let inBlockquote = false;
  let footnoteTarget: string[] | null = null;
  const emit = (xml: string): void => { if (footnoteTarget) footnoteTarget.push(xml); else body += xml + '\n'; };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const level = Math.min(6, Math.max(1, Number(t.tag.slice(1)) || 3));
        emit(`<text:h text:style-name="Heading_20_${level}" text:outline-level="${level}">${await inlineOdf(tokens[i + 1])}</text:h>`);
        i += 2;
        break;
      }
      case 'paragraph_open': {
        const style = inBlockquote ? 'OwpQuote' : listStack.length > 0 ? 'OwpListPara' : 'Text_20_body';
        const inner = `<text:p text:style-name="${style}">${await inlineOdf(tokens[i + 1])}</text:p>`;
        emit(listStack.length > 0 ? `<text:list-item>${inner}</text:list-item>` : inner);
        i += 2;
        break;
      }
      case 'bullet_list_open': listStack.push({ ordered: false }); emit('<text:list text:style-name="OwpBulletList">'); break;
      case 'ordered_list_open': listStack.push({ ordered: true }); emit('<text:list text:style-name="OwpNumberList">'); break;
      case 'bullet_list_close':
      case 'ordered_list_close': listStack.pop(); emit('</text:list>'); break;
      case 'blockquote_open': inBlockquote = true; break;
      case 'blockquote_close': inBlockquote = false; break;
      case 'fence':
      case 'code_block': {
        for (const line of t.content.replace(/\n$/, '').split('\n')) {
          emit(`<text:p text:style-name="OwpCodeBlock">${xmlEscape(line)}</text:p>`);
        }
        break;
      }
      case 'hr': emit('<text:p text:style-name="OwpRule"/>'); break;
      case 'table_open': {
        let table = '<table:table>';
        let cols = 0;
        const rowsXml: string[] = [];
        i++;
        for (; i < tokens.length && tokens[i].type !== 'table_close'; i++) {
          if (tokens[i].type === 'tr_open') {
            const cells: string[] = [];
            for (i++; i < tokens.length && tokens[i].type !== 'tr_close'; i++) {
              if (tokens[i].type === 'inline') cells.push(`<table:table-cell office:value-type="string"><text:p>${await inlineOdf(tokens[i])}</text:p></table:table-cell>`);
            }
            cols = Math.max(cols, cells.length);
            rowsXml.push(`<table:table-row>${cells.join('')}</table:table-row>`);
          }
        }
        table += `<table:table-column table:number-columns-repeated="${Math.max(1, cols)}"/>` + rowsXml.join('') + '</table:table>';
        emit(table);
        break;
      }
      case 'footnote_open': {
        const id = (t.meta as { id?: number } | null)?.id;
        footnoteTarget = [];
        if (typeof id === 'number') footnoteBodies.set(id + 1, footnoteTarget);
        break;
      }
      case 'footnote_close': footnoteTarget = null; break;
      default: break;
    }
  }

  // Splice footnote bodies into their citation anchors.
  for (const [id, paras] of footnoteBodies) {
    body = body.replace(`__OWP_FOOTNOTE_${id}__`, paras.join(''));
  }
  body = body.replace(/__OWP_FOOTNOTE_\d+__/g, '');

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">
  <office:automatic-styles>
    <style:style style:name="OwpBold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="OwpItalic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
    <style:style style:name="OwpStrike" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
    <style:style style:name="OwpCode" style:family="text"><style:text-properties style:font-name="Courier New"/></style:style>
    <style:style style:name="OwpCodeBlock" style:family="paragraph"><style:text-properties style:font-name="Courier New" fo:font-size="9pt"/></style:style>
    <style:style style:name="OwpQuote" style:family="paragraph"><style:paragraph-properties fo:margin-left="0.8cm"/><style:text-properties fo:font-style="italic"/></style:style>
    <style:style style:name="OwpListPara" style:family="paragraph"/>
    <style:style style:name="OwpRule" style:family="paragraph"><style:paragraph-properties fo:border-top="0.5pt solid #808080"/></style:style>
  </office:automatic-styles>
  <office:body><office:text>
${body}  </office:text></office:body>
</office:document-content>
`;

  const manifestEntries = [
    '  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>',
    '  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
    '  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
    '  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
    ...pictures.map((p) => `  <manifest:file-entry manifest:full-path="${p.path}" manifest:media-type="${p.mediaType}"/>`),
  ].join('\n');

  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file('content.xml', contentXml);
  zip.file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">
  <office:styles>
    <style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph"/>
    ${[1, 2, 3, 4, 5, 6].map((l) => `<style:style style:name="Heading_20_${l}" style:display-name="Heading ${l}" style:family="paragraph"><style:text-properties fo:font-weight="bold" fo:font-size="${22 - l * 2}pt"/></style:style>`).join('\n    ')}
  </office:styles>
</office:document-styles>
`);
  zip.file('meta.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
  <office:meta><dc:title>${xmlEscape(opts.title ?? 'Document')}</dc:title></office:meta>
</office:document-meta>
`);
  zip.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
${manifestEntries}
</manifest:manifest>
`);

  // EPUB-DET-1 — ODT has no `modifiedAt` in its options, so pin to the epoch: the
  // value only needs to be STABLE, and a fixed epoch is honest about carrying no
  // real modification time (an invented 'now' would be the bug again).
  pinZipTimestamps(zip, '1970-01-01T00:00:00Z');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>;
}

// ── ADR 0400 P4 — LaTeX source export ────────────────────────────────────────

/** LaTeX special-char escape for BODY text (never inside math or verbatim).
 *  `$` is intentionally NOT escaped here — math spans are split out first so a
 *  `$…$` formula passes through verbatim (LaTeX is math's native format, so
 *  this export has the BEST math fidelity of the set — the ADR matrix's ✓). */
function latexEscapeText(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/** Escape body text but preserve inline `$…$` math spans verbatim. markdown-it
 *  does not tokenize `$…$`, so a formula arrives as plain text; split on the
 *  delimiters and escape only the non-math segments. */
function latexInlineWithMath(text: string): string {
  // Split on $$…$$ (display) first, then $…$ (inline). Odd segments are math.
  const parts = text.split(/(\$\$[^$]*\$\$|\$[^$]+\$)/g);
  return parts.map((seg) => (seg.startsWith('$') ? seg : latexEscapeText(seg))).join('');
}

/**
 * Render Markdown to a standalone LaTeX SOURCE document (ADR 0400 P4) — a peer
 * token walker over the same markdown-it stream (with footnotes). SOURCE-only:
 * no compile, no TeX distribution shipped (the ADR decision). Headings →
 * section levels, lists → itemize/enumerate, code → verbatim, tables → tabular,
 * blockquote → quote, footnotes → \footnote, inline marks → \textbf/\textit/
 * \sout/\texttt/\href. Inline `$…$` math passes through VERBATIM — the one
 * export where math is faithful. Host/external images become a labelled
 * placeholder (source-only carries no bytes). Deterministic; no network.
 */
export async function renderMarkdownToLatex(markdown: string, opts: { title?: string } = {}): Promise<string> {
  const footnotePlugin = (await import('markdown-it-footnote')).default;
  const md = new MarkdownIt();
  footnotePlugin(md);
  const tokens = md.parse(markdown ?? '', {});

  const SECTION = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'];
  const footnoteBodies = new Map<number, string>();

  const inlineLatex = (inline: Token | undefined): string => {
    if (!inline?.children) return latexInlineWithMath(inline?.content ?? '');
    let out = '';
    const link: { href?: string; buf?: string }[] = [];
    const push = (s: string): void => { if (link.length) link[link.length - 1]!.buf += s; else out += s; };
    for (const c of inline.children) {
      switch (c.type) {
        case 'text': push(latexInlineWithMath(c.content)); break;
        case 'code_inline': push(`\\texttt{${latexEscapeText(c.content)}}`); break;
        case 'strong_open': push('\\textbf{'); break;
        case 'em_open': push('\\textit{'); break;
        case 's_open': push('\\sout{'); break;
        case 'strong_close': case 'em_close': case 's_close': push('}'); break;
        case 'link_open': link.push({ href: String(c.attrGet('href') ?? ''), buf: '' }); break;
        case 'link_close': {
          const l = link.pop();
          if (l) push(`\\href{${latexEscapeText(l.href ?? '')}}{${l.buf ?? ''}}`);
          break;
        }
        case 'image': push(`\\texttt{[${latexEscapeText(c.content || 'image')}]}`); break;
        case 'softbreak': push(' '); break;
        case 'hardbreak': push('\\\\\n'); break;
        case 'footnote_ref': {
          const id = (c.meta as { id?: number } | null)?.id;
          if (typeof id === 'number') push(`\\footnote{__OWP_FN_${id + 1}__}`);
          break;
        }
        default: break;
      }
    }
    return out;
  };

  const body: string[] = [];
  const listStack: Array<'itemize' | 'enumerate'> = [];
  let footnoteTarget: number | null = null;
  const emit = (s: string): void => {
    if (footnoteTarget !== null) footnoteBodies.set(footnoteTarget, (footnoteBodies.get(footnoteTarget) ?? '') + s + ' ');
    else body.push(s);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const level = Math.min(6, Math.max(1, Number(t.tag.slice(1)) || 3));
        emit(`\\${SECTION[level - 1]}{${inlineLatex(tokens[i + 1])}}`);
        i += 2;
        break;
      }
      case 'paragraph_open':
        emit(inlineLatex(tokens[i + 1]) + '\n');
        i += 2;
        break;
      case 'bullet_list_open': listStack.push('itemize'); emit('\\begin{itemize}'); break;
      case 'ordered_list_open': listStack.push('enumerate'); emit('\\begin{enumerate}'); break;
      case 'bullet_list_close':
      case 'ordered_list_close': { const env = listStack.pop(); emit(`\\end{${env}}`); break; }
      case 'list_item_open': emit('\\item '); break;
      case 'blockquote_open': emit('\\begin{quote}'); break;
      case 'blockquote_close': emit('\\end{quote}'); break;
      case 'fence':
      case 'code_block':
        emit(`\\begin{verbatim}\n${t.content.replace(/\n$/, '')}\n\\end{verbatim}`);
        break;
      case 'hr': emit('\\begin{center}\\rule{0.5\\linewidth}{0.4pt}\\end{center}'); break;
      case 'table_open': {
        const rows: string[][] = [];
        let cols = 0;
        i++;
        for (; i < tokens.length && tokens[i].type !== 'table_close'; i++) {
          if (tokens[i].type === 'tr_open') {
            const cells: string[] = [];
            for (i++; i < tokens.length && tokens[i].type !== 'tr_close'; i++) {
              if (tokens[i].type === 'inline') cells.push(inlineLatex(tokens[i]));
            }
            cols = Math.max(cols, cells.length);
            rows.push(cells);
          }
        }
        const spec = `|${'l|'.repeat(Math.max(1, cols))}`;
        const lines = rows.map((r) => r.concat(Array(Math.max(0, cols - r.length)).fill('')).join(' & ') + ' \\\\');
        emit(`\\begin{center}\\begin{tabular}{${spec}}\n\\hline\n${lines.join('\n\\hline\n')}\n\\hline\n\\end{tabular}\\end{center}`);
        break;
      }
      case 'footnote_open': {
        const id = (t.meta as { id?: number } | null)?.id;
        footnoteTarget = typeof id === 'number' ? id + 1 : null;
        break;
      }
      case 'footnote_close': footnoteTarget = null; break;
      default: break;
    }
  }

  let doc = body.join('\n\n');
  // Splice footnote bodies into their \footnote{__OWP_FN_n__} anchors.
  for (const [id, text] of footnoteBodies) doc = doc.replace(`__OWP_FN_${id}__`, text.trim());
  doc = doc.replace(/__OWP_FN_\d+__/g, '');

  const title = opts.title ?? 'Document';
  return `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage[normalem]{ulem}
\\usepackage{hyperref}
\\title{${latexEscapeText(title)}}
\\date{}
\\begin{document}
\\maketitle
${doc}
\\end{document}
`;
}
