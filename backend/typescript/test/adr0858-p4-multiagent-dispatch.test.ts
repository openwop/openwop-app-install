/**
 * ADR 0858 P4 — `multiAgent` and `agents.dispatch` at major 2 (spec-steward
 * ruling openwop-e2, 2026-10-10).
 *
 * - `multiAgent.executionModel.version` is the highest N whose phases 1..N are
 *   ALL on, read from the runtime gates (`host/multiAgentPhases.ts`). A gap in
 *   the ladder caps the claim below it.
 * - `confidenceEscalationInterruptKind` is `clarification`, the kind core.dispatch
 *   actually suspends with (v1 advertised an `x-host-…` kind it never emitted).
 * - `crossHostCausation.hostId` is the constant getRunAncestry answers with.
 * - `agents.dispatch: true` rests on CP-2: core.dispatch starts workers as child
 *   runs and never mutates the parent's registered definition.
 *
 * Tracker TST-BFA-6. Red when: the version ladder counts phases past a gap;
 * `isPhase3Enabled` ignores PHASE_5; core.dispatch suspends with another kind
 * or floor than advertised; a child run does not carry the parent's runId; the
 * agents record stops claiming dispatch; `crossHostCausation.hostId` drifts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createApp } from '../src/index.js';
import { CROSS_HOST_CAUSATION_HOST_ID } from '../src/routes/discovery.js';
import { isPhase3Enabled } from '../src/host/multiAgentPhases.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { setEventLogBackend, getEventLog } from '../src/executor/eventLog.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerWorkflow, getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import type { RunRecord } from '../src/types.js';
import type { NodeContext, WorkflowDefinition } from '../src/executor/types.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { executeRun } from '../src/executor/executor.js';
import { corpusSchema } from './support/corpusSchema.js';

const FLAGS = [
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL',
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2',
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3',
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4',
  'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5',
  'OPENWOP_MULTI_AGENT_CONFIDENCE_FLOOR',
  'OPENWOP_AGENT_VERIFIER_GATING',
] as const;
const saved = new Map<string, string | undefined>(FLAGS.map((k) => [k, process.env[k]]));
function setFlags(on: Partial<Record<(typeof FLAGS)[number], string>>): void {
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, on);
}

let server: http.Server;
let BASE = '';
let appStorage: Storage;
let appHostSuite: HostAdapterSuite;
/** The boot-time seams this file replaces, put back after each node-level case. */
function restoreSeams(): void {
  setEventLogBackend(appStorage);
  setSubWorkflowDispatcher({
    storage: appStorage, hostSuite: appHostSuite,
    executeRun: (s, run, definition, options) => executeRun(s, run, definition as WorkflowDefinition, options as Parameters<typeof executeRun>[3]),
  });
}
function nodeCtx(runId: string, tenantId: string, input: Record<string, unknown>): NodeContext {
  const m = new Map<string, unknown>();
  let seq = 0;
  return {
    runId, nodeId: 'd', tenantId, attempt: 1, secrets: {}, config: {}, configurable: {},
    emit: async () => { seq += 1; return { eventId: `${runId}-ev-${seq}`, sequence: seq }; },
    variables: { get: (n: string): unknown => m.get(n), set: (n: string, v: unknown): void => { m.set(n, v); } },
    inputs: { input },
  };
}
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  appStorage = app.locals.storage as Storage;
  appHostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
}, 120_000);
afterEach(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function served(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
type EM = { version?: number; confidenceEscalationFloor?: number; confidenceEscalationInterruptKind?: string; crossHostCausation?: { hostId?: string; ancestryEndpointSupported?: boolean }; replayDeterminism?: Record<string, unknown>; statefulResume?: boolean; verifier?: unknown };
async function executionModel(): Promise<EM | undefined> {
  return ((await served())['multiAgent'] as { executionModel?: EM } | undefined)?.executionModel;
}

function seatValidator(family: string): ReturnType<Ajv2020['compile']> {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const caps = corpusSchema('v2/capabilities.schema.json') as { $id?: string };
  const dir = dirname(createRequire(`${process.cwd()}/`).resolve('@openwop/spec-artifacts/schemas/v2/capabilities.schema.json'));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try { ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>); } catch { /* a malformed sibling is its own test's problem */ }
  }
  return ajv.compile({ $ref: `${caps.$id ?? ''}#/properties/${family}` });
}

