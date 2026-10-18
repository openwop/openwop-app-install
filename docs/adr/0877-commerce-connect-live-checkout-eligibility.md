# ADR 0877 — commerce-connect: who may take live money, and on whose account

Status: implemented (2026-10-12, feature-loop row 38)

Feature-loop round 2, row 38 (`commerce-connect`: Stripe Connect seller
marketplace). Extends ADR 0385 (Connect marketplace), ADR 0576 (seller binding),
ADR 0575 (gate classes); resolves the open product question ADR 0875 left for this
row. Host-extension only (`/v1/host/openwop-app/*`): no wire change, no RFC.

## Context

Since 2026-10-06 the platform Stripe key (`billing:stripe-key`) is live. ADR 0875
D7 made `liveStripeKeyFor(tenantId)` the ONE resolver for "may this storefront take
live money", and it refuses only `anon:` tenants. So every signed-in tenant's public
storefront opens live Checkout sessions on the operator's own Stripe account. That
holds for the quote-accept checkout, the one-click off-session charge and product
subscriptions too. The operator is then merchant of record for every tenant's
sales: chargebacks and disputes land on the operator account, payouts to the
tenant are manual, and processing payments on behalf of unrelated businesses
without Connect is payment facilitation, which Stripe's terms reserve for Connect.

**User decision (2026-10-12, relayed by the orchestrator):** live storefront
checkout on the PLATFORM account is allowed only for the operator's own tenants
(`OPENWOP_SUPERADMIN_TENANTS`) and billing-exempt/demo tenants
(`OPENWOP_BILLING_EXEMPT_TENANTS`). Any other tenant must onboard a Stripe connected
account through Commerce Connect before live checkout. Until then its checkout is
demo-only (no real charge), and the owner sees a clear prompt to connect Stripe. The
platform earns through the Connect application fee.

Prod (read-only, 2026-10-12): no paying team/enterprise tenant, 0 commerce
entitlements, every order demo. Latent today, live the day the first paid tenant
opens a store.

### Grade findings this ADR also closes (row-38 grade, `origin/main` @ `1add18177`)

| # | Finding | Where | Class |
|---|---|---|---|
| F1 | Any signed-in non-operator tenant's storefront charges land on the platform account (4 lanes) | `commerce/routes.ts` public checkout, quote accept, one-click; `subscriptions.ts` | merchant-of-record / ToS |
| F2 | A seller row minted in DEMO mode (keyless era) resumes as demo forever once the key is live; that tenant can never reach a live Connect account | `onboarding.ts` `startOnboarding` resume branch | stuck state |
| F3 | The workflow surface's `createCheckout` (a money-opening write) has no role floor: a run acting for a Viewer starts a purchase the HTTP door refuses to a Viewer | `commerce-connect/feature.ts` surface; `featureSurfaces.ts` policy | role floor on the node lane |
| F4 | The surface `createCheckout` returns the buyer to `/commerce-connect` (the seller-onboarding page), the MKT-UX-2 defect the route fixed and the surface did not | `feature.ts:90-91` | UX / copy drift |
| F5 | `reconcileSellerBindings` docblock says "Invoked from the daily sweep"; nothing calls it (WF-MKT-14, re-measured: still 0 production callers) | `adminOps.ts:204-208` | claim without code |
| F6 | A native-paid listing price is not quantized to the currency minor unit and has no upper bound (the ADR 0875 F13 class on this store) | `listings.ts:121` | money hygiene |

## Boundaries audit

- **One Stripe client** stays `features/billing/stripeApi.ts`. The destination-charge
  parameters already exist there for the pack marketplace
  (`createStripeConnectCheckoutSession`, `stripeApi.ts:435`). This ADR adds
  OPTIONAL Connect routing to the two storefront creators
  (`createStripeOrderCheckoutSession`, `createStripeOffSessionPaymentIntent`) and to
  `createStripeSubscription`. No second client, no second webhook.
- **One seller row** per tenant (`commerce-connect:seller`, `stores.ts:58`). The
  storefront does not get its own Connect account: a tenant that sells packs and
  products has one connected account, as `kicktodo-commerce/sellerRequestService.ts`
  already assumes.
