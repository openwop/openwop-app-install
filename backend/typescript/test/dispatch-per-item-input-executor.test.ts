/**
 * RFC 0126 — data-parallel core.dispatch: per-item input fan-out (the ADR 0255
 * segment-winback witness). ONE childWorkflowId fanned out over N slots, each
 * child receiving a DISTINCT per-item input (`nextWorkerInputs[i]`), projected
 * OVER the RFC 0022 inputMapping (G1 per-item-overrides). Plus the two fail-closed
 * rails: length-mismatch → validation_error, and honest-off (capability not
 * advertised) → reject (never silently dispatch N identical children).
 * TST-CWB-4.
 *
 * Driven through the real core.dispatch node + real subWorkflowDispatcher with a
 * controlled child executor that RECORDS each child's seeded inputs.
 *
 * Red when (sabotage-witnessed, wave 69): the per-item projection is dropped
 * (cases 1–2); the mapping is applied AFTER the per-item value — the parent
 * variable is SEEDED, so the wrong order yields its distinct value (case 2); the
 * `perItemInputSupported()` gate or the length check is removed (cases 3–4, each
 * asserting its own refusal message, since both share `validation_error`); the
 * advertisement ignores the `=false` hatch (case 6); an `undefined` per-item value
 * is copied over the mapped one (the ADR 1020 D1 case).
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { setRunVariable, clearRunVariables } from '../src/host/variablesRuntime.js';
import { createHostAdapterSuite, type HostAdapterSuite } from '../src/host/index.js';
import { perItemInputSupported, dispatchCapability } from '../src/host/dispatchFanOut.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { NodeContext, NodeOutcome } from '../src/executor/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
ensureNodesRegistered();

const ENV = 'OPENWOP_DISPATCH_PER_ITEM_INPUT';

// Records every child run's seeded inputs (subWorkflowDispatcher set them from
// perItemInputs), then completes it.
let childInputs: Array<Record<string, unknown>> = [];
const fakeExecuteRun = async (_s: Storage, childRun: RunRecord): Promise<unknown> => {
  childInputs.push({ ...(childRun.inputs as Record<string, unknown>) });
  await storage.updateRun(childRun.runId, { status: 'completed', updatedAt: new Date().toISOString() });
  return undefined;
};
/** The real suite with only the child-workflow catalog replaced (typed, no cast). */
const fakeSuite: HostAdapterSuite = {
  ...createHostAdapterSuite({ storage }),
  workflowCatalog: { getWorkflow: async (id: string) => ({ workflowId: id, definition: { workflowId: id, variables: [], nodes: [], edges: [] } }) },
};

