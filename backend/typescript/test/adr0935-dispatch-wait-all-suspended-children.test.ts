/**
 * ADR 0935 — RFC 0118 wait-all: "the dispatch node remains suspended until
 * every dispatched child reaches a terminal state".
 *
 * A parallel wave whose child stops at an approval gate used to join at once,
 * folding the waiting child as `failed` (`joinOutcome: 'partial'`), and the
 * parent ran on without it. Now the parent waits, joins when the child's gate is
 * decided, keeps its `.dispatched` port shape, and carries on with the decision
 * that followed the wave.
 *
 * Route-level: the join rides the run-terminal hook, the real executor's
 * re-invoke resume, and the interrupt routes.
 *
 * Sabotage: mapping a waiting child to `failed` again (the old line in
 * `bootstrap/nodes.ts`) reds the first case at "parent waits"; dropping the
 * `registerDispatchWaitAll` boot line reds it at "parent completes"; dropping
 * the `isDispatchWaitInterrupt` guard in `resolveAndResume` reds the second.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { openStorage } from '../src/storage/index.js';
import { appendDispatchWaitResolution, claimDispatchWaitResume, DISPATCH_WAIT_EVENT_TYPE, isDispatchWaitInterrupt, reconcileDispatchWaits, storedDispatchWave, type WaveCorrelation, type WaveJoinResolution } from '../src/host/dispatchWaitAll.js';
import { __resetAllRunVariablesForTests, snapshotRunVariables } from '../src/host/variablesRuntime.js';
import { randomUUID } from 'node:crypto';
import type { InterruptRecord, RunRecord } from '../src/types.js';
import { RUN_DISPATCH_LEASE_MS } from '../src/executor/executor.js';
import { toWireBoundId } from '../src/host/v2Ids.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const DSN = `sqlite://${join(mkdtempSync(join(tmpdir(), 'owp-dispatch-wait-')), 'runs.db')}`;
let storage: Storage;
let hostSuite: HostAdapterSuite;
const reopened: Storage[] = [];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = DSN;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: DSN, serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  hostSuite = app.locals.hostSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); for (const db of reopened) await db.close(); await storage.close(); });
afterEach(() => vi.restoreAllMocks());

type Json = Record<string, unknown>;
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
const TERMINAL = ['completed', 'failed', 'cancelled'];
async function waitStatus(runId: string, pred: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 300; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
type Ev = { sequence: number; type: string; nodeId?: string; payload?: Json };
async function events(runId: string): Promise<Ev[]> {
  return (await api<{ events: Ev[] }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
}
type Open = { token: string; nodeId: string; kind: string; data?: Json };
async function openInterrupts(runId: string): Promise<Open[]> {
  return (await api<{ interrupts: Open[] }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
}
async function register(def: Json): Promise<void> {
  const r = await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify(def) });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}

let seq = 0;
/** A parent fanning out to a child that completes and a child with an approval gate. */
async function startWave(twoWaves = false): Promise<{ parentId: string; gateChildId: string }> {
  const s = `${Date.now()}-${seq++}`;
  const ok = `adr0935.ok.${s}`;
  const gated = `adr0935.gated.${s}`;
  const parent = `adr0935.parent.${s}`;
  await register({ workflowId: ok, nodes: [{ nodeId: 'n', typeId: 'core.noop' }], edges: [] });
  await register({ workflowId: gated, nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'ok?' } }], edges: [] });
  const early = `adr0935.early.${s}`;
  const early2 = `adr0935.early2.${s}`;
  if (twoWaves) {
    await register({ workflowId: early, variables: [{ name: 'prefix', defaultValue: 'kept-from-first-wave' }], nodes: [{ nodeId: 'n', typeId: 'core.noop' }], edges: [] });
    await register({ workflowId: early2, nodes: [{ nodeId: 'n', typeId: 'core.noop' }], edges: [] });
  }
  await register({
    workflowId: parent,
    nodes: [
      { nodeId: 'sup', typeId: 'core.orchestrator.supervisor', config: { mockDispatchPlan: [
        ...(twoWaves ? [{ kind: 'next-worker', nextWorkerIds: [early, early2] }] : []),
        { kind: 'next-worker', nextWorkerIds: [ok, gated] },
        { kind: 'terminate', reason: 'channels-dispatched' },
      ] } },
      { nodeId: 'dispatch', typeId: 'core.dispatch', config: { fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' }, ...(twoWaves ? { outputMapping: { prefixValue: 'prefix' } } : {}) } },
      { nodeId: 'after', typeId: 'core.identity' },
    ],
    edges: [
      { edgeId: 'e1', sourceNodeId: 'sup', targetNodeId: 'dispatch' },
      { edgeId: 'e2', sourceNodeId: 'dispatch', sourcePort: 'dispatched', targetNodeId: 'after' },
    ],
  });
  const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId: parent }) });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const parentId = create.body.runId;
  // The gated child suspends; the parent must too.
  const parentStatus = await waitStatus(parentId, (st) => st.startsWith('waiting') || TERMINAL.includes(st));
  expect(parentStatus, 'parent waits for its waiting child (RFC 0118 wait-all)').toMatch(/^waiting/);
  const dispatched = (await events(parentId)).filter((e) => e.type === 'node.dispatched').map((e) => e.payload as { childRunId: string; childWorkflowId: string });
  const gateChildId = dispatched.find((d) => d.childWorkflowId === gated)?.childRunId;
  expect(gateChildId).toBeDefined();
  return { parentId, gateChildId: gateChildId! };
}

