/**
 * RFC 0223 (openwop#1700, interrupt.md §Rejection) — a rejected approval gate is
 * a FAILED SOURCE, routed by the scheduler like any failed node:
 *
 *   - it MUST NOT satisfy `all_success`, `any_success` or `none_failed`;
 *   - the run continues past it only over `all_complete` / `any_failed`;
 *   - with no such edge the run fails `approval_rejected`, `failedNodeId` = gate.
 *
 * Before this, all three reject paths wrote `run.failed` directly and never
 * re-entered the executor, so no edge out of a rejected gate could ever fire.
 *
 * Driven on the REAL executor + event log for every reject path — the
 * single-approver reject, the quorum reject, and the timeout sweep — against
 * the SAME five-rule matrix, because the three paths used to be three separate
 * implementations and "routes the same way" is the claim under test.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { executeRun } from '../src/executor/executor.js';
import { timeoutApprovalGateIfDue } from '../src/executor/approvalGateTimeout.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __awaitRunResumeChainForTests, resolveAndResume } from '../src/routes/interrupts.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { EventRecord, RunRecord } from '../src/types.js';
import { installRejectedGateRouter } from './support/rejectedGateRouter.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-reject-routing-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });
installRejectedGateRouter(storage, hostSuite);

type Rule = 'all_success' | 'any_success' | 'all_complete' | 'none_failed' | 'any_failed';
type Path = 'single' | 'quorum' | 'timeout';
const RULES: readonly Rule[] = ['all_success', 'any_success', 'all_complete', 'none_failed', 'any_failed'];
const ROUTES: ReadonlySet<Rule> = new Set(['all_complete', 'any_failed']);

const wfId = (path: Path, rule: Rule): string => `wf.reject-routing.${path}.${rule}`;

beforeAll(() => {
  ensureNodesRegistered();
  for (const path of ['single', 'quorum', 'timeout'] as const) {
    for (const rule of RULES) {
      registerHostWorkflow({
        workflowId: wfId(path, rule),
        name: `reject routing ${path} ${rule}`,
        version: '1.0.0',
        nodes: [
          {
            nodeId: 'gate',
            typeId: 'core.approvalGate',
            config: path === 'quorum' ? { prompt: 'Approve?', requiredApprovals: 2 } : { prompt: 'Approve?', rejectionPolicy: 'single-veto' },
          },
          { nodeId: 'recover', typeId: 'core.noop', config: {} },
        ],
        edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'recover', triggerRule: rule }],
      } as unknown as WorkflowDefinition);
    }
  }
});

async function rejectVia(path: Path, rule: Rule): Promise<{ run: RunRecord; events: EventRecord[] }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-routing-${path}-${rule}-${Math.random().toString(36).slice(2)}`, workflowId: wfId(path, rule), tenantId: 'default',
    status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(wfId(path, rule)))!.definition;
  expect((await executeRun(storage, run, def)).status).toBe('waiting-approval');
  const [open] = await storage.listOpenInterrupts(run.runId);
  if (path === 'single') {
    await resolveAndResume(storage, hostSuite, open!.interruptId, { action: 'reject' }, { capabilityToken: true });
  } else if (path === 'quorum') {
    await resolveAndResume(storage, hostSuite, open!.interruptId, { action: 'reject' }, { subjectRef: 'user:alice' });
  } else {
    // `core.approvalGate` carries no per-gate timeout into its interrupt data,
    // so the gate expires on the host default (the RFC 0093 ladder's 2nd rung).
    process.env.OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC = '1';
    try {
      expect(await timeoutApprovalGateIfDue(storage, open!, Date.now() + 5_000)).toBe(true);
    } finally {
      delete process.env.OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC;
    }
  }
  await __awaitRunResumeChainForTests(run.runId);
  return { run: (await storage.getRun(run.runId))!, events: [...(await storage.listEvents(run.runId))] };
}

const EXPECTED_RESOLVED: Record<Path, Record<string, unknown>> = {
  single: { decision: 'rejected', action: 'reject' },
  quorum: { decision: 'rejected', action: 'reject', reason: 'quorum-reject' },
  timeout: { decision: 'rejected', action: 'timeout', reason: 'timeout' },
};

for (const path of ['single', 'quorum', 'timeout'] as const) {
  describe(`RFC 0223 — ${path} reject routes through the scheduler`, () => {
    for (const rule of RULES) {
      const routes = ROUTES.has(rule);
      it(`${rule}: ${routes ? 'admits the failed gate — the downstream runs and the run COMPLETES' : 'skips — the run fails naming the gate'}`, async () => {
        const { run, events } = await rejectVia(path, rule);
        const at = (type: string, nodeId?: string): number =>
          events.findIndex((e) => e.type === type && (nodeId === undefined || e.nodeId === nodeId));

        // Every path: resolved first, then the gate NODE fails, never retryable.
        const resolvedAt = at('interrupt.resolved', 'gate');
        const failedAt = at('node.failed', 'gate');
        expect(resolvedAt, 'interrupt.resolved is recorded').toBeGreaterThanOrEqual(0);
        expect(events[resolvedAt]!.payload).toMatchObject(EXPECTED_RESOLVED[path]);
        expect(failedAt, 'the gate node fails').toBeGreaterThan(resolvedAt);
        expect(events[failedAt]!.payload).toMatchObject({
          nodeId: 'gate',
          error: { code: 'approval_rejected', retryable: false },
        });
        expect(events.filter((e) => e.type === 'node.failed' && e.nodeId === 'gate')).toHaveLength(1);
        expect(events.filter((e) => e.type === 'interrupt.resolved')).toHaveLength(1);

        if (routes) {
          // (a)/(b) — the edge admits a failed source: recover runs, run completes.
          const recoverDone = at('node.completed', 'recover');
          expect(recoverDone, `${rule} must fire out of a rejected gate`).toBeGreaterThan(failedAt);
          expect(run.status).toBe('completed');
          expect(at('run.failed'), 'a routed rejection must not fail the run').toBe(-1);
          expect(at('run.completed')).toBeGreaterThan(recoverDone);
        } else {
          // (c) — the edge does not admit it: recover never runs, and the run
          // fails ONLY now, naming the gate, as the log's terminal event.
          expect(at('node.started', 'recover'), `${rule} must NOT fire out of a rejected gate`).toBe(-1);
          expect(at('node.completed', 'recover')).toBe(-1);
          expect(run.status).toBe('failed');
          expect((run.error as { code?: string } | undefined)?.code).toBe('approval_rejected');
          const runFailedAt = at('run.failed');
          expect(runFailedAt).toBeGreaterThan(failedAt);
          expect(runFailedAt, 'run.failed is terminal').toBe(events.length - 1);
          expect(events[runFailedAt]!.payload).toMatchObject({
            failedNodeId: 'gate',
            error: { code: 'approval_rejected' },
          });
        }
      });
    }
  });
}

async function suspendedRun(rule: Rule): Promise<{ runId: string; interruptId: string }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-routing-race-${Math.random().toString(36).slice(2)}`, workflowId: wfId('single', rule), tenantId: 'default',
    status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(wfId('single', rule)))!.definition;
  expect((await executeRun(storage, run, def)).status).toBe('waiting-approval');
  const [open] = await storage.listOpenInterrupts(run.runId);
  return { runId: run.runId, interruptId: open!.interruptId };
}

describe('RFC 0223 — exactly-once around the routed rejection', () => {
  it('a caller that PRE-CLAIMED the interrupt (the MCP retry) still routes a reject — the run is not stranded', async () => {
    const { runId, interruptId } = await suspendedRun('all_success');
    // The ENG-6 claim the MCP retry makes before calling resolveAndResume.
    expect(await storage.resolveInterrupt(interruptId, { action: 'reject' }, new Date().toISOString())).toBe(true);
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'reject' }, { capabilityToken: true, preclaimed: true });
    await __awaitRunResumeChainForTests(runId);
    const run = (await storage.getRun(runId))!;
    expect(run.status, 'a pre-claimed reject used to lose its own CAS and leave the run waiting').toBe('failed');
    const events = await storage.listEvents(runId);
    expect(events.some((e) => e.type === 'node.failed' && e.nodeId === 'gate')).toBe(true);
  });

  it('a losing ACCEPT arriving after the rejection ROUTED on (run live, waiting at a second gate) does not complete the failed gate', async () => {
    // The case the executor's own terminal guard cannot cover: the rejection
    // routed over any_failed to a second gate, so the run is NOT terminal and
    // its persisted snapshot is live. A late accept for the FIRST gate would
    // hydrate that snapshot and mark the failed gate completed.
    const WF = 'wf.reject-routing.race-second-gate';
    registerHostWorkflow({
      workflowId: WF, name: 'race second gate', version: '1.0.0',
      nodes: [
        { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve?', rejectionPolicy: 'single-veto' } },
        { nodeId: 'gate2', typeId: 'core.approvalGate', config: { prompt: 'Escalate?', rejectionPolicy: 'single-veto' } },
        { nodeId: 'after', typeId: 'core.noop', config: {} },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'gate2', triggerRule: 'any_failed' },
        { edgeId: 'e2', sourceNodeId: 'gate', targetNodeId: 'after', triggerRule: 'all_success' },
      ],
    } as unknown as WorkflowDefinition);
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-routing-race2-${Math.random().toString(36).slice(2)}`, workflowId: WF, tenantId: 'default',
      status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    expect((await executeRun(storage, run, (await hostSuite.workflowCatalog.getWorkflow(WF))!.definition)).status).toBe('waiting-approval');
    const [first] = await storage.listOpenInterrupts(run.runId);
    await resolveAndResume(storage, hostSuite, first!.interruptId, { action: 'reject' }, { capabilityToken: true });
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))!.status, 'routed on to gate2').toBe('waiting-approval');
    // The late accept for the ALREADY-REJECTED first gate. ADR 0778 D1 — it is
    // now REFUSED (409) rather than queued behind the rejection; the event
    // assertions below are the invariant either way.
    await expect(resolveAndResume(storage, hostSuite, first!.interruptId, { action: 'accept' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 409 });
    await __awaitRunResumeChainForTests(run.runId);
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'gate'), 'the late accept completed a rejected gate').toBe(false);
    expect(events.some((e) => e.type === 'node.started' && e.nodeId === 'after'), 'the late accept released the all_success branch').toBe(false);
    expect((await storage.getRun(run.runId))!.status).toBe('waiting-approval');
  });

  it('a concurrent ACCEPT queued behind a routed rejection does not complete the failed gate', async () => {
    const { runId, interruptId } = await suspendedRun('all_success');
    // The reject wins the CAS and queues its resume; the accept arrives before
    // that resume has run. CORRECTED (ADR 0778 D1): this said the accept "cannot
    // CAS its own resolve (pre-claiming callers rely on it being a no-op write)",
    // and so queued a resume guarded only by the chained executor finding the
    // gate no longer suspended — which holds only when the reject's resume was
    // queued FIRST. Pre-claiming callers now say so (`preclaimed`), and the
    // accept claims like both reject paths: it loses, and is refused.
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'reject' }, { capabilityToken: true });
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'accept' }, { capabilityToken: true }))
      .rejects.toMatchObject({ httpStatus: 409 });
    await __awaitRunResumeChainForTests(runId);
    const events = await storage.listEvents(runId);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'gate'), 'the losing accept completed a rejected gate').toBe(false);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'recover'), 'the losing accept released all_success downstream').toBe(false);
    expect((await storage.getRun(runId))!.status).toBe('failed');
  });
});
