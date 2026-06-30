/**
 * RFC 0105 — the `speech-synthesis-roundtrip` conformance seam over HTTP. Boots
 * the real app via createApp and exercises the LOCKED seam the published
 * `@openwop/openwop-conformance` suite drives:
 *   POST /v1/host/sample/ai/call-speech-synthesizer   (and the app-canonical
 *        /v1/host/openwop-app/ai/call-speech-synthesizer alias)
 *   body { text, voiceId } → { audio: { url XOR base64, mimeType, voiceId }, ... }
 *
 * Asserts: the host advertises aiProviders.speechSynthesis === "supported" with
 * minimax in supported[]; the seam validates text/voiceId (400 invalid_request);
 * and the seam is wired to the real ctx.callSpeechSynthesizer adapter (NOT a
 * 404, NOT a stub) under BOTH path prefixes. A live 200-with-audio roundtrip
 * runs against a deployed rev that has the managed MiniMax key; CI (no key)
 * deterministically exercises the validation + wiring contract.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const APP_PATH = '/v1/host/openwop-app/ai/call-speech-synthesizer';
const SAMPLE_PATH = '/v1/host/sample/ai/call-speech-synthesizer';
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('RFC 0105 — speech-synthesis seam', () => {
  it('advertises aiProviders.speechSynthesis === "supported" with minimax in supported[]', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      aiProviders?: { speechSynthesis?: unknown; supported?: string[] };
    };
    expect(doc.aiProviders?.speechSynthesis).toBe('supported');
    expect(doc.aiProviders?.supported ?? []).toContain('minimax');
  });

  it('400s (invalid_request) on missing text', async () => {
    const res = await post(APP_PATH, { voiceId: 'male-qn-qingse' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe('invalid_request');
  });

  it('400s (invalid_request) on missing voiceId', async () => {
    const res = await post(APP_PATH, { text: 'hello' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe('invalid_request');
  });

  it('is wired to the real adapter under BOTH path prefixes (not 404, not a stub)', async () => {
    // With a valid request the seam reaches ctx.callSpeechSynthesizer. In CI no
    // managed MiniMax key is seeded, so the managed path returns
    // speech_synthesis_unsupported (400) — proving the seam calls the real
    // adapter rather than serving a canned 200. A deployed rev WITH the key
    // returns 200 + audio. Either way it must NOT be 404 (seam registered).
    for (const path of [APP_PATH, SAMPLE_PATH]) {
      const res = await post(path, { text: 'OpenWOP RFC 0105 witness.', voiceId: 'male-qn-qingse' });
      expect(res.status).not.toBe(404);
      if (res.status === 200) {
        const body = await res.json() as { audio?: { mimeType?: string; voiceId?: string; url?: string; base64?: string } };
        expect(body.audio?.voiceId).toBe('male-qn-qingse');
        expect(typeof body.audio?.mimeType).toBe('string');
        expect(Boolean(body.audio?.url) !== Boolean(body.audio?.base64)).toBe(true); // exactly one
      } else {
        expect(res.status).toBe(400);
        expect((await res.json() as { error?: { code?: string } }).error?.code).toBe('speech_synthesis_unsupported');
      }
    }
  });

  it('ADR 0106 — rejects with media_budget_exceeded when the per-org TTS budget is exhausted (before dispatch)', async () => {
    // A tiny daily TTS budget; the budget check runs BEFORE provider resolution,
    // so this fires regardless of whether a managed key is configured.
    process.env.OPENWOP_MEDIA_DAILY_TTS_CHARS = '5';
    try {
      const res = await post(APP_PATH, { text: 'this text is well over five characters', voiceId: 'male-qn-qingse' });
      expect(res.status).toBe(429); // quota/budget — not 502 (provider outage), not 200
      const body = await res.json() as { error?: { code?: string; details?: { kind?: string; cap?: number } } };
      expect(body.error?.code).toBe('media_budget_exceeded');
      expect(body.error?.details?.kind).toBe('tts');
      expect(body.error?.details?.cap).toBe(5);
    } finally {
      delete process.env.OPENWOP_MEDIA_DAILY_TTS_CHARS;
    }
  });
});
