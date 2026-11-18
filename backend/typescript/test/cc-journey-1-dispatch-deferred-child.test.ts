/**
 * CC-JOURNEY-1, the dispatch path: core.dispatch hands a DEFERRED child its
 * per-item inputs under bare param names, and the child's variable bag must bind
 * them to its prefixed variables.
 *
 * This is the path prod took (segment-winback → re-engage-contact, run
 * 9d1d9d09 on 569fdfec88). subWorkflowDispatcher seeds the child's bag itself,
 * and the executor then only hydrates it, so a fix limited to POST /runs never
 * reached the child. Driven through the real core.dispatch node and the real
 * subWorkflowDispatcher, with the REAL campaign-journeys deferred definition as
 * the child. The child executor records the seeded bag.
 *
 * Red on main: the child's bag has no prefixed contactId (undefined), which is
 * the "journeyId and contactId … are required" failure prod showed.
 * The child's recorded `inputs` stay exactly what the parent sent (bare). Only
 * the derived bag changes, so a recorded run reads the same inputs on recovery.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { snapshotRunVariables } from '../src/host/variablesRuntime.js';
import { createHostAdapterSuite, type HostAdapterSuite } from '../src/host/index.js';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { NodeContext } from '../src/executor/types.js';

const pack = JSON.parse(readFileSync(new URL('../../../examples/workflow-chain-packs/campaign-journeys/pack.json', import.meta.url), 'utf8')) as { chains: WorkflowChain[] };
const reEngage = pack.chains.find((c) => c.chainId === 'campaign-journeys.re-engage-contact')!;
const child = expandChain(reEngage, { deferred: true, params: { orgId: 'org-qa', senderEmail: 'sender@example.invalid' } });
const aliases = child.metadata?.deferredParameterAliases as Record<string, string>;

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
ensureNodesRegistered();

const seen: Array<{ inputs: Record<string, unknown>; bag: Record<string, unknown> | null }> = [];
const recordingExecuteRun = async (_s: Storage, childRun: RunRecord): Promise<unknown> => {
  seen.push({ inputs: { ...(childRun.inputs as Record<string, unknown>) }, bag: snapshotRunVariables(childRun.runId) });
  await storage.updateRun(childRun.runId, { status: 'completed', updatedAt: new Date().toISOString() });
  return undefined;
};
const suite: HostAdapterSuite = {
  ...createHostAdapterSuite({ storage }),
  workflowCatalog: { getWorkflow: async (id: string) => ({ workflowId: id, definition: { ...child, workflowId: id } }) },
};

function ctx(runId: string, decision: unknown): NodeContext {
  const m = new Map<string, unknown>();
  return {
    runId, nodeId: 'dispatch', tenantId: 'tenant-j1', attempt: 1, secrets: {},
    emit: async () => ({ eventId: 'evt-j1', sequence: 0 }),
    inputs: { input: { agentId: 'segment-winback.plan', decisions: [decision] } },
    config: { fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } },
    configurable: {}, variables: { get: (n: string): unknown => m.get(n), set: (n: string, v: unknown): void => { m.set(n, v); } },
  };
}

beforeAll(() => {
  process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT = 'true';
  setSubWorkflowDispatcher({ storage, hostSuite: suite, executeRun: recordingExecuteRun });
});

describe('CC-JOURNEY-1: a dispatched deferred child binds its bare per-item inputs', () => {
  it('each member child gets its own contactId in the prefixed variable; the recorded inputs stay bare', async () => {
    const now = new Date().toISOString();
    await insertRunWithStartContext(storage, { runId: 'run-j1', workflowId: 'segment-winback', tenantId: 'tenant-j1', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now }, { admission: { plan: 'exempt:test-fixture' } });
    const res = await getNodeRegistry().get('core.dispatch')!.execute(ctx('run-j1', {
      kind: 'next-worker',
      nextWorkerIds: ['wf.copy.re-engage', 'wf.copy.re-engage'],
      nextWorkerInputs: [
        { contactId: 'crm:a', orgId: 'org-qa', subject: 'S', body: 'B', senderEmail: 'sender@example.invalid' },
        { contactId: 'crm:b', orgId: 'org-qa', subject: 'S', body: 'B', senderEmail: 'sender@example.invalid' },
      ],
    }));
    expect(res.status).toBe('success');
    expect(seen).toHaveLength(2);
    expect(new Set(seen.map((s) => s.bag?.[aliases.contactId]))).toEqual(new Set(['crm:a', 'crm:b']));
    for (const s of seen) {
      expect(s.bag?.[aliases.senderEmail]).toBe('sender@example.invalid');
      expect(s.inputs[aliases.contactId]).toBeUndefined(); // recorded inputs untouched (bare only)
      expect(typeof s.inputs.contactId).toBe('string');
    }
  });
});
