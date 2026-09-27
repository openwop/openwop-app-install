/**
 * Commerce Connect routes (ADR 0385 Phase 1) — authed, host-extension,
 * NON-NORMATIVE (`/v1/host/openwop-app/commerce-connect/*`). Seller onboarding +
 * own-account state, tenant-scoped (a seller account is a per-tenant commercial
 * fact, mirroring billing's routes: `tenantOf(req)` is the only tenant ever read
 * or written — no caller-supplied tenant ids, so cross-tenant IDOR is
 * structurally absent). CORRECTED (MPL-2, 2026-08-19): this line used to say
 * "membership in the tenant is the authority" — it was NOT. No route here read a
 * role at all, so a VIEWER in a shared workspace could set the price and the
 * external payout URL. Membership is the authority now, via `authorizeTenant`
 * below; the sentence and the code finally agree. The Stripe-hosted
 * account link is the ONLY onboarding UI (Express); no public routes in Phase 1
 * (the account-link return/refresh URLs land on the SPA, not the backend).
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, requireTenantScope, tenantOf, optionalString, requireString, publicBaseUrl } from '../featureRoute.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { appendAudit } from '../../host/auditChainService.js';
import { getApproval, listPendingCommerceListingApprovals } from '../../host/approvalService.js';
import { claimApproval, rejectApproval } from '../../host/approvalDecision.js';
import { getListing } from '../marketplace/listingService.js';
import { OpenwopError } from '../../types.js';
import {
  getSeller, startOnboarding, syncSellerFromStripe,
  createCheckout, getOrder, listPaidListings, listOrdersFor,
  getApplicationFeePct, setApplicationFeePct, listPayouts, sellerStats,
  dissolveListing, setListingState,
  upsertPaidListing, releaseOwnListing, listOwnListings, getPaidListing,
  getSeller as getSellerAccount, orderIdFor, type ListingLane,
  listDisputes, listRecentOrders, refundOrder, importSellers, type SellerAccount,
} from './connectService.js';

const BASE = '/v1/host/openwop-app/commerce-connect';

const FEATURE = { toggleId: 'commerce-connect', label: 'Commerce Connect' } as const;

/**
 * MPL-2 — the ONE tenant-facing gate for every class-1 route in this file.
 *
 * Until 2026-08-19 there was NO role check anywhere here: `requireFeatureEnabled`
 * checks the toggle and the paid-bundle entitlement, never a role, so any
 * authenticated member of a shared `ws:`/`org:` workspace — a **viewer** included —
 * could `PUT …/listings/:packName` to set the workspace's price, lane and
 * **external payout URL**, and could start money movement via
 * `POST …/purchase/checkout`. The operator approval card attributes the listing
 * to `sellerTenantId` (the workspace), not the submitting user, so a rogue
 * viewer's payout destination is attributed to everyone.
 *
 * These routes are TENANT-scoped (no `:orgId` in any path — `tenantOf(req)` is
 * the only tenant ever read or written), so the shared predicate is
 * `requireTenantScope` — the same one `assistant`, `users` and `operations` use —
 * NOT `authorizeOrgScope`, which resolves `req.params.orgId` and would 404 here.
 * `workspace:write` is editor+ (`accessControlService.ts` EDITOR_SCOPES);
 * `workspace:read` is viewer+ (VIEWER_SCOPES). Reachability is proved per lane in
 * `test/commerce-connect-rbac.test.ts` — owner, admin, editor, viewer, non-member,
 * anon and the wildcard system principal each get their own assertion, because a
 * branch assumed unreachable is how this class survives.
 *
 * NOT applied below the ADR 0575 class-3 divider: those are `requireSuperadmin`
 * and deliberately un-toggled (see the comment there).
 */
async function authorizeTenant(req: Request, scope: 'workspace:read' | 'workspace:write'): Promise<string> {
  await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
  await requireTenantScope(req, scope);
  return tenantOf(req);
}

