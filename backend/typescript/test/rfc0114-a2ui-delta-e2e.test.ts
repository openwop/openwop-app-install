/**
 * RFC 0114 — end-to-end A2UI delta transport witness (the non-vacuous proof).
 * Drives the REAL §15 emit-surface seam + REAL acceptEnvelope catalog gate +
 * REAL streams.ts ?a2uiDelta=1 transport: emit two surfaces for a run, then read
 * the events stream with ?a2uiDelta=1 and assert the 2nd arrives as a delta frame
 * that reconstructs to the materialized full surface. Plus the fail-closed leg:
 * an out-of-catalog surface is rejected (422) on the same gate a full receives.
 *
 * ADR 0812 P3c-0 — the delta leg retired with major 1 (RFC 0209 §D.15); what remains
 * is the default-subscriber leg on the v2 stream and the fail-closed emit leg.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

// catalog 0.9.1 components only (text / field.* / action.button).
// Per host-sample-test-seams.md §15 the seam's `surface` field is the FULL
// `ui.a2ui-surface` payload (`{ catalogVersion, surface }`), not the inner
// surface object — this test previously pinned the inner shape, masking a seam
// bug that 422'd every spec-shaped (conformance-suite) request.
const INNER_A = {
  title: 'Schedule',
  components: [
    { component: 'text', text: 'Pick a time.' },
    { component: 'field.date', id: 'date', label: 'Date', required: true },
    { component: 'action.button', id: 'go', label: 'Confirm', action: { target: 'resume' } },
  ],
};
const INNER_B = { ...INNER_A, components: INNER_A.components.map((c, i) => (i === 0 ? { ...c, text: 'Reschedule.' } : c)) };
const SURFACE_A = { catalogVersion: '0.9.1', surface: INNER_A };
const SURFACE_B = { catalogVersion: '0.9.1', surface: INNER_B };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // mounts the emit-surface seam + advert
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jf<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
}

/** Read the SSE stream for `ms`, returning parsed `{event, data}` frames. */
function readSse(path: string, ms: number): Promise<Array<{ event: string; data: any }>> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'OpenWOP-Version': '2' } }, (res) => {
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

/** A real, OPEN run to emit surfaces onto — parked at a conversation gate, so
 *  it is readable and never terminal. It used to be a COMPLETED run, and RFC
 *  0194 closes a terminal run's log to anything but compensation / dead-letter
 *  records, so the seam's append onto it was (correctly) refused. The suite's
 *  own scenario never emits onto a finished run either. The helper name is
 *  kept so the call sites read unchanged. */
let gateRegistered = false;
async function completedRun(): Promise<string> {
  const workflowId = 'openwop-app.a2ui-delta-open-run';
  if (!gateRegistered) {
    await jf('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'hold' } }], edges: [] }) });
    gateRegistered = true;
  }
  const v2 = { 'OpenWOP-Version': '2' };
  const c = await jf<{ runId: string }>('/runs', { method: 'POST', headers: v2, body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }) });
  // ADR 0812 P3c-0 — the tenant-BOUND id addresses the protocol path; the seam (a host
  // lane that appends to the event log) takes the bare id. See `./support/bareRunId.ts`.
  const runId = c.body.runId;
  for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 40)); const s = await jf<{ status: string }>(`/runs/${encodeURIComponent(runId)}`, { headers: v2 }); if (String(s.body.status).startsWith('waiting')) break; }
  return runId;
}

// ADR 0812 P3c-0 — the `a2uiSurface.deltaTransport` discovery-advert block is deleted: the record
// exists only in the retired v1 document (the closed v2 root carries none); the transport legs remain.

describe('RFC 0114 — emit-surface seam + delta transport (end to end)', () => {
  // ADR 0812 P3c-0 — the delta-frame leg is deleted with v1: RFC 0209 §D.15 deprecates the
  // `?a2uiDelta=1` frame for major 2 (the v1 transport it witnessed retired with major 1).
  // `src/host/__tests__/a2uiSurfaceDelta.test.ts` keeps the diff/patch mechanism pinned.
  it('a default (non-negotiating) subscriber gets BOTH surfaces full — never a delta', async () => {
    const runId = await completedRun();
    await jf('/host/sample/a2ui/emit-surface', { method: 'POST', body: JSON.stringify({ runId: bareRunId(runId), surface: SURFACE_A }) });
    await jf('/host/sample/a2ui/emit-surface', { method: 'POST', body: JSON.stringify({ runId: bareRunId(runId), surface: SURFACE_B }) });
    const frames = await readSse(`/runs/${encodeURIComponent(runId)}/events`, 400); // no ?a2uiDelta=1
    // v2 spelling: the host-defined `ui.a2ui-surface` event is `openwop-app.a2ui-surface` on the wire.
    expect(frames.filter((f) => f.event === 'openwop-app.a2ui-surface').length).toBe(2);
    expect(frames.filter((f) => f.event.includes('delta')).length).toBe(0);
  });

  it('fail-closed: an out-of-catalog surface is rejected at emit (422)', async () => {
    const runId = await completedRun();
    // Wrapped in the spec payload shape so the rejection exercises the CATALOG
    // gate (unknown component), not a wrapper-shape violation.
    const bad = { catalogVersion: '0.9.1', surface: { title: 'x', components: [{ component: 'script', src: 'evil.js' }] } };
    const res = await jf('/host/sample/a2ui/emit-surface', { method: 'POST', body: JSON.stringify({ runId: bareRunId(runId), surface: bad }) });
    expect(res.status).toBe(422);
  });
});
