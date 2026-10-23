/**
 * RFC 0114 — A2UI surfaces end to end on the v2 stream, and the emit-time
 * fail-closed catalog gate (conformance seam §15).
 *
 * CORRECTED 2026-10-18 (8fw1g4, /grade-tests). The file name and the first header
 * describe a DELTA-transport witness ("the 2nd arrives as a delta frame that
 * reconstructs…"). That leg was deleted with major 1 (ADR 0812 P3c-0; RFC 0209
 * §D.15 deprecates the `?a2uiDelta=1` frame for major 2), and
 * `src/host/__tests__/a2uiSurfaceDelta.test.ts` keeps the diff/patch mechanism
 * pinned. What this file witnesses now:
 *   1. a default subscriber on the v2 stream receives BOTH emitted surfaces FULL,
 *      in order, with their real content (A: "Pick a time.", then B: "Reschedule.");
 *   2. an out-of-catalog surface is refused at emit with `422 a2ui_surface_invalid`
 *      (the catalog gate, not a wrapper-shape refusal).
 * The file rename is the orchestrator's call (citations: `git grep rfc0114-a2ui-delta-e2e`).
 *
 * DOUBLE GUARD ("never a delta"): a default subscriber is kept off deltas by the
 * `?a2uiDelta=1` opt-in AND by the v2 wire rename (`ui.a2ui-surface` →
 * `openwop-app.a2ui-surface`, which `isA2uiSurfaceEvent` does not match), so removing
 * the opt-in alone stays green (round-1 probe a2-default-delta, vacuous). The probe
 * on the shared piece forces `deliverEvent`'s delta branch for every surface payload.
 *
 * Sabotages that red this file: skipping the emit catalog gate, emitting under a
 * different event type, and forcing the delta branch in `deliverEvent`.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
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

interface SseFrame { event: string; data: unknown }
interface SurfaceEventData { payload?: { catalogVersion?: string; surface?: { components?: Array<{ text?: string }> } } }
interface ErrorBody { error?: string; details?: { reason?: unknown; validation?: unknown } }

async function jf<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
}

/** Read the SSE stream until `want` frames named `eventName` have arrived (or
 *  `capMs` passes), then `graceMs` more so a trailing frame (e.g. a delta) would
 *  still be seen. Returns every parsed `{event, data}` frame. */
function readSse(path: string, eventName: string, want: number, capMs = 3000, graceMs = 100): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    let settled = false;
    const finish = (req: http.ClientRequest): void => {
      if (settled) return;
      settled = true;
      setTimeout(() => { req.destroy(); resolve(frames); }, graceMs);
    };
    const req = http.get(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'OpenWOP-Version': '2' } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const dm = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && dm) { try { frames.push({ event: ev, data: JSON.parse(dm) }); } catch { /* heartbeat */ } }
        }
        if (frames.filter((f) => f.event === eventName).length >= want) finish(req);
      });
    });
    setTimeout(() => finish(req), capMs);
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
  });
}

const firstText = (f: SseFrame): string | undefined => (f.data as SurfaceEventData).payload?.surface?.components?.[0]?.text;

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
  // A run-settle poll on the real condition (the run status); no hook exists to await.
  await vi.waitFor(async () => {
    const s = await jf<{ status: string }>(`/runs/${encodeURIComponent(runId)}`, { headers: v2 });
    if (!String(s.body.status).startsWith('waiting')) throw new Error(`run ${runId} is ${s.body.status}`);
  }, { timeout: 5000, interval: 40 });
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
    // v2 spelling: the host-defined `ui.a2ui-surface` event is `openwop-app.a2ui-surface` on the wire.
    const frames = await readSse(`/runs/${encodeURIComponent(runId)}/events`, 'openwop-app.a2ui-surface', 2); // no ?a2uiDelta=1
    const surfaces = frames.filter((f) => f.event === 'openwop-app.a2ui-surface');
    // BOTH surfaces, FULL, in order — the content, not just a frame count.
    expect(surfaces.map(firstText)).toEqual(['Pick a time.', 'Reschedule.']);
    expect(surfaces.map((f) => (f.data as SurfaceEventData).payload?.surface?.components?.length)).toEqual([3, 3]);
    expect(frames.filter((f) => f.event.includes('delta')).length).toBe(0);
  });

  it('fail-closed: an out-of-catalog surface is rejected at emit (422)', async () => {
    const runId = await completedRun();
    // Wrapped in the spec payload shape so the rejection exercises the CATALOG
    // gate (unknown component), not a wrapper-shape violation.
    const bad = { catalogVersion: '0.9.1', surface: { title: 'x', components: [{ component: 'script', src: 'evil.js' }] } };
    const res = await jf<ErrorBody>('/host/sample/a2ui/emit-surface', { method: 'POST', body: JSON.stringify({ runId: bareRunId(runId), surface: bad }) });
    expect(res.status).toBe(422);
    // sendError namespaces a host-extension route's code (testSeam.ts:394 passes 'a2ui_surface_invalid').
    expect(res.body.error).toBe('openwop-app.a2ui_surface_invalid');
    expect(typeof res.body.details?.reason).toBe('string');
  });
});
