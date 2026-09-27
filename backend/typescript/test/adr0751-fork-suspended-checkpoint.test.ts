/**
 * ADR 0751 — forking a run at a checkpoint INSIDE a suspended run.
 *
 * `POST /runs/{id}:fork` used to answer `501 fork_checkpoint_unsupported` when
 * the copied prefix ended on an open interrupt. Neither `runs.md` §Fork nor
 * `replay.md` licenses that refusal. The fork now inherits the gate as STATE: the
 * gate node never re-executes, the fork's executor re-creates the live interrupt
 * row, and the fork resumes through the normal resolve path.
 *
 * Route-level because every property here — the refusal's absence, token
 * separation, the resolve path, the ancestry ownership rule — is only observable
 * through the HTTP boundary and the real executor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { getSuspendManager } from '../src/executor/suspendManager.js';
import { executeRun, snapshotFromEventPrefix } from '../src/executor/executor.js';
import { ensureForkInterrupts, forkDispatchOptions } from '../src/executor/forkInterrupts.js';
import { sweepOrphanedRuns, type RunSweeperDeps } from '../src/host/runDispatchSweeper.js';
import type { Storage } from '../src/storage/storage.js';
import type { EventRecord, InterruptRecord, RunRecord } from '../src/types.js';

let server: http.Server;
let BASE = '';
let sweeperDeps: RunSweeperDeps;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  sweeperDeps = { storage: app.locals.storage as Storage, hostSuite: app.locals.hostSuite as RunSweeperDeps['hostSuite'] };
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function waitStatus(runId: string, pred: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 200; i++) {
    status = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
async function events(runId: string): Promise<Array<{ sequence: number; type: string; nodeId?: string; payload?: unknown }>> {
  return (await api<{ events: Array<{ sequence: number; type: string; nodeId?: string; payload?: unknown }> }>(`/v1/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
}
async function openInterrupts(runId: string): Promise<Array<{ token: string; nodeId: string; kind: string; data?: Json }>> {
  return (await api<{ interrupts: Array<{ token: string; nodeId: string; kind: string; data?: Json }> }>(`/v1/host/openwop-app/runs/${runId}/interrupts`)).body.interrupts ?? [];
}
/** A suspended `conformance-approval` run plus one later event, so a fork can land AFTER the suspension. */
async function suspendedApproval(): Promise<{ runId: string; fromSeq: number }> {
  const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-approval' }) });
  expect(create.status).toBe(201);
  const runId = create.body.runId;
  expect(await waitStatus(runId, (s) => s.startsWith('waiting'))).toBe('waiting-approval');
  return { runId, fromSeq: await appendMarker(runId) };
}
/** Record one more event on a suspended run — the corpus does this with an a2ui envelope. */
async function appendMarker(runId: string): Promise<number> {
  const rec = await getEventLog().append({ runId, type: 'log.message', payload: { message: 'adr0751 fork point' } });
  return rec.sequence;
}
async function fork(runId: string, fromSeq: number, mode: 'replay' | 'branch'): Promise<{ status: number; body: Json }> {
  return api<Json>(`/v1/runs/${runId}:fork`, { method: 'POST', body: JSON.stringify({ mode, fromSeq }) });
}

