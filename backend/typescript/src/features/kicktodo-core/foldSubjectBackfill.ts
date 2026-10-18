/**
 * KTENR-2 / KTX-D2 (KickTodo wave 4C) — the EXPLICIT backfill for subject fields a
 * tenant fold does not rewrite.
 *
 * THE GAP. The anon→user adopt-migration (`routes/migrate.ts` → `reassignTenant`)
 * rewrites every colon-bounded TENANT segment in row keys and string fields, and
 * nothing else (`storage/tenantMigration.ts`). An enrollment created inside an
 * `anon:` sandbox therefore arrives in the user's tenant still owned by the anon
 * principal's subject, so `listEnrollmentsFor(tenant, userSubject)` misses it —
 * Today, Plan and Progress do not show it — and re-enrolling mints a second `enr:`
 * id (the id hashes the subject). This is real only if an anonymous principal can
 * enrol (tracker PROBE-7, not yet run), so the repair is shipped DORMANT.
 *
 * THE CONTRACT — read before calling:
 *  - EXPLICIT ONLY. Nothing in the app calls this: no boot step, no daemon, no
 *    route, no fold hook. It must not be run against production until PROBE-7 has
 *    measured that such rows exist, and then only deliberately, per tenant.
 *  - The caller supplies the mapping (`fromSubject` → `toSubject`); nothing is
 *    inferred. A tenant with no enrollment owned by `fromSubject` changes ZERO rows
 *    (the test pins this), so a second run is a no-op.
 *  - `dryRun: true` reports what WOULD change and writes nothing.
 *  - Scope is kicktodo-core's own subject fields: the enrollment's `ownerSubject`
 *    and its check-ins' `ownerSubject`. Row keys and `enr:` ids are left alone.
 *  - CONFLICT-SAFE: when `toSubject` already holds an enrollment in the same
 *    challenge version, the folded one is NOT re-owned (that would give one person
 *    two enrollments in one version); it is reported in `conflicts` instead.
 *  - Every write is a CAS against the row read; a row that moved is reported, not
 *    overwritten.
 */
import { listEnrollmentsInTenant, rewriteEnrollmentOwner } from './enrollmentService.js';
import { rewriteCheckInOwner } from './todayService.js';

export interface FoldSubjectBackfillResult {
  /** Enrollments re-owned (or that would be, under `dryRun`). */
  enrollments: number;
  /** Check-ins re-owned (or that would be). */
  checkIns: number;
  /** Enrollment ids skipped because `toSubject` already holds that challenge version. */
  conflicts: string[];
  /** Enrollment ids whose CAS lost (moved concurrently) — re-run to pick them up. */
  raced: string[];
}

export async function backfillFoldedEnrollmentSubjects(input: {
  tenantId: string;
  fromSubject: string;
  toSubject: string;
  dryRun?: boolean;
}): Promise<FoldSubjectBackfillResult> {
  const out: FoldSubjectBackfillResult = { enrollments: 0, checkIns: 0, conflicts: [], raced: [] };
  const { tenantId, fromSubject, toSubject } = input;
  if (!tenantId || !fromSubject || !toSubject || fromSubject === toSubject) return out;
  const rows = await listEnrollmentsInTenant(tenantId);
  const held = new Set(rows.filter((e) => e.ownerSubject === toSubject).map((e) => `${e.challengeId}::v${e.challengeVersion}`));
  for (const e of rows) {
    if (e.tenantId !== tenantId || e.ownerSubject !== fromSubject) continue;
    if (held.has(`${e.challengeId}::v${e.challengeVersion}`)) { out.conflicts.push(e.id); continue; }
    if (input.dryRun) {
      out.enrollments += 1;
      out.checkIns += await rewriteCheckInOwner(tenantId, e.id, fromSubject, toSubject, { dryRun: true });
      continue;
    }
    if (!(await rewriteEnrollmentOwner(tenantId, e.id, fromSubject, toSubject))) { out.raced.push(e.id); continue; }
    out.enrollments += 1;
    held.add(`${e.challengeId}::v${e.challengeVersion}`);
    out.checkIns += await rewriteCheckInOwner(tenantId, e.id, fromSubject, toSubject);
  }
  return out;
}
