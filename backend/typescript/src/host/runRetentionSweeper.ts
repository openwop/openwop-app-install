/**
 * ADR 0371 Phase 2 — the run-retention sweeper.
 *
 * Feed: `listRunsPastRemoval` (index range scan over the Phase 1 stamp),
 * bounded batches, optional quiet window. Per candidate, SWEEP-TIME
 * re-validation (policy may have changed since the stamp):
 *
 *   1. non-terminal ⇒ skip + CLEAR the stale stamp (live HITL state is never
 *      retention's business — a resumed/forked oddity must not be deleted);
 *   2. `run.metadata.pinned === true` ⇒ skip forever (a user promise);
 *   3. tenant legal hold ⇒ skip + COUNT (a hold that silently disables
 *      retention is itself an audit finding — the counters surface it);
 *   4. definition retention override (`definition.metadata.retention.ttlDays`,
 *      the same metadata channel as ADR 0369's lifecycle) extending past now
 *      ⇒ RE-STAMP `removal_at` to the extended deadline and skip — overrides
 *      added AFTER a run completed are honored, the write-time stamp is only
 *      the default;
 *   5. otherwise ⇒ `deleteRun` (the ONE cascade: run + events + interrupts +
 *      invocation-log).
 *
 * Multi-instance: deliberately LEASE-FREE — deletes are idempotent
 * (`deleteRun` returns whether a row existed), so concurrent sweeps race
 * harmlessly; a lease would add coordination for no correctness gain.
 */

import type { Storage } from '../storage/storage.js';
import { getRegisteredWorkflowAsync, listRegisteredWorkflows, deleteRegisteredWorkflow } from './workflowsRegistry.js';
import { lifecycleOf } from './workflowLifecycle.js';
import { removeOwnershipByWorkflowId } from './workflowOwnership.js';
import { listPendingApprovalsByKind } from './approvalService.js';
import { allOwnershipByWorkflow } from './workflowOwnership.js';
import { buildHostSurfaceBundle } from './inMemorySurfaces.js';
import type { RunRecord } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { workflowRoomLive } from './collab/workflowCollabResource.js';

const log = createLogger('host.runRetention');

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
const DAY_MS = 86_400_000;

/**
 * CONS-4 / WF-CONS-1 — the legal-hold STORE moved to `host/retentionHold.ts`.
 * It lived here, in the RUN-retention lane, and that placement is exactly why
 * the hold only ever reached runs: the other destructive lanes could not import
 * it without a cycle. Re-exported so every existing importer is unchanged.
 */
export {
  type RetentionHoldRecord,
  setRetentionHold,
  clearRetentionHold,
  listRetentionHolds,
  getRetentionHold,
} from './retentionHold.js';
import { getRetentionHold } from './retentionHold.js';

