# ADR 0178 — Universal Commerce Protocol (UCP) server adapter for commerce

**Status:** implemented (2026-07-01 — all 4 phases; see § Implementation record)
**Date:** 2026-07-01
**Track:** A (Software & App Architecture) — **extends** the `commerce` feature (ADR 0177)
with a UCP **server** surface. **No OpenWOP wire change → no OpenWOP RFC** (UCP is a
THIRD-PARTY protocol the host speaks, exactly like the inbound MCP server (RFC 0020) and
the A2A server (RFC 0100); it advertises at UCP's own discovery, never at
`/.well-known/openwop`). See § RFC gate.
**PRD source:** UCP spec, https://ucp.dev/ (Apache-2.0; backed by Google/Amazon/Shopify/
Stripe). Agentic-commerce protocol: REST + JSON-RPC transports with built-in AP2 (payments),
A2A, and MCP support; OAuth-2.0 identity; the merchant stays Merchant of Record.
**Owner:** EXTENDS `backend/typescript/src/features/commerce/` — NOT a new package.
**Toggle:** `commerce-ucp` (default **OFF**, `bucketUnit: tenant`) gating the UCP surface;
`commerce` itself is unchanged and can run without exposing UCP.
**Composes (does NOT fork):** commerce (0177 — catalog/cart/order = the single source of
truth), Connections/OAuth (ADR 0024 — UCP identity linking is OAuth 2.0), the inbound MCP
server (RFC 0020 / ADR 0087 precedent) + the A2A server (RFC 0100) — UCP's built-in agent
transports, billing/Stripe (ADR 0176 — the AP2 payment last-mile), Media (RFC 0055 —
product images), Sharing/Publishing public-surface pattern (ADR 0013), `PUBLIC_PATH_PREFIXES`.

> **What UCP is.** A standards-based protocol for **agentic commerce** — so an AI agent
> (ChatGPT, Gemini, a custom shopper) can discover a catalog, build a cart, check out,
> pay (via AP2 mandates/verifiable credentials), and track orders against a merchant,
> while the merchant "retains ownership of the customer relationship" and remains Merchant
> of Record. Shopping vertical is specified; lodging/food are "coming soon". It rides REST
> + JSON-RPC and has built-in support for AP2, A2A, and MCP.

---

## Context — boundaries & pre-existing-surface audit (done first)

**openwop-app already speaks every protocol UCP builds on** — UCP is an ADAPTER, not new
infra:

