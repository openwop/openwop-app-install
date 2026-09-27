# ADR 0385 — `commerce-connect`: two-sided seller marketplace on Stripe Connect

**Status:** implemented (Phases 0–5; see § Implementation record)

> **Correction note (chat-first-port F3, 2026-07-22).** Phase 4's operator
> listing-approval queue was a SECOND approvals inbox: bespoke approve/reject
> buttons on a superadmin route (`setListingApproval`) flipping the listing's
> private `approvalState`, duplicating `host/approvalService` + the unified reviews
> inbox. Reconciled onto the shared owner: a listing submission
> (`syncCommerceListingApproval`) now queues a shared
> `kind:'commerce-listing-publish'` PendingApproval (stored under the seller's
> tenant; deterministic per listing+material-version — an identical re-submit
> reuses the row, a material edit supersedes it). The operator card's buttons and
> the reviews inbox BOTH resolve THAT row through the shared decision core
> (`claimApproval`/`rejectApproval` → the feature's registered
> `commerce-listing-publish` handler), which enforces SUPERADMIN authority
> (`decidedBySuperadmin`, computed at the HTTP boundary) and flips the listing
> `approvalState` as a derived mirror. The separation-of-duties invariant (the
> approver is NEVER the seller) is preserved by the superadmin gate + a
> superadmin-only reviews-inbox visibility filter. Finding 2: the log-only
> `dispute LOST` / open-dispute webhook anomalies now surface as operator-visible
> `host/exceptionProjection` rows (`commerce-connect:disputes`, read-first over the
> existing `disputes` store); the two transient tenant-LESS webhook anomalies
> (`purchase event for UNKNOWN order`, `unknown Connect account`) stay enriched log
> lines — with no order/account→tenant attribution they cannot honestly be placed
> in a tenant-scoped exception ledger.
**Date:** 2026-07-17
**Owner:** a NEW feature-package `features/commerce-connect/`
**Toggle:** `commerce-connect` (default **OFF**, `bucketUnit: tenant`)
**Surface:** authed `/v1/host/openwop-app/commerce-connect/*` + a public checkout return
lane (host-extension, NON-NORMATIVE — no new wire, no RFC; see § RFC verdict)
**Composes (does NOT fork):** `features/billing/` (ADR 0176 — the Stripe HTTP client
`stripeApi.ts`, the public webhook endpoint + signature verification, the `event.id` CAS
dedup ledger, the BYOK key ref), `features/marketplace/` (ADR 0022 — pack listings/reviews;
paid packs ride THIS feature), `features/commerce/` (ADR 0177/0228 — refund + money seam),
the HITL/approvals seam (native-paid seller gate), `byok/secretResolver`.

---

## Context

The MyndHyve gap analysis (`docs/steward/MYNDHYVE-GAP-ANALYSIS.md`, commerce domain table
`:187`) names the **two-sided Stripe Connect seller marketplace** as *"the one structural
commerce absence"* and *"the largest gap"* — everything else in commerce is COVERED or
COVERED-BETTER. openwop-app has a **pack** marketplace (free install, ADR 0022), a full
own-goods **commerce** engine (ADR 0177 and its follow-ons), and Stripe **billing** with a
day-1 id-preserving cutover importer (ADR 0176) — but nothing that onboards a *third-party*
seller, takes a **destination charge**, or splits a **platform application fee**. A
definitive grep confirms zero Connect primitives exist today (see § Boundaries audit).

This is **P0.3** in the port backlog (`docs/steward/MYNDHYVE-GAP-ANALYSIS.md:34`), **RESOLVED — build
it**. The decision rationale is `docs/steward/MYNDHYVE-DECISIONS.md` §1 (two adversarially-verified deep
research passes, citations fetched live 2026-07-17), which this ADR adopts verbatim as its
decision source:

