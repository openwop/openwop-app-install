/**
 * kicktodo-commerce — the ONE compliance registration for the package
 * (ADR 0458 Phase 0).
 *
 * The money adapter's subject-eraser is DIFFERENT in kind from core/accountability:
 * commerce rows are dominated by the money-truth rule (ADR 0176/0385 — money records
 * are never destroyed). So the eraser ANONYMIZES the billing-relevant per-buyer
 * entitlement (severs the person, keeps the paid-order evidence) and DELETES only the
 * pure identity linkage (the subject↔affiliate-code bridge). Rows deliberately left
 * intact and why:
 *   - `kicktodo-product-links` / `kicktodo-cohort-seat-products` — CATALOG config keyed
 *     by product; `createdBy` is authorship attribution (an opaque subject, ADR 0426),
 *     not buyer personal data (the CRM "third-party business record" precedent).
 *   - `kicktodo-seller-requests` — payout-onboarding / KYC-adjacent records tied to an
 *     operator approval; retained under the money-truth exception.
 *   - `kicktodo-share-ledger` / `kicktodo-payout-runs` / `kicktodo-share-policy` — the
 *     author obligation ledger (money owed + operator payout records); never destroyed.
 *
 * There is NO retention-purger for this package: no commerce row is `confidential-pii`
 * that ages out — every subject-keyed row is either money-truth (retained) or pure
 * linkage (erased on DSAR, not swept by age). Registering a no-op purger would be dead
 * code, so it is deliberately omitted (the honest deviation from "one purger per
 * package"). There is likewise no subject-key resolver — the identity bridge that backs
 * one lives in kicktodo-core.
 *
 * Driven from `feature.ts` `registerRoutes` (runs for every feature regardless of
 * toggle); the handler is a module-level constant, so a repeat registration dedupes.
 */

import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { eraseSubjectEntitlements } from './entitlementService.js';
import { eraseSubjectAffiliateLinks } from './subjectAffiliateBridge.js';

/** The package's single subject-eraser: anonymize billing-relevant entitlements +
 *  delete the affiliate-code linkage. No-op on a falsy tenant; idempotent. */
const kicktodoCommerceEraser = async (tenantId: string, subjectKey: string): Promise<void> => {
  if (!tenantId || !subjectKey) return;
  await eraseSubjectEntitlements(tenantId, subjectKey);
  await eraseSubjectAffiliateLinks(tenantId, subjectKey);
};

/** Register the package's compliance handler (idempotent — the seam dedupes by
 *  reference). Called from `feature.ts` `registerRoutes`. */
export function registerKicktodoCommerceCompliance(): void {
  registerSubjectEraser(kicktodoCommerceEraser);
}
