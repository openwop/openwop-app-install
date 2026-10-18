/**
 * ADR 0829 P1 — the structured handoff record.
 *
 * Pinned on the PRODUCTION path: `core.dispatch` driven with a real sub-workflow
 * dispatcher, and `executeRun` for the suspend row. A literal-built payload
 * would only prove the literal.
 *
 * What must hold:
 *   - normalize is bounded (truncation, list caps, 8 KiB) and redacts secrets;
 *   - the child run is stamped (always on since 2026-10-07; no toggle); `agent.handoff` is emitted only when
 *     the supervisor NAMES the receiving agent, caused by its `runOrchestrator.decided`;
 *   - a parallel wave emits `agent.handoff` in worker order, not child wall-clock;
 *   - an escalation's record rides `node.suspended`, never interrupt data;
 *   - the carried payloads validate against the v2 corpus `$defs` after the v2
 *     projection, with `openwop-handoff` flat (not boxed under `vendor.openwop-app`).
 *
 * Sabotages that turn it red: any normalize cap/clamp/redaction removed;
 * `namedTargetAgent` accepting any string; the hatch regex in
 * `storage/vendorKeyCarry.ts` losing `openwop-`; the parallel stamp loop
 * reordered; the record moved into interrupt `data` or off `node.suspended`.
 */
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { corpusSchema } from './support/corpusSchema.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { setEventLogBackend, getEventLog } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { setRuntimeCapabilities } from '../src/executor/runtimeCapabilities.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { executeRun } from '../src/executor/executor.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { projectV2Payload } from '../src/storage/v2PayloadProjection.js';
import {
  HANDOFF_KEY,
  HANDOFF_LIMITS,
  normalizeHandoffRecord,
  type HandoffRecordV1,
} from '../src/host/handoff/handoffRecord.js';
import type { RunRecord } from '../src/types.js';
import type { NodeContext, WorkflowDefinition } from '../src/executor/types.js';
import { createHostAdapterSuite, type HostAdapterSuite } from '../src/host/index.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage); // toggle resolution reads overrides through it
ensureNodesRegistered();

const TENANT = 'tenant-handoff';

const fakeExecuteRun = async (_s: Storage, childRun: RunRecord): Promise<unknown> => {
  if (childRun.workflowId === 'wf-slow') await new Promise((r) => setTimeout(r, 30));
  await storage.updateRun(childRun.runId, { status: 'completed', updatedAt: new Date().toISOString() });
  return undefined;
};
const fakeSuite: HostAdapterSuite = {
  ...createHostAdapterSuite({ storage }),
  workflowCatalog: { getWorkflow: async (id: string) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
};

function varsBag() {
  const m = new Map<string, unknown>();
  return { get: (n: string): unknown => m.get(n), set: (n: string, v: unknown): void => { m.set(n, v); } };
}

async function insertParent(runId: string): Promise<void> {
  const now = new Date().toISOString();
  await insertRunWithStartContext(storage, {
    runId, workflowId: 'parent-wf', tenantId: TENANT, status: 'running',
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  });
}

function dispatchCtx(runId: string, supervisor: Record<string, unknown>, config: Record<string, unknown> = {}): NodeContext {
  return { runId, nodeId: 'dispatch-node', tenantId: TENANT, inputs: { input: supervisor }, config, configurable: {}, variables: varsBag(), attempt: 1, secrets: {}, emit: async () => ({ eventId: 'e-test', sequence: 0 }) };
}

async function childRuns(parentRunId: string): Promise<RunRecord[]> {
  const events = await getEventLog().list(parentRunId);
  const ids = events.filter((e) => e.type === 'node.dispatched').map((e) => (e.payload as { childRunId: string }).childRunId);
  const runs = await Promise.all(ids.map((id) => storage.getRun(id)));
  return runs.filter((r): r is RunRecord => !!r);
}

// v2 corpus `$defs`, from the package (RFC 0145 G2), whole document registered so internal $refs resolve.
const V2 = corpusSchema('v2/run-event-payloads.schema.json') as { $defs: Record<string, object> };
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const s of ['v2/ids.schema.json', 'v2/subject.schema.json', 'v2/credential-reference.schema.json', 'v2/suspend-request.schema.json', 'v2/orchestrator-decision.schema.json']) {
  try { ajv.addSchema(corpusSchema(s) as object); } catch { /* not every major ships every file; a missing $ref fails the compile below loudly */ }
}
ajv.addSchema(V2, 'v2payloads');
/**
 * The v2 errors THIS ADR could cause: anything under the carried key, and any
 * additionalProperties rejection (a key the closed def does not admit). Ids the
 * envelope projection mints from a stored run (`interruptId`) are out of scope
 * here — `run-event-payload-conformance.test.ts` owns the whole-payload leg.
 */
