# ADR 0420 — `kicktodo-commerce`: paid challenges, entitlements, and (Wave 3) the creator marketplace

Status: **implemented (P1–P3, P5; P4 vacuously satisfied)** — 2026-07-18; Connect seller onboarding composes the EXISTING commerce-connect lanes at Wave-3 activation (phase record below)

**Requirements source:** `docs/kicktodo-prd.md` §6.7, §11, §12 Waves 1/3, §13 Commerce, review findings **H2** + **M1** (folded); the F2 gate in `docs/kicktodo-implementation-plan.md`.
**Depends on:** ADR 0414 (`kicktodo-core` — the challenge/enrollment owner), ADR 0415 (publication), Commerce (`features/commerce`), Billing (`features/billing`), ADR 0176/0385 (the Stripe invariants + Commerce Connect), later ADR 0367 (`packSignature`) for the M1 leg.
**Surface:** host-extension; the adapter registers behavior — it adds NO second money route. **NO new RFC.**

## Why this exists

Wave-1 sells curated first-party challenges through ordinary Commerce; Wave-3 opens the governed creator marketplace. The PRD's money rules are absolute (§6.7): Commerce owns products/orders/refunds, Billing owns subscriptions, Commerce Connect owns payouts, and the ADR 0176/0385 Stripe invariants (one client, one webhook URL, webhook routing order, money-truth toggle-independence, CAS fulfilment) are preserved exactly. `kicktodo-commerce` is the **adapter** that imports the public service contracts of both sides and registers fulfilment — `kicktodo-core` never imports Stripe (PRD §9.2).

## Boundaries audit (Step 3 — verified against live code)

- **Product types are a CLOSED set:** `PRODUCT_TYPES = ['physical','digital','service']` (`commerceService.ts:221`) — the H2 finding holds: **a "challenge" listing type does not exist** in either lane (Commerce products or the Connect pack-keyed paid listing). Selling a challenge as a plain `digital` product sidesteps this but is NOT the governed marketplace (no seller onboarding/fee split) — the PRD names this the acceptable Wave-1 lane.
- **Per-buyer entitlement is a named ADR 0385 deferral:** `resolveEntitlements` (`features/billing/entitlementGuard.ts`) models subscription tiers, not marketplace purchases; Connect pack install is host-wide superadmin. **Scoped per-buyer unlock is net-new** (H2 confirmed).
- **Fulfilment seam:** commerce fulfils orders through its own lifecycle; the adapter registers a fulfilment hook for challenge-typed items (grant entitlement on the order-row CAS `pending→paid` — never the checkout return, PRD §13).
- **Single owners named:** money truth = Commerce/Billing/Connect rows; access truth = the entitlement record HERE (a projection keyed to the buyer subject + challenge); the challenge itself stays in `kicktodo-core`. No second catalog, cart, or ledger.

## Decision + data model

New feature package `src/features/kicktodo-commerce/` (the adapter):

```text
ChallengeProductLink            // Wave 1 — first-party paid challenges
  tenantId, challengeId, challengeVersion, productId   // a `digital` Commerce product
  priceRef (informational; Commerce owns price truth)

ChallengeEntitlement            // the per-buyer unlock (H2's net-new half)
  tenantId, buyerSubject, challengeId, challengeVersion
  orderId                        // the money truth it projects
  state: active|revoked          // refund/dispute → revoked (future access only;
                                 // completed history is never deleted — PRD §13)
  grantedAt, revokedAt?
```

