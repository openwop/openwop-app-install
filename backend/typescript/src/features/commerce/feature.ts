/**
 * E-Commerce (ADR 0177) — a new feature-package reversing the roadmap's commerce cut
 * ADDITIVELY (Phase 1 = product catalog + order lifecycle, payment demo-mode). Composes
 * CRM (customer = contactId) + Media (images/downloads = tokens); depends on them, never
 * the reverse — preserving the cut's "CRM ships without commerce" invariant. Toggle OFF ⇒
 * zero behavior change. Host-extension — no wire, no RFC.
 *
 * @see docs/adr/0177-e-commerce.md
 */
import type { BackendFeature } from '../types.js';
import { registerCommerceRoutes } from './routes.js';
import { registerCommerceUcpRoutes } from './ucp/routes.js';
import { registerUcpBuyerRoutes } from './ucpBuyer/routes.js';
import { registerCommerceAgentTools } from './agentTools.js';
import { registerCommerceBuyerAgentTools } from './ucpBuyer/agentTools.js';
import { registerToggleDefault } from '../../host/featureToggles/registry.js';
import { buildCommerceSurface } from './surface.js';
import { setTransactionalEmailTransport } from './transactionalEmail.js';
import { sendBrokeredTransactionalEmail } from '../email/brokeredProvider.js';
import { startCommerceReservationSweep } from './reservationSweep.js';
import { backfillAffiliateLedger } from './affiliate.js';
import { registerSubscriptionRecurrence, registerProductDeletionCleanup } from './subscriptions.js';
import { onCrmRecordDeleted } from '../../host/crmRecordLifecycle.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { deleteSavedPaymentMethodsForContact, anonymizeOrderShippingForContacts, deleteCartsForUser } from './commerceService.js';

