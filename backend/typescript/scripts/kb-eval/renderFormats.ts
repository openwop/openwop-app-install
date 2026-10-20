/**
 * ADR 0904 P2 — the eval measures parsing too: a deterministic share of the corpus is
 * ingested as a real DOCX or PDF RENDERED from its markdown at run time (the `docx` and
 * `pdfkit` deps the app already ships), so a parser regression shows up as a retrieval
 * drop on the same labelled queries. No binary fixture is checked in.
 *
 * Every 5th markdown document → DOCX (headings, tables, bullet lists as real Word
 * structures); every 7th document → PDF (headings as larger bold text, one page per
 * top-level section). Everything else stays pasted text.
 */
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import PDFDocument from 'pdfkit';
import type { EvalDoc } from './harness.js';

export type EvalFormat = 'text' | 'docx' | 'pdf';

export function formatFor(doc: EvalDoc, index: number): EvalFormat {
  if (index % 7 === 3) return 'pdf';
  if (doc.format === 'md' && index % 5 === 1) return 'docx';
  return 'text';
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const strip = (s: string) => s.replace(/\*\*|__/g, '');
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

async function toDocx(md: string): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { children.push(new Paragraph({ text: strip(h[2]!), heading: HEADINGS[h[1]!.length - 1] })); continue; }
    if (line.trimStart().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) {
        if (!/^\s*\|\s*:?-{3,}/.test(lines[i]!)) rows.push(cells(lines[i]!));
        i++;
      }
      i--;
      children.push(new Table({ rows: rows.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph(strip(c))] })) })) }));
      continue;
    }
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) { children.push(new Paragraph({ text: strip(li[1]!), bullet: { level: 0 } })); continue; }
    if (line.trim()) children.push(new Paragraph({ children: [new TextRun(strip(line))] }));
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

function toPdf(md: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ autoFirstPage: false, info: { CreationDate: new Date(0) } });
    const out: Buffer[] = [];
    pdf.on('data', (c: Buffer) => out.push(c));
    pdf.on('end', () => resolve(Buffer.concat(out)));
    pdf.on('error', reject);
    pdf.addPage();
    let first = true;
    for (const line of md.split('\n')) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        if (h[1]!.length <= 2 && !first) pdf.addPage();
        pdf.font('Helvetica-Bold').fontSize(18 - h[1]!.length * 2).text(strip(h[2]!));
        pdf.font('Helvetica').fontSize(11);
      } else if (line.trim()) {
        pdf.text(strip(line.replace(/^\s*[-*]\s+/, '• ')));
      }
      first = false;
    }
    pdf.end();
  });
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The `ingestDocument` input for a corpus document in its eval format. */
export async function ingestInput(doc: EvalDoc, format: EvalFormat): Promise<{ title: string; text?: string; contentBase64?: string; contentType?: string }> {
  if (format === 'docx') return { title: doc.title, contentBase64: (await toDocx(doc.text)).toString('base64'), contentType: DOCX_MIME };
  if (format === 'pdf') return { title: doc.title, contentBase64: (await toPdf(doc.text)).toString('base64'), contentType: 'application/pdf' };
  return { title: doc.title, text: doc.text };
}
