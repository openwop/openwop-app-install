/**
 * KB file upload + extraction — bytes → extracted text → ingested document.
 * Round-trips a real PDF (pdfkit writes it, `unpdf` extracts it) through
 * `ingestDocument({ contentBase64, contentType })`, plus the text/* path and the
 * unsupported-MIME 415. Proves the parsers work at runtime (not just typecheck).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import PDFDocument from 'pdfkit';
// Media → text resolves a headless dispatch (ADR 0110) — mock the resolver to return a
// closure that yields a canned extraction (no real provider call) AND captures the dispatch
// opts (so we can assert the per-modality maxTokens / timeout — ADR 0111 review fix).
const cap = vi.hoisted(() => ({ opts: null as { maxTokens: number; timeoutMs?: number } | null }));
vi.mock('../src/host/headlessAi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/host/headlessAi.js')>('../src/host/headlessAi.js');
  return { ...actual, resolveHeadlessAi: vi.fn(async () => async (_m: unknown, opts: { maxTokens: number; timeoutMs?: number }) => { cap.opts = opts; return 'INVOICE TOTAL 4242 USD'; }) };
});
import { resolveHeadlessAi } from '../src/host/headlessAi.js';
// Budget hooks mocked so the audio path is testable without governance/storage wiring.
vi.mock('../src/aiProviders/mediaBudget.js', async () => {
  const actual = await vi.importActual<typeof import('../src/aiProviders/mediaBudget.js')>('../src/aiProviders/mediaBudget.js');
  return { ...actual, checkMediaBudget: vi.fn(async () => ({ exceeded: false, cap: 0, used: 0 })), recordMediaUsage: vi.fn(async () => undefined) };
});
import { checkMediaBudget, recordMediaUsage } from '../src/aiProviders/mediaBudget.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createCollection, ingestDocument, getDocument } from '../src/features/kb/kbService.js';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbup-')) });
});

/** Render a one-line PDF to a Buffer via pdfkit (already a dep). */
function makePdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.text(text);
    doc.end();
  });
}

const TENANT = 'kbup-t';
const ORG = 'kbup-org';

