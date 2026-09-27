/**
 * `identity.md` §5 — EVERY run id on the major-2 wire is tenant-bound, and the
 * SSE stream is a wire.
 *
 * Found 2026-09-05 from a peer host's live witness (myndhyve-1 `efcf`): bodies
 * written via `res.write`/`res.end` never pass the `res.json` projection wrapper
 * (`middleware/protocolVersion.ts installV2ResponseHygiene`). On this host
 * `routes/streams.ts` has NO `res.json` body — three `res.write` sites, all
 * `JSON.stringify(ev)`. Under major 2 the stream routes every frame through the
 * era seat, which translates TYPES and projects the OWNER echo but never the
 * RUN ID, so every major-2 SSE frame carried the bare storage id while the
 * JSON poll of the same run carried `default/<id>`. No `v2-*` conformance
 * scenario covers SSE (there is none), which is why 55/56 green hid it.
 *
 * Three legs, disjoint under the obvious sabotages: a projector applied only
 * to the single-frame path passes leg 1 and fails leg 2 (batch); a projector
 * applied unconditionally passes both and fails leg 3 (major 1 must be the
 * bare id — same bytes as before).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

const TOKEN = 'dev-token';
let server: http.Server;
let base = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function createRunV1(): Promise<string> {
  const res = await fetch(`${base}/v1/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }),
  });
  expect(res.status, 'v1 create').toBe(201);
  const j = (await res.json()) as { runId: string };
  // Let the noop run reach its terminal event so the replay carries run.completed.
  for (let i = 0; i < 50; i++) {
    const s = await fetch(`${base}/v1/runs/${j.runId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const snap = (await s.json()) as { status: string };
    if (snap.status === 'completed' || snap.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return j.runId;
}

/** Read SSE frames until a frame whose data has a terminal type, then abort. */
async function readFrames(path: string, headers: Record<string, string>): Promise<Array<{ event?: string; data: unknown }>> {
  const ac = new AbortController();
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream', ...headers },
    signal: ac.signal,
  });
  expect(res.status, `SSE open ${path}`).toBe(200);
  expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames: Array<{ event?: string; data: unknown }> = [];
  const deadline = Date.now() + 5_000;
  outer: while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const ev = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (data === undefined) continue; // heartbeat / comment
      const parsed = JSON.parse(data) as unknown;
      frames.push({ event: ev, data: parsed });
      const items = Array.isArray(parsed) ? parsed : [parsed];
      if (items.some((e) => typeof e === 'object' && e !== null && /^run\.(completed|failed|cancelled)$/.test(String((e as { type?: string }).type)))) break outer;
    }
  }
  ac.abort();
  return frames;
}

function runIdsIn(frames: Array<{ data: unknown }>): string[] {
  const out: string[] = [];
  for (const f of frames) {
    const items = Array.isArray(f.data) ? f.data : [f.data];
    for (const e of items) {
      const id = (e as { runId?: unknown }).runId;
      if (typeof id === 'string') out.push(id);
    }
  }
  return out;
}

describe('SSE frames carry the tenant-bound run id under major 2', () => {
  it('single-frame path: every data frame runId is `default/<id>` (the leg that was broken)', async () => {
    const bare = await createRunV1();
    const frames = await readFrames(`/runs/${bare}/events`, { 'OpenWOP-Version': '2' });
    const ids = runIdsIn(frames);
    expect(ids.length, 'non-vacuous: frames with a runId were read').toBeGreaterThan(0);
    expect(new Set(ids), 'every frame bound').toEqual(new Set([`default/${bare}`]));
  });

  it('batch path (?bufferMs): every element of the batch array is bound', async () => {
    const bare = await createRunV1();
    const frames = await readFrames(`/runs/${bare}/events?bufferMs=30`, { 'OpenWOP-Version': '2' });
    const batches = frames.filter((f) => f.event === 'batch');
    expect(batches.length, 'non-vacuous: at least one batch frame').toBeGreaterThan(0);
    const ids = runIdsIn(batches);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([`default/${bare}`]));
  });

  it('major 1 is untouched: frames carry the bare id (same bytes as before)', async () => {
    const bare = await createRunV1();
    const frames = await readFrames(`/v1/runs/${bare}/events`, {});
    const ids = runIdsIn(frames);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([bare]));
  });
});
