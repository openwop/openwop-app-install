/**
 * ADR 0904 D6 / P6 (Track 2) — Document AI Layout Parser, operator opt-in, built INERT.
 *
 * Pinned, each sabotage-witnessed (revert → red → restore):
 *  - boot refuses a malformed processor or one without a daily page cap;
 *  - the Layout Parser's own blocks become markdown the chunker understands — headings,
 *    lists, tables — with page offsets;
 *  - a SCANNED PDF (no text layer) yields text only with Document AI configured, with
 *    real headings and pages;
 *  - the cap is checked BEFORE the call with the real page count (no call over the cap
 *    or the 15-page online limit), and a failed or empty answer falls back to the
 *    in-process parser.
 * Not built (owed): batch processing through GCS staging for files over 15 pages.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { assertDocAiBootConfig, layoutToMarkdown, __setDocAiDepsForTest, type DocAiDeps } from '../src/features/kb/parsers/documentAi.js';
import { createCollection, getDocument, ingestDocument, searchDetailed } from '../src/features/kb/kbService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbdocai-')) });
  initHostExtPersistence(await openStorage('memory://'));
});
afterEach(() => {
  __setDocAiDepsForTest(null);
  delete process.env.OPENWOP_KB_DOCAI_PROCESSOR;
  delete process.env.OPENWOP_KB_DOCAI_PAGES_PER_DAY;
});

const PROC = 'projects/p1/locations/us/processors/abc123';
const ON = () => Object.assign(process.env, { OPENWOP_KB_DOCAI_PROCESSOR: PROC, OPENWOP_KB_DOCAI_PAGES_PER_DAY: '50' });

function pdf(pages: Array<{ text?: string }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const out: Buffer[] = [];
    doc.on('data', (c: Buffer) => out.push(c));
    doc.on('end', () => resolve(Buffer.concat(out)));
    doc.on('error', reject);
    for (const p of pages) { doc.addPage(); if (p.text) doc.text(p.text); else doc.rect(50, 50, 200, 100).fill('#000000'); }
    doc.end();
  });
}

const LAYOUT = {
  document: {
    documentLayout: {
      blocks: [
        { pageSpan: { pageStart: 1 }, textBlock: { type: 'heading-1', text: 'Cold Chain Manual' } },
        { pageSpan: { pageStart: 1 }, textBlock: { type: 'paragraph', text: 'Pallets stay between two and eight degrees.' } },
        { pageSpan: { pageStart: 2 }, textBlock: { type: 'heading-2', text: 'Exceptions' } },
        { pageSpan: { pageStart: 2 }, listBlock: { type: 'unordered', listEntries: [{ blocks: [{ textBlock: { text: 'SX-17 temperature excursion' } }] }, { blocks: [{ textBlock: { text: 'SX-18 late arrival' } }] }] } },
        { pageSpan: { pageStart: 2 }, tableBlock: { headerRows: [{ cells: [{ blocks: [{ textBlock: { text: 'Code' } }] }, { blocks: [{ textBlock: { text: 'Action' } }] }] }], bodyRows: [{ cells: [{ blocks: [{ textBlock: { text: 'SX-17' } }] }, { blocks: [{ textBlock: { text: 'Quarantine | inspect' } }] }] }] } },
      ],
    },
  },
};

function fake(status: number, body: unknown, calls: Array<{ url: string; mime: string }> = []): DocAiDeps {
  return {
    metadata: { accessToken: async () => 'tok', metadataText: async () => 'p', invalidate: () => {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, mime: (JSON.parse(init.body) as { rawDocument: { mimeType: string } }).rawDocument.mimeType });
      return { ok: status === 200, status, text: async () => JSON.stringify(body) };
    },
  };
}

let n = 0;
async function col(): Promise<{ t: string; c: string }> {
  const t = `org:docai-${Date.now()}-${n++}`;
  return { t, c: (await createCollection(t, 'o', 'u', { name: 'c' })).collectionId };
}

describe('config + boot guard', () => {
  it('refuses a malformed processor and a processor without a page cap', () => {
    expect(() => assertDocAiBootConfig({})).not.toThrow();
    expect(() => assertDocAiBootConfig({ OPENWOP_KB_DOCAI_PROCESSOR: 'abc' })).toThrow(/projects\/<project>/);
    expect(() => assertDocAiBootConfig({ OPENWOP_KB_DOCAI_PROCESSOR: `${PROC}?query=unexpected` })).toThrow(/projects\/<project>/);
    expect(() => assertDocAiBootConfig({ OPENWOP_KB_DOCAI_PROCESSOR: PROC })).toThrow(/PAGES_PER_DAY/);
    expect(() => assertDocAiBootConfig({ OPENWOP_KB_DOCAI_PROCESSOR: PROC, OPENWOP_KB_DOCAI_PAGES_PER_DAY: '100' })).not.toThrow();
  });
});

describe('layoutToMarkdown', () => {
  it('retains text without inventing a citation for an unspecified zero page', () => {
    expect(layoutToMarkdown([{ pageSpan: { pageStart: 0 }, textBlock: { text: 'Page unknown' } }])).toEqual({ text: 'Page unknown', pageOffsets: [] });
  });

  it.each([-1, 1.5, 16])('rejects an invalid online page span %s', pageStart => {
    expect(() => layoutToMarkdown([{ pageSpan: { pageStart }, textBlock: { text: 'invalid page' } }])).toThrow('docai_invalid_page_span');
  });

  it('maps headings, lists and tables, with page offsets', () => {
    const { text, pageOffsets } = layoutToMarkdown(LAYOUT.document.documentLayout.blocks);
    expect(text).toBe([
      '# Cold Chain Manual',
      'Pallets stay between two and eight degrees.',
      '## Exceptions',
      '- SX-17 temperature excursion\n- SX-18 late arrival',
      '| Code | Action |\n| --- | --- |\n| SX-17 | Quarantine \\| inspect |',
    ].join('\n\n'));
    expect(pageOffsets).toEqual([0, text.indexOf('## Exceptions')]);
  });
});

describe('Document AI on ingest', () => {
  it('a SCANNED PDF yields text only with Document AI: headings, tables and pages', async () => {
    const scanned = (await pdf([{}, {}])).toString('base64');
    const a = await col();
    await expect(ingestDocument(a.t, 'o', 'u', a.c, { title: 'scan.pdf', contentBase64: scanned, contentType: 'application/pdf' })).rejects.toMatchObject({ httpStatus: 400 });

    ON();
    const calls: Array<{ url: string; mime: string }> = [];
    __setDocAiDepsForTest(fake(200, LAYOUT, calls));
    const b = await col();
    const d = await ingestDocument(b.t, 'o', 'u', b.c, { title: 'scan.pdf', contentBase64: scanned, contentType: 'application/pdf' });
    // ADR 0812 KEEP — Google's own REST API version (`googleapis.com/v1`), not the OpenWOP v1 wire.
    expect(calls).toEqual([{ url: `https://us-documentai.googleapis.com/v1/${PROC}:process`, mime: 'application/pdf' }]); // ADR 0812 KEEP
    expect((await getDocument(b.t, 'o', b.c, d.documentId))?.pageOffsets).toHaveLength(2);
    const hit = (await searchDetailed(b.t, 'o', b.c, 'SX-18 late arrival', 1, 'hybrid')).hits[0]!;
    expect(hit.pageNumber).toBe(2);
    expect(hit.headingPath).toEqual(['Cold Chain Manual', 'Exceptions']);
  });

  it('checks the page cap BEFORE calling, and never calls over the online page limit', async () => {
    ON();
    process.env.OPENWOP_KB_DOCAI_PAGES_PER_DAY = '1';
    const calls: Array<{ url: string; mime: string }> = [];
    __setDocAiDepsForTest(fake(200, LAYOUT, calls));
    const a = await col();
    await ingestDocument(a.t, 'o', 'u', a.c, { title: 'two.pdf', contentBase64: (await pdf([{ text: 'Page one text.' }, { text: 'Page two text.' }])).toString('base64'), contentType: 'application/pdf' });
    process.env.OPENWOP_KB_DOCAI_PAGES_PER_DAY = '100';
    await ingestDocument(a.t, 'o', 'u', a.c, { title: 'big.pdf', contentBase64: (await pdf(Array.from({ length: 16 }, (_v, i) => ({ text: `Page ${i}` })))).toString('base64'), contentType: 'application/pdf' });
    expect(calls, 'no call over the cap or the 15-page limit — the in-process parser ran').toHaveLength(0);
  });

  it('a failed or empty answer falls back to the in-process parser', async () => {
    ON();
    const a = await col();
    const text = (await pdf([{ text: 'Forklift recertification every three years.' }])).toString('base64');
    __setDocAiDepsForTest(fake(500, {}));
    const d1 = await ingestDocument(a.t, 'o', 'u', a.c, { title: 'a.pdf', contentBase64: text, contentType: 'application/pdf' });
    expect((await getDocument(a.t, 'o', a.c, d1.documentId))?.text).toMatch(/Forklift recertification/);
    __setDocAiDepsForTest(fake(200, { document: { documentLayout: { blocks: [] } } }));
    const d2 = await ingestDocument(a.t, 'o', 'u', a.c, { title: 'b.pdf', contentBase64: text, contentType: 'application/pdf' });
    expect((await getDocument(a.t, 'o', a.c, d2.documentId))?.text).toMatch(/Forklift recertification/);
  });
});