| UCP layer | Existing openwop-app owner (compose, don't fork) |
|---|---|
| Catalog / cart / checkout / orders | **`features/commerce/`** (ADR 0177) — `commerceService` (Product/Order/lifecycle + the cart store from the deferred-work plan). The UCP surface **projects** these; it never re-models an order. |
| Agent transports (A2A, MCP) | **A2A server** (`host/a2aServer.ts`/`a2aSurface.ts`, RFC 0100) + **inbound MCP server** (`host/mcpServerRegistry.ts`/`routes/mcp.ts`, RFC 0020). UCP-over-MCP registers commerce tools like **ADR 0087** (notebooks-as-MCP-tools); UCP-over-A2A exposes commerce skills. **No parallel agent transport.** |
| Identity (OAuth 2.0 linking) | **Connections** (`features/connections/oauthFlow.ts`/`oauthClientStore.ts`, ADR 0024) — the OAuth client store + flow. UCP `.well-known/oauth-authorization-server` composes this; **no new auth system**. |
| Payments (AP2 mandates / VCs) | **billing/Stripe** (ADR 0176 — BYOK, demo-mode default) + the commerce order's external-`paymentIntentId` (ADR 0177). AP2 mandate → a commerce payment intent. **No new payment store.** |
| Product images / digital delivery | **Media** (RFC 0055) tokens — already how commerce holds images/downloads. |
| Public surface | **`PUBLIC_PATH_PREFIXES`** + the Forms/Sharing published-only, tenant-from-resource pattern (ADR 0013). |

**Collision-free:** no `ucp` route/namespace/type exists anywhere in `backend/typescript/
src` (grep clean). The `/v1/host/openwop-app/commerce/ucp/*` prefix + a `commerce-ucp`
toggle + the UCP well-known path are unclaimed.

**Single owners named:** UCP order/cart/catalog → **commerce**; identity → **Connections**;
payment → **billing/Stripe** + the commerce intent; agent transport → **A2A/MCP servers**.
The UCP feature owns ONLY the **protocol translation** (UCP shapes ⇄ commerce shapes) +
the UCP discovery document.

## RFC gate (the key question) — **host-extension, NO OpenWOP RFC**

Speaking UCP does **not** touch the OpenWOP wire:
- It adds **no** OpenWOP run-event field, **no** OpenWOP event type, **no** normative MUST,
  and **no** capability flag in `/.well-known/openwop`. UCP is discovered at **UCP's own**
  well-known (`.well-known/ucp` + `.well-known/oauth-authorization-server` per the UCP
  spec), which is a THIRD-PARTY contract — precisely the class of the inbound MCP server
  (advertised at the MCP mount, RFC 0020) and the A2A server (advertised at the A2A
  agent-card, RFC 0100).
- Where UCP rides **A2A / MCP**, it rides **already-Accepted** OpenWOP RFCs (0100 / 0020)
  as CONTENT over those wires — the ADR 0087 pattern (notebooks-as-MCP-tools rides RFC
  0020, no new RFC). Where UCP is a standalone REST/JSON-RPC surface, it is a
  non-normative host-extension.
- ⚠️ **The one thing that WOULD need an OpenWOP RFC** (and is explicitly rejected):
  advertising a `capabilities.ucp` block in `/.well-known/openwop` so other OpenWOP hosts
  discover "this host speaks UCP". We do **not** — UCP interop is UCP's discovery, not
  OpenWOP's. (Cross-OpenWOP-host UCP negotiation is the only future wire-RFC case.)
- **AP2 / A2A / MCP are UCP's** built-ins, not OpenWOP's — no OpenWOP RFC is implied by
  supporting them within the UCP surface.

## Decision

Add a **UCP server adapter** to `commerce`, gated by `commerce-ucp` (OFF): a UCP-conformant
Shopping surface that PROJECTS the commerce catalog/cart/checkout/orders so external AI
agents can transact against an openwop-app merchant, with OAuth-2.0 identity via Connections
and AP2 payment intents composing the commerce/billing payment path. The merchant stays
Merchant of Record; the surface is a translation layer over commerce — never a second store.

### Decomposition (this ADR = the SERVER; the CLIENT is a separate future capability)
- **0178 (this ADR) — UCP server (merchant side):** be agent-shoppable. Primary reading of
  "add UCP to commerce".
- **Future — UCP client (buyer side):** an openwop-app agent shops EXTERNAL UCP merchants
  (outbound, credentials host-side via Connections, egress governed like outbound MCP
  RFC 0093). A distinct capability + ADR; **out of scope here**, logged.

### The mapping (UCP ⇄ commerce — no new store)
```
UCP catalog item      ⇄  commerce Product (id, name, price, currency, images=Media tokens, variants)
UCP cart / line items ⇄  commerce cart (the deferred-work cart store) → createOrder
UCP checkout          ⇄  commerce order create + the lifecycle state machine
UCP order / status    ⇄  commerce Order (status/fulfillment) + webhook/notification hooks
UCP identity (OAuth)  ⇄  Connections OAuth client store + `.well-known/oauth-authorization-server`
UCP payment (AP2)     ⇄  a commerce paymentIntent (demo-mode) / billing Stripe (live, BYOK)
```
Tenant is derived from the **resource** (the merchant org in the UCP path), never the
request (the public-surface discipline). OAuth scopes gate write ops.

### PRD-vs-architecture corrections
| UCP/PRD assumption | Correction here | Why |
|---|---|---|
| UCP defines its own order/cart/catalog model | **Project commerce**; the UCP shape is a translation, commerce is the source of truth | No parallel order store (the ADR 0177/0082 law) |
| UCP identity is its own OAuth server | **Compose the Connections OAuth store/flow** (ADR 0024) | One auth system; no fork |
| AP2 payments need a bespoke payment/VC store | **Compose billing/Stripe + the commerce intent**; AP2 mandate → a payment intent; demo-mode default | No new payment store; faithful to the commerce demo-mode posture |
| UCP needs its own agent transport | **Ride the A2A + inbound MCP servers** (RFC 0100/0020) | No parallel agent transport (ADR 0087 precedent) |
| Advertise UCP on the OpenWOP wire | **NO** — advertise at UCP's own discovery only | Keeps it a host-extension; a wire advert would need an OpenWOP RFC |

## Phased implementation plan

- **Phase 1 — UCP catalog + cart + checkout (REST) over commerce.** UCP Shopping REST
  endpoints under `/v1/host/openwop-app/commerce/ucp/*` (+ the UCP well-known discovery
  doc) projecting `commerceService` catalog/cart/order; tenant-from-resource; published/
  active products only; rate-limited + payload-capped. OAuth-2.0 identity via the
  Connections OAuth store (`.well-known/oauth-authorization-server`). Order creation flows
  through `commerceService.createOrder` (never a new store). Route-harness tests
  (discovery, catalog projection, cart→order, OAuth scope gate, tenant IDOR, uniform 404).
- **Phase 2 — ride the agent transports.** Register UCP commerce tools in the **inbound
  MCP server** (the ADR 0087 declarative-workflow pattern) + expose UCP commerce **skills**
  on the **A2A server** (RFC 0100), so an MCP/A2A agent transacts without the raw REST.
  **Core-app extension surface** = these registrations + `ctx.features.commerce` reuse
  (no new `ctx` — UCP is inbound).
- **Phase 3 — AP2 payments + order lifecycle.** AP2 mandate/verifiable-credential intake
  → a commerce payment intent → `markAsPaid` (demo-mode) or the billing Stripe path (live,
  BYOK); UCP order-status webhooks + returns composing the commerce lifecycle +
  Notifications. **Deferred / operator last-mile:** full AP2 verifiable-credential
  verification + real settlement (needs live payment creds — the ADR 0176/0177 posture).
- **Phase 4 — frontend.** A **UCP** panel in the commerce admin: enable/disable, the
  merchant's UCP endpoint + discovery URL, the OAuth client config, and a connected-agents
  view. `ui/` tokens + 4-locale i18n.
- **Node/agent packs:** the SERVER is inbound (agents call us), so no new `feature.commerce.
  ucp.nodes` for Phase 1–3; a UCP **client** node pack belongs to the future client ADR.
  A "UCP concierge" agent (help a human configure/monitor UCP) is optional — honest "none"
  for v1.

## Implementation record (2026-07-01)

| Phase | What shipped | Key files | Tests |
|---|---|---|---|
| **P1 — REST over commerce** | UCP Shopping surface under `/v1/host/openwop-app/commerce/ucp/orgs/:orgId/*` (discovery `.well-known/ucp` + OAuth-AS metadata, client-credentials token endpoint, catalog projection, cart→checkout→order, order status). `commerce-ucp` toggle (OFF, tenant). Tenant from the merchant org; `commerce/ucp` public-path prefix; catalog open, cart/checkout writes need bearer+scope. **No new order/cart store** — projects `commerceService` (cart keyed by the token subject). | `features/commerce/ucp/{ucpClientStore,ucpAdapter,routes}.ts`, `features/commerce/feature.ts`, `middleware/auth.ts` | `commerce-ucp-route` (7) |
| **P2 — inbound MCP transport** | UCP commerce as MCP tools (RFC 0020, ADR 0087 expose-tool pattern): `ucp-catalog-search` + `ucp-place-order` 2-node built-in workflows over the existing `feature.commerce.nodes.*`; gated by `commerce-ucp`+auth via workflow metadata → `mcpServerRegistry.isToolAllowed`. | `features/commerce/ucp/ucpMcpTools.ts`, `features/commerce/feature.ts` | `commerce-ucp-mcp` (2) |
| **P3 — AP2 payment + lifecycle** | AP2 mandate → commerce payment intent → `markAsPaid` (demo-mode; the whole lifecycle — inventory/commission/notification/email — rides commerce). `POST /orders/:id/pay` + `POST /orders/:id/cancel`. Mandate amount/currency cross-checked; VC honestly reported as **not verified**. | `features/commerce/ucp/ap2.ts`, `features/commerce/ucp/routes.ts` | `commerce-ucp-route` +4 |
| **P4 — frontend** | Standalone `commerce-ucp` FE feature (admin): public endpoints (copy) + agent-client provisioning (secret-once) / revoke; org picker; `ui/` tokens; 4-locale i18n. | `frontend/react/src/features/commerce-ucp/*`, `features/registry.ts` | FE build gate |

**Deferrals (honest, logged — not scope cuts):**
- **A2A transport — OUT OF SCOPE for this ADR (boundary finding, `/architect` 2026-07-01).**
  Phase 2's "MCP/A2A" phrasing conflated two different interaction models. The inbound MCP
  server is a **tool registry** (RFC 0020) — UCP's REST/tool shape maps onto it directly, so
  UCP-over-MCP is real translation code (shipped). The A2A server (`host/a2aServer.ts`, RFC
  0076/0100) is **message-to-agent**: `message/send` dispatches `params.agentId` to a manifest
  agent. There is **no UCP wire to translate over A2A** — an A2A peer transacts by *messaging
  the commerce agent* (`feature.commerce.agents` + `feature.commerce.nodes` over
  `ctx.features.commerce`), which already works and is owned by the roster / agent-card /
  `publishAgentCard` seam (`routes/agents.ts`), **not** by this feature. Building a
  "commerce A2A skill" inside `features/commerce/ucp` would duplicate that seam (a parallel
  path) or invent a UCP-over-A2A shim with **no external client to test against** (open
  question #3: decide "with the maturity of external UCP-agent clients" — there are none).
  **Verdict:** MCP is the shipped UCP agent-transport; A2A-as-a-UCP-surface is closed as
  out-of-scope. **Revisit trigger:** a concrete external UCP-over-A2A client (a fixture
  defining UCP message-parts carried over A2A) makes a thin UCP-message shim *on the commerce
  agent* real, testable work — gate it then, not speculatively.
- **AP2 VC verification + live settlement** (P3): demo-mode marks paid against the derived
  intent; full verifiable-credential signature verification + real Stripe capture (BYOK) are
  operator last-mile — the ADR 0176/0177 demo-mode boundary. Surfaced in `payment.warnings`,
  never silently claimed as verified.
- **UCP panel nested in the commerce admin** (P4): the commerce admin has **no frontend yet**
  (ADR 0177 shipped backend-only), so the UCP panel is its own feature package; it composes
  into the commerce admin when that FE lands.
- **UCP client (buyer) half**: out of scope (a distinct capability + ADR), as designed.

## Feature Evaluation Matrix (extension of commerce)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | **Extends** `features/commerce/` (new `commerce/ucp/` module + routes); appended nowhere new — commerce is already registered. No core edits. |
| 2 | Toggle | **`commerce-ucp`** (OFF, `tenant`) gating the UCP surface; registered beside the `commerce` toggle (the code-export/`code-export` precedent). |
| 3 | `ctx.<feature>` | Reuses `ctx.features.commerce` (ADR 0177); UCP is inbound, so no new ctx surface. |
| 4 | Node pack | None for the server (inbound); the UCP-client node pack is the future client ADR. |
| 5 | AI-chat envelopes | None new — UCP agents reach commerce via MCP/A2A (Phase 2), the existing envelopes. |
| 6 | Agent pack | None for v1 (honest). A UCP concierge is optional later. |
| 7 | **Public surface** | UCP endpoints are **public** (external agents) → `PUBLIC_PATH_PREFIXES`; tenant from the resource (merchant org); OAuth-scoped writes; uniform 404; rate-limit + payload caps (abuse: an open storefront-for-agents). |
| 8 | RBAC + isolation | OAuth scopes gate writes; every op tenant+org IDOR-guarded; fail-closed; admin toggles the surface. Merchant-of-record = the org. |
| 9 | Replay/fork | UCP order creation rides commerce (recorded); no new run non-determinism. AP2 intent recorded on the order. |
| 10 | Frontend | UCP admin panel (Phase 4) — `commerceUcpClient.ts` + a panel in the commerce admin; 4-locale i18n; tokens. |

## Alternatives considered
1. **A new `ucp` feature package.** Rejected — UCP is a protocol projection of commerce;
   a separate package would fork the order/catalog model. It extends commerce.
2. **A bespoke UCP OAuth + payment + agent transport.** Rejected — Connections (OAuth),
   billing/Stripe (payment), and the A2A/MCP servers already own those; UCP composes them.
3. **Advertise `capabilities.ucp` on the OpenWOP wire.** Rejected — would need an OpenWOP
   RFC; UCP interop is UCP's own discovery. Keeps this host-extension.
4. **Ship the UCP client (buyer) half here too.** Rejected for scope — outbound shopping is
   a distinct capability (governed egress, its own OAuth-consumer flow); its own ADR.

## Open questions
- [ ] **UCP spec version / vertical.** Target the **Shopping** vertical v1 (lodging/food are
  "coming soon" upstream); pin the UCP spec version the adapter conforms to + revisit on
  UCP updates.
- [ ] **AP2 depth.** Phase 3 handles the mandate→intent→commerce path; full verifiable-
  credential verification + settlement is operator last-mile (live payment creds) — confirm
  the demo-mode boundary is acceptable for v1.
- [x] **Transport priority — RESOLVED (`/architect` 2026-07-01).** Ship REST (P1), then
  UCP-over-**MCP** (P2, the tool-registry shape that matches UCP's REST/tool nature). **A2A
  is closed as out-of-scope** for this ADR: the A2A server is message-to-agent, not a tool
  registry, so "UCP-over-A2A" is just generic commerce-agent reachability (owned by the
  roster/A2A-card seam), with no external client to test a UCP-message shim against. See
  the § Implementation-record A2A deferral note for the full boundary finding + revisit trigger.
- [ ] **Discovery path.** Confirm the exact UCP well-known path(s) the spec mandates and
  whether they must sit at the host root vs under the merchant-org path (multi-tenant).
- [ ] **Cross-OpenWOP-host UCP negotiation** — the ONE future wire-RFC case (if two OpenWOP
  hosts want to advertise UCP support to each other). Out of scope; logged.
