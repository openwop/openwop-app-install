/**
 * ADR 0964 D1 — `core.subWorkflow` is replay-served.
 *
 * Before: `core.subWorkflow` was in no side-effect set, so a replay fork re-executed it,
 * and the dispatcher minted a FRESH, non-replay child run (`randomUUID()`, no source
 * outcomes). Every side effect inside the child fired again. Now the node is
 * `sideEffecting`; a replay fork serves its recorded outcome and re-applies the
 * `outputMapping` writes it recorded (`parentVariableWrites`).
 *
 * Witness A (through the real app):
 *  - the live run dispatches ONE child, whose side-effect node and pure node each run once;
 *  - a replay fork completes with ZERO new child runs, both counters unchanged, and the
 *    parent bag equal to the source's (the mapped value is back);
 *  - a branch fork re-dispatches: exactly one new child run.
 * Old-shape sources (recorded before D1, no `parentVariableWrites`) rebuild the writes
 * from the source child's durable bag, and fail closed when it is gone.
 * The undefined-skip (`node-packs.md`: never overwrite a parent variable from an
 * undefined child source) is pinned on the fold.
 *
 * Mapped secret boundary (recovery correction 2026-10-25): a key only the child resolved
 * never reaches the child's or parent's durable bag, the parent's events or a replay;
 * each holds the redaction marker. The evidence an old-shape replay reads is the
 * DURABLE bag: never a warm cache, and corrupt or unreadable evidence fails closed.
 *
 * BORN RED: without the `sideEffecting` flag, the replay fork starts a new child and
 * the counters move. Measured sabotage (wave 77, each red): dropping the flag, the
 * re-apply, the recorded writes, the fold's undefined skip, the seal or the durable
 * strip; reading the warm cache; arming a branch fork as a replay.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client, type Res } from './planningHarness.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { tryDurableStorage } from '../src/host/durable/durableStore.js';
import { seedRunVariables, snapshotRunVariables } from '../src/host/variablesRuntime.js';
import { applyServedSubWorkflow } from '../src/executor/subWorkflowReplay.js';
import { foldChildOutputMapping } from '../src/executor/subWorkflowDispatcher.js';
import { bareRunId } from './support/bareRunId.js';
import { registerRunSecret, getRunSecrets } from '../src/byok/ephemeralRunSecrets.js';
const CHILD_SECRET = 'opaque-child-provider-material-0964';

let BASE = '';
let close: () => Promise<void>;
const counts = { effect: 0, pure: 0 };

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; close = h.close;
  await enableToggle('users', 'on');
  getNodeRegistry().register({
    typeId: 'test.adr0964.effect', version: '1.0.0', sideEffecting: true,
    async execute(ctx) { counts.effect++; ctx.variables?.set('out', 'from-the-child'); return { status: 'success', outputs: { sent: true } }; },
  });
  getNodeRegistry().register({
    typeId: 'test.adr0964.pure', version: '1.0.0',
    async execute() { counts.pure++; return { status: 'success', outputs: {} }; },
  });
  getNodeRegistry().register({
    typeId: 'test.adr0964.secret', version: '1.0.0', sideEffecting: true,
    async execute(ctx) {
      // A child can resolve a provider key the parent never resolved. The
      // existing BYOK boundary registers it before node code receives it.
      registerRunSecret(ctx.runId, 'child-provider', CHILD_SECRET);
      ctx.variables?.set('out', { nested: `credential: ${CHILD_SECRET}` });
      return { status: 'success', outputs: {} };
    },
  });
}, 120_000);
afterAll(async () => { await close(); });

const TERMINAL = ['completed', 'failed', 'cancelled'];
async function settle(c: Client, runId: string): Promise<string> {
  let s = '';
  // A run has no settle hook to await: poll its status until terminal.
  await vi.waitFor(async () => {
    const read: Res<{ status?: string }> = await c.get(`/runs/${runId}`);
    s = read.body.status ?? '';
    expect(TERMINAL).toContain(s);
  }, { timeout: 20_000, interval: 25 });
  return s;
}
/** A run id from a create or fork reply, after its status is checked. */
async function runIdOf(reply: Promise<Res<{ runId: string }>>): Promise<string> {
  const r = await reply;
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.runId;
}

