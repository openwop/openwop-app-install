# ADR 0419 — Paid feature bundles: platform→tenant bundle entitlements over the ADR 0176 billing rail

Status: Implemented (2026-07-18) — Phases 1–3 + Phase 4-A landed; Phase 4-B
(public marketing pricing read) deliberately deferred (see the Phases table).

## Context

ADR 0366 Phase 4 classified every feature into a bundle catalog
(`distributions/bundles.json`) and the `/marketplace/bundles` shop renders it —
but that shop's job is **white-label BUILD composition**: an operator ticks
bundles and EXPORTS a distribution manifest (a JSON list of feature ids) that
becomes a real, slimmer artifact only via a repo PR + the gated
`gen-distribution` pipeline (the ADR 0366 P3 "no write twin" ruling).

The product owner wants to also **sell premium feature bundles to the platform's
customers** (owner decisions, 2026-07-18): the buyer is a **tenant** in the
hosted app; the lane is **platform Stripe (`billing`)**; and the model is a
**runtime entitlement** — paying turns the bundle's features ON in that tenant's
workspace, it is not a manifest download.

**The load-bearing honesty point.** In the hosted app every first-party feature
is already compiled in — ADR 0366's premise is that toggles/entitlements gate
*behaviour*, and distributions exist only to produce slimmer *self-built*
artifacts. So "pay to download the manifest" would gate a build recipe anyone
could hand-write — not a paywall. The real, enforceable paywall is the **ADR
0176 entitlement gate** (`requireEntitledFeature`), which already exists and is
the opt-in seam ADR 0385 §Implementation explicitly names as the extension point
(`resolveEntitlements` "does not model marketplace purchases today").

This ADR therefore adds a **tenant-facing bundle store** that rides the existing
billing + entitlement rails, sharing the ADR 0366 catalog data. It does NOT
touch the white-label composer, `commerce-connect`, or the wire.

## Pre-existing-surface audit (what we REUSE, never duplicate)

| Concept | Single owner (reused) | Extension |
|---|---|---|
| Stripe client + webhook + money-truth CAS + per-event idempotency | `features/billing/{stripeApi,billingService}.ts` — ONE client, ONE `…/billing/webhook`, `seenEvents` ledger | a new webhook BRANCH, no new client/route |
| Checkout session | `createStripeCheckoutSession(input:{priceId,mode,successUrl,cancelUrl})` + `POST …/billing/checkout` | a thin bundle-checkout route that resolves the CONFIGURED priceId server-side |
| Entitlements (plan → `allowedFeatures`) | `billingService.resolveEntitlements` + `entitlementGuard.requireEntitledFeature` (ADR 0176) | UNION purchased-bundle featureIds into `allowedFeatures` |
| Price catalog (operator config, no baked prices) | `planPriceMap` / `tokenPackMap` (`OPENWOP_BILLING_*_PRICES`) | `OPENWOP_BILLING_BUNDLE_PRICES = {priceId: bundleId}` |
| Honest-when-unconfigured pricing display | `PlanDisplay` / `/public/pricing` (ADR 0391) | a bundle-price display read (never fabricates a figure) |
| One-time purchase → durable grant precedent | token packs (`checkout.session.completed` → credit balance) | one-time-unlock variant of a bundle entitlement |
| Bundle catalog (id → featureIds, labels) | `features/marketplace/bundleCatalog.ts` (ADR 0366) | its raw `bundles.json` read is EXTRACTED to a host helper so billing can resolve bundle→featureIds without importing marketplace |

No second Stripe client, webhook, money model, or entitlement system is created.
The concept "which features is this tenant entitled to" stays owned by
`resolveEntitlements`; "the bundle catalog" stays owned by marketplace.

## Decision

Sell bundles as **platform→tenant entitlements** on the billing rail.