function v2Violations(def: string, type: string, payload: unknown, runId: string): string[] {
  const projected = projectV2Payload(type, payload, { runId, nodeId: 'n' }, TENANT) as Record<string, unknown>;
  const validate = ajv.getSchema(`v2payloads#/$defs/${def}`);
  if (!validate) return [`no $defs/${def}`];
  validate(projected);
  return (validate.errors ?? [])
    .filter((e) => e.instancePath.startsWith(`/${HANDOFF_KEY}`) || e.keyword === 'additionalProperties')
    .map((e) => `${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`);
}

beforeAll(() => {
  setSubWorkflowDispatcher({ storage, hostSuite: fakeSuite, executeRun: fakeExecuteRun });
  setRuntimeCapabilities([]);
  const dataDir = mkdtempSync(join(tmpdir(), 'openwop-adr0829-'));
  configureSecretResolver({ storage, dataDir });
  initInMemorySurfaces({ dataDir });
});
afterEach(() => { delete process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL; delete process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2; });

describe('ADR 0829 D1 — normalizeHandoffRecord', () => {
  it('requires an intent', () => {
    expect(normalizeHandoffRecord({ decisions: [{ summary: 'x' }] }, 'agent')).toBeNull();
    expect(normalizeHandoffRecord({ intent: '   ' }, 'agent')).toBeNull();
    expect(normalizeHandoffRecord('intent', 'agent')).toBeNull();
  });

  it('truncates, caps lists, drops malformed entries and clamps confidence', () => {
    const r = normalizeHandoffRecord({
      intent: 'x'.repeat(2000),
      decisions: [{ summary: 'keep', decidedBy: 'user:42', sourceRef: 'evt-1' }, { nope: 1 }, 'bare string'],
      openQuestions: Array.from({ length: 50 }, (_, i) => `q${i}`),
      tried: [{ approach: 'A', droppedBecause: 'slow' }, { droppedBecause: 'no approach' }],
      confidence: { value: 7, basis: 'over' },
    }, 'agent')!;
    expect(r.intent.length).toBe(HANDOFF_LIMITS.intent);
    expect(r.decisions).toEqual([{ summary: 'keep', decidedBy: 'user:42', sourceRef: 'evt-1' }]);
    expect(r.openQuestions).toHaveLength(HANDOFF_LIMITS.listItems);
    expect(r.tried).toEqual([{ approach: 'A', droppedBecause: 'slow' }]);
    expect(r.confidence).toEqual({ value: 1, basis: 'over' });
    expect(r).toMatchObject({ v: 1, producedBy: 'agent' });
  });

  it('fits the serialized cap', () => {
    const big = Array.from({ length: 20 }, () => 'y'.repeat(300));
    const r = normalizeHandoffRecord({ intent: 'i', openQuestions: big, decisions: big.map((summary) => ({ summary })), tried: big.map((approach) => ({ approach })) }, 'agent')!;
    expect(Buffer.byteLength(JSON.stringify(r), 'utf8')).toBeLessThanOrEqual(HANDOFF_LIMITS.serializedBytes);
    expect(r.decisions.length + r.openQuestions.length + r.tried.length).toBeGreaterThan(0);
  });

  it('redacts a credential-shaped string before it can reach the log', () => {
    const key = `sk-ant-${'a'.repeat(30)}`;
    const r = normalizeHandoffRecord({ intent: `use ${key} to call the API` }, 'agent')!;
    expect(JSON.stringify(r)).not.toContain(key);
  });
});

