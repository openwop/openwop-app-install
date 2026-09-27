/**
 * Subscriptions & Billing routes (ADR 0176). Authed reads (subscription / balance /
 * entitlements) under `/v1/host/openwop-app/billing/*`; the PUBLIC Stripe webhook
 * (signature-is-credential, added to PUBLIC_PATH_PREFIXES); the superadmin R-1 import.
 * Checkout/portal call the REAL Stripe API when a key is configured (LEAK-11 fix,
 * `stripeApi.ts`), and fall back to honest `demo:` sentinels when keyless.
 */
import type { Request, Response } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, tenantOf, requireString, publicBaseUrl } from '../featureRoute.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { createLogger } from '../../observability/logger.js';
import { listTenantMembers } from '../../host/accessControlService.js';
import {
  getSubscription, getBalance, resolveEntitlements, verifyStripeSignature,
  processStripeEvent, importBillingState, tenantForStripeCustomer, createCheckoutSession,
  setSeats, createBillingCoupon, generateInvoice, listInvoices, getInvoice,
  publicPricingCatalog, priceForBundle, bundleStore, publicBundlePricing,
  STRIPE_KEY_REF,
  type Subscription, type TokenBalance,
} from './billingService.js';
import { OpenwopError } from '../../types.js';
import { registerEntitlementCheck, registerTenantEntitlementCheck } from '../../host/entitlementSeam.js';
import { requireEntitledFeature, requireEntitledFeatureForTenant } from './entitlementGuard.js';
import { createStripePortalSession } from './stripeApi.js';
import { fireConnectEvent } from './connectEventHook.js';
import { sendError } from '../../middleware/errorEnvelope.js';

const log = createLogger('billing');
const BASE = '/v1/host/openwop-app/billing';
/** Host-level (operator) Stripe webhook signing secret ref — one Stripe account. */
const WEBHOOK_SECRET_REF = 'billing:webhook-secret';
/** ADR 0385 correction — Stripe delivers CONNECTED-ACCOUNT events only through a
 *  webhook endpoint registered with `connect=true`, which carries its OWN signing
 *  secret even when pointed at this same URL. One URL, one owner, TWO secrets. */
const CONNECT_WEBHOOK_SECRET_REF = 'billing:connect-webhook-secret';