- **One live-key resolver for SETTLEMENT** stays `liveStripeKeyFor`
  (`commerceService.ts:1276`). It answers "is this host live, so must a payment be
  verified, and with which key do I refund". It is NOT the charge gate any more:
  UCP `/pay` and `/checkout` keep refusing on a live host (ADR 0875 D4), markAsPaid
  keeps verifying, refunds keep using the platform key (destination charges are
  platform charges). Splitting the question is the decision. Reusing one resolver
  for both would make every non-operator tenant's UCP `/pay` settle an unverified
  AP2 mandate as demo on a live host, which is the regression ADR 0875 D4 closed.
- **Feature edges.** `commerce` → `commerce-connect` is a new import edge (one
  module, the resolver). `commerce-connect` imports nothing from `commerce`.
  `kicktodo-commerce` → `commerce-connect` is the precedent. No cycle.
- **Eligibility predicates** already exist: `isListedSuperadminTenant`
  (`host/superadmin.ts:112`, exact env match, NOT the dev-open switch) and
  `isBillingExemptTenant` (`host/planLimitsSeam.ts:91`). The second's docblock
  scopes it to "limits and credits only, never the paywall". This ADR is a third,
  user-sanctioned reader: platform settlement. Its docblock is corrected in the
  same change.

## Decision

**D1 — ONE charge-gate resolver: `resolveStorefrontSettlement(tenantId)`**
(`features/commerce-connect/storefrontSettlement.ts`). It returns exactly one of:

- `{ kind: 'platform', key }`: the platform key resolves AND the tenant is a
  listed superadmin tenant or a billing-exempt tenant AND it is not `anon:`.
- `{ kind: 'connect', key, destinationAccountId, applicationFeePct }`: the platform
  key resolves AND the tenant's seller row is `mode:'live'`,
  `onboardingState:'enabled'`, `chargesEnabled`, a non-empty `stripeAccountId`,
  same region as the platform (the ADR 0385 v1 restriction) AND the tenant's
  `commerce-connect` toggle resolves enabled (`resolveOne`). A tenant whose toggle
  is off is not routed through an account whose state events this host has stopped
  applying.
- `{ kind: 'demo', reason }` with `reason ∈ 'no_key' | 'anon' | 'connect_required' |
  'connect_incomplete' | 'connect_disabled' | 'connect_region'`. The reason is what
  the owner UI renders.

Order of evaluation: no key → `no_key`; `anon:` → `anon` (before anything else, so a
crafted superadmin/exempt list entry cannot grant an anon tenant); platform
eligibility; then Connect. A tenant that is BOTH operator and onboarded seller is
`platform`. The operator's own store is not charged an application fee by itself.

**D2 — every charge-opening lane asks D1, and only D1.** These are the four sites
that open money on Stripe for a storefront (measured by grep of the three creators'
call sites, `commerce/routes.ts:389,587,731` + `subscriptions.ts:120`):

| Lane | `platform` | `connect` | `demo` |
|---|---|---|---|
| Public checkout | as today | session + `payment_intent_data[transfer_data][destination]`, `[on_behalf_of]`, `[application_fee_amount]` | demo branch (order pending, `mode:'demo'`) |
| Quote accept (public) | as today | same Connect params | demo branch |
| One-click (off-session PI) | as today | PI + `transfer_data[destination]`, `on_behalf_of`, `application_fee_amount` | demo child (honestly unpaid) |
| Product subscription | as today | subscription + `transfer_data[destination]`, `on_behalf_of`, `application_fee_percent` | `paymentMode:'demo'` |

The fee is computed **minor units first** (CC-9): `round(chargeMinor × pct / 100)`.
The charge is the server's own order total (goods + tax + shipping), never client
input. `metadata` (orderId/tenantId/orgId) is unchanged, so ADR 0875 D3's intent
binding and the commerce webhook keep working: a destination charge is a PLATFORM
event (no `event.account`). It routes exactly like today's storefront event, not
through the `connectEventHook`.

A **ratchet** pins the creator call-site set: any `src/` file that calls one of the
three creators must import `resolveStorefrontSettlement`, or be the billing plan
checkout (`billingService.ts`, the operator selling its own plans) or the pack
marketplace (`commerce-connect/orders.ts`, already destination-charge). A fifth
lane added later fails CI until it asks D1.

