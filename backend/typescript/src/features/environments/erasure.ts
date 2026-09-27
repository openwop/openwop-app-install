/**
 * UX_UPGRADE-environments R2 (ENV2-B1) — subject erasure for Environments.
 *
 * `environments` is subject-signalled and registered no subject eraser, so
 * `eraseSubject` fanned out to every feature that had registered and silently
 * skipped this one. Same absence as `documents` (DOC2-B1). MEASURED across the
 * tree when that landed: 125 feature dirs, 34 registering an eraser, 42 storing
 * a user identifier and registering none.
 *
 * BUT THE SEMANTIC IS NOT THE SAME, AND THAT IS THE POINT.
 *
 * `documents` anonymized everything it held, because a document is org content
 * and the author id is incidental attribution. This feature holds two different
 * kinds of identifier:
 *
 *   - `ConfigSnapshotRecord.createdBy` — attribution: who captured a config
 *     snapshot. Anonymized here, exactly like documents. This is the ONLY
 *     erasable attribution the feature holds. (The first draft of this file also
 *     anonymized `EnvironmentRecord.createdBy`, which does not exist —
 *     `EnvironmentRecord` carries no actor at all. I had read a `createdBy` grep
 *     hit that belonged to a different interface. `tsc` caught it; the module
 *     docstring had already confidently described the behaviour.)
 *
 *   - `PromotionRecord.actor` — **the audit trail of who changed production
 *     config**. This is deliberately NOT erased. It is not incidental
 *     attribution; it is the security record answering "who pushed this to
 *     live", on a ledger whose own docstring exists so "the promotions history
 *     is honest about the attempt". Anonymizing it would destroy accountability
 *     for production changes in order to remove a name from an audit log — the
 *     same disproportion `documents` avoided by refusing to delete documents,
 *     pointed the other way.
 *
 * That distinction is a JUDGMENT, and it is recorded rather than buried: an
 * operator whose legal posture requires purging audit actors too should make
 * that call explicitly (and pair it with a retention policy), not discover it
 * by reading this file. It is flagged in `UX_UPGRADE-environments.md`.
 *
 * The wrong move here would have been to copy the documents eraser across
 * because the shape matched. It is the reason the 42 are being closed one
 * feature at a time.
 *
 * Idempotent by construction: every write sets a field to the tombstone, which
 * is a no-op the second time. Tenant-scoped.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { createLogger } from '../../observability/logger.js';
import type { ConfigSnapshotRecord, EnvironmentRecord } from './environmentsService.js';

const log = createLogger('features.environments.erasure');

/** What an erased attribution becomes. Not '' — that reads as "nobody set it",
 *  which is a different fact from "erased on request". Same token as documents. */
export const ERASED_SUBJECT = 'erased:subject';

const snapshots = new DurableCollection<ConfigSnapshotRecord>('env:snapshot', (s) => s.snapshotId, undefined, (s) => s.tenantId);
const environments = new DurableCollection<EnvironmentRecord>('env:environment', (e) => e.environmentId, undefined, (e) => e.tenantId);

export async function eraseEnvironmentsSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!subjectKey) return;
  let touched = 0;

  for (const snap of await snapshots.list()) {
    if (snap.tenantId !== tenantId || snap.createdBy !== subjectKey) continue;
    await snapshots.put({ ...snap, createdBy: ERASED_SUBJECT });
    touched += 1;
  }

  // `env:promotion` is INTENTIONALLY absent from this loop — see the module
  // docstring. Its `actor` is the audit record of a production config change.
  log.info('environments_subject_erased', { tenantId, rows: touched, promotionLedger: 'preserved' });
}

export function registerEnvironmentsErasure(): void {
  registerSubjectEraser(eraseEnvironmentsSubject);

  // R3 (the R2 known-open, closed on the documents precedent #3248) — age-based
  // retention now REACHES config-snapshot history. The AGE stays the operator's:
  // the sweep passes the per-tenant window in, and "no window ⇒ never purge".
  // Scope floor: a snapshot ANY environment currently pins (`currentSnapshot`
  // hash) is never purged, so the deployed config can never age away; what goes
  // is dormant history. `env:promotion` stays untouched — its module docstring
  // preserves it as the audit record, and purging an audit ledger is a separate
  // product decision, not this mechanism's. Classification is `internal` (this
  // feature declares no PII fields — opaque principal ids only).
  registerRetentionPurger({
    feature: 'environments',
    async purge(tenantId, classification, cutoffIso) {
      if (!tenantId || classification !== 'internal') return 0;
      const pinned = new Set((await environments.list())
        .filter((e) => e.tenantId === tenantId)
        .map((e) => e.currentSnapshot)
        .filter((h): h is string => !!h));
      const rows = (await snapshots.list()).filter((sn) => sn.tenantId === tenantId && !pinned.has(sn.hash));
      return purgeRowsByAge('environments', rows, tenantId, cutoffIso,
        (sn) => ({ tenantId: sn.tenantId, updatedAt: sn.createdAt, id: sn.snapshotId }),
        (id) => snapshots.delete(id));
    },
  });
  // No `declarePiiFields`: every identifier this feature stores is an opaque
  // principal id, which `comments` already decided in writing is NOT PII for
  // log-masking purposes ("an opaque principal id (RFC 0048), not PII") even
  // though it still erases by one. There is no free-text field here to declare.
}