1. **Bundle→price = operator config.** `OPENWOP_BILLING_BUNDLE_PRICES`
   (`{stripePriceId: bundleId}`), mirroring `planPriceMap`. Money lives ONLY in
   operator config — never in the checked-in `bundles.json`, never on a row,
   never logged. A bundle with **no configured price is NOT for sale** (it is a
   free/included grouping) — honest-when-unconfigured (mirrors ADR 0391: never
   show a fabricated figure).

2. **New store `billing:bundle-entitlement`**, keyed `(tenantId, bundleId)` —
   `{ tenantId, bundleId, status: 'active'|'canceled', stripeSubscriptionId?,
   oneTimePaid?, updatedAt }`. A per-tenant grant of one bundle. Tenant-scoped
   `DurableCollection`, same shape discipline as `Subscription`.

3. **`resolveEntitlements` unions** the tenant's ACTIVE bundle entitlements'
   featureIds into `allowedFeatures` (alongside `planFeatures(plan)`). Bundle→
   featureIds is resolved via the new **host helper** `host/featureBundles.ts`
   (raw `distributions/bundles.json` read), so `billing` does NOT import
   `marketplace` (ADR 0001 boundary; the same helper backs
   `marketplace/bundleCatalog.ts`). When billing is off, `allowedFeatures` stays
   `'*'` — unchanged fail-open.

4. **Webhook branch.** `processStripeEvent` gains a bundle branch: on
   `customer.subscription.*` / `checkout.session.completed` where
   `priceId → bundleId`, activate the bundle entitlement; on
   `customer.subscription.deleted`/`canceled`, deactivate. Money-truth: the
   entitlement flips only on the verified paid event (CAS), never on the checkout
   API response; idempotent via the existing `seenEvents` ledger; tenant from
   `metadata.tenantId`.

5. **Bundle checkout route.** `POST …/billing/bundles/:bundleId/checkout` — the
   client passes a **bundleId, never a priceId** (server resolves the CONFIGURED
   price → no arbitrary-price / entitlement-injection), sets
   `metadata.{tenantId,bundleId}`, and reuses `createStripeCheckoutSession`
   (`mode:'subscription'` recurring add-on; `'payment'` one-time is a config
   option). Returns the Stripe URL; fulfilment rides the webhook.

