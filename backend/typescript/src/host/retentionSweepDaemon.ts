/**
 * Retention sweep daemon (ADR 0077 Phase 3). Periodically deletes data past its
 * retention window, per (tenant, DataClassification), by fanning out to the
 * `registerRetentionPurger` seam. Time-based + subject-agnostic — distinct from the
 * subject-keyed GDPR erasure (`subjectErasure.ts`).
 *
 * DESTRUCTIVE → default OFF: the START is gated behind `OPENWOP_RETENTION_SWEEP_ENABLED`
 * at the boot call site (index.ts). Mirrors the `scheduleDaemon`/`refreshDaemon` pattern:
 * pure `processRetentionSweep(deps, now)` for deterministic tests; a re-entrancy-guarded
 * `setInterval(...).unref()` loop; a per-(tenant,classification,day) idempotency lease so
 * multiple fleet instances don't double-sweep; the audit row IS the tombstone (no separate
 * tombstone store exists — every purge emits `governance.retention.purged`).
 *
 * @see src/host/scheduleDaemon.ts — the daemon pattern this follows.
 */

import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { getInstanceId } from './instanceId.js';
import { getGovernancePolicy, listGovernedTenants, type GovernancePolicy } from './governanceService.js';
import { purgeRetained } from './retentionPurger.js';
import type { DataClassification } from './dataClassification.js';

const log = createLogger('host.retentionSweep');

const POLL_INTERVAL_MS = 60 * 60_000; // hourly — retention is day-granular
const DAY_MS = 86_400_000;
const CLAIM_KEY_PREFIX = 'retention-sweep:';   // the per-slot START lease (mutual exclusion)
const DONE_KEY_PREFIX = 'retention-swept:';    // the per-slot COMPLETION marker (GOV-3)
const CLAIM_PRUNE_AGE_MS = 2 * DAY_MS;
/** GOV-3 — a START claim older than this with NO completion marker is treated as a CRASHED
 *  holder, and the slot becomes eligible for same-day recovery instead of waiting for the
 *  next calendar day. Generous (2 poll intervals) so a normally-running sweep is never
 *  mistaken for a crash. Safe even if mis-tuned: the purge is idempotent (re-deleting an
 *  already-gone row is a no-op), so the lease is an EFFICIENCY guard, not a correctness one —
 *  a rare double-recovery is harmless redundant work, never data damage. */
const STALE_CLAIM_MS = 2 * POLL_INTERVAL_MS;
/** Classifications the sweep considers, with their default window (days) when unset.
 *  BOTH default to `null` (opt-in): retention purge only runs when an admin EXPLICITLY
 *  configures a window (`retention.confidentialPiiDays` / `retention.internalDays`).
 *  ADR 0081 P5 correction: the original `confidential-pii: 365` default meant registering
 *  ANY governance policy (e.g. a provider allowlist) silently armed a 365-day PII purge of
 *  durable, user-authored records (contacts/profiles/comments) once the sweep is enabled —
 *  a latent data-loss footgun. Making it opt-in (matching `internal`) requires deliberate
 *  intent before any personal data is auto-deleted. The PRD's 365 is now the recommended
 *  value an admin SETS, not an implicit default. */
const SWEPT: ReadonlyArray<{ classification: DataClassification; defaultDays: number | null }> = [
  { classification: 'confidential-pii', defaultDays: null },
  { classification: 'internal', defaultDays: null },
];

/** Resolve the retention window (days) for a classification, or null ⇒ never purge. */
export function windowDaysFor(policy: GovernancePolicy | null, classification: DataClassification, defaultDays: number | null): number | null {
  const r = policy?.retention;
  if (classification === 'confidential-pii') return r?.confidentialPiiDays ?? defaultDays;
  if (classification === 'internal') return r?.internalDays ?? defaultDays;
  return null; // 'public' is never retention-swept
}

export interface RetentionSweepDeps { storage: Storage }

/** Sweep every governed tenant × classification once. Returns the total rows purged by
 *  THIS instance. Exported pure for deterministic tests (pass `now`). */
