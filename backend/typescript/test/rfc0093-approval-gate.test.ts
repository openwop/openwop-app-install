/**
 * RFC 0093 §D — approval-gate timeout + quorum override (pins RFC 0051
 * UQ 1-2; spec text in `interrupt-profiles.md` §"Approval-gate timeout and
 * quorum override (RFC 0093)").
 *
 *   §D.1 Timeout ⇒ auto-reject (fail closed): an approval gate past its
 *        `timeoutSec` resolves as rejected with reason `timeout`, emitting
 *        the standard `interrupt.resolved` event with outcome "rejected" /
 *        reason "timeout". Enforced lazily on every interrupt access AND by
 *        the periodic sweep that rides the webhook worker tick.
 *   §D.2 Quorum override is opt-in: `overrideBypassesQuorum: true` lets a
 *        single override grant resolve the gate; default (absent/false) the
 *        override grant counts as ONE quorum vote. Both paths emit
 *        `approval.overridden { principal, reason }` (reason REQUIRED) and
 *        write an audit entry.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import {
  approvalGateDeadlineMs,
  sweepExpiredApprovalGates,
  timeoutApprovalGateIfDue,
} from '../src/executor/approvalGateTimeout.js';
import {
  __awaitRunResumeChainForTests,
  __resolveAndResumeForTests,
} from '../src/routes/interrupts.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-rfc0093-gate-')) });
const baseSuite = createHostAdapterSuite({ storage });
// Recording audit sink: Storage has no audit READ surface, so the §D.2
// audit-entry assertions capture through the sink (which still forwards to
// the real persistence path).
const auditEntries: Array<{ principalId?: string; action: string; resource?: string }> = [];
const hostSuite: typeof baseSuite = {
  ...baseSuite,
  auditSink: {
    record(input) {
      auditEntries.push({ principalId: input.principalId, action: input.action, resource: input.resource });
      baseSuite.auditSink.record(input);
    },
  },
};

const WORKFLOW_ID = 'wf.rfc0093-gate';

beforeAll(() => {
  getNodeRegistry().register({
    typeId: 'test.rfc0093-sink',
    version: '1.0.0',
    async execute() {
      return { status: 'success', outputs: { output: 'ok' } };
    },
  });
  const def: WorkflowDefinition = {
    workflowId: WORKFLOW_ID,
    nodes: [
      { nodeId: 'gate', typeId: 'test.rfc0093-sink' },
      { nodeId: 'sink', typeId: 'test.rfc0093-sink' },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'sink', triggerRule: 'all_success' }],
  };
  registerHostWorkflow(def);
});

let seq = 0;
async function seedRun(status: RunRecord['status'] = 'waiting-approval'): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-gate-${++seq}`,
    workflowId: WORKFLOW_ID,
    tenantId: 'default',
    status,
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

async function seedGate(runId: string, data: Record<string, unknown>, over: Partial<InterruptRecord> = {}): Promise<InterruptRecord> {
  const record: InterruptRecord = {
    interruptId: `int-gate-${++seq}`,
    runId,
    nodeId: 'gate',
    kind: 'approval',
    token: `tok-gate-${seq}`,
    data,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  };
  await storage.insertInterrupt(record);
  return record;
}

describe('rfc0093 §D.1 — gate timeout ⇒ auto-reject', () => {
  it('computes the deadline ladder: timeoutSec > timeoutMs > host default > none', async () => {
    const run = await seedRun();
    const created = new Date(Date.now() - 10_000).toISOString();
    const bySec = await seedGate(run.runId, { timeoutSec: 60 }, { createdAt: created });
    const byMs = await seedGate(run.runId, { timeoutMs: 90_000 }, { createdAt: created });
    const none = await seedGate(run.runId, {}, { createdAt: created });
    expect(approvalGateDeadlineMs(bySec)).toBe(Date.parse(created) + 60_000);
    expect(approvalGateDeadlineMs(byMs)).toBe(Date.parse(created) + 90_000);
    expect(approvalGateDeadlineMs(none)).toBeNull();
    process.env.OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC = '120';
    try {
      expect(approvalGateDeadlineMs(none)).toBe(Date.parse(created) + 120_000);
    } finally {
      delete process.env.OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC;
    }
    // Non-approval interrupts never gate-time-out.
    const clarification = await seedGate(run.runId, { timeoutSec: 1 }, { kind: 'clarification', createdAt: created });
    expect(approvalGateDeadlineMs(clarification)).toBeNull();
  });

  it('auto-rejects an overdue gate with reason timeout + the standard interrupt.resolved event', async () => {
    const run = await seedRun();
    const gate = await seedGate(
      run.runId,
      { timeoutSec: 1, requiredApprovals: 2 },
      { createdAt: new Date(Date.now() - 5_000).toISOString() },
    );

    expect(await timeoutApprovalGateIfDue(storage, gate)).toBe(true);

    const stored = await storage.getInterrupt(gate.interruptId);
    expect(stored?.resolvedAt).toBeTruthy();
    expect(stored?.resolvedValue).toEqual({ action: 'reject', reason: 'timeout' });

    const events = await storage.listEvents(run.runId);
    const resolved = events.find((e) => e.type === 'interrupt.resolved');
    expect(resolved).toBeDefined();
    expect(resolved!.payload).toMatchObject({
      interruptId: gate.interruptId,
      outcome: 'rejected',
      reason: 'timeout',
    });

    // Fail closed: the run failed, never auto-approved.
    const finalRun = await storage.getRun(run.runId);
    expect(finalRun?.status).toBe('failed');
    expect(events.some((e) => e.type === 'run.failed')).toBe(true);

    // Idempotent: a second pass is a no-op.
    expect(await timeoutApprovalGateIfDue(storage, (await storage.getInterrupt(gate.interruptId))!)).toBe(false);
  });

  it('does NOT time out a gate before its deadline or one with no timeout', async () => {
    const run = await seedRun();
    const fresh = await seedGate(run.runId, { timeoutSec: 3_600 });
    const untimed = await seedGate(run.runId, {});
    expect(await timeoutApprovalGateIfDue(storage, fresh)).toBe(false);
    expect(await timeoutApprovalGateIfDue(storage, untimed)).toBe(false);
    expect((await storage.getInterrupt(fresh.interruptId))?.resolvedAt).toBeUndefined();
  });

  it('the periodic sweep resolves overdue gates without any traffic', async () => {
    const run = await seedRun();
    const overdue = await seedGate(
      run.runId,
      { timeoutSec: 1 },
      { createdAt: new Date(Date.now() - 5_000).toISOString() },
    );
    const live = await seedGate(run.runId, { timeoutSec: 3_600 });

    const swept = await sweepExpiredApprovalGates(storage);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect((await storage.getInterrupt(overdue.interruptId))?.resolvedAt).toBeTruthy();
    expect((await storage.getInterrupt(live.interruptId))?.resolvedAt).toBeUndefined();
  });

  it('a late vote on a timed-out gate is refused (lazy check path)', async () => {
    const run = await seedRun();
    const gate = await seedGate(
      run.runId,
      { timeoutSec: 1, requiredApprovals: 2 },
      { createdAt: new Date(Date.now() - 5_000).toISOString() },
    );
    // Every interrupt route runs timeoutApprovalGateIfDue BEFORE acting:
    // the first access auto-rejects the overdue gate...
    expect(await timeoutApprovalGateIfDue(storage, gate)).toBe(true);
    // ...and the (now stale) vote attempt sees a resolved gate — the route
    // layer's resolvedAt check turns this into 409 interrupt_already_resolved.
    const stored = await storage.getInterrupt(gate.interruptId);
    expect(stored?.resolvedAt).toBeTruthy();
    expect(stored?.resolvedValue).toEqual({ action: 'reject', reason: 'timeout' });
  });
});

describe('rfc0093 §D.2 — quorum override semantics', () => {
  it('overrideBypassesQuorum: true — a single override grant resolves the gate and emits approval.overridden + audit', async () => {
    const run = await seedRun();
    const gate = await seedGate(run.runId, {
      requiredApprovals: 3,
      override: { requiredRole: 'owner', audited: true },
      overrideBypassesQuorum: true,
    });

    await __resolveAndResumeForTests(storage, hostSuite, gate.interruptId, {
      action: 'override',
      voter: 'principal-owner',
      reason: 'emergency change window',
    });
    await __awaitRunResumeChainForTests(run.runId);

    const stored = await storage.getInterrupt(gate.interruptId);
    expect(stored?.resolvedAt).toBeTruthy();

    const events = await storage.listEvents(run.runId);
    const overridden = events.find((e) => e.type === 'approval.overridden');
    expect(overridden).toBeDefined();
    expect(overridden!.payload).toMatchObject({
      principal: 'principal-owner',
      reason: 'emergency change window',
      bypassedQuorum: true,
    });

    // Audit-log entry written (RFC 0009/0010 requirement on the override path).
    expect(
      auditEntries.some((a) => a.action === 'approval.override' && a.resource === `interrupt:${gate.interruptId}`),
    ).toBe(true);
  });

  it('default (flag absent) — an override grant counts as ONE quorum vote', async () => {
    const run = await seedRun();
    const gate = await seedGate(run.runId, {
      requiredApprovals: 2,
      override: { requiredRole: 'owner', audited: true },
    });

    await __resolveAndResumeForTests(storage, hostSuite, gate.interruptId, {
      action: 'override',
      voter: 'principal-owner',
      reason: 'expedite',
    });
    // One vote of two — the gate MUST still be open.
    let stored = await storage.getInterrupt(gate.interruptId);
    expect(stored?.resolvedAt).toBeUndefined();

    // ...but the override event + audit still fired.
    const events = await storage.listEvents(run.runId);
    const overridden = events.find((e) => e.type === 'approval.overridden');
    expect(overridden).toBeDefined();
    expect(overridden!.payload).toMatchObject({ bypassedQuorum: false });

    // A second ordinary grant tips the quorum.
    await __resolveAndResumeForTests(storage, hostSuite, gate.interruptId, { action: 'accept', voter: 'peer' });
    await __awaitRunResumeChainForTests(run.runId);
    stored = await storage.getInterrupt(gate.interruptId);
    expect(stored?.resolvedAt).toBeTruthy();
  });

  it('the override path REQUIRES a reason (400 validation_error without one)', async () => {
    const run = await seedRun();
    const gate = await seedGate(run.runId, {
      requiredApprovals: 2,
      override: { requiredRole: 'owner' },
      overrideBypassesQuorum: true,
    });
    await expect(
      __resolveAndResumeForTests(storage, hostSuite, gate.interruptId, { action: 'override', voter: 'boss' }),
    ).rejects.toMatchObject({ code: 'validation_error', httpStatus: 400 });
    expect((await storage.getInterrupt(gate.interruptId))?.resolvedAt).toBeUndefined();
  });

  it('a gate WITHOUT an override block has no override path — the flag alone grants nothing', async () => {
    const run = await seedRun();
    const gate = await seedGate(run.runId, {
      requiredApprovals: 2,
      overrideBypassesQuorum: true, // no `override` config ⇒ unreachable
    });
    await __resolveAndResumeForTests(storage, hostSuite, gate.interruptId, {
      action: 'accept',
      override: true,
      voter: 'pretender',
      reason: 'should not matter',
    });
    // Counted as an ordinary single vote; gate still open, no override event.
    expect((await storage.getInterrupt(gate.interruptId))?.resolvedAt).toBeUndefined();
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'approval.overridden')).toBe(false);
  });
});
