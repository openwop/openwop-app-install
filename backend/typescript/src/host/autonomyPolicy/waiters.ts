/**
 * ADR 0942 D5 — runs waiting on a PendingApproval-lane decision.
 *
 * When a chokepoint opens (or finds) an owning-kind approval for a campaign run,
 * the effect node suspends on `external-event` keyed `approval:<approvalId>` and
 * the run is recorded here. A spend approval is keyed by a fork-stable spend key,
 * so SEVERAL runs can wait on one row (a redrive, a second run proposing the same
 * spend): one waiter row per run, never a single field on the approval.
 *
 * `resumeRunsAwaitingApproval` is called by the owning kind's finalizer AFTER its
 * decision CAS. It resumes each waiting run's open interrupt through
 * `resolveAndResume` (the claude-code precedent). The node then re-invokes and
 * re-checks the chokepoint, which now finds the decided row. Best-effort per run: a
 * run that already moved on (cancelled, its interrupt gone) is skipped.
 *
 * The rows hold ids only (no subject), are tenant-reachable for teardown, and are
 * deleted once resumed.
 */
import { DurableCollection } from '../hostExtPersistence.js';
import type { Storage } from '../../storage/storage.js';
import type { HostAdapterSuite } from '../index.js';
import { createLogger } from '../../observability/logger.js';
import { isTerminalRunStatus } from '@openwop/openwop';
import { openInterruptsForSweep } from '../../executor/openInterruptSweep.js';
import { getApproval } from '../approvalService.js';

const log = createLogger('autonomy-waiters');

export const APPROVAL_WAIT_KEY_PREFIX = 'approval:';

interface ApprovalWaiter { tenantId: string; approvalId: string; runId: string; createdAt: string }

const waiters = new DurableCollection<ApprovalWaiter>(
  'autonomy:approval-waiter',
  (w) => `${w.tenantId}::${w.approvalId}::${w.runId}`,
  undefined,
  (w) => w.tenantId,
);

export async function recordApprovalWaiter(tenantId: string, approvalId: string, runId: string): Promise<void> {
  await waiters.putIfAbsent({ tenantId, approvalId, runId, createdAt: new Date().toISOString() });
}

/** Requester checks for a shared pending approval must include every run that
 * proposed that spend, including the owner identity on actorless runs. */
export async function approvalWaiterRunIds(tenantId: string, approvalId: string): Promise<string[]> {
  return (await waiters.listByPrefix(`${tenantId}::${approvalId}::`))
    .filter(w => w.tenantId === tenantId && w.approvalId === approvalId).map(w => w.runId);
}

let resumeDeps: { storage: Storage; hostSuite: HostAdapterSuite } | null = null;
/** Boot wiring (the claude-code `sweepDeps` precedent): the deps `resolveAndResume` needs. */
export function setApprovalResumeDeps(deps: { storage: Storage; hostSuite: HostAdapterSuite } | null): void { resumeDeps = deps; }

export async function resumeRunsAwaitingApproval(tenantId: string, approvalId: string, outcome: 'approved' | 'rejected'): Promise<number> {
  if (!resumeDeps) return 0;
  const { storage, hostSuite } = resumeDeps;
  const { resolveAndResume } = await import('../../routes/interrupts.js');
  let resumed = 0;
  for (const w of await waiters.listByPrefix(`${tenantId}::${approvalId}::`)) {
    if (w.tenantId !== tenantId || w.approvalId !== approvalId) continue;
    try {
      const open = await storage.listOpenInterrupts(w.runId);
      const it = open.find((i) => i.kind === 'external-event' && (i.data as { key?: unknown } | null)?.key === `${APPROVAL_WAIT_KEY_PREFIX}${approvalId}`);
      if (it) {
        await resolveAndResume(storage, hostSuite, it.interruptId, { approvalId, outcome });
        resumed++;
      } else {
        // Admission records the waiter before executeRun persists its interrupt.
        // A decision in that gap must leave durable recovery evidence behind.
        const run = await storage.getRun(w.runId);
        if (run && !isTerminalRunStatus(run.status)) continue;
      }
    } catch (err) {
      log.warn('approval_waiter_resume_failed', { approvalId, runId: w.runId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    await waiters.delete(`${w.tenantId}::${w.approvalId}::${w.runId}`);
  }
  return resumed;
}

/** Repair a decision-before-suspend, missed finalizer, or fork of an already
 * decided wait. One bounded rotating pass in the EXISTING dispatch daemon;
 * the interrupt CAS and dispatch lease remain the only execution owners. */
export async function reconcileApprovalWaits(storage: Storage, hostSuite: HostAdapterSuite): Promise<number> {
  const { resolveAndResume } = await import('../../routes/interrupts.js');
  let resumed = 0;
  for (const it of await openInterruptsForSweep(storage, 'autonomy-approval-wait', 20)) {
    if (it.kind !== 'external-event') continue;
    const key = (it.data as { key?: unknown } | null)?.key;
    if (typeof key !== 'string' || !key.startsWith(APPROVAL_WAIT_KEY_PREFIX)) continue;
    const approvalId = key.slice(APPROVAL_WAIT_KEY_PREFIX.length);
    try {
      const run = await storage.getRun(it.runId);
      if (!run || isTerminalRunStatus(run.status)) continue;
      const waiterKey = `${run.tenantId}::${approvalId}::${run.runId}`;
      const waiter = await waiters.get(waiterKey);
      if (!waiter || waiter.tenantId !== run.tenantId || waiter.runId !== run.runId || waiter.approvalId !== approvalId) continue;
      const approval = await getApproval(approvalId);
      if (!approval || approval.tenantId !== run.tenantId || approval.kind !== 'campaign-spend' || approval.status === 'pending') continue;
      await resolveAndResume(storage, hostSuite, it.interruptId, { approvalId, outcome: approval.status });
      await waiters.delete(waiterKey);
      resumed++;
    } catch (err) {
      log.warn('approval_waiter_recovery_failed', { approvalId, runId: it.runId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return resumed;
}