describe('ADR 0964 D1 — a replay fork of a parent serves its sub-workflow', () => {
  it('Witness A: live → one child; replay fork → zero children, zero effects, same bag; branch fork → one new child', async () => {
    const c = makeClient(() => BASE);
    expect((await c.post('/host/openwop-app/test/login', { email: uniqEmail('d1'), tenantId: `org:d1-${Date.now()}` })).status).toBe(201);
    const k = Date.now();
    const child = `test.d1.child.${k}`;
    const parent = `test.d1.parent.${k}`;
    registerWorkflow({ workflowId: child, variables: [{ name: 'out' }], nodes: [
      { nodeId: 'eff', typeId: 'test.adr0964.effect', config: {} },
      { nodeId: 'pure', typeId: 'test.adr0964.pure', config: {} },
    ], edges: [{ edgeId: 'e', sourceNodeId: 'eff', targetNodeId: 'pure' }] });
    registerWorkflow({ workflowId: parent, nodes: [
      { nodeId: 'sub', typeId: 'core.subWorkflow', config: { workflowId: child, outputMapping: { seen: 'out' } } },
    ], edges: [] });

    const storage = tryDurableStorage()!;
    const runId = await runIdOf(c.post('/runs', { workflowId: parent, inputs: {} }));
    expect(await settle(c, runId)).toBe('completed');
    expect(counts).toEqual({ effect: 1, pure: 1 });
    expect(await storage.listRunsByParent(bareRunId(runId))).toHaveLength(1);
    expect(snapshotRunVariables(bareRunId(runId))?.seen).toBe('from-the-child');

    const forkId = await runIdOf(c.post(`/runs/${runId}:fork`, { mode: 'replay' }));
    expect(await settle(c, forkId), 'served, never re-dispatched').toBe('completed');
    expect(counts, 'a replay fork fired the child\'s nodes again').toEqual({ effect: 1, pure: 1 });
    expect(await storage.listRunsByParent(bareRunId(forkId)), 'a replay fork started a child run').toHaveLength(0);
    expect(snapshotRunVariables(bareRunId(forkId))?.seen, 'the served node must re-apply its outputMapping').toBe('from-the-child');
    expect(snapshotRunVariables(bareRunId(forkId)), 'the fork\'s bag is the source\'s').toEqual(snapshotRunVariables(bareRunId(runId)));

    const branchId = await runIdOf(c.post(`/runs/${runId}:fork`, { mode: 'branch', fromSeq: 0 }));
    expect(await settle(c, branchId)).toBe('completed');
    expect(await storage.listRunsByParent(bareRunId(branchId)), 'a branch is a new execution').toHaveLength(1);
    expect(counts).toEqual({ effect: 2, pure: 2 });
  }, 30_000);
});

