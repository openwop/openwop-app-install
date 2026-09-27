/**
 * PROBE-DOC-3 (falsifies WF-DOC-2 / GEN-DOC-2) — a rejected single-approver
 * `core.approvalGate` MUST NOT fire its downstream.
 *
 * The mechanism this pins: `requiredApprovals: 1` routes AROUND the quorum
 * machinery (`recordQuorumVote` returns null), and the executor's
 * resume-by-snapshot marked the resumed node `completed` verb-blind — so a
 * REAL reject payload (`{action:'reject'}`, the shape ApprovalCard sends)
 * completed the gate and released every downstream edge. `rejectionPolicy`
 * was inert config. Born-red witnessed: before the fix the reject leg
 * completed the run WITH the downstream node executed.
 *
 * The fix mirrors the two paths that already got this right — the quorum
 * reject (`reject-quorum` → run failed `approval_rejected`) and the RFC 0093
 * §D.1 timeout (auto-reject → run failed). Scope: `core.approvalGate` only.
 * The reinvoke lane (`core.chat.approvalGate`, ctx.suspend nodes) shapes its
 * own reject output and routes via conditioned edges — its semantics are
 * asserted by kicktodo-challenge-factory (B) and NOT changed here (this test
 * does not discriminate that lane; stated).
 *
 * Real scheduler + real resume path (`__resolveAndResumeForTests` — the same
 * `resolveAndResume` the HTTP route and the /reviews surface call).
 *
 * ADR 0600 §6 — these fixtures said `rejectionPolicy: 'block'`, copied from the
 * `insights-suite` chain that shipped it. `'block'` is in NEITHER vocabulary and
 * was silently coerced, so the probe written to prove the gate works was itself
 * carrying the drift it was next door to. `core.approvalGate` now refuses an
 * unrecognized token, which is how these three sites were FOUND; they are moved
 * to `single-veto` (the wire schema's own default spelling for the behaviour they
 * always meant), so they now also cover that token end-to-end through a real run.
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
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __resolveAndResumeForTests, __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-gate-reject-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });

const WF_ID = 'wf.probe-doc-3-gate';

beforeAll(() => {
  ensureNodesRegistered();
  // The anniversary-draft shape: gate → unconditional downstream effect
  // (the edge shape every core.approvalGate consumer in the corpus ships).
  const def: WorkflowDefinition = {
    workflowId: WF_ID,
    name: 'PROBE-DOC-3',
    version: '1.0.0',
    nodes: [
      { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve?', rejectionPolicy: 'single-veto' } },
      { nodeId: 'notify', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'notify' }],
  } as unknown as WorkflowDefinition;
  registerHostWorkflow(def);
});

async function runAndResolve(resumeValue: unknown): Promise<{ status: string; error?: unknown; states: Record<string, string> }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-probe3-${Math.random().toString(36).slice(2)}`, workflowId: WF_ID, tenantId: 'default',
    status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(WF_ID))!.definition;
  const initial = await executeRun(storage, run, def);
  expect(initial.status).toBe('waiting-approval');
  const open = await storage.listOpenInterrupts(run.runId);
  expect(open.length).toBe(1);
  await __resolveAndResumeForTests(storage, hostSuite, open[0]!.interruptId, resumeValue);
  await __awaitRunResumeChainForTests(run.runId);
  const events = await storage.listEvents(run.runId);
  const states: Record<string, string> = {};
  for (const e of events) {
    if (e.type === 'node.completed' && e.nodeId) states[e.nodeId] = 'completed';
    if (e.type === 'node.failed' && e.nodeId) states[e.nodeId] = 'failed';
  }
  const final = (await storage.getRun(run.runId))!;
  return { status: final.status, error: final.error, states };
}

describe('PROBE-DOC-3 — single-approver core.approvalGate honors reject', () => {
  it('the REAL reject payload fails the run and the downstream does NOT run', async () => {
    const { status, error, states } = await runAndResolve({ action: 'reject', comment: 'No.' });
    expect(status).toBe('failed');
    expect((error as { code?: string } | undefined)?.code).toBe('approval_rejected');
    expect(states['notify'], 'the downstream effect fired on a REJECT — the gate did not gate').toBeUndefined();
  });

  it('polarity: an accept resumes and the downstream DOES run', async () => {
    const { status, states } = await runAndResolve({ action: 'accept' });
    expect(status).toBe('completed');
    expect(states['gate']).toBe('completed');
    expect(states['notify']).toBe('completed');
  });
});

/**
 * Review F1 — the reject guard must FAIL CLOSED on an UNIDENTIFIABLE gate node.
 *
 * The first cut of the WF-DOC-2 fix fired only when the node RESOLVED as
 * `core.approvalGate`; when the run's definition no longer contained the node
 * (reachable: the anon-lane seams resolve from HEAD, and the builder permits
 * deleting/renaming a referenced node) it fell through to the verb-blind
 * accept — the original bug, one layer down. An unprovable reject must never
 * be converted into an accept: the resolve is REFUSED (409 `conflict`,
 * `details.reason: 'approval_node_unresolvable'`) and the interrupt stays
 * OPEN. DECISION (stated): the refusal covers BOTH verbs of an approval-kind
 * interrupt — an approve on an unidentifiable node used to consume the
 * suspend and then die on the resume lookups, stranding the run with the
 * interrupt already spent; refusing first keeps it recoverable (the polarity
 * arm below proves recovery: restore the definition, approve, run completes).
 */
