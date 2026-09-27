# ADR 0188 — Universal Commerce Protocol (UCP) buyer/client half — agentic outbound shopping

**Status:** implemented (Phases 1–3 floor + Phase 4 packs — 2026-07-03, ADR 0228; see the correction note)
**Date:** 2026-07-02
**Track:** A (Software & App Architecture) — **extends** the `commerce` feature (ADR 0177)
with a UCP **client** (buyer) surface, the deliberately-deferred other half of the UCP
**server** (merchant) adapter (ADR 0178 § Decomposition). Lets THIS host's agents/workflows
**discover, cart, pay (AP2), and track** purchases against **external** UCP merchants.
**No OpenWOP wire change → no OpenWOP RFC** (outbound consumption of a THIRD-PARTY protocol,
symmetric to the 0178 server side; it rides already-Accepted RFCs 0020/0079/0095 as
mechanism, and advertises nothing at `/.well-known/openwop`). See § RFC gate.
**PRD source:** UCP spec, https://ucp.dev/ (Apache-2.0) + AP2 (Agent Payments Protocol) —
the buyer role: an agent presents signed **mandates** (Intent → Cart → Payment) to a
merchant and remains the payer while the merchant stays Merchant of Record.
**Owner:** EXTENDS `backend/typescript/src/features/commerce/` with a new `commerce/ucpBuyer/`
module (symmetric to the server's `commerce/ucp/`) — NOT a new package. Co-located so the
AP2 mandate types are shared with the merchant-intake path.
**Toggle:** `commerce-ucp-buyer` (default **OFF**, `bucketUnit: tenant`) gating the outbound
buyer surface; independent of `commerce` and of `commerce-ucp` (the server).
**Composes (does NOT fork):** the **outbound MCP client** (`host/mcpClient.ts` — "the missing
other half of RFC 0020", `ctx.mcp.*`), **Connections** (`features/connections/` — the external
merchant credential as a provider manifest + per-user credential broker, ADR 0024 / RFC 0095),
the **tool-approval ledger + capability-firewall** (`host/conversationToolLoop.ts`
`approvalLedger` + `capability-firewall/firewallHook.ts` `SENSITIVE_APPROVAL_TOOLS` →
`interrupt.approval` cards) for the HITL spend gate, the **SSRF-guarded egress dispatcher +
egress policy** (RFC 0079 credential-provenance-and-egress-policy), the **AP2 module**
(`commerce/ucp/ap2.ts` — extend with the buyer-authored typed mandates), **Notifications**
(order-status), and **Media** (product images from the external catalog).

> **What the buyer half is.** The mirror of ADR 0178. There, external agents shop OUR
> catalog. Here, OUR agents shop THEIRS: a workflow/agent discovers an external UCP
> merchant, searches its catalog, builds a cart, and — **only after a human approves the
> spend** — issues an AP2 PaymentMandate and places the order, then tracks it. The host is
> the **payer/buyer**; the external merchant is Merchant of Record.

---

## Context — boundaries & pre-existing-surface audit (done first)

A read-only scout mapped every UCP file + the outbound seams. Findings:

**1. The entire existing `commerce/ucp/` surface is the merchant/seller half — zero buyer
code.** `ucpClientStore.ts:6-12` is explicit: it is the app-as-OAuth-**server** (token
*issuer*), and *"That is a DIFFERENT OAuth role from Connections' `oauthClientStore` (the
app-as-OAuth-CLIENT to EXTERNAL providers — outbound). We deliberately do NOT overload that
store."* The buyer half is genuinely net-new; nothing to duplicate or extend on the
merchant surface except the AP2 types.

**2. The generic outbound seams the buyer must ride already exist and are owned:**

