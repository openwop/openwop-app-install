/**
 * RFC 0106 §D/§F (ADR 0109 P4) — the barge-in / cancellation seam. Boots the real
 * app and drives the `voice.barge_in` → `voice.cancelled` lifecycle the
 * `realtimeVoice.bargeIn` capability promises. Asserts:
 *   - (the v1 advert leg — realtimeVoice.turnDetection/bargeIn — was deleted with
 *     the v1 document, ADR 0812 P3c-0; nothing here asserts an advertisement);
 *   - the seam answers identically at the vendor and the sample address;
 *   - a barge-in mid-playback emits voice.barge_in then a DISTINCT voice.cancelled;
 *   - §F `voice-bargein-no-partial-leak`: NO voice.synthesis_chunk is emitted after
 *     voice.cancelled — the in-flight synthesis is halted, not leaked.
 *
 * Witnessed (8f W4): vb-chunks-leak, vb-no-cancel, vb-sample-unmounted,
 * vb-dropped-miscount-r2.
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const APP_PATH = '/host/openwop-app/voice/barge-in';
const SAMPLE_PATH = '/host/sample/voice/barge-in';
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

type Ev = { type: string; payload: Record<string, unknown> };

describe('RFC 0106 §D/§F — barge-in lifecycle (ADR 0109 P4)', () => {
  // ADR 0812 P3c-0 — the v1-document advert leg (`realtimeVoice.turnDetection` / `bargeIn`)
  // was deleted: v2's `realtimeVoice` seat is unfilled here (whd7-v2-projection-parity KNOWN_UNPROJECTED).

  it('is mounted under BOTH path prefixes', async () => {
    // Same handler at both addresses: same status AND the same lifecycle.
    const bodies: string[][] = [];
    for (const p of [APP_PATH, SAMPLE_PATH]) {
      const res = await post(p, { chunks: 4, bargeInAtSeq: 1 });
      expect(res.status, p).toBe(200);
      bodies.push(((await res.json()) as { events: Ev[] }).events.map((e) => e.type));
    }
    expect(bodies[0]).toContain('voice.cancelled');
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it('emits voice.barge_in then a distinct voice.cancelled, with NO synthesis_chunk after cancel (§F)', async () => {
    const res = await post(APP_PATH, { chunks: 4, bargeInAtSeq: 1 });
    expect(res.status).toBe(200);
    const { events, droppedChunks } = await res.json() as { events: Ev[]; droppedChunks: number };
    const types = events.map((e) => e.type);

    // barge_in precedes cancelled, and they are distinct events.
    const bargeIdx = types.indexOf('voice.barge_in');
    const cancelIdx = types.indexOf('voice.cancelled');
    expect(bargeIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeGreaterThan(bargeIdx);

    // §F voice-bargein-no-partial-leak: no synthesis_chunk after the cancel.
    const lastChunkIdx = types.lastIndexOf('voice.synthesis_chunk');
    expect(lastChunkIdx).toBeLessThan(cancelIdx);

    // The in-flight synthesis was genuinely halted (chunks were dropped, not leaked).
    // Exactly the two chunks after seq 1 of 4 (seq 2 and 3): `> 0` could not tell
    // a miscount from the truth (8f W4 probe vb-dropped-miscount, vacuous).
    expect(droppedChunks).toBe(2);
    // Exactly the chunks up to the barge-in point played (seq 0 and 1).
    expect(types.filter((t) => t === 'voice.synthesis_chunk')).toHaveLength(2);
  });
});
