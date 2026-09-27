# E-commerce + UCP (unit F2) — chat-first port review

Scope: `backend/typescript/src/features/commerce` (incl. `ucp/` server + `ucpBuyer/`),
`frontend/react/src/features/{commerce, commerce-ucp, commerce-ucp-buyer}`.
Toggles: `commerce`, `commerce-ucp`, `commerce-ucp-buyer` (all OFF by default,
`backend/typescript/src/features/commerce/feature.ts:88-113`).

**Headline verdict:** the money-movement machinery is *excellent* and genuinely
rides the engine — the buyer checkout gate is a real `approvalService` sign-off
in the reviews inbox, the UCP server exposes real MCP-ignited workflows, and the
Stripe/affiliate/subscription seams all instantiate their owners. But the ONE
chat-first surface each half of this unit advertises — the **Store Assistant**
and the **Procurement Concierge** — is **pure THEATER**: both agents' entire
tool allowlists are node typeIds that are **never projected into conversational
tools**, so at dispatch they resolve to **zero callable tools**. The Store
Assistant is wired live into the commerce admin UI
(`CommercePage.tsx:882`) and the Concierge is the buyer half's only advertised
driver — both look real and do nothing.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | **Store Assistant** chat (browse catalog, place/track/fulfill/refund orders, inventory, coupons, quotes) | `EmbeddedChatPanel` scoped to `feature.commerce.agents.store-assistant`, allowlist = 13 `openwop:feature.commerce.nodes.*` ids | **THEATER** | Register those 13 nodes as agent tools (`registerFeatureAgentTool`) → the embed becomes real |
| 2 | **Procurement Concierge** chat (discover/search external UCP merchants, build AP2 cart, checkout, track) | `feature.commerce.buyer.agents.procurement-concierge`, allowlist = 6 `openwop:feature.commerce.buyer.nodes.*` ids; not wired into ANY FE | **THEATER** | Same registration; deep-link the ONE chat from the buyer page |
| 3 | Buyer **checkout money gate** (fail-closed org cap + ALWAYS human sign-off) | `checkoutPurchase` → `createCommerceSpendApproval`/`getApproval` | **RIDES** | Leave alone — this is the reference implementation |
| 4 | Order **spend-approval thresholds** (over-threshold order/refund pauses) | `commerceService` recorded-action + approval thresholds | **RIDES** | Leave alone |
| 5 | **UCP server MCP tools** (`ucp-catalog-search`, `ucp-place-order`) | built-in 2-node workflows, `mcpServerRegistry` ignition (RFC 0020) | **RIDES** | Leave alone — real external-agent ignition |
| 6 | **Subscriptions** recurrence (billing `invoice.paid` → recurring order) | `registerSubscriptionRecurrence()` seam | **RIDES** | Leave alone |
| 7 | **Affiliate** commission ledger | `backfillAffiliateLedger` over `obligationLedger` | **RIDES** | Leave alone |
| 8 | **Subject erasure** / saved-PM prune | `registerSubjectEraser`, `onCrmRecordDeleted` seams | **RIDES** | Leave alone |
| 9 | **Transactional email** (order confirmations) | brokered email spine (`sendBrokeredTransactionalEmail`) | **ADAPTER** | Leave; watch for drift |
| 10 | Buyer **REST action routes** (discover/search/build-cart/checkout/track) | `ucpBuyer/routes.ts` thin over the service | **ADAPTER** | Leave; but note (cap #2) they have no live driver today |
| 11 | **UCP REST/OAuth conformance surface** (`/.well-known`, catalog/cart/checkout projection) | `ucp/routes.ts` projects commerce, no new store | **ADAPTER** | Leave — protocol conformance, machine-shaped |
| 12 | **Product catalog** admin CRUD (`ProductsTab`) | bespoke forms → REST | **PAGE-LEGIT** | Keep; capability #1 should also drive these via chat |
| 13 | **Order** admin (`OrdersTab`: view/fulfill/refund) | bespoke forms → REST | **PAGE-LEGIT** | Keep |
| 14 | **Quotes** admin (`QuotesTab`: create/send/accept/decline) | bespoke forms → REST | **PAGE-LEGIT** | Keep |
| 15 | **Pricing / price-lists / coupons** admin (`PricingTab`) | bespoke forms → REST | **PAGE-LEGIT** | Keep |
| 16 | **Reports** (`ReportsTab`) | read-only reporting | **PAGE-LEGIT** | Keep |
| 17 | **Public storefront** (browse/checkout/one-click/quote-accept) | `StorefrontPage` + public routes | **PAGE-LEGIT** | Keep — public commerce, not an AI surface |
| 18 | **UCP admin config** (provision clients, endpoints) | `CommerceUcpPage` | **PAGE-LEGIT** | Keep — structural config |
| 19 | **Buyer purchases** list/detail | `PurchasesPage`/`PurchaseDetailPage`, read-only | **PAGE-LEGIT** | Keep; complete the honesty loop (surface the pending-approval state) |

**Counts:** RIDES=6, ADAPTER=3, PARALLEL=0, THEATER=2, PAGE-LEGIT=8.

(No PARALLEL: money correctly rides `approvalService`, there is no second chat
system — the admin uses the shared `EmbeddedChatPanel` — and no bespoke
approve/submit button duplicating the reviews inbox.)

---

## Blockers (from contract scouting) — each with the honest alternative

### BLOCKER 1 — The two commerce agents have ZERO callable tools (the whole chat-first surface is dead)

The unit ships two manifest agents whose personas describe rich action
(`feature.commerce.agents/pack.json` — Store Assistant "place/track orders, run
order ops (fulfillment, refunds), manage inventory and coupons";
`feature.commerce.buyer.agents/pack.json` — Concierge "build a cart… request the
… checkout"). Their `toolAllowlist`s are **entirely node typeIds**:

- Store Assistant: 13 × `openwop:feature.commerce.nodes.*`
- Concierge: 6 × `openwop:feature.commerce.buyer.nodes.*`

But the conversational tool loop only offers tools that are in the **builtin tool
universe**:

- `conversationToolLoop.ts:304` — `compileAgentTools(agent, builtinAgentToolIds(), …)`
- `agentDispatch.ts:185-189` — `filterTools` returns `available.filter(t => allow.has(t))`, i.e. it **starts from the builtin ids** and keeps those the agent allows.
- `agentToolProvider.ts:413-422` — `BUILTINS` contains only the static platform tools (`knowledge.search`, `ai.research.web`, `http.fetch`, `code-exec`, `kanban.add-todo`, `schema.lookup`, RAG retrievers) **plus a hardcoded two-entry `PROJECTABLE_COMPUTE_NODE_TYPE_IDS`** (`agentToolProvider.ts:50` — two `insights-suite` nodes) **plus whatever features register via `registerFeatureAgentTool`** (`agentToolProvider.ts:441`).

**Commerce registers nothing.** `feature.ts` has no `agentTools.ts` import and no
`registerFeatureAgentTool` call anywhere (grep of `src/features/commerce*` for
`registerFeatureAgentTool` → 0 hits; contrast: cdp, goals, kicktodo, documents,
media, slides, service-desk, app-builder, projects, bi, entities all have an
`agentTools.ts`). So every id in both allowlists is filtered OUT at
`agentDispatch.ts:187`, and both agents dispatch with an empty tool set. A user
who opens the commerce admin's Assistant tab (`CommercePage.tsx:877-884`) and
says "place an order for 3 widgets" gets a model that can only talk.

**Why it passed review / CI:** the drift-guard `agent-prompt-tool-ids.test.ts`
builds its "real tool universe" from **pack-declared node typeIds** (test
step 1, `agent-prompt-tool-ids.test.ts:29-35`) — so `feature.commerce.nodes.create-order`
*resolves* because it exists as a node typeId in `packs/feature.commerce.nodes/pack.json`.
The lint verifies the id **exists**, not that it is **projected into the chat
tool loop**. This is a false-comfort gap and is exactly the cross-cutting
pattern flagged for this sweep.

**Honest alternative:** add `backend/typescript/src/features/commerce/agentTools.ts`
(+ a buyer twin) that calls `registerFeatureAgentTool` once per allowlisted node
id, each `run()` invoking the same `commerceService` method the backing node's
`index.mjs` calls (`packs/feature.commerce.nodes/index.mjs:14-27`,
`packs/feature.commerce.buyer.nodes/index.mjs:15-37`) and sharing the routes'
authorization predicate (fail-typed for actions). This is the ADR 0308
`registerFeatureAgentTool` pattern already proven by ~15 other features. Once
registered, the existing `EmbeddedChatPanel` embed at `CommercePage.tsx:882`
becomes real with **zero** new UI. This is a small, high-value port.

### BLOCKER 2 — Buyer checkout is a throw-and-retry, not a native run-suspend/resume HITL

`checkoutPurchase` (`ucpBuyer/ucpBuyerService.ts:302-351`) correctly rides the
approvals owner: it creates a real `createCommerceSpendApproval`, persists the
purchase as `awaiting_approval` with the `approvalId`, and on re-checkout reads
`getApproval` and refuses unless `approved` (`:336-351`). But it does this by
**throwing** `OpenwopError('approval_required', …, 409)` rather than suspending
the run into a shared gate. The buyer `checkout` node
(`packs/feature.commerce.buyer.nodes/index.mjs:27-29`) just calls
`ctx.features.commerce.ucpCheckout`, so a **workflow-** or **agent-driven**
checkout will surface the approval as a **node failure**, not an inline HITL
interrupt card. The human still approves in the reviews inbox and the caller
re-invokes — money-safe, but not the ideal "gate renders inline in the
conversation" experience the skill's HITL test wants.

**Honest alternative (deferred):** for the agent-tool port, the checkout tool's
`run()` should catch `approval_required` and return a typed
"pending sign-off in reviews inbox" result the model reports, then the human
approves and the user asks to retry. A native run-suspend interrupt would need
the node to `ctx.suspend` on the approval — a larger executor change. Keep the
service's throw-based gate (it is the authoritative money guard,
`ucpBuyerService.ts:362-368` re-counts under the `placing` claim); layer the
inline card later. Record as deferred, don't fake it.

### BLOCKER 3 — Buyer actions have no live driver at all today

The buyer half's REST routes work (`ucpBuyer/routes.ts:26-67`), but: the
Procurement Concierge (their intended chat driver) is dead (Blocker 1); there is
**no admin UI** that drives discover/search/build-cart/checkout (the buyer FE is
read-only — `PurchasesPage.tsx` and `PurchaseDetailPage.tsx` have only reload /
filter buttons, no build/checkout action); and `procurement-concierge` is
referenced **nowhere** in `frontend/react/src` (grep → 0 hits). So the entire
outbound-purchasing capability is currently reachable only by hand-rolled REST
calls or a hand-authored workflow. Fixing Blocker 1 + deep-linking the chat is
what makes this capability exist for a user.

---

## Demolition list (with regression pins to add)

Very little bespoke UI to demolish — the commerce admin CRUD, storefront, UCP
config, and buyer purchase list are all PAGE-LEGIT. The port is **additive**
(register the tools), not a teardown. The demolitions are of the *illusions*:

| Demolish | Because | Regression pin |
|---|---|---|
| The claim that the Store Assistant / Concierge can act | Both resolve to zero tools | A test that dispatches each agent and asserts `compileAgentTools(...).length > 0` (and equals the allowlist size) — would fail today, passes after the port. This is the missing test the drift-lint should have been. |
| The false-comfort scope of `agent-prompt-tool-ids.test.ts` | It checks id existence, not chat-tool projection (`:29-35`) | Add a companion assertion: every `openwop:`-prefixed id in an agent `toolAllowlist` is either in `builtinAgentToolIds()` **or** a projectable/registered agent tool — NOT merely a declared node typeId. (Cross-cutting — file as a platform TODO, this unit surfaced it.) |

---

## New-code inventory (small)

1. `backend/typescript/src/features/commerce/agentTools.ts` — 13
   `registerFeatureAgentTool` entries (one per Store-Assistant allowlist id),
   each `run()` calling the matching `commerceService` method (the same methods
   `packs/feature.commerce.nodes/index.mjs` calls), sharing the route
   authorization predicate; catalog/get/list = read (fail EMPTY), create/fulfill/
   refund/adjust/coupon/quote = action (fail TYPED). Invoked from `feature.ts`
   `registerRoutes`.
2. `backend/typescript/src/features/commerce/ucpBuyer/agentTools.ts` — 6 entries
   for the Concierge; `checkout` catches `approval_required` → typed pending
   result (Blocker 2).
3. A buyer-page deep-link into the ONE chat scoped to the Concierge
   (`navigate('/?agent=feature.commerce.buyer.agents.procurement-concierge')`)
   from `PurchasesPage` — no new chat surface.
4. Two tests: the "agents have non-empty tools" pin, and the drift-lint
   projection assertion (above).

No new nodes, no new workflow, no new store, no new owner — the service, nodes,
approvals, and chat panel all already exist.

---

## Phased plan (gated on `npm run ci`)

- **Phase 1 (compliance seam first):** add the drift-lint projection assertion +
  the "agents have tools" test. They go RED, proving the THEATER. (Never
  demolish the illusion before the replacement works — here the replacement is
  the registration.)
- **Phase 2:** ship `commerce/agentTools.ts` (Store Assistant). Tests from
  Phase 1 go green; the existing `CommercePage.tsx:882` embed is now functional.
  Close with `/code-review` + `/ux-review`.
- **Phase 3:** ship `ucpBuyer/agentTools.ts` (Concierge) with the
  `approval_required` typed-result handling, + the buyer-page chat deep-link.
  Verify the money gate still fails closed (org cap unset ⇒ deny;
  `ucpBuyerService.ts:328-332`). Close with reviews.
- **Phase 4 (deferred):** native run-suspend HITL card for buyer checkout
  (Blocker 2) — only if/when the executor gains node-level approval-suspend.

---

## Deferred honestly

- **Inline HITL card for buyer checkout** — today the approval is a thrown 409 +
  a reviews-inbox entry, not an inline interrupt card. Money-safe; UX-deferred
  (Blocker 2 / Phase 4). Do not paint it as an inline gate.
- **Session-keyed subject erasure → orders** — `feature.ts` erasure covers a
  `contactId`-keyed subject fully but a CDP `sessionKey`-keyed one races the
  analytics identity-link eraser (noted in-code as PRIV-2). Pre-existing,
  out of this unit's port scope.
- **A2A transport for the commerce agent** — the ADR 0178 next increment; MCP
  leads (`ucpMcpTools.ts`). Not built; not claimed as built.