describe('ADR 0964 D1 — mapped child-secret boundary', () => {
  it('a key resolved only by the completed child never appears in parent evidence or replay', async () => {
    const c = makeClient(() => BASE);
    expect((await c.post('/host/openwop-app/test/login', { email: uniqEmail('d1-secret'), tenantId: `org:d1-secret-${Date.now()}` })).status).toBe(201);
    const k = Date.now();
    const child = `test.d1.secret-child.${k}`;
    const parent = `test.d1.secret-parent.${k}`;
    registerWorkflow({ workflowId: child, variables: [{ name: 'out' }], nodes: [{ nodeId: 'secret', typeId: 'test.adr0964.secret', config: {} }], edges: [] });
    registerWorkflow({ workflowId: parent, nodes: [{ nodeId: 'sub', typeId: 'core.subWorkflow', config: { workflowId: child, outputMapping: { seen: 'out' } } }], edges: [] });
    const publicRunId = await runIdOf(c.post('/runs', { workflowId: parent, inputs: {} }));
    const runId = bareRunId(publicRunId);
    expect(await settle(c, publicRunId)).toBe('completed');
    const storage = tryDurableStorage();
    if (!storage) throw new Error('Planning storage missing');
    const children = await storage.listRunsByParent(runId);
    expect(children).toHaveLength(1);
    const childRunId = children[0]?.runId;
    if (!childRunId) throw new Error('Child missing');
    expect(getRunSecrets(childRunId)).toEqual({});
    // A durable bag that was never written would pass a bare `not.toContain`.
    const durableBag = async (id: string): Promise<string> => {
      let raw: string | null = null;
      await vi.waitFor(async () => { raw = await storage.kvGet(`runvars:${id}`); expect(raw).toBeTruthy(); });
      return raw ?? '';
    };
    const childBag = await durableBag(childRunId);
    expect(childBag).not.toContain(CHILD_SECRET);
    expect(childBag).toContain('<<redacted:child-provider>>');
    const recorded = JSON.stringify(await storage.listEvents(runId));
    expect(recorded).not.toContain(CHILD_SECRET);
    expect(recorded).toContain('<<redacted:child-provider>>');
    const parentBag = await durableBag(runId);
    expect(parentBag).not.toContain(CHILD_SECRET);
    expect(parentBag).toContain('<<redacted:child-provider>>');
    const publicForkId = await runIdOf(c.post(`/runs/${publicRunId}:fork`, { mode: 'replay' }));
    const forkId = bareRunId(publicForkId);
    expect(await settle(c, publicForkId)).toBe('completed');
    expect(await storage.listRunsByParent(forkId)).toHaveLength(0);
    expect(JSON.stringify(snapshotRunVariables(forkId))).not.toContain(CHILD_SECRET);
    expect(snapshotRunVariables(forkId)?.seen).toEqual({ nested: 'credential: <<redacted:child-provider>>' });
  }, 30_000);
});

