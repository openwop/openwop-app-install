/**
 * ADR 0368 Phase 1 — the tour step nodes at the run boundary: a two-step tour
 * suspends with `tour-step` interrupts carrying the player payload; resolving
 * each advances; the run completes. Also pins the interrupt-resolution
 * round-trip the player will use (resolve-by-run) and the checkpoint payload.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

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

interface Res<T = Record<string, unknown>> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

async function waitFor(c: ReturnType<typeof client>, runId: string, pred: (s: string) => boolean): Promise<Record<string, unknown>> {
  for (let i = 0; i < 60; i++) {
    const r = await c.get(`/v1/runs/${runId}`);
    if (pred(r.body.status as string)) return r.body;
    if (r.body.status === 'failed') throw new Error(`run failed: ${JSON.stringify(r.body.error)}`);
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('condition never reached');
}

describe('guided-tour nodes (ADR 0368 P1)', () => {
  it('a two-step tour suspends per step with the player payload; resolving advances; the run completes', async () => { // legacy ui.tour.* typeids exercise the ADR 0376 replay alias
    const c = client();
    expect((await c.post('/v1/host/openwop-app/test/login', { email: `gt-${Date.now()}-${n++}@acme.test` })).status).toBe(201);

    const workflowId = `tour-demo-${Date.now()}`;
    const reg = await c.post('/v1/host/openwop-app/workflows', {
      workflowId,
      metadata: { lifecycle: { transient: true, generatedBy: 'guided-tours-test' } },
      nodes: [
        { nodeId: 's1', typeId: 'ui.tour.step', config: { actionId: 'demo.first.click', narration: 'First, click the thing.' } },
        { nodeId: 's2', typeId: 'ui.tour.step', config: { actionId: 'demo.upload.file', narration: 'Now choose a file.', hitl: { prompt: 'Pick any file' } } },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 's1', targetNodeId: 's2' }],
    });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);

    const create = await c.post('/v1/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    // Step 1 suspends: waiting with a tour-step interrupt carrying the payload.
    await waitFor(c, runId, (s) => s.startsWith('waiting'));
    let ints = await c.get(`/v1/host/openwop-app/runs/${runId}/interrupts`);
    let open = (ints.body.interrupts as Array<Record<string, unknown>>).filter((i) => !i.resolvedAt);
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe('walkthrough-step');
    expect((open[0]!.data as Record<string, unknown>).actionId).toBe('demo.first.click');
    expect((open[0]!.data as Record<string, unknown>).hitl).toBe(false);

    // The player's resolve path: resolve-by-run+node.
    const r1 = await c.post(`/v1/runs/${runId}/interrupts/${open[0]!.nodeId as string}`, { resumeValue: { acked: true, actionId: 'demo.first.click' } });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);

    // Step 2 (HITL) suspends with the hitl payload.
    await waitFor(c, runId, (s) => s.startsWith('waiting'));
    ints = await c.get(`/v1/host/openwop-app/runs/${runId}/interrupts`);
    open = (ints.body.interrupts as Array<Record<string, unknown>>).filter((i) => !i.resolvedAt);
    expect(open).toHaveLength(1);
    expect((open[0]!.data as Record<string, unknown>).actionId).toBe('demo.upload.file');
    expect((open[0]!.data as Record<string, unknown>).hitl).toEqual({ prompt: 'Pick any file' });

    const r2 = await c.post(`/v1/runs/${runId}/interrupts/${open[0]!.nodeId as string}`, { resumeValue: { acked: true, hitlValue: { mediaRef: 'media:abc' } } });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);

    await waitFor(c, runId, (s) => s === 'completed');
  });

  it('a checkpoint suspends with its declaration; a missing actionId fails the step node honestly', async () => {
    const c = client();
    expect((await c.post('/v1/host/openwop-app/test/login', { email: `gt-${Date.now()}-${n++}@acme.test` })).status).toBe(201);

    const workflowId = `tour-cp-${Date.now()}`;
    expect((await c.post('/v1/host/openwop-app/workflows', {
      workflowId,
      metadata: { lifecycle: { transient: true, generatedBy: 'guided-tours-test' } },
      nodes: [{ nodeId: 'cp', typeId: 'ui.tour.checkpoint', config: { expect: 'demo.brief-exists' } }],
    })).status).toBe(201);
    const create = await c.post('/v1/runs', { workflowId, inputs: {} });
    const runId = create.body.runId as string;
    await waitFor(c, runId, (s) => s.startsWith('waiting'));
    const ints = await c.get(`/v1/host/openwop-app/runs/${runId}/interrupts`);
    const open = (ints.body.interrupts as Array<Record<string, unknown>>).filter((i) => !i.resolvedAt);
    expect((open[0]!.data as Record<string, unknown>).checkpoint).toBe('demo.brief-exists');

    // Missing actionId → the node FAILS (config error), never a silent hang.
    const badId = `tour-bad-${Date.now()}`;
    expect((await c.post('/v1/host/openwop-app/workflows', {
      workflowId: badId,
      metadata: { lifecycle: { transient: true, generatedBy: 'guided-tours-test' } },
      nodes: [{ nodeId: 'x', typeId: 'ui.tour.step', config: {} }],
    })).status).toBe(201);
    const bad = await c.post('/v1/runs', { workflowId: badId, inputs: {} });
    for (let i = 0; i < 60; i++) {
      const r = await c.get(`/v1/runs/${bad.body.runId as string}`);
      if (r.body.status === 'failed') return;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('bad step never failed');
  });
});
