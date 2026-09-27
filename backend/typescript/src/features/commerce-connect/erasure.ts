/**
 * MPL-7 — subject erasure for Commerce Connect.
 *
 * WHAT WAS WRONG. Re-derive rather than trusting this sentence — the number in a
 * docblock outlives the code it describes:
 *
 *   grep -rn 'registerSubjectEraser\|registerRetentionPurger' \
 *     src/features/marketplace src/features/commerce-connect | wc -l
 *
 * MEASURED 2026-08-19 on this branch's parent: **0**. Across 13 namespaces
 * (2 marketplace + 11 here). Sharpest instance:
 * `commerce-connect:listing-tombstone` had NO `tenantOf`, and its row type has no
 * field literally named `tenantId`, so `purgeTenantRows`'s `jsonTenantId` fallback
 * skipped it too — reachable by no eraser, no purger AND no tenant teardown, while
 * carrying a raw `req.userId` in `by` and operator free text in `reason`. Every
 * dissolution added a row nothing in the app could ever remove. Its `tenantOf` is
 * added in `stores.ts` alongside this module.
 *
 * ANONYMIZE THE ACTOR; NEVER DELETE THE ROW. Both stores this eraser touches are
 * ones where deletion would be a GRANT, not a redaction:
 *
 *   `commerce-connect:listing-tombstone` carries the ADR 0574 P1 ninety-day
 *   same-seller re-claim cooldown. Deleting it on erasure would let a seller whose
 *   listing was dissolved for cause re-squat the pack name immediately — an
 *   erasure request as a way to clear an enforcement action. Only `by` is a
 *   subject field, so only `by` goes. `reason` is the OPERATOR's business record of
 *   why the listing was dissolved, not a statement about the erased subject.
 *
 *   `commerce-connect:paid-listing` carries `stateMeta.by` — the operator who put
 *   the listing on hold. Deleting the listing (or the `stateMeta`) would silently
 *   RELEASE that hold, since `listingState()` reads absent-⇒-active. Only
 *   `stateMeta.by` goes.
 *
 * WHAT THIS DELIBERATELY DOES NOT ERASE — stated here rather than left to be
 * inferred from the ADR 0464 ratchet resolving coverage at feature-DIRECTORY level
 * (the `forms:def` precedent; without this paragraph, registering ANY eraser in
 * this directory makes all eleven namespaces read "covered").
 *
 *   The nine MONEY-TRUTH stores — `order`, `order-by-seller`, `order-by-intent`,
 *   `payout`, `dispute`, `seller`, `seller-by-account`, `fee-config`,
 *   `webhook-event` — are keyed by TENANT, not by subject, and each is a financial
 *   record: an order is a receipt, a payout is a settlement, a dispute is a
 *   chargeback, a seller row is a Stripe Connect binding. Statutory retention
 *   (tax, AML, chargeback evidence windows) outlives a DSAR for the individual who
 *   happened to click Buy, and none of them stores a person — they store a
 *   workspace. A DSAR against the OWNER of a personal `user:` workspace is a
 *   tenant-deletion question, which `purgeTenantRows` answers and which every one
 *   of these nine is reachable by (each has a `tenantOf`, except `webhook-event`
 *   whose exclusion is documented at its declaration as a money-critical dedup
 *   ledger).
 *
 *   That is a REASONED exemption, not an oversight, and it is the honest one: an
 *   eraser that deleted an order row on a DSAR would destroy the platform's proof
 *   of a charge it must be able to evidence, and would move `sellerStats` for a
 *   seller who is not the erasure subject.
 *
 * Idempotent by construction (the contract requires it): every write sets a field
 * to the tombstone, which is a no-op the second time.
 */

import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';
import { listingTombstones, paidListings, nowIso } from './stores.js';

const log = createLogger('features.commerce-connect.erasure');

/** What an erased actor becomes. Not `''` — an empty actor reads as "recorded
 *  without an operator", a different fact from "erased on request". Mirrors
 *  `crm/erasure.ts`, `forms/erasure.ts` and `marketplace/erasure.ts`. */
export const ERASED_VALUE = 'erased:subject';

/**
 * The registered eraser. `subjectKey` is whatever identity space the DSAR arrived
 * in; both fields here record an APP USER id (`req.userId`), so the only leg that
 * can match is an exact comparison.
 *
 * RESIDUAL, named rather than left to be inferred (the `forms:submission`
 * precedent): a DSAR arriving ONLY as an email or a CRM contactId does not reach
 * these rows, because no registered `SubjectKeyResolver` maps those spaces back to
 * a `userId` — the only shipped resolver (`crm/erasure.ts` `resolveCrmSubjectKeys`)
 * is ONE-DIRECTIONAL email/phone → contactId. Matching a non-userId key against
 * these fields heuristically would tombstone an unrelated operator's audit line on
 * a coincidence, and over-erasure is unrecoverable in a way under-erasure is not.
 */
async function eraseCommerceConnectSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  let anonymized = 0;

  for (const t of await listingTombstones.listForTenantIndexed(tenantId)) {
    if (t.by !== subjectKey) continue;
    // The row SURVIVES — it is the cooldown. Only the actor goes.
    await listingTombstones.put({ ...t, by: ERASED_VALUE });
    anonymized += 1;
  }

  for (const l of await paidListings.listForTenantIndexed(tenantId)) {
    if (!l.stateMeta || l.stateMeta.by !== subjectKey) continue;
    // `stateMeta` SURVIVES — dropping it would read as absent-⇒-active and
    // silently release an operator hold.
    await paidListings.put({ ...l, stateMeta: { ...l.stateMeta, by: ERASED_VALUE }, updatedAt: nowIso() });
    anonymized += 1;
  }

  if (anonymized > 0) log.info('commerce_connect_subject_erased', { tenantId, rows: anonymized });
}

/** Registered from the feature's boot module (feature → host, never the reverse). */
export function registerCommerceConnectErasure(): void {
  registerSubjectEraser(eraseCommerceConnectSubject);
}