describe('review F1 — an unidentifiable gate node fails CLOSED (409, both verbs)', () => {
  const WF2_ID = 'wf.review-f1-unresolvable-gate';
  const v1 = (): WorkflowDefinition => ({
    workflowId: WF2_ID,
    name: 'review F1',
    version: '1.0.0',
    nodes: [
      { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve?', rejectionPolicy: 'single-veto' } },
      { nodeId: 'notify', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'notify' }],
  } as unknown as WorkflowDefinition);

  async function suspendedRun(): Promise<{ runId: string; interruptId: string }> {
    registerHostWorkflow(v1());
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-f1-${Math.random().toString(36).slice(2)}`, workflowId: WF2_ID, tenantId: 'default',
      status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    const def = (await hostSuite.workflowCatalog.getWorkflow(WF2_ID))!.definition;
    const initial = await executeRun(storage, run, def);
    expect(initial.status).toBe('waiting-approval');
    const open = await storage.listOpenInterrupts(run.runId);
    expect(open.length).toBe(1);
    // The head moves past the gate: the builder renames the referenced node.
    // This run carries no pinned revision, so resolveRunDefinition serves the
    // NEW head, in which `gate` no longer exists.
    registerHostWorkflow({
      ...v1(),
      version: '1.1.0',
      nodes: [
        { nodeId: 'gate-renamed', typeId: 'core.approvalGate', config: { prompt: 'Approve?', rejectionPolicy: 'single-veto' } },
        { nodeId: 'notify', typeId: 'core.noop', config: {} },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'gate-renamed', targetNodeId: 'notify' }],
    } as unknown as WorkflowDefinition);
    return { runId: run.runId, interruptId: open[0]!.interruptId };
  }

  async function assertUntouched(runId: string): Promise<void> {
    // The refusal must leave everything as it was: interrupt open, run still
    // waiting, downstream never fired.
    expect((await storage.listOpenInterrupts(runId)).length, 'the interrupt must stay OPEN').toBe(1);
    expect((await storage.getRun(runId))!.status).toBe('waiting-approval');
    const events = await storage.listEvents(runId);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'notify'), 'downstream ran off a refused resolve').toBe(false);
    expect(events.some((e) => e.type === 'interrupt.resolved' || e.type === 'interrupt.resolved'), 'a refused resolve must not record a resolution').toBe(false);
  }

  it('a REJECT on an unresolvable node is refused (409), not converted into an accept', async () => {
    const { runId, interruptId } = await suspendedRun();
    await expect(__resolveAndResumeForTests(storage, hostSuite, interruptId, { action: 'reject', comment: 'No.' }))
      .rejects.toMatchObject({ code: 'conflict', httpStatus: 409, details: { reason: 'approval_node_unresolvable' } });
    await assertUntouched(runId);
  });

  it('an APPROVE on the same shape is refused too (the stated conservative choice)', async () => {
    const { runId, interruptId } = await suspendedRun();
    await expect(__resolveAndResumeForTests(storage, hostSuite, interruptId, { action: 'accept' }))
      .rejects.toMatchObject({ code: 'conflict', httpStatus: 409, details: { reason: 'approval_node_unresolvable' } });
    await assertUntouched(runId);
  });

  it('recovery polarity: restore the definition and the SAME interrupt approves cleanly', async () => {
    const { runId, interruptId } = await suspendedRun();
    await expect(__resolveAndResumeForTests(storage, hostSuite, interruptId, { action: 'reject' }))
      .rejects.toMatchObject({ code: 'conflict' });
    registerHostWorkflow(v1()); // the operator restores the node
    await __resolveAndResumeForTests(storage, hostSuite, interruptId, { action: 'accept' });
    await __awaitRunResumeChainForTests(runId);
    const final = (await storage.getRun(runId))!;
    expect(final.status).toBe('completed');
  });
});