function batchSize(): number {
  const n = Number(process.env.OPENWOP_RUN_RETENTION_BATCH);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

/** `HH:MM-HH:MM` UTC; unset ⇒ always in-window. Overnight spans supported. */
export function inSweepWindow(now: Date = new Date()): boolean {
  const raw = process.env.OPENWOP_RUN_RETENTION_WINDOW;
  if (!raw) return true;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(raw);
  if (!m) return true; // malformed ⇒ fail open on sweeping (logged once at boot in Phase 3)
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

/** The definition's retention override, if a well-formed one exists. */
function overrideTtlDays(metadata: Record<string, unknown> | undefined): number | null {
  const retention = metadata?.retention;
  if (!retention || typeof retention !== 'object') return null;
  const days = (retention as Record<string, unknown>).ttlDays;
  return typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : null;
}

export interface SweepCounters {
  scanned: number;
  swept: number;
  skippedPinned: number;
  skippedHold: number;
  restampedOverride: number;
  clearedNonTerminal: number;
  exported: number;
  exportFailed: number;
}

/** ADR 0371 Phase 3 — opt-in NDJSON export to the tenant's blob store before
 *  the hard delete (the Temporal-Archival shape). One blob per run under the
 *  retention namespace: line 1 = the run row, then its events. Export failure
 *  SKIPS the delete (fail-safe: better a retained row than a lost record). */
async function exportRun(storage: Storage, run: RunRecord): Promise<boolean> {
  try {
    const events = await storage.listEvents(run.runId);
    const lines = [JSON.stringify({ kind: 'run', run }), ...events.map((e) => JSON.stringify({ kind: 'event', event: e }))];
    const bundle = buildHostSurfaceBundle({ tenantId: run.tenantId });
    const res = await bundle.storage.blob.put({
      key: `retention-export/${run.runId}.ndjson`,
      contentBase64: Buffer.from(lines.join('\n'), 'utf8').toString('base64'),
      contentType: 'application/x-ndjson',
    });
    return Boolean((res as { ok?: boolean }).ok ?? true);
  } catch (err) {
    log.warn('retention export failed', { runId: run.runId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function exportEnabled(): boolean {
  return process.env.OPENWOP_RUN_RETENTION_EXPORT === 'true';
}

export async function __runRetentionSweepOnce(storage: Storage, now: Date = new Date()): Promise<SweepCounters> {
  const c: SweepCounters = { scanned: 0, swept: 0, skippedPinned: 0, skippedHold: 0, restampedOverride: 0, clearedNonTerminal: 0, exported: 0, exportFailed: 0 };
  if (!inSweepWindow(now)) return c;
  const candidates = await storage.listRunsPastRemoval(now.toISOString(), batchSize());
  for (const run of candidates) {
    c.scanned += 1;
    if (!TERMINAL.has(run.status)) {
      // A non-terminal run with a stamp is a resumed fork/oddity — clear it;
      // the next terminal transition re-stamps.
      await storage.clearRunRemoval(run.runId);
      c.clearedNonTerminal += 1;
      continue;
    }
    if ((run.metadata as Record<string, unknown> | undefined)?.pinned === true) {
      c.skippedPinned += 1;
      continue;
    }
    if (await getRetentionHold(run.tenantId)) {
      c.skippedHold += 1;
      continue;
    }
    const def = await getRegisteredWorkflowAsync(run.workflowId);
    const ttlOverride = overrideTtlDays(def?.metadata as Record<string, unknown> | undefined);
    if (ttlOverride !== null) {
      const base = run.completedAt ? Date.parse(run.completedAt) : Date.parse(run.updatedAt);
      const extended = new Date(base + ttlOverride * DAY_MS);
      if (extended.getTime() > now.getTime()) {
        await storage.updateRun(run.runId, { removalAt: extended.toISOString() });
        c.restampedOverride += 1;
        continue;
      }
    }
    if (exportEnabled()) {
      if (await exportRun(storage, run)) c.exported += 1;
      else { c.exportFailed += 1; continue; } // fail-safe: keep the row, retry next sweep
    }
    await storage.deleteRun(run.runId);
    c.swept += 1;
  }
  if (c.scanned > 0) log.info('retention sweep', { ...c });
  lastSweep = { at: now.toISOString(), counters: c };
  return c;
}

/** ADR 0371 Phase 4 — the ADR 0369 GC, finally unblocked: an ARCHIVED
 *  transient definition whose last run has aged out of retention can be
 *  hard-deleted (replay has nothing left to re-resolve). The referenced
 *  refusal (`hasRunForWorkflow`) keeps protecting everything else; ownership
 *  rows go with the definition. Runs AFTER the run sweep on the same tick. */
export async function __runTransientDefGcOnce(storage: Storage): Promise<{ gcScanned: number; gcDeleted: number }> {
  let gcScanned = 0;
  let gcDeleted = 0;
  // ADR 0473 (review F7) — a draft under a PENDING composed-workflow proposal
  // is the reviewed artifact itself: a user archiving it in the builder (a
  // normal ADR 0369 verb) must not let this tick hard-delete it out from under
  // the open review card. Resolved proposals release the guard.
  const pendingProposalRefs = new Set(
    (await listPendingApprovalsByKind('composed-workflow')).map((a) => a.workflowId),
  );
  // ADR 0473 (grade-data D4) — a legal hold freezes deletion for the owning
  // tenant: this GC is the one path that hard-deletes tenant-authored
  // definitions with zero runs and zero tenant action (ignored proposal →
  // expiry-archive → collect), which a hold must interrupt.
  const owners = await allOwnershipByWorkflow();
  const heldTenants = new Map<string, boolean>();
  const anyOwnerHeld = async (workflowId: string): Promise<boolean> => {
    for (const tenantId of owners.get(workflowId) ?? []) {
      if (!heldTenants.has(tenantId)) heldTenants.set(tenantId, (await getRetentionHold(tenantId)) !== null);
      if (heldTenants.get(tenantId) === true) return true;
    }
    return false;
  };
  for (const def of listRegisteredWorkflows({ includeArchived: true, includeTransient: true })) {
    const lc = lifecycleOf(def);
    if (!lc.transient || !lc.archivedAt) continue; // only archived DRAFTS ever gc
    gcScanned += 1;
    if (pendingProposalRefs.has(def.workflowId)) continue;
    if (await anyOwnerHeld(def.workflowId)) continue;
    if (await storage.hasRunForWorkflow(def.workflowId)) continue;
    // ADR 0481 (code-review H2) — never GC a draft out from under a live
    // collab room (eligibility does not refuse archived drafts).
    if (await workflowRoomLive(def.workflowId)) continue;
    deleteRegisteredWorkflow(def.workflowId, [...(owners.get(def.workflowId) ?? [])]);
    await removeOwnershipByWorkflowId(def.workflowId);
    gcDeleted += 1;
    log.info('transient definition gc', { workflowId: def.workflowId, generatedBy: lc.generatedBy ?? null });
  }
  return { gcScanned, gcDeleted };
}

let lastSweep: { at: string; counters: SweepCounters } | null = null;
/** Superadmin observability (per-instance, like collab _debug). */
export function lastRetentionSweep(): { at: string; counters: SweepCounters } | null {
  return lastSweep;
}
