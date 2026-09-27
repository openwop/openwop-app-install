/**
 * Board-chat "Timed out waiting for the conversation to start" incident
 * (2026-07-09) — a background-dispatch throw was LOG-ONLY, leaving the run
 * `pending` forever; the chat FE burned its whole gate-open budget and
 * surfaced a blind timeout instead of the cause.
 *
 * Pins the fail-closed contract: a dispatch error marks a non-terminal run
 * `failed` + appends a `run.failed` event carrying `dispatch_failed: <cause>`,
 * and never touches a run the executor already drove to a terminal state.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { failRunClosedOnDispatchError } from '../src/host/runDispatch.js';
import { getEventLog } from '../src/executor/eventLog.js';

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** A run held open (suspended conversation gate) — non-terminal by design. */
async function createGateRun(): Promise<string> {
  const workflowId = 'openwop-app.dispatch-failclosed-test';
  await api('/v1/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'hold' } }], edges: [] }),
  });
  const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }) });
  expect(create.status).toBe(201);
  return create.body.runId;
}

describe('dispatch fail-closed (the pending-forever incident)', () => {
  it('marks a non-terminal run failed + appends run.failed with the cause', async () => {
    const runId = await createGateRun();
    await failRunClosedOnDispatchError(
      // The real storage the app booted with — reach it through the API-visible
      // run instead of poking internals: the helper takes the Storage the
      // dispatcher holds, so import the app's storage via the debug bundle
      // route is unnecessary; use the module-level host storage.
      (await import('../src/host/hostExtPersistence.js')).hostExtStorage(),
      runId,
      'simulated executor crash',
    );
    const run = await api<{ status: string }>(`/v1/runs/${runId}`);
    expect(run.body.status).toBe('failed');
    const events = await getEventLog().list(runId, { fromSeq: -1, limit: 1000 });
    const failed = events.find((e) => e.type === 'run.failed');
    expect(failed).toBeTruthy();
    expect(JSON.stringify(failed?.payload)).toContain('dispatch_failed');
    expect(JSON.stringify(failed?.payload)).toContain('simulated executor crash');
    // G6 — the canonical terminal sequence includes the node-level terminal too.
    expect(events.some((e) => e.type === 'node.failed')).toBe(true);
  });

  it('leaves an already-terminal run untouched (no double-marking)', async () => {
    const runId = await createGateRun();
    // Drive it terminal through the real close path.
    const close = await api(`/v1/runs/${runId}/interrupts/gate`, {
      method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'close' } }),
    });
    expect(close.status).toBe(200);
    const before = await api<{ status: string }>(`/v1/runs/${runId}`);
    await failRunClosedOnDispatchError((await import('../src/host/hostExtPersistence.js')).hostExtStorage(), runId, 'late crash');
    const after = await api<{ status: string }>(`/v1/runs/${runId}`);
    expect(after.body.status).toBe(before.body.status); // completed, not failed
    const events = await getEventLog().list(runId, { fromSeq: -1, limit: 1000 });
    expect(events.some((e) => e.type === 'run.failed')).toBe(false);
  });

  it('a run whose LOG is closed but whose status write failed is repaired, never double-terminated', async () => {
    // The production state of run 2c4095e7 (2026-09-21): `finalizeRun` appended
    // `run.completed`, then its status write threw on a pool timeout, so the ROW
    // still said non-terminal when this path ran. It used to append node.failed +
    // run.dead_lettered + run.failed behind run.completed and report `failed`.
    const runId = await createGateRun();
    await getEventLog().append({ runId, type: 'run.completed', payload: { output: null } });
    const before = await api<{ status: string }>(`/v1/runs/${runId}`);
    expect(before.body.status, 'precondition: the row is still non-terminal').not.toMatch(/^(completed|failed|cancelled)$/);

    await failRunClosedOnDispatchError((await import('../src/host/hostExtPersistence.js')).hostExtStorage(), runId, 'timeout exceeded when trying to connect');

    const after = await api<{ status: string }>(`/v1/runs/${runId}`);
    expect(after.body.status, 'the row follows the durable log').toBe('completed');
    const events = await getEventLog().list(runId, { fromSeq: -1, limit: 1000 });
    const terminals = events.filter((e) => ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type));
    expect(terminals.map((e) => e.type)).toEqual(['run.completed']);
    expect(events.at(-1)?.type, 'nothing appended after the terminal event').toBe('run.completed');
  });
});
