# Commerce Connect (F3) — chat-first port review

Scope: `backend/typescript/src/features/commerce-connect/*` + `frontend/react/src/features/commerce-connect/*`, node pack `packs/feature.commerce-connect.nodes/`. ADR 0385. Toggle OFF by default (`feature.ts:88`).

## TL;DR

Commerce Connect is a **money feature that already rides the engine's money/webhook owners honestly** and is legitimately page-shaped almost everywhere. It declares **no workflows, no agents, no `registerFeatureAgentTool`** — deliberately (`pack.json:4`: "money movement + human gates stay privileged REST, the ADR 0022 'install is not a node' rule"). That is the correct call for checkout/refund/onboarding. The review is not "make checkout a chat" — it's the two seams where it shadows an existing owner or paints a status it never surfaces:

- **The operator listing-approval queue is a second approvals inbox** — bespoke approve/reject buttons on a superadmin route (`SellerListingsCard.tsx:125-184`, `routes.ts:169-184`) duplicating `host/approvalService.ts` + the unified reviews inbox (`host/reviewProjection.ts`), for which a **non-run precedent already exists** (CMS `content-publish` handler-hook, `features/cms/contentApproval.ts`). This is the one PARALLEL.
- **"Operator review needed" is log-only** — three anomaly states (`purchase event for UNKNOWN order`, unknown Connect account, `dispute LOST — platform loss realized`) `log.error(...'operator review needed')` with **no operator-visible read** (`webhookHandlers.ts:153,53,263`). The `host/exceptionProjection.ts` owner is already fed by the sibling `kicktodo-commerce` payout-exception source (`kicktodo-commerce/exceptionSources.ts:37`). Honesty-loop gap on an otherwise PAGE-LEGIT console.