const ALL = {
  OPENWOP_MULTI_AGENT_EXECUTION_MODEL: 'true',
  OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2: 'true',
  OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3: 'true',
  OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4: 'true',
  OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5: 'true',
};

describe('ADR 0858 P4 — multiAgent.executionModel.version is the unbroken ladder of runtime gates', () => {
  it('absent when phase 1 is off', async () => {
    setFlags({});
    expect((await served())['multiAgent']).toBeUndefined();
  });

  it.each([
    ['phase 1 only', { OPENWOP_MULTI_AGENT_EXECUTION_MODEL: 'true' }, 1],
    ['phases 1-2', { OPENWOP_MULTI_AGENT_EXECUTION_MODEL: 'true', OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2: 'true' }, 2],
    ['phases 1-3', { OPENWOP_MULTI_AGENT_EXECUTION_MODEL: 'true', OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2: 'true', OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3: 'true' }, 3],
    ['phases 1-5', ALL, 5],
    // The v1 over-claim: PHASE_5 alone advertised 5 with no escalation or refusal-divergence running.
    ['phase 1 + PHASE_5 (gap at 2)', { OPENWOP_MULTI_AGENT_EXECUTION_MODEL: 'true', OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5: 'true' }, 1],
    // PHASE_5 now implies the phase-3 gate, but phase 4 is still off: the claim stops at 3.
    ['phases 1-2 + PHASE_5 (gap at 4)', { OPENWOP_MULTI_AGENT_EXECUTION_MODEL: 'true', OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2: 'true', OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5: 'true' }, 3],
  ] as const)('%s ⇒ version %i, and the record validates against its seat', async (_n, flags, version) => {
    setFlags(flags);
    const rec = (await served())['multiAgent'];
    const validate = seatValidator('multiAgent');
    expect(validate(rec), JSON.stringify(validate.errors ?? [])).toBe(true);
    const em = (rec as { executionModel: EM }).executionModel;
    expect(em.version).toBe(version);
    // Each sub-block appears exactly from its level.
    expect('confidenceEscalationFloor' in em).toBe(version >= 2);
    expect('crossHostCausation' in em).toBe(version >= 3);
    expect('replayDeterminism' in em).toBe(version >= 4);
    expect('statefulResume' in em).toBe(version >= 5);
  });

  it('level 6 (verifier) is never claimed: no production path injects a verifier', async () => {
    setFlags({ ...ALL, OPENWOP_AGENT_VERIFIER_GATING: 'true' });
    const em = await executionModel();
    expect(em?.version).toBe(5);
    expect(em).not.toHaveProperty('verifier');
  });

  it('the phase-3 predicate honours PHASE_5 (it used to ignore it)', () => {
    setFlags({ OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5: 'true' });
    expect(isPhase3Enabled()).toBe(true);
  });

  it('crossHostCausation.hostId is the id getRunAncestry answers with', async () => {
    setFlags(ALL);
    expect((await executionModel())?.crossHostCausation).toEqual({ hostId: CROSS_HOST_CAUSATION_HOST_ID, ancestryEndpointSupported: true });
  });
});