export function registerBillingRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ADR 0419 — register billing's plan/bundle entitlement check into the host seam
  // so the core route gate (`requireFeatureEnabled`) can enforce paid bundles for
  // sellable-bundle features WITHOUT a core→feature import. No-op until an operator
  // narrows PLAN_FEATURES (requireEntitledFeature returns quietly when unrestricted).
  registerEntitlementCheck((req, featureId) => requireEntitledFeature(req, featureId));
  // WF-KB-4 / ADR 0583 — the SAME verdict for a recurring daemon, which has a
  // tenant id and no `Request`. Without this half a daemon aligned to a
  // `requireFeatureEnabled`-gated write path keeps spending for a tenant whose
  // plan stopped covering the feature, while every route 403s.
  registerTenantEntitlementCheck((tenantId, featureId) => requireEntitledFeatureForTenant(tenantId, featureId));

  // PUBLIC pricing catalog (ADR 0391 (b)) — the marketing pricing page's read.
  // Under `/v1/host/openwop-app/public/*` (already on PUBLIC_PATH_PREFIXES), so
  // NO auth. Fail-open: returns the static tier list + feature/limit config +
  // optional operator display copy even when the billing toggle is off (the
  // tiers are marketing facts, not entitlements). NEVER leaks a Stripe id.
  app.get('/v1/host/openwop-app/public/pricing', async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ tiers: publicPricingCatalog() });
    } catch (err) { next(err); }
  });

  // ADR 0419 — PUBLIC bundle pricing (the marketing page's read). Anonymous, no
  // auth (public prefix); for-sale bundles only; NO Stripe id on the boundary;
  // `[]` when nothing is priced (honest-when-unconfigured).
  app.get('/v1/host/openwop-app/public/bundle-pricing', async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ bundles: publicBundlePricing() });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/subscription`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      res.json(await getSubscription(tenantOf(req)));
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/balance`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      res.json(await getBalance(tenantOf(req)));
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/entitlements`, async (req, res, next) => {
    try {
      const assignment = await requireFeatureEnabled(req, 'billing', 'Billing');
      res.json(await resolveEntitlements(tenantOf(req), assignment.enabled));
    } catch (err) { next(err); }
  });

  // ADR 0419 — the tenant bundle-store projection (for-sale / owned / display
  // copy per bundle, caller's tenant only; NO Stripe id on the boundary). The
  // marketplace bundle-shop composes this over HTTP onto the catalog.
  app.get(`${BASE}/bundles`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      res.json({ bundles: await bundleStore(tenantOf(req)) });
    } catch (err) { next(err); }
  });

  // Checkout — create a Checkout Session for a configured price. DEMO mode (no
  // Stripe key) returns the honest deterministic sentinel; LIVE mode creates a
  // REAL session via the Stripe API and returns Stripe's own hosted URL
  // (LEAK-11 — the prior code fabricated a checkout.stripe.com URL that 404'd).
  // Fulfilment rides the (already-real) webhook (checkout.session.completed).
  app.post(`${BASE}/checkout`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      const priceId = requireString((req.body ?? {}).priceId, 'priceId');
      const stripeKey = await resolveSecret(STRIPE_KEY_REF);
      const base = publicBaseUrl(req);
      res.status(201).json(await createCheckoutSession(tenantOf(req), priceId, stripeKey, {
        successUrl: `${base}/billing?checkout=success`,
        cancelUrl: `${base}/billing?checkout=cancelled`,
      }));
    } catch (err) { next(err); }
  });
  // ADR 0419 — buy a paid FEATURE BUNDLE (platform→tenant). The client passes a
  // bundleId (never a priceId — the server resolves the CONFIGURED price, so no
  // arbitrary-price / entitlement-injection); an unpriced bundle is not for sale
  // (404). Fulfilment rides the (already-real) webhook: the subscription's
  // {tenantId,bundleId} metadata activates the grant.
  app.post(`${BASE}/bundles/:bundleId/checkout`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      const bundleId = requireString(req.params.bundleId, 'bundleId');
      const priceId = priceForBundle(bundleId);
      if (!priceId) throw new OpenwopError('not_found', 'This bundle is not for sale.', 404, { bundleId });
      const stripeKey = await resolveSecret(STRIPE_KEY_REF);
      const base = publicBaseUrl(req);
      res.status(201).json(await createCheckoutSession(tenantOf(req), priceId, stripeKey, {
        successUrl: `${base}/marketplace/bundles?checkout=success`,
        cancelUrl: `${base}/marketplace/bundles?checkout=cancelled`,
      }));
    } catch (err) { next(err); }
  });
  // Billing portal — LIVE mode creates a REAL Stripe Billing-Portal session for
  // the stored customer (the prior code fabricated a billing.stripe.com URL);
  // keyless or not-yet-a-customer stays the honest demo sentinel.
  app.post(`${BASE}/portal`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      const stripeKey = await resolveSecret(STRIPE_KEY_REF);
      const sub = await getSubscription(tenantOf(req));
      if (stripeKey && sub.stripeCustomerId) {
        const portal = await createStripePortalSession(stripeKey, sub.stripeCustomerId, `${publicBaseUrl(req)}/billing`);
        res.json({ url: portal.url, mode: 'live' });
        return;
      }
      // No real portal URL to offer (keyless, or key present but no Stripe
      // customer yet) → the response IS the demo sentinel; say so.
      res.json({ url: 'demo:portal', mode: 'demo' });
    } catch (err) { next(err); }
  });

  // PUBLIC Stripe webhook — signature IS the credential; NO auth header (added to
  // PUBLIC_PATH_PREFIXES). Verifies over the raw body, resolves the tenant, applies
  // the event idempotently. Demo-mode: 503 not_configured until the signing secret is set.
  app.post(`${BASE}/webhook`, async (req: Request, res: Response) => {
    try {
      const rawBody = req.rawBody?.toString('utf8');
      if (!rawBody) { sendError(res, 400, 'invalid_request', 'The raw request body is required to verify the Stripe signature.'); return; }
      const signingSecret = await resolveSecret(WEBHOOK_SECRET_REF);
      const connectSecret = await resolveSecret(CONNECT_WEBHOOK_SECRET_REF);
      if (!signingSecret && !connectSecret) { sendError(res, 503, 'not_configured', 'No Stripe webhook signing secret is configured on this host.'); return; }
      // Verify against the platform secret, then the Connect-endpoint secret (each
      // check is constant-time; trying both leaks nothing). Fail-closed when
      // neither matches.
      const sigInput = { signatureHeader: req.get('stripe-signature'), rawBody, now: Date.now() };
      const platformVerdict = signingSecret ? verifyStripeSignature({ signingSecret, ...sigInput }) : { ok: false as const, reason: 'missing_headers' as const };
      const verdict = platformVerdict.ok ? platformVerdict : connectSecret ? verifyStripeSignature({ signingSecret: connectSecret, ...sigInput }) : platformVerdict;
      if (!verdict.ok) { log.warn('stripe webhook rejected', { reason: verdict.reason }); sendError(res, 401, 'unauthorized', 'Stripe signature verification failed.'); return; }

      const event = (req.body ?? {}) as { id?: unknown; type?: unknown; account?: unknown; data?: unknown };

      // ADR 0385 — Connect events (top-level `event.account`, present only on
      // connected-account deliveries) go to the registered commerce-connect
      // handler BEFORE customer-based tenant resolution (they carry none) and
      // BEFORE billing's event.id claim (the handler owns its own dedup). A
      // handler error propagates to the 500 below so Stripe retries.
      const connectAccount = typeof event.account === 'string' && event.account ? event.account : undefined;
      if (connectAccount) {
        const eventId = typeof event.id === 'string' ? event.id : '';
        const eventType = typeof event.type === 'string' ? event.type : '';
        if (!eventId || !eventType) { sendError(res, 400, 'invalid_request', 'The Stripe event is missing `id` or `type`.'); return; }
        const outcome = await fireConnectEvent({ event: { id: eventId, type: eventType, account: connectAccount, data: event.data } });
        res.status(202).json({ received: true, applied: outcome.handled });
        return;
      }
      const obj = ((event.data as { object?: unknown })?.object ?? {}) as Record<string, unknown>;

      // ADR 0385 Phase 2 — a marketplace purchase success is a PLATFORM event (no
      // `event.account`): route on the `ccOrderId` metadata marker BEFORE tenant
      // resolution and BEFORE processStripeEvent (whose event.id CAS would claim
      // and strand it). Billing's own sessions never carry `ccOrderId`; the
      // commerce storefront uses its own endpoint + `metadata.orderId`.
      // ADR 0385 Phase 5 — Dispute objects carry NO metadata, so those two types
      // forward unconditionally; the handler resolves the order via its
      // payment-intent index and declines (`handled:false`) when it isn't a
      // marketplace charge. Billing itself ignores dispute events entirely.
      const eventTypeStr = typeof event.type === 'string' ? event.type : '';
      const isDisputeEvent = eventTypeStr === 'charge.dispute.created' || eventTypeStr === 'charge.dispute.closed';
      const ccOrderId = (obj.metadata as { ccOrderId?: unknown } | undefined)?.ccOrderId;
      if (isDisputeEvent || (typeof ccOrderId === 'string' && ccOrderId)) {
        const eventId = typeof event.id === 'string' ? event.id : '';
        const eventType = typeof event.type === 'string' ? event.type : '';
        if (!eventId || !eventType) { sendError(res, 400, 'invalid_request', 'The Stripe event is missing `id` or `type`.'); return; }
        const outcome = await fireConnectEvent({ event: { id: eventId, type: eventType, data: event.data } });
        res.status(202).json({ received: true, applied: outcome.handled });
        return;
      }

      // Tenant = metadata.tenantId (set at checkout for a new customer) OR the tenant
      // owning this Stripe customer (an existing subscription).
      const metaTenant = typeof (obj.metadata as { tenantId?: unknown })?.tenantId === 'string' ? String((obj.metadata as { tenantId?: unknown }).tenantId) : undefined;
      const customerId = typeof obj.customer === 'string' ? obj.customer : '';
      const tenantId = metaTenant ?? (await tenantForStripeCustomer(customerId));
      if (!tenantId) { res.status(202).json({ received: true, applied: false }); return; } // ack unknown-tenant events

      const result = await processStripeEvent(tenantId, event);
      res.status(202).json({ received: true, status: result.status });
    } catch (err) {
      log.error('stripe webhook handler error', { error: err instanceof Error ? err.message : String(err) });
      sendError(res, 500, 'internal_error', 'An unexpected error occurred.');
    }
  });

  // R-1 cutover import (superadmin only) — bulk-load MyndHyve billing state, Stripe ids
  // preserved verbatim. An operator data-migration tool, not an app schema migration.
  app.post(`${BASE}/import`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Billing import');
      const body = (req.body ?? {}) as { subscriptions?: unknown; balances?: unknown };
      const subs = Array.isArray(body.subscriptions) ? (body.subscriptions as Subscription[]) : [];
      const bals = Array.isArray(body.balances) ? (body.balances as TokenBalance[]) : [];
      res.json(await importBillingState({ subscriptions: subs, balances: bals }));
    } catch (err) { next(err); }
  });

  // ── Seat sync (deferred P2) — set the subscription seat count from live org membership. ──
  app.post(`${BASE}/sync-seats`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Billing seat sync');
      const tenantId = tenantOf(req);
      const seats = new Set((await listTenantMembers(tenantId)).map((m) => m.subject)).size;
      res.json(await setSeats(tenantId, seats));
    } catch (err) { next(err); }
  });

  // ── Billing coupons (deferred P2, admin) ──
  app.post(`${BASE}/coupons`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Billing coupons');
      const b = (req.body ?? {}) as { code?: unknown; type?: unknown; value?: unknown };
      const type = b.type === 'fixed' ? 'fixed' : 'percentage';
      res.status(201).json(await createBillingCoupon(tenantOf(req), requireString(b.code, 'code'), type, typeof b.value === 'number' ? b.value : 0));
    } catch (err) { next(err); }
  });

  // ── Invoices (deferred P2) — record + markdown; real PDF composes Documents (0053). ──
  app.get(`${BASE}/invoices`, async (req, res, next) => {
    try { await requireFeatureEnabled(req, 'billing', 'Billing'); res.json({ invoices: await listInvoices(tenantOf(req)) }); } catch (err) { next(err); }
  });
  app.get(`${BASE}/invoices/:invoiceId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      const inv = await getInvoice(tenantOf(req), req.params.invoiceId);
      if (!inv) { sendError(res, 404, 'not_found', 'No such invoice for this workspace.'); return; }
      res.json(inv);
    } catch (err) { next(err); }
  });
  // Generate an invoice (admin/demo — in live mode invoices arrive via the Stripe webhook).
  app.post(`${BASE}/invoices`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Billing invoice');
      const b = (req.body ?? {}) as { amount?: unknown; currency?: unknown };
      res.status(201).json(await generateInvoice(tenantOf(req), typeof b.amount === 'number' ? b.amount : 0, typeof b.currency === 'string' ? b.currency : 'USD'));
    } catch (err) { next(err); }
  });
}