export const commerceFeature: BackendFeature = {
  id: 'commerce',
  registerRoutes: (deps) => {
    registerCommerceRoutes(deps);
    // ADR 0447 D3 — opening-balance backfill: frozen `balanceOwed` values become
    // deterministic ledger rows. Idempotent by row key (never a sentinel), so
    // running every boot is safe until the field is deleted in P3. Best-effort:
    // a backfill hiccup must never block boot (reads fall back to zero-net
    // ledger + the export cross-check catches a miss).
    void backfillAffiliateLedger().catch(() => undefined);
    // MERCH-E (ADR 0279) — register the billing invoice.paid → recurring-order bridge
    // (billing fires the seam; commerce never imports back the other way).
    registerSubscriptionRecurrence();
    // grade-data — cancel active subscriptions when their product is deleted, so no
    // live recurring subscription outlives its product (product-lifecycle seam).
    registerProductDeletionCleanup();
    // C5 — the reservation-expiry sweep (publishSweep pattern: feature-owned,
    // bounded, unref'd; releases stock held by unpaid expired orders).
    startCommerceReservationSweep();
    // ADR 0296 P2 — a deleted CRM contact must not leave a charge-capable saved
    // payment reference behind (PRUNE: live capability, not historical data).
    onCrmRecordDeleted('commerce-saved-pm', async (e) => {
      if (e.entity === 'contact') await deleteSavedPaymentMethodsForContact(e.tenantId, e.recordId);
    });
    // PRIV-1 (GDPR right-to-erasure) — commerce's subject data reachable by `eraseSubject`.
    // ANONYMIZE the order shipping snapshot (keep the financial record — legal tax
    // retention) and DELETE saved payment methods for the subject's contactId. Best-effort
    // per the seam contract. The subjectKey is matched as a contactId DIRECTLY: an erasure
    // keyed by a CDP sessionKey would need the `analytics:identity-link` to resolve it, but
    // the analytics eraser DELETES that link in the same fan-out (erasers run in registration
    // order), so a read here would race — resolving a session-keyed subject to its orders
    // needs `eraseSubject` to expand the identity graph UPFRONT (a host-seam follow-up;
    // recorded as PRIV-2). A contactId-keyed erasure — the CRM-contact-erasure case — is
    // fully covered here.
    // EM-4b (review HIGH-2) — and DELETE the subject's carts. `commerce:cart` had
    // no eraser at all; it was invisible to the ADR 0464 gate only because
    // `interface Cart` is declared on ONE LINE, and the moment the gate's signal
    // regexes were de-anchored it started reporting the store COVERED (that check
    // resolves at feature-DIRECTORY level, and this very function is the eraser it
    // was crediting). The subjectKey is a USER id on this lane — see
    // `deleteCartsForUser` for why a contactId-shaped key correctly matches nothing.
    registerSubjectEraser(async function eraseCommerce(tenantId, subjectKey) {
      const contactIds = new Set<string>([subjectKey]);
      await anonymizeOrderShippingForContacts(tenantId, contactIds);
      await deleteSavedPaymentMethodsForContact(tenantId, subjectKey);
      await deleteCartsForUser(tenantId, subjectKey);
    });
    // B4 (gap plan §5B) — the DEFAULT transactional transport: order confirmations
    // ride the email feature's ADR 0193 brokered spine (acting human's Connection +
    // the per-org sender address + the ONE sent-ledger). No connection / no sender
    // ⇒ `false` = the seam's documented honest no-op. Tests can still inject a mock
    // via setTransactionalEmailTransport (last writer wins).
    setTransactionalEmailTransport(async (email) => {
      if (!email.context) return false;
      return sendBrokeredTransactionalEmail({
        storage: deps.storage,
        tenantId: email.context.tenantId,
        orgId: email.context.orgId,
        actingUserId: email.context.actingUserId,
        to: email.to, subject: email.subject, text: email.text,
        ...(email.context.idempotencyKey ? { idempotencyKey: email.context.idempotencyKey } : {}),
      });
    });
    // ADR 0178 — UCP server adapter (agentic commerce). A DISTINCT toggle (`commerce-ucp`,
    // OFF) gates the UCP surface; `commerce` itself is unchanged and runs without it. The
    // UCP routes PROJECT commerce (no new order/cart store) — see docs/adr/0178.
    registerCommerceUcpRoutes(deps);
    // ADR 0188 — the UCP BUYER half (outbound agentic shopping). Distinct toggle;
    // the checkout money gate (org cap + ALWAYS approval) lives in the service.
    registerUcpBuyerRoutes(deps);
    // CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — project the honest, money-safe subset of
    // the Store Assistant + Procurement Concierge allowlists into REAL conversational
    // agent tools (ADR 0308 seam). Toggle honesty + org RBAC live inside each run();
    // NO tool moves money or completes a purchase (the service keeps the money gate).
    registerCommerceAgentTools();
    registerCommerceBuyerAgentTools();
    registerToggleDefault({
      id: 'commerce-ucp-buyer',
      label: 'UCP buyer (agent purchasing)',
      description:
        'Let this host\'s agents/workflows shop EXTERNAL UCP merchants: discover, search, cart, and — only after a human sign-off AND under the org spend cap (OPENWOP_UCP_BUYER_ORG_CAP_MINOR, fail-closed at zero) — place demo-mode AP2 purchases and track them. The host is the payer; the merchant stays Merchant of Record. OFF by default.',
      category: 'Commerce',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'commerce-ucp-buyer',
    });
    registerToggleDefault({
      id: 'commerce-ucp',
      label: 'Universal Commerce Protocol (UCP)',
      description:
        'Expose the commerce catalog/cart/checkout/orders as a UCP-conformant Shopping surface so external AI agents can transact against this merchant (ucp.dev). Projects commerce (no new store); OAuth-2.0 client-credentials identity; the merchant stays Merchant of Record; AP2 payments are demo-mode. Third-party protocol — advertised at UCP’s own discovery, never on the OpenWOP wire. OFF by default.',
      category: 'Commerce',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'commerce-ucp',
    });
  },
  // ADR 0177 Phase 2 — `ctx.features.commerce` (products/orders reads + create-order).
  surface: { id: 'commerce', build: buildCommerceSurface },
  requiredPacks: [
    { name: 'feature.commerce.nodes', version: '1.3.1' },
    { name: 'feature.commerce.agents', version: '1.2.1' },
    { name: 'feature.commerce.buyer.nodes', version: '1.1.2' },
    { name: 'feature.commerce.buyer.agents', version: '1.0.3' },
  ],
  toggleDefault: {
    id: 'commerce',
    label: 'E-Commerce',
    description:
      'Product catalog (physical/digital/service + variants) and orders with a fulfillment lifecycle. Product images & digital downloads ride Media tokens; the customer links to a CRM contact. Payment is demo-mode (records an external payment intent — no live capture yet). OFF by default.',
    category: 'Commerce',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'commerce',
  },
  // Hard dep: orders link to CRM contacts and the service imports the CRM store
  // (`../crm`), so E-Commerce cannot function without the CRM core (ADR 0194
  // disable-lock).
  dependsOn: ['crm'],
};
