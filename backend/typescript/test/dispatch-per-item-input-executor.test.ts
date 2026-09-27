/**
 * RFC 0126 — data-parallel core.dispatch: per-item input fan-out (the ADR 0255
 * segment-winback witness). ONE childWorkflowId fanned out over N slots, each
 * child receiving a DISTINCT per-item input (`nextWorkerInputs[i]`), projected
 * OVER the RFC 0022 inputMapping (G1 per-item-overrides). Plus the two fail-closed
 * rails: length-mismatch → validation_error, and honest-off (capability not
 * advertised) → reject (never silently dispatch N identical children).
 *
 * Driven through the real core.dispatch node + real subWorkflowDispatcher with a
 * controlled child executor that RECORDS each child's seeded inputs.
 */
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
ensureNodesRegistered();

// Records every child run's seeded inputs (subWorkflowDispatcher set them from
// perItemInputs), then completes it.
let childInputs: Array<Record<string, unknown>> = [];
const fakeExecuteRun = async (_s: Storage, childRun: RunRecord): Promise<unknown> => {
  childInputs.push({ ...(childRun.inputs as Record<string, unknown>) });
  await storage.updateRun(childRun.runId, { status: 'completed', updatedAt: new Date().toISOString() });
  return undefined;
};
const fakeSuite = { workflowCatalog: { getWorkflow: async (_id: string) => ({ definition: { variables: [], nodes: [], edges: [] } }) } } as never;

function varsBag() {
  const m = new Map<string, unknown>();
  return { get: (n: string): unknown => m.get(n), set: (n: string, v: unknown): void => { m.set(n, v); } };
}
async function insertParent(runId: string): Promise<void> {
  const now = new Date().toISOString();
  await insertRunWithStartContext(storage, { runId, workflowId: 'parent-wf', tenantId: 'tenant-pi', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
}
function ctx(runId: string, decision: unknown): unknown {
  return {
    runId, nodeId: 'dispatch-node', tenantId: 'tenant-pi',
    inputs: { input: { agentId: 'orchestrator.perItem.test', decisions: [decision] } },
    config: { fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } },
    configurable: {}, variables: varsBag(),
  };
}

beforeAll(() => {
  ensureNodesRegistered();
  setSubWorkflowDispatcher({ storage, hostSuite: fakeSuite, executeRun: fakeExecuteRun });
});
afterEach(() => { childInputs = []; delete process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT; });

describe('RFC 0126 — per-item input fan-out (executor arm)', () => {
  it('projects a distinct per-item input into each child of ONE workflow (homogeneous data-parallel)', async () => {
    process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT = 'true';
    await insertParent('run-pi-1');
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute(ctx('run-pi-1', {
      kind: 'next-worker',
      nextWorkerIds: ['re-engage', 're-engage', 're-engage'],
      nextWorkerInputs: [{ contactId: 'c1' }, { contactId: 'c2' }, { contactId: 'c3' }],
    }) as never);

    expect(res.status).toBe('success');
    // three children of the SAME workflow, each with its own contactId — not N identical.
    expect(childInputs).toHaveLength(3);
    expect(new Set(childInputs.map((i) => i.contactId))).toEqual(new Set(['c1', 'c2', 'c3']));
  });

  it('per-item value OVERRIDES the inputMapping projection on a key collision (G1)', async () => {
    process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT = 'true';
    await insertParent('run-pi-2');
    const node = getNodeRegistry().get('core.dispatch')!;
    // inputMapping would map child.contactId <- parent var (unset → undefined); per-item wins.
    const c = ctx('run-pi-2', { kind: 'next-worker', nextWorkerIds: ['re-engage', 're-engage'], nextWorkerInputs: [{ contactId: 'x1' }, { contactId: 'x2' }] }) as { config: Record<string, unknown> };
    c.config.inputMapping = { contactId: 'someParentVar' };
    const res = await node.execute(c as never);
    expect(res.status).toBe('success');
    expect(new Set(childInputs.map((i) => i.contactId))).toEqual(new Set(['x1', 'x2'])); // per-item, not the mapping
  });

  it('FAIL-CLOSED: nextWorkerInputs on a host that does not advertise perItemInput → validation_error, no child', async () => {
    // RFC 0126 is Accepted so the host advertises perItemInput by default; the disable
    // escape hatch (`=false`) reproduces the honest-off / fail-closed path.
    process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT = 'false';
    await insertParent('run-pi-3');
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute(ctx('run-pi-3', { kind: 'next-worker', nextWorkerIds: ['re-engage', 're-engage'], nextWorkerInputs: [{ contactId: 'c1' }, { contactId: 'c2' }] }) as never);
    expect(res.status).toBe('failure');
    expect((res as { error: { code: string } }).error.code).toBe('validation_error');
    expect(childInputs).toHaveLength(0); // nothing dispatched
  });

  it('length-mismatch (nextWorkerInputs.length !== nextWorkerIds.length) → validation_error, no child', async () => {
    process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT = 'true';
    await insertParent('run-pi-4');
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute(ctx('run-pi-4', { kind: 'next-worker', nextWorkerIds: ['re-engage', 're-engage'], nextWorkerInputs: [{ contactId: 'c1' }] }) as never);
    expect(res.status).toBe('failure');
    expect((res as { error: { code: string } }).error.code).toBe('validation_error');
    expect(childInputs).toHaveLength(0);
  });

  it('no nextWorkerInputs → normal fan-out, unaffected (back-compat)', async () => {
    await insertParent('run-pi-5');
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute(ctx('run-pi-5', { kind: 'next-worker', nextWorkerIds: ['re-engage', 're-engage'] }) as never);
    expect(res.status).toBe('success');
    expect(childInputs).toHaveLength(2); // dispatched, no per-item inputs
  });
});

describe('RFC 0126 — capability advertisement (honest-on now that 0126 is Accepted)', () => {
  it('advertises dispatch.perItemInput by default (env unset), and the =false hatch forces it off', async () => {
    const { perItemInputSupported, dispatchCapability } = await import('../src/host/dispatchFanOut.js');
    delete process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT;
    expect(perItemInputSupported()).toBe(true); // honest-on: RFC accepted, behavior honored
    expect(dispatchCapability().perItemInput).toBe(true);

    process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT = 'false'; // disable escape hatch
    expect(perItemInputSupported()).toBe(false);
    expect(dispatchCapability().perItemInput).toBe(false);
  });
});
