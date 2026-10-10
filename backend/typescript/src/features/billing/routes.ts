/**
 * Subscriptions & Billing routes (ADR 0176). Authed reads (subscription / balance /
 * entitlements) under `/v1/host/openwop-app/billing/*`; the PUBLIC Stripe webhook
 * (signature-is-credential, added to PUBLIC_PATH_PREFIXES); the superadmin R-1 import.
 * Checkout/portal call the REAL Stripe API when a key is configured (LEAK-11 fix,
 * `stripeApi.ts`), and fall back to honest `demo:` sentinels when keyless.
 */
import { isListedSuperadmin } from '../../host/superadmin.js';
import type { Request, Response } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, tenantOf, requireString, publicBaseUrl, requireTenantScope } from '../featureRoute.js';
import { isAnonTenantId, callerSubject } from '../../host/requestSubject.js';
import { describeAiCreditMeter } from './aiCreditMeter.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { createLogger } from '../../observability/logger.js';
import { listTenantMembers } from '../../host/accessControlService.js';
import {
  getSubscription, getBalance, resolveEntitlements, verifyStripeSignature,
  processStripeEvent, importBillingState, resolveEventTenant, createCheckoutSession,
  setSeats, createBillingCoupon, generateInvoice, listInvoices, getInvoice,
  publicPricingCatalog, publicBillingPolicy, priceForBundle, priceForPlan, bundleStore, publicBundlePricing, publicFeatureLabels, publicCreditPacks,
  isBillingCadence, pastDueGraceEndsAtMs, entitlementEndedAt, STRIPE_KEY_REF,
  listTokenPacks, priceForTokenPack, listCheckoutsSince, countActiveEntitlements,
  type BillingCadence,
  type Subscription, type TokenBalance,
} from './billingService.js';
import { OpenwopError } from '../../types.js';
import { registerEntitlementCheck, registerTenantEntitlementCheck } from '../../host/entitlementSeam.js';
import { registerEntitlementEndedAtSource } from '../../host/publicLapse.js';
import { requireEntitledFeature, requireEntitledFeatureForTenant } from './entitlementGuard.js';
import { createStripePortalSession } from './stripeApi.js';
import { fireConnectEvent } from './connectEventHook.js';
import { sendError } from '../../middleware/errorEnvelope.js';
import { listFeatureSpendForDay } from '../../host/managedCredits.js';
import { listPaywallCounts, windowDays } from '../../host/paywallFunnel.js';
import { buildFunnelReport } from './funnelReport.js';
import { weekOverWeek } from './funnelWeeklySummary.js';
import { displayablePlanLimits } from '../../host/planLimitsSeam.js';

const log = createLogger('billing');
const BASE = '/host/openwop-app/billing';
/** Host-level (operator) Stripe webhook signing secret ref — one Stripe account. */
const WEBHOOK_SECRET_REF = 'billing:webhook-secret';
/** ADR 0385 correction — Stripe delivers CONNECTED-ACCOUNT events only through a
 *  webhook endpoint registered with `connect=true`, which carries its OWN signing
 *  secret even when pointed at this same URL. One URL, one owner, TWO secrets. */
const CONNECT_WEBHOOK_SECRET_REF = 'billing:connect-webhook-secret';

/**
 * ADR 0786 D5 — the ONE authority for a billing WRITE (checkout, bundle checkout,
 * portal). The subscription and its card are tenant-wide, so buying or opening the
 * portal (cancel, change card, read invoices) is admin-class: `host:billing:manage`
 * via `requireTenantScope` — the ADR 0711/0779 BYOK authority, which short-circuits
 * on the caller's own personal workspace and, unlike `callerHoldsTenantScope`,
 * never grants an undeclared `owk_` key. The anon refusal comes FIRST and is not
 * optional: `requireTenantScope` would ALLOW an `anon:` personal tenant.
 */
async function requireBillingManage(req: Request): Promise<void> {
  if (isAnonTenantId(tenantOf(req))) {
    throw new OpenwopError('forbidden', 'Sign in to purchase or manage billing.', 403, { reason: 'anonymous_session' });
  }
  await requireTenantScope(req, 'host:billing:manage');
}

/** ADR 0820 §7 — a checkout body's `cadence`: absent ⇒ `month`; anything other
 *  than `month`/`year` is a 400, never a silent default to a different price. */
