/**
 * Media → text END-TO-END (ADR 0108 + 0110) — runs the REAL stack and mocks ONLY the
 * network. ingestDocument → extractTextFromBytes → mediaToTextViaLLM → resolveHeadlessAi
 * (real BYOK default) → the real closure → dispatchChat → dispatchGoogle (real request
 * builder + SSE parser); only the Gemini HTTP call is intercepted. Proves the image/audio
 * bytes actually reach the provider as multimodal `inlineData`, the response flows back into
 * the KB document, the binary-upload trust fence holds, and the no-provider path 422s.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setSecret, clearAllSecrets } from '../src/byok/secretResolver.js';
import { setHeadlessAiDefault, clearHeadlessAiDefault } from '../src/host/headlessAi.js';
import { createCollection, ingestDocument, getDocument } from '../src/features/kb/kbService.js';

const NOW = '2026-06-23T00:00:00.000Z';
const T = 'tnt:e2e';
const ORG = 'org:e2e';

interface GeminiPart { text?: string; inlineData?: { mimeType: string; data: string } }
interface GeminiBody { contents: Array<{ role: string; parts: GeminiPart[] }> }

const realFetch = global.fetch;
let lastGoogleBody: GeminiBody | null = null;

/** A minimal SSE response Gemini's stream parser accepts (one candidate text part). */
function sseResponse(text: string): Response {
  const data = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
  return new Response(`data: ${data}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function setGoogleDefault(): Promise<void> {
  await setSecret('gem', 'GEMINI-KEY', { tenantId: T });
  await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem' }, NOW);
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-e2e-')) });
});
beforeEach(async () => {
  process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
  process.env.OPENWOP_KB_OCR_ENABLED = 'true';
  process.env.OPENWOP_KB_TRANSCRIBE_ENABLED = 'true';
  await clearAllSecrets();
  await clearHeadlessAiDefault(T);
  lastGoogleBody = null;
  const mock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('generativelanguage.googleapis.com')) {
      lastGoogleBody = JSON.parse(String(init?.body)) as GeminiBody;
      return sseResponse('INVOICE TOTAL 4242 USD');
    }
    return realFetch(input, init);
  });
  global.fetch = mock as typeof fetch;
});
afterEach(() => { global.fetch = realFetch; });
afterAll(async () => {
  await clearAllSecrets();
  delete process.env.OPENWOP_BYOK_EPHEMERAL;
  delete process.env.OPENWOP_KB_OCR_ENABLED;
  delete process.env.OPENWOP_KB_TRANSCRIBE_ENABLED;
});

describe('media → text end-to-end (real stack, only the network mocked)', () => {
  it('image OCR: ingest → BYOK google → real dispatchGoogle → KB doc; image sent as inlineData; untrusted', async () => {
    await setGoogleDefault();
    const col = await createCollection(T, ORG, 'tester', { name: 'E2Eimg' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const doc = await ingestDocument(T, ORG, 'tester', col.collectionId, {
      title: 'scan.png', contentBase64: png.toString('base64'), contentType: 'image/png',
    });
    const full = await getDocument(T, ORG, col.collectionId, doc.documentId);
    // the OCR text flowed all the way back into the durable doc
    expect(full?.text).toContain('INVOICE TOTAL 4242 USD');
    // binary-upload hardening held end-to-end
    expect(full?.contentTrust).toBe('untrusted');
    // the REAL provider request carried the exact image as inlineData (the wiring works)
    const img = (lastGoogleBody?.contents[0]?.parts ?? []).find((p) => p.inlineData);
    expect(img?.inlineData?.mimeType).toBe('image/png');
    expect(img?.inlineData?.data).toBe(png.toString('base64'));
  });

  it('audio transcription: ingest mp3 → real dispatchGoogle audio inlineData → transcript in the doc', async () => {
    await setGoogleDefault();
    const col = await createCollection(T, ORG, 'tester', { name: 'E2Eaud' });
    const mp3 = Buffer.from('ID3-fake-audio-bytes');
    const doc = await ingestDocument(T, ORG, 'tester', col.collectionId, {
      title: 'memo.mp3', contentBase64: mp3.toString('base64'), contentType: 'audio/mpeg',
    });
    const full = await getDocument(T, ORG, col.collectionId, doc.documentId);
    expect(full?.text).toContain('INVOICE TOTAL 4242 USD'); // the canned transcript
    const aud = (lastGoogleBody?.contents[0]?.parts ?? []).find((p) => p.inlineData);
    expect(aud?.inlineData?.mimeType).toBe('audio/mpeg');
    expect(aud?.inlineData?.data).toBe(mp3.toString('base64'));
  });

  it('no BYOK default configured → honest 422 (managed MiniMax cannot do vision) — no network call', async () => {
    const col = await createCollection(T, ORG, 'tester', { name: 'E2Eno' });
    await expect(ingestDocument(T, ORG, 'tester', col.collectionId, {
      title: 's.png', contentBase64: Buffer.from([1, 2, 3, 4]).toString('base64'), contentType: 'image/png',
    })).rejects.toMatchObject({ httpStatus: 422 });
  });
});
