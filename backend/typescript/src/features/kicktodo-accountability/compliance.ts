/**
 * kicktodo-accountability — the ONE compliance registration for the package
 * (ADR 0458 Phase 0).
 *
 * Composes the per-service erase/purge helpers into exactly one subject-eraser and
 * one retention-purger on the ADR 0077 host seams (this package has no identity
 * bridge, so no subject-key resolver — that is kicktodo-core's). Driven from
 * `feature.ts` `registerRoutes` (runs for every feature regardless of toggle, so a
 * tenant that used accountability then turned it off is still erasable); the handlers
 * are module-level constants, so a repeat registration dedupes by reference.
 */

import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerRetentionPurger, type RetentionPurger } from '../../host/retentionPurger.js';
import { registerApprovalRedactor } from '../../host/approvalService.js';
import { listEnrollmentsFor } from '../kicktodo-core/enrollmentService.js';
import { onEnrollmentDeleted } from '../kicktodo-core/enrollmentLifecycle.js';
import { circlesAnchoredTo, eraseSubjectGrants, handOverCircle, listCirclesOwnedBy, type AccountabilityCircle } from './circleService.js';
import {
  dropDissolvedCircleCohortRows,
  eraseProposalsForEnrollment,
  eraseSubjectCohortData,
  purgeProposalsByAge,
} from './cohortService.js';
import { dropDissolvedCircleSessions, eraseSubjectSessions } from './sessionService.js';

/**
 * KTACC-2 — hand each circle over (or dissolve it) on behalf of its departing
 * owner, then drop a dissolved circle's cohort + session children (which
 * circleService does not own). Shared by the subject eraser and the KTA-11
 * enrollment-deleted subscription, so either path alone converges.
 */
async function handOverCircles(tenantId: string, circles: readonly AccountabilityCircle[]): Promise<void> {
  for (const c of circles) {
    const outcome = await handOverCircle(tenantId, c.id, c.ownerSubject);
    if (outcome?.outcome === 'dissolved') {
      await dropDissolvedCircleCohortRows(tenantId, c.id, outcome.memberSubjects);
      await dropDissolvedCircleSessions(tenantId, c.id);
    }
  }
}

/**
 * The package's single subject-eraser. Removes the subject's accountability footprint:
 * grants where they are grantor OR grantee (revocation semantics), their coach-caseload
 * pointers + seat occupancy + reservation holds, coach proposals they authored (and
 * proposals about their own enrollments, which would otherwise orphan once core deletes
 * those enrollments), and sessions they created. Shared circle PRODUCT resources are
 * retained; erasure ends the subject's MEMBERSHIP, not other members' circle. A circle
 * the subject OWNS survives them (KTACC-2, decided 2026-10-17): it passes to the
 * longest-standing live member, or dissolves when none is left — and that runs FIRST,
 * so the grants the owner issued are re-attributed before the grantor match below.
 * No-op on a falsy tenant; idempotent.
 */
const kicktodoAccountabilityEraser = async (tenantId: string, subjectKey: string): Promise<void> => {
  if (!tenantId || !subjectKey) return;
  // Resolve the subject's enrollments through kicktodo-core (the enrollment SoT) so
  // proposals ABOUT the subject are reachable — read BEFORE core's own eraser deletes
  // them is unnecessary (this seam runs each eraser per key independently), but the
  // ids are stable input regardless of eraser ordering.
  const enrollmentIds = (await listEnrollmentsFor(tenantId, subjectKey)).map((e) => e.id);
  await handOverCircles(tenantId, await listCirclesOwnedBy(tenantId, subjectKey));
  await eraseSubjectGrants(tenantId, subjectKey);
  await eraseSubjectCohortData(tenantId, subjectKey, enrollmentIds);
  await eraseSubjectSessions(tenantId, subjectKey);
};

/**
 * The package's single retention-purger. Ages the one `confidential-pii` collection
 * that carries a timestamp — coach plan proposals (their `note` is author free-text) —
 * exactly like the crm/comments purgers. Grants / circles / cohorts / seats / sessions
 * are operational relationship rows keyed by opaque subjects (never aged out — erased
 * on DSAR), so they are not swept here.
 */
const kicktodoAccountabilityPurger: RetentionPurger = {
  feature: 'kicktodo-accountability',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeProposalsByAge(tenantId, cutoffIso);
  },
};

/** Register the package's compliance handlers (idempotent — the seams dedupe by
 *  reference). Called from `feature.ts` `registerRoutes`. */
export function registerKicktodoAccountabilityCompliance(): void {
  registerSubjectEraser(kicktodoAccountabilityEraser);
  registerRetentionPurger(kicktodoAccountabilityPurger);
  // KTA-11 — circles and proposals are enrollment-anchored children of
  // kicktodo-core's rows, so they prune on the delete signal (keyed — a repeat
  // boot overwrites) instead of depending on eraser ORDER: the subject eraser
  // above reaches proposals only through `listEnrollmentsFor`, which is empty
  // once core's eraser has run first. A circle is always anchored to its OWNER's
  // own enrollment (the create route checks it), and today the only enrollment
  // deleter is that owner's DSAR, so this is the same KTACC-2 handover, reached
  // from the other side. Both handlers are idempotent with the eraser path.
  //
  // The owner match is load-bearing: a circle handed over earlier stays ANCHORED to
  // the departed owner's enrollment, so without it this delete signal would hand the
  // circle away from its new owner a second time.
  onEnrollmentDeleted('kicktodo-accountability.circles', async ({ tenantId, enrollmentId, ownerSubject }) => {
    if (!ownerSubject) return;
    const anchored = (await circlesAnchoredTo(tenantId, enrollmentId)).filter((c) => c.ownerSubject === ownerSubject);
    await handOverCircles(tenantId, anchored);
  });
  onEnrollmentDeleted('kicktodo-accountability.proposals', async ({ tenantId, enrollmentId }) => {
    await eraseProposalsForEnrollment(tenantId, enrollmentId);
  });
  // ADR 0464 — this package OWNS the `kicktodo-plan-proposal` approval kind, so it
  // registers the kind's subject-redactor map on the store-wide registry. As COACH
  // (`coachSubject` match) → redact both note copies, preserving `coachSubject` as
  // the match key (byte-identical to the ADR 0459 #2322 behavior). As PARTICIPANT
  // (the sole decider in `approverRefs[0]`) → delete the now-meaningless card. The
  // package eraser also invokes the kind-scoped walk directly (so plan-proposal is
  // reached even when only this eraser is registered); both paths are idempotent.
  registerApprovalRedactor('kicktodo-plan-proposal', {
    idFields: ['planProposal.coachSubject'],
    textFields: ['planProposal.note', 'proposal'],
    preserveMatchedIds: true,
    onApproverMatch: 'delete',
  });
}
