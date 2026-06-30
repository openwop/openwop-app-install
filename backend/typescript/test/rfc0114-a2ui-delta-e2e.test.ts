/**
 * RFC 0114 — end-to-end A2UI delta transport witness (the non-vacuous proof).
 * Drives the REAL §15 emit-surface seam + REAL acceptEnvelope catalog gate +
 * REAL streams.ts ?a2uiDelta=1 transport: emit two surfaces for a run, then read
 * the events stream with ?a2uiDelta=1 and assert the 2nd arrives as a delta frame
 * that reconstructs to the materialized full surface. Plus the fail-closed leg:
 * an out-of-catalog surface is rejected (422) on the same gate a full receives.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { applyPatch } from '../src/host/a2uiSurfaceDelta.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

// catalog 0.9.1 components only (text / field.* / action.button).
const SURFACE_A = {
  title: 'Schedule',
  components: [
    { component: 'text', text: 'Pick a time.' },
    { component: 'field.date', id: 'date', label: 'Date', required: true },
    { component: 'action.button', id: 'go', label: 'Confirm', action: { target: 'resume' } },
  ],
};
const SURFACE_B = { ...SURFACE_A, components: SURFACE_A.components.map((c, i) => (i === 0 ? { ...c, text: 'Reschedule.' } : c)) };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // mounts the emit-surface seam + advert
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jf<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
}

/** Read the SSE stream for `ms`, returning parsed `{event, data}` frames. */
function readSse(path: string, ms: number): Promise<Array<{ event: string; data: any }>> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      const frames: Array<{ event: string; data: any }> = [];
      res.on('data', (c) => {
        buf += c.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const dm = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && dm) { try { frames.push({ event: ev, data: JSON.parse(dm) }); } catch { /* heartbeat */ } }
        }
      });
      setTimeout(() => { req.destroy(); resolve(frames); }, ms);
    });
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
  });
}

async function completedRun(): Promise<string> {
  const c = await jf<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: { text: 'hi' } }) });
  const runId = c.body.runId;
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 40)); const s = await jf<{ status: string }>(`/v1/runs/${runId}`); if (['completed', 'failed', 'cancelled'].includes(s.body.status)) break; }
  return runId;
}

describe('RFC 0114 — a2uiSurface.deltaTransport advert (seam enabled)', () => {
  it('advertises a2uiSurface.deltaTransport when the seam is on', async () => {
    const d = await jf<{ capabilities: { a2uiSurface?: { deltaTransport?: boolean } } }>('/.well-known/openwop');
    expect(d.body.capabilities.a2uiSurface?.deltaTransport).toBe(true);
  });
});

describe('RFC 0114 — emit-surface seam + delta transport (end to end)', () => {
  it('2nd surface arrives as a delta frame that reconstructs to the full', async () => {
    const runId = await completedRun();
    const a = await jf<{ surfaceRef: string }>('/v1/host/sample/a2ui/emit-surface', { method: 'POST', body: JSON.stringify({ runId, surface: SURFACE_A }) });
    expect(a.status).toBe(201);
    const b = await jf('/v1/host/sample/a2ui/emit-surface', { method: 'POST', body: JSON.stringify({ runId, surface: SURFACE_B }) });
    expect(b.status).toBe(201);

    const frames = await readSse(`/v1/runs/${runId}/events?a2uiDelta=1`, 400);
    const fulls = frames.filter((f) => f.event === 'ui.a2ui-surface');
    const deltas = frames.filter((f) => f.event === 'ui.a2ui-surface.delta');
    // First a2ui surface delivered full; second as a delta frame.
    expect(fulls.length).toBe(1);
    expect(deltas.length).toBe(1);
    expect(fulls[0]!.data.payload.surface).toEqual(SURFACE_A);
    const frame = deltas[0]!.data;
    expect(frame.surfaceRef).toBe(a.body.surfaceRef); // baseline full event id
    // Reconstruct: applying the patch to surface A yields the materialized full B.
    expect(applyPatch(SURFACE_A, frame.patch)).toEqual(SURFACE_B);
  });

  it('a default (non-negotiating) subscriber gets BOTH surfaces full — never a delta', async () => {
    const runId = await completedRun();
    await jf('/v1/host/sample/a2ui/emit-surface', { method: 'POST', body: JSON.stringify({ runId, surface: SURFACE_A }) });
    await jf('/v1/host/sample/a2ui/emit-surface', { method: 'POST', body: JSON.stringify({ runId, surface: SURFACE_B }) });
    const frames = await readSse(`/v1/runs/${runId}/events`, 400); // no ?a2uiDelta=1
    expect(frames.filter((f) => f.event === 'ui.a2ui-surface').length).toBe(2);
    expect(frames.filter((f) => f.event === 'ui.a2ui-surface.delta').length).toBe(0);
  });

  it('fail-closed: an out-of-catalog surface is rejected at emit (422)', async () => {
    const runId = await completedRun();
    const bad = { title: 'x', components: [{ component: 'script', src: 'evil.js' }] }; // not in catalog 0.9.1
    const res = await jf('/v1/host/sample/a2ui/emit-surface', { method: 'POST', body: JSON.stringify({ runId, surface: bad }) });
    expect(res.status).toBe(422);
  });
});