**Wave-1 flow:** publish (ADR 0415) → link product (`digital` type; the H2 correction: the first-class `challenge` product type is added to Commerce's enum only at Wave 3, as an ADDITIVE host change with its own fulfilment semantics) → buyer checks out through ordinary Commerce → the adapter's registered fulfilment hook fires on `pending→paid` CAS → `ChallengeEntitlement` created (idempotent per orderId) → `enroll` for a paid challenge requires an active entitlement (a `requireEntitlement` predicate the kicktodo-core enroll path calls through a registered guard — inversion: core exposes the seam, this adapter registers into it; core never imports commerce).
**Refund/dispute:** the adapter subscribes to the EXISTING commerce refund/dispute transitions (money events apply toggle-independently per ADR 0385) → entitlement `revoked` → new enrollments refused; the active enrollment's snooze is offered, never forced.
**Subscriptions (KickBot Plus):** a Billing tier gate composed via `resolveEntitlements` — the adapter contributes a tier→limits mapping (AI budget, concurrent enrollments); no new billing machinery.
**Wave-3 marketplace:** Connect seller onboarding (approval-gated dual lanes per ADR 0385's fold guard — `anon:` tenants never onboard), destination charges with minor-units-first fees, the `challenge` product type (additive enum + fulfilment semantics), and — only if third-party challenges carry executable packs — the **M1 chain-pack registry-fetch signature leg** built on `packSignature.ts`.

## Phased plan

| Phase | Ships |
|---|---|
| **P1 (Wave 1)** | Adapter package; `ChallengeProductLink` + linking route (publisher-gated); the entitlement store + fulfilment hook on the order CAS (idempotent per orderId); the `requireEntitlement` guard seam registered into kicktodo-core's enroll path; refund/dispute → revoke; route + saga tests (paid enroll exactly-once; refund revokes future access only). |
| **P2** | KickBot Plus tier mapping via `resolveEntitlements`; cohort capacity holds (a capacity counter CAS on the cohort resource — composes ADR 0419's cohorts). |
| **P3 (Wave-3 gate)** | The `challenge` product type (additive Commerce enum + fulfilment semantics); Connect seller onboarding for approved creators (approval-gated, dual paid lanes); destination charges + payout/fee math (minor-units-first); creator revenue view (own data only). |
| **P4 (conditional)** | M1: chain-pack registry-fetch signature verification against pinned publisher keys — ONLY if Wave-3 challenges ship executable extensions. |
| **P5 (core-app extension surface)** | `ctx.features.kicktodo-commerce` (read: entitlement check, price projection); node additions for the factory's pricing step; LLM-EXCHANGE row. |

## Implementation record (phase → PR)

| Phase | Landed |
|---|---|
| P1 — commerce order-lifecycle observers (additive `registerOrderPaidObserver`/`registerOrderRefundObserver`, invoked best-effort post-CAS — money truth never depends on them); the kicktodo-core `registerEnrollGuard` inversion (guards gate NEW enrollments only — an existing enrollment always converges); the adapter (`entitlementService.ts`: product links, per-buyer entitlements granted ONLY via the paid observer, re-point-on-re-purchase semantics so an old order's refund can't claw back a newer purchase, revoke = future access only); routes under `/kicktodo/entitlements/*` (the reserved-namespace guard correctly refused `/kicktodo/commerce` — renamed, a live catch); enroll denial → 402; observers/guard registered TOGGLE-INDEPENDENTLY (the ADR 0176/0385 money-truth rule) | kicktodo/0420-p1-commerce |
| P2 — the KickBot Plus tier gate (`tierGuard.ts`: the billing tier's `kicktodo.maxActiveEnrollments` limit consumed at the SAME enroll-guard choke point — "expressed in operator tier config, enforced at existing choke points", the ADR 0176 Phase-3 posture; absent limit ⇒ unlimited, the fail-open billing default; actionable upgrade copy in the denial; resolver injectable for tests). Cohort capacity landed with ADR 0419 P3 (`joinCohort` exact CAS) — the composition the ADR named | kicktodo/0420-p2-tiers |
| P3 — the `challenge` product type (additive `PRODUCT_TYPES` entry — inert-by-default: every commerce type branch keys on `physical`/`digital`, so a challenge product carries no inventory/weight/downloads; fulfilment IS the P1 entitlement observer; commerce regression suites green) + the creator revenue projection (`revenueProjectionFor` — the creator's OWN links with entitlement COUNTS only, no buyer PII, cross-creator-scoped; `/kicktodo/entitlements/revenue`). Connect seller onboarding/destination charges/fee math compose the EXISTING commerce-connect owner (ADR 0385) at Wave-3 activation — no code needed here, recorded | kicktodo/0420-p3p5 |
| P4 — M1 chain-pack registry-fetch signing | **Vacuously satisfied**: the condition ("Wave-3 challenges ship executable extensions") is false — no third-party challenge carries packs. Falsifiable trigger: the first publisher-key-verified challenge pack reopens this phase on `packSignature.ts` |
| P5 — `ctx.features.kicktodo-commerce` (read-only `isPaid`/`entitlement`), the `entitlement-check` node (pack v1.4.0; pins bumped in lockstep across all four pinning features) | kicktodo/0420-p3p5 |

## Feature matrix

1. Package ✔ (adapter posture; imports the PUBLIC contracts of commerce/billing/kicktodo-core; neither base imports it back). 2. Toggle `kicktodo-commerce`, **OFF**, `bucketUnit: tenant`. **Money-truth rule:** purchase/refund/dispute effects apply even when the toggle is OFF (ADR 0176/0385 — only discovery/linking UI is toggle-gated). 3. Workflow surface: read-only checks (P5). 4. Node pack: extends `feature.kicktodo.nodes`. 5. Envelopes: none. 6. Agent pack: none (pricing advice is not an agent surface here). 7. Public surface: none new (storefront/checkout are Commerce's existing surfaces). 8. RBAC: linking = publisher-gated; entitlements readable by their buyer only (uniform 404); revenue views seller-scoped. 9. Replay/fork: entitlement grant is CAS-idempotent per orderId; a replay never re-charges or re-grants (the order row is the truth); run-visible pricing stamped in run metadata where a workflow reads it. 10. Frontend: price/entitlement chips on Discover + a "My purchases" slice; checkout hand-off to the existing storefront.

## Alternatives weighed

- **Extend Commerce's enum to `challenge` at Wave 1** — rejected: the H2 analysis stands; `digital` + adapter link delivers first-party sales now, and the enum change lands once (Wave 3) with its real fulfilment semantics instead of twice.
- **Entitlements inside `resolveEntitlements` rows** — rejected for purchases: that guard models tenant subscription tiers; per-buyer per-challenge rows need their own store projecting order truth. Subscriptions DO ride it (P2).
- **A kicktodo checkout route** — rejected: one storefront, one webhook, one money truth (ADR 0176).

## Open questions

1. Refund policy window + whether a revoked entitlement pauses an ACTIVE enrollment (recommend: never auto-pause; offer snooze) — product decision at P1.
2. Wave-3 platform fee % + region policy (PRD §19 Q6) — operator decision, config not code.
3. Does the Wave-3 `challenge` product type live in Commerce's enum or as a typed extension registry? (Recommend: additive enum — smallest honest change; revisit if a third product family appears.)

## RFC verdict

**Host work, no new RFC.** Everything rides the existing Commerce/Billing/Connect owners and the ADR 0176/0385 invariants; nothing touches the OpenWOP wire. The M1 signing leg is host pack-pipeline work (ADR 0367 primitives). PRD §17 stands: a portable challenge COMMERCE schema across hosts would be an RFC first.

## Correction note (2026-07-18 — ADR 0427)

P4's falsifiable trigger is now BUILT: workflow-chain-pack registry-fetch signature verification ships in the loader (ADR 0427), enforced by `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES`. The deploy that opens third-party executable challenges MUST set that flag; P4 remains vacuous only until such packs exist, and the enforcement mechanism no longer is.