describe('ADR 0964 D1 — serving rules', () => {
  it('an erased old-shape child cannot supply its still-cached variable bag to a replay', async () => {
    const storage = tryDurableStorage();
    if (!storage) throw new Error('Planning storage missing');
    const childRunId = 'run-d1-erased-child';
    seedRunVariables(childRunId, [{ name: 'out' }], { out: 'erased evidence' });
    expect(snapshotRunVariables(childRunId)?.out).toBe('erased evidence');
    await vi.waitFor(async () => expect(await storage.kvGet(`runvars:${childRunId}`)).toBeTruthy());
    // Run deletion and retention own the durable cascade. The shared process
    // can still have a warm cache from before that cross-instance deletion.
    await storage.kvDelete(`runvars:${childRunId}`);
    expect(await storage.kvGet(`runvars:${childRunId}`)).toBeNull();
    seedRunVariables('run-d1-erased-parent', [], {});
    await expect(applyServedSubWorkflow('run-d1-erased-parent', { outputMapping: { seen: 'out' } }, { childRunId, childStatus: 'completed' })).rejects.toThrow(/never re-dispatches/);
    expect(snapshotRunVariables('run-d1-erased-parent')).not.toHaveProperty('seen');
  });

  it('an old-shape replay uses the durable terminal bag instead of a stale warm cache', async () => {
    const storage = tryDurableStorage();
    if (!storage) throw new Error('Planning storage missing');
    const childRunId = 'run-d1-refreshed-child';
    seedRunVariables(childRunId, [{ name: 'out' }], { out: 'stale cache' });
    await vi.waitFor(async () => expect(await storage.kvGet(`runvars:${childRunId}`)).toBeTruthy());
    await storage.kvSet(`runvars:${childRunId}`, JSON.stringify({ out: 'durable terminal result' }));
    seedRunVariables('run-d1-refreshed-parent', [], {});
    await applyServedSubWorkflow('run-d1-refreshed-parent', { outputMapping: { seen: 'out' } }, { childRunId, childStatus: 'completed' });
    expect(snapshotRunVariables('run-d1-refreshed-parent')?.seen).toBe('durable terminal result');
  });

  it('corrupt or unreadable old-shape evidence never falls back to the warm cache', async () => {
    const storage = tryDurableStorage();
    if (!storage) throw new Error('Planning storage missing');
    const childRunId = 'run-d1-corrupt-child';
    seedRunVariables(childRunId, [{ name: 'out' }], { out: 'cached result' });
    await vi.waitFor(async () => expect(await storage.kvGet(`runvars:${childRunId}`)).toBeTruthy());
    seedRunVariables('run-d1-corrupt-parent', [], {});
    for (const raw of ['{broken', 'null', '["not a bag"]']) {
      await storage.kvSet(`runvars:${childRunId}`, raw);
      await expect(applyServedSubWorkflow('run-d1-corrupt-parent', { outputMapping: { seen: 'out' } }, { childRunId, childStatus: 'completed' })).rejects.toThrow(/never re-dispatches/);
      expect(snapshotRunVariables('run-d1-corrupt-parent')).not.toHaveProperty('seen');
    }
    const read = vi.spyOn(storage, 'kvGet').mockRejectedValueOnce(new Error('storage offline'));
    try {
      await expect(applyServedSubWorkflow('run-d1-corrupt-parent', { outputMapping: { seen: 'out' } }, { childRunId, childStatus: 'completed' })).rejects.toThrow(/never re-dispatches/);
      expect(snapshotRunVariables('run-d1-corrupt-parent')).not.toHaveProperty('seen');
    } finally { read.mockRestore(); }
  });

  it('recorded writes are applied as recorded', async () => {
    seedRunVariables('run-d1-a', [], {});
    await applyServedSubWorkflow('run-d1-a', { outputMapping: { seen: 'out' } }, { childRunId: 'c', childStatus: 'completed', parentVariableWrites: { seen: 'v1' } });
    expect(snapshotRunVariables('run-d1-a')?.seen).toBe('v1');
  });

  it('an old-shape source rebuilds the writes from the source child\'s bag; a missing bag fails closed', async () => {
    const storage = tryDurableStorage();
    if (!storage) throw new Error('Planning storage missing');
    seedRunVariables('run-d1-child', [{ name: 'out' }], { out: 'old-run-value' });
    await vi.waitFor(async () => expect(await storage.kvGet('runvars:run-d1-child')).toBeTruthy());
    seedRunVariables('run-d1-b', [], {});
    await applyServedSubWorkflow('run-d1-b', { outputMapping: { seen: 'out', gone: 'absent' } }, { childRunId: 'run-d1-child', childStatus: 'completed' });
    expect(snapshotRunVariables('run-d1-b')).toMatchObject({ seen: 'old-run-value' });
    expect(snapshotRunVariables('run-d1-b')).not.toHaveProperty('gone');

    await expect(applyServedSubWorkflow('run-d1-b', { outputMapping: { seen: 'out' } }, { childRunId: 'run-d1-never', childStatus: 'completed' })).rejects.toThrow(/never re-dispatches/);
    // No mapping, or a child that did not complete: nothing to apply, no failure.
    await expect(applyServedSubWorkflow('run-d1-b', {}, { childRunId: 'run-d1-never', childStatus: 'completed' })).resolves.toBeUndefined();
    await expect(applyServedSubWorkflow('run-d1-b', { outputMapping: { seen: 'out' } }, { childRunId: 'run-d1-never', childStatus: 'failed' })).resolves.toBeUndefined();
  });

  it('the fold never overwrites a parent variable from an undefined child source', () => {
    seedRunVariables('run-d1-c', [{ name: 'keep' }], { keep: 'parent-value' });
    const writes = foldChildOutputMapping('run-d1-c', { keep: 'missing', got: 'present' }, { present: 1 });
    expect(writes).toEqual({ got: 1 });
    expect(snapshotRunVariables('run-d1-c')).toMatchObject({ keep: 'parent-value', got: 1 });
  });
});