> **BUILD on Stripe Connect (Express accounts + destination charges).** Do NOT adopt a
> third-party merchant-of-record (Paddle/Lemon Squeezy). **v1 = free listings +
> external-payment-link paid listings open to everyone; native Stripe-paid listings behind
> an operator approval gate (Notion's model).** Platform application fee **10–15%**.
> **Same-region payout restriction** initially (Stripe recommends destination charges for
> same-country pairs; route the rest to external links). Under destination charges the
> **PLATFORM eats Stripe fees, refunds, chargebacks, and disputes** (creator recovery is
> best-effort transfer reversal) — set an explicit `reverse_transfer`/refund policy in v1.

Verified norm anchors from §1 (cite these, not the refuted claims): Notion 8% + $0.40 with
native selling behind a waitlist + approval while shipping free templates AND
external-payment-link listings; Figma flat 15%, Express-pattern payouts, and has *paused*
approving new paid-file sellers; Framer 0% open-paid is the outlier. **Refuted — never
cite:** the Shopify "0% under $1M revenue share" figure (`docs/steward/MYNDHYVE-DECISIONS.md:18,96`).

**Sequencing fact still owed by David** (affects priority, not architecture): whether
MyndHyve has **live Connect sellers today**. With live sellers this is the P0 migration
blocker (and the id-preserving importer phase, §Phase 0, is on the critical path); without
them it is still the right architecture, shipped at P1/P2. The ADR is written for either.

---

## Boundaries audit (done first — file:line evidence)

| Concern | Single owner (compose) | Evidence |
|---|---|---|
| Stripe HTTP client (raw `fetch`, hardcoded `api.stripe.com`, pinned `Stripe-Version`, per-POST `Idempotency-Key`) | **`features/billing/stripeApi.ts`** | `stripeApi.ts:23` base, `:38` version, `:40` `stripeRequest`. **Connect calls (`POST /v1/accounts`, `/v1/account_links`, charges with `application_fee_amount`+`transfer_data[destination]`, `/v1/transfers`, `/v1/refunds` with `reverse_transfer`) are NEW functions ADDED to this one file** — never a second Stripe client. |
| Public Stripe webhook endpoint + signature verification + `event.id` idempotency | **`features/billing/routes.ts:92` (`${BASE}/webhook`)** + `billingService.ts:261` `processStripeEvent` (CAS claim `:272` on `billing:webhook-event`, `:240` `verifyStripeSignature`) | ONE endpoint, ONE signing secret, ONE dedup ledger. commerce-connect does **not** add a second public webhook route (see § Decision, webhook composition). |
| Cross-feature webhook handoff without an upward import | **`features/billing/subscriptionInvoiceHook.ts`** (`setSubscriptionInvoiceHook`/`fireSubscriptionInvoicePaid`, `:24`/`:29`; billing fires, commerce registers, billing never imports commerce) | This dependency-inversion seam is the **exact pattern** commerce-connect mirrors for Connect events. |
| Refund + money/minor-unit boundary | **`features/commerce/` + `billing/stripeApi.ts:213` `createStripeRefund`**, `toStripeMinorUnits :129` | Refund of a marketplace purchase reuses `createStripeRefund` (add `reverse_transfer`); money is MAJOR-unit `number` app-side, minor units only at the Stripe boundary (the ADR 0383 convention). |
| Listings (browse/install/reviews/cert) | **`features/marketplace/listingService.ts`** (`Listing` is a COMPUTED projection `:29`/`:110`, `DurableCollection<Review>` is the only store) | Paid listings **extend** `listingService` with optional pricing metadata + a purchase check — NOT a parallel catalog. Install stays superadmin, signed-only (ADR 0022 `:172`); PURCHASE is the new org-scoped action. |
| Native-paid seller approval | **the HITL/approvals seam** (ADR 0198 depth) | Native Stripe-paid selling is gated by an operator approval workflow, not a bespoke boolean. |
| Plan entitlements (may a paid pack be *delivered* to this buyer) | **`billing.resolveEntitlements`** (`billingService.ts:128`) | Paid-pack delivery consults the existing entitlement resolver; never a new gate. |

**No existing Connect primitives — the grep that proves the gap:**
`grep -rn "application_fee|transfer_data|account_link|reverse_transfer|on_behalf_of|/v1/accounts|connectCreateSeller"` over `backend/typescript/src/` returns **zero** (excluding the
unrelated `connection`/`connected` substrings). This matches the gap analysis' "definitive
grep" (`:187`). `payout` hits elsewhere are the affiliate-commission ledger (ADR 0177 P5),
not Connect. So commerce-connect adds genuinely-new structures; it forks nothing.

---

## Decision

A `commerce-connect` feature-package (toggle OFF, tenant-bucketed) that owns **seller
Connect-account state + paid-listing pricing + purchase/order records + application-fee
config + the native-paid approval gate + the refund/dispute policy & ledger**, drives Stripe
Connect **through billing's existing `stripeApi.ts` client**, and receives Connect webhook
events **through billing's existing endpoint via a registered dependency-inversion handler**.

### Webhook composition — reuse billing's endpoint, register a handler (the crux)

**Decision: ONE public endpoint (billing's), ONE signing secret, ONE `event.id` CAS dedup —
plus a Connect-event registration seam that mirrors `subscriptionInvoiceHook.ts`.** Rejected:
a *second* `/commerce-connect/webhook` endpoint with its own signing secret (a parallel
public surface + a second verification path + a second dedup ledger — exactly the
duplication ADR 0176 forbade for the billing webhook itself).

Concretely, add to billing a `connectEventHook.ts` seam (billing OWNS + fires it; billing
never imports commerce-connect; default no-op ⇒ byte-identical when the feature is
absent/OFF):

```
// billing/connectEventHook.ts  (mirrors subscriptionInvoiceHook.ts)
setConnectEventHook(fn | null)             // commerce-connect registers at boot
fireConnectEvent({ event }): Promise<{ handled: boolean }>   // billing calls it
```

Wiring at the billing webhook route (`routes.ts:92`), AFTER signature verification and the
`event.id` CAS claim, BEFORE the customer-based tenant resolution that Connect events can't
satisfy:

- Connect events (`account.updated`, `account.application.deauthorized`,
  `capability.updated`, `payment_intent.succeeded`/`charge.succeeded` carrying
  `application_fee_amount`, `charge.refunded`, `charge.dispute.{created,closed}`,
  `transfer.created`, `payout.{paid,failed}`) are identified by the **top-level
  `event.account`** field (present only on Connect events) or a registered type set →
  handed to `fireConnectEvent`. commerce-connect does its **own tenant resolution**
  (`event.account` → seller tenant, via its `commerce-connect:seller` reverse index) and its
  **own purchase-level idempotency** keyed on the `payment_intent`/`charge`/`dispute` id
  (the ADR 0279 finding: `event.id` dedup is necessary but not sufficient — a re-delivered
  charge under a different event id must not double-fulfil).
- Non-Connect events flow unchanged through billing's existing subscription/invoice branches.
- The handler NEVER throws into the webhook path (swallow + let Stripe retry; the
  purchase-level dedup makes reprocessing safe) — same contract as `fireSubscriptionInvoicePaid`.

This keeps the load-bearing security invariants (raw-body HMAC verify, CAS-claim dedup) in
their single owner and gives commerce-connect the raw verified event with zero new public
attack surface.

> **Correction note (Phase 1 /architect review, 2026-07-17).** Three claims above were
> adjusted against the real code:
> 1. **Hook placement.** Billing's `event.id` CAS lives *inside* `processStripeEvent`
>    (`billingService.ts` `seenEvents.compareAndSwap`), which the route calls *after*
>    customer-based tenant resolution — so "after the `event.id` CAS claim" was impossible:
>    a Connect event would be acked `applied:false` before any CAS. As built, the route
>    branches on top-level `event.account` immediately after signature verification, and
>    the commerce-connect handler owns its own event-level CAS dedup. Consequently the
>    `commerce-connect:webhook-event` store is **required from Phase 1**, not optional.
> 2. **"ONE signing secret" is physically wrong for Connect.** Stripe delivers
>    connected-account events only through a webhook endpoint registered with
>    `connect=true`, which carries its **own** signing secret even when pointed at the same
>    URL. Billing's route now verifies against the platform secret then an optional
>    `billing:connect-webhook-secret` (both constant-time, fail-closed when neither
>    matches). Still one URL, one owner, one verification path.
> 3. **Handler errors propagate** (they do not "swallow + let Stripe retry" — a swallowed
>    error is acked 202 and Stripe does NOT retry). The handler releases its idempotency
>    claim on error and the route's 500 is what triggers Stripe's retry.

> **Correction note (grade pass, 2026-07-17).** The v1 "free + external-link lanes
> ship ungated" ruling (§1's Notion model) is **narrowed: the external-link lane is
> operator-approval-gated like native-paid; only the FREE lane ships ungated.** The
> Notion anchor is a single-vendor marketplace; in a multi-tenant host an unreviewed
> listing pointing an arbitrary https "payment URL" at other tenants is a
> phishing/name-squat vector (grade finding CC-2). Unapproved paid-lane rows are
> visible only to their own seller; the marketplace pricing annotation never carries
> an unapproved external URL. Also hardened in the same pass: self-healing reverse
> indexes (CC-1), structured logs on every money-path decline (CC-3), checkout CAS
> discipline (CC-7), missing-amount fail-closed (CC-8), minor-unit-first fee math
> (CC-9), and a clobber-proof importer (CC-10) — tracked in
> `docs/CODEBASE-ASSESSMENT-adr0385-0392-batch.md`.

> **Correction note (Phase 2 /architect review, 2026-07-17).**
> 1. **Purchase-success routing is metadata-keyed, not type-keyed.** Destination-charge
>    successes (`checkout.session.completed`, `payment_intent.succeeded`) are PLATFORM
>    events with no `event.account`; billing's route branches on the `metadata.ccOrderId`
>    marker BEFORE tenant resolution/`processStripeEvent` (whose `event.id` CAS would
>    otherwise claim and strand them). No collision with the commerce storefront — that
>    rides its own endpoint (`commerce/webhook`, own secret) and `metadata.orderId`.
> 2. **The v1 same-region restriction is PLATFORM↔seller, not buyer↔seller** (Stripe's
>    destination-charge same-country guidance constrains the platform/connected-account
>    pair; a buyer's card country is unknowable pre-checkout). Guard:
>    `seller.region === OPENWOP_CONNECT_PLATFORM_REGION` (default `US`).
> 3. **Money-truth exception:** purchase-success events are applied even when the tenant's
>    toggle has been turned OFF since checkout — the charge already happened; dropping the
>    event would lose a payment record. Only purchase *initiation* is toggle-gated.
> 4. Purchase idempotency uses the ORDER-ROW CAS (`pending→paid`) as the sole dedup (an
>    `event.id` claim is redundant there and the order key also covers re-delivery under a
>    different event id, the ADR 0279 lesson).

### Data model (host-ext KV `DurableCollection`s, no SQL migration — the ADR 0383 lane)

| Store | Key | Shape (fields) |
|---|---|---|
| `commerce-connect:seller` | `tenantId` (+ reverse index by Connect account id) | `{ tenantId, stripeAccountId, onboardingState: 'none'|'pending'|'restricted'|'enabled'|'deauthorized', chargesEnabled, payoutsEnabled, region (ISO country), capabilities[], createdAt, updatedAt }` |
| `commerce-connect:paid-listing` | `(packName)` | pricing metadata **extending** the marketplace `Listing`: `{ packName, sellerTenantId, lane: 'free'|'external-link'|'native-paid', priceMajorUnits?, currency?, externalPaymentUrl?, approvalState?: 'draft'|'pending'|'approved'|'rejected', stripePriceId? }` |
| `commerce-connect:order` | `orderId` | `{ orderId, buyerTenantId, sellerTenantId, packName, amountMajorUnits, currency, applicationFeeMajorUnits, stripePaymentIntentId, stripeChargeId, stripeTransferId?, status: 'pending'|'paid'|'refunded'|'disputed'|'failed', idempotencyKey, createdAt }` |
| `commerce-connect:fee-config` | `('__global__' or tenantId)` | `{ applicationFeePct }` — operator config, **clamped 10–15%** (fail-closed to the operator default; never a seller-supplied fee) |
| `commerce-connect:dispute` | `(disputeId)` | `{ disputeId, orderId, sellerTenantId, amountMajorUnits, reason, status, reverseTransferId?, platformLossMajorUnits, createdAt }` — the **platform-loss ledger** (destination-charge liability lands on the platform) |
| `commerce-connect:webhook-event` (optional) | purchase-level key | only if the handler needs charge/dispute-level dedup beyond billing's `event.id` claim |

Purchase/refund idempotency keys are **deterministic** (`orderId` derived from
buyer+pack+priceId, not a random uuid) so a fork/replay produces the same key — see § Replay.
Money is MAJOR-unit `number` app-side; `toStripeMinorUnits` (`stripeApi.ts:129`) converts
only at the Stripe boundary (the ADR 0383/commerce convention).

### Feature Evaluation Matrix

| # | Axis | Ruling |
|---|---|---|
| 1 | **Feature-package wiring** | NEW `features/commerce-connect/` appended to `BACKEND_FEATURES` (`features/index.ts:156`) + `FRONTEND_FEATURES`, zero core edits. Adds one seam to billing (`connectEventHook.ts`) and one extension to `marketplace/listingService.ts` (optional pricing on the projection) — both dependency-inversion / additive, no upward import. |
| 2 | **Toggle** | `commerce-connect`, default **OFF**, `category: 'Admin'`, `salt: 'commerce-connect'`. **`bucketUnit: tenant`** — justified per **ADR 0015** (workspace-as-tenant): a Connect seller account, its payouts, and its purchase liability are per-**tenant** commercial facts (mirrors `billing`'s `bucketUnit: tenant`, `features/billing/feature.ts:35`); a per-user or per-instance bucket would mis-scope money movement. Toggle OFF ⇒ no routes, no seam registration, byte-identical. |
| 3 | **`ctx.commerceConnect` workflow surface** | **Read-plus-scoped-write, advertised at `/.well-known/openwop`.** READS: `sellerAccount` (own onboarding/payout state), `listPaidListings`, `getOrder`. WRITE: `createCheckout(packName)` (a buyer starts a destination-charge purchase — money-movement, so gated + idempotent). **Excluded from the surface:** account onboarding (returns a Stripe-hosted `account_link` URL — a human step, not a workflow write), approval decisions (operator HITL only), and refunds (privileged). |
| 4 | **Node pack `feature.commerce-connect.nodes`** | **Minimal v1 — one read node**, `feature.commerce-connect.nodes.seller-stats` (own seller onboarding + payout + recent-order-count read, RBAC-shared with its route). **Purchase/onboarding/refund/approval are deliberately NOT nodes** (money movement + human gates = privileged REST, mirroring ADR 0022's "install is not a node"). A `create-checkout` node is **deferred** until there's a demonstrated workflow-driven-purchase use case. |
| 5 | **Envelopes** | **None v1.** No in-run structured model→app intent here — purchases are user/HTTP-initiated and human-gated, not model-authored durable intent. A new envelope kind would require an OpenWOP RFC (CLAUDE.md), and none is warranted. |
| 6 | **Agent pack** | **None v1.** No persona needs to *drive* selling; the marketplace recommender agent (ADR 0022 `feature.marketplace.agents.recommender`) already suggests packs and is read-only. Revisit only if a "sell your pack" guided flow is chartered. |
| 7 | **Public surface** | Purchase RIDES the **existing storefront/funnel checkout precedent** — no new bespoke checkout page. The one genuinely public route is the **Stripe Checkout return lane** (`GET .../commerce-connect/return?session_id=…` success/cancel, added to `PUBLIC_PATH_PREFIXES` like `billing/webhook`); fulfilment itself rides the **webhook** (`checkout.session.completed`/`charge.succeeded`), never the return redirect (the ADR 0176 fulfilment discipline). External-link listings are a plain outbound link — no openwop money path at all. |
| 8 | **RBAC** | Fail-closed, three separated authorities: **(a) seller** ops (onboarding, price editor, own dashboard) = `authorizeOrgScope` `workspace:write` on the seller's own tenant, IDOR-guarded; **(b) buyer** purchase = `workspace:write` on the buyer tenant + `resolveEntitlements` delivery check; **(c) operator approval** of native-paid sellers + fee-config = **`requireSuperadmin`** (mirrors marketplace install authority, ADR 0022 `:172`). The approver is NEVER the seller (separation of duties). Payout figures are seller-scoped (a seller sees only their own). |
| 9 | **Replay / fork** | Webhook idempotency reuses billing's `event.id` CAS claim + adds purchase-level dedup on `payment_intent`/`charge` id (ADR 0279 lesson). `orderId` + Stripe `Idempotency-Key` are **deterministic** (buyer+pack+priceId hash), so a `:fork`/replay of the purchase workflow yields the same key → Stripe de-dupes the charge; no double-charge, no double-fulfil, no double-credit. Dispute/refund apply CAS-guarded on the dispute/refund id. |
| 10 | **Frontend** | `features/commerce-connect/` (nav-gated on the toggle): **seller onboarding** (start → Stripe-hosted `account_link` redirect → return → state chip), **seller dashboard** (onboarding/charges/payouts state, recent orders, payout summary — read-only, seller-scoped), **listing price editor** (lane picker free/external-link/native-paid + price/currency, native-paid submits to the approval queue), **operator approval queue** (superadmin: pending native-paid sellers/listings → approve/reject), **buyer purchase** affordance on a paid listing. Full 4-locale i18n (the `check-i18n` gate is FATAL); plain `ui/` inputs (no ProductForm machinery). |

---

## Phased plan

**Phase 0 — MyndHyve continuity importer (on the critical path IFF live Connect sellers exist).**
An operator, superadmin-only `POST .../commerce-connect/import` that bulk-loads MyndHyve's
existing Connect seller accounts → `commerce-connect:seller` rows with **`stripeAccountId`
preserved verbatim** (id-preserving, mirroring ADR 0176's R-1 importer `billingService.ts:362`
/ `routes.ts:120`). Because the Connect account ids are preserved, existing sellers keep
their onboarding, capabilities, and payout schedule against the *same* Stripe platform
account — no re-onboarding. A one-time data-migration tool over host-ext KV, NOT an app
`APP_MIGRATIONS`/`LATEST_SCHEMA_VERSION` change. Sequenced first only if the live-seller fact
is confirmed; otherwise it lands after Phase 1.

- **Phase 1 — Connect onboarding + account state.** `stripeApi.ts` gains `createStripeConnectAccount`
  (`POST /v1/accounts` type=`express`) + `createStripeAccountLink`; the `commerce-connect:seller`
  store + reverse index; onboarding routes returning the hosted `account_link` URL; the
  `account.updated`/`capability.updated`/`deauthorized` handler branch via `connectEventHook`
  keeping `onboardingState`/`chargesEnabled`/`payoutsEnabled`/`region` current. Region captured
  for the same-region payout restriction. Tests: RBAC, IDOR, demo-mode no-op, webhook
  account-state application, deauthorization.
- **Phase 2 — destination-charge purchase + application fee + purchase webhook.** `stripeApi.ts`
  gains the destination-charge Checkout Session (`application_fee_amount` +
  `transfer_data[destination]` + `on_behalf_of`); fee-config (clamped 10–15%, operator default);
  the `commerce-connect:order` store; deterministic idempotency; the
  `checkout.session.completed`/`charge.succeeded` handler crediting/fulfilling exactly-once;
  same-region guard (buyer/seller region mismatch → route to external-link or reject, never a
  cross-region native charge in v1). Paid-pack **delivery** consults `resolveEntitlements`.
- **Phase 3 — seller dashboard + payouts view.** Seller-scoped read routes + FE dashboard
  (onboarding/charges/payouts state, recent orders, payout summary from `payout.*` events);
  the `feature.commerce-connect.nodes.seller-stats` read node. No money movement.
- **Phase 4 — approval gate + external-link lane on marketplace listings.** Extend
  `marketplace/listingService.ts` with the optional pricing projection + lane; the price editor;
  the operator (superadmin) HITL approval queue for **native-paid** sellers/listings (free +
  external-link lanes ship ungated per §1's Notion model); native-paid purchase is *enabled*
  only once approved. Fail-closed: unapproved native-paid = not purchasable.
- **Phase 5 — refunds / disputes policy + admin.** `createStripeRefund` extended with
  `reverse_transfer` (recover the seller's share on refund, best-effort); the
  `charge.dispute.{created,closed}` handler → `commerce-connect:dispute` platform-loss ledger
  (destination-charge liability lands on the platform — budget it, surface it to the operator);
  an admin dispute/refund console. Explicit v1 policy recorded: platform budgets
  refunds/chargebacks; creator recovery is best-effort `reverse_transfer`.

---

## Alternatives weighed

1. **Merchant-of-record (Paddle / Lemon Squeezy).** **Rejected** per `docs/steward/MYNDHYVE-DECISIONS.md`
   §1: no studied best-in-class marketplace outsources to an MoR; the dominant architecture is
   the platform as its own marketplace facilitator on Stripe rails (Figma/Notion both on
   Stripe), and openwop-app *already* runs Stripe billing (ADR 0176) — Connect is the only
   coherent choice. An MoR would also fracture the day-1 continuity story (a second payment
   processor alongside the existing Stripe account).
2. **Stripe direct charges (charge on the connected account, `application_fee` back to
   platform).** Rejected for v1: direct charges put the connected account as merchant-of-record
   for the charge and shift more compliance/PCI surface to the seller; §1 explicitly recommends
   **destination charges** (platform creates the charge, keeps the fee, transfers the
   remainder) as Stripe's recommended mechanic for Express-style accounts. The liability
   trade-off (platform eats fees/refunds/disputes) is accepted and budgeted (Phase 5).
3. **A separate Stripe platform account for the marketplace.** Rejected: it would orphan the
   existing billing account + break the id-preserving continuity path. One Stripe account, one
   BYOK key ref (`billing:stripe-key`), Connect layered on top.
4. **A second public `/commerce-connect/webhook` endpoint with its own signing secret.**
   Rejected (see § Decision): duplicates the raw-body HMAC verify + dedup ledger that ADR 0176
   made a single owner. Reuse billing's endpoint + a registered handler.
5. **A parallel paid-catalog store instead of extending `marketplace/listingService`.**
   Rejected: `Listing` is already a computed projection (ADR 0022); a second catalog would
   drift from install/review state. Extend the projection with optional pricing.

**MyndHyve-continuity note.** Existing MyndHyve Connect sellers migrate **id-preserving**,
mirroring ADR 0176's R-1 importer (§Phase 0). Every `stripeAccountId` carries over verbatim
against the *same* Stripe platform account, so sellers keep onboarding, capabilities, and
payout schedule with no re-onboarding — the direct Connect analogue of the billing cutover.

---

## Open questions

1. **Live Connect-seller inventory (sequencing).** Does MyndHyve have live Connect sellers
   today? Confirms P0-with-Phase-0-first vs P1/P2. Business fact owed by David
   (`docs/steward/MYNDHYVE-DECISIONS.md:9`); architecture is unchanged either way.
2. **Final platform application fee %.** §1 bounds it 10–15%; pick the exact figure (Notion 8%,
   Figma 15% are the anchors) and clamp `fee-config` to it. Operator-configurable within bounds.
3. **International / cross-region expansion.** v1 restricts native paid selling to same-region
   payout pairs (Stripe's destination-charge guidance) and routes the rest to external links;
   revisit multi-region payouts (Figma/Notion country lists) as a later phase
   (`docs/steward/MYNDHYVE-DECISIONS.md` residual Q5).
4. **Paid-pack delivery entitlement check.** Exact seam by which a completed purchase unlocks
   pack *install/delivery* for the buyer — confirm it consults `resolveEntitlements`
   (`billingService.ts:128`) / the install marker, and that a refund/dispute *revokes* delivery.
5. **Managed-key vs BYOK for the seller's own Stripe.** N/A for v1 — sellers are Connect
   *connected accounts* under the platform's one Stripe key, not BYOK-Stripe merchants.

---

## Implementation record

| Phase | Landed | Notes |
|---|---|---|
| 1 — Connect onboarding + account state | branch `feat/adr-0385-commerce-connect` | `billing/connectEventHook.ts` seam + dual-secret webhook verify; `stripeApi` gains `createStripeConnectAccount`/`createStripeAccountLink`/`getStripeConnectAccount`; `commerce-connect` package (seller store + keyed reverse index + CAS-claimed onboarding + own event dedup ledger + routes + `ctx.commerceConnect.sellerAccount` read); FE onboarding page (4 locales); route+handler tests (`test/commerce-connect.test.ts`). |
| 2 — destination-charge purchase | branch `feat/adr-0385-commerce-connect` | `createStripeConnectCheckoutSession` (application fee + `transfer_data[destination]` + `on_behalf_of`); `paid-listing`/`order`/`order-by-seller`/`fee-config` stores; deterministic `cco_` orderId (one license per buyer+pack) + CAS `pending→paid` fulfilment with amount/currency verification + async-payment guard; fee clamped 10–15% (default 12, superadmin config); platform↔seller region guard; purchase/browse/orders routes + fee-config admin routes; surface gains `listPaidListings`/`getOrder`/`createCheckout`. Ops note: the billing Stripe endpoint registration must subscribe `checkout.session.completed` + `payment_intent.succeeded`; the `connect=true` registration subscribes account/capability/payout events. |
| 3 — seller dashboard + payouts + node | branch `feat/adr-0385-commerce-connect` | `commerce-connect:payout` store (seller-tenant-indexed; payout.{paid,failed} recorded under the money-truth rule — applied even toggle-off, like purchases); `sellerStats` aggregate (state + per-currency gross/fees + recent payouts) on service/route/surface; FE dashboard cards; `packs/feature.commerce-connect.nodes` v1.0.0 (`seller-stats` read node over the surface) + requiredPacks pin. |
| 4 — approval gate + marketplace lanes | branch `feat/adr-0385-commerce-connect` | Marketplace-owned `listingPricingHook` (commerce-connect registers the provider; marketplace never imports upward) annotates `/listings` with `pricing` per viewer; seller listing editor (`PUT /listings/:packName`, own-listings read) + superadmin approval queue routes; FE: marketplace price/lane chips + Buy/external-link affordances, seller editor + 403-hidden approval queue. **Delivery deferral (resolves open question 4):** pack install is HOST-WIDE superadmin (ADR 0022), so v1 delivery = the `hasPaidOrder` license record surfaced as `pricing.purchased`; a per-tenant install/delivery gate needs org-scoped install (named deferral). `resolveEntitlements` does not model marketplace purchases today — consulting it would be a silent no-op, so no fake gate was wired. |
| 5 — refunds/disputes + admin console | branch `feat/adr-0385-commerce-connect` | `createStripeRefund` gains `reverse_transfer`; superadmin refund route (order flips on the charge.refunded WEBHOOK — fulfilment discipline; demo flips immediately); `commerce-connect:dispute` platform-loss ledger + `order-by-intent` index (Dispute objects carry no metadata); status machine paid→disputed→paid/lost, all CAS; operator console FE (orders + refund + dispute ledger + realized-loss total, 403-hidden). v1 policy recorded: platform budgets refunds/chargebacks, creator recovery = best-effort reverse_transfer (never silently retried without reversal). |
| 0 — importer | branch `feat/adr-0385-commerce-connect` | `POST /import` (superadmin) bulk-loads sellers, `stripeAccountId` VERBATIM + reverse-index rows (ADR 0176 R-1 semantics); sequenced after Phase 1 per § Open questions 1. |

## Data dispositions (grade-data pass, 2026-07-17 — the ADR 0288 taxonomy)

- **TOLERATE ON READ (historical money provenance):** a buyer's `commerce-connect:order`
  outlives the seller tenant's teardown (a money record belongs to the payer), and the
  seller-side/intent index markers may briefly dangle after a buyer teardown — every read
  path drops null gets and logs. Never "cleaned up": deleting money history is the bug.
- **DELIBERATELY UNPURGED:** `commerce-connect:webhook-event` adopts billing's ADR 0380
  ledger posture verbatim (retention would reopen the Stripe-redelivery replay window;
  rows are tiny; the claim precedes tenant resolution so no tenant index fits).
- Full edge map + probes: `docs/DATA-ASSESSMENT-adr0385-0392-batch.md`.

## RFC verdict

**Host work only — no OpenWOP wire change, no RFC.** All routes live under
`/v1/host/openwop-app/commerce-connect/*` (host-extension, non-normative — CLAUDE.md "Host
extension routes … never touch the wire"). No new run-event field, capability flag, event
type, endpoint contract, or normative `MUST`; no new RFC 0021 envelope kind (§ matrix row 5);
Stripe Connect is operator-private commercial policy driven host-side through BYOK — exactly
the posture ADR 0176 and ADR 0022 established for billing and the pack marketplace. Verified
against the CLAUDE.md RFC-gate: nothing here advertises a capability whose RFC isn't accepted,
so `OPENWOP_REQUIRE_BEHAVIOR=true` is unaffected.

## /prd five-architect compatibility pass

| Architect | Verdict |
|---|---|
| **Spec** | No new wire vocabulary. Connect/seller/purchase are operator-private commercial policy under `/v1/host/openwop-app/*`; no capability handshake change. **N/A.** |
| **Schema** | No new/changed wire schema. Seller/order/dispute/paid-listing are host-private KV stores; the Stripe Connect webhook rides billing's existing inbound endpoint (no new wire). |
| **Security** | One Stripe key + one webhook signing secret (billing's, BYOK); Connect events verified by the same raw-body HMAC + `event.id` CAS; seller/buyer routes RBAC + IDOR-guarded; approval + fee-config superadmin-gated (separation of duties); no new public attack surface beyond the Checkout return redirect. |
| **Conformance** | Nothing advertised → no scenario. `OPENWOP_REQUIRE_BEHAVIOR` unaffected. |
| **Compatibility** | Additive (new package, toggle OFF, demo-mode ⇒ byte-identical when off/unconfigured). The continuity importer is a one-time operator data-migration tool over host-ext KV (no migration-integrity-gate impact) and re-creates nothing in Stripe. Blast radius contained by composing billing's Stripe client + webhook + marketplace's listing projection rather than forking any. |
