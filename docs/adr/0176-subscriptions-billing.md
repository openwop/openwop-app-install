# ADR 0176 — Subscriptions & Billing (Stripe, plan tiers, usage limits, token packs)

**Status:** implemented (Phases 1–3 + R-1 cutover — 2026-07-01). **P2** added: the
prepaid-balance ENFORCEMENT seam (`host/managedBalanceHook.ts` — dependency inversion so
core never imports billing; the managed provider draws from balance BEFORE the daily cap +
records draw-down) + the FE plan/balance panel (`features/billing/`, 4-locale). **P3** added:
per-tier `planLimits` config surfaced by `resolveEntitlements` + the ONE opt-in
`requireEntitledFeature` guard (never per-feature edits). **P1** checkout/portal now return
a real Checkout Session (demo-mode default; live URL when a Stripe key is present). Tests +2.
Original P1 core below. `features/billing/`:
subscription store + prepaid **token-balance ledger** (Stripe ids verbatim, R-1.3);
**config-driven price catalog** (`OPENWOP_BILLING_{PLAN,TOKEN_PACK}_PRICES`, no baked IDs,
R-1.2); **Stripe webhook** (verify `t=,v1=` HMAC over raw body → idempotent-per-`event.id`
processor: subscription lifecycle + token-pack credit + invoice) on a PUBLIC path
(`/billing/webhook` in `PUBLIC_PATH_PREFIXES`, R-1.4); the **R-1 importer** (`/billing/import`,
superadmin, ids preserved); the **central `resolveEntitlements`** (unrestricted when off);
`drawFromBalance` (balance-before-cap seam). Demo-mode: checkout/portal report
`capability_not_provided` until a Stripe key is set ⇒ byte-identical when off. `billing`
toggle OFF. Test: `billing.test.ts` (6). **Sequenced follow-ons (P2/P3):** live Stripe
checkout/portal SDK, balance-enforcement at the `managedProvider` choke point, per-tier
limits as `GovernancePolicy` + the one opt-in entitlement guard, the FE plan/usage panel.
Pure host-ext — no wire, no RFC.
**Date:** 2026-07-01

