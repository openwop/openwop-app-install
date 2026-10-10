/**
 * loop row 3, P2 — interrupt.md §Events — interrupt.md §Events: "Every kind uses two registered types",
 * `interrupt.requested` (the InterruptPayload) and `interrupt.resolved`. This
 * host recorded `interrupt.requested` for the `credential` kind only; an
 * approval / clarification / … suspension left `node.suspended` alone.
 *
 * Pinned here:
 *  - the per-kind PROJECTION validates against BOTH majors' vendored
 *    `suspend-request.schema.json`, for every kind this host can raise
 *    (enumerated from the projector's total map over `InterruptRecord['kind']`);
 *  - the full event ORDER on the real executor + event log for the single,
 *    quorum and timeout approval paths and for a clarification;
 *  - exactly ONE request per suspension (a resume does not re-emit; fork and
 *    sweeper recovery are pinned in adr0751-fork-suspended-checkpoint.test.ts);
 *  - replay divergence skips a request ONLY for a pre-change source that holds
 *    none of that kind, and still catches a real divergence otherwise.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { corpusSchema } from './support/corpusSchema.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { executeRun } from '../src/executor/executor.js';
import { sweepExpiredApprovalGates, timeoutApprovalGateIfDue } from '../src/executor/approvalGateTimeout.js';
import { compareObservableSequences } from '../src/executor/replayDivergence.js';
import { buildInterruptRequestedPayload, PROJECTED_HOST_KINDS } from '../src/executor/interruptRequestedPayload.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __awaitRunResumeChainForTests, resolveAndResume, validateResumeValue } from '../src/routes/interrupts.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { EventRecord, InterruptRecord, RunRecord } from '../src/types.js';
import { installRejectedGateRouter } from './support/rejectedGateRouter.js';

// ── schema validators, one per major, from the PACKAGE ──────────────────────
function validatorFor(major: 1 | 2): (payload: unknown) => { ok: boolean; errors: string } {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const p = major === 1 ? '' : 'v2/';
  for (const dep of ['credential-reference.schema.json', ...(major === 2 ? ['ids.schema.json'] : [])]) ajv.addSchema(corpusSchema(`${p}${dep}`) as object);
  const validate = ajv.compile(corpusSchema(`${p}suspend-request.schema.json`) as object);
  return (payload) => ({ ok: validate(payload) as boolean, errors: JSON.stringify(validate.errors ?? []) });
}
const V1 = validatorFor(1);
const V2 = validatorFor(2);

/** Representative host data per kind — what this host's nodes actually raise. */
const HOST_DATA: Record<InterruptRecord['kind'], unknown> = {
  approval: { prompt: 'Ship it?', actions: ['approve', 'reject'], requiredApprovals: 2, rejectionPolicy: 'single-veto', approverRefs: ['u1'], overrideScopes: ['x'], artifactId: 'run-event:r:gate', revisionId: 'r:gate:1' },
  clarification: { question: 'Which region?', schema: { type: 'string' } },
  refinement: { draft: 'v1' },
  cancellation: { reason: 'user' },
  'external-event': { eventType: 'stripe.checkout.completed', correlation: { sessionId: 's1' } },
  conversation: { conversationId: 'c1', turnIndex: 0 },
  timer: { until: '2026-10-01T00:00:00Z' },
  'tour-step': { step: 2 },
  'walkthrough-step': { step: 3 },
  credential: { provider: 'slack', scopes: ['chat:write'], reason: 'missing', connectUrl: 'https://h/connect', __resumeKey: 'n', __resumeStyle: 'reinvoke' },
};

