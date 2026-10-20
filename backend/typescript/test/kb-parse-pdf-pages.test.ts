/**
 * ADR 0904 P2 — a PDF chunk knows its page. The ingest extracted with `mergePages:true`
 * and every KB chunk reported `pageNumber: null`, so a citation could name the document
 * but never the page.
 *
 * Pinned (sabotage-witnessed): a 3-page PDF's chunks carry pages 1–3 through search AND
 * through `tenantRetrieve` (what `ctx.knowledge` and the vendor `augment-prompt` "(p. N)"
 * marker read) — a page boundary is a chunk boundary, so no chunk straddles two pages;
 * offsets are pure and empty pages keep their number; a later upsert of
 * non-PDF text over the same document id carries no stale page offsets.
 * Sabotage: `mergePages:true` again ⇒ red; drop `pageOffsets` from the document ⇒ red.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { joinPdfPages } from '../src/features/kb/parsers/pdfPages.js';
import { createCollection, ingestDocument, getDocument, searchDetailed, tenantRetrieve, upsertDocument, KB_MAINTENANCE_CALLER } from '../src/features/kb/kbService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbpdf-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

function makePdf(pages: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const p of pages) { doc.addPage(); doc.text(p); }
    doc.end();
  });
}

// Long enough that each page is its own chunk (> the 1,200-char window).
const filler = (topic: string) => `${topic}. `.repeat(1) + 'General operating guidance follows for this site and every shift. '.repeat(22);

describe('joinPdfPages', () => {
  it('records where each page starts; empty pages keep their number', () => {
    const { text, pageOffsets } = joinPdfPages(['Alpha', '', '  Gamma\r\n']);
    expect(text).toBe('Alpha\n\nGamma');
    expect(pageOffsets).toEqual([0, 5, 7]);
  });
});

describe('PDF ingest → page numbers on chunks', () => {
  it('search hits and tenantRetrieve chunks carry the real page', async () => {
    const pdf = await makePdf([filler('Forklift recertification is every three years'), filler('Cold chain pallets stay between two and eight degrees'), filler('Visitor badges are returned at the front desk')]);
    const col = await createCollection('t-pdf', 'o', 'u', { name: 'manuals' });
    const d = await ingestDocument('t-pdf', 'o', 'u', col.collectionId, { title: 'ops.pdf', contentBase64: pdf.toString('base64'), contentType: 'application/pdf' });
    const stored = await getDocument('t-pdf', 'o', col.collectionId, d.documentId);
    expect(stored?.pageOffsets).toHaveLength(3);

    const page = async (q: string) => (await searchDetailed('t-pdf', 'o', col.collectionId, q, 1, 'hybrid')).hits[0]?.pageNumber;
    expect(await page('forklift recertification three years')).toBe(1);
    expect(await page('cold chain pallets degrees')).toBe(2);
    expect(await page('visitor badges front desk')).toBe(3);

    const r = await tenantRetrieve('t-pdf', { query: 'visitor badges front desk', resultLimit: 1 }, KB_MAINTENANCE_CALLER);
    expect(r?.chunks[0]?.pageNumber).toBe(3);
    expect(r?.sources[0]?.pageNumber).toBe(3);
  });

  it('an upsert of plain text over a PDF document carries no stale page offsets', async () => {
    const pdf = await makePdf(['First page body text here.', 'Second page body text here.']);
    const col = await createCollection('t-pdf2', 'o', 'u', { name: 'm' });
    await ingestDocument('t-pdf2', 'o', 'u', col.collectionId, { title: 'a.pdf', contentBase64: pdf.toString('base64'), contentType: 'application/pdf' }, { documentId: 'doc-x' });
    expect((await getDocument('t-pdf2', 'o', col.collectionId, 'doc-x'))?.pageOffsets).toHaveLength(2);
    await upsertDocument('t-pdf2', 'o', col.collectionId, 'doc-x', 'u', { title: 'a', text: 'Now it is plain pasted text with no pages at all.' });
    const after = await getDocument('t-pdf2', 'o', col.collectionId, 'doc-x');
    expect(after?.pageOffsets).toBeUndefined();
    expect((await searchDetailed('t-pdf2', 'o', col.collectionId, 'plain pasted text', 1, 'hybrid')).hits[0]?.pageNumber).toBeUndefined();
  });
});
