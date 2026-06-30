/**
 * RFC 0106 §C (ADR 0109 P3) — the streaming arm of `callSpeechSynthesizer`
 * over the speech-synth seam. Boots the real app and exercises the LOCKED
 * post-amendment shape (openwop#745): `callSpeechSynthesizer({ stream:true })`
 * resolves the whole-file Promise AND emits `voice.synthesis_chunk` METADATA-ONLY
 * run-events (seq / mimeType / durationMs / url — bytes off the log, the C2/G8
 * budget rule). Asserts:
 *   - the host advertises aiProviders.realtimeVoice.synthesis === "streaming";
 *   - stream:true → 200 with the audio result + voice.synthesis_chunk events that
 *     carry a url and NO inline base64;
 *   - the no-stream call is byte-for-byte the RFC 0105 roundtrip (no events).
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
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // deterministic mock TTS path
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

const PATH = '/v1/host/openwop-app/ai/call-speech-synthesizer';
const post = (body: unknown) => fetch(`${BASE}${PATH}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

type Chunk = { type: string; payload: Record<string, unknown> };

describe('RFC 0106 §C — streaming synthesis arm (ADR 0109 P3)', () => {
  it('advertises aiProviders.realtimeVoice.synthesis === "streaming"', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      aiProviders?: { realtimeVoice?: { synthesis?: unknown }; speechSynthesis?: unknown };
    };
    expect(doc.aiProviders?.realtimeVoice?.synthesis).toBe('streaming');
    // §C closure: synthesis streaming requires speechSynthesis supported.
    expect(doc.aiProviders?.speechSynthesis).toBe('supported');
  });

  it('stream:true → resolves the whole-file result AND emits voice.synthesis_chunk metadata-only', async () => {
    const res = await post({ text: 'Welcome to the weekly digest.', voiceId: 'host:narrator', stream: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { audio?: { url?: string }; events?: Chunk[] };
    // Promise still resolves with the finished asset.
    expect(typeof body.audio?.url).toBe('string');
    // ... and the streaming chunks were emitted on the durable log.
    const chunks = (body.events ?? []).filter((e) => e.type === 'voice.synthesis_chunk');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) {
      expect(typeof c.payload.seq).toBe('number');
      expect(typeof c.payload.mimeType).toBe('string');
      expect(typeof c.payload.url).toBe('string');     // metadata references the asset url
      expect(c.payload.base64).toBeUndefined();         // METADATA-ONLY — no inline bytes on the log
    }
  });

  it('no stream → unchanged RFC 0105 whole-file result (no events attached)', async () => {
    const res = await post({ text: 'plain', voiceId: 'host:narrator' });
    expect(res.status).toBe(200);
    const body = await res.json() as { audio?: { url?: string }; events?: unknown };
    expect(typeof body.audio?.url).toBe('string');
    expect(body.events).toBeUndefined();
  });
});