describe('loop row 3, P2 — interrupt.md §Events — every host kind projects onto a valid InterruptPayload on BOTH majors', () => {
  it('the representative table covers every kind the projector maps (a new kind must be added here)', () => {
    expect(Object.keys(HOST_DATA).sort()).toEqual([...PROJECTED_HOST_KINDS].sort());
  });
  for (const kind of PROJECTED_HOST_KINDS) {
    it(`${kind}: valid on v1 and v2`, () => {
      const payload = buildInterruptRequestedPayload({
        runId: 'r', nodeId: 'n', kind, data: HOST_DATA[kind],
        ...(kind === 'credential' ? { resumeSchema: (corpusSchema('v2/suspend-request.schema.json') as { allOf: Array<{ then?: { properties?: { resumeSchema?: { const?: Record<string, unknown> } } } }> }).allOf.find((b) => b.then?.properties?.resumeSchema?.const)!.then!.properties!.resumeSchema!.const! } : {}),
        preview: { artifactId: 'run-event:r:n', artifactType: 'openwop-app.gate-preview' },
      });
      const v1 = V1(payload); const v2 = V2(payload);
      expect(v1.ok, `v1: ${v1.errors}`).toBe(true);
      expect(v2.ok, `v2: ${v2.errors}`).toBe(true);
      expect(JSON.stringify(payload), 'engine routing keys never reach the wire').not.toMatch(/__resume/);
    });
  }
  it('approval: the action vocabulary is the one interrupt.resolved records (approve → accept)', () => {
    const p = buildInterruptRequestedPayload({ runId: 'r', nodeId: 'n', kind: 'approval', data: HOST_DATA.approval, preview: { artifactId: 'a', artifactType: 't' } });
    expect(p.data['actions']).toEqual(['accept', 'reject']);
    expect(p.data).toMatchObject({ artifactId: 'a', artifactType: 't', title: 'Ship it?', requiredApprovals: 2 });
  });
  describe('resume validation admits ONLY normalised equivalents', () => {
    const gate = (actions: string[]) => ({ kind: 'approval', data: { actions } });
    const refused = (fn: () => void) => { try { fn(); } catch (e) { return (e as { httpStatus?: number }).httpStatus; } return undefined; };
    it('(1) `accept` is admitted on a gate that lists `approve` (the advertised spelling), and vice versa', () => {
      expect(() => validateResumeValue(gate(['approve', 'reject']), { action: 'accept' })).not.toThrow();
      expect(() => validateResumeValue(gate(['accept', 'reject']), { action: 'approve' })).not.toThrow();
    });
    it('(2) `accept` is REFUSED on a gate whose actions exclude approve/accept', () => {
      expect(refused(() => validateResumeValue(gate(['reject']), { action: 'accept' }))).toBe(400);
      expect(refused(() => validateResumeValue(gate(['refine']), { action: 'accept' }))).toBe(400);
      expect(refused(() => validateResumeValue(gate(['reject']), { action: 'approve' }))).toBe(400);
    });
    it('(4) `override` is not an equivalent: refused unless the gate lists it', () => {
      expect(refused(() => validateResumeValue(gate(['approve', 'reject']), { action: 'override' }))).toBe(400);
      expect(refused(() => validateResumeValue(gate(['accept', 'reject']), { action: 'override' }))).toBe(400);
      expect(() => validateResumeValue(gate(['approve', 'reject', 'override']), { action: 'override' })).not.toThrow();
    });
  });
  it('the key names the run, the node and the visit', () => {
    expect(buildInterruptRequestedPayload({ runId: 'r1', nodeId: 'gate', kind: 'timer', data: {} }).key).toBe('r1:gate:0');
  });
});

// ── real executor ───────────────────────────────────────────────────────────
const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-int-requested-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });
installRejectedGateRouter(storage, hostSuite);