export function registerCommerceConnectRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // Own seller-account state (null until onboarding starts).
  app.get(`${BASE}/seller`, async (req, res, next) => {
    try {
      res.json({ seller: await getSeller(await authorizeTenant(req, 'workspace:read')) });
    } catch (err) { next(err); }
  });

  // Start (or resume) Express onboarding → the Stripe-hosted account-link URL.
  app.post(`${BASE}/seller/onboard`, async (req, res, next) => {
    try {
      const tenant = await authorizeTenant(req, 'workspace:write');
      const base = publicBaseUrl(req);
      const country = optionalString((req.body ?? {}).country);
      res.status(201).json(await startOnboarding(tenant, {
        returnUrl: `${base}/commerce-connect?onboarding=return`,
        refreshUrl: `${base}/commerce-connect?onboarding=refresh`,
      }, country ? { country } : {}));
    } catch (err) { next(err); }
  });

  // Re-read live account state from Stripe (the onboarding-return bridge).
  app.post(`${BASE}/seller/sync`, async (req, res, next) => {
    try {
      res.json({ seller: await syncSellerFromStripe(await authorizeTenant(req, 'workspace:write')) });
    } catch (err) { next(err); }
  });

  // ── Phase 2 — purchase + listings + orders + operator fee config ─────────────

  // Browse paid listings (own unapproved rows visible to their seller only).
  // Grade-pass DATA-CC-4: each row is annotated with whether its pack actually
  // exists on this host (a tombstoned/uninstalled pack's listing would
  // otherwise look purchasable).
  // CORRECTED (R2 CC2-B2): this comment used to end "annotation only, the
  // purchase gate is the service's own approval/seller checks" — asserting a
  // gate that did not exist. `createCheckout` checked lane, approval, self-
  // purchase, seller readiness and price, and NOT pack existence, so the money
  // path had no such guard at all. It does now; this annotation is the hint,
  // `orders.ts` is the gate.
  app.get(`${BASE}/listings`, async (req, res, next) => {
    try {
      const listings = await listPaidListings(await authorizeTenant(req, 'workspace:read'));
      res.json({
        listings: listings.map((l) => {
          const pack = getListing(l.packName);
          return { ...l, packMissing: !pack || pack.tombstoned === true };
        }),
      });
    } catch (err) { next(err); }
  });

  // Buyer starts a destination-charge purchase (money movement — the ONE write).
  app.post(`${BASE}/purchase/checkout`, async (req, res, next) => {
    try {
      const tenant = await authorizeTenant(req, 'workspace:write');
      const packName = requireString((req.body ?? {}).packName, 'packName');
      const base = publicBaseUrl(req);
      // MKT-UX-2 — Stripe returned a paying BUYER to `/commerce-connect`, the
      // SELLER-ONBOARDING page, and nothing in the SPA read `?purchase` at all.
      // For the typical buyer — who is not a seller — `getSellerAccount()`
      // resolves null and the page renders "Become a seller … Start selling". So
      // the screen shown immediately after a completed charge named no amount, no
      // pack, no order id and no fulfilment expectation, and offered a Stripe
      // onboarding CTA. The bundle lane one route over already returns the buyer
      // to the page that started the flow (`billing/routes.ts`); this follows it.
      //
      // The order id rides the URL so the return page can fetch the real order
      // instead of guessing. It is derived, not invented: `orderIdFor` is the SAME
      // deterministic id `createCheckout` will CAS and hand Stripe as the
      // Idempotency-Key, so no new identifier and no new coupling is introduced.
      const orderId = orderIdFor(tenant, packName);
      const q = `order=${encodeURIComponent(orderId)}&pack=${encodeURIComponent(packName)}`;
      res.status(201).json(await createCheckout(tenant, packName, {
        successUrl: `${base}/marketplace?purchase=success&${q}`,
        cancelUrl: `${base}/marketplace?purchase=cancelled&${q}`,
      }));
    } catch (err) { next(err); }
  });

  // Own orders — both sides (purchases as buyer, sales as seller).
  app.get(`${BASE}/orders`, async (req, res, next) => {
    try {
      res.json(await listOrdersFor(await authorizeTenant(req, 'workspace:read')));
    } catch (err) { next(err); }
  });

  // One order — IDOR-guarded: only its buyer or seller tenant may read it (404
  // otherwise; no existence leak).
  app.get(`${BASE}/orders/:orderId`, async (req, res, next) => {
    try {
      const tenant = await authorizeTenant(req, 'workspace:read');
      const order = await getOrder(String(req.params.orderId));
      if (!order || (order.buyerTenantId !== tenant && order.sellerTenantId !== tenant)) {
        throw new OpenwopError('not_found', 'No such order.', 404, {});
      }
      res.json({ order });
    } catch (err) { next(err); }
  });

  // ── Phase 3 — seller dashboard reads ─────────────────────────────────────────

  // Own payouts (seller-scoped; recorded from payout.* Connect events).
  app.get(`${BASE}/payouts`, async (req, res, next) => {
    try {
      res.json({ payouts: await listPayouts(await authorizeTenant(req, 'workspace:read')) });
    } catch (err) { next(err); }
  });

  // Own seller stats (state + sales aggregates + recent payouts, one call).
  app.get(`${BASE}/seller/stats`, async (req, res, next) => {
    try {
      res.json(await sellerStats(await authorizeTenant(req, 'workspace:read')));
    } catch (err) { next(err); }
  });

  // ── Phase 4 — seller price editor + operator approval queue ─────────────────

  // A seller's own listings, any lane/approval state (the editor's read).
  app.get(`${BASE}/seller/listings`, async (req, res, next) => {
    try {
      res.json({ listings: await listOwnListings(await authorizeTenant(req, 'workspace:read')) });
    } catch (err) { next(err); }
  });

  // Seller lists (or re-prices) one of their packs. Native-paid requires an
  // onboarded seller; a material change re-enters the approval queue (service).
  app.put(`${BASE}/listings/:packName`, async (req, res, next) => {
    try {
      const tenant = await authorizeTenant(req, 'workspace:write');
      const body = (req.body ?? {}) as { lane?: unknown; priceMajorUnits?: unknown; currency?: unknown; externalPaymentUrl?: unknown };
      const lane = requireString(body.lane, 'lane');
      if (!['free', 'external-link', 'native-paid'].includes(lane)) {
        throw new OpenwopError('validation_error', 'lane must be free | external-link | native-paid.', 400, {});
      }
      if (lane === 'native-paid' && !(await getSellerAccount(tenant))) {
        throw new OpenwopError('validation_error', 'Start seller onboarding before listing a native-paid pack.', 409, {});
      }
      res.json({
        listing: await upsertPaidListing(tenant, {
          packName: String(req.params.packName),
          lane: lane as ListingLane,
          ...(typeof body.priceMajorUnits === 'number' ? { priceMajorUnits: body.priceMajorUnits } : {}),
          ...(optionalString(body.currency) ? { currency: optionalString(body.currency) } : {}),
          ...(optionalString(body.externalPaymentUrl) ? { externalPaymentUrl: optionalString(body.externalPaymentUrl) } : {}),
        }),
      });
    } catch (err) { next(err); }
  });

  // MPL-6 / MKT-UX-17 — a seller releases their OWN listing.
  //
  // Until now there was no seller-side delete at all: the only removal was the
  // superadmin `dissolveListing`, which tombstones and imposes a 90-day
  // same-seller cooldown — the wrong instrument for "I no longer want to list
  // this". Combined with the free lane setting no `approvalState` (so no approval
  // row is ever queued), a `PUT …/listings/<any pack> {lane:'free'}` was an
  // INVISIBLE, PERMANENT claim on the name. Reversibility is the cure the service
  // docblock argues for over gating the claim, which would have to refuse on pack
  // ABSENCE and take legitimate listings down on a transiently-unreadable pack dir.
  app.delete(`${BASE}/listings/:packName`, async (req, res, next) => {
    try {
      const tenant = await authorizeTenant(req, 'workspace:write');
      await releaseOwnListing(tenant, String(req.params.packName));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ────────────────────────────────────────────────────────────────────────
  // OPERATOR REMEDIATION SURFACES — ADR 0575 gate class 3.
  // Everything from here down is `requireSuperadmin` and DELIBERATELY NOT
  // toggle-gated: a refund is the remediation of money that already moved, a
  // dispute must be inspectable, and fees/approvals/import are platform
  // authority — none of it may vanish because a tenant (or an incident) turned
  // the feature off. The tenant-facing routes above are class 1 (toggle+RBAC);
  // the webhook is class 2 (money-truth events apply regardless of toggle).
  // `commerce-connect-gate-classes.test.ts` pins all three directions — adding
  // `requireFeatureEnabled` to a route below turns CI red with the money-trap
  // explanation. Do not "fix" the missing toggle here; read ADR 0575 first.
  // ────────────────────────────────────────────────────────────────────────

  // Operator approval queue (superadmin — the approver is NEVER the seller).
  // ADR 0385 (chat-first-port F3) — the queue now reads the SHARED
  // `commerce-listing-publish` approval rows (host/approvalService), and the
  // decision resolves THAT row through the SHARED decision core
  // (host/approvalDecision) — the SAME path the reviews inbox uses, so
  // card-decide ≡ inbox-decide. No bespoke listing flip on this route.
  app.get(`${BASE}/approvals`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Commerce Connect approvals');
      // Join the current listing row (bounded — pending count) so the operator
      // card keeps its price display without widening the approval payload.
      const pending = await Promise.all(
        // CC2-R1 — a row without `commerceListing` cannot be attributed, and
        // emitting `sellerTenantId: ''` would reinstate exactly what the client
        // type forbids: an approval card with no identifiable submitter. Drop
        // it from the queue instead of rendering a blank.
        (await listPendingCommerceListingApprovals())
          .filter((a) => a.commerceListing?.packName)
          .map(async (a) => {
          const packName = a.commerceListing!.packName;
          const listing = packName ? await getPaidListing(packName) : null;
          return {
            approvalId: a.approvalId,
            packName,
            lane: a.commerceListing!.lane,
            proposal: a.proposal,
            createdAt: a.createdAt,
            ...(listing?.priceMajorUnits !== undefined ? { priceMajorUnits: listing.priceMajorUnits } : {}),
            ...(listing?.currency ? { currency: listing.currency } : {}),
            // CC2-B1 — the two facts the decision actually turns on. Read from
            // the LIVE listing, which is safe because `listingMaterialVersion`
            // hashes lane+price+currency+url and `decideCommerceListing`
            // re-checks it both before and after the CAS: an edit supersedes
            // the approval rather than sliding under it. Without these the
            // operator approved a payment destination they never saw.
            sellerTenantId: a.commerceListing!.sellerTenantId,
            ...(listing?.externalPaymentUrl ? { externalPaymentUrl: listing.externalPaymentUrl } : {}),
            // CC2-R1 — the ABSENT half of CC2-B2, closed where it is safe to
            // close it. The money path refuses only a TOMBSTONED pack, because
            // absence is ambiguous and refusing on it would take every purchase
            // down whenever the pack directory is briefly unreadable. Here that
            // trade runs the other way: a stale `true` costs the operator a
            // warning on one card, so the human gate is the right place to be
            // cautious. It also makes `packMissing` a CONSUMED signal — it was
            // emitted on the browse route and read by nothing at all.
            packMissing: !getListing(packName) || getListing(packName)?.tombstoned === true,
          };
        }),
      );
      res.json({ pending });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/approvals/:approvalId`, async (req, res, next) => {
    try {
      // Superadmin authority at the boundary; the handler RE-ASSERTS it via
      // `decidedBySuperadmin` so no non-superadmin decide path can slip through.
      requireSuperadmin(req, 'Commerce Connect approvals');
      const decision = requireString((req.body ?? {}).decision, 'decision');
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new OpenwopError('validation_error', 'decision must be approved | rejected.', 400, {});
      }
      // MKT-UX-7 — the REASON, which did not exist anywhere on the wire. Until
      // now this route parsed `{ decision }` only, so "Rejected" was the entire
      // feedback a seller received and their only exit was retyping the pack id.
      // REQUIRED on reject (a refusal with no reason is a dead end — trace the
      // path the refusal prescribes and there isn't one) and optional on approve.
      // The shared decision core already threaded `note` into `resolveApproval`;
      // nothing ever populated it.
      const reason = optionalString((req.body ?? {}).reason);
      if (decision === 'rejected' && !reason) {
        throw new OpenwopError('validation_error', 'A rejection must carry a `reason` — the seller can only act on a reason they can read.', 400, { field: 'reason' });
      }
      const approval = await getApproval(String(req.params.approvalId));
      if (!approval || approval.kind !== 'commerce-listing-publish') {
        throw new OpenwopError('not_found', 'No such listing approval.', 404, {});
      }
      // Resolve the SELLER-tenant-scoped row through the shared decision core.
      const decisionDeps = { storage: deps.storage, hostSuite: deps.hostSuite };
      const decideCtx = {
        tenantId: approval.tenantId,
        decidedBy: req.userId ?? req.principal?.principalId,
        decidedBySuperadmin: true,
        ...(reason ? { note: reason } : {}),
      };
      const result = decision === 'approved'
        ? await claimApproval(decisionDeps, decideCtx, approval.approvalId)
        : await rejectApproval(decisionDeps, decideCtx, approval.approvalId);
      res.json({ approvalId: result.approvalId, status: result.status });
    } catch (err) { next(err); }
  });

  // ── Phase 5 — operator refunds / disputes / loss ledger + Phase 0 importer ──

  // All disputes + realized platform loss (destination-charge liability).
  app.get(`${BASE}/admin/disputes`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Commerce Connect disputes');
      res.json(await listDisputes());
    } catch (err) { next(err); }
  });

  // Recent orders across tenants (operator console; bounded, newest first).
  app.get(`${BASE}/admin/orders`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Commerce Connect orders');
      res.json({ orders: await listRecentOrders() });
    } catch (err) { next(err); }
  });

  // Full refund with reverse_transfer (money movement — superadmin only; the
  // order flips refunded on the charge.refunded webhook, not here).
  app.post(`${BASE}/admin/orders/:orderId/refund`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Commerce Connect refund');
      res.json(await refundOrder(String(req.params.orderId)));
    } catch (err) { next(err); }
  });

  // ── ADR 0574 P1 — operator listing dissolution (tombstone, never hard-delete;
  // the durable tombstone row carries the 90-day same-seller cooldown). Class-3
  // operator surface per ADR 0575 — superadmin, deliberately NOT toggle-gated.
  app.delete(`${BASE}/admin/listings/:packName`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Commerce Connect listing dissolution');
      const reason = requireString((req.body ?? {})?.reason, 'reason');
      await dissolveListing(String(req.params.packName), req.userId ?? 'superadmin', reason);
      await appendAudit('__host__', 'commerce-connect.listing-dissolved', { packName: req.params.packName, reason });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── ADR 0574 P3 — operator hold / release (`suspended` ⇄ `active`).
  app.put(`${BASE}/admin/listings/:packName/state`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Commerce Connect listing state');
      const body = (req.body ?? {}) as { state?: unknown; reason?: unknown };
      if (body.state !== 'suspended' && body.state !== 'active') {
        throw new OpenwopError('validation_error', '`state` must be `suspended` or `active` (dissolution has its own route).', 400, { field: 'state' });
      }
      await setListingState(String(req.params.packName), body.state, req.userId ?? 'superadmin', requireString(body.reason, 'reason'));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // Phase 0 — MyndHyve continuity importer: Stripe account ids preserved
  // VERBATIM against the same platform account (the ADR 0176 R-1 semantics).
  // An operator data-migration tool, not an app schema migration.
  app.post(`${BASE}/import`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Commerce Connect import');
      const body = (req.body ?? {}) as { sellers?: unknown };
      const rows = Array.isArray(body.sellers) ? (body.sellers as Partial<SellerAccount>[]) : [];
      res.json(await importSellers(rows));
    } catch (err) { next(err); }
  });

  // Operator application-fee config (superadmin; clamped 10–15%; never seller-set).
  app.get(`${BASE}/fee-config`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Commerce Connect fee config');
      const scope = optionalString(req.query.tenantId) ?? '__global__';
      res.json({ key: scope, applicationFeePct: await getApplicationFeePct(scope === '__global__' ? '' : scope) });
    } catch (err) { next(err); }
  });
  app.put(`${BASE}/fee-config`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Commerce Connect fee config');
      // ADR 0575 — a prospective money write is attributable: audit it.
      const body = (req.body ?? {}) as { tenantId?: unknown; applicationFeePct?: unknown };
      const key = optionalString(body.tenantId) ?? '__global__';
      const pct = typeof body.applicationFeePct === 'number' ? body.applicationFeePct : NaN;
      const out = await setApplicationFeePct(key, pct);
      await appendAudit('__host__', 'commerce-connect.fee-config-changed', { scope: key, applicationFeePct: pct });
      res.json(out);
    } catch (err) { next(err); }
  });
}
