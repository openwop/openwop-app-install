/**
 * kicktodo-commerce — the money adapter (ADR 0420 P1).
 *
 * MONEY-TRUTH RULE (ADR 0176/0385, preserved): the order-lifecycle observers
 * and the enroll guard register UNCONDITIONALLY at boot — a paid order grants
 * (and a refund revokes) its entitlement even while the toggle is OFF. The
 * toggle gates only the LINKING/READ routes (discovery of the surface), never
 * money effects.
 */

import type { BackendFeature } from '../types.js';
import { registerOrderPaidObserver, registerOrderRefundObserver } from '../commerce/commerceService.js';
import { registerEnrollGuard } from '../kicktodo-core/enrollmentService.js';
import { enrollGuardVerdict, reprocessOrder } from './entitlementService.js';
import { deriveShares, normalizeShareLedgerRows } from './shareLedgerService.js';
import { linkKicktodoBuyerContact } from './contactLinkObserver.js';
import { registerAffiliateAccrualGuard } from '../commerce/affiliate.js';
import { isSelfReferralAccrual } from './subjectAffiliateBridge.js';
import { reprocessSeatOrder } from './seatService.js';
import { enrollTierVerdict } from './tierGuard.js';
import { registerKicktodoCommerceRoutes } from './routes.js';
import { buildKicktodoCommerceSurface } from './surface.js';
import { registerKicktodoCommerceCompliance } from './compliance.js';
import { registerKicktodoPayoutExceptionSource } from './exceptionSources.js';

export const kicktodoCommerceFeature: BackendFeature = {
  id: 'kicktodo-commerce',
  registerRoutes: (deps) => {
    registerKicktodoCommerceRoutes(deps);
    // ADR 0420 P1 — the fulfilment inversion: commerce notifies; we derive.
    registerOrderPaidObserver(async (order) => void (await reprocessOrder(order, 'grant')));
    registerOrderRefundObserver(async (order) => void (await reprocessOrder(order, 'revoke')));
    // ADR 0431 — cohort SEATS ride the same inversion, registered
    // UNCONDITIONALLY: a refund releases a seat even with the toggle OFF.
    registerOrderPaidObserver(async (order) => void (await reprocessSeatOrder(order, 'grant')));
    registerOrderRefundObserver(async (order) => void (await reprocessSeatOrder(order, 'revoke')));
    // ADR 0445 P1 — author share ledger: DERIVED from the same paid/refund
    // truth, unconditionally (money-truth rule). Downstream of the order-row
    // CAS; the Stripe webhook routing order is untouched by construction.
    registerOrderPaidObserver(async (order) => void (await deriveShares(order, 'accrue')));
    registerOrderRefundObserver(async (order) => void (await deriveShares(order, 'reverse')));
    // ADR 0449 P2 — participant⇄CRM contact bridge: a PAID KickTodo order (one
    // whose line links a challenge OR a cohort seat) that carries a checkout
    // contactId links the buyer subject to that Contact. Best-effort + scoped
    // to KickTodo orders only (never links a plain commerce buyer). No refund
    // pair — the link is durable identity continuity, not a money effect.
    registerOrderPaidObserver(linkKicktodoBuyerContact);
    // Grade fix MEDIUM-2 (ADR 0447) — rewrite any legacy-shaped ledger row
    // canonical at boot so the payout CAS-claim always byte-matches. Idempotent
    // by shape; empty collections ⇒ a no-op; best-effort (never blocks boot).
    void normalizeShareLedgerRows().catch(() => undefined);
    // Paid challenges gate NEW enrollments through kicktodo-core's guard seam.
    registerEnrollGuard(async ({ tenantId, ownerSubject, challenge }) =>
      enrollGuardVerdict({ tenantId, ownerSubject, challenge: { id: challenge.id, version: challenge.version } }),
    );
    // ADR 0420 P2 — the KickBot Plus tier limit (operator tier config;
    // absent ⇒ unlimited) at the same choke point.
    registerEnrollGuard(async ({ tenantId, ownerSubject }) => enrollTierVerdict({ tenantId, ownerSubject }));
    // ADR 0451 P2 — self-referral guard: never credit a buyer for their OWN
    // referral code (the affiliate lane has no owner column; the subject↔code
    // bridge resolves the referrer to compare against the buyer). Registered
    // unconditionally — a self-referral must never accrue regardless of toggle.
    registerAffiliateAccrualGuard(async (order) => !(await isSelfReferralAccrual(order)));
    // ADR 0458 Phase 0 — the ONE subject-eraser for this package (anonymize
    // money-relevant entitlements + drop the affiliate-code linkage). Registered here
    // like the money observers: erasure must work regardless of toggle. No retention
    // purger / resolver — see compliance.ts for why.
    registerKicktodoCommerceCompliance();
    // ADR 0460 Phase 2 — the payout-runs feed of the admin Exception Ledger
    // (open runs awaiting external payment evidence; host never moves money).
    registerKicktodoPayoutExceptionSource();
  },
  toggleDefault: {
    id: 'kicktodo-commerce',
    label: 'KickTodo Commerce',
    description:
      'Sell challenges: product links, per-buyer entitlements granted on verified payment, refund-driven revocation (ADR 0420). Money effects apply toggle-independently.',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kicktodo-commerce',
  },
  dependsOn: ['kicktodo-core', 'commerce'],
  // The pack's entitlement-check / referral-code / seat-availability nodes consume
  // this surface — pin it here, not only transitively via kicktodo-core (NP-KT-3).
  requiredPacks: [{ name: 'feature.kicktodo.nodes', version: '1.30.0' }],
  surface: { id: 'kicktodo-commerce', build: buildKicktodoCommerceSurface }, // ADR 0420 P5
};
