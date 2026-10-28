/**
 * ADR 0368 Phase 1 — the tour step nodes at the run boundary: a two-step tour
 * suspends with `tour-step` interrupts carrying the player payload; resolving
 * each advances; the run completes. Also pins the interrupt-resolution
 * round-trip the player will use (resolve-by-run) and the checkpoint payload.
 * The legacy `ui.tour.*` typeIds are used on purpose: they are the ADR 0376
 * replay alias, registered beside `ui.walkthrough.*`.
 *
 * Witnessed (8f W4): wn-missing-actionid (the bad step must fail with its OWN
 * `requires config.actionId` message), wn-hitl-default, wn-hitl-object, wn-kind,
 * wn-checkpoint-data, wn-legacy-alias. Polls are run-settle ceilings (100 ms).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The fields of the run snapshot / interrupt list this file reads. */
interface RunSnapshot { runId: string; status: string; error?: { code?: string; message?: string } }
interface Interrupt {
  nodeId: string; kind: string; resolvedAt?: string;
  data: { actionId?: string; hitl?: unknown; checkpoint?: string };
}
interface InterruptList { interrupts: Interrupt[] }

interface Res<T> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

/** Run-settle poll: an honest ceiling (no completion hook to await over HTTP). */
async function waitFor(c: ReturnType<typeof client>, runId: string, pred: (s: string) => boolean): Promise<RunSnapshot> {
  for (let i = 0; i < 60; i++) {
    const r = await c.get<RunSnapshot>(`/runs/${runId}`);
    if (pred(r.body.status)) return r.body;
    if (r.body.status === 'failed') throw new Error(`run failed: ${JSON.stringify(r.body.error)}`);
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('condition never reached');
}
const openInterrupts = async (c: ReturnType<typeof client>, runId: string): Promise<Interrupt[]> =>
  (await c.get<InterruptList>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts.filter((i) => !i.resolvedAt);

describe('guided-tour nodes (ADR 0368 P1)', () => {
  it('a two-step tour suspends per step with the player payload; resolving advances; the run completes', async () => { // legacy ui.tour.* typeids exercise the ADR 0376 replay alias
    const c = client();
    expect((await c.post<unknown>('/host/openwop-app/test/login', { email: `gt-${Date.now()}-${n++}@acme.test` })).status).toBe(201);

    const workflowId = `tour-demo-${Date.now()}`;
    const reg = await c.post<unknown>('/host/openwop-app/workflows', {
      workflowId,
      metadata: { lifecycle: { transient: true, generatedBy: 'guided-tours-test' } },
      nodes: [
        { nodeId: 's1', typeId: 'ui.tour.step', config: { actionId: 'demo.first.click', narration: 'First, click the thing.' } },
        { nodeId: 's2', typeId: 'ui.tour.step', config: { actionId: 'demo.upload.file', narration: 'Now choose a file.', hitl: { prompt: 'Pick any file' } } },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 's1', targetNodeId: 's2' }],
    });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);

    const create = await c.post<RunSnapshot>('/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId;

    // Step 1 suspends: waiting with a tour-step interrupt carrying the payload.
    await waitFor(c, runId, (s) => s.startsWith('waiting'));
    let open = await openInterrupts(c, runId);
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe('walkthrough-step');
    expect(open[0]!.data.actionId).toBe('demo.first.click');
    expect(open[0]!.data.hitl).toBe(false);

    // The player's resolve path: resolve-by-run+node.
    const r1 = await c.post<unknown>(`/runs/${runId}/interrupts/${open[0]!.nodeId}`, { resumeValue: { acked: true, actionId: 'demo.first.click' } });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);

    // Step 2 (HITL) suspends with the hitl payload.
    await waitFor(c, runId, (s) => s.startsWith('waiting'));
    open = await openInterrupts(c, runId);
    expect(open).toHaveLength(1);
    expect(open[0]!.data.actionId).toBe('demo.upload.file');
    expect(open[0]!.data.hitl).toEqual({ prompt: 'Pick any file' });

    const r2 = await c.post<unknown>(`/runs/${runId}/interrupts/${open[0]!.nodeId}`, { resumeValue: { acked: true, hitlValue: { mediaRef: 'media:abc' } } });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);

    await waitFor(c, runId, (s) => s === 'completed');
  });

  it('a checkpoint suspends with its declaration; a missing actionId fails the step node honestly', async () => {
    const c = client();
    expect((await c.post<unknown>('/host/openwop-app/test/login', { email: `gt-${Date.now()}-${n++}@acme.test` })).status).toBe(201);

    const workflowId = `tour-cp-${Date.now()}`;
    expect((await c.post<unknown>('/host/openwop-app/workflows', {
      workflowId,
      metadata: { lifecycle: { transient: true, generatedBy: 'guided-tours-test' } },
      nodes: [{ nodeId: 'cp', typeId: 'ui.tour.checkpoint', config: { expect: 'demo.brief-exists' } }],
    })).status).toBe(201);
    const create = await c.post<RunSnapshot>('/runs', { workflowId, inputs: {} });
    const runId = create.body.runId;
    await waitFor(c, runId, (s) => s.startsWith('waiting'));
    const open = await openInterrupts(c, runId);
    expect(open).toHaveLength(1);
    expect(open[0]!.data.checkpoint).toBe('demo.brief-exists');

    // Missing actionId → the node FAILS with its typed config error, never a
    // silent hang and never some unrelated failure.
    const badId = `tour-bad-${Date.now()}`;
    expect((await c.post<unknown>('/host/openwop-app/workflows', {
      workflowId: badId,
      metadata: { lifecycle: { transient: true, generatedBy: 'guided-tours-test' } },
      nodes: [{ nodeId: 'x', typeId: 'ui.tour.step', config: {} }],
    })).status).toBe(201);
    const bad = await c.post<RunSnapshot>('/runs', { workflowId: badId, inputs: {} });
    // Settles on the first TERMINAL-or-suspended status, so a step that suspends
    // instead of failing is caught at once rather than after a 6 s timeout.
    let settled: RunSnapshot | undefined;
    for (let i = 0; i < 60 && !settled; i++) {
      const r = await c.get<RunSnapshot>(`/runs/${bad.body.runId}`);
      if (r.body.status === 'failed' || r.body.status === 'completed' || r.body.status.startsWith('waiting')) settled = r.body;
      else await new Promise((res) => setTimeout(res, 100));
    }
    const failed = settled;
    expect(failed?.status, 'bad step never failed').toBe('failed');
    expect(failed?.error?.message).toMatch(/requires config\.actionId/);
  });
});