describe('ADR 0829 D2 — core.dispatch (sequential)', () => {
  const supervisor = {
    agentId: 'orchestrator.handoff.test',
    decisions: [{ kind: 'next-worker', nextWorkerIds: ['wf-named', 'wf-plain'], confidence: 0.9 }],
    handoffs: {
      'wf-named': {
        toAgentId: 'vendor.openwop-app.agents.researcher',
        intent: 'Find three comparable launches',
        decisions: [{ summary: 'Budget capped at $5k', decidedBy: 'user:owner' }],
        openQuestions: ['Which regions?'],
        tried: [{ approach: 'Internal wiki search', droppedBecause: 'stale' }],
        confidence: { value: 0.8 },
      },
    },
  };

  it('ON: stamps every child; emits agent.handoff only for the named agent, caused by its decided event', async () => {
    await insertParent('run-ho-on');
    await getNodeRegistry().get('core.dispatch')!.execute(dispatchCtx('run-ho-on', supervisor));
    const events = await getEventLog().list('run-ho-on');

    const handoffs = events.filter((e) => e.type === 'agent.handoff');
    expect(handoffs).toHaveLength(1);
    const decided = events.find((e) => e.type === 'runOrchestrator.decided')!;
    expect(handoffs[0]!.causationId).toBe(decided.eventId);
    const p = handoffs[0]!.payload as Record<string, unknown>;
    expect(p).toMatchObject({ fromAgentId: 'orchestrator.handoff.test', toAgentId: 'vendor.openwop-app.agents.researcher' });
    expect(p[HANDOFF_KEY]).toMatchObject({ v: 1, producedBy: 'agent', intent: 'Find three comparable launches', openQuestions: ['Which regions?'] });

    const kids = await childRuns('run-ho-on');
    const byWf = Object.fromEntries(kids.map((k) => [k.workflowId, k.metadata?.[HANDOFF_KEY] as HandoffRecordV1 | undefined]));
    expect(byWf['wf-named']).toEqual(p[HANDOFF_KEY]); // the SAME record, not a second build
    // No supervisor record ⇒ the thin host fallback. A conforming next-worker decision
    // has no `reason` (orchestrator-decision.schema.json), so intent names the worker.
    expect(byWf['wf-plain']).toEqual({ v: 1, intent: 'Dispatched to wf-plain', decisions: [], openQuestions: [], tried: [], confidence: { value: 0.9, basis: 'supervisor decision confidence' }, producedBy: 'host' });

    expect(v2Violations('agentHandoff', 'agent.handoff', p, 'run-ho-on')).toEqual([]);
    const projected = projectV2Payload('agent.handoff', p, { runId: 'run-ho-on' }, TENANT) as Record<string, unknown>;
    expect(projected[HANDOFF_KEY]).toEqual(p[HANDOFF_KEY]);
    expect(projected['vendor.openwop-app']).toBeUndefined();
  });

  it('never infers a receiving agent: an invalid toAgentId emits no agent.handoff', async () => {
    await insertParent('run-ho-bad');
    const bad = { ...supervisor, handoffs: { 'wf-named': { toAgentId: 'x', intent: 'i' } } };
    await getNodeRegistry().get('core.dispatch')!.execute(dispatchCtx('run-ho-bad', bad));
    expect((await getEventLog().list('run-ho-bad')).filter((e) => e.type === 'agent.handoff')).toHaveLength(0);
  });
});