6. **Enforcement = the real paywall.** Each **for-sale** bundle's premium
   feature routes adopt `requireEntitledFeature(req, '<featureId>')` at the
   feature's ONE shared authz choke (the `commerce` precedent — one line in the
   feature's `authz`/`authorizeOrgScope` wrapper, NOT per-route, NOT fanned into
   `requireFeatureEnabled` — ADR 0176's anti-blast-radius design). Free/core
   features never gate. Fail-open until an operator narrows `PLAN_FEATURES`
   (`resolveEntitlements ⇒ '*'`), so adoption is a safe no-op until configured.

   **The `priced ⟹ gated` invariant (architect CRITICAL).** A bundle is a
   DISHONEST paywall if it is priced (`OPENWOP_BILLING_BUNDLE_PRICES`) while its
   features are NOT `requireEntitledFeature`-gated — buyers pay but non-buyers get
   the features anyway. Therefore: **an operator MUST NOT price a bundle until all
   its features gate.** Adoption is phased (one line per feature's authz choke);
   a bundle becomes sellable only once its whole feature set is gated. P3 gated
   `analytics` + `email` (single-choke); **R2 (2026-07-18) completes the CRM
   bundle** — `crm` gates at its FIVE authenticated chokes (`routes.ts`
   `requireEnabled` + the inline `convert` authz + the `runs` handler,
   `orgRoutes.authorize`, `signRoutes.authz`, `bookingRoutes.authz`, a
   `gmailSyncRoutes` helper) and `csm` at its one `requireEnabled` — the PUBLIC
   `public-book`/`public-sign` routes are deliberately EXEMPT (they never call
   the authed chokes; a public booker/signer is never 403'd on the operator's
   plan — the ADR 0176 shopper exemption). A per-sub-registrar route test proves
   no authed choke was missed. **The CRM bundle is now fully gated ⇒ sellable.**
   Other sellable bundles (marketing/cdp/…) gate their features the same way
   before being priced.

   **§Correction (2026-07-19) — the CENTRAL gate (Option D) replaces the
   per-feature grind.** The R2 code showed the honest way to gate the *remaining*
   ~40 bundle features is NOT ~40 per-feature edits. `authorizeOrgScope` calls
   `requireFeatureEnabled` internally, so `requireFeatureEnabled` is the ONE
   universal choke every gated route passes through (inline OR org-scoped). So a
   single check inside it — **`if (req.principal?.principalId &&
   isSellableBundleFeature(toggleId)) await checkEntitlement(req, toggleId)`** —
   gates EVERY sellable-bundle feature at once, and makes `priced ⟹ gated`
   STRUCTURAL (no per-feature hole to miss). It is scoped so it can't over-gate:
   ONLY bundle features (core/standalone `isSellableBundleFeature === false` →
   skip) and ONLY authenticated callers (`req.principal` is absent on public
   routes — the ADR 0176 shopper exemption, now central not per-feature).
   Fail-open until `PLAN_FEATURES` narrows. This EVOLVES ADR 0176's "don't fan
   into `requireFeatureEnabled`" ruling rather than violating it: entitlement is
   fanned ONLY to bundle features, authenticated-only — the anti-blast-radius
   intent (don't gate core, don't 403 shoppers) is preserved. Boundary: the check
   is billing's, reached via a **host seam** (`host/entitlementSeam.ts` —
   `registerEntitlementCheck`/`checkEntitlement`), so core `featureRoute.ts` never
   imports the billing feature (ADR 0001). The only routes the central choke does
   NOT cover are features that roll their OWN `resolveOne()` gate bypassing
   `requireFeatureEnabled` — an audit found ONLY `crm`/`csm`, both already gated
   per-choke (R2/P3). Net: **all sellable bundles are now enforceable; any bundle
   can be priced honestly.** The R2/P3/commerce per-feature gates remain as
   harmless redundancy (and the necessary path for `crm`/`csm`).

   **§Operator note (2026-07-19, DATA-419-2) — a narrowed plan makes gating and
   pricing two sides of one config.** Because the central choke gates EVERY
   feature that belongs to ANY bundle (`isSellableBundleFeature`), once an operator
   narrows `OPENWOP_BILLING_PLAN_FEATURES`, a bundled feature that is *gated* but
   whose bundle carries no price (`OPENWOP_BILLING_BUNDLE_PRICES`) and no
   plan inclusion becomes a **permanent 403 with no store path to unlock it** — the
   tenant can neither use it (not entitled) nor buy it (not for sale). This is an
   operator-config hazard, not a code defect (fail-open until a plan is narrowed).
   **Rule for operators narrowing a plan: every bundle whose features you gate MUST
   be either priced (so it appears in the store) or included in the plan.** The
   `publicBundlePricing`/`bundleStore` reads are honest-when-unconfigured (unpriced
   ⇒ absent, never a fabricated figure), and `bundlePriceMap`/`bundleDisplayConfig`
   now `log.warn` on a config key naming an unknown bundle (DATA-419-3), so a
   *typo'd* bundle id is greppable in logs — but a *missing* price on a real gated
   bundle is silent by design; the deploy checklist must diff the priced set against
   the gated set. (A future lint could assert this; deferred as operator-config, not
   in-repo state — DATA-419-1 likewise declined: the referential integrity of
   `bundles.json` is already a CI `--check` gate on an immutable build artifact, and
   wiring it into runtime boot would couple the host catalog reader to the feature
   registry for near-zero added safety.)

   **§Correction (2026-07-21, live-activation fix) — a narrowed plan must never
   lock a NON-SELLABLE feature.** During the first real activation (pricing the
   agents/crm/marketing ladder on `app.openwop.dev`), narrowing `PLAN_FEATURES.free`
   to an allowlist of only the unpriced *bundle* features **locked every non-bundle
   feature too** — most visibly `/marketplace/bundles` itself: the store gates on
   `useFeatureAccess('marketplace')`, and the FE locks any enabled feature absent
   from `allowedFeatures` (`locked = enabled && !entitled`), so the store **locked
   itself** ("this feature needs an upgrade… not available to buy"). Root cause: the
   backend central gate only entitlement-checks `isSellableBundleFeature` toggles, but
   `allowedFeatures` was a flat allowlist the FE applied to ALL features — the two
   disagreed. Fix (`resolveEntitlements`): when a plan is narrowed, union in **every
   non-sellable toggle id** (`listToggleDefaults()` minus `isSellableBundleFeature`)
   so the allowlist can only ever exclude features that are actually for sale. Net: a
   narrowed plan now locks ONLY sellable-bundle features not owned; the operator's
   `PLAN_FEATURES` list only needs the sellable features it wants free (e.g. the
   unpriced bundles' features). Pinned by `paid-feature-bundles.test.ts` ("locks
   SELLABLE features but never non-sellable ones").

   > **§ Correction (2026-07-19) — the audit above was WRONG, and so was
   > the conclusion it licensed.** Both halves of the preceding paragraph are
   > retracted:
   >
   > 1. **The count.** The audit claimed "ONLY `crm`/`csm`" roll their own
   >    `resolveOne` gate. Measured precisely — a feature resolving its OWN toggle
   >    with a REQUEST-derived subject — the pre-fix set was **five**: `billing`,
   >    `cdp`, `crm`, `csm`, `destination-sync`. Of these, `crm`/`csm` were indeed
   >    gated per-choke (the audit got those right), and `billing` is **core**, so
   >    `isSellableBundleFeature('billing')` is false and it can never be a paywall
   >    hole. The two the audit missed are the two that mattered: **`cdp`
   >    (`routes.ts`, 10 handlers) and `destination-sync` (6 handlers) were gated by
   >    NOTHING** — no central choke, no `requireEntitledFeature`.
   > 2. **The conclusion.** "Any bundle can be priced honestly" was therefore FALSE
   >    for **`customer-data-platform`**, which contains both. Pricing it would have
   >    sold nothing: buyers pay, non-buyers keep full access.
   >
   > The hole was **latent, not live** — `OPENWOP_BILLING_BUNDLE_PRICES` has no
   > checked-in default anywhere in the repo, so nothing was ever priced. The danger
   > was that this ADR actively told operators the coast was clear.
   >
   > **Fixed:** `cdp` and `destination-sync` now call the shared
   > `requireFeatureEnabled` (labels `'CDP'` / `'Destination Sync'` keep their 404
   > bodies byte-identical), inheriting the central choke. Their local gates were
   > pure duplication — same subject shape, same error — so they were deleted, not
   > patched.
   >
   > **The claim is now backed by a check, not an audit.**
   > `test/bundle-gating-invariant.test.ts` statically asserts that no feature in any
   > bundle resolves its OWN toggle with a **request-derived** subject. That
   > predicate is deliberate: a bundle feature MAY resolve its own toggle with a
   > **resource-derived** subject (`{ tenantId: org.tenantId }`) when serving a
   > PUBLIC route — the ADR 0176 shopper exemption the central choke intentionally
   > skips. `funnels`, `consent`, `discovery` and `recommendations` all do this and
   > are correct; keying the check on the mere presence of `resolveOne` would have
   > flagged them, and "fixing" them would 403 anonymous visitors — a worse bug than
   > the one closed. `crm`/`csm` are allowlisted, and the allowlist itself is
   > verified (an entry must actually call `requireEntitledFeature`, so it cannot
   > wave through a genuinely ungated feature).
   >
   > **Rejected: a boot-time `priced ⟹ gated` assertion.** "Is this feature gated"
   > is a STATIC property of the source — routes register imperatively with no
   > registry to walk, so the runtime cannot compute it and would have to consult a
   > hand-kept list. That is a second owner of a CI-owned invariant and the exact
   > drift mode that produced the false audit above. The static test is the single
   > owner; with it, every bundle feature gates **by construction**.
   >
   > Lesson for this ADR's own method: *an audit is a snapshot, a test is a
   > ratchet.* A structural claim in prose ("no per-feature hole to miss") needs a
   > structural check, or it decays the moment a new feature copies an old pattern.
   >
   > **Follow-up — the pricing-layer linchpin is now pinned (ENG-8, 2026-07-20).**
   > The static test proved every `bundles.json` bundle gates + is non-core, but the
   > step that actually makes `priced ⟹ gated` hold — that a
   > `OPENWOP_BILLING_BUNDLE_PRICES` entry can point at *nothing but* a real bundle
   > (`parseBundlePriceMap` honors only `knownBundleIds()`) — was itself only prose +
   > code. `test/bundle-gating-invariant.test.ts` now carries
   > `describe('priced ⟹ gated … (ENG-8)')`: a price at a phantom bundle OR a **core
   > feature id** is unsellable (`bundleForPrice` → `undefined`), closing "no core
   > feature is ever priced" at the pricing layer (the catalog checks only inspect
   > `bundles.json`) and composing the full chain. This is the named invariant the
   > paragraph above can cite.

