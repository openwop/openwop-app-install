/**
 * ENG-1 — approval-gate timeout atomicity (compare-and-set, fire-once).
 *
 * The gate timeout is enforced from TWO independent paths (RFC 0093 §D.1):
 *   - LAZY: `timeoutApprovalGateIfDue` on every interrupt read/vote/resolve.
 *   - PERIODIC: `sweepExpiredApprovalGates` riding the worker tick.
 *
 * In a multi-instance deployment these can fire concurrently against the SAME
 * overdue gate. The resolve is gated on an atomic compare-and-set
 * (`storage.resolveInterrupt` succeeds only on the NULL→set transition), so the
 * gate resolves and `interrupt.resolved` / `run.failed` are emitted EXACTLY
 * once regardless of how the two paths interleave.
 *
 * This complements `rfc0093-approval-gate.test.ts` (which races two lazy calls)
 * by mixing the LAZY and the SWEEP path — the real production interleave — and
 * by racing them concurrently.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import {
  timeoutApprovalGateIfDue,
  sweepExpiredApprovalGates,
} from '../src/executor/approvalGateTimeout.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

let storage: Storage;
let seq = 0;

beforeEach(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-eng1-gate-')) });
});

async function seedRun(): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-eng1-gate-${++seq}`,
    workflowId: 'wf.eng1-gate',
    tenantId: 'default',
    status: 'waiting-approval',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

async function seedOverdueGate(runId: string): Promise<InterruptRecord> {
  const record: InterruptRecord = {
    interruptId: `int-eng1-gate-${++seq}`,
    runId,
    nodeId: 'gate',
    kind: 'approval',
    token: `tok-eng1-${seq}`,
    data: { timeoutSec: 1, requiredApprovals: 2 },
    createdAt: new Date(Date.now() - 5_000).toISOString(), // 5s old, 1s timeout ⇒ overdue
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  await storage.insertInterrupt(record);
  return record;
}

function assertResolvedExactlyOnce(
  results: boolean[],
  events: readonly { type: string }[],
): void {
  // Exactly one caller won the compare-and-set.
  expect(results.filter(Boolean)).toHaveLength(1);
  // Exactly one of each terminal event was emitted (no double-emit).
  expect(events.filter((e) => e.type === 'interrupt.resolved')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'run.failed')).toHaveLength(1);
}

describe('ENG-1 approval-gate timeout atomicity (lazy + sweep)', () => {
  it('lazy THEN sweep on the same overdue gate resolves exactly once', async () => {
    const run = await seedRun();
    const gate = await seedOverdueGate(run.runId);

    // Lazy path fires first (some route touched the gate)...
    const lazyWon = await timeoutApprovalGateIfDue(storage, gate);
    expect(lazyWon).toBe(true);
    // ...then the periodic sweep runs against the (now-resolved) gate.
    const sweptCount = await sweepExpiredApprovalGates(storage);
    expect(sweptCount).toBe(0); // already resolved ⇒ nothing left to time out

    const events = await storage.listEvents(run.runId);
    assertResolvedExactlyOnce([lazyWon, false], events);

    const finalRun = await storage.getRun(run.runId);
    expect(finalRun?.status).toBe('failed');
    expect(finalRun?.error?.code).toBe('approval_rejected');
  });

  it('sweep THEN lazy on the same overdue gate resolves exactly once', async () => {
    const run = await seedRun();
    const gate = await seedOverdueGate(run.runId);

    // The sweep wins first this time...
    const sweptCount = await sweepExpiredApprovalGates(storage);
    expect(sweptCount).toBe(1);
    // ...the lazy path then sees a resolved gate (re-fetched) and is a no-op.
    const stale = (await storage.getInterrupt(gate.interruptId))!;
    const lazyWon = await timeoutApprovalGateIfDue(storage, stale);
    expect(lazyWon).toBe(false);

    const events = await storage.listEvents(run.runId);
    assertResolvedExactlyOnce([true, lazyWon], events);
  });

  it('CONCURRENT lazy + sweep racing the same overdue gate resolve exactly once', async () => {
    const run = await seedRun();
    const gate = await seedOverdueGate(run.runId);

    // Both paths hold a snapshot with resolvedAt still unset and fire together —
    // the worst-case multi-instance interleave.
    const [lazyWon, sweptCount] = await Promise.all([
      timeoutApprovalGateIfDue(storage, gate),
      sweepExpiredApprovalGates(storage),
    ]);

    // Whoever loses the CAS contributes 0; the pair sums to exactly one win.
    expect((lazyWon ? 1 : 0) + sweptCount).toBe(1);

    const events = await storage.listEvents(run.runId);
    expect(events.filter((e) => e.type === 'interrupt.resolved')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run.failed')).toHaveLength(1);

    const finalRun = await storage.getRun(run.runId);
    expect(finalRun?.status).toBe('failed');
  });

  it('the gate resolves as REJECTED with reason timeout (fail closed, never auto-approve)', async () => {
    const run = await seedRun();
    const gate = await seedOverdueGate(run.runId);

    await timeoutApprovalGateIfDue(storage, gate);

    const stored = await storage.getInterrupt(gate.interruptId);
    expect(stored?.resolvedAt).toBeTruthy();
    expect(stored?.resolvedValue).toEqual({ action: 'reject', reason: 'timeout' });

    const events = await storage.listEvents(run.runId);
    const resolved = events.find((e) => e.type === 'interrupt.resolved');
    expect(resolved?.payload).toMatchObject({ outcome: 'rejected', reason: 'timeout' });
  });
});