describe('ADR 0829 D2 — core.dispatch (parallel wave)', () => {
  it('emits agent.handoff in worker order before the wave, not in child completion order', async () => {
    await insertParent('run-ho-par');
    const supervisor = {
      agentId: 'orchestrator.handoff.par',
      decisions: [{ kind: 'next-worker', nextWorkerIds: ['wf-slow', 'wf-fast'] }],
      handoffs: {
        'wf-slow': { toAgentId: 'agent.slow', intent: 'slow one' },
        'wf-fast': { toAgentId: 'agent.fast', intent: 'fast one' },
      },
    };
    await getNodeRegistry().get('core.dispatch')!.execute(dispatchCtx('run-ho-par', supervisor, { fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } }));
    const events = await getEventLog().list('run-ho-par');
    const order = events.filter((e) => e.type === 'agent.handoff').map((e) => (e.payload as { toAgentId: string }).toAgentId);
    expect(order).toEqual(['agent.slow', 'agent.fast']);
    const fanOutSeq = events.findIndex((e) => e.type === 'core.dispatch.fanOut');
    const firstDispatched = events.findIndex((e) => e.type === 'node.dispatched');
    const lastHandoff = events.map((e) => e.type).lastIndexOf('agent.handoff');
    expect(fanOutSeq).toBeLessThan(lastHandoff);
    expect(lastHandoff).toBeLessThan(firstDispatched);
    const kids = await childRuns('run-ho-par');
    expect(kids.map((k) => (k.metadata?.[HANDOFF_KEY] as HandoffRecordV1).intent).sort()).toEqual(['fast one', 'slow one']);
  });
});

describe('ADR 0829 D2 — escalation rides node.suspended', () => {
  function enableFloor(): void {
    process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL = 'true';
    process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2 = 'true';
  }
  const lowConfidence = {
    agentId: 'orchestrator.handoff.esc',
    decisions: [{ kind: 'next-worker', nextWorkerIds: ['wf-x'], confidence: 0.2 }],
    handoffs: { 'wf-x': { intent: 'Draft the launch brief', openQuestions: ['Is the date fixed?'] } },
  };

  it('the node outcome carries the record beside, not inside, the interrupt data', async () => {
    enableFloor();
    await insertParent('run-ho-esc-node');
    const res = await getNodeRegistry().get('core.dispatch')!.execute(dispatchCtx('run-ho-esc-node', lowConfidence));
    expect(res.status).toBe('suspended');
    if (res.status !== 'suspended') return;
    const data = res.interrupt.data;
    expect(data !== null && typeof data === 'object').toBe(true);
    expect(Object.keys(data as object)).not.toContain(HANDOFF_KEY);
    expect(res.interrupt.handoff).toMatchObject({ intent: 'Draft the launch brief', openQuestions: ['Is the date fixed?'], producedBy: 'agent' });
    expect(res.interrupt.handoff?.confidence?.value).toBe(0.2);
    expect(res.interrupt.handoff?.confidence?.basis).toMatch(/below the escalation floor/);
  });

  it('executeRun writes it onto node.suspended; interrupt.requested never carries it', async () => {
    getNodeRegistry().register({
      typeId: 'test.adr0829-escalate',
      version: '1.0.0',
      async execute(ctx) {
        return getNodeRegistry().get('core.dispatch')!.execute({ ...ctx, inputs: { input: lowConfidence }, config: {}, variables: varsBag() });
      },
    });
    enableFloor();
    const runOnce = async (status: 'on') => {
      const now = new Date().toISOString();
      const run: RunRecord = { runId: `run-ho-exec-${status}`, workflowId: 'wf.test.adr0829', tenantId: TENANT, status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
      await storage.insertRun(run);
      const def: WorkflowDefinition = { workflowId: run.workflowId, nodes: [{ nodeId: 'n1', typeId: 'test.adr0829-escalate' }] };
      await executeRun(storage, run, def);
      return storage.listEvents(run.runId);
    };

    const on = await runOnce('on');
    const suspended = on.find((e) => e.type === 'node.suspended');
    expect(suspended, 'the escalation did not suspend — the leg would be vacuous').toBeDefined();
    const sp = suspended!.payload as Record<string, unknown>;
    expect(sp[HANDOFF_KEY]).toMatchObject({ v: 1, intent: 'Draft the launch brief' });
    expect(v2Violations('nodeSuspended', 'node.suspended', sp, 'run-ho-exec-on')).toEqual([]);
    const requested = on.find((e) => e.type === 'interrupt.requested');
    expect(requested, 'no interrupt.requested — the negative below would be vacuous').toBeDefined();
    expect(JSON.stringify(requested?.payload ?? {})).not.toContain('Draft the launch brief');
  });
});
