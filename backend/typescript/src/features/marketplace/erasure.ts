/**
 * MPL-7 — subject erasure for Marketplace.
 *
 * WHAT WAS WRONG. Re-derive the numbers rather than trusting this sentence:
 *
 *   # namespaces owned by the two marketplace feature packages
 *   grep -rhoE "new DurableCollection(<[^>]*>)?[[:space:]]*\([[:space:]]*'[^']+'" \
 *     src/features/marketplace src/features/commerce-connect | grep -oE "'[^']+'" | sort -u | wc -l
 *   # …and the erasure/retention seams they were registered on
 *   grep -rn 'registerSubjectEraser\|registerRetentionPurger' \
 *     src/features/marketplace src/features/commerce-connect | wc -l
 *
 * MEASURED 2026-08-19 on this branch's parent: **13** namespaces (2 marketplace +
 * 11 commerce-connect), **0** erasers, **0** purgers. Twelve of the thirteen were
 * also INVISIBLE to the ADR 0464 feature-store ratchet: its actor regex bound
 * `createdBy|uploadedBy|authorId`, and these stores spell the actor `by` (the
 * listing tombstone; the listing's nested `stateMeta.by`) and `disabledBy`
 * (`marketplace:pack-disable`). Only `marketplace:review` was seen at all, and it
 * was recorded as permanent `ACTOR_ATTRIBUTED_DEBT` — a record of a gap, not
 * coverage.
 *
 * ANONYMIZE, DO NOT DELETE — twice, for two different reasons, both of them
 * "deletion becomes a grant or a rewrite".
 *
 *   `marketplace:review`. The free-text `body` is the person's own words and goes.
 *   The RATING does not: a pack's average is other people's information as much as
 *   this person's, and deleting the row silently moves every score on the host —
 *   an erasure request must not be a way to change a competitor's rating. So the
 *   row survives with `authorId` tombstoned and `body` removed. This overturns
 *   nothing: the ratchet's own debt note said "delete is arguably right — but
 *   reviews are also public reputation signal for the pack, so the marketplace
 *   owner decides." This is that decision, made and written down.
 *
 *   `marketplace:pack-disable`. The row is a per-TENANT curation DENY: it exists
 *   only for a pack the workspace has deliberately hidden. Deleting it would
 *   silently RE-ENABLE that pack host-wide for the workspace — the
 *   deletion-becomes-a-grant shape, on a surface whose whole job is to withhold
 *   something. Only `disabledBy` is a subject field, so only `disabledBy` goes.
 *
 * WHAT THIS DELIBERATELY DOES NOT REACH, stated rather than implied (the
 * `crm:suppression` precedent — an unstated omission is how a whole feature
 * package went unnoticed): nothing else in `features/marketplace` is a durable
 * store. The listing PROJECTION is derived from the on-disk pack set at read
 * time and holds no subject data at all.
 *
 * Idempotent by construction (the contract requires it): every write sets a field
 * to the tombstone, which is a no-op the second time.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.marketplace.erasure');

/** What an erased actor becomes. Not `''` — an empty author reads as "anonymous
 *  by choice", a different fact from "erased on request". Mirrors
 *  `crm/erasure.ts` and `forms/erasure.ts`. */
export const ERASED_VALUE = 'erased:subject';

// The SAME namespaces + key functions as the owning services — this module reads
// and writes the same rows. Declared here rather than exported from those modules
// so the erasure seam does not widen their public surface (the forms/documents
// precedent).
interface ReviewRow {
  reviewId: string; tenantId: string; orgId: string; packName: string;
  rating: number; body?: string; authorId: string; createdAt: string; updatedAt: string;
}
interface PackDisableRow {
  id: string; tenantId: string; packName: string; disabledAt: string; disabledBy: string;
}

const reviews = new DurableCollection<ReviewRow>('marketplace:review', (r) => r.reviewId, undefined, (r) => r.tenantId);
const packDisables = new DurableCollection<PackDisableRow>('marketplace:pack-disable', (r) => r.id, undefined, (r) => r.tenantId);

/**
 * The registered eraser. `subjectKey` is whatever identity space the DSAR arrived
 * in (a `userId`, a CRM `contactId`, an analytics `sessionKey`, an email); both
 * stores here record an APP USER id, so the only leg that can match is an exact
 * comparison against `authorId` / `disabledBy`.
 *
 * RESIDUAL, named rather than left to be inferred (the `forms:submission`
 * precedent): a subject whose DSAR arrives ONLY as an email or a contactId — with
 * no registered resolver mapping it back to their `userId` — is not reached here.
 * That is a property of the ADR 0381 identity graph, not of this eraser: the only
 * shipped resolver (`crm/erasure.ts` `resolveCrmSubjectKeys`) is one-directional
 * email/phone → contactId. Matching a non-userId key against these fields
 * heuristically would over-erase a stranger's review on a coincidence, and
 * over-erasure is unrecoverable in a way under-erasure is not.
 */
async function eraseMarketplaceSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  let anonymized = 0;

  for (const r of await reviews.listForTenantIndexed(tenantId)) {
    if (r.authorId !== subjectKey) continue;
    const next: ReviewRow = { ...r, authorId: ERASED_VALUE, updatedAt: new Date().toISOString() };
    // The person's own words go; the rating stays (see the docblock).
    delete next.body;
    await reviews.put(next);
    anonymized += 1;
  }

  for (const d of await packDisables.listForTenantIndexed(tenantId)) {
    if (d.disabledBy !== subjectKey) continue;
    await packDisables.put({ ...d, disabledBy: ERASED_VALUE });
    anonymized += 1;
  }

  if (anonymized > 0) log.info('marketplace_subject_erased', { tenantId, rows: anonymized });
}

/** Registered from the feature's boot module (feature → host, never the reverse). */
export function registerMarketplaceErasure(): void {
  registerSubjectEraser(eraseMarketplaceSubject);
}