describe('ADR 0751 — a fork at a suspended checkpoint inherits the gate', () => {
  for (const mode of ['replay', 'branch'] as const) {
    it(`${mode}: 201, the prefix is byte-equal, and the fork waits on a gate of its OWN`, async () => {
      const { runId, fromSeq } = await suspendedApproval();
      const f = await fork(runId, fromSeq, mode);
      expect(f.status, JSON.stringify(f.body)).toBe(201);
      const forkId = String(f.body['runId']);
      expect(await waitStatus(forkId, (s) => s.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s))).toBe('waiting-approval');

      const src = (await events(runId)).filter((e) => e.sequence < fromSeq);
      const inherited = (await events(forkId)).filter((e) => e.sequence < fromSeq);
      expect(inherited.map((e) => [e.type, e.nodeId ?? null, e.payload])).toEqual(src.map((e) => [e.type, e.nodeId ?? null, e.payload]));
      // The gate node never re-executed on the fork.
      expect((await events(forkId)).filter((e) => e.type === 'node.started' && e.nodeId === 'gate')).toHaveLength(1);

      const [srcGate] = await openInterrupts(runId);
      const [forkGate] = await openInterrupts(forkId);
      expect(forkGate, 'the fork must have a live gate to resolve').toBeDefined();
      expect(forkGate!.token, 'a token is a credential and is never shared between runs').not.toBe(srcGate!.token);
      expect(forkGate!.kind).toBe('approval');
      // ADR 0262 ruling #2 — the fork inherits the gate's createdAt (its deadline).
      const srcRow = await getSuspendManager().getByToken(srcGate!.token);
      const forkRow = await getSuspendManager().getByToken(forkGate!.token);
      expect(forkRow!.runId).toBe(forkId.slice(forkId.lastIndexOf('/') + 1));
      expect(forkRow!.interruptId).not.toBe(srcRow!.interruptId);
      expect(forkRow!.createdAt).toBe(srcRow!.createdAt);

      // The fork resumes through the NORMAL resolve path; the source stays suspended.
      const resolve = await api(`/v1/interrupts/${forkGate!.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'accept' } }) });
      expect(resolve.status, JSON.stringify(resolve.body)).toBeLessThan(300);
      expect(await waitStatus(forkId, (s) => ['completed', 'failed', 'cancelled'].includes(s))).toBe('completed');
      expect((await api<{ status: string }>(`/v1/runs/${runId}`)).body.status).toBe('waiting-approval');
      await api(`/v1/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
    });
  }

  it('a replay fork that settles on the gate reports no divergence, though the source ran on', async () => {
    const { runId, fromSeq } = await suspendedApproval();
    // The SOURCE continues past the fork point, so its tail holds observable
    // events (node.completed, run.completed) the settled fork has not reached.
    // Comparing now would manufacture a divergence; only a terminal fork compares.
    const [srcGate] = await openInterrupts(runId);
    await api(`/v1/interrupts/${srcGate!.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'accept' } }) });
    expect(await waitStatus(runId, (s) => s === 'completed')).toBe('completed');
    const f = await fork(runId, fromSeq, 'replay');
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const forkId = String(f.body['runId']);
    expect(await waitStatus(forkId, (s) => s.startsWith('waiting'))).toBe('waiting-approval');
    await new Promise((r) => setTimeout(r, 150));
    expect((await events(forkId)).filter((e) => e.type === 'replay.diverged')).toHaveLength(0);
    await api(`/v1/runs/${forkId}/cancel`, { method: 'POST', body: '{}' });
  });

  it('a fork OF A FORK re-creates the gate from the grandparent the copied event names', async () => {
    const { runId, fromSeq } = await suspendedApproval();
    const f1 = String((await fork(runId, fromSeq, 'branch')).body['runId']);
    expect(await waitStatus(f1, (s) => s.startsWith('waiting'))).toBe('waiting-approval');
    const bareF1 = f1.slice(f1.lastIndexOf('/') + 1);
    const f2res = await fork(bareF1, await appendMarker(bareF1), 'branch');
    expect(f2res.status).toBe(201);
    const f2 = String(f2res.body['runId']);
    expect(await waitStatus(f2, (s) => s.startsWith('waiting') || s === 'failed')).toBe('waiting-approval');
    expect(await openInterrupts(f2)).toHaveLength(1);
    for (const id of [f2, f1, runId]) await api(`/v1/runs/${id}/cancel`, { method: 'POST', body: '{}' });
  });

  it('a conversation gate keeps the recorded conversationId, so the copied transcript stays addressable', async () => {
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId: 'adr0751.conversation', nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [],
    }) });
    const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'adr0751.conversation', inputs: { provider: 'mock', model: 'mock-1' }, tenantId: '_anon' }) });
    const runId = create.body.runId;
    expect((await waitStatus(runId, (s) => s.startsWith('waiting')))).toMatch(/^waiting/);
    const f = await fork(runId, await appendMarker(runId), 'branch');
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const forkId = String(f.body['runId']);
    expect(await waitStatus(forkId, (s) => s.startsWith('waiting') || s === 'failed')).toMatch(/^waiting/);
    const [gate] = await openInterrupts(forkId);
    expect(gate?.kind).toBe('conversation');
    expect(gate?.data?.['conversationId']).toBe(`${runId}:gate:0`);
    for (const id of [forkId, runId]) await api(`/v1/runs/${id}/cancel`, { method: 'POST', body: '{}' });
  });
});

describe('ADR 0751 — the pieces', () => {
  it('snapshotFromEventPrefix restores an open gate as suspended with its kind, and a closed one as completed', () => {
    const open = snapshotFromEventPrefix([
      { type: 'node.started', nodeId: 'a', payload: {} },
      { type: 'node.completed', nodeId: 'a', payload: { outputs: { x: 1 } } },
      { type: 'node.started', nodeId: 'gate', payload: {} },
      { type: 'node.suspended', nodeId: 'gate', payload: { interruptId: 'i1', kind: 'approval' } },
    ]);
    expect(open.nodeState).toEqual([['a', 'completed'], ['gate', 'suspended']]);
    expect(open.suspendedKinds).toEqual([['gate', 'approval']]);
    const closed = snapshotFromEventPrefix([
      { type: 'node.suspended', nodeId: 'gate', payload: { interruptId: 'i1', kind: 'approval' } },
      { type: 'node.completed', nodeId: 'gate', payload: { outputs: {} } },
    ]);
    expect(closed.nodeState).toEqual([['gate', 'completed']]);
    expect(closed.suspendedKinds).toBeUndefined();
  });

  /** A fork `f` of `p` in tenant `t`, whose prefix names `interruptId` for node `gate`. */
  function harness(rows: InterruptRecord[], named: string) {
    const runs: Record<string, RunRecord> = {
      p: { runId: 'p', workflowId: 'w', tenantId: 't', status: 'waiting-approval', inputs: {}, metadata: {}, configurable: {}, createdAt: '', updatedAt: '' },
      f: { runId: 'f', workflowId: 'w', tenantId: 't', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: '', updatedAt: '', parentRunId: 'p', parentSeq: 5, forkMode: 'branch' },
    };
    const log: EventRecord[] = [{ eventId: 'e', runId: 'f', sequence: 2, type: 'node.suspended', nodeId: 'gate', payload: { interruptId: named, kind: 'approval' }, timestamp: '' }];
    const created: Json[] = [];
    const storage = {
      getRun: async (id: string) => runs[id] ?? null,
      listEvents: async () => log,
      getInterrupt: async (id: string) => rows.find((r) => r.interruptId === id) ?? null,
      getInterruptByNode: async (runId: string, nodeId: string) => rows.find((r) => r.runId === runId && r.nodeId === nodeId) ?? null,
    };
    const open: InterruptRecord[] = [];
    const suspend = {
      listOpen: async () => open,
      createInterrupt: async (i: Json) => { created.push(i); const rec = { ...i, interruptId: `new-${created.length}`, token: 't' } as unknown as InterruptRecord; open.push(rec); return rec; },
    } as unknown as ReturnType<typeof getSuspendManager>;
    return { run: runs['f']!, storage, suspend, created };
  }
  const row = (runId: string, interruptId: string): InterruptRecord => ({ interruptId, runId, nodeId: 'gate', kind: 'approval', token: 'x', data: { title: 'T' }, createdAt: '2026-01-01T00:00:00.000Z' });

  it('is idempotent: a second call re-creates nothing', async () => {
    const h = harness([row('p', 'i1')], 'i1');
    expect((await ensureForkInterrupts({ ...h, suspendedNodeIds: ['gate'] })).recreated).toEqual(['gate']);
    expect((await ensureForkInterrupts({ ...h, suspendedNodeIds: ['gate'] })).recreated).toEqual([]);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ runId: 'f', nodeId: 'gate', kind: 'approval', data: { title: 'T' }, createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('ADR 0755 (WIT-FORK-1): a sub-run CHILD is not a fork — parentRunId without forkMode re-creates nothing and fails nothing', async () => {
    const h = harness([row('p', 'i1')], 'i1');
    const child = { ...h.run, forkMode: undefined, parentSeq: undefined };
    const out = await ensureForkInterrupts({ ...h, run: child, suspendedNodeIds: ['gate'] });
    expect(out).toEqual({ recreated: [], unrecoverable: [], kinds: [] });
    expect(h.created).toHaveLength(0);
  });

  it('refuses an interrupt the prefix names that belongs to no ancestor — and does not fall back', async () => {
    const h = harness([row('stranger', 'i9'), row('p', 'i1')], 'i9');
    const out = await ensureForkInterrupts({ ...h, suspendedNodeIds: ['gate'] });
    expect(out.unrecoverable).toEqual(['gate']);
    expect(h.created).toHaveLength(0);
  });
});

describe('ADR 0755 (FORKINT-2) — a fork orphaned between its 201 and its dispatch recovers as the SAME fork', () => {
  it('the sweeper resumes it from the persisted checkpoint: the gate never re-executes and keeps the source deadline', async () => {
    const { runId, fromSeq } = await suspendedApproval();
    const { storage } = sweeperDeps;
    const source = (await storage.getRun(runId))!;
    const prefix = (await storage.listEvents(runId, { fromSeq: -1, limit: 1000 })).filter((e) => e.sequence < fromSeq);
    // Exactly what the :fork route persists before its 201 — then "crash": no dispatch.
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const forkId = `run-forkint2-${Math.random().toString(36).slice(2)}`;
    const crashed: RunRecord = {
      ...source,
      runId: forkId,
      status: 'pending',
      parentRunId: runId,
      parentSeq: fromSeq,
      forkMode: 'branch',
      schedulerSnapshot: JSON.stringify(snapshotFromEventPrefix(prefix)),
      createdAt: old,
      updatedAt: old,
    };
    delete (crashed as { dispatchOwner?: unknown }).dispatchOwner;
    delete (crashed as { dispatchLeaseUntil?: unknown }).dispatchLeaseUntil;
    await storage.insertRun(crashed);
    for (const ev of prefix) {
      await getEventLog().append({ runId: forkId, type: ev.type, nodeId: ev.nodeId, payload: ev.payload, causationId: ev.eventId, timestamp: ev.timestamp });
    }
    expect(forkDispatchOptions(crashed).resumeSnapshot, 'precondition: the checkpoint is durable').toBeDefined();

    expect(await sweepOrphanedRuns(sweeperDeps, 'forkint2-worker')).toBeGreaterThanOrEqual(1);
    expect(await waitStatus(forkId, (s) => s.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s))).toBe('waiting-approval');
    // The copied prefix did not re-execute: one gate start, the inherited one.
    expect((await events(forkId)).filter((e) => e.type === 'node.started' && e.nodeId === 'gate')).toHaveLength(1);
    const [srcGate] = await openInterrupts(runId);
    const [forkGate] = await openInterrupts(forkId);
    expect(forkGate).toBeDefined();
    const srcRow = await getSuspendManager().getByToken(srcGate!.token);
    const forkRow = await getSuspendManager().getByToken(forkGate!.token);
    expect(forkRow!.createdAt, 'a re-executed gate would mint a LATER deadline').toBe(srcRow!.createdAt);
    await api(`/v1/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
    await api(`/v1/runs/${forkId}/cancel`, { method: 'POST', body: '{}' });
  });

  it('a sub-run child (parentRunId, no forkMode) gets no fork options', () => {
    expect(forkDispatchOptions({ runId: 'c', parentRunId: 'p', schedulerSnapshot: '{}' } as RunRecord)).toEqual({});
  });

  it('ADR 0754 (WIT-FORK-2) — two CONCURRENT deliveries of one fork re-create the gate ONCE: the execution claim fences them', async () => {
    const { runId, fromSeq } = await suspendedApproval();
    const { storage, hostSuite } = sweeperDeps;
    const source = (await storage.getRun(runId))!;
    const prefix = (await storage.listEvents(runId, { fromSeq: -1, limit: 1000 })).filter((e) => e.sequence < fromSeq);
    const forkId = `run-forkint-race-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    const fork: RunRecord = {
      ...source, runId: forkId, status: 'pending', parentRunId: runId, parentSeq: fromSeq, forkMode: 'branch',
      schedulerSnapshot: JSON.stringify(snapshotFromEventPrefix(prefix)), createdAt: now, updatedAt: now,
    };
    delete (fork as { dispatchOwner?: unknown }).dispatchOwner;
    delete (fork as { dispatchLeaseUntil?: unknown }).dispatchLeaseUntil;
    await storage.insertRun(fork);
    for (const ev of prefix) {
      await getEventLog().append({ runId: forkId, type: ev.type, nodeId: ev.nodeId, payload: ev.payload, causationId: ev.eventId, timestamp: ev.timestamp });
    }
    const wf = (await hostSuite.workflowCatalog.getWorkflow(fork.workflowId))!;
    const deliver = () => executeRun(storage, fork, wf.definition, { policyResolver: hostSuite.providerPolicyResolver, ...forkDispatchOptions(fork) });
    // A checkpoint resume WAITS for the holder of the claim (ADR 0740's resume
    // wait) instead of being refused, so the two deliveries serialize: the second
    // finds the first's re-created gate open and re-creates nothing.
    await Promise.all([deliver(), deliver()]);
    const open = await storage.listOpenInterrupts(forkId);
    expect(open.filter((i) => i.nodeId === 'gate'), 'one resolvable gate — never a hidden second token').toHaveLength(1);
    await api(`/v1/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
    await api(`/v1/runs/${forkId}/cancel`, { method: 'POST', body: '{}' });
  });
});
