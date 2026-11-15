/**
 * ADR 1040 D7 F1 — `declineExpected` (and `actionLabels`) change the CARD's
 * words only. A reject on such a gate ends exactly as a reject on a plain gate:
 * the run fails `approval_rejected`, the downstream does not run, and the
 * recorded `interrupt.resolved` says `reject` / `rejected` either way.
 *
 * Real scheduler + the real resume path (`__resolveAndResumeForTests`, the same
 * `resolveAndResume` the HTTP route and /reviews call), the
 * approval-gate-reject-blocks harness.
 *
 * Red when: anything on the resolve or executor path starts reading the
 * wording keys (e.g. treating an expected decline as a completion).
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
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-decline-')) });
setChatStorage(storage);
const hostSuite = createHostAdapterSuite({ storage });

const PLAIN = 'wf.adr1040-plain-gate';
const WORDED = 'wf.adr1040-worded-gate';

beforeAll(() => {
  ensureNodesRegistered();
  const def = (workflowId: string, extra: Record<string, unknown>): WorkflowDefinition => ({
    workflowId,
    nodes: [
      { nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Apply?', rejectionPolicy: 'single-veto', ...extra } },
      { nodeId: 'apply', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'apply' }],
  });
  registerHostWorkflow(def(PLAIN, {}));
  registerHostWorkflow(def(WORDED, { actionLabels: { approve: 'bookai:useEdits', reject: 'bookai:notNow' }, declineExpected: true }));
});

async function rejectOn(workflowId: string) {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-1040-${Math.random().toString(36).slice(2)}`, workflowId, tenantId: 'default',
    status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(workflowId))!.definition;
  expect((await executeRun(storage, run, def)).status).toBe('waiting-approval');
  const [open] = await storage.listOpenInterrupts(run.runId);
  await __resolveAndResumeForTests(storage, hostSuite, open!.interruptId, { action: 'reject' });
  await __awaitRunResumeChainForTests(run.runId);
  const events = await storage.listEvents(run.runId);
  const final = (await storage.getRun(run.runId))!;
  const resolved = events.find((e) => e.type === 'interrupt.resolved')?.payload as Record<string, unknown> | undefined;
  return {
    status: final.status,
    code: (final.error as { code?: string } | undefined)?.code,
    applyRan: events.some((e) => e.nodeId === 'apply' && e.type === 'node.completed'),
    resolved: resolved ? { action: resolved.action, decision: resolved.decision } : undefined,
  };
}

describe('ADR 1040 D7 F1 — an expected decline ends exactly like any reject', () => {
  it('same run outcome, same recorded decision, downstream skipped, with or without the wording', async () => {
    const plain = await rejectOn(PLAIN);
    const worded = await rejectOn(WORDED);
    expect(plain).toEqual({ status: 'failed', code: 'approval_rejected', applyRan: false, resolved: { action: 'reject', decision: 'rejected' } });
    expect(worded).toEqual(plain);
  });
});