| Buyer-half layer | Existing openwop-app owner (compose, don't fork) |
|---|---|
| Outbound transport to a merchant | **`host/mcpClient.ts`** — the host-as-MCP-**client** (RFC 0020's other half): resolves a `reach:'mcp'` Connections provider (`mcpServer.url`), runs the egress governance gate, resolves a per-user credential, JSON-RPC POSTs over the **SSRF-guarded egress dispatcher**, marks results `untrustedContent`. Surfaced as `ctx.mcp.{invokeTool,readResource,listTools,serverStatus}`. The UCP discovery doc already reserves `mcp: null` for this (`ucpAdapter.ts:95`). REST-only merchants ride the same egress dispatcher directly. **No new outbound HTTP client.** |
| External-merchant credential | **`features/connections/`** (ADR 0024 / RFC 0095) — `providerRegistry` already models `CredentialKind = oauth2\|api_key\|bearer\|…`, `ProviderReach = 'mcp'\|'openapi'`, and `mcpServer?: { url; transport }`. A UCP merchant is a **provider manifest** (a connection pack), with secrets in the BYOK envelope via `connectionsService`. **No new credential store.** |
| HITL spend gate | **The tool-approval ledger** — `mcpApproval: 'always'\|'conditional'\|'never'` tool metadata (`mcpServerRegistry.ts:71`), enforced in `host/conversationToolLoop.ts` (`approvalLedger`) + `capability-firewall/firewallHook.ts` (`SENSITIVE_APPROVAL_TOOLS`), surfaced as `interrupt.approval` cards. Notebooks' write tool (`mcpApproval:'always'`) is the precedent. **No new approval gate.** |
| Egress policy / provenance | **RFC 0079** (credential-provenance-and-egress-policy) — the merchant URL + credential run through the existing egress allow/deny + SSRF guard. |
| Order-status / receipts | **Notifications** (ADR 0010) — external order transitions notify the buyer. |
| Product images | **Media** (RFC 0055) tokens, as commerce already does. |

**3. AP2 mandate TYPES do not exist yet.** `commerce/ucp/ap2.ts` reads an *untyped* inbound
`body.ap2_mandate` (`Record<string, unknown>`, pulling only amount/currency/id;
`ap2.ts:34,43-55`) and honestly reports the VC as **not verified** (`:51-52`). The buyer half
must **author** the typed `IntentMandate` / `CartMandate` / `PaymentMandate` shapes + the
signing/creation logic, co-located with `ap2.ts`, so the merchant-intake path can later
consume the same shared types (today intake is loosely-typed). **Shared file to extend, not
reusable types to import.**

**4. `host/managedBalanceHook.ts` is NOT the spend gate.** Despite the name it is the prepaid
**AI-token** balance seam (ADR 0176 — `available`/`draw` tokens for LLM metering). It has
nothing to do with buying goods. **Explicitly do not attach buyer-spend here.**

**5. The buy-side purchase is a distinct entity from the sell-side `Order`.** Commerce `Order`
(`commerceService.ts:125-135`) is strictly sell-side: `tenantId/orgId` = the merchant (us),
`contactId` = the CRM customer, `items` = products we sell, `paymentIntentId` = payment we
*receive*. A buyer purchase is the opposite direction (we pay an external merchant; no
`contactId`; a `merchantConnectionId` + AP2 mandate chain + `approvalId` + `buyerSubject`;
an *external* order id). A **new `UcpPurchase` store is justified** — it is not a duplicate of
`Order`; commerce owns sell-side, this feature owns buy-side. Single-source-of-truth is
preserved by direction.

**6. MyndHyve baseline: none.** MyndHyve commerce is merchant/seller only (Stripe
checkout/webhooks/`markAsPaid`); no UCP, no AP2, no agentic purchase. Net-new; compose
openwop seams (not a port).

**Collision-free:** no `ucpBuyer` / buyer route/namespace/type exists; `commerce-ucp-buyer`
toggle and a `feature.commerce.buyer.*` pack slug are unclaimed. The buyer surface is
**outbound/internal** — it registers **no** public route (the opposite of the server's
`PUBLIC_PATH_PREFIXES` surface).

## RFC gate (the key question) — **host-extension, NO OpenWOP RFC**

Consuming UCP outbound does **not** touch the OpenWOP wire — symmetric to ADR 0178:
- It adds **no** OpenWOP run-event field, event type, normative MUST, or capability flag in
  `/.well-known/openwop`. UCP is a THIRD-PARTY protocol; being its *client* is exactly the
  class of `host/mcpClient.ts` being an *outbound MCP client* (rides **already-Accepted**
  RFC 0020 as mechanism) and of any outbound connector (RFC 0079/0095).
- AP2 is UCP's built-in payment layer, not OpenWOP's — authoring buyer-side mandates implies
  no OpenWOP RFC.
- ⚠️ **The one thing that WOULD need an OpenWOP RFC** (and is rejected): advertising a
  `capabilities.ucpBuyer` block in `/.well-known/openwop` so other OpenWOP hosts discover
  "this host can shop UCP." We do **not** — buyer capability is internal; UCP interop is
  UCP's own discovery. (Symmetric to the 0178 § "cross-OpenWOP-host UCP negotiation" note —
  the sole future wire-RFC case.)
- **Honesty:** advertise/enable nothing that isn't wired. Real AP2 verifiable-credential
  signing + live settlement are demo-mode-gated (below); the surface reports
  `payment.warnings` when a mandate is unsigned/unverified, never silently "paid."

## Decision

Add a **UCP client (buyer) surface** to `commerce` as a new `commerce/ucpBuyer/` module,
gated by `commerce-ucp-buyer` (OFF): the host's agents/workflows **discover → search → cart →
(HITL-approved) pay → track** against external UCP merchants. It **composes** the outbound
MCP client (transport), Connections (merchant credential), the tool-approval ledger +
capability-firewall (the mandatory spend gate), and the egress policy (RFC 0079). It
**authors** the typed AP2 mandate chain alongside `ap2.ts`, and persists buy-side purchases
in a **new `UcpPurchase` store** distinct from the sell-side `Order`. The host is the
payer/buyer; nothing is advertised on the OpenWOP wire.

### The mapping (UCP buyer ⇄ existing seams — one new store)
```
External UCP merchant       ⇄  a Connections provider manifest (reach:'mcp'|'openapi', oauth2) + per-user credential
Merchant discovery doc      ⇄  fetched via the egress dispatcher; `.well-known/ucp` cached per connection
Catalog search              ⇄  ctx.mcp.invokeTool (MCP merchant) / egress GET (REST) → UCP catalog shapes
Cart + "what I authorized"  ⇄  an AP2 IntentMandate → CartMandate (buyer-authored, typed; new in commerce/ucpBuyer/ap2Mandates.ts)
Checkout (money movement)   ⇄  a PaymentMandate, GATED by mcpApproval:'always' → interrupt.approval (approvalLedger + firewall)
Placed purchase + tracking  ⇄  a NEW UcpPurchase record (merchantConnectionId, mandate chain, approvalId, buyerSubject, extOrderId, status)
Order-status changes        ⇄  Notifications (ADR 0010)
```
Tenant/org is the **buyer's** own tenant (never request-derived from an external party).
Money movement is **fail-closed**: no approval ⇒ no PaymentMandate; over a per-org spend cap
⇒ deny.

### PRD-vs-architecture corrections ("port, not clone" — here, "compose, not build")
| UCP/AP2 assumption | Correction here | Why |
|---|---|---|
| A UCP client needs its own HTTP/JSON-RPC merchant client | **Ride `host/mcpClient.ts` (MCP merchants) / the egress dispatcher (REST)** | RFC 0020's outbound half + the SSRF-guarded egress already own outbound calls |
| A buyer needs its own OAuth-consumer + credential store | **Compose Connections** (`oauthClientStore`/`connectionsService`, a provider manifest) | One outbound-credential system (`ucpClientStore.ts:6-12` says so explicitly) |
| An agent-tool-that-spends-money needs a bespoke approval flow | **Declare `mcpApproval:'always'`; ride the tool-approval ledger + firewall → `interrupt.approval`** | The HITL spend gate already exists; notebooks-write is the precedent |
| Attach spend to `managedBalanceHook` (it "has balance in the name") | **NO — that is AI-token metering**; buyer-spend is unrelated | Mis-attachment would draw LLM tokens, not gate money |
| AP2 mandate types can be imported from `ap2.ts` | **Author them**; `ap2.ts` intake is untyped — put typed mandates beside it and share | No reusable types exist yet; keep merchant-intake + buyer symmetric |
| Buy-side purchases extend the commerce `Order` | **New `UcpPurchase` store** (opposite direction, no `contactId`, has `merchantConnectionId`+mandates) | `Order` is sell-side SSoT; direction keeps them non-overlapping |
| Advertise buyer capability on the OpenWOP wire | **NO** — internal capability; UCP interop is UCP's discovery | Keeps it a host-extension; a wire advert would need an OpenWOP RFC |

## Phased implementation plan

- **Phase 1 — Merchant connection + discovery + read-only browse (outbound).** A Connections
  provider manifest for a UCP merchant (`reach:'mcp'|'openapi'`, oauth2); the connect flow
  reuses `connections/oauthFlow.ts`. Fetch + cache the merchant's `.well-known/ucp` through
  the egress dispatcher (RFC 0079 gate). Read-only ops: **discover** + **searchCatalog** (via
  `ctx.mcp.invokeTool` for MCP merchants, egress GET for REST). `commerce-ucp-buyer` toggle
  (OFF, tenant). Route-harness tests: connection resolve, discovery fetch through the egress
  gate, catalog projection, tenant isolation, **fail-closed on missing/denied connection**.
- **Phase 2 — Cart + AP2 mandate authoring (no money yet).** Author typed `IntentMandate` /
  `CartMandate` / `PaymentMandate` in `commerce/ucpBuyer/ap2Mandates.ts` (co-located with the
  server's `ap2.ts`; refactor intake to consume the shared types). Build a cart against the
  merchant → an `IntentMandate` (what the user authorized) → a resolved `CartMandate`. Persist
  a **draft `UcpPurchase`**. Tests: mandate construction, amount/currency integrity, the
  RFC 0093 **idempotency key** on mandate creation, `UcpPurchase` tenant isolation.
- **Phase 3 — Checkout with the HITL spend gate + tracking.** The checkout op declares
  `mcpApproval:'always'` → `interrupt.approval` (approvalLedger + firewall `SENSITIVE_APPROVAL_TOOLS`).
  On approval: create a `PaymentMandate` (signed with a host-side BYOK key — never in
  payload/logs) → place the order (demo-mode: record the merchant's returned external order id;
  live settlement deferred). Enforce a **per-org spend cap fail-closed**. Track external order
  status → Notifications. Tests: **approval-gated (no approval ⇒ no spend)**, **idempotent
  payment (retry ⇒ no double-charge)**, spend-cap denial, VC-not-verified honesty in
  `payment.warnings`, status tracking.
- **Phase 4 — Core-app extension surface: node pack + agent + frontend.**
  - **Node pack `feature.commerce.buyer.nodes.*`** (the real new workflow surface):
    `discover`, `searchCatalog`, `buildCart`, `checkout` (interrupt-gated), `trackOrder` —
    signed pack via the registry (Ed25519 + SRI), `requiredPacks`.
  - **Agent pack `feature.commerce.buyer.agents`** — a **Procurement/Shopping concierge** that
    drives the node pack through the existing chat (the ADR 0058 "chat-drivability = agent +
    nodes" pattern; **no new chat UI** — deep-link/embed the shared `chat/`). This IS an AI
    surface (unlike the inbound server), so an agent is honest here, not "none".
  - **Frontend package `commerce-ucp-buyer`**: connect a merchant, browse its catalog, build a
    cart, the **approval card** on checkout, and a purchase-history view. `ui/` tokens + focus
    rings + designed empty/loading/error states + 4-locale i18n (parity-checked).
- **Deferrals (honest, logged — not scope cuts):**
  - **Live AP2 VC signature verification + real settlement** — demo-mode records the merchant's
    external order id; full verifiable-credential signing/verification + real payment capture
    are operator last-mile (live payment creds — the ADR 0176/0177 posture). Always surfaced in
    `payment.warnings`.
  - **REST-only merchants beyond MCP** — Phase 1 targets MCP-transport merchants (rides
    `ctx.mcp`); REST-only rides the same egress dispatcher but a fuller REST catalog/cart client
    is more code — gate it on a real REST-only merchant fixture, not speculatively.
  - **Multi-merchant cart / price-comparison shopping** — a discovery-aggregation layer over N
    merchant connections; a distinct future capability once single-merchant buy is proven.

## Feature Evaluation Matrix (extension of commerce)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | **Extends** `features/commerce/` (new `commerce/ucpBuyer/` module); AP2 mandate types co-located with the server's `ap2.ts`. No core edits. |
| 2 | Toggle | **`commerce-ucp-buyer`** (OFF, `tenant`), independent of `commerce` and `commerce-ucp`. |
| 3 | `ctx.<feature>` | Rides **`ctx.mcp.*`** (outbound transport) + a thin `ctx.features.commerceBuyer` for the higher-level shop ops driven by the node pack. |
| 4 | Node pack | **`feature.commerce.buyer.nodes.*`** — discover/search/buildCart/checkout(interrupt-gated)/trackOrder. The genuine new surface (the buyer is agent-driven). |
| 5 | AI-chat envelopes | None new — the concierge agent reaches the nodes via the existing chat tool-loop. |
| 6 | Agent pack | **`feature.commerce.buyer.agents`** — a Procurement concierge (honest AI surface; drives the nodes; spend HITL-gated). |
| 7 | **Public surface** | **NONE** — outbound/internal; the buyer registers no public route (the opposite of the 0178 server). |
| 8 | RBAC + isolation | Purchases scoped to the buyer's tenant/org; `buyerSubject` recorded; initiate needs `workspace:write` + a spend scope; merchant credential is a per-user/org Connection; egress via the SSRF-guarded dispatcher + RFC 0079; **money movement HITL-gated + per-org capped, fail-closed**. |
| 9 | Replay/fork | The mandate chain, `approvalId`, external order id, and outbound result are **stamped on the `UcpPurchase` record** (durable) and read verbatim on `:fork`; the outbound call is non-deterministic so its result is recorded (the executor already marks `untrustedContent`). **PaymentMandate creation is idempotent** (RFC 0093 key) to prevent double-charge on retry. |
| 10 | Frontend | `commerce-ucp-buyer` package: connect-merchant + browse + cart + approval card + history; tokens; 4-locale i18n. |

## Alternatives considered
1. **Fold the buyer into the existing `commerce/ucp/` module.** Rejected — opposite direction;
   it shares only the AP2 types. Folding would entangle the merchant-exposing public surface
   with outbound egress, a different store, and the HITL spend gate. Separate module, shared
   AP2 types.
2. **A standalone `procurement` package divorced from commerce.** Rejected for cohesion + AP2
   type co-location — it is the commerce domain. (Revisit only if it grows beyond UCP into
   generic multi-protocol procurement.)
3. **A bespoke outbound HTTP client + approval gate + credential store.** Rejected — the
   outbound MCP client (RFC 0020's other half), Connections, and the tool-approval
   ledger/firewall already own transport, credential, and HITL.
4. **Advertise `capabilities.ucpBuyer` on the OpenWOP wire.** Rejected — would need an OpenWOP
   RFC; buyer capability is internal, UCP interop is UCP's own discovery.
5. **Let agents spend autonomously (no HITL).** Rejected — this is the app's highest-risk
   surface (autonomous real-money movement). Every payment MUST be approval-gated + per-org
   capped, fail-closed. This is the CRITICAL scale-risk that justifies the HITL requirement.

## Open questions
- [ ] **AP2 mandate signing scheme + spec version.** Which VC/key scheme; host-side BYOK
  signing key per org; pin the AP2 spec version. Demo-mode (unsigned/unverified, honest
  `warnings`) default until live payment creds.
- [ ] **Spend-budget model.** Per-org hard cap + per-purchase approval — configured as a new
  buyer setting, or reuse a billing budget? Where is the cap enforced (node vs service)?
- [ ] **Transport discovery.** How to resolve MCP-vs-REST from a merchant's `.well-known/ucp`,
  and how the Connections provider manifest encodes it (`reach`).
- [ ] **Idempotency + partial failure.** Confirm the RFC 0093 idempotency key threads from the
  node through `ctx.mcp` to the merchant so a retried checkout never double-charges; define the
  `UcpPurchase` state machine (draft → approved → placed → tracked → settled/failed) and its
  fail-closed transitions.
- [ ] **Cross-OpenWOP-host UCP negotiation** — the sole future wire-RFC case (two OpenWOP hosts
  advertising UCP-buyer support to each other). Out of scope; logged (mirrors 0178).

## Correction note — implementation floor (2026-07-03, ADR 0228 / ecommerce gap plan §5D D2)

Implemented as `commerce/ucpBuyer/` with two floor deviations from the design
above, both deliberate and reversible:

1. **Merchant identity**: an egress-policy-gated merchant BASE URL (RFC 0079
   `assertEgressAllowed` + SSRF baseline) instead of a Connections provider
   manifest — the demo-mode floor has no credentialed merchant to model yet.
   The first real credentialed merchant promotes to the provider-manifest +
   brokered-credential design verbatim (the service seam already isolates
   `merchantFetch`).
2. **Transport**: REST-only; MCP-transport merchants and AP2 VC signing stay
   deferred — every PaymentMandate carries the explicit
   `ap2_vc_signing_not_configured` warning.

Unchanged from the design (non-negotiable): the distinct `UcpPurchase` store,
typed mandates with ceiling integrity, the ALWAYS human sign-off on the ONE
approval queue + the fail-closed per-org cap (`OPENWOP_UCP_BUYER_ORG_CAP_MINOR`,
unset ⇒ zero), idempotent placement, `mcpApproval:'always'` on the checkout
node, and nothing advertised on the OpenWOP wire.

