# Billing (unit F1) — chat-first port review

**Scope:** `backend/typescript/src/features/billing` + `frontend/react/src/features/billing`.
Single-feature mode. Context: CLAUDE.md § Stripe surface invariants (ONE Stripe
client, ONE webhook URL / two secrets, webhook routing order, money-truth rule,
ADR 0419 paid feature bundles).

## TL;DR

**Billing already rides the engine; there is nothing bespoke to demolish.** The
feature declares no agent, no workflow, no node, and no chat tool
(`grep -rniE "registerFeatureAgentTool|startWorkflowRun|WorkflowDefinition|\.nodes|registerAgent"`
over the package → **zero hits**). Every capability is one of: (a) money
movement correctly **delegated to Stripe's own hosted flows** (checkout/portal)
+ a signature-verified webhook that applies money-truth, (b) a **single central
entitlement resolver** wired through the host seam, or (c) an **honest read
page / operator-config surface**. Money movement is deliberately NOT a chat
action — CLAUDE.md forbids it and there is no shared approval machinery for it —
so the chat-first lens produces **no PARALLEL and no THEATER findings**. The only
additive opportunity is a *read-only* "what plan am I on / what's my token
balance" agent tool (ADR 0308/0315 pattern); it is optional and non-blocking.

### Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| View plan tier + status | `BillingPage.tsx:56-60` read of `GET /subscription` | **PAGE-LEGIT** | Keep. Honest read; backed by a real subscription row. |
| View prepaid token balance | `BillingPage.tsx:61` read of `GET /balance` | **PAGE-LEGIT** | Keep. |
| Manage subscription (payment method, cancel, invoices) | "Manage" button → `POST /portal` → **Stripe hosted Billing Portal** (`routes.ts:139-153`, `stripeApi.createStripePortalSession`) | **RIDES** | Leave. Delegates to the external owner (Stripe), not a bespoke re-implementation; keyless → honest `demo:portal` sentinel. |
| Checkout a plan / token-pack | `POST /checkout` → **real Stripe Checkout Session** (`routes.ts:105-116`, `billingService.ts:491-527`) | **RIDES** | Leave. Server resolves the CONFIGURED price; unknown price = typed `validation_error`. |
| Buy a paid feature bundle (ADR 0419) | `POST /bundles/:bundleId/checkout` (`routes.ts:122-135`) → `priceForBundle` → real Stripe session | **RIDES** | Leave. `bundleId` in / server-resolved price out (no arbitrary-price / entitlement-injection). |
| Apply Stripe events (money-truth) | `POST /webhook` (`routes.ts:158-225`) → `processStripeEvent` (`billingService.ts:553-673`) | **RIDES** | Leave. Signature-is-credential, event-id CAS-claim dedup, fee/credit CAS ledgers, Connect/ccOrder/dispute routing order preserved. |
| Central entitlement resolution + gating | `resolveEntitlements` (`billingService.ts:300-327`) + `requireEntitledFeature` (`entitlementGuard.ts:20`) + host-seam registration (`routes.ts:45`) | **RIDES** | Leave. THE single resolver; opt-in guard; fail-open when billing off / plan unrestricted. No per-feature fan-out. |
| Prepaid balance ledger + managed-provider draw | `setManagedBalanceProvider` (`feature.ts:22-26`) + `drawFromBalance`/`creditBalance` CAS (`billingService.ts:695-737`) | **RIDES** | Leave. Dependency inversion at the managed-provider choke; core stays feature-free. |
| Connect + product-subscription event seams | `connectEventHook.ts` + `subscriptionInvoiceHook.ts` | **ADAPTER** | Leave; watch for drift. Thin inversion seams so commerce / commerce-connect receive events without billing importing them. |
| Public pricing + bundle-pricing catalogs | `GET /public/pricing` + `GET /public/bundle-pricing` (`routes.ts:52-67`) → `publicPricingCatalog`/`publicBundlePricing` | **PAGE-LEGIT** | Keep. Anonymous marketing facts, honest-when-unconfigured (`[]`), never leaks a Stripe id. |
| Tenant bundle-store projection | `GET /bundles` (`routes.ts:93-98`) → `bundleStore` (`billingService.ts:238-249`) | **PAGE-LEGIT** | Keep. For-sale/owned/display projection, no Stripe id on the boundary. |
| Operator tools: R-1 import / seat-sync / coupons / invoices | `POST /import`, `/sync-seats`, `/coupons`, `GET|POST /invoices` (`routes.ts:229-278`) | **PAGE-LEGIT** | Keep. Superadmin-gated operator/migration surfaces; invoices are honest markdown records (live invoices arrive via webhook). |