function varsBag(): NonNullable<NodeContext['variables']> {
  const m = new Map<string, unknown>();
  return { get: (n: string): unknown => m.get(n), set: (n: string, v: unknown): void => { m.set(n, v); } };
}
async function insertParent(runId: string): Promise<void> {
  const now = new Date().toISOString();
  await insertRunWithStartContext(storage, { runId, workflowId: 'parent-wf', tenantId: 'tenant-pi', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now }, { admission: { plan: 'exempt:test-fixture' } });
}
function ctx(runId: string, decision: unknown, config: Record<string, unknown> = {}): NodeContext {
  return {
    runId, nodeId: 'dispatch-node', tenantId: 'tenant-pi', attempt: 1, secrets: {},
    emit: async () => ({ eventId: 'evt-pi', sequence: 0 }),
    inputs: { input: { agentId: 'orchestrator.perItem.test', decisions: [decision] } },
    config: { fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' }, ...config },
    configurable: {}, variables: varsBag(),
  };
}
const errorOf = (res: NodeOutcome): { code: string; message: string } | undefined =>
  res.status === 'failure' ? res.error : undefined;

let priorEnv: string | undefined;
beforeAll(() => {
  setSubWorkflowDispatcher({ storage, hostSuite: fakeSuite, executeRun: fakeExecuteRun });
});
beforeEach(() => { priorEnv = process.env[ENV]; childInputs = []; });
afterEach(() => {
  childInputs = [];
  if (priorEnv === undefined) delete process.env[ENV]; else process.env[ENV] = priorEnv;
});

describe('RFC 0126 — per-item input fan-out (executor arm)', () => {
  it('projects a distinct per-item input into each child of ONE workflow (homogeneous data-parallel)', async () => {
    process.env[ENV] = 'true';
    await insertParent('run-pi-1');
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute(ctx('run-pi-1', {
      kind: 'next-worker',
      nextWorkerIds: ['re-engage', 're-engage', 're-engage'],
      nextWorkerInputs: [{ contactId: 'c1' }, { contactId: 'c2' }, { contactId: 'c3' }],
    }));

    expect(res.status).toBe('success');
    // three children of the SAME workflow, each with its own contactId — not N identical.
    expect(childInputs).toHaveLength(3);
    expect(new Set(childInputs.map((i) => i.contactId))).toEqual(new Set(['c1', 'c2', 'c3']));
  });

  it('per-item value OVERRIDES the inputMapping projection on a key collision (G1)', async () => {
    process.env[ENV] = 'true';
    await insertParent('run-pi-2');
    // The mapping has a REAL value to project, so applying it after the
    // per-item value would show up as 'FROM-PARENT', not as undefined.
    setRunVariable('run-pi-2', 'someParentVar', 'FROM-PARENT');
    try {
      const node = getNodeRegistry().get('core.dispatch')!;
      const res = await node.execute(ctx('run-pi-2',
        { kind: 'next-worker', nextWorkerIds: ['re-engage', 're-engage'], nextWorkerInputs: [{ contactId: 'x1' }, { contactId: 'x2' }] },
        { inputMapping: { contactId: 'someParentVar' } }));
      expect(res.status).toBe('success');
      expect(new Set(childInputs.map((i) => i.contactId))).toEqual(new Set(['x1', 'x2'])); // per-item, not the mapping
    } finally {
      clearRunVariables('run-pi-2');
    }
  });

  it('an UNDEFINED per-item value never erases the mapped value; null still overrides (ADR 1020 D1)', async () => {
    // A deferred chain expansion freezes an unset `{{params.X}}` in config to
    // `undefined`. JSON cannot carry one, so a recorded decision drops the key and
    // the mapping wins; live, the override used to ERASE it (CS70WF-1: every
    // Campaign Studio channel child got `briefId: undefined`).
    process.env[ENV] = 'true';
    await insertParent('run-pi-u');
    setRunVariable('run-pi-u', 'briefId', 'brief-1');
    try {
      const node = getNodeRegistry().get('core.dispatch')!;
      const res = await node.execute(ctx('run-pi-u',
        { kind: 'next-worker', nextWorkerIds: ['channel', 'channel'], nextWorkerInputs: [{ briefId: undefined, tag: 'a' }, { briefId: null, tag: 'b' }] },
        { inputMapping: { briefId: 'briefId' } }));
      expect(res.status).toBe('success');
      const byTag = new Map(childInputs.map((i) => [i.tag, i]));
      expect(byTag.get('a')).toMatchObject({ briefId: 'brief-1' });
      expect(byTag.get('b')).toMatchObject({ briefId: null });
    } finally {
      clearRunVariables('run-pi-u');
    }
  });

  it('FAIL-CLOSED: nextWorkerInputs on a host that does not advertise perItemInput → validation_error, no child', async () => {
    // RFC 0126 is Accepted so the host advertises perItemInput by default; the disable
    // escape hatch (`=false`) reproduces the honest-off / fail-closed path.
    process.env[ENV] = 'false';
    await insertParent('run-pi-3');
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute(ctx('run-pi-3', { kind: 'next-worker', nextWorkerIds: ['re-engage', 're-engage'], nextWorkerInputs: [{ contactId: 'c1' }, { contactId: 'c2' }] }));
    expect(res.status).toBe('failure');
    expect(errorOf(res)?.code).toBe('validation_error');
    expect(errorOf(res)?.message).toContain('does not advertise capabilities.dispatch.perItemInput');
    expect(childInputs).toHaveLength(0); // nothing dispatched
  });

  it('length-mismatch (nextWorkerInputs.length !== nextWorkerIds.length) → validation_error, no child', async () => {
    process.env[ENV] = 'true';
    await insertParent('run-pi-4');
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute(ctx('run-pi-4', { kind: 'next-worker', nextWorkerIds: ['re-engage', 're-engage'], nextWorkerInputs: [{ contactId: 'c1' }] }));
    expect(res.status).toBe('failure');
    expect(errorOf(res)?.code).toBe('validation_error');
    expect(errorOf(res)?.message).toContain('nextWorkerInputs.length (1) MUST equal nextWorkerIds.length (2)');
    expect(childInputs).toHaveLength(0);
  });

  it('no nextWorkerInputs → normal fan-out, unaffected (back-compat)', async () => {
    await insertParent('run-pi-5');
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute(ctx('run-pi-5', { kind: 'next-worker', nextWorkerIds: ['re-engage', 're-engage'] }));
    expect(res.status).toBe('success');
    expect(childInputs).toHaveLength(2); // dispatched, no per-item inputs
  });
});

describe('RFC 0126 — capability advertisement (honest-on now that 0126 is Accepted)', () => {
  it('advertises dispatch.perItemInput by default (env unset), and the =false hatch forces it off', () => {
    delete process.env[ENV];
    expect(perItemInputSupported()).toBe(true); // honest-on: RFC accepted, behavior honored
    expect(dispatchCapability().perItemInput).toBe(true);

    process.env[ENV] = 'false'; // disable escape hatch
    expect(perItemInputSupported()).toBe(false);
    expect(dispatchCapability().perItemInput).toBe(false);
  });
});
