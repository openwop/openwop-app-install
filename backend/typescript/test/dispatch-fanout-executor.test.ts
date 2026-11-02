/**
 * RFC 0118 — the core.dispatch PARALLEL fan-out executor arm (bootstrap/nodes.ts), driven through
 * the real node + the real subWorkflowDispatcher with a CONTROLLED child executor.
 *
 * THE R1 GATE (replay determinism): two children write colliding outputMapping ({result: 'out'}).
 * The FIRST-dispatched child (idx 0, wf-a) is made to complete LAST; the SECOND (idx 1, wf-b)
 * completes FIRST. outputMapping is re-applied in the recorded `mergeOrder` (observed terminal
 * order), so last-in-mergeOrder = wf-a wins → parent `result === 'A'`. If the code wrongly applied
 * in dispatch/array order, `result` would be 'B'. mergeOrder is recorded on the core.dispatch.join
 * event so a :fork re-applies in the same order, never recomputed from wall-clock.
 *
 * TST-CVH-20. The completion order is forced by a GATE, not a sleep: wf-a's fake
 * run waits until wf-b has marked itself completed. Red when: outputMapping is
 * applied in dispatch order or reversed (`bootstrap/nodes.ts` finishWave),
 * `foldJoin` stops recording observed terminal order as mergeOrder, or the join
 * event loses its causation link to the fanOut event.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend, getEventLog } from '../src/executor/eventLog.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { setRunVariable } from '../src/host/variablesRuntime.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { NodeContext } from '../src/executor/types.js';
import { createHostAdapterSuite, type HostAdapterSuite } from '../src/host/index.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
ensureNodesRegistered();

// Each child's terminal `out` value; wf-a is GATED so it terminates LAST.
const CHILD_OUT: Record<string, string> = { 'wf-a': 'A', 'wf-b': 'B' };

// wf-a's fake run waits on this gate; wf-b opens it once it has completed. A fresh
// gate per parent run (keyed by the child's parent) so each case is self-contained.
const gates = new Map<string, { opened: Promise<void>; open: () => void }>();
function gateFor(parentRunId: string): { opened: Promise<void>; open: () => void } {
  let g = gates.get(parentRunId);
  if (!g) {
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    g = { opened, open };
    gates.set(parentRunId, g);
  }
  return g;
}

// Controlled child executor: seed the child's `out` var, then mark it completed. wf-a waits for
// wf-b → the FIRST-dispatched child finishes LAST → exercises mergeOrder vs dispatch order.
const fakeExecuteRun = async (_s: Storage, childRun: RunRecord): Promise<unknown> => {
  const gate = gateFor(String(childRun.parentRunId ?? ''));
  if (childRun.workflowId === 'wf-a') await gate.opened;
  setRunVariable(childRun.runId, 'out', CHILD_OUT[childRun.workflowId] ?? '?');
  await storage.updateRun(childRun.runId, { status: 'completed', updatedAt: new Date().toISOString() });
  if (childRun.workflowId === 'wf-b') gate.open();
  return undefined;
};

const realSuite = createHostAdapterSuite({ storage });
const fakeSuite: HostAdapterSuite = {
  ...realSuite,
  workflowCatalog: {
    getWorkflow: async (id: string) => ({ workflowId: id, definition: { workflowId: id, nodes: [], edges: [] } }),
  },
};

function varsBag() {
  const m = new Map<string, unknown>();
  return { get: (n: string): unknown => m.get(n), set: (n: string, v: unknown): void => { m.set(n, v); }, _m: m };
}

async function insertParent(runId: string): Promise<void> {
  const now = new Date().toISOString();
  const parent: RunRecord = {
    runId, workflowId: 'parent-wf', tenantId: 'tenant-fan', status: 'running',
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, parent, { admission: { plan: 'exempt:test-fixture' } });
}

function ctx(runId: string, vars: ReturnType<typeof varsBag>): NodeContext {
  return {
    runId, nodeId: 'dispatch-node', tenantId: 'tenant-fan',
    inputs: { input: { agentId: 'orchestrator.fanout.test', decisions: [{ kind: 'next-worker', nextWorkerIds: ['wf-a', 'wf-b'] }] } },
    config: { fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' }, outputMapping: { result: 'out' } },
    configurable: {}, variables: vars, attempt: 1, secrets: {},
    emit: async () => ({ eventId: '', sequence: 0 }),
  };
}

beforeAll(() => {
  ensureNodesRegistered();
  setSubWorkflowDispatcher({ storage, hostSuite: fakeSuite, executeRun: fakeExecuteRun });
});

describe('RFC 0118 — core.dispatch parallel fan-out (executor arm)', () => {
  it('joins a wait-all/collect wave: satisfied + children[2] + fanOut/join events with mergeOrder', async () => {
    await insertParent('run-fan-1');
    const vars = varsBag();
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute(ctx('run-fan-1', vars));

    expect(res.status).toBe('success');
    const out = (res as { outputs: { joinOutcome?: string; children?: Array<{ workflowId: string; childRunId: string; childStatus: string }> } }).outputs;
    expect(out.joinOutcome).toBe('satisfied');
    expect(out.children).toHaveLength(2);
    expect(new Set(out.children!.map((c) => c.workflowId))).toEqual(new Set(['wf-a', 'wf-b']));
    expect(out.children!.every((c) => c.childStatus === 'completed')).toBe(true);

    const events = await getEventLog().list('run-fan-1');
    const fanOut = events.find((e) => e.type === 'core.dispatch.fanOut');
    const join = events.find((e) => e.type === 'core.dispatch.join');
    expect(fanOut?.payload).toMatchObject({ fanOutPolicy: 'parallel', childCount: 2, joinMode: 'wait-all' });
    expect(join?.payload).toMatchObject({ joinOutcome: 'satisfied', completedCount: 2 });
    expect((join?.payload as { mergeOrder?: string[] }).mergeOrder).toHaveLength(2);
    // join causation chains to the fanOut (RFC 0118).
    expect(join?.causationId).toBe(fanOut?.eventId);
  });

  it('R1 — applies colliding outputMapping in mergeOrder, NOT dispatch order (last terminal wins)', async () => {
    await insertParent('run-fan-2');
    const vars = varsBag();
    const node = getNodeRegistry().get('core.dispatch')!;
    await node.execute(ctx('run-fan-2', vars));

    // wf-a (dispatched FIRST) terminates LAST → last-in-mergeOrder → its 'A' wins the collision.
    // A wall-clock/array-order bug would yield 'B'.
    expect(vars.get('result')).toBe('A');

    const events = await getEventLog().list('run-fan-2');
    const join = events.find((e) => e.type === 'core.dispatch.join');
    const mergeOrder = (join?.payload as { mergeOrder?: string[] }).mergeOrder ?? [];
    // wf-a's childRunId is last in mergeOrder: the node.dispatched events map workflowId→childRunId.
    const dispatched = events.filter((e) => e.type === 'node.dispatched').map((e) => e.payload as { childRunId: string; childWorkflowId: string });
    const wfaRunId = dispatched.find((d) => d.childWorkflowId === 'wf-a')?.childRunId;
    expect(mergeOrder[mergeOrder.length - 1]).toBe(wfaRunId);
  });
});
