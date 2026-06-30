/**
 * Retention-purger registry (ADR 0077 Phase 3) — the time-based sibling of
 * `subjectErasure.ts`.
 *
 * The registration PATTERN is reused; the HANDLERS are not. `SubjectEraser` purges
 * ALL of one identified person's data (subject-keyed, age-blind); retention purges
 * rows OLDER than a cutoff for a classification, regardless of subject. Only the
 * feature knows its own age field + tenant key + which rows are which classification,
 * so each feature registers a `RetentionPurger` and the daemon fans out a per-(tenant,
 * classification) cutoff to them. Host owns the seam; features import it; core never
 * imports features (no cycle).
 *
 * Fan-out is best-effort (one feature's failure must not block the others) and the
 * caller (the sweep daemon) is responsible for the audit row — this seam stays pure.
 */

import { createLogger } from '../observability/logger.js';
import type { DataClassification } from './dataClassification.js';

const log = createLogger('host.retentionPurger');

/** What a purger reports back: rows actually deleted, plus how many MATCHED the cutoff but
 *  failed to delete (a degraded-storage hiccup). A bare `number` is still accepted for
 *  back-compat (interpreted as `{ deleted, failed: 0 }`). */
export interface PurgeOutcome { deleted: number; failed?: number }

export interface RetentionPurger {
  /** Feature name, for audit attribution. */
  feature: string;
  /**
   * Delete this feature's rows of `classification` older than `cutoffIso`, scoped to
   * `tenantId`. Returns the count deleted (or a `PurgeOutcome` to also report rows that
   * matched but could not be deleted). MUST no-op (return 0) on a falsy tenant
   * (fail-closed — never a global/cross-tenant purge).
   */
  purge(tenantId: string, classification: DataClassification, cutoffIso: string): Promise<number | PurgeOutcome>;
}

const purgers: RetentionPurger[] = [];

/** Register a per-feature retention purger (idempotent by reference). */
export function registerRetentionPurger(p: RetentionPurger): void {
  if (!purgers.includes(p)) purgers.push(p);
}

/**
 * Shared age-based purge for every feature purger (GOV-1 + GOV-6): delete this tenant's
 * rows whose `updatedAt` is STRICTLY older than `cutoffIso`, RESILIENT to a per-row delete
 * failure — a single row that fails to delete is logged + counted, never aborts the loop,
 * so already-deleted progress and the returned count are not lost mid-purge (the prior
 * hand-rolled loops let one throwing `delete()` abort the whole purge, reverting the result
 * to `ok:false, deleted:0` while N rows were in fact already gone). Returns `{ deleted,
 * failed }`. NOTE: the scan itself is still a full-collection read — bounding it to the
 * tenant slice needs the tenant-prefixed-id migration tracked as FEAT-1; the resilience is
 * what THIS seam guarantees today.
 */
export async function purgeRowsByAge<T>(
  feature: string,
  rows: readonly T[],
  tenantId: string,
  cutoffIso: string,
  rowOf: (row: T) => { tenantId: string; updatedAt: string; id: string },
  del: (id: string) => Promise<unknown>,
): Promise<PurgeOutcome> {
  if (!tenantId) return { deleted: 0, failed: 0 }; // fail-closed (defense in depth)
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    const { tenantId: rowTenant, updatedAt, id } = rowOf(row);
    if (rowTenant !== tenantId || !(updatedAt < cutoffIso)) continue; // strict `<` — equal is retained
    try {
      await del(id);
      deleted += 1;
    } catch (err) {
      failed += 1;
      log.error('retention_row_delete_failed', {
        feature, tenantId, id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failed > 0) log.warn('retention_purge_partial', { feature, tenantId, deleted, failed });
  return { deleted, failed };
}

export interface PurgeResult { feature: string; deleted: number; failed: number; ok: boolean; error?: string }

/** Fan out a retention purge to every registered feature for one (tenant, classification,
 *  cutoff). Best-effort: a thrown purger is logged + reported `ok:false` (with its error),
 *  never blocks the rest; a purger that completes but could not delete some matched rows is
 *  reported `ok:true` with `failed>0`. Returns per-feature results for the daemon to audit. */
export async function purgeRetained(
  tenantId: string,
  classification: DataClassification,
  cutoffIso: string,
): Promise<PurgeResult[]> {
  if (!tenantId) return []; // fail-closed — no ambiguous-tenant sweep
  const results: PurgeResult[] = [];
  for (const p of purgers) {
    try {
      const out = await p.purge(tenantId, classification, cutoffIso);
      const deleted = typeof out === 'number' ? out : out.deleted;
      const failed = typeof out === 'number' ? 0 : (out.failed ?? 0);
      results.push({ feature: p.feature, deleted, failed, ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error('retention_purger_failed', { tenantId, classification, feature: p.feature, error });
      results.push({ feature: p.feature, deleted: 0, failed: 0, ok: false, error });
    }
  }
  return results;
}

/** Test-only: clear registered purgers (mirrors `__resetSubjectErasers`). */
export function __resetRetentionPurgers(): void { purgers.length = 0; }