7. **Surface = the marketplace bundles page reuses the catalog + billing's store
   client.** The catalog projection gains per-viewer annotations —
   `forSale` (price configured), `owned` (tenant entitled), `priceDisplay`
   (honest-when-unconfigured) — sourced from billing. The tenant store is a
   MODE/section of `/marketplace/bundles` (Buy / Owned / Locked), distinct from
   the operator's white-label composer. **Money + entitlement logic stays in
   `billing`; marketplace only renders.** The page composes over HTTP (it calls
   billing's bundle-store client) — no cross-feature CODE import.

8. **Locked state (frontend).** `FeatureAccessContext` fetches
   `GET …/billing/entitlements` alongside the toggle assignments and exposes
   `entitled` + **`locked`** (`enabled && !entitled` — toggle on, plan/bundles
   don't include it) WITHOUT overloading `enabled` (no consumer breakage);
   `useFeatureLocked()` is the reusable nav/surface hook. Entitlements degrade to
   `'*'` on any failure / billing-off, so a resolution error never spuriously
   locks. **R3 (2026-07-18) wires it nav-wide**: a locked feature shows a quiet
   lock affordance in BOTH the Sidebar and the ⌘K palette, and its nav link/action
   routes to the feature store (`/marketplace/bundles`) instead of its own page
   (which 403s) — the recognizable "locked → upgrade" pattern. Computed at render
   in the components (mirroring `useFeatureBadge`, not `resolveNav`). Per-page
   deep-link locked-state (a bookmarked URL still hits the backend 403) remains
   the recorded follow-on.

## Evaluation-matrix notes

- **Feature-package/toggle:** extends `billing` + `marketplace`; the store rides
  BOTH toggles (page = `marketplace`, purchase = `billing`). Optional
  `paid-bundles` sub-toggle to gate the store surface without touching either.
- **Node/agent packs · `ctx.<feature>` · envelopes · public surface:** N/A (no
  runtime capability added). A marketing bundle-price read may mirror
  `/public/pricing` (ADR 0391), Stripe-id-free.
- **RBAC:** buying is a tenant billing action (billing-admin/owner), same authz
  as managing a subscription — NOT superadmin (that is the white-label composer).
  Anon tenants cannot buy (no real customer) — mirror the ADR 0385 anon-can't-
  sell guard on the buy side.
- **Replay/fork:** entitlements are a LIVE read (like twin-recall, ADR 0044) —
  never run-stamped; a run does not reference entitlement identity; revocation is
  immediate. Unaffected.
- **Security / data-integrity:** money-truth CAS on the webhook only; bundleId-
  not-priceId at the boundary; fail-closed on unknown bundle / unconfigured price
  / billing-off; secrets stay in the BYOK Stripe resolver, never on rows/logs.
- **RFC verdict: NONE.** Host-extension under `/v1/host/openwop-app/billing/*` +
  platform Stripe; no run-event, capability advert, or normative behaviour
  changes. (Same posture as ADR 0176/0385.)

## Phases

| Phase | Scope | Gate |
|---|---|---|
| 1 | Host helper (`featureBundles.ts` raw read; refactor `bundleCatalog.ts` onto it) + `billing:bundle-entitlement` store + `OPENWOP_BILLING_BUNDLE_PRICES` map + `resolveEntitlements` union + `processStripeEvent` bundle branch + `POST /billing/bundles/:id/checkout` + route/webhook tests. **Backend paywall works; no UI.** | `npm run ci`; billing + entitlement route tests |
| 2 | Catalog projection gains `forSale`/`owned`/`priceDisplay` (billing composed over HTTP) + the tenant store UI on `/marketplace/bundles` (Buy / Owned / Locked) + entitlements-aware locked state | FE build + shop tests |
| 3 | **LANDED** — enforcement at the feature authz choke: `analytics` + `email` (clean-choke crm-bundle features) adopt `requireEntitledFeature` (403 without entitlement → pass once the `crm` bundle is owned, end-to-end tested); the `priced ⟹ gated` invariant recorded (a bundle stays unpriced until ALL its features gate); `crm`/`csm` gating tracked. FE `FeatureAccessContext` gains `entitled`/`locked` + `useFeatureLocked()` (degrades to unrestricted on failure). Nav-wide lock rendering = follow-on | `paid-feature-bundles.test.ts` gate test + `entitlement-access.test.tsx` |
| 4 (optional) | **PART A LANDED** — the one-time-unlock variant: `OPENWOP_BILLING_BUNDLE_ONETIME` marks a bundle `mode:'payment'`; it fulfils on `checkout.session.completed` via the session `metadata.bundleId` (activate ONLY one-time bundles — recurring bundles fulfil via `customer.subscription.*` and must not double-fulfil here); idempotent per event id; a one-time grant has no subscription so it never auto-revokes (recorded limitation). **PART B DEFERRED** — a public `/public/pricing`-style anonymous bundle-price read (marketing/SEO surface) is not a dependency; the authed store already shows prices to buyers. Falsifiable: build it when a public pricing page is actually wanted. | `paid-feature-bundles.test.ts` one-time tests |

## Decisions (was: open questions — resolved 2026-07-18)

- **Purchase shape → recurring add-on subscription per bundle** (`mode:'subscription'`),
  a separate Stripe subscription per bundle (least invasive to the one-plan-per-
  tenant model; `customer.subscription.deleted` cleanly deactivates the grant).
  A one-time-unlock variant (`mode:'payment'`, token-pack precedent) is an
  operator config option (`OPENWOP_BILLING_BUNDLE_ONETIME`, landed P4-A), NOT the
  default. Matches the owner's recurring lean + the existing subscription rail.
- **Unpurchased premium features → LOCKED with a "buy to unlock" CTA** (not
  hidden): discoverable, drives purchase, and honest about what the plan omits.
- **Bundle price display source → operator config à la `PlanDisplay`**
  (honest-when-unconfigured — never a fabricated figure). Key shape:
  `OPENWOP_BILLING_BUNDLE_DISPLAY = {"<bundleId>":{"price":"$29","cadence":"/mo","blurb":"…"}}`,
  read only for display; entitlement/price-mapping stays on
  `OPENWOP_BILLING_BUNDLE_PRICES`.

## Falsifiability

If the owner instead wants tenants to RESELL bundles to *their* customers, this
is the wrong lane — that is `commerce-connect` (ADR 0385, Stripe Connect), and
this ADR would be superseded. If no bundle is ever priced
(`OPENWOP_BILLING_BUNDLE_PRICES` empty), the store shows nothing for sale and the
reference host is byte-identical to today — nothing is lost.