export async function processRetentionSweep(deps: RetentionSweepDeps, now: number = Date.now()): Promise<number> {
  const tenants = await listGovernedTenants(); // explicit enumeration — never a wildcard
  const slot = Math.floor(now / DAY_MS); // one sweep per (tenant,classification) per day
  let purgedTotal = 0;
  let failedTotal = 0; // rows that matched the cutoff but could not be deleted (GOV-6 metrics)
  let claimedSlots = 0; // (tenant,classification) slots THIS instance owned + swept this tick
  let recoveredSlots = 0; // slots re-swept after a crashed holder (GOV-3)
  const nowIso = new Date(now).toISOString();
  for (const tenantId of tenants) {
    if (!tenantId) continue;
    const policy = await getGovernancePolicy(tenantId);
    for (const { classification, defaultDays } of SWEPT) {
      const days = windowDaysFor(policy, classification, defaultDays);
      if (days == null) continue; // no window ⇒ never purge this classification
      const slotKey = `${CLAIM_KEY_PREFIX}${tenantId}:${classification}:${slot}`;
      const doneKey = `${DONE_KEY_PREFIX}${tenantId}:${classification}:${slot}`;
      // GOV-3 — acquire the slot. The START claim gives mutual exclusion for the common
      // case; if it's already held, recover ONLY when that claim is STALE (its holder
      // crashed) AND the slot was never completed. We decide "completed?" by atomically
      // claiming the COMPLETION marker: winning it ⇒ not completed ⇒ recover; losing it ⇒
      // already done ⇒ skip. A normally-finished sweep writes the marker (below), so a
      // stale-but-completed slot is correctly skipped (no hourly re-scan regression).
      const start = await deps.storage.claimIdempotency(slotKey, nowIso);
      let sweep = start.claimed;
      let recovered = false;
      if (!sweep) {
        const ageMs = now - Date.parse(start.existing?.createdAt ?? nowIso);
        if (ageMs >= STALE_CLAIM_MS) {
          const done = await deps.storage.claimIdempotency(doneKey, nowIso);
          if (done.claimed) { sweep = true; recovered = true; } // marker absent ⇒ holder crashed
        }
      }
      if (!sweep) continue; // another instance owns this slot, or it's already completed
      claimedSlots += 1;
      if (recovered) { recoveredSlots += 1; log.warn('retention_slot_recovered', { tenantId, classification, slot }); }
      const cutoffIso = new Date(now - days * DAY_MS).toISOString();
      const results = await purgeRetained(tenantId, classification, cutoffIso);
      for (const r of results) {
        purgedTotal += r.deleted;
        failedTotal += r.failed;
        // The audit row IS the tombstone — never a silent cascade. Best-effort: an
        // audit-store failure must not abort the remaining tenants/classifications nor
        // suppress sibling tombstones (the delete already happened); log instead.
        // A purger that threw (`ok:false`) OR completed but could not delete some matched
        // rows (`failed>0`) is a partial_failure — the audit row carries the count + reason
        // so an operator can tell a clean no-op from a degraded purge (GOV-4).
        const outcome = !r.ok || r.failed > 0 ? 'partial_failure' : r.deleted > 0 ? 'success' : 'noop';
        await deps.storage.appendAudit({
          timestamp: new Date(now).toISOString(),
          action: 'governance.retention.purged',
          resource: `governance:${tenantId}`,
          outcome,
          payload: {
            tenantId, classification, feature: r.feature, cutoffIso, deleted: r.deleted,
            ...(r.failed > 0 ? { failed: r.failed } : {}),
            ...(r.error ? { error: r.error } : {}),
          },
        }).catch((err) => log.error('retention_audit_failed', {
          tenantId, classification, feature: r.feature, deleted: r.deleted,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
      // GOV-3 — mark the slot COMPLETED so a later stale-claim recovery tick knows this
      // slot finished and skips it (the marker reaching us via `done.claimed` in the
      // recovery path means it's already present; this overwrite is harmless). Best-effort:
      // if the write fails the slot may be redundantly re-swept later — idempotent, so safe.
      await deps.storage.putIdempotency({ key: doneKey, responseBody: 'done', responseStatus: 200, createdAt: nowIso })
        .catch((err) => log.error('retention_done_mark_failed', { tenantId, classification, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  // Sweep-completion metric (GOV-6): one structured line an operator/SRE can alert on —
  // how many slots this instance owned, how much it deleted, and whether any rows failed.
  if (claimedSlots > 0 || purgedTotal > 0) {
    log.info('retention_sweep_completed', { tenantsConsidered: tenants.length, claimedSlots, recoveredSlots, purged: purgedTotal, failed: failedTotal });
  }
  return purgedTotal;
}

export interface RetentionSweepDaemon { stop(): void }

/** Start the polling retention sweep for the running server. Gate the CALL behind
 *  `OPENWOP_RETENTION_SWEEP_ENABLED` (this function does not self-gate). */
export function startRetentionSweepDaemon(deps: RetentionSweepDeps): RetentionSweepDaemon {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await processRetentionSweep(deps);
      const pruneBefore = new Date(Date.now() - CLAIM_PRUNE_AGE_MS).toISOString();
      await deps.storage.pruneIdempotencyByPrefix(CLAIM_KEY_PREFIX, pruneBefore).catch(() => undefined);
      await deps.storage.pruneIdempotencyByPrefix(DONE_KEY_PREFIX, pruneBefore).catch(() => undefined); // GOV-3 completion markers
    } catch (err) {
      log.warn('retention sweep tick error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('retention sweep daemon started', { pollIntervalMs: POLL_INTERVAL_MS, instanceId: getInstanceId() });
  return { stop: () => clearInterval(timer) };
}
