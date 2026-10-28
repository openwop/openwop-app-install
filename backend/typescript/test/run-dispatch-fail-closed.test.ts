/**
 * Board-chat "Timed out waiting for the conversation to start" incident
 * (2026-07-09) — a background-dispatch throw was LOG-ONLY, leaving the run
 * `pending` forever; the chat FE burned its whole gate-open budget and
 * surfaced a blind timeout instead of the cause.
 *
 * Pins the fail-closed contract: a dispatch error marks a non-terminal run
 * `failed` + appends a `run.failed` event carrying `dispatch_failed: <cause>`,
 * and never touches a run the executor already drove to a terminal state.
 *
 * Breaks it (round-1 probes, witnessed): the dispatch error code renamed
 * (8fw2g2-rdf-code), the closed-log repair skipped (rdf-log).
 *
 * DOUBLE GUARD on "leaves an already-terminal run untouched": the STATUS check
 * (`!['completed','failed','cancelled'].includes(current.status)`) AND the
 * closed-log repair (a completed run's log ends `run.completed`, so the repair
 * path rewrites `completed` and appends nothing). Removing the status check
 * alone kept status + events identical (round-1 8fw2g2-rdf-terminal VACUOUS).
 * The observable that separates them is `completedAt`: the repair path
 * rewrites it, the status guard does not touch the row — so case 2 stamps a
 * sentinel `completedAt` and asserts it survives (8fw2g2-rdf-terminal-r2).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { failRunClosedOnDispatchError } from '../src/host/runDispatch.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { bareRunId } from './support/bareRunId.js';

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
  await api('/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'hold' } }], edges: [] }),
  });
  const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }) });
  expect(create.status).toBe(201);
  return create.body.runId;
}

describe('dispatch fail-closed (the pending-forever incident)', () => {
  it('marks a non-terminal run failed + appends run.failed with the cause', async () => {
    const runId = await createGateRun();
    // The real storage the app booted with (the module-level host storage the
    // dispatcher holds).
    await failRunClosedOnDispatchError(hostExtStorage(), bareRunId(runId), 'simulated executor crash');
    const run = await api<{ status: string }>(`/runs/${runId}`);
    expect(run.body.status).toBe('failed');
    const events = await getEventLog().list(bareRunId(runId), { fromSeq: -1, limit: 1000 });
    const failed = events.filter((e) => e.type === 'run.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ error: { code: 'dispatch_failed', message: 'simulated executor crash' } });
    // G6 — the canonical terminal sequence includes the node-level terminal too.
    expect(events.some((e) => e.type === 'node.failed')).toBe(true);
  });

  it('leaves an already-terminal run untouched (no double-marking)', async () => {
    const runId = await createGateRun();
    // Drive it terminal through the real close path.
    const close = await api(`/runs/${runId}/interrupts/gate`, {
      method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'close' } }),
    });
    expect(close.status).toBe(200);
    const before = await api<{ status: string }>(`/runs/${runId}`);
    expect(before.body.status).toBe('completed');
    // A sentinel completedAt: the closed-log repair path (the second guard) would
    // REWRITE it, the status guard leaves the row alone (header).
    const SENTINEL = '2026-01-01T00:00:00.000Z';
    await hostExtStorage().updateRun(bareRunId(runId), { completedAt: SENTINEL });
    expect((await hostExtStorage().getRun(bareRunId(runId)))?.completedAt).toBe(SENTINEL);
    await failRunClosedOnDispatchError(hostExtStorage(), bareRunId(runId), 'late crash');
    const after = await api<{ status: string }>(`/runs/${runId}`);
    expect(after.body.status).toBe('completed'); // not failed
    expect((await hostExtStorage().getRun(bareRunId(runId)))?.completedAt, 'the status guard never touched the row').toBe(SENTINEL);
    const events = await getEventLog().list(bareRunId(runId), { fromSeq: -1, limit: 1000 });
    expect(events.some((e) => e.type === 'run.failed')).toBe(false);
  });

  it('a run whose LOG is closed but whose status write failed is repaired, never double-terminated', async () => {
    // The production state of run 2c4095e7 (2026-09-21): `finalizeRun` appended
    // `run.completed`, then its status write threw on a pool timeout, so the ROW
    // still said non-terminal when this path ran. It used to append node.failed +
    // run.dead_lettered + run.failed behind run.completed and report `failed`.
    const runId = await createGateRun();
    await getEventLog().append({ runId: bareRunId(runId), type: 'run.completed', payload: { output: null } });
    const before = await api<{ status: string }>(`/runs/${runId}`);
    expect(before.body.status, 'precondition: the row is still non-terminal').not.toMatch(/^(completed|failed|cancelled)$/);

    await failRunClosedOnDispatchError(hostExtStorage(), bareRunId(runId), 'timeout exceeded when trying to connect');

    const after = await api<{ status: string }>(`/runs/${runId}`);
    expect(after.body.status, 'the row follows the durable log').toBe('completed');
    const events = await getEventLog().list(bareRunId(runId), { fromSeq: -1, limit: 1000 });
    const terminals = events.filter((e) => ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type));
    expect(terminals.map((e) => e.type)).toEqual(['run.completed']);
    expect(events.at(-1)?.type, 'nothing appended after the terminal event').toBe('run.completed');
  });
});