describe('ADR 0935 — a parallel wave waits for a child at its approval gate', () => {
  it('suspends, joins satisfied once the gate is approved, then runs the next decision and the downstream node', async () => {
    const { parentId, gateChildId } = await startWave();
    expect((await events(parentId)).some((e) => e.type === 'dispatch.joined'), 'no join while a child waits').toBe(false);

    const [gate] = await openInterrupts(gateChildId);
    expect(gate?.kind).toBe('approval');
    const resolved = await api(`/interrupts/${gate!.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'accept' } }) });
    expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(300);

    expect(await waitStatus(parentId, (st) => TERMINAL.includes(st)), 'parent completes after the join').toBe('completed');
    const evs = await events(parentId);
    const joins = evs.filter((e) => e.type === 'dispatch.joined');
    expect(joins).toHaveLength(1);
    expect(joins[0]!.payload).toMatchObject({ joinOutcome: 'satisfied', completedCount: 2, failedCount: 0 });
    // The late child is last in the recorded terminal order.
    const mergeOrder = (joins[0]!.payload as { mergeOrder: string[] }).mergeOrder;
    expect(mergeOrder).toHaveLength(2);
    expect(mergeOrder[1]).toBe(bareRunId(gateChildId));
    // Decisions before the wave are not re-emitted on the re-invoke.
    expect(evs.filter((e) => e.type === 'orchestrator.decided' && e.nodeId === 'dispatch')).toHaveLength(2);
    expect(evs.filter((e) => e.type === 'dispatch.fanned-out')).toHaveLength(1);
    // The `.dispatched` port carried both children to the downstream node.
    expect(evs.some((e) => e.type === 'node.completed' && e.nodeId === 'after')).toBe(true);
  });

  it('the wait itself cannot be resolved by a caller — its resume value would be the join', async () => {
    const { parentId } = await startWave();
    const [wait] = await openInterrupts(parentId);
    expect(wait?.kind).toBe('external-event');
    const forged = await api(`/interrupts/${wait!.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: {
      // Everything a reader of the interrupt can see — the route's own correlation check passes.
      ...(wait!.data?.['correlation'] as Json),
      terminals: [],
    } }) });
    expect(forged.status, JSON.stringify(forged.body)).toBe(403);
    expect((await api<{ status: string }>(`/runs/${parentId}`)).body.status).toMatch(/^waiting/);
    expect(await openInterrupts(parentId)).toHaveLength(1);
    await api(`/runs/${parentId}/cancel`, { method: 'POST', body: '{}' });
  });

  it('a rejected gate still joins: the child fails, the wave is partial, the parent goes on', async () => {
    const { parentId, gateChildId } = await startWave();
    const [gate] = await openInterrupts(gateChildId);
    await api(`/interrupts/${gate!.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'reject' } }) });
    expect(await waitStatus(parentId, (st) => TERMINAL.includes(st))).toBe('completed');
    const join = (await events(parentId)).find((e) => e.type === 'dispatch.joined');
    expect(join?.payload).toMatchObject({ joinOutcome: 'partial', completedCount: 1 });
  });

  it('recovers a terminal hint that fired before the parent wait was published', async () => {
    const insert = storage.insertInterrupt.bind(storage);
    const list = storage.listOpenInterrupts.bind(storage);
    let publishingParent = '';
    let observedEmpty = false;
    let release!: () => void;
    const emptyRead = new Promise<void>((r) => { release = r; });
    vi.spyOn(storage, 'listOpenInterrupts').mockImplementation(async (runId) => {
      const rows = await list(runId);
      if (runId === publishingParent && rows.length === 0) { observedEmpty = true; release(); }
      return rows;
    });
    vi.spyOn(storage, 'insertInterrupt').mockImplementation(async (record) => {
      if (isDispatchWaitInterrupt(record)) {
        publishingParent = record.runId;
        const wave = (record.data as { correlation: WaveCorrelation }).correlation;
        const child = wave.children.find((c) => !TERMINAL.includes(c.status));
        if (!child) throw new Error('fixture wave has no waiting child');
        const [gate] = await openInterrupts(child.childRunId);
        if (!gate) throw new Error('fixture child has no approval gate');
        await api(`/interrupts/${gate.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'accept' } }) });
        await emptyRead; // The real terminal hook observed no parent interrupt.
      }
      return insert(record);
    });
    const { parentId } = await startWave();
    expect(observedEmpty).toBe(true);
    expect((await api<{ status: string }>(`/runs/${parentId}`)).body.status).toBe('waiting-external');
    await reconcileDispatchWaits(storage, hostSuite);
    expect(await waitStatus(parentId, (s) => TERMINAL.includes(s))).toBe('completed');
    expect((await events(parentId)).filter((e) => e.type === 'dispatch.joined')).toHaveLength(1);
  });

  it('a fresh storage connection recovers a resolved undispatched wave and restores earlier children/mappings after cache loss', async () => {
    const { parentId, gateChildId } = await startWave(true);
    const parent = bareRunId(parentId);
    const list = storage.listOpenInterrupts.bind(storage);
    const [wait] = (await list(parent)).filter(isDispatchWaitInterrupt);
    if (!wait) throw new Error('fixture parent has no dispatch wait');
    // Model the lost terminal wakeup without changing the recorded child runs.
    let observed!: () => void;
    const suppressedHook = new Promise<void>((r) => { observed = r; });
    const suppress = vi.spyOn(storage, 'listOpenInterrupts').mockImplementation(async (runId) => {
      if (runId === parent) { observed(); return []; }
      return list(runId);
    });
    const [gate] = await openInterrupts(gateChildId);
    if (!gate) throw new Error('fixture child has no gate');
    await api(`/interrupts/${gate.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'accept' } }) });
    expect(await waitStatus(gateChildId, (s) => TERMINAL.includes(s))).toBe('completed');
    await suppressedHook;
    suppress.mockRestore();
    const wave = (wait.data as { correlation: WaveCorrelation }).correlation;
    expect(wave.priorChildren).toHaveLength(2);
    const ordered = [...wave.settledOrder, ...wave.children.map((c) => c.childRunId).filter((id) => !wave.settledOrder.includes(id))];
    const resolution: WaveJoinResolution = { fanOutEventId: wave.fanOutEventId, terminals: ordered.map((childRunId) => ({ childRunId, status: 'completed' })) };
    expect(await storage.resolveInterrupt(wait.interruptId, resolution, new Date().toISOString())).toBe(true);
    // Crash boundary: no resolution event and no queued resume, and the final
    // asynchronous parent variable writes are absent. Child bags remain durable.
    expect(await storage.findFirstEventByPayload(parent, 'interrupt.resolved', 'interruptId', wait.interruptId)).toBeNull();
    const variables = JSON.parse((await storage.kvGet(`runvars:${parent}`)) ?? '{}');
    delete variables['__dispatchWaitAll:dispatch']; delete variables.prefixValue;
    await storage.kvSet(`runvars:${parent}`, JSON.stringify(variables));
    __resetAllRunVariablesForTests();
    const fresh = await openStorage(DSN); reopened.push(fresh);
    // Closed-log parked rows are poison for forward appends. Put several
    // newer ones ahead of the valid parent: neither the newest window nor
    // round-robin page may be pinned forever by their permanent errors.
    const parentRow = await storage.getRun(parent);
    if (!parentRow) throw new Error('fixture parent vanished');
    const poison: string[] = [];
    for (let i = 0; i < 3; i++) {
      const runId = randomUUID(); const interruptId = randomUUID();
      poison.push(runId);
      await storage.insertRun({ ...parentRow, runId, createdAt: new Date(Date.now() + i + 1).toISOString() });
      await storage.insertInterrupt({ ...wait, runId, interruptId, token: `test-${interruptId}`, resolvedAt: new Date().toISOString(), resolvedValue: resolution });
      await storage.appendEvent({ eventId: randomUUID(), runId, nodeId: 'dispatch', type: 'node.suspended', timestamp: new Date().toISOString(),
        payload: { kind: 'external-event', interruptId } });
      await storage.appendEvent({ eventId: randomUUID(), runId, type: 'run.completed', timestamp: new Date().toISOString(), payload: {} });
    }
    for (let tick = 0; tick < 15; tick++) await reconcileDispatchWaits(fresh, hostSuite);
    expect(await waitStatus(parentId, (s) => TERMINAL.includes(s))).toBe('completed');
    const log = await events(parentId);
    expect(log.filter((e) => e.type === 'dispatch.fanned-out')).toHaveLength(2);
    expect(log.filter((e) => e.type === 'dispatch.joined')).toHaveLength(2);
    expect(log.filter((e) => e.type === 'orchestrator.decided' && e.nodeId === 'dispatch')).toHaveLength(3);
    const completed = log.find((e) => e.type === 'node.completed' && e.nodeId === 'dispatch');
    expect((completed?.payload?.outputs as { dispatched?: unknown[] })?.dispatched).toHaveLength(4);
    expect(snapshotRunVariables(parent)?.prefixValue).toBe('kept-from-first-wave');
    expect(log.filter((e) => e.type === 'interrupt.resolved'
      && e.payload?.interruptId === toWireBoundId(wait.interruptId, parentRow.tenantId!))).toHaveLength(1);
    for (const runId of poison) expect((await storage.listEvents(runId)).filter((e) => e.type === 'interrupt.resolved')).toHaveLength(0);
    await reconcileDispatchWaits(fresh, hostSuite);
    expect((await events(parentId)).filter((e) => e.type === 'dispatch.joined')).toHaveLength(2);
  });
});

describe('ADR 0935 — durable generation and history fences', () => {
  async function seedParent(): Promise<RunRecord> {
    const at = '2026-10-21T00:00:00.000Z';
    const row: RunRecord = { runId: randomUUID(), workflowId: 'generation-fixture', tenantId: 'dispatch-generation', status: 'waiting-external',
      inputs: {}, metadata: {}, configurable: {}, createdAt: at, updatedAt: at,
      schedulerSnapshot: JSON.stringify({ schemaVersion: 1, nodeState: [['a', 'suspended'], ['b', 'suspended']], nodeOutputs: [], nodeErrors: [] }) };
    await storage.insertRun(row);
    return row;
  }
  async function seedResolved(parent: RunRecord, nodeId: string): Promise<InterruptRecord> {
    const id = randomUUID();
    const childRunId = randomUUID();
    const wave: WaveCorrelation = { fanOutEventId: randomUUID(), decisionIndex: 0,
      children: [{ childRunId, workflowId: 'child', status: 'waiting-approval' }], settledOrder: [] };
    const value: WaveJoinResolution = { fanOutEventId: wave.fanOutEventId, terminals: [{ childRunId, status: 'completed' }] };
    const interrupt: InterruptRecord = { interruptId: id, runId: parent.runId, nodeId, kind: 'external-event', token: `test-${id}`,
      data: { eventType: DISPATCH_WAIT_EVENT_TYPE, correlation: wave, __resumeStyle: 'reinvoke', __resumeKey: `dispatch-wait-all:${nodeId}` },
      createdAt: parent.createdAt, resolvedAt: parent.updatedAt, resolvedValue: value };
    await storage.insertInterrupt(interrupt);
    await storage.appendEvent({ eventId: randomUUID(), runId: parent.runId, nodeId, type: 'node.suspended', timestamp: parent.createdAt,
      payload: { kind: interrupt.kind, interruptId: id } });
    return interrupt;
  }

  it('independent storage handles contend for one parent generation; an identical snapshot with a later suspension gets a new claim', async () => {
    const parent = await seedParent();
    const a = await seedResolved(parent, 'a');
    const b = await seedResolved(parent, 'b');
    const other = await openStorage(DSN); reopened.push(other);
    const result = await Promise.all([
      claimDispatchWaitResume(storage, a, a.resolvedValue, RUN_DISPATCH_LEASE_MS),
      claimDispatchWaitResume(other, b, b.resolvedValue, RUN_DISPATCH_LEASE_MS),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    const winner = result[0] ? a : b;
    // Same createdAt, same parent snapshot bytes, same node; event SEQUENCE is
    // the only reliable distinction from the preceding wave.
    const next = await seedResolved(parent, winner.nodeId);
    expect(await claimDispatchWaitResume(other, winner, winner.resolvedValue, RUN_DISPATCH_LEASE_MS)).toBeNull();
    expect((await claimDispatchWaitResume(other, next, next.resolvedValue, RUN_DISPATCH_LEASE_MS))?.runId).toBe(parent.runId);
    expect((await storedDispatchWave(parent.tenantId, parent.runId, winner.nodeId))?.fanOutEventId)
      .toBe((next.resolvedValue as WaveJoinResolution).fanOutEventId);
  });

  it('concurrent resolution history writes and a lost commit acknowledgement leave exactly one verified event', async () => {
    const parent = await seedParent();
    const wait = await seedResolved(parent, 'a');
    const find = storage.findFirstEventByPayload.bind(storage);
    const append = storage.appendEvent.bind(storage);
    let arrivals = 0; let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    vi.spyOn(storage, 'findFirstEventByPayload').mockImplementation(async (runId, type, key, value, opts) => {
      const event = await find(runId, type, key, value, opts);
      if (runId === parent.runId && type === 'interrupt.resolved' && arrivals < 2) {
        arrivals++; if (arrivals === 2) release(); await barrier;
      }
      return event;
    });
    let lostAck = false;
    vi.spyOn(storage, 'appendEvent').mockImplementation(async (input) => {
      const event = await append(input);
      if (input.runId === parent.runId && input.type === 'interrupt.resolved' && !lostAck) { lostAck = true; throw new Error('commit acknowledgement lost'); }
      return event;
    });
    await Promise.all([appendDispatchWaitResolution(storage, wait), appendDispatchWaitResolution(storage, wait)]);
    expect(lostAck).toBe(true);
    expect((await storage.listEvents(parent.runId)).filter((e) => e.type === 'interrupt.resolved')).toHaveLength(1);
  });

  it('malformed wave identity and incomplete/duplicate joins never acquire execution authority', async () => {
    const parent = await seedParent();
    const good = await seedResolved(parent, 'a');
    const wave = (good.data as { correlation: WaveCorrelation }).correlation;
    const value = good.resolvedValue as WaveJoinResolution;
    const variants = [
      { correlation: { ...wave, decisionIndex: undefined }, value },
      { correlation: { ...wave, children: [...wave.children, ...wave.children] }, value },
      { correlation: wave, value: { ...value, terminals: [] } },
      { correlation: wave, value: { ...value, terminals: [...value.terminals, ...value.terminals] } },
    ];
    const claim = vi.spyOn(storage, 'claimInvocation');
    for (const bad of variants) {
      const id = randomUUID();
      const row: InterruptRecord = { ...good, interruptId: id, token: `test-${id}`, data: { eventType: DISPATCH_WAIT_EVENT_TYPE, correlation: bad.correlation }, resolvedValue: bad.value };
      await storage.insertInterrupt(row);
      await storage.appendEvent({ eventId: randomUUID(), runId: parent.runId, nodeId: 'a', type: 'node.suspended', timestamp: parent.createdAt,
        payload: { kind: 'external-event', interruptId: id } });
      expect(await claimDispatchWaitResume(storage, row, bad.value, RUN_DISPATCH_LEASE_MS)).toBeNull();
      await expect(storedDispatchWave(parent.tenantId, parent.runId, 'a')).rejects.toThrow('dispatch_wait_invalid_stored_join');
    }
    expect(claim).not.toHaveBeenCalled();
  });

  it.each(['out-of-range', 'wrong-kind', 'wrong-workers'] as const)('refuses a resolved wave with %s decision before folding or dispatching', async (variant) => {
    const parent = await seedParent();
    const original = await seedResolved(parent, 'a');
    const id = randomUUID();
    const wave: WaveCorrelation = { fanOutEventId: randomUUID(), decisionIndex: variant === 'out-of-range' ? 999 : 0,
      children: ['child-a', 'child-b'].map((workflowId) => ({ childRunId: randomUUID(), workflowId, status: 'waiting-approval' })), settledOrder: [] };
    const value: WaveJoinResolution = { fanOutEventId: wave.fanOutEventId, terminals: wave.children.map((child) => ({ childRunId: child.childRunId, status: 'completed' })) };
    await storage.insertInterrupt({ ...original, interruptId: id, token: `test-${id}`, data: { eventType: DISPATCH_WAIT_EVENT_TYPE, correlation: wave }, resolvedValue: value });
    await storage.appendEvent({ eventId: randomUUID(), runId: parent.runId, nodeId: 'a', type: 'node.suspended', timestamp: parent.createdAt,
      payload: { kind: 'external-event', interruptId: id } });
    const before = await storage.listEvents(parent.runId);
    const vars = new Map<string, unknown>();
    const node = getNodeRegistry().get('core.dispatch');
    if (!node) throw new Error('core.dispatch is not registered');
    const result = await node.execute({ runId: parent.runId, nodeId: 'a', tenantId: parent.tenantId, attempt: 1, secrets: {}, configurable: {},
      inputs: { decisions: [{ kind: variant === 'wrong-kind' ? 'terminate' : 'next-worker', nextWorkerIds: variant === 'wrong-workers' ? ['other', 'child-b'] : ['child-a', 'child-b'] }] },
      config: { fanOutPolicy: 'parallel' }, variables: { get: (key) => vars.get(key), set: (key, v) => { vars.set(key, v); } },
      suspend: async () => value, emit: async () => { throw new Error('invalid wave must not emit'); } });
    expect(result).toMatchObject({ status: 'failure', error: { code: 'dispatch_wait_invalid_decision' } });
    expect(await storage.listEvents(parent.runId)).toEqual(before);
  });

  it('an observer at the waiting write sees its matching suspended snapshot in the same durable row', async () => {
    const read = await openStorage(DSN); reopened.push(read);
    const update = storage.updateRun.bind(storage);
    let observations = 0;
    vi.spyOn(storage, 'updateRun').mockImplementation(async (runId, patch) => {
      await update(runId, patch);
      if (patch.status === 'waiting-external') {
        const visible = await read.getRun(runId);
        expect(visible?.schedulerSnapshot).toBeTypeOf('string');
        const snapshot = JSON.parse(visible!.schedulerSnapshot!);
        expect(snapshot.nodeState).toContainEqual([visible!.currentNodeId, 'suspended']);
        observations++;
      }
    });
    const { parentId } = await startWave();
    expect(observations).toBe(1);
    await api(`/runs/${parentId}/cancel`, { method: 'POST', body: '{}' });
  });
});
