/**
 * ADR 0779 D4 + D5 — a run's provider keys across suspend, resume and cancel.
 *
 * Real scheduler + the real resume path (`__resolveAndResumeForTests`, the same
 * `resolveAndResume` the HTTP route calls). Two test nodes stand in for a
 * provider call: `test.b779.leak` outputs the key it was handed (a node or a
 * provider error echoing a key — the thing the event scrub exists for), and
 * `test.b779.probe` reports whether the key it sees is the CURRENT one, never
 * the value itself.
 *
 *  - D4: the persisted `scheduler_snapshot` holds no run-secret value.
 *  - D5: suspend releases the plaintext; the resume re-resolves it, so it works
 *    with an empty in-process store (a restart / another instance) and sees a
 *    ROTATED key; a key deleted during the wait does not fail a tail that never
 *    needs it (tolerant); cancel releases.
 *
 * Sabotage record (on committed code):
 *   - `persistSnapshot` without `stripKnownRunSecrets`       → leg 1
 *   - drop `clearRunSecrets` after the suspend persist        → leg 2
 *   - drop the resume-time `prepareRunSecrets`                → leg 3
 *   - resume prepare with `tolerant: false`                   → leg 4
 *   - drop `clearRunSecrets` in `cancelRunAndCascade`         → leg 5
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { setChatStorage } from '../src/host/chatSurface.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __resolveAndResumeForTests, __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import { configureSecretResolver, setSecret, removeSecret } from '../src/byok/secretResolver.js';
import { getRunSecrets, setRunSecrets } from '../src/byok/ephemeralRunSecrets.js';
import { cancelRunAndCascade } from '../src/host/runCancel.js';
import { requestRunPause, clearRunPause } from '../src/executor/runLifecycle.js';
import type { NodeContext, NodeOutcome, WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
setDurableStorage(storage); // the run variable bag persists through it
const dataDir = mkdtempSync(join(tmpdir(), 'openwop-b779-'));
initInMemorySurfaces({ dataDir });
configureSecretResolver({ storage, dataDir });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });

const TENANT = 'demo';
const REF = 'byok:b779';
const REF2 = 'byok:b779-second';
const ORIGINAL = 'b779-ORIGINAL-provider-key-value-0001';
const ROTATED = 'b779-ROTATED-provider-key-value-0002';
const LEAK_WF = 'wf.b779-leak';
const PROBE_WF = 'wf.b779-probe';
const TAIL_WF = 'wf.b779-tail';

beforeAll(() => {
  ensureNodesRegistered();
  getNodeRegistry().register({
    typeId: 'test.b779.leak', version: '1.0.0', sideEffecting: false,
    async execute(ctx: NodeContext): Promise<NodeOutcome> {
      const key = (ctx.secrets as Record<string, string>)[REF] ?? '';
      // The realistic leak: the key EMBEDDED in a larger string (a provider
      // error echoing the header), and parked in the run's variable bag.
      ctx.variables?.set('lastAuth', `Authorization: Bearer ${key}`);
      return { status: 'success', outputs: { echoed: key || null, error: `401 Unauthorized for key ${key} (rotate it)` } };
    },
  });
  getNodeRegistry().register({
    typeId: 'test.b779.probe', version: '1.0.0', sideEffecting: false,
    async execute(ctx: NodeContext): Promise<NodeOutcome> {
      const key = (ctx.secrets as Record<string, string>)[REF];
      return { status: 'success', outputs: { present: typeof key === 'string', rotated: key === ROTATED } };
    },
  });
  getNodeRegistry().register({
    typeId: 'test.b779.probe2', version: '1.0.0', sideEffecting: false,
    async execute(ctx: NodeContext): Promise<NodeOutcome> {
      return { status: 'success', outputs: { present: typeof (ctx.secrets as Record<string, string>)[REF2] === 'string' } };
    },
  });
  const gate = { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve?' } };
  const defs: WorkflowDefinition[] = [
    { workflowId: LEAK_WF, name: 'leak', version: '1.0.0',
      nodes: [{ nodeId: 'leak', typeId: 'test.b779.leak', config: {} }, gate, { nodeId: 'after', typeId: 'core.noop', config: {} }],
      edges: [{ edgeId: 'e1', sourceNodeId: 'leak', targetNodeId: 'gate' }, { edgeId: 'e2', sourceNodeId: 'gate', targetNodeId: 'after' }] },
    { workflowId: PROBE_WF, name: 'probe', version: '1.0.0',
      nodes: [gate, { nodeId: 'probe', typeId: 'test.b779.probe', config: {} }],
      edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'probe' }] },
    { workflowId: TAIL_WF, name: 'tail', version: '1.0.0',
      nodes: [gate, { nodeId: 'after', typeId: 'test.b779.probe2', config: {} }],
      edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'after' }] },
  ] as unknown as WorkflowDefinition[];
  for (const d of defs) registerHostWorkflow(d);
});

async function startToGate(workflowId: string): Promise<RunRecord> {
  await setSecret(REF2, 'b779-second-provider-key-value-0003', { tenantId: TENANT });
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-b779-${Math.random().toString(36).slice(2)}`, workflowId, tenantId: TENANT,
    status: 'pending', inputs: {}, metadata: {}, configurable: { credentialRefs: [REF, REF2] }, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(workflowId))!.definition;
  const initial = await executeRun(storage, run, def);
  expect(initial.status).toBe('waiting-approval');
  return run;
}

async function approve(runId: string): Promise<void> {
  const [open] = await storage.listOpenInterrupts(runId);
  await __resolveAndResumeForTests(storage, hostSuite, open!.interruptId, { action: 'accept' });
  await __awaitRunResumeChainForTests(runId);
}

async function nodeOutputs(runId: string, nodeId: string): Promise<Record<string, unknown> | undefined> {
  const ev = (await storage.listEvents(runId)).find((e) => e.type === 'node.completed' && e.nodeId === nodeId);
  return (ev?.payload as { outputs?: Record<string, unknown> } | undefined)?.outputs;
}

describe('ADR 0779 D4/D5 — run secrets across suspend, resume and cancel', () => {
  it('leg 1 (D4): the persisted scheduler snapshot never holds the key a node echoed', async () => {
    await setSecret(REF, ORIGINAL, { tenantId: TENANT });
    const run = await startToGate(LEAK_WF);
    const row = await storage.getRun(run.runId);
    const snap = JSON.stringify((row as unknown as { schedulerSnapshot?: unknown }).schedulerSnapshot ?? '');
    expect(snap.length, 'the run must have persisted a snapshot').toBeGreaterThan(10);
    expect(snap, 'scheduler_snapshot carries the provider key in plaintext').not.toContain(ORIGINAL);
    expect(snap).toContain(`<<redacted:${REF}>>`);
    // Embedded occurrences are removed too, and the text around them survives.
    expect(snap).toContain(`401 Unauthorized for key <<redacted:${REF}>> (rotate it)`);
    // The run's variable bag is persisted as well (`runvars:<runId>`).
    await new Promise((r) => setTimeout(r, 25)); // the bag write is fire-and-forget
    const bag = await storage.kvGet(`runvars:${run.runId}`);
    expect(bag, 'the variable bag must have been persisted').toBeTruthy();
    expect(String(bag), 'runvars carries the provider key in plaintext').not.toContain(ORIGINAL);
  });

  it('leg 2 (D5): a suspended run holds no provider plaintext in process memory', async () => {
    await setSecret(REF, ORIGINAL, { tenantId: TENANT });
    const run = await startToGate(PROBE_WF);
    expect(getRunSecrets(run.runId), 'the suspend must release the run keys').toEqual({});
  });

  it('leg 3 (D5): the resume re-resolves — works with an empty store, and sees a ROTATED key', async () => {
    await setSecret(REF, ORIGINAL, { tenantId: TENANT });
    const run = await startToGate(PROBE_WF);
    await setSecret(REF, ROTATED, { tenantId: TENANT });
    await approve(run.runId);
    expect((await storage.getRun(run.runId))!.status).toBe('completed');
    expect(await nodeOutputs(run.runId, 'probe')).toEqual({ present: true, rotated: true });
  });

  it('leg 4 (D5): a key deleted during the wait costs only itself — the tail still gets the key it needs', async () => {
    await setSecret(REF, ORIGINAL, { tenantId: TENANT });
    const run = await startToGate(TAIL_WF);
    await removeSecret(REF, { tenantId: TENANT });
    await approve(run.runId);
    const final = (await storage.getRun(run.runId))!;
    expect(final.status, JSON.stringify(final.error)).toBe('completed');
    // Tolerant prep registered the ref that still resolves; a strict prep
    // would have thrown at the deleted one and registered nothing.
    expect(await nodeOutputs(run.runId, 'after')).toEqual({ present: true });
  });

  it('leg 6 (D5): a pause releases the run keys (the resume re-prepares them)', async () => {
    await setSecret(REF, ORIGINAL, { tenantId: TENANT });
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-b779-p-${Math.random().toString(36).slice(2)}`, workflowId: PROBE_WF, tenantId: TENANT,
      status: 'pending', inputs: {}, metadata: {}, configurable: { credentialRefs: [REF] }, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    requestRunPause(run.runId, { drainPolicy: 'drain-current-node', requestedAt: now });
    try {
      const def = (await hostSuite.workflowCatalog.getWorkflow(PROBE_WF))!.definition;
      expect((await executeRun(storage, run, def)).status).toBe('paused');
      expect(getRunSecrets(run.runId), 'a paused run must not hold provider plaintext').toEqual({});
    } finally {
      clearRunPause(run.runId);
    }
  });

  it('leg 5 (D5): a cancel releases the run keys on this instance', async () => {
    await setSecret(REF, ORIGINAL, { tenantId: TENANT });
    const run = await startToGate(TAIL_WF);
    setRunSecrets(run.runId, { [REF]: ORIGINAL }); // as if a node were mid-flight
    expect(await cancelRunAndCascade(storage, (await storage.getRun(run.runId))!, 'test')).toBe('cancelled');
    expect(getRunSecrets(run.runId)).toEqual({});
  });
});