describe('ADR 0858 P4 — escalation advert and behaviour agree (floor and interrupt kind)', () => {
  it('the advertised floor and kind are what core.dispatch suspends with', async () => {
    setFlags({ OPENWOP_MULTI_AGENT_EXECUTION_MODEL: 'true', OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2: 'true', OPENWOP_MULTI_AGENT_CONFIDENCE_FLOOR: '0.7' });
    const em = await executionModel();
    expect(em?.confidenceEscalationFloor).toBe(0.7);
    expect(em?.confidenceEscalationInterruptKind).toBe('clarification');

    const storage = await openStorage('memory://');
    setEventLogBackend(storage);
    try {
      ensureNodesRegistered();
      const ctx = nodeCtx('run-escalate', 't-esc', { agentId: 'orchestrator.esc', decisions: [{ kind: 'next-worker', nextWorkerIds: ['wf-x'], confidence: 0.6 }] });
      const res = await getNodeRegistry().get('core.dispatch')!.execute(ctx);
      expect(res.status).toBe('suspended');
      const interrupt = res.status === 'suspended' ? res.interrupt : undefined;
      expect(interrupt?.kind).toBe(em?.confidenceEscalationInterruptKind);
      expect((interrupt?.data as { floor?: number } | undefined)?.floor).toBe(em?.confidenceEscalationFloor);
    } finally { restoreSeams(); }
  });
});

describe('ADR 0858 P4 — agents.dispatch and CP-2', () => {
  it('the served agents record claims dispatch and validates against its seat', async () => {
    const rec = (await served())['agents'] as Record<string, unknown>;
    expect(rec['dispatch']).toBe(true);
    const validate = seatValidator('agents');
    expect(validate(rec), JSON.stringify(validate.errors ?? [])).toBe(true);
    // The v1 fan-out descriptor has no v2 seat: no top-level `dispatch` block.
    expect((await served())['dispatch']).toBeUndefined();
  });

  it('CP-2: core.dispatch starts workers as child runs and never mutates the parent DAG', async () => {
    const storage: Storage = await openStorage('memory://');
    setEventLogBackend(storage);
    initHostExtPersistence(storage);
    ensureNodesRegistered();
    const parentDef: WorkflowDefinition = {
      workflowId: 'cp2.parent', variables: [],
      nodes: [{ nodeId: 'sup', typeId: 'core.orchestrator.supervisor' }, { nodeId: 'd', typeId: 'core.dispatch' }],
      edges: [{ edgeId: 'sup-d', sourceNodeId: 'sup', targetNodeId: 'd' }],
    };
    registerWorkflow(parentDef);
    try {
    const before = JSON.stringify(getRegisteredWorkflow('cp2.parent'));
    const children: RunRecord[] = [];
    const childDef: WorkflowDefinition = { workflowId: 'cp2.child', variables: [], nodes: [], edges: [] };
    setSubWorkflowDispatcher({
      storage,
      // The real suite, with only the catalog answering the two worker ids.
      hostSuite: { ...appHostSuite, workflowCatalog: { getWorkflow: async (workflowId: string) => ({ workflowId, definition: childDef }) } },
      executeRun: async (_s: Storage, child: RunRecord) => { children.push(child); await storage.updateRun(child.runId, { status: 'completed', updatedAt: new Date().toISOString() }); return undefined; },
    });
    const now = new Date().toISOString();
    await insertRunWithStartContext(storage, { runId: 'run-cp2', workflowId: 'cp2.parent', tenantId: 't-cp2', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
    const ctx = nodeCtx('run-cp2', 't-cp2', { agentId: 'orchestrator.cp2', decisions: [{ kind: 'next-worker', nextWorkerIds: ['wf-a', 'wf-b'] }] });
    await getNodeRegistry().get('core.dispatch')!.execute(ctx);

    // Workers ran as SEPARATE child runs of the parent…
    expect(children.map((c) => c.parentRunId)).toEqual(['run-cp2', 'run-cp2']);
    expect(children.every((c) => c.runId !== 'run-cp2')).toBe(true);
    // …and the parent's DAG and run are untouched.
    expect(JSON.stringify(getRegisteredWorkflow('cp2.parent'))).toBe(before);
    expect((await storage.getRun('run-cp2'))?.workflowId).toBe('cp2.parent');
    const types = new Set((await getEventLog().list('run-cp2')).map((e) => e.type));
    expect([...types].filter((t) => /node\.(added|inserted|removed)|definition\./.test(t))).toEqual([]);
    } finally { restoreSeams(); }
  });
});
