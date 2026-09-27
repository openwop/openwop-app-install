/**
 * kicktodo-core — the ONE compliance registration for the package (ADR 0458 Phase 0).
 *
 * Composes the per-service erase/purge helpers into exactly one subject-eraser, one
 * retention-purger, and one subject-key resolver on the ADR 0077/0381 host seams —
 * the same "one registration per feature" shape crm/comments follow. Registration is
 * driven from `feature.ts` `registerRoutes` (which runs for EVERY feature regardless
 * of toggle, so a tenant that used KickTodo then turned it off is still erasable);
 * the handlers are module-level constants, so the seams' idempotent-by-reference
 * dedupe makes a repeat registration a no-op.
 */

import {
  registerSubjectEraser,
  registerSubjectKeyResolver,
} from '../../host/subjectErasure.js';
import { registerRetentionPurger, type RetentionPurger } from '../../host/retentionPurger.js';
import { eraseSubjectEnrollments } from './enrollmentService.js';
import { eraseSubjectCheckIns, purgeCheckInsByAge } from './todayService.js';
import { eraseEvidenceForEnrollments, purgeEvidenceByAge } from './progressService.js';
import { eraseSubjectInvites } from './inviteService.js';
import {
  eraseContactLinkForSubject,
  linkedContactIdsForSubject,
  subjectsForContact,
} from './contactBridgeService.js';

/**
 * The package's single subject-eraser. Deletes every subject-keyed row this package
 * owns for (tenant, subjectKey): the subject's enrollments + occurrences (and, via
 * the returned enrollment ids, their evidence snapshots), their check-ins, the
 * invites they minted, and their subject→contact link. Enrollment-keyed evidence
 * MUST be captured before the enrollment rows are deleted, so `eraseSubjectEnrollments`
 * returns the ids and evidence is dropped from them. No-op on a falsy tenant; each
 * helper is idempotent and none fires a notification (per the seam contract).
 */
const kicktodoCoreEraser = async (tenantId: string, subjectKey: string): Promise<void> => {
  if (!tenantId || !subjectKey) return;
  const enrollmentIds = await eraseSubjectEnrollments(tenantId, subjectKey);
  await eraseEvidenceForEnrollments(tenantId, enrollmentIds);
  await eraseSubjectCheckIns(tenantId, subjectKey);
  await eraseSubjectInvites(tenantId, subjectKey);
  await eraseContactLinkForSubject(tenantId, subjectKey);
};

/**
 * The package's single retention-purger. Ages the two `confidential-pii` collections
 * that carry a timestamp — check-ins (participant evidence: note/measurement) and
 * frozen evidence snapshots — exactly like the crm/comments purgers: guard on the
 * classification + a falsy tenant, sum the two `PurgeOutcome`s. Enrollments /
 * occurrences / invites / the contact link are `internal` operational rows (erased on
 * DSAR, never aged out), so they are deliberately not swept here.
 */
const kicktodoCorePurger: RetentionPurger = {
  feature: 'kicktodo-core',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    const [checkins, evidence] = await Promise.all([
      purgeCheckInsByAge(tenantId, cutoffIso),
      purgeEvidenceByAge(tenantId, cutoffIso),
    ]);
    return {
      deleted: checkins.deleted + evidence.deleted,
      failed: (checkins.failed ?? 0) + (evidence.failed ?? 0),
    };
  },
};

/**
 * The package's single subject-key resolver (ADR 0381) over the authoritative
 * subject↔contact bridge: expand a key to its linked identity keys UPFRONT so a DSAR
 * keyed on a KickTodo subject reaches the same person's contact-keyed data (CRM,
 * orders, …) and — reverse — a DSAR keyed on a `contactId` reaches the subject's
 * KickTodo footprint. Both hops read only store-backed links (never a heuristic); the
 * bare subjectKey is seeded by the seam, so it is dropped from the result.
 */
const kicktodoCoreResolver = async (tenantId: string, subjectKey: string): Promise<readonly string[]> => {
  if (!tenantId || !subjectKey) return [];
  const keys = new Set<string>();
  for (const contactId of await linkedContactIdsForSubject(tenantId, subjectKey)) keys.add(contactId);
  for (const subject of await subjectsForContact(tenantId, subjectKey)) keys.add(subject);
  keys.delete(subjectKey);
  return [...keys];
};

/** Register the package's compliance handlers (idempotent — the seams dedupe by
 *  reference). Called from `feature.ts` `registerRoutes`. */
export function registerKicktodoCoreCompliance(): void {
  registerSubjectEraser(kicktodoCoreEraser);
  registerRetentionPurger(kicktodoCorePurger);
  registerSubjectKeyResolver(kicktodoCoreResolver);
}