Everything else is RIDES/PAGE-LEGIT and should be left alone.

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Seller Express onboarding (start/resume → Stripe hosted link; sync) | REST + redirect (`routes.ts:39-57`, `onboarding.ts:36-144`) | **RIDES** (billing's ONE Stripe client `createStripeConnectAccount`/`AccountLink`, `onboarding.ts:9-10`) | Leave. Hosted onboarding is an external flow, not a chat |
| Seller account-state view | page read (`CommerceConnectPage.tsx:104-123`) | **PAGE-LEGIT** | Keep; honest (sync reads live Stripe, `onboarding.ts:131-143`) |
| Seller dashboard (sales stats + payouts) | page reads (`CommerceConnectPage.tsx:124-167`, `orders.ts:158-183`) | **PAGE-LEGIT** | Keep; real reads, tenant-indexed |
| `seller-stats` node (engine/chat-reachable read) | role:action read node over surface (`index.mjs:21-35`) | **RIDES** (node catalog) | Leave — but **no agent pack scopes it**, so no seller can ask about sales in chat today (opportunity, below) |
| Browse listings + purchase (destination-charge checkout) | REST money write (`routes.ts:66-90`, `orders.ts:77-155`) | **RIDES** (billing Stripe destination charge + application fee) | Leave. Money write = privileged REST, correctly NOT a node |
| Seller listing editor (upsert lane/price) | bespoke form (`SellerListingsCard.tsx:28-123`, `listings.ts:15-58`) | **PAGE-LEGIT** | Keep (low-freq structured write w/ approval gate); optional agent tool noted |
| **Operator listing-approval queue (approve/reject)** | bespoke buttons → superadmin route (`SellerListingsCard.tsx:125-184`, `routes.ts:169-184`, `listings.ts:63-71`) | **PARALLEL** (approvalService + reviews inbox owner) | `kind:'commerce-listing-publish'` approval + handler-hook (CMS precedent) → the SAME reviews inbox |
| Operator admin console (recent orders + disputes + loss ledger) | bespoke card reads (`AdminConsoleCard.tsx`, `adminOps.ts:15-26`) | **PAGE-LEGIT** (honesty-loop gap) | Keep the reporting; **feed `registerExceptionSource`** for the log-only anomalies |
| Operator full refund (reverse_transfer) | superadmin REST + `confirm()` (`AdminConsoleCard.tsx:46-52`, `adminOps.ts:37-57`) | **RIDES** (billing Stripe refund; order flips on webhook, not the API call) | Leave |
| Operator application-fee config (get/set, clamped 10–15%) | superadmin REST, **no UI** (`routes.ts:226-241`, `orders.ts:28-40`) | **PAGE-LEGIT** | Keep; UI-less operator config (deferred honestly / API-only) |
| Operator MyndHyve seller importer (id-preserving) | superadmin REST, one-time tool (`routes.ts:216-223`, `adminOps.ts:64-93`) | **PAGE-LEGIT** | Keep; operator migration tool, API-only |
| Connect/purchase/refund/dispute/payout webhook handling | `connectEventHook` handler (`webhookHandlers.ts:28-74`, `feature.ts:24`) | **RIDES** (billing's ONE webhook, ONE client — money-truth rule honored) | Leave |
| Marketplace pricing annotation | `listingPricingHook` provider (`feature.ts:27-31`, `listings.ts:105-140`) | **ADAPTER** (thin over marketplace's Listing owner) | Leave; watch for drift |

**Counts: RIDES 5 · ADAPTER 1 · PARALLEL 1 · THEATER 0 · PAGE-LEGIT 6.**

## Blockers (from scouting) — each with the honest alternative

**B1 — There is no orchestration to port, and that is correct.** No `WorkflowDefinition`, no agent pack, no `registerFeatureAgentTool` anywhere in the feature (grep clean); the only pack is the single read node. Do NOT invent a "checkout workflow" or a "seller agent that moves money." Money movement (`createCheckout`, `refundOrder`, `startOnboarding`) is fail-closed privileged REST sharing billing's ONE Stripe client, exactly per CLAUDE.md's Stripe invariants and ADR 0022. The chat-first surface area here is small by design — the ignition test is satisfied vacuously (nothing declared to ignite), not violated.

**B2 — approvalService is org/tenant-scoped; listing approval is host-global superadmin.** The listing-approval port (below) must NOT assume the generic approvals route's tenant-scoped authority. The CMS precedent already solves this: `content-publish` approvals enforce their OWN authority inside the handler (`contentApproval.ts` header: "Authority is unchanged from the direct routes … enforced HERE"). A `commerce-listing-publish` handler enforces `requireSuperadmin` itself, identically. Composes — but the port is a handler-hook registration, not a call into the generic tenant-scoped path.

**B3 — the reviews-inbox interrupt-scan is global-then-filtered (ADR 0068 known limit, `reviewProjection.ts:33-44`).** For a host-global superadmin approval this is a non-issue (single operator inbox), but the port should register listing approvals on the **approval** source (durable rows), not the interrupt source, so the 500-row OPEN-interrupt scan bound never applies to them.

## Demolition list (with regression pins to add)

- **`ApprovalQueueCard` bespoke approve/reject** (`SellerListingsCard.tsx:125-184`) and its client calls `listApprovals`/`decideApproval` — demolish once listing approvals render in the reviews inbox. **Pin:** a test asserting a pending native-paid/external-link listing produces a `PendingApproval` row of `kind:'commerce-listing-publish'` and that resolving it via the reviews route flips `approvalState` (a resurrected standalone queue fails because the row now lives in the approval store).
- **Nothing else demolishes.** The seller dashboard, admin console reporting, onboarding page, listing editor, fee-config/importer routes are all PAGE-LEGIT and stay. The refund `confirm()` (`AdminConsoleCard.tsx:47`) is a client guard on an already-superadmin money action, not a duplicate of the HITL gate — keep.

## New-code inventory (small)

1. **`commerce-listing-publish` approval kind + handler-hook** — on submit of a native-paid/external-link listing (`upsertPaidListing`, `listings.ts:43-52`), instead of writing `approvalState:'pending'` as private state, create a `PendingApproval` (approvalService) and register a `registerCommerceListingApprovalHandler` (mirror `registerContentApprovalHandler`) that enforces `requireSuperadmin` and flips the listing on approve/reject. The seller's own listing row keeps a derived `approvalState` mirror for its editor badge.
2. **One `registerExceptionSource('commerce-connect:anomalies', …)`** (~30 lines, mirror `kicktodo-commerce/exceptionSources.ts`) surfacing: paid orders never fulfilled / purchase-event-without-order, disputes with realized platform loss, unknown-Connect-account events. Deep-link `href:'/commerce-connect'` (or the admin console). Turns three `log.error` anomalies into operator-visible `action-required` rows.
3. **(Optional, opportunity) a seller agent pack + `sellerStats` allowlist** so "how are my marketplace sales / when did I last get paid?" answers in the ONE chat via the existing `seller-stats` node — the node is built and unused by any persona today.

No new stores, no new wire, no new node beyond the optional agent pack. All host-extension.

## Phased plan (real gates)

- **Phase 1 — honesty seam first (additive, no demolition).** Add the `registerExceptionSource` anomaly source (#2). Ships operator visibility for the "review needed" states that are log-only today. Close with `/code-review` + `/grade-data` (it's a projection over existing rows) and apply fixes. No user-facing removal.
- **Phase 2 — approval owner.** Add the `commerce-listing-publish` approval kind + handler-hook (#1); render listing approvals in the reviews inbox; keep the bespoke queue live behind it until parity is proven. Close with `/code-review` + `/architect` (authority-parity: the handler must enforce superadmin exactly as the route does).
- **Phase 3 — demolish the bespoke queue.** Remove `ApprovalQueueCard` + its client methods; land the regression pin. Only after Phase 2 parity is green.
- **Phase 4 — (optional) seller agent pack.** Ship the persona + `sellerStats` allowlist so the read node is chat-reachable. Close with `/grade-ai-exchange`.

## Deferred honestly

- **Application-fee config has no UI** (`routes.ts:226-241` exist; no card renders them). Operator sets fees via API only. State this in the ADR/console rather than implying a settings screen exists.
- **`external-link` lane annotates a seller-supplied https URL onto the marketplace** — already approval-gated (CC-2, `listings.ts:44-52`, `listings.ts:115-119`) and anon tenants can never onboard (`onboarding.ts:48-49`). No port needed; noted as the standing phishing-surface invariant the reviews-inbox port must preserve (the approval decision stays superadmin, never the seller).
- **Cross-region native purchase is refused, not routed** (`orders.ts:117-120`) — v1 sends cross-region buyers to the seller's external link. Honest limitation, not a defect to port.