**VERDICTS: R=6 A=2 P=0 T=0 PL=4** (12 capabilities; the "conversational billing
status" affordance below is an *opportunity*, not a current capability, so it is
not a verdict row.)

---

### Blockers (from scouting) — each with the honest alternative

**B1 — Money movement cannot become a chat action (by design).** Checkout,
portal, seat changes, coupon issuance and bundle purchase all move (or authorize
moving) real money. CLAUDE.md § Stripe surface + the skill's Law 4 require that
any money decision ride the shared HITL/approval machinery, and there is no
approval kind for "spend money" today. *Honest alternative:* keep money movement
delegated to Stripe's hosted checkout/portal (already RIDES) and, if chat ever
needs to *initiate* a purchase, it must hand off to the Stripe-hosted URL (a
link the user completes out-of-band) — never an in-chat "confirm charge" button.
This is a bound on the port, not a defect in the feature.

**B2 — There is no billing agent/tool surface at all** (`grep` → zero
`registerFeatureAgentTool` in the package). This is *not* THEATER (theater needs
a DECLARED-but-unignited capability; billing declares none). It is simply the
absence of a chat read affordance. *Honest alternative:* the single legitimate
addition is a **read-only** status tool (see New-code inventory) that SHARES the
`GET /subscription` + `GET /balance` route predicate (`requireFeatureEnabled`,
`routes.ts:69-81`) and fails EMPTY without an acting user — the ADR 0308/0315
read-tool pattern. It exposes no money action.

---

### Demolition list (with regression pins)

**None.** No bespoke "talk to AI" surface, no hand-rolled approval/submit button,
no orphaned workflow, no toothless agent, no painted status. `BillingPage.tsx` is
a read page + a delegate-to-Stripe button — the sanctioned page shape (skill Law
7). The one durable regression pin worth *adding* if the read tool below ships:

- A test asserting **no billing agent tool can mutate** — i.e. the billing pack
  allowlist contains only read tools, and no billing tool calls `createCheckoutSession`
  / `setSeats` / `createBillingCoupon` / `processStripeEvent`. (Guards against a
  future "let the agent upgrade the plan" drift that would violate B1.)

---

### New-code inventory (optional, SMALL)

Only if the team wants conversational read access to billing state:

1. **One read-only agent tool** `billing.status` (feature pack, allowlisted, not
   in the ADR 0315 default-on baseline) returning `{ plan, status, tokenBalance,
   allowedFeatures }` — composed from the EXISTING `getSubscription` /
   `getBalance` / `resolveEntitlements` service fns (`billingService.ts:216-327`).
   MUST reuse the route's `requireFeatureEnabled` predicate (one helper, route +
   tool both call it) and fail EMPTY without an acting user.
2. **Its prompt-catalog parity pin** (`promptCatalogParity`-style) so the schema
   text the model sees is generated from the resolver's types, not hand-copied.

No new workflow, no new node, no new durable row, no new envelope kind. That is
the entire honest surface — everything else is already owned.

---

### Phased plan (gated on real gates)

The feature needs no port. If the optional read tool is pursued:

- **Phase 1 (additive, non-breaking):** ship `billing.status` read tool + its
  route-predicate share + parity pin + the "no billing tool mutates" regression
  pin. Gate: `npm run ci` green. Close with `/code-review` + `/ux-review` (the
  UX check confirms the chat answer cites the same numbers the page shows — one
  SSoT). No demolition, so no "replacement works first" ordering needed.

That is the only phase. There is deliberately no phase that moves checkout /
portal / seat / coupon into chat (B1).

---

### Deferred honestly

- **Conversational purchase/upgrade** — deferred indefinitely, blocked on B1
  (no money-in-chat without a shared spend-approval kind, which does not exist).
  Stated, not faked.
- **In-app plan-change UI** — the billing *page* has no plan picker; upgrades go
  through the Stripe hosted portal (Manage) and the separate marketplace
  bundle-shop (a different feature that composes billing's HTTP reads,
  `manual-tests/suites.ts:865` is the only cross-package reference). This is an
  intentional page/delegate split, not a gap in F1.
- **Card-mechanism test:** N/A — billing renders no cards in chat (no A2UI
  surface, no typed renderer, no interrupt card). Nothing to mis-pick.

---

*Reviewed read-only. No app code, builds, or tests were modified; this file is
the sole write.*
