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
import { eraseSubjectGrants } from './circleService.js';
import { eraseSubjectCohortData, purgeProposalsByAge } from './cohortService.js';
import { eraseSubjectSessions } from './sessionService.js';

/**
 * The package's single subject-eraser. Removes the subject's accountability footprint:
 * grants where they are grantor OR grantee (revocation semantics), their coach-caseload
 * pointers + seat occupancy + reservation holds, coach proposals they authored (and
 * proposals about their own enrollments, which would otherwise orphan once core deletes
 * those enrollments), and sessions they created. Shared circle PRODUCT resources are
 * retained (opaque-owner-keyed, ADR 0426 — never PII); erasure ends the subject's
 * MEMBERSHIP, not other members' circle. No-op on a falsy tenant; idempotent.
 */
const kicktodoAccountabilityEraser = async (tenantId: string, subjectKey: string): Promise<void> => {
  if (!tenantId || !subjectKey) return;
  // Resolve the subject's enrollments through kicktodo-core (the enrollment SoT) so
  // proposals ABOUT the subject are reachable — read BEFORE core's own eraser deletes
  // them is unnecessary (this seam runs each eraser per key independently), but the
  // ids are stable input regardless of eraser ordering.
  const enrollmentIds = (await listEnrollmentsFor(tenantId, subjectKey)).map((e) => e.id);
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