> **§Deferred-work follow-on landed (2026-07-01):** seat-sync (quantity from org membership), billing coupons, and invoice generation (record + markdown; real PDF composes Documents 0053) shipped; checkout returns a real Checkout Session (demo→live seam). Live Stripe SDK capture remains operator last-mile.
**Track:** A (Software & App Architecture). **No OpenWOP wire change → no RFC**
(operator-private commercial policy + host-side Stripe credentials).
**Reverses:** the ROADMAP "explicit cut" of Billing/Subscriptions ("CRM is decoupled
from commerce on purpose", `ROADMAP.md:605`) — **additively**. The cut's real invariant
("CRM ships without commerce") is preserved: billing depends on CRM/orgs, never the reverse.
**Primary target — the MyndHyve cutover (Requirement R-1):** when MyndHyve migrates onto
this codebase, **every existing Stripe integration MUST keep working on day one against
the existing Stripe account — no re-provisioning.** Existing products/prices, live
customers + active subscriptions, the configured webhook, and outstanding token-pack
balances all carry over untouched. This makes **live mode a first-class Phase-1
deliverable** (demo-mode remains the *fresh-OSS-operator* default, not the MyndHyve path).
See § "Stripe migration continuity". **Still no wire change → no RFC** (operator-private).
**Owner:** a NEW feature-package `features/billing/`.
**Toggle:** `billing` (default **OFF**, `bucketUnit: tenant`).
**Composes (does NOT fork):** ADR 0015 (workspace-as-tenant = the billing subject),
`features/orgs/` (seats = org membership), ADR 0006 (RBAC), `providers/managedProvider`
(the token-usage meter — read, don't fork), `host/governanceService` (usage LIMITS as
`GovernancePolicy` — ADR 0106/0077), `byok/secretResolver` (Stripe keys), the
`connections/inboundWebhooks` seam (Stripe webhook), `observability/costEmitter`.
**MyndHyve baseline:** `functions/src/stripe/` (~2,200 LOC — checkout/portal/subscriptions/
tokenPacks/webhooks/paymentPlans/customers) + `functions/src/types.ts:11-125`.

---

## Context — boundaries & composition audit (done first)

| Concern | Single owner (compose) | Note |
|---|---|---|
| Plan/subscription state | **NET-NEW** (`billing` package) | nothing owns it today |
| Seats / members | **`features/orgs/`** | per-seat pricing reads org membership — **don't re-model seats** |
| Token USAGE meter | **`managedProvider.dailyTokenCap` + `storage.getManagedUsage/incrementManagedUsage`** | read; layer plan limits as governance, not a second meter |
| Usage LIMITS (workspaces/members/projects/storage/runs/tokens/API-rate) | **`host/governanceService` `GovernancePolicy`** (ADR 0106/0077, superadmin-gated) | the limit home **already exists** — extend it |
| AI-token BALANCE ledger (prepaid credit) | **NET-NEW** | grep for `tokenBalance/purchasedTokens/prepaid` = **zero**; openwop has *usage-cap*, no *balance* |
| Stripe secrets (API key + webhook signing secret) | **`byok/secretResolver`** (AES-256-GCM `credentialRef`) | no new secret store |
| Stripe inbound webhook | **`connections/inboundWebhooks.ts`** (provider-signature-is-the-credential, raw-body, RFC 0083 path) | model Stripe as a new `InboundProvider` (HMAC over **raw** body) — **do NOT hand-roll a public endpoint** |
| Spend figures | `observability/costEmitter.emitCost` | reuse |

**The two genuinely net-new structures:** (1) subscription/plan state, (2) the
**prepaid AI-token balance ledger** — which MUST interoperate with `managedProvider`'s
cap check: **precedence = balance depletion is checked first (a purchased-credit
tenant draws down balance); the managed daily-cap remains the operator backstop.**

**Plan-tier gating ≠ feature toggles (the critical distinction).** Feature toggles are
an **operator/admin** "does this INSTANCE ship the feature" gate. Plan gating is a
**per-tenant COMMERCIAL entitlement** "may this TENANT use it". They are **orthogonal**;
overloading `toggleDefault` for entitlements would be a parallel gate with the wrong
lifecycle.

## Decision

A `billing` feature-package (toggle OFF, tenant-bucketed) that owns subscription state +
the token-balance ledger, drives Stripe **host-side (BYOK, demo-mode default)**, and
expresses commercial policy through **one central entitlement resolver** — never by
editing individual features.

- **Stripe surface** under `/v1/host/openwop-app/billing/*` (checkout / portal /
  setup-intent / subscription GET+update / cancel / reactivate) — host-extension,
  `authorizeOrgScope`/admin-gated, Stripe key via BYOK. **Demo-mode:** with no live key
  the routes no-op/mock (honoring the "OPTIONAL" framing) ⇒ zero behavior change.
- **Webhook** as a new `InboundProvider` (Stripe `Stripe-Signature` HMAC over the raw
  body) on the connections-inbound seam → drives subscription/invoice/balance updates;
  added to `PUBLIC_PATH_PREFIXES`; idempotent per Stripe event id.
- **Token-balance ledger** (`billing:token-balance`, `billing:token-purchase`) —
  prepaid packs; balance drawn down **before** the daily cap; depletion enforced at the
  `managedProvider` choke point (one added read), warning thresholds surfaced via
  Notifications (ADR 0010), never a new banner system.
- **Entitlements = ONE central resolver.** `billing` owns
  `resolveEntitlements(tenant) → { plan, allowedFeatures, limits }`; usage-LIMITS are
  written as **`GovernancePolicy`** enforced at existing choke points
  (`managedProvider` for tokens, orgs for seats/members, governance for storage/runs).
  A single **opt-in** guard middleware lets a route consult entitlements; **features are
  NOT edited** to add plan-checks (that fan-out is the anti-pattern).

## Stripe migration continuity (Requirement R-1 — the MyndHyve cutover)

The billing package MUST be **configuration-compatible with MyndHyve's existing Stripe
account** — same account, same objects, no re-provisioning. Six invariants make the
cutover work day-one:

1. **Same Stripe account + credentials (BYOK).** The existing **secret API key** and the
   existing **webhook signing secret** are imported as `byok/secretResolver` credential
   refs. No new Stripe account, no key regeneration. Live mode = "a Stripe key is
   configured"; the routes are real, not mocked.
2. **Config-driven price catalog — NO hard-coded price IDs.** MyndHyve's `paymentPlans.ts`
   (plan tiers) + `tokenPacks.ts` (`TOKEN_PACKS`) port as a **catalog config**
   (`plan-tier → stripePriceId`, `token-pack → stripePriceId`), loaded from settings/env.
   Pointing the host at MyndHyve's Stripe = supply the **existing** price IDs. The code
   never bakes a price ID, so checkout/portal reference the live prices customers already
   have. (Fail-closed: an unmapped tier/pack is a config error, never a silent new price.)
3. **State import preserves every Stripe id.** The billing store schema carries
   `stripeCustomerId`, `stripeSubscriptionId`, `stripePriceId`, `status`,
   `latestInvoiceId`, `defaultPaymentMethodId`, period/trial timestamps, `quantity`
   (seats) **verbatim**, plus the token-balance rows (`purchasedTokensTotal`,
   `totalAvailable`). A one-time **operator importer** maps MyndHyve's Firestore
   subscription/customer/invoice/token-balance docs → the new `DurableCollection` rows.
   Because the ids are preserved, **existing customers, active subscriptions, the billing
   portal, and saved payment methods keep working untouched** — no re-subscribe, no
   re-checkout, no lost prepaid balance. (This is an **operator data-migration tool**, not
   an app `LATEST_SCHEMA_VERSION`/`APP_MIGRATIONS` change — the billing store is host-ext KV.)
4. **Webhook parity + cutover.** The Stripe `InboundProvider` handles the **same event set**
   MyndHyve handles — `customer.subscription.{created,updated,deleted,trial_will_end}`,
   `invoice.{paid,payment_failed,created,finalized}`, `checkout.session.completed`,
   `payment_method.{attached,detached}` — verified with the existing signing secret,
   **idempotent per Stripe `event.id`**. Cutover runbook: **add** the new host's
   `…/billing/webhook` URL as an *additional* Stripe endpoint during the window (both
   receive events; idempotency makes double-delivery safe), then retire the old endpoint —
   or re-point in place. No missed/duplicated state.
5. **Hosted portal + Checkout against the live account.** Billing-portal + Checkout use
   Stripe's hosted flows on the **existing** account; portal configuration already lives in
   Stripe, so it "just works" post-cutover. Checkout Sessions reference the config price IDs.
6. **Token-pack purchase is transactional + idempotent.** Crediting a purchased pack
   (webhook `checkout.session.completed`) uses `DurableCollection.compareAndSwap` keyed on
   the Stripe `event.id`, so a webhook retry during cutover never double-credits the balance
   (MyndHyve's Firestore-transaction guarantee, ported to the host CAS primitive).

**Cutover acceptance (R-1 done means):** point the host at MyndHyve's Stripe (keys +
catalog config), run the importer, add the webhook endpoint → an existing paying customer
sees their **same plan, same renewal date, same token balance**, a Stripe subscription
event updates host state, and the portal opens their existing subscription — with **zero**
Stripe objects re-created.

### Port-not-clone corrections
- **Plan state is its own entity**, not denormalized onto the user/identity record
  (MyndHyve puts `currentPlanTier` on `UserDocument`) — keeps the ADR 0003 identity lean.
- **No per-feature plan-checks.** Central resolver + governance policy + one opt-in guard.
  Per-feature plan-gates (if ever) are opt-in Phase 2, not a cross-cutting rewrite.
- **Stripe webhook rides the connections-inbound seam** — not a hand-rolled public route.
- **Usage limits are governance policy**, not a parallel quota store.

## Phased plan

**Phase 1 carries the R-1 cutover surface — live mode is NOT deferred.**

- **Phase 1 — subscription + live Stripe + config catalog + webhook + importer.**
  `billing` package + toggle; the subscription/plan store carrying all Stripe ids (§R-1.3);
  the **config-driven price catalog** (§R-1.2, no baked price IDs); Stripe routes
  (checkout/portal/subscription/cancel/reactivate) real when a **BYOK key is present**,
  no-op/`not_configured` when absent (§demo-mode default); the Stripe `InboundProvider`
  webhook with **full MyndHyve event parity + per-`event.id` idempotency** (§R-1.4); the
  **one-time state importer** (Firestore → billing `DurableCollection`, ids verbatim,
  §R-1.3). Tests: RBAC, IDOR, signature verify (existing secret), demo-mode no-op,
  webhook idempotency (double-delivery), importer id-preservation, unmapped-tier config
  error, subscription-event → host-state update.
- **Phase 2 — token-balance ledger + enforcement.** Prepaid packs credited transactionally
  per `event.id` (§R-1.6); balance draw-down **before** the daily-cap at `managedProvider`;
  depletion → `token_balance_exhausted`; warnings via Notifications. Frontend: plan / usage
  / balance panel (`ui/`, gated). **Imported balances carry over.** **Blocker for going live:
  the balance draw MUST discount cached-read tokens** — see the "Cached-read token
  accounting" decision below.
- **Phase 3 — entitlements (opt-in).** `resolveEntitlements` + usage-LIMITS as
  `GovernancePolicy` + one opt-in guard; seats from org membership. **No per-feature edits.**
- **Deferred:** coupons, per-seat proration polish, invoice PDF rendering.

## /prd five-architect compatibility pass

| Architect | Verdict |
|---|---|
| **Spec** | No new wire vocabulary. Billing/Stripe/entitlements are operator-private commercial policy under `/v1/host/openwop-app/*`; no capability handshake change. **N/A.** |
| **Schema** | No new/changed wire schema. Subscription/invoice/token-balance are host-private stores. The Stripe webhook rides the existing inbound-webhook contract (no new wire). |
| **Security** | Stripe API key + webhook signing secret host-side via BYOK (never wire/log/payload); webhook = signature-over-raw-body (timing-safe, idempotent per event id) on the connections-inbound seam; admin routes RBAC-gated; entitlements are host authz, not protocol. |
| **Conformance** | Nothing advertised → no scenario. `OPENWOP_REQUIRE_BEHAVIOR` unaffected (no capability flip). |
| **Compatibility** | **Additive** on infra (new package, toggle OFF, demo-mode ⇒ byte-identical when off/unconfigured). **R-1 cutover is additive too:** the Stripe-state importer is a **one-time operator data-migration tool** into the host-ext KV store — NOT an app `LATEST_SCHEMA_VERSION`/`APP_MIGRATIONS` change (no migration-integrity-gate impact) — and it re-creates **nothing** in Stripe (configuration-compatible with the existing account). **Risk contained** on the entitlement axis by the central-resolver + governance-policy mandate — the one thing that could be invasive (per-feature plan-checks) is explicitly forbidden. |

**RFC gate: none.** ⚠️ **Blast-radius flag (design invariant, not a wire issue):** the
ONLY way billing becomes non-additive is if plan-gating fans checks into every feature
package. The ADR **commits to the centralized resolver + governance-policy path**; that
keeps the blast radius to one guard + one policy extension.

## Alternatives considered
1. **Overload feature toggles for plan entitlements.** Rejected — wrong lifecycle
   (per-tenant, Stripe-driven) + a parallel gate; toggles answer "does the instance ship
   it", entitlements answer "may the tenant use it".
2. **A parallel usage-quota store.** Rejected — `governanceService` + `managedProvider`
   already meter/limit; extend `GovernancePolicy`.
3. **Per-feature plan-checks.** Rejected — cross-cutting rewrite of every feature; use one
   opt-in guard + the central resolver.
4. **Live Stripe *by default* (always-on for every operator).** Rejected — demo-mode
   *default* keeps the fresh reference host additive + safe. **This does NOT weaken R-1:**
   live mode is a first-class, day-1-supported mode (config catalog + BYOK key + importer,
   Phase 1) — MyndHyve simply *configures* into it. The default is off; the capability is
   present from Phase 1, not deferred.
5. **Re-create Stripe objects in a new account for the migration.** Rejected — violates
   R-1 (would re-provision products/prices/subscriptions, break the portal, and orphan
   prepaid balances). The port is **configuration-compatible with the existing account**;
   nothing in Stripe is re-created.

## Open questions
- [ ] **Balance vs daily-cap precedence** — confirm balance-first, cap-as-backstop at the
  `managedProvider` choke point (one read).
- [ ] **Entitlement default when `billing` OFF** — must be "all features allowed" (no
  gating) so the reference host is unrestricted until an operator opts into billing.
- [ ] **Seat counting** — derive from org membership live vs snapshot at invoice time.
- [ ] **Tenant ↔ Stripe customer mapping on import (R-1).** MyndHyve keys billing to the
  user/workspace; confirm the importer maps each `stripeCustomerId` to the correct
  openwop **tenant** (ADR 0015) — a mapping table is the migration's load-bearing step.
- [ ] **Webhook cutover window (R-1.4).** Prefer *add-then-retire* (dual endpoints, both
  idempotent) over in-place re-point, to avoid a gap while DNS/routing settles.
- [ ] **Catalog source of truth (R-1.2).** Price-ID catalog in env vs a superadmin-edited
  settings store — settings store lets ops update prices without a redeploy; env is simpler.
  Either way it's operator config, never code constants.
- [ ] **API-version pinning.** Pin the Stripe API version to MyndHyve's current one on
  cutover so webhook payload shapes match the ported handlers; upgrade deliberately later.

## Correction note — LIVE mode now calls the REAL Stripe API (2026-07-03, LEAK-11 / ADR 0195 Phase 4)

The Phase-1 "live mode" seam was DISHONEST in a way the original text did not
anticipate: with a Stripe key configured, `createCheckoutSession` FABRICATED a
`https://checkout.stripe.com/c/pay/cs_<locally-minted-uuid>` URL (404 at
Stripe), and the portal route fabricated `billing.stripe.com/p/session/<id>`.
Architect-reviewed and fixed:

- **`features/billing/stripeApi.ts`** — the single owner of Stripe HTTP.
  Egress rides the aiProviders/adsAdapter discipline (raw fetch to a HARDCODED
  `api.stripe.com` base, `OPENWOP_STRIPE_API_BASE` test override only) — NOT
  the Connections broker: the key is BYOK operator config
  (`STRIPE_KEY_REF = 'billing:stripe-key'`), not a Connection, and forcing it
  through `brokeredPost` would have invented a second credential model.
  15s timeouts; fresh `Idempotency-Key` per POST; Stripe 401 →
  `credential_unavailable`, other errors → 502 with Stripe's message only.
- **Checkout** — real `POST /v1/checkout/sessions` (form-encoded; `mode`
  inferred from the catalog: plan → `subscription`, token pack → `payment`;
  success/cancel URLs from `publicBaseUrl`). Stored under STRIPE'S session id
  so the (already-real) webhook's `checkout.session.completed` correlates.
- **Portal** — real `POST /v1/billing_portal/sessions` for the stored
  `stripeCustomerId`; keyless or no-customer returns the honest `demo:portal`
  sentinel with `mode:'demo'`.
- Keyless demo sentinels (`demo:checkout:`, `mode:'demo'`) unchanged.
- Tests: `test/stripe-live-payments.test.ts` against a mock Stripe server
  (form/Bearer assertions, mode inference, 401/error honesty).

## Correction note — plan-feature gating activated (2026-07-03, ecommerce gap-analysis Phase A / A2)

Phase 3 shipped `requireEntitledFeature()` as "the ONE opt-in guard" — but
`resolveEntitlements` hardcoded `allowedFeatures: '*'` and **no route ever called
the guard**, so plan-feature gating was unsatisfiable dead code (an honesty gap:
the ADR claimed a mechanism the app couldn't exercise). Now:

- **`planFeatures(plan)`** reads operator config
  `OPENWOP_BILLING_PLAN_FEATURES` (e.g. `{"free":["crm","forms"],"pro":"*"}`),
  mirroring `planLimits`. Absent / not-listed / invalid ⇒ `'*'` — the reference
  host stays unrestricted until an operator explicitly narrows a plan, so no
  default deployment changes behavior.
- **First consumer:** the commerce org-scoped routes call
  `requireEntitledFeature(req, 'commerce')` inside their shared `authz` helper
  (ADR 0177's surface — a natural paid tier). The public storefront route and
  the Stripe webhooks are deliberately NOT gated (a shopper must never see the
  merchant's plan error; money-state truth beats plan gating).
- Route-tested: billing ON + a narrowed free plan → 403 `forbidden` with the
  canonical envelope; billing OFF or unnarrowed config → unaffected.

## Correction/resolution note — R-1 cutover-readiness hardening (2026-07-07)

A cutover-readiness audit (openwop `features/billing/` vs MyndHyve `functions/src/stripe/`,
the two `/Users/david/dev/myndhyve` + `-seed` trees) found the billing feature ~90% R-1-ready
but with concrete gaps that would bite on the real cutover. All closed; the **Open questions**
above are resolved:

- **Webhook parity (R-1.4).** The processor now handles MyndHyve's FULL event set — added the
  four missing types: `invoice.payment_failed`, `invoice.created`, `payment_method.attached`,
  `payment_method.detached` (were silently ignored). `payment_method.*` keep the tenant
  subscription's `defaultPaymentMethodId` current so the portal shows the right card.
- **Idempotency is now a CAS CLAIM, not get+put (R-1.4/R-1.6).** `processStripeEvent`
  compare-and-swap-inserts the `event.id` marker BEFORE applying, releasing it on error so a
  Stripe retry reprocesses. This is the load-bearing fix for the **webhook cutover window**
  open question: under *add-then-retire* dual endpoints both deliver the same event
  concurrently — the old get-then-put guard raced and would double-credit a token pack; CAS
  lets exactly one delivery win. **Resolution: add-then-retire is the runbook, now race-safe.**
- **Stripe API version PINNED (R-1.5, open question resolved).** `stripeApi.ts` sends
  `Stripe-Version: 2025-12-15.clover` (MyndHyve's version; `OPENWOP_STRIPE_API_VERSION`
  override). The webhook handler also reads `current_period_{start,end}` from BOTH the
  top-level (older versions) AND the subscription ITEM (where clover moved them) — without
  this the renewal date would silently fail to populate on cutover payloads.
- **Continuity timestamps carried (R-1.3).** `Subscription` gained `currentPeriodStart` +
  `trialEnd`; subscription events populate them and the importer carries them verbatim — so an
  active trial keeps its end date and the renewal window survives the cutover.
- **No silent tier default.** An unmapped price no longer flips the tier to `'pro'`; it keeps
  the existing tier (honest — a catalog miss is a config error to notice, not a silent plan).
- **Catalog source of truth (open question resolved): env-only** (`OPENWOP_BILLING_PLAN_PRICES`
  / `..._TOKEN_PACK_PRICES`) — deliberate; a superadmin-editable price store is a future
  nice-to-have, not a cutover blocker (prices change rarely; an env update is one redeploy).
- **Still-open last-mile (recorded, not a blocker):** `setSeats` writes `quantity` to the
  local store only — it does NOT push a Stripe subscription `quantity` update. MyndHyve has no
  auto seat-sync either (seats are explicit checkout inputs), so this is an ADDITION beyond
  R-1 parity, deferred.

- **Cached-read token accounting (decision, 2026-07-07; from an `/architect` options
  eval).** Since PR #1491 (ADR 0148 A2 / OQ#3) the managed provider parses MiniMax's
  automatic prefix-cache hits (`cachedReadTokens`), which MiniMax bills at ~20% (an 80%
  discount); ADR 0315 made every managed turn take the multi-round tool loop, so cached
  reads are now a large, growing share of prompt tokens. **The managed daily-token cap
  deliberately keeps charging cached reads at FULL weight** — the cap is an operator
  *cost-control safety rail*, and for a rail erring high (trip early) is correct; at a 20M
  tokens/tenant/day cap the over-count is immaterial, and discounting it would drift the
  stored `inputTokens` bucket's meaning and hardcode one vendor's price sheet into a
  provider-agnostic charge. **The prepaid balance is different: it is customer money.** A
  token-denominated `drawFromBalance` (this ADR's Phase 2 seam) that draws cached reads at
  full weight *over-charges a paying customer* for tokens MiniMax billed at 20%. This is
  latent today only because `billing` ships `status:'off'` (the balance hook is a no-op),
  so **before prepaid goes live (this Phase 2 / the R-1 cutover), the balance draw MUST
  discount cached-read tokens** — applied consistently to BOTH the cap increment and the
  balance draw, via a **per-managed-target discount factor** (config, not a hardcoded
  `0.2`; Anthropic cache-read is 0.1×, OpenAI ~0.5×, so the factor is provider-specific).
  Inputs are already in hand: `cachedReadTokens` is parsed at the dispatch sites and needs
  only threading into `recordManagedUsage`. **Trigger metric:** the `managed_prompt_cache`
  log line (shipping since #1491). **Act sooner (flip the free cap to discounted too) iff**
  those logs show real tenants *hitting* the 20M cap with a high cache-hit ratio — i.e.
  users denied free usage they effectively earned via caching. No gaming risk either way:
  `cached_tokens` is provider-reported, unforgeable, and more cache hits genuinely mean
  lower operator cost. Cross-refs: [ADR 0148 §A2/OQ#3], [ADR 0315], `managedProvider.ts`
  (`prepareManagedDispatch` cap check, `recordManagedUsage`), `managedBalanceHook.ts`.

Cutover runbook: `docs/research/myndhyve-cutover-runbook.md`. Tests: `billing.test.ts`
(+5: CAS concurrency, clover period location, unmapped-price tier, invoice.created/failed,
payment_method attach/detach) and `stripe-live-payments.test.ts` (+1: pinned `Stripe-Version`).
