/**
 * ADR 0551 P1 — `POST /v1/runs` returns 201 only once the dispatch intent is
 * durable.
 *
 * The unit suite (`dispatch-outbox.test.ts`) proves the outbox mechanism. This
 * file proves the WIRING, which is the part that can silently rot: the outbox is
 * opt-in per run-creation path (`enqueueDispatch`), so dropping one word from
 * `routes/runs.ts` would take the flagship path back to `setImmediate`-only
 * durability with every mechanism test still green.
 *
 * It asserts through the real HTTP route and the real storage handle — the two
 * things the ADR's exit criterion is actually about.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';

let server: http.Server;
let app: Express;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

const storage = (): Storage => app.locals.storage as Storage;

describe('ADR 0551 P1 — POST /v1/runs writes a durable dispatch intent', () => {
  const workflowId = 'openwop-app.dispatch-outbox-route-test';

  beforeAll(async () => {
    // A gate node keeps the run non-terminal, so the assertions below observe
    // the intent rather than racing a run that finished first.
    const created = await api('/v1/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'hold' } }], edges: [] }),
    });
    expect(created.status).toBe(201);
  });

  it('has committed the outbox row by the time the 201 is observable', async () => {
    const create = await api<{ runId: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }),
    });
    expect(create.status).toBe(201);

    // Read straight after the response — no waiting, no retry loop. The point
    // of writing the intent inside the run insert is that "201 received" and
    // "intent durable" are the same instant; a poll here would hide a
    // fire-and-forget enqueue passing for a transactional one.
    const row = await storage().getDispatchOutbox(create.body.runId);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ runId: create.body.runId, workflowId, status: 'pending', attempts: 0 });
    // Unclaimed and not yet due: the in-process hint gets its window first.
    expect(row?.claimedBy).toBeNull();
    expect(row!.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it('records exactly one intent per run', async () => {
    const a = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }) });
    const b = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }) });
    expect(a.body.runId).not.toBe(b.body.runId);
    expect((await storage().getDispatchOutbox(a.body.runId))?.runId).toBe(a.body.runId);
    expect((await storage().getDispatchOutbox(b.body.runId))?.runId).toBe(b.body.runId);
  });

  it('an Idempotency-Key replay does not mint a second intent', async () => {
    const key = `outbox-replay-${Date.now()}`;
    const body = JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' });
    const first = await api<{ runId: string }>('/v1/runs', { method: 'POST', headers: { 'idempotency-key': key }, body });
    const replay = await api<{ runId: string }>('/v1/runs', { method: 'POST', headers: { 'idempotency-key': key }, body });

    // The ADR 0549 ledger replays the cached 201 without creating a run, so
    // there is no second run to carry a second intent. Asserted because the
    // outbox now rides the run insert: if a retry ever created a run, it would
    // silently create a second dispatch too.
    expect(replay.body.runId).toBe(first.body.runId);
    expect((await storage().getDispatchOutbox(first.body.runId))?.attempts).toBe(0);
  });
});