**D3 — refunds of a Connect charge reverse the transfer.** `getStripePaymentIntent`
also returns `transferDestination` (the PI's `transfer_data.destination`), derived
from Stripe and NOT stored on the order. Storing it would need a new `Order` field
that the six node-rebuilding validator allowlists would drop. Both refund exits
(`refundOrder`, `partialRefundOrder`) already re-read the intent
(`assertRefundableIntent`, ADR 0875 H3). When the intent has a destination, the
refund sends `reverse_transfer=true` and `refund_application_fee=true` (Stripe
prorates both on a partial). The seller funds the refund and the platform returns
its fee. Without this, every Connect refund would come out of the operator's
balance while the seller kept the money.

**D4 — a demo-era seller row re-onboards live.** In `startOnboarding`, when the key
now resolves and the stored row is `mode:'demo'`, the demo row and its
`acct_demo_*` binding are replaced through the same live claim (CAS on the demo row
→ claim). A demo row was never a Stripe account, so nothing real is orphaned. The
`acct_demo_*` index row is deleted only if it still points at this tenant. Demo
pack-marketplace orders keep their `mode:'demo'`. Their seller is now live, and a
`demo` order never reaches Stripe (refund lane checks `order.mode`).

**D5 — the surface carries the HTTP door's floor.** `commerce-connect`'s surface
declares `tenantMethodScopes: { createCheckout: 'workspace:write' }` (ADR 0837 D2,
the CRM precedent: the predicate `requireTenantScope` uses). Reads stay at the
seam's default. The surface's checkout return URLs become the route's
(`/marketplace?purchase=…&order=…&pack=…`, F4).

**D6 — owner-facing readiness.** `GET /commerce/orgs/:orgId/payments` (commerce
route, `workspace:read`) returns `{ settlement: 'platform'|'connect'|'demo', reason?,
connectAvailable }`. `connectAvailable` = the tenant's `commerce-connect` toggle
resolves enabled. `CommercePage` renders a `Notice` above the tabs. For demo +
`connect_required|connect_incomplete` it says "Your store takes demo orders only —
no card is charged. Connect a Stripe account to take live payments" and links to
`/commerce-connect` when `connectAvailable`, otherwise "ask your workspace operator
to enable Commerce Connect". `connect` shows an info line naming the
connected-account lane. `platform` and `no_key` show nothing new (`no_key` is the
existing keyless posture). The public storefront already tells a buyer "no card was
charged (demo mode)" on a demo placement. The key never reaches the client.

**D7 — hygiene.** Native-paid listing prices are quantized to the currency minor
unit and capped (`≤ 1,000,000` major units); the currency must be a 3-letter code.
`reconcileSellerBindings`' docblock and ADR 0576's Status line say what is true:
an operator-run check with no scheduler (WF-MKT-14 closed as a claim correction; a
tick remains a follow-up).

## Adversarial `/architect` pass (pre-code, 2026-10-12) — amendments

An independent pass found 0 Blockers, 4 High, 9 Medium and 7 Low. The decision text
above is AMENDED as follows. The original wording is kept so the reasoning trail
survives; where the two disagree, this section wins.

- **H1 — "demo" on a live host made a store that could not work.** `/pay` refused
  every non-`pi_` id once the platform key resolved (`routes.ts:213-218`), and
  `/cycle` refused every subscription. An ineligible tenant's demo orders could
  never be settled. **Amended D2:** a `demo` lane store behaves as it would on a
  KEYLESS host. `/pay` accepts a non-`pi_` (offline/`manual:`) id without Stripe
  verification only when the order's lane is demo. A `pi_` id is still verified
  with the settlement key (ADR 0875 D3 holds). `/cycle` is the demo clock when the
  tenant's lane is demo and the row never touched Stripe. Demo quote accept converts
  as on a keyless host. UCP `/pay` and `/checkout` stay refused on a live host: an
  unverified AP2 mandate is not an offline payment the owner attests to (ADR 0875 D4).
- **H2 — subscription orders carry an `in_` invoice id.** `assertRefundableIntent`
  would GET `/payment_intents/in_…`. **Amended D3:** a refund of an `in_` order is
  refused with a typed 409 `refund_in_stripe` before any Stripe call.
- **H3 — one-click charged a saved card under a different merchant than the buyer
  consented to.** **Amended D2:** the order carries `settlement` (M5). The
  one-click child refuses (the uniform 404) unless the tenant's lane NOW equals the
  parent's (kind and destination). It never falls back to a demo child.
- **H4 — the ratchet was an import check.** **Amended D2:** the three storefront
  creators take a `StorefrontCharge` object that only `resolveStorefrontSettlement`
  mints (a module-private brand), never a bare key. The ratchet pins every
  `stripeApi` money-creator call site by CALL, per creator.
- **M5 — the reason for not storing the lane was wrong.** The validator allowlists
  apply to workflow nodes, not `commerce:order`. **Amended:** the order stamps
  `settlement: { kind, destinationAccountId? }` at creation. Refunds still read the
  destination from Stripe (the source of truth), so a stamped lane can never
  redirect money.
- **M6 / L20 — the billing-exempt list is a limits list.** Implemented as the
  mandate says (superadmin ∪ billing-exempt), with a dedicated override
  `OPENWOP_COMMERCE_PLATFORM_TENANTS`: when set, that list replaces the default.
  Raised to the orchestrator.
- **M7 — the platform check matches the tenant id.** An operator store in a `ws:`
  workspace is not platform-eligible unless that tenant is listed. Stated as an
  operator step; the prod mapping was asked for.
- **M8 — fee on goods only.** Fee = `round(orderTotalMinor × pct / 100)`, where
  `order.total` is goods after discount (tax and shipping excluded), and fee ≤ charge.
- **M9 — refund keeps the fee (pack-lane parity).** `reverse_transfer` only. **D3's
  `refund_application_fee=true` is withdrawn** pending the product call.
- **M10 — Connect storefront disputes were dropped silently.** The dispute handler's
  index miss now logs. The exception-feed row and ledger are a follow-up.
- **M11 — D4 race.** `syncSellerFromStripe` writes by CAS. D4 runs before the resume
  self-heal bind. The `acct_demo_` index delete is an explicit ADR 0576 exception,
  guarded on `=== acct_demo_${tenantId}` and on the index still naming this tenant.
- **M12** — storefront Connect sessions/PIs carry no `ccOrderId` (asserted), so
  they never route to the pack-marketplace handler.
- **M13** — matrix row 9's "idempotency keys are deterministic per order" was false
  for sessions. The Connect variants pass `storefront:<orderId>` keys; the row is
  corrected below.
- **L14** — D1 also requires a non-empty `region`, the `transfers` and
  `card_payments` capabilities, and maps a `mode:'demo'` seller to
  `connect_required`. **D8 (new):** `createStripeConnectAccount` requests both
  capabilities (it requested none, so `on_behalf_of` could not work).
- **L15** — D1 uses `resolveOne` (toggle + plan) on purpose: a lapsed plan falls to
  demo, the no-charge direction.
- **L16** — the surface floor's "no person ⇒ no check" is acceptable for
  `createCheckout`: it mints a hosted session; nothing is charged until a person
  enters a card.
- **L17** — a reverse transfer against a deleted/rejected account fails at Stripe
  and releases the claim. Operator path: refund in Stripe, record the loss.
- **L18** — platform-lane product subscriptions created since 2026-10-06 keep
  billing on the platform. The prod count was asked for; no migration in this ADR.

Corrected matrix row 9: replay never re-opens a checkout (no node opens one). The
Connect session/PI/subscription creates carry deterministic `storefront:` keys; the
platform-lane session create keeps its pre-existing (key-less) shape.

## User decisions (2026-10-12, relayed by the orchestrator) — these SUPERSEDE the defaults above

The open questions were answered after the first implementation. Where the text above
disagrees, this section wins; the original wording is kept as the reasoning trail.

- **Q1 — a SEPARATE storefront application fee.** Clamp 0–15%, default **2%**, per-tenant
  operator override, stored in the existing `commerce-connect:fee-config` namespace under a
  `storefront:` key (the tenant index strips the prefix, so teardown still reclaims an
  override). Read/written by the superadmin `…/fee-config` route with `lane:'storefront'`.
  The marketplace pack fee (10–15%, default 12%) is **unchanged**. (Supersedes the open
  question "reuse the commerce-connect fee config".)
- **Q3 (FINAL) — explicit lists only.** Platform-lane eligibility =
  `OPENWOP_SUPERADMIN_TENANTS` ∪ `OPENWOP_COMMERCE_PLATFORM_TENANTS`. The billing-exempt
  list **does not** grant live checkout: lifting billing limits must never make the operator
  merchant of record. Exempt and conformance tenants are demo unless explicitly listed.
  Pinned by "Q3 — a billing-exempt but UNLISTED tenant gets demo" (sabotage-witnessed). The
  rule is the one `return` line of `isPlatformSettlementTenant`. (Supersedes D1's "or a
  billing-exempt tenant", architect M6's "replaces the default", and the
  `isBillingExemptTenant` docblock edit, now reverted to "never a settlement reader".)
- **Q5 — the platform refunds its fee.** A Connect storefront refund sends
  `reverse_transfer=true` AND `refund_application_fee=true`, so Stripe returns the
  application fee proportionally on a partial refund. **Divergence, recorded:** the pack
  marketplace's operator refund (`adminOps.ts` `refundOrder`) keeps `reverse_transfer` only
  and is unchanged. (Supersedes architect M9 / "fee kept, pack-lane parity".)
- **Prod facts (read-only, rev 00941):** 0 `commerce-connect:seller` rows. Store data in
  three tenants only: the operator (`OPENWOP_SUPERADMIN_TENANTS`, stays platform), one
  `user:` tenant with July demo orders (becomes demo) and `demo-ucp-merchant` (becomes
  demo). 5 product subscriptions, all the operator's, none with a `stripeSubscriptionId`.
  So L18's residue is empty today, and D4's stuck-demo-seller case has zero exposure (fixed
  anyway).

## Alternatives weighed

1. **Platform-only for operators, everyone else demo, no Connect routing on the
   storefront.** Smallest change, but then onboarding Connect would change nothing
   for a storefront, which contradicts "must onboard … before live checkout" and the
   fee lane. Rejected.
2. **Direct charges** (`Stripe-Account` header, the connected account is the
   merchant and bears fees/disputes). It moves the most liability off the operator,
   but Stripe recommends destination charges for Express accounts. It would need the
   saved payment method and customer cloned onto every connected account (breaking
   ADR 0296 one-click), and the commerce webhook would need Connect-endpoint routing
   for storefront events. Rejected for v1. Destination + `on_behalf_of` makes the
   connected account the settlement merchant (statement descriptor, merchant of
   record), and the reverse transfer recovers refunds. **Residual stated:** dispute
   losses on a destination charge debit the platform balance first. Recovery from
   the seller is a manual transfer reversal (the ADR 0385 platform-loss posture). It
   is recorded in Open questions, not hidden.
3. **Keep one resolver (`liveStripeKeyFor`) and make it return null for ineligible
   tenants.** Rejected: it doubles as the settlement/verification key, so UCP `/pay`
   would demo-settle unverified mandates on a live host and markAsPaid would skip
   verification (the ADR 0875 D3/D4 regressions). See Boundaries.
4. **Store the destination on the order.** Rejected (D3): the Stripe intent is the
   source of truth, and a new `Order` field is at risk from the validator allowlists.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Code in `features/commerce-connect/` (resolver, onboarding) and `features/commerce/` (lanes, readiness route, page). No core route/nav edits. New edge commerce → commerce-connect (one module). |
| 2 | Toggle | No new toggle. `commerce-connect` (default off, tenant bucket) now ALSO gates the storefront's Connect lane. The operator must enable it for selling tenants (operator step). |
| 3 | Workflow surface | `commerce-connect.createCheckout` gets a write floor (D5). The `commerce` surface opens no Stripe money (`createOrder` creates a pending order only); asserted by the D2 ratchet. |
| 4 | Node pack | No change. `feature.commerce-connect.nodes` stays read-only (`seller-stats`). |
| 5 | AI chat / envelopes | None. No commerce chat tool opens a checkout (asserted by the D2 ratchet). |
| 6 | Agent pack | None. |
| 7 | Public surface | Public checkout / quote accept / one-click change their SETTLEMENT only. Tenant is still derived from the org. No new public route. |
| 8 | RBAC | Readiness route is `workspace:read`. Onboarding stays `workspace:write`. Surface floor D5. |
| 9 | Replay / fork | Unchanged. The Stripe idempotency keys are deterministic per order. A replayed run never re-opens a checkout (no node opens one). |
| 10 | Frontend | `CommercePage` readiness `Notice` (D6), 4-locale i18n, `ui/Notice`. |

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 resolver + D2 four lanes + ratchet | `test/adr0877-live-checkout-eligibility.test.ts`, RED first on `main`: a non-operator tenant's public checkout opens a session with no `transfer_data` |
| P2 | D3 refunds reverse the transfer | same file (mock Stripe records `reverse_transfer`) |
| P3 | D4 demo→live re-onboard; D5 surface floor + URLs; D7 | same file + `commerce-connect-*` suites |
| P4 | D6 readiness route + page notice | route test + frontend test |

Existing live-lane suites (`adr0875-commerce-trust-*`, `commerce-one-click`,
`stripe-live-payments`) list their shops in `OPENWOP_COMMERCE_PLATFORM_TENANTS` (Q3). They test
platform-lane behaviour, which is now an operator-only lane.

## Open questions

- [ ] Storefront application fee: this ADR reuses the commerce-connect fee config
      (per-tenant override → global → 12%, clamped 10–15%). A storefront-specific
      fee (lower clamp) is a product call, raised to the orchestrator.
- [ ] Dispute liability on destination charges (Alternative 2 residual): the
      commerce storefront has no Connect dispute ledger. A lost dispute on a Connect
      storefront charge is a platform loss recovered by hand. Follow-up: route
      storefront disputes into the ADR 0385 dispute/loss ledger.
- [ ] Account state events stay toggle-gated (the CLAUDE.md invariant). A tenant
      that turns `commerce-connect` off falls back to demo (D1), so a stale
      `chargesEnabled` cannot route money. Turning it back on resumes from stale
      state until the next `account.updated` or `/seller/sync`.
- [ ] `reconcileSellerBindings` on a daemon tick (WF-MKT-14 residue).

## Implementation record (2026-10-12, `feat/fl2-38-commerce-connect`)

| Decision | Change | Witness |
|---|---|---|
| D1 | `commerce-connect/storefrontSettlement.ts` `resolveStorefrontSettlement` / `isPlatformSettlementTenant` | `adr0877-live-checkout-eligibility` (RED on `1add18177`: 12 of 16) |
| D2 | `StorefrontCharge` brand in `stripeApi.ts`. Four lanes re-wired (`commerce/routes.ts` public checkout, quote accept, one-click; `subscriptions.ts`). Orders stamped `settlement` | same file. `adr0877-charge-gate-ratchet` (per-creator call pins + mint pin) |
| D3 | `transferDestination` on the PI read. `reverse_transfer` on both refund exits. `in_` → 409 `refund_in_stripe` | same file (full + partial + `in_`) |
| D4 | demo row → live claim. Guarded `acct_demo_` index delete. Sync writes by CAS. In-flight claim refused (CC2CD-1) | same file |
| D5 | `orgPolicy.tenantMethodScopes.createCheckout`. Return URLs | `adr0877-connect-surface-floor` |
| D6 | `GET /commerce/orgs/:org/payments`. `PaymentsNotice`. Connect-page store-owner journey | `paymentsNotice.test.tsx`, `demoUpgrade.test.tsx` |
| D7 | listing price quantize/cap/≥0. Claim corrections (adminOps, ADR 0576) | `commerce-connect-*` suites |
| D8 | Express accounts request `card_payments` + `transfers` | same file (D4 case) |
| H1 | demo-lane `/pay` accepts offline ids; `/cycle` is the demo clock on the demo lane | same file |

Sabotage-witnessed: deleting the platform-eligibility check reds 11 cases.
Removing the surface policy reds the floor test. Disabling the superseded-account
guard reds its case.

User decisions Q1/Q3/Q5 landed in `1a1691229` (storefront fee config, explicit
platform list, fee returned on refund), with tests.

Grade passes (independent): grade-code B+ (0 Blocker / 0 High; 10 of 15 folded),
grade-ux C → B+ (1 Blocker + 2 High folded), grade-workflows B → A−. The open items
are in the trackers (`CC2CD-4/5/7/11/14`, `CC2UX-7/10..13`, `CC2WF-3`, `WF-MKT-15`).

### Operator steps (ship day)

1. Platform-eligible tenants are matched by EXACT tenant id. If the operator's own
   store lives in a `ws:`/`org:` workspace, add that tenant id to
   `OPENWOP_SUPERADMIN_TENANTS` or `OPENWOP_COMMERCE_PLATFORM_TENANTS`. Otherwise
   that store turns demo.
2. (Q3) Billing-exempt tenants are NOT platform merchants. List any tenant beyond
   the superadmin one that must take live money on the platform account in
   `OPENWOP_COMMERCE_PLATFORM_TENANTS`. As of rev 00941 none is needed: the
   operator's store is in its superadmin tenant.
3. Turn `commerce-connect` on for any tenant that should be able to take live
   payments. Each such tenant onboards from `/commerce-connect`.
4. The Stripe Connect platform profile must allow Express accounts with the
   `card_payments` + `transfers` capabilities (D8 now requests them).