describe('KB file upload — extraction', () => {
  it('extracts text from an uploaded PDF and ingests it', async () => {
    const col = await createCollection(TENANT, ORG, 'tester', { name: 'Uploads' });
    const pdf = await makePdf('The quarterly revenue grew forty percent.');
    const doc = await ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
      title: 'Q.pdf',
      contentBase64: pdf.toString('base64'),
      contentType: 'application/pdf',
    });
    expect(doc.title).toBe('Q.pdf');
    expect(doc.chunkCount).toBeGreaterThan(0);
    const full = await getDocument(TENANT, ORG, col.collectionId, doc.documentId);
    expect(full?.text.toLowerCase()).toContain('quarterly revenue grew forty percent');
    // Hardening (ADR 0108 review): file-extracted content is fenced UNTRUSTED — even a
    // manual upload, since hidden/adversarial text in the binary was never human-reviewed.
    expect(full?.contentTrust).toBe('untrusted');
  });

  it('fences ALL file uploads untrusted but keeps PASTED text trusted', async () => {
    const col = await createCollection(TENANT, ORG, 'tester', { name: 'TrustPolicy' });
    // pasted text → trusted (the human typed/reviewed it)
    const pasted = await ingestDocument(TENANT, ORG, 'tester', col.collectionId, { title: 'note', text: 'A reviewed note.' });
    expect((await getDocument(TENANT, ORG, col.collectionId, pasted.documentId))?.contentTrust).toBe('trusted');
    // an uploaded file, even a .txt, → untrusted (the security boundary is "extracted ≠ reviewed")
    const uploaded = await ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
      title: 'f.txt', contentBase64: Buffer.from('uploaded body', 'utf8').toString('base64'), contentType: 'text/plain',
    });
    expect((await getDocument(TENANT, ORG, col.collectionId, uploaded.documentId))?.contentTrust).toBe('untrusted');
    // an explicit contentTrust:'trusted' on a file upload is IGNORED (can't override the fence)
    const forced = await ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
      title: 'g.txt', contentBase64: Buffer.from('forced', 'utf8').toString('base64'), contentType: 'text/plain', contentTrust: 'trusted',
    });
    expect((await getDocument(TENANT, ORG, col.collectionId, forced.documentId))?.contentTrust).toBe('untrusted');
  });

  it('ingests a text/* upload directly (no parser)', async () => {
    const col = await createCollection(TENANT, ORG, 'tester', { name: 'Uploads2' });
    const doc = await ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
      title: 'notes.md',
      contentBase64: Buffer.from('# Heading\nplain markdown body', 'utf8').toString('base64'),
      contentType: 'text/markdown',
    });
    const full = await getDocument(TENANT, ORG, col.collectionId, doc.documentId);
    expect(full?.text).toContain('plain markdown body');
  });

  it('rejects an oversize upload (413) before decoding/parsing', async () => {
    const col = await createCollection(TENANT, ORG, 'tester', { name: 'Uploads4' });
    const big = 'A'.repeat(45_000_000); // > 32 MiB decoded; valid base64 charset + length % 4 === 0
    await expect(ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
      title: 'big.pdf', contentBase64: big, contentType: 'application/pdf',
    })).rejects.toMatchObject({ httpStatus: 413 });
  });

  it('rejects an unsupported binary MIME with 415', async () => {
    const col = await createCollection(TENANT, ORG, 'tester', { name: 'Uploads3' });
    await expect(ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
      title: 'x.bin',
      contentBase64: Buffer.from([0, 1, 2, 3]).toString('base64'),
      contentType: 'application/octet-stream',
    })).rejects.toMatchObject({ httpStatus: 415 });
  });

  // ── officeparser formats (PPTX / XLSX / ODF / RTF) ───────────────────────────

  it('extracts text from an RTF upload via officeparser (real round-trip)', async () => {
    const col = await createCollection(TENANT, ORG, 'tester', { name: 'UploadsRTF' });
    // RTF is text-constructable, so this is a REAL officeparser extraction (not a mock).
    const rtf = Buffer.from('{\\rtf1\\ansi\\deff0 The acquisition closed in March twenty twenty six.}');
    const doc = await ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
      title: 'deal.rtf', contentBase64: rtf.toString('base64'), contentType: 'application/rtf',
    });
    const full = await getDocument(TENANT, ORG, col.collectionId, doc.documentId);
    expect(full?.text.toLowerCase()).toContain('acquisition closed in march');
  });

  it('rejects a corrupt office file (right MIME, bad bytes) with 422 — that ingest fails, no crash', async () => {
    const col = await createCollection(TENANT, ORG, 'tester', { name: 'UploadsBad' });
    const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    await expect(ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
      title: 'broken.pptx', contentBase64: Buffer.from([1, 2, 3, 4, 5]).toString('base64'), contentType: PPTX,
    })).rejects.toMatchObject({ httpStatus: 422 });
  });

  // ── image OCR (env-gated) ────────────────────────────────────────────────────

  describe('image OCR', () => {
    afterEach(() => { delete process.env.OPENWOP_KB_OCR_ENABLED; });

    it('415s an image when OCR is NOT enabled (default)', async () => {
      const col = await createCollection(TENANT, ORG, 'tester', { name: 'OcrOff' });
      await expect(ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
        title: 'scan.png', contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), contentType: 'image/png',
      })).rejects.toMatchObject({ httpStatus: 415 });
    });

    it('OCRs an image into text when OPENWOP_KB_OCR_ENABLED=true', async () => {
      process.env.OPENWOP_KB_OCR_ENABLED = 'true';
      const col = await createCollection(TENANT, ORG, 'tester', { name: 'OcrOn' });
      const doc = await ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
        title: 'invoice.png', contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), contentType: 'image/png',
      });
      const full = await getDocument(TENANT, ORG, col.collectionId, doc.documentId);
      expect(full?.text).toContain('INVOICE TOTAL 4242 USD'); // the (mocked) OCR output
      // image OCR uses the modest 8k output budget + no special deadline (ADR 0111 review)
      expect(cap.opts).toMatchObject({ maxTokens: 8192 });
      expect(cap.opts?.timeoutMs).toBeUndefined();
    });

    it('422s when no capable AI provider is resolved (ADR 0110 — gate on, no default)', async () => {
      process.env.OPENWOP_KB_OCR_ENABLED = 'true';
      vi.mocked(resolveHeadlessAi).mockResolvedValueOnce(null); // no vision-capable provider
      const col = await createCollection(TENANT, ORG, 'tester', { name: 'OcrNoProvider' });
      await expect(ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
        title: 'scan.png', contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), contentType: 'image/png',
      })).rejects.toMatchObject({ httpStatus: 422 });
    });
  });

  describe('audio transcription (ADR 0108 Phase 2)', () => {
    afterEach(() => { delete process.env.OPENWOP_KB_TRANSCRIBE_ENABLED; vi.mocked(checkMediaBudget).mockClear(); vi.mocked(recordMediaUsage).mockClear(); });

    it('415s audio when transcription is NOT enabled (default)', async () => {
      const col = await createCollection(TENANT, ORG, 'tester', { name: 'SttOff' });
      await expect(ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
        title: 'memo.mp3', contentBase64: Buffer.from('ID3AUDIO').toString('base64'), contentType: 'audio/mpeg',
      })).rejects.toMatchObject({ httpStatus: 415 });
    });

    it('transcribes audio + meters the STT budget when OPENWOP_KB_TRANSCRIBE_ENABLED=true', async () => {
      process.env.OPENWOP_KB_TRANSCRIBE_ENABLED = 'true';
      const col = await createCollection(TENANT, ORG, 'tester', { name: 'SttOn' });
      const audio = Buffer.from('ID3AUDIOBYTES');
      const doc = await ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
        title: 'standup.mp3', contentBase64: audio.toString('base64'), contentType: 'audio/mpeg',
      });
      const full = await getDocument(TENANT, ORG, col.collectionId, doc.documentId);
      expect(full?.text).toContain('INVOICE TOTAL 4242 USD'); // the (mocked) transcript
      expect(vi.mocked(checkMediaBudget)).toHaveBeenCalledWith(TENANT, 'stt', audio.length); // pre-flight
      expect(vi.mocked(recordMediaUsage)).toHaveBeenCalledWith(TENANT, 'stt', audio.length); // recorded after success
      // ADR 0111 review fix: transcription gets the model's FULL output budget (not the 8k OCR
      // default — it truncated long transcripts) + a generous deadline (File-API path > 120s).
      expect(cap.opts?.maxTokens).toBe(65536);
      expect(cap.opts?.timeoutMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
    });

    it('429s when the STT budget is exceeded (no provider call)', async () => {
      process.env.OPENWOP_KB_TRANSCRIBE_ENABLED = 'true';
      vi.mocked(checkMediaBudget).mockResolvedValueOnce({ exceeded: true, cap: 1, used: 0 } as never);
      const col = await createCollection(TENANT, ORG, 'tester', { name: 'SttBudget' });
      await expect(ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
        title: 'big.mp3', contentBase64: Buffer.from('ID3AUDIO').toString('base64'), contentType: 'audio/mpeg',
      })).rejects.toMatchObject({ httpStatus: 429 });
      expect(vi.mocked(recordMediaUsage)).not.toHaveBeenCalled();
    });

    it('415s VIDEO even when transcription is enabled (extract the audio track first)', async () => {
      process.env.OPENWOP_KB_TRANSCRIBE_ENABLED = 'true';
      const col = await createCollection(TENANT, ORG, 'tester', { name: 'SttVideo' });
      await expect(ingestDocument(TENANT, ORG, 'tester', col.collectionId, {
        title: 'clip.mp4', contentBase64: Buffer.from('VIDEOBYTES').toString('base64'), contentType: 'video/mp4',
      })).rejects.toMatchObject({ httpStatus: 415 });
    });
  });
});
