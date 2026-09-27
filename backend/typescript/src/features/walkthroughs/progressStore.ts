/**
 * Walkthrough progress store (ADR 0368 Phase 5 → ADR 0378 P3 per-user) — the ONE
 * owner of the `walkthrough-progress` collection, shared by the host-ext progress
 * routes AND the `ctx.features.walkthroughs` surface (no feature↔surface cycle).
 *
 * ADR 0378 P3: NEW rows are keyed `tenantId:userId:walkthroughId` (userId = the
 * caller's durable subject, stamped SERVER-side — never client-supplied), which
 * fixes the latent cross-member resume-hijack: with the old tenant-level key,
 * ANY member's in-flight run hijacked every other member's launch of the same
 * walkthrough. LEGACY rows (`tenantId:walkthroughId`, no userId) remain readable
 * as a tenant-level fallback — dual-read, copy-nothing (the ADR 0376 discipline).
 * Anonymous callers (no subject) keep the legacy tenant-level behavior.
 *
 * ACCEPTED, BOUNDED residue (grade-pass audit — deliberate; reclaimed by TENANT
 * deletion via the self-registered collection cascade, and per-SUBJECT by the
 * ADR 0464 eraser registered at the foot of this file):
 *  - `runId` may dangle once ADR 0371 retention sweeps the run — the ONLY
 *    dereferencer (the FE resume probe) 404-gates and starts fresh;
 *  - `completed` rows are resume-history + the future suggestTour substrate,
 *    not read elsewhere today; one row per tenant×user×walkthrough (upsert);
 *  - a per-user row permanently shadows a same-walkthrough legacy row (the
 *    copy-nothing dual-read); shadowed rows are one-per-tenant×walkthrough;
 *  - rows for a GC'd authored draft persist (low volume, erased with tenant).
 * KEY INVARIANT: keys are CONSTRUCTED only, never parsed — subjects contain
 * ':' (`user:<hash>`), so any future parser must split on FIELDS, not the key.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';

export interface WalkthroughProgressRecord {
  key: string;
  tenantId: string;
  /** ADR 0378 P3 — absent on legacy tenant-level rows + anonymous writes. */
  userId?: string;
  walkthroughId: string;
  status: 'started' | 'completed';
  runId: string;
  updatedAt: string;
}

const progress = new DurableCollection<WalkthroughProgressRecord>(
  'walkthrough-progress',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

/** The caller's progress rows: their OWN per-user rows ∪ legacy tenant-level
 *  rows (fallback only — a per-user row for the same walkthrough wins). With no
 *  userId (anonymous), returns the legacy tenant-level rows only. */
export async function listWalkthroughProgress(tenantId: string, userId?: string): Promise<WalkthroughProgressRecord[]> {
  // §Correction (grade-code `TUT-12`, same defect as the tutorials store): this
  // was a bare `list()` — a full CROSS-TENANT scan. BOTH key shapes
  // (`tenantId:userId:wf` and legacy `tenantId:wf`) live under the tenant
  // prefix, so one bounded scan still sees the legacy rows the dual-read needs.
  const rows = (await progress.listForTenant(tenantId)).filter((r) => r.tenantId === tenantId);
  const legacy = rows.filter((r) => !r.userId);
  if (!userId) return legacy;
  const own = rows.filter((r) => r.userId === userId);
  const ownIds = new Set(own.map((r) => r.walkthroughId));
  return [...own, ...legacy.filter((r) => !ownIds.has(r.walkthroughId))];
}

/** Upsert progress (deterministic key ⇒ idempotent). New writes carry the
 *  caller's userId when known; anonymous writes stay tenant-level (legacy key). */
export async function putWalkthroughProgress(rec: Omit<WalkthroughProgressRecord, 'key'>): Promise<void> {
  const key = rec.userId ? `${rec.tenantId}:${rec.userId}:${rec.walkthroughId}` : `${rec.tenantId}:${rec.walkthroughId}`;
  await progress.put({ ...rec, key });
}

/**
 * ADR 0464 — erase every row this SUBJECT owns in this tenant.
 *
 * §Correction (grade-code `WT-18` / grade-data `WALK-1`): this collection stores
 * a `userId` and had NO eraser at all. Its own docblock above claimed the
 * residue was "all reclaimed by account erasure" — true for TENANT deletion,
 * false for a per-subject DSAR erasure, which is the case ADR 0464 exists for.
 * The tutorials store was modelled on this one and self-policed its way to an
 * eraser; the original never got one, and the ADR 0464 coverage ratchet could
 * not see it because that gate enumerates only `src/host/**` (now widened —
 * `subject-erasure-coverage.test.ts`).
 *
 * DELETE rather than anonymize, matching the tutorials store: progress is
 * behavioural data with no retention duty once the subject is gone.
 *
 * LEGACY tenant-level rows (no `userId`) are deliberately left: they are not
 * subject-bearing, they are shared tenant state by construction, and they are
 * reclaimed by tenant deletion. Erasing them on one member's DSAR would delete
 * another member's resume state.
 *
 * Filters on the `userId` FIELD, never by parsing the key.
 */
export async function eraseWalkthroughProgressForSubject(tenantId: string, subjectKey: string): Promise<void> {
  const rows = (await progress.listByPrefix(`${tenantId}:${subjectKey}:`))
    .filter((r) => r.tenantId === tenantId && r.userId === subjectKey);
  for (const row of rows) await progress.delete(row.key);
}

registerSubjectEraser(eraseWalkthroughProgressForSubject);

/** Test-only. */
export async function __clearWalkthroughProgressForTests(): Promise<void> {
  for (const r of await progress.list()) await progress.delete(r.key);
}
