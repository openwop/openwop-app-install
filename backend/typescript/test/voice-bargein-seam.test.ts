/**
 * RFC 0106 §D/§F (ADR 0109 P4) — the barge-in / cancellation seam. Boots the real
 * app and drives the `voice.barge_in` → `voice.cancelled` lifecycle the
 * `realtimeVoice.bargeIn` capability promises. Asserts:
 *   - the host advertises realtimeVoice.turnDetection === "semantic" (callTranscriber
 *     emits endpoint_candidate distinct from turn_commit) + bargeIn === "supported";
 *   - a barge-in mid-playback emits voice.barge_in then a DISTINCT voice.cancelled;
 *   - §F `voice-bargein-no-partial-leak`: NO voice.synthesis_chunk is emitted after
 *     voice.cancelled — the in-flight synthesis is halted, not leaked.
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

const APP_PATH = '/v1/host/openwop-app/voice/barge-in';
const SAMPLE_PATH = '/v1/host/sample/voice/barge-in';
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

type Ev = { type: string; payload: Record<string, unknown> };

describe('RFC 0106 §D/§F — barge-in lifecycle (ADR 0109 P4)', () => {
  it('advertises realtimeVoice.turnDetection === "semantic" + bargeIn === "supported"', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      aiProviders?: { realtimeVoice?: { turnDetection?: unknown; bargeIn?: unknown } };
    };
    expect(doc.aiProviders?.realtimeVoice?.turnDetection).toBe('semantic');
    expect(doc.aiProviders?.realtimeVoice?.bargeIn).toBe('supported');
  });

  it('is mounted under BOTH path prefixes', async () => {
    for (const p of [APP_PATH, SAMPLE_PATH]) {
      const res = await post(p, { chunks: 4, bargeInAtSeq: 1 });
      expect(res.status).toBe(200);
    }
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
    expect(droppedChunks).toBeGreaterThan(0);
    // Exactly the chunks up to the barge-in point played (seq 0 and 1).
    expect(types.filter((t) => t === 'voice.synthesis_chunk')).toHaveLength(2);
  });
});