beforeAll(() => {
  ensureNodesRegistered();
  const wf = (id: string, gate: Record<string, unknown>) => registerHostWorkflow({
    workflowId: id, name: id, version: '1.0.0',
    nodes: [gate, { nodeId: 'after', typeId: 'core.noop', config: {} }],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'after' }],
  } as unknown as WorkflowDefinition);
  wf('wf.p2.single', { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve?', rejectionPolicy: 'single-veto' } });
  wf('wf.p2.quorum', { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve?', requiredApprovals: 2 } });
  wf('wf.p2.clarify', { nodeId: 'gate', typeId: 'core.clarificationGate', config: { question: 'Which region?' } });
});

async function suspended(workflowId: string): Promise<{ runId: string; interrupt: InterruptRecord }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-p2-${Math.random().toString(36).slice(2)}`, workflowId, tenantId: 'default',
    status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(workflowId))!.definition;
  const r = await executeRun(storage, run, def);
  expect(r.status.startsWith('waiting')).toBe(true);
  const [interrupt] = await storage.listOpenInterrupts(run.runId);
  return { runId: run.runId, interrupt: interrupt! };
}

const LIFECYCLE = new Set(['node.started', 'node.suspended', 'interrupt.requested', 'interrupt.resolved', 'node.completed', 'node.failed', 'run.completed', 'run.failed']);
async function sequence(runId: string): Promise<string[]> {
  return (await storage.listEvents(runId)).filter((e) => LIFECYCLE.has(e.type)).map((e) => `${e.type}${e.nodeId ? `@${e.nodeId}` : ''}`);
}
async function requests(runId: string): Promise<EventRecord[]> {
  return (await storage.listEvents(runId)).filter((e) => e.type === 'interrupt.requested');
}
const REJECTED = ['node.started@gate', 'node.suspended@gate', 'interrupt.requested@gate', 'interrupt.resolved@gate', 'node.failed@gate', 'run.failed'];

describe('loop row 3, P2 — interrupt.md §Events — the full order on the real executor, one request per suspension', () => {
  it('approval, single reject', async () => {
    const { runId, interrupt } = await suspended('wf.p2.single');
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'reject' }, { capabilityToken: true });
    await __awaitRunResumeChainForTests(runId);
    expect(await sequence(runId)).toEqual(REJECTED);
    const [req] = await requests(runId);
    expect(req!.payload).toMatchObject({ kind: 'approval', key: `${runId}:gate:0`, data: { title: 'Approve?', actions: ['accept', 'reject'], artifactType: 'openwop-app.gate-preview' } });
    expect(V2(req!.payload).ok, V2(req!.payload).errors).toBe(true);
  });

  it('approval, quorum reject', async () => {
    const { runId, interrupt } = await suspended('wf.p2.quorum');
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'reject' }, { subjectRef: 'user:alice' });
    await __awaitRunResumeChainForTests(runId);
    expect(await sequence(runId)).toEqual(REJECTED);
    const [req] = await requests(runId);
    expect(req!.payload).toMatchObject({ kind: 'approval', data: { requiredApprovals: 2 } });
  });

  it('approval, timeout', async () => {
    const { runId, interrupt } = await suspended('wf.p2.single');
    process.env.OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC = '1';
    try {
      expect(await timeoutApprovalGateIfDue(storage, interrupt, Date.now() + 5_000)).toBe(true);
    } finally {
      delete process.env.OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC;
    }
    expect(await sequence(runId)).toEqual(REJECTED);
  });

  it('(3) `timeout` is still refused with 400 on a resume (RFC 0223, #4187), and the gate stays open', async () => {
    const { runId, interrupt } = await suspended('wf.p2.single');
    await expect(resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'timeout' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 400 });
    expect((await storage.listOpenInterrupts(runId)).length).toBe(1);
  });

  it('a timed approval still times out through the PERIODIC sweep (openInterruptsForSweep), with the same order', async () => {
    // #4205's openInterruptSweep drives both periodic sweeps; this change adds
    // an event and binds a preview onto approval data, and must not alter which
    // open interrupts the sweep picks up.
    const { runId, interrupt } = await suspended('wf.p2.single');
    process.env.OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC = '1';
    try {
      expect(await sweepExpiredApprovalGates(storage, Date.now() + 5_000)).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC;
    }
    await __awaitRunResumeChainForTests(runId);
    expect((await storage.getInterrupt(interrupt.interruptId))?.resolvedValue).toEqual({ action: 'reject', reason: 'timeout' });
    expect(await sequence(runId)).toEqual(REJECTED);
  });

  it('approval, accept: the resume does NOT re-emit the request', async () => {
    const { runId, interrupt } = await suspended('wf.p2.single');
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'accept' }, { capabilityToken: true });
    await __awaitRunResumeChainForTests(runId);
    expect(await sequence(runId)).toEqual([
      'node.started@gate', 'node.suspended@gate', 'interrupt.requested@gate', 'interrupt.resolved@gate',
      'node.completed@gate', 'node.started@after', 'node.completed@after', 'run.completed',
    ]);
  });

  it('clarification: requested with a projected question, then resolved and completed', async () => {
    const { runId, interrupt } = await suspended('wf.p2.clarify');
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { answer: 'EU' }, { capabilityToken: true });
    await __awaitRunResumeChainForTests(runId);
    expect(await sequence(runId)).toEqual([
      'node.started@gate', 'node.suspended@gate', 'interrupt.requested@gate', 'interrupt.resolved@gate',
      'node.completed@gate', 'node.started@after', 'node.completed@after', 'run.completed',
    ]);
    const [req] = await requests(runId);
    expect(req!.payload).toMatchObject({ kind: 'clarification', data: { questions: [{ id: 'gate', question: 'Which region?' }] } });
    expect(V1(req!.payload).ok && V2(req!.payload).ok).toBe(true);
  });
});

// ── replay divergence, pre-change-source compatibility ─────────────────────
const ev = (type: string, nodeId: string, payload: unknown = {}): EventRecord =>
  ({ eventId: `${type}-${nodeId}-${Math.random()}`, runId: 'r', sequence: 0, type, nodeId, payload, timestamp: '' }) as unknown as EventRecord;

describe('loop row 3, P2 — interrupt.md §Events — replay divergence and the pre-change source', () => {
  const pre = [ev('node.started', 'gate'), ev('node.suspended', 'gate', { kind: 'approval' })];
  const post = [ev('node.started', 'gate'), ev('node.suspended', 'gate', { kind: 'approval' }), ev('interrupt.requested', 'gate', { kind: 'approval' })];

  it('a source recorded BEFORE the change (no approval request) does not diverge from a replay that emits one', () => {
    expect(compareObservableSequences(pre, post).diverged).toBe(false);
  });
  it('a source that HAS approval requests keeps the full comparison: a missing request is a divergence', () => {
    expect(compareObservableSequences(post, pre).diverged).toBe(true);
  });
  it('the skip is per KIND: a credential request in the source does not excuse an approval request, nor vice versa', () => {
    const src = [...pre, ev('interrupt.requested', 'cred', { kind: 'credential' })];
    const rep = [...post, ev('interrupt.requested', 'cred', { kind: 'credential' })];
    expect(compareObservableSequences(src, rep).diverged).toBe(false); // approval: pre-change; credential: compared, equal
    expect(compareObservableSequences(src, post).diverged, 'the replay dropped the credential request').toBe(true);
  });
});
