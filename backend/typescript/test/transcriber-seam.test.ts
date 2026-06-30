/**
 * RFC 0106 §B (ADR 0109 P1) — the `ctx.callTranscriber` deterministic-stub seam
 * over HTTP. Boots the real app via createApp and exercises the LOCKED
 * post-amendment shape (openwop#745) the gated `voice-transcription-streaming`
 * conformance scenario will drive:
 *   POST /v1/host/sample/ai/call-transcriber  (and the app-canonical
 *        /v1/host/openwop-app/ai/call-transcriber alias)
 *   body { audio: { streamRef } } → { finalText, atMs, language?, events: voice.* }
 *
 * Asserts: the host advertises aiProviders.realtimeVoice.transcription ===
 * "streaming"; the seam validates the audio source (400 invalid_request when
 * neither streamRef nor url); and under the test seam the mock path emits the
 * canonical voice.* taxonomy on the durable log (the C1 single-taxonomy path),
 * with voice.transcript carrying contentTrust:"untrusted" (RFC 0106 §F), and
 * resolves the Promise at voice.turn_commit with the settled finalText.
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
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // route to the deterministic mock STT path
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

const APP_PATH = '/v1/host/openwop-app/ai/call-transcriber';
const SAMPLE_PATH = '/v1/host/sample/ai/call-transcriber';
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

type VoiceEvent = { type: string; payload: Record<string, unknown> };
// The seam response IS the settled TranscriptResult at the TOP LEVEL, with the
// voice.* run-events alongside (the shape the gated conformance scenarios read).
type SeamOk = { finalText: string; atMs: number; language?: string; events: VoiceEvent[] };

describe('RFC 0106 §B — real-time voice transcriber seam (ADR 0109 P1)', () => {
  it('advertises aiProviders.realtimeVoice.transcription === "streaming"', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      aiProviders?: { realtimeVoice?: { transcription?: unknown } };
    };
    expect(doc.aiProviders?.realtimeVoice?.transcription).toBe('streaming');
  });

  it('400s (invalid_request) when neither audio.streamRef nor audio.url is supplied', async () => {
    const res = await post(APP_PATH, { audio: {} });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe('invalid_request');
  });

  it('is wired under BOTH path prefixes (not 404)', async () => {
    for (const path of [APP_PATH, SAMPLE_PATH]) {
      const res = await post(path, { audio: { streamRef: 'stream:test/mic' } });
      expect(res.status).toBe(200);
    }
  });

  it('emits the canonical voice.* taxonomy + resolves at turn_commit (the C1 path)', async () => {
    const res = await post(APP_PATH, { audio: { streamRef: 'stream:test/mic' }, languageCode: 'en-US' });
    expect(res.status).toBe(200);
    const body = await res.json() as SeamOk;
    const events = body.events;

    // Promise resolves at turn_commit with the settled final transcript (top-level).
    expect(body.finalText).toBe('book a table for two');
    expect(body.atMs).toBe(1650);
    expect(body.language).toBe('en-US');

    // The single canonical taxonomy, in order, on the durable log.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('voice.speech_start');
    expect(types).toContain('voice.transcript');
    expect(types).toContain('voice.endpoint_candidate');
    expect(types[types.length - 1]).toBe('voice.turn_commit');

    // §F voice-transcript-untrusted: EVERY voice.transcript carries contentTrust:"untrusted".
    const transcripts = events.filter((e) => e.type === 'voice.transcript');
    expect(transcripts.length).toBeGreaterThanOrEqual(2);
    for (const t of transcripts) expect(t.payload.contentTrust).toBe('untrusted');

    // Interim → final settling: at least one isFinal:false, exactly one isFinal:true.
    expect(transcripts.some((t) => t.payload.isFinal === false)).toBe(true);
    expect(transcripts.filter((t) => t.payload.isFinal === true)).toHaveLength(1);

    // turn_commit finalText agrees with the resolved Promise.
    const commit = events.find((e) => e.type === 'voice.turn_commit');
    expect(commit?.payload.finalText).toBe('book a table for two');
  });
});
