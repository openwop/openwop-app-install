/**
 * host.canvas — `vendor.myndhyve.canvas` against the durable canvas store.
 * Proves create/write/read really work end-to-end through the pack nodes (a
 * canvas created by one node is read by another), plus surface-direct
 * optimistic concurrency (ADR 0153 Phase 2b / ADR 0865 B18), deep merge,
 * tenant isolation, the CAS-backed create idempotency (CODEBASE-ASSESSMENT
 * CAS-adoption pass), and that crossCanvasInvoke refuses an unknown workflow
 * (real dispatch since PR #548 — see canvas-invoke-dispatch.test.ts).
 *
 * Idempotent create is CLAIM-FIRST (CANVAS-IDEM-ORPHAN-1, fixed): the key is
 * CAS-claimed before the canvas row is written, so a same-key race leaves ONE
 * row on both create paths (`createCanvasForTenant` and the run-lane surface
 * `create`); an abandoned claim (older than 30 s, no row) is taken over by one
 * caller; a fresh claim with no row answers `idempotency_in_flight` (409 +
 * Retry-After). The pack node owns the
 * `merge: 'shallow'` default (`packs/vendor.myndhyve.canvas/index.mjs`), so the
 * surface's own default is not reachable from the node case.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { createApp } from '../src/index.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';
import { OpenwopError } from '../src/types.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { createCanvasForTenant, deleteCanvasForTenant, listCanvasesForTenant } from '../src/host/canvasSurface.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as T };
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }

async function runNode(workflowId: string, typeId: string, config: Record<string, unknown>, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  await jsonFetch('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'op', typeId, config }], edges: [] }) });
  const create = await jsonFetch<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs, tenantId: 'default' }) });
  expect(create.status).toBe(201);
  const { runId } = create.body;
  // Settle on the run's own terminal status (no hook to await from outside the run).
  let status = 'pending';
  await vi.waitFor(async () => {
    status = (await jsonFetch<{ status: string }>(`/runs/${runId}`)).body.status;
    expect(['completed', 'failed', 'cancelled']).toContain(status);
  }, { timeout: 5_000, interval: 25 });
  const bundle = await jsonFetch<{ events?: BundleEvent[] }>(`/runs/${runId}/debug-bundle`);
  const ev = (bundle.body.events ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'op');
  return { __status: status, ...((ev?.payload?.outputs as Record<string, unknown>) ?? {}) };
}

describe('durable CAS idempotency (CODEBASE-ASSESSMENT CAS-adoption pass)', () => {
  it('two CONCURRENT same-key creates converge on one canvas; a later retry reuses it', async () => {
    const args = { canvasTypeId: 'doc', idempotencyKey: 'race-key-1' };
    const [a, b] = await Promise.all([
      createCanvasForTenant('t-cas', args),
      createCanvasForTenant('t-cas', args),
    ]);
    expect(a.canvasId).toBe(b.canvasId);
    const c = await createCanvasForTenant('t-cas', args);
    expect(c.canvasId).toBe(a.canvasId);
  });

  // CANVAS-IDEM-ORPHAN-1 (fixed). The create used to write its canvas row BEFORE the
  // idempotency CAS settled, so the race loser returned the winner's canvas and left
  // its OWN row listed in the tenant. Now the key is claimed first and only the winner
  // writes a row. Break it by moving `canvases.put` back before the claim.
  it('CANVAS-IDEM-ORPHAN-1: concurrent same-key creates leave exactly ONE canvas row, the winner\'s', async () => {
    const args = { canvasTypeId: 'doc', idempotencyKey: 'race-orphan-1' };
    const [a, b] = await Promise.all([
      createCanvasForTenant('t-cas-orphan', args),
      createCanvasForTenant('t-cas-orphan', args),
    ]);
    expect(b.canvasId).toBe(a.canvasId);
    expect((await listCanvasesForTenant('t-cas-orphan')).map((r) => r.canvasId)).toEqual([a.canvasId]);
  });

  it('CANVAS-IDEM-ORPHAN-1: the run-lane surface create (its own `c:` key) leaves exactly ONE row under a same-key race', async () => {
    const c = buildHostSurfaceBundle({ tenantId: 't-cas-lane' }).canvas;
    const args = { canvasTypeId: 'doc', idempotencyKey: 'race-lane-1' };
    const [a, b] = await Promise.all([c.create(args), c.create(args)]);
    expect(b.canvasId).toBe(a.canvasId);
    expect((await listCanvasesForTenant('t-cas-lane')).map((r) => r.canvasId)).toEqual([a.canvasId]);
  });

  it('a same-key create with a DIFFERENT body replays the first canvas (first write wins, no second row)', async () => {
    const first = await createCanvasForTenant('t-cas-body', { canvasTypeId: 'doc', idempotencyKey: 'body-key-1', initialState: { n: 1 } });
    const second = await createCanvasForTenant('t-cas-body', { canvasTypeId: 'doc', idempotencyKey: 'body-key-1', initialState: { n: 2 } });
    expect(second.canvasId).toBe(first.canvasId);
    expect(second.state).toEqual({ n: 1 });
    expect((await listCanvasesForTenant('t-cas-body')).map((r) => r.canvasId)).toEqual([first.canvasId]);
  });

  it('an ABANDONED claim (older than 30 s, no canvas row) is taken over by exactly one caller, leaving one row', async () => {
    const first = await createCanvasForTenant('t-cas-stale', { canvasTypeId: 'doc', idempotencyKey: 'stale-key-1' });
    // The claim outlives its row: the canvas is gone (here deleted; in production, a
    // winner killed between claim and write) and the `ct:` idem row is not cascaded.
    expect(await deleteCanvasForTenant('t-cas-stale', first.canvasId)).toBe(true);
    expect(await listCanvasesForTenant('t-cas-stale')).toEqual([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      const [a, b] = await Promise.all([
        createCanvasForTenant('t-cas-stale', { canvasTypeId: 'doc', idempotencyKey: 'stale-key-1' }),
        createCanvasForTenant('t-cas-stale', { canvasTypeId: 'doc', idempotencyKey: 'stale-key-1' }),
      ]);
      expect(a.canvasId).not.toBe(first.canvasId);
      expect(b.canvasId).toBe(a.canvasId);
      expect((await listCanvasesForTenant('t-cas-stale')).map((r) => r.canvasId)).toEqual([a.canvasId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a FRESH claim with no canvas row (an in-flight winner that never lands) answers idempotency_in_flight (409 + Retry-After), not a dead id', async () => {
    const first = await createCanvasForTenant('t-cas-young', { canvasTypeId: 'doc', idempotencyKey: 'young-key-1' });
    expect(await deleteCanvasForTenant('t-cas-young', first.canvasId)).toBe(true);
    const err = await createCanvasForTenant('t-cas-young', { canvasTypeId: 'doc', idempotencyKey: 'young-key-1' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject({ code: 'idempotency_in_flight', httpStatus: 409, details: { idempotencyKey: 'young-key-1', retryAfter: 1 } });
    expect(await listCanvasesForTenant('t-cas-young')).toEqual([]);
    // Over HTTP the envelope carries it as a header too, so a client retries
    // without mistaking it for an update's canvas_version_conflict (the same
    // in-flight answer the run-create idempotency gives, idempotency.md).
    const app = express();
    app.get('/x', (_req, _res, next) => next(err));
    app.use(errorEnvelopeMiddleware());
    const srv = await new Promise<http.Server>((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    try {
      const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/x`);
      expect(r.status).toBe(409);
      expect(r.headers.get('retry-after')).toBe('1');
      expect(((await r.json()) as { error: string }).error).toBe('idempotency_in_flight');
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });

  it('a sequential same-key retry returns the cached canvas and writes no second canvas row', async () => {
    const args = { canvasTypeId: 'doc', idempotencyKey: 'seq-key-1', initialState: { n: 1 } };
    const first = await createCanvasForTenant('t-cas-seq', args);
    const retry = await createCanvasForTenant('t-cas-seq', args);
    expect(retry).toEqual(first);
    expect((await listCanvasesForTenant('t-cas-seq')).map((r) => r.canvasId)).toEqual([first.canvasId]);
  });
});

describe('host.canvas: create → write → read through the pack nodes', () => {
  it('a canvas created by one node is mutated + read by others', async () => {
    const created = await runNode('c.create', 'core.coordination.canvasCreate', { canvasTypeId: 'doc' }, { name: 'Spec', initialState: { title: 'Draft', count: 1 } });
    expect(created.__status).toBe('completed');
    const canvasId = created.canvasId as string;
    expect(canvasId).toMatch(/^canvas-/);

    const written = await runNode('c.write', 'core.coordination.canvasWrite', { merge: 'shallow' }, { canvasId, mutation: { count: 2, status: 'review' } });
    expect(written.__status).toBe('completed');
    expect(written.newVersion).toBe(2); // create=v1, one write=v2

    const read = await runNode('c.read', 'core.coordination.canvasRead', {}, { canvasId });
    expect(read.__status).toBe('completed');
    const state = read.state as Record<string, unknown>;
    expect(state.title).toBe('Draft');   // preserved
    expect(state.count).toBe(2);          // overwritten
    expect(state.status).toBe('review');  // added
    expect(read.version).toBe(2);
  });
});

describe('host.canvas: surface-direct', () => {
  const cv = () => buildHostSurfaceBundle({ tenantId: 'default' }).canvas;

  it('rejects a stale expectedVersion (optimistic concurrency)', async () => {
    const c = cv();
    const { canvasId } = await c.create({ canvasTypeId: 'doc', initialState: { v: 0 } });
    await c.write(canvasId, { v: 1 }, { expectedVersion: 1 }); // ok → v2
    await expect(c.write(canvasId, { v: 2 }, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'canvas_version_conflict' });
  });

  it('deep-merges nested state', async () => {
    const c = cv();
    const { canvasId } = await c.create({ canvasTypeId: 'doc', initialState: { meta: { a: 1, b: 2 } } });
    await c.write(canvasId, { meta: { b: 3, c: 4 } }, { merge: 'deep' });
    const r = await c.read(canvasId);
    expect(r.state.meta).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('isolates canvases by tenant', async () => {
    const a = buildHostSurfaceBundle({ tenantId: 'tA' }).canvas;
    const b = buildHostSurfaceBundle({ tenantId: 'tB' }).canvas;
    const { canvasId } = await a.create({ canvasTypeId: 'doc', initialState: {} });
    await expect(b.read(canvasId)).rejects.toMatchObject({ code: 'canvas_not_found' });
  });

  it('crossCanvasInvoke does real dispatch — rejects an unknown workflow', async () => {
    // Now a real child-run dispatcher (see canvas-invoke-dispatch.test.ts);
    // an unknown workflowId is refused rather than stubbed.
    await expect(cv().invoke('canvas-x', 'wf-does-not-exist', {})).rejects.toMatchObject({ code: 'canvas_invoke_workflow_not_found' });
  });
});