function cadenceOf(v: unknown): BillingCadence {
  if (v === undefined || v === null) return 'month';
  if (!isBillingCadence(v)) throw new OpenwopError('validation_error', 'cadence must be "month" or "year".', 400, { field: 'cadence' });
  return v;
}

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
  // ADR 0820 §7 — when a public runtime's owner is refused, the lapse grace starts
  // at the moment billing says coverage ENDED (past-due grace end, or the canceled
  // row's write), not at the first refusal this host happens to observe.
  // `entitlementEndedAt` documents what "ended" means per source and answers
  // `null` (→ the observed clock) whenever it cannot say honestly.
  registerEntitlementEndedAtSource((tenantId, featureId) => entitlementEndedAt(tenantId, featureId));

  // PUBLIC pricing catalog (ADR 0391 (b)) — the marketing pricing page's read.
  // Under `/v1/host/openwop-app/public/*` (already on PUBLIC_PATH_PREFIXES), so
  // NO auth. Fail-open: returns the static tier list + feature/limit config +
  // optional operator display copy even when the billing toggle is off (the
  // tiers are marketing facts, not entitlements). NEVER leaks a Stripe id.
  app.get('/host/openwop-app/public/pricing', async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'public, max-age=300');
      // featureLabels + creditPacks (ADR 0820 §7 / ADR 0821 D7): the page's human
      // feature names and priced AI credit packs — still no Stripe id or pack key.
      // billingPolicy (ADR 0820 §7 pricing FAQ): the grace windows the FAQ states.
      const tiers = publicPricingCatalog();
      res.json({ tiers, featureLabels: publicFeatureLabels(tiers, publicBundlePricing()), creditPacks: publicCreditPacks(), billingPolicy: publicBillingPolicy() });
    } catch (err) { next(err); }
  });

  // ADR 0419 — PUBLIC bundle pricing (the marketing page's read). Anonymous, no
  // auth (public prefix); for-sale bundles only; NO Stripe id on the boundary;
  // `[]` when nothing is priced (honest-when-unconfigured).
  app.get('/host/openwop-app/public/bundle-pricing', async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ bundles: publicBundlePricing() });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/subscription`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      const sub = await getSubscription(tenantOf(req));
      // ADR 0820 §7 — the past-due banner's "access continues until" date. Present
      // only while past_due AND a grace window is configured.
      const graceEnd = sub.status === 'past_due' ? pastDueGraceEndsAtMs(sub.pastDueSince) : undefined;
      res.json(graceEnd !== undefined ? { ...sub, pastDueGraceEndsAt: new Date(graceEnd).toISOString() } : sub);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/balance`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      res.json(await getBalance(tenantOf(req)));
    } catch (err) { next(err); }
  });

  // ADR 0821 D1/D2/D4 — the billing page's AI credit meter (free daily → plan
  // monthly → purchased, plus the per-feature breakdown). Tenant-wide AI spend
  // per feature is ADMIN-class (usage-analytics' rollup of the same store is
  // `host:members:manage`), so this read goes through the ONE billing authority,
  // `requireBillingManage` — never the member-level read predicate the balance
  // uses. The tenant is the session's (`tenantOf`), and the authority is
  // asserted IN that tenant, so a caller can only meter a workspace they manage.
  app.get(`${BASE}/ai-credits`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      await requireBillingManage(req);
      res.json(await describeAiCreditMeter(tenantOf(req), callerSubject(req)));
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/entitlements`, async (req, res, next) => {
    try {
      const assignment = await requireFeatureEnabled(req, 'billing', 'Billing');
      const ent = await resolveEntitlements(tenantOf(req), assignment.enabled);
      // What the SPA locks is this list, so it must agree with the route gate:
      // the operator is unrestricted in whichever workspace is active.
      // ADR 0821 D6 — the SPA renders these limits, so only enforced keys are sent.
      res.json(isListedSuperadmin(req) ? { ...ent, allowedFeatures: '*', limits: {} } : { ...ent, limits: displayablePlanLimits(ent.limits) });
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
      await requireBillingManage(req);
      // A plan may be bought by tier + cadence (ADR 0820 §7 — the server resolves the
      // price, as for bundles) or, as before, by a configured priceId.
      const body = (req.body ?? {}) as { priceId?: unknown; plan?: unknown; cadence?: unknown };
      let priceId: string;
      if (body.plan !== undefined) {
        const plan = body.plan;
        if (plan !== 'pro' && plan !== 'team' && plan !== 'enterprise') throw new OpenwopError('validation_error', 'plan must be pro, team or enterprise.', 400, { field: 'plan' });
        const resolved = priceForPlan(plan, cadenceOf(body.cadence));
        if (!resolved) throw new OpenwopError('not_found', 'This plan is not for sale at that billing cadence.', 404, { plan, cadence: cadenceOf(body.cadence) });
        priceId = resolved;
      } else {
        priceId = requireString(body.priceId, 'priceId');
      }
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
      await requireBillingManage(req);
      const bundleId = requireString(req.params.bundleId, 'bundleId');
      // ADR 0820 §7 — the client picks a CADENCE, never a price; the server resolves
      // the configured price for bundle + cadence (default monthly).
      const cadence = cadenceOf((req.body ?? {}).cadence);
      const priceId = priceForBundle(bundleId, cadence);
      if (!priceId) throw new OpenwopError('not_found', 'This bundle is not for sale at that billing cadence.', 404, { bundleId, cadence });
      const stripeKey = await resolveSecret(STRIPE_KEY_REF);
      const base = publicBaseUrl(req);
      res.status(201).json(await createCheckoutSession(tenantOf(req), priceId, stripeKey, {
        successUrl: `${base}/marketplace/bundles?checkout=success`,
        cancelUrl: `${base}/marketplace/bundles?checkout=cancelled`,
      }));
    } catch (err) { next(err); }
  });
  // ADR 0821 D1/D7 — the store's AI-credit packs. Gated like the bundle-store
  // read (billing toggle; the caller's own tenant). Every pack the operator
  // configured, keyed by an OPAQUE packKey — NO Stripe id on the boundary — with
  // its optional display copy; `[]` when no pack is configured.
  app.get(`${BASE}/token-packs`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      res.json({ packs: listTokenPacks() });
    } catch (err) { next(err); }
  });
  // ADR 0821 D7 — buy a credit pack by its opaque key. The server resolves the
  // configured price (the client never names one — ADR 0419); fulfilment is the
  // unchanged checkout-row CAS on the webhook (ADR 0786). The legacy
  // `POST /checkout {priceId}` lane still accepts a pack price and is left as is.
  app.post(`${BASE}/token-packs/:packKey/checkout`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      await requireBillingManage(req);
      const packKey = requireString(req.params.packKey, 'packKey');
      const priceId = priceForTokenPack(packKey);
      if (!priceId) throw new OpenwopError('not_found', 'This credit pack is not for sale.', 404, { packKey });
      const stripeKey = await resolveSecret(STRIPE_KEY_REF);
      const base = publicBaseUrl(req);
      const session = await createCheckoutSession(tenantOf(req), priceId, stripeKey, {
        successUrl: `${base}/marketplace/bundles?checkout=credits`,
        cancelUrl: `${base}/marketplace/bundles?checkout=cancelled`,
      });
      // The store named a pack, not a price — so the price id is not echoed back.
      res.status(201).json({ sessionId: session.sessionId, url: session.url, mode: session.mode, createdAt: session.createdAt });
    } catch (err) { next(err); }
  });
  // Billing portal — LIVE mode creates a REAL Stripe Billing-Portal session for
  // the stored customer (the prior code fabricated a billing.stripe.com URL);
  // keyless or not-yet-a-customer stays the honest demo sentinel.
  app.post(`${BASE}/portal`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'billing', 'Billing');
      await requireBillingManage(req);
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

      // Tenant (ADR 0786 D1/D3): the checkout row we wrote for a session, else the
      // object's metadata, else an invoice's subscription-metadata snapshot, else
      // the customer's tenant. Still AFTER the Connect/ccOrderId branches above.
      const tenantId = await resolveEventTenant(event);
      if (!tenantId) { res.status(202).json({ received: true, applied: false }); return; } // ack unknown-tenant events

      // The key is used to READ current Stripe state (D1/D4), never to write.
      const result = await processStripeEvent(tenantId, event, { stripeKey: await resolveSecret(STRIPE_KEY_REF) });
      // D0 — another delivery holds a fresh claim on this event: answer non-2xx so
      // Stripe RETRIES it (a 2xx would count as delivered and lose it if that
      // holder dies before finishing).
      if (result.status === 'in_progress') { sendError(res, 409, 'conflict', 'This Stripe event is being processed; retry.'); return; }
      res.status(202).json({ received: true, status: result.status });
    } catch (err) {
      // ADR 0786 D9 — a rejected key is the one read failure an operator must act on.
      if (err instanceof OpenwopError && err.code === 'credential_unavailable') {
        log.error('stripe webhook: Stripe rejected the configured API key — rotate `billing:stripe-key`; events are being retried', {});
      }
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

  // ADR 0821 D4 / P1 — the OPERATOR's per-feature managed-spend read ("measure
  // before pricing"): every tenant's per-(day, feature) rows for one UTC day.
  //
  // WHY HERE AND NOT UNDER usage-analytics. This is cross-tenant platform-cost
  // accounting, which is the operator's commercial surface: billing already owns
  // the superadmin-only operator routes (import, seat sync, coupons) and the
  // prepaid ledger these rows explain. usage-analytics is a TENANT-admin,
  // org-scoped read (`host:members:manage`); giving it a cross-tenant route would
  // put two authorization models behind one package. Its tenant-scoped view of
  // the same store rides its own rollup route instead.
  //
  // Deliberately NOT gated on the `billing` toggle: the point of P1 is to measure
  // spend BEFORE an operator turns pricing on. Superadmin is the only gate.
  app.get(`${BASE}/admin/usage-by-feature`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Per-feature AI spend');
      const raw = typeof req.query.day === 'string' ? req.query.day : '';
      const day = raw || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new OpenwopError('validation_error', '`day` must be YYYY-MM-DD (UTC).', 400, { field: 'day' });
      const rows = await listFeatureSpendForDay(day);
      const byFeature = new Map<string, { featureId: string; tenants: number; inputTokens: number; outputTokens: number; calls: number; chargedTokens: number }>();
      for (const r of rows) {
        const agg = byFeature.get(r.featureId) ?? { featureId: r.featureId, tenants: 0, inputTokens: 0, outputTokens: 0, calls: 0, chargedTokens: 0 };
        agg.tenants += 1; agg.inputTokens += r.inputTokens; agg.outputTokens += r.outputTokens; agg.calls += r.calls; agg.chargedTokens += r.chargedTokens;
        byFeature.set(r.featureId, agg);
      }
      const features = [...byFeature.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
      res.json({ day, features, rows });
    } catch (err) { next(err); }
  });

  // Strategy §8 — the operator's paywall → checkout → grant funnel, per bundle
  // and feature over a 7-, 30- or 90-day UTC window. Checkouts and grants are
  // daily counts in `paywall:funnel-counts` (92-day TTL) since the funnel digest
  // (ADR 0820 §7); before that they were read from the `billing:checkout` ledger,
  // which ages out at 30 days and is still read for rows the counts never saw.
  // Superadmin only, cross-tenant by design, and like usage-by-feature NOT gated
  // on the `billing` toggle: the funnel is read before and while pricing is on.
  app.get(`${BASE}/admin/funnel`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Paywall funnel');
      const raw = typeof req.query.days === 'string' ? req.query.days : '7';
      if (raw !== '7' && raw !== '30' && raw !== '90') throw new OpenwopError('validation_error', '`days` must be 7, 30 or 90.', 400, { field: 'days' });
      const days = Number(raw);
      const now = new Date();
      const window = windowDays(days, now);
      const since = `${window[window.length - 1]}T00:00:00.000Z`;
      const [counts, checkouts, active] = await Promise.all([
        listPaywallCounts(days, now), listCheckoutsSince(since), countActiveEntitlements(now.getTime()),
      ]);
      res.json(buildFunnelReport({ days, since, until: now.toISOString(), counts, checkouts, active }));
    } catch (err) { next(err); }
  });

  // The funnel digest (ADR 0820 §7): the last 7 UTC days against the 7 before —
  // the panel's "This week vs last week" header, and the same numbers the weekly
  // operator notice sends. Superadmin only, like the read above.
  app.get(`${BASE}/admin/funnel/weekly`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Paywall funnel');
      res.json(await weekOverWeek(new Date()));
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
