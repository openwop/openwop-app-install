/**
 * RFC 0106 §B (ADR 0109 P1) — the `ctx.callTranscriber` deterministic-stub seam
 * over HTTP. Boots the real app via createApp and exercises the LOCKED
 * post-amendment shape (openwop#745) the gated `voice-transcription-streaming`
 * conformance scenario will drive:
 *   POST /host/sample/ai/call-transcriber  (and the app-canonical
 *        /host/openwop-app/ai/call-transcriber alias)
 *   body { audio: { streamRef } } → { finalText, atMs, language?, events: voice.* }
 *
 * Asserts: the host advertises aiProviders.realtimeVoice.transcription ===
 * "streaming"; the seam validates the audio source (400 invalid_request when
 * neither streamRef nor url); and under the test seam the mock path emits the
 * canonical voice.* taxonomy on the durable log (the C1 single-taxonomy path),
 * with voice.transcript carrying contentTrust:"untrusted" (RFC 0106 §F), and
 * resolves the Promise at voice.turn_commit with the settled finalText.
 *
 * Wave 61:
 *   - the 400 case asserts the ROUTE's own message. Without it, the adapter's
 *     exactly-one refusal answered the same 400 + code, so deleting the route
 *     guard stayed green (probe tsm-route-validate, vacuous).
 *   - HONEST CEILING (probe tsm-sample, vacuous, unpredicted): this file runs
 *     with `OPENWOP_TEST_SEAM_ENABLED` (the mock STT path needs it), and with the
 *     seam on, testSeam.ts's LEGACY rewrite (~:311) maps `/host/sample/*` onto
 *     `/host/openwop-app/*` BEFORE agents.ts's own `STT_SAMPLE` registration is
 *     reached. So "both prefixes" here proves the sample path is served (through
 *     the rewrite), not that line. The `STT_SAMPLE` registration itself is
 *     reached only with the seam OFF, and is witnessed by
 *     transcriber-tenant-isolation.test.ts (probe tsm-sample-r2 is aimed there).
 *   - the taxonomy is asserted as the exact ordered sequence, not first/last.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { errorCodeOf } from './helpers/errorEnvelope.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_VOICE_MOCK = 'true'; // route to the deterministic mock STT path (own flag, not the seam)
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_VOICE_MOCK;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  await new Promise<void>((res) => server.close(() => res()));
});

const APP_PATH = '/host/openwop-app/ai/call-transcriber';
const SAMPLE_PATH = '/host/sample/ai/call-transcriber';
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

type VoiceEvent = { type: string; payload: Record<string, unknown> };
// The seam response IS the settled TranscriptResult at the TOP LEVEL, with the
// voice.* run-events alongside (the shape the gated conformance scenarios read).
type SeamOk = { finalText: string; atMs: number; language?: string; events: VoiceEvent[] };

describe('RFC 0106 §B — real-time voice transcriber seam (ADR 0109 P1)', () => {
  // ADR 0812 P3c-0 — the v1-document advert leg (`aiProviders.realtimeVoice.transcription`)
  // was deleted: v2's `realtimeVoice` seat is unfilled here (whd7-v2-projection-parity KNOWN_UNPROJECTED).

  it('400s (invalid_request) when neither audio.streamRef nor audio.url is supplied', async () => {
    const res = await post(APP_PATH, { audio: {} });
    expect(res.status).toBe(400);
    const body = await res.json() as { message?: unknown };
    expect(errorCodeOf(body)).toBe('invalid_request');
    // The ROUTE's guard answered — not the adapter's later exactly-one refusal,
    // which carries the same status and code.
    expect(body.message).toBe('audio.streamRef OR audio.url (non-empty string) required');
  });

  it('is wired under BOTH path prefixes (not 404)', async () => {
    for (const path of [APP_PATH, SAMPLE_PATH]) {
      const res = await post(path, { audio: { streamRef: 'stream:test/mic' } });
      expect(res.status, path).toBe(200);
      expect((await res.json() as SeamOk).finalText, path).toBe('book a table for two');
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
    expect(events.map((e) => e.type)).toEqual([
      'voice.speech_start',
      'voice.transcript',
      'voice.transcript',
      'voice.endpoint_candidate',
      'voice.transcript',
      'voice.turn_commit',
    ]);

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
