/**
 * ADR 0897 / RFC 0247 — a bounded close on the WIRE streams, through the real
 * route and executor.
 *
 * Cloud Run over HTTP/1.1 never tells the container a client left, so a stream
 * the server does not end holds its cap slot until the platform's request
 * timeout (MEASURED 2026-10-15: 3601 s for a 20 s client). `events.md` holds a
 * live run's stream open, so the host may end one early ONLY for a consumer that
 * sent `resumable=true` — and that consumer must lose nothing on resume.
 *
 * Pinned here, on a run suspended at an approval gate (live, quiet):
 *   1. opted in: the server ends the stream before the terminal event, after a
 *      `retry:` field, at a frame boundary;
 *   2. resuming with `Last-Event-ID` delivers exactly the events after it —
 *      including one appended while no stream was open;
 *   3. not opted in: the stream is held open past the bound (the MUST holds);
 *   4. a pending `bufferMs` batch flushes on the bounded close.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { bareRunId } from './support/bareRunId.js';
import { resetRfc0247WireCache } from '../src/host/streamAgeCapability.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
/** Short enough to keep the suite fast; jitter takes it to 360–400 ms. */
const MAX_AGE_MS = 400;

beforeAll(async () => {
  // Advertised (as once the vendored schema carries the facet), with the 15 s
  // floor lowered so each case does not wait 15 s.
  resetRfc0247WireCache(true, 100);
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { resetRfc0247WireCache(); await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { delete process.env.OPENWOP_SSE_MAX_AGE_MS; });

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function suspendedRun(): Promise<string> {
  const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-approval' }) });
  expect(create.status).toBe(201);
  const runId = create.body.runId;
  for (let i = 0; i < 200; i++) {
    const { body } = await api<{ status: string }>(`/runs/${runId}`);
    if (body.status === 'waiting-approval') return runId;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('run never suspended');
}

async function appendMarker(runId: string): Promise<number> {
  return (await getEventLog().append({ runId: bareRunId(runId), type: 'log.message', payload: { message: 'adr0897 marker' } })).sequence;
}

interface Read { raw: string; ids: number[]; batchIds: number[]; serverClosed: boolean; elapsedMs: number }

/** Read one stream until the server ends it or `windowMs` passes. */
async function readStream(runId: string, opts: { query?: string; lastEventId?: number; windowMs: number; onOpen?: () => Promise<void> }): Promise<Read> {
  const ac = new AbortController();
  const started = Date.now();
  const headers: Record<string, string> = { ...H, accept: 'text/event-stream' };
  if (opts.lastEventId !== undefined) headers['last-event-id'] = String(opts.lastEventId);
  const res = await fetch(`${BASE}/runs/${runId}/events${opts.query ? `?${opts.query}` : ''}`, { headers, signal: ac.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let serverClosed = false;
  const timer = setTimeout(() => ac.abort(), opts.windowMs);
  if (opts.onOpen) await opts.onOpen();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { serverClosed = true; break; }
      raw += decoder.decode(value, { stream: true });
    }
  } catch { /* aborted by the window */ } finally { clearTimeout(timer); }
  const ids: number[] = [];
  const batchIds: number[] = [];
  for (const block of raw.split('\n\n')) {
    if (/^event: batch$/m.test(block)) {
      const data = /^data: (.*)$/m.exec(block)![1]!;
      for (const ev of JSON.parse(data) as Array<{ sequence: number }>) batchIds.push(ev.sequence);
      continue;
    }
    const id = /^id: (\d+)$/m.exec(block);
    if (id) ids.push(Number(id[1]));
  }
  return { raw, ids, batchIds, serverClosed, elapsedMs: Date.now() - started };
}

describe('ADR 0897 / RFC 0247 — bounded close on /runs/{id}/events', () => {
  it('an opted-in stream ends early with retry:, and Last-Event-ID resumes with no gap and no duplicate', async () => {
    process.env.OPENWOP_SSE_MAX_AGE_MS = String(MAX_AGE_MS);
    const runId = await suspendedRun();

    const first = await readStream(runId, { query: 'resumable=true', windowMs: 3_000 });
    expect(first.serverClosed, 'the host ends an opted-in live stream').toBe(true);
    expect(first.elapsedMs).toBeLessThan(2_000);
    expect(first.raw).not.toMatch(/event: run\.(completed|failed|cancelled)/);
    expect(first.raw.endsWith('retry: 1000\n\n'), 'the last thing written is the retry: hint, at a frame boundary').toBe(true);
    expect(first.ids.length).toBeGreaterThan(0);
    const last = Math.max(...first.ids);

    // An event lands while no stream is open; the resume must carry it.
    const marker = await appendMarker(runId);
    const second = await readStream(runId, { query: 'resumable=true', lastEventId: last, windowMs: 3_000 });
    expect(second.serverClosed).toBe(true);
    expect(second.ids).toEqual([marker]);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(first.ids.length + second.ids.length);
    await api(`/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
  });

  it('a stream that did not opt in is held open past the bound', async () => {
    process.env.OPENWOP_SSE_MAX_AGE_MS = String(MAX_AGE_MS);
    const runId = await suspendedRun();
    const read = await readStream(runId, { windowMs: MAX_AGE_MS * 3 });
    expect(read.serverClosed, 'events.md: the host MUST hold a live run open').toBe(false);
    await api(`/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
  });

  it('discovery advertises limits.maxStreamAgeSec from the same predicate, and drops it when the host does not bound', async () => {
    process.env.OPENWOP_SSE_MAX_AGE_MS = '300000';
    const on = await api<{ limits?: Record<string, unknown> }>('/.well-known/openwop');
    expect(on.body.limits?.maxStreamAgeSec).toBe(300);
    resetRfc0247WireCache(false);
    try {
      const off = await api<{ limits?: Record<string, unknown> }>('/.well-known/openwop');
      expect(off.body.limits).toBeDefined();
      expect(off.body.limits).not.toHaveProperty('maxStreamAgeSec');
    } finally { resetRfc0247WireCache(true, 100); }
  });

  it('a pending bufferMs batch flushes on the bounded close', async () => {
    process.env.OPENWOP_SSE_MAX_AGE_MS = String(MAX_AGE_MS);
    const runId = await suspendedRun();
    let marker = -1;
    // bufferMs 5000 outlasts the bound, so only the close can flush the marker.
    const read = await readStream(runId, {
      query: 'resumable=true&bufferMs=5000',
      windowMs: 3_000,
      onOpen: async () => { await new Promise((r) => setTimeout(r, 100)); marker = await appendMarker(runId); },
    });
    expect(read.serverClosed).toBe(true);
    expect(read.batchIds).toContain(marker);
    expect(read.raw.endsWith('retry: 1000\n\n'), 'the batch flushes before the retry: hint').toBe(true);
    await api(`/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
  });
});
