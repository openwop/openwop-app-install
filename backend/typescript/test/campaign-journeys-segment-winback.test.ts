/**
 * ADR 0255 / RFC 0126 — the segment-winback consumer. The `segment-winback-plan`
 * supervisor node projects a resolved segment's contactIds into a `next-worker`
 * decision (one childWorkflowId × N, per-contact input via RFC 0126
 * nextWorkerInputs), which the real core.dispatch fans out — proving the full
 * "per-member supervisor shape" ADR 0255 deferred, now sitting on the merged
 * executor arm. Pure node unit tests + an end-to-end plan → dispatch integration.
 */
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { segmentWinbackPlan } from '../../../packs/feature.campaign-journeys.nodes/index.mjs';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const RE_ENGAGE = 'campaign-journeys.re-engage-contact';

// Module-level (top-level await is allowed here, not inside a describe callback).
const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
ensureNodesRegistered();
let childInputs: Array<Record<string, unknown>> = [];
const fakeExecuteRun = async (_s: Storage, childRun: RunRecord): Promise<unknown> => {
  childInputs.push({ ...(childRun.inputs as Record<string, unknown>) });
  await storage.updateRun(childRun.runId, { status: 'completed', updatedAt: new Date().toISOString() });
  return undefined;
};
const fakeSuite = { workflowCatalog: { getWorkflow: async () => ({ definition: { variables: [], nodes: [], edges: [] } }) } } as never;

describe('ADR 0255 — segment-winback-plan supervisor node (pure)', () => {
  it('projects contactIds into one next-worker decision: N × childWorkflowId + per-contact nextWorkerInputs', async () => {
    const out = await segmentWinbackPlan({
      nodeId: 'plan',
      config: { childWorkflowId: RE_ENGAGE, fromAddress: 'news@acme.test', orgId: 'o1', subject: 'Come back' },
      inputs: { contactIds: ['c1', 'c2', 'c3'], total: 3, truncated: false },
    });
    expect(out.status).toBe('success');
    const decisions = out.outputs!.decisions as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(2);
    expect(decisions[0].kind).toBe('next-worker');
    expect(decisions[0].nextWorkerIds).toEqual([RE_ENGAGE, RE_ENGAGE, RE_ENGAGE]); // one workflow ×3
    // each slot carries its own contactId + the shared params (contactId wins).
    expect(decisions[0].nextWorkerInputs).toEqual([
      { fromAddress: 'news@acme.test', orgId: 'o1', subject: 'Come back', contactId: 'c1' },
      { fromAddress: 'news@acme.test', orgId: 'o1', subject: 'Come back', contactId: 'c2' },
      { fromAddress: 'news@acme.test', orgId: 'o1', subject: 'Come back', contactId: 'c3' },
    ]);
    expect(decisions[1]).toEqual({ kind: 'terminate', reason: 'segment-dispatched' });
    expect(out.outputs!.dispatched).toBe(3);
  });

  it('empty segment → a clean terminate (no fan-out)', async () => {
    const out = await segmentWinbackPlan({ nodeId: 'plan', config: { childWorkflowId: RE_ENGAGE }, inputs: { contactIds: [] } });
    expect(out.status).toBe('success');
    expect(out.outputs!.decisions).toEqual([{ kind: 'terminate', reason: 'segment-empty' }]);
    expect(out.outputs!.dispatched).toBe(0);
  });

  it('missing childWorkflowId → validation_error', async () => {
    const out = await segmentWinbackPlan({ nodeId: 'plan', config: {}, inputs: { contactIds: ['c1'] } });
    expect(out.status).toBe('failed');
    expect(out.error!.code).toBe('validation_error');
  });
});

describe('ADR 0255 — end-to-end: plan → core.dispatch → per-contact children', () => {
  beforeAll(() => {
    ensureNodesRegistered();
    setSubWorkflowDispatcher({ storage, hostSuite: fakeSuite, executeRun: fakeExecuteRun });
    process.env.OPENWOP_DISPATCH_PER_ITEM_INPUT = 'true'; // RFC 0126 host honors per-item input
  });
  afterEach(() => { childInputs = []; });

  it('a 3-contact segment fans out to 3 re-engage children, each with its own contactId (+ shared params)', async () => {
    // 1) the plan node projects the segment into a decision.
    const plan = await segmentWinbackPlan({
      nodeId: 'plan',
      config: { childWorkflowId: RE_ENGAGE, fromAddress: 'news@acme.test', orgId: 'o1' },
      inputs: { contactIds: ['ct-1', 'ct-2', 'ct-3'] },
    });
    expect(plan.status).toBe('success');

    // 2) feed the plan's decisions into the REAL core.dispatch (as the supervisor payload).
    const now = new Date().toISOString();
    await insertRunWithStartContext(storage, { runId: 'run-wb', workflowId: 'segment-winback', tenantId: 'tenant-wb', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
    const vars = new Map<string, unknown>();
    const node = getNodeRegistry().get('core.dispatch')!;
    const res = await node.execute({
      runId: 'run-wb', nodeId: 'dispatch', tenantId: 'tenant-wb',
      inputs: { input: { agentId: plan.outputs!.agentId, decisions: plan.outputs!.decisions } },
      config: { fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } },
      configurable: {}, variables: { get: (n: string) => vars.get(n), set: (n: string, v: unknown) => { vars.set(n, v); } },
    } as never);

    expect(res.status).toBe('success');
    // 3) three children of the re-engage workflow, each with its distinct contactId + shared params.
    expect(childInputs).toHaveLength(3);
    expect(new Set(childInputs.map((i) => i.contactId))).toEqual(new Set(['ct-1', 'ct-2', 'ct-3']));
    expect(childInputs.every((i) => i.fromAddress === 'news@acme.test' && i.orgId === 'o1')).toBe(true);
  });
});
