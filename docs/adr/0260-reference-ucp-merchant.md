# ADR 0260 — Reference UCP-over-MCP merchant (validating the `ucp.<op>` convention)

Status: implemented

Relates to: ADR 0258 (UCP buyer MCP transport — this closes its two open questions), ADR 0178
(the seller-side UCP surface + `ucpMcpTools`), ADR 0030 (outbound MCP client), ADR 0195
(fail-closed enterprise posture / demo gating). No OpenWOP wire change; no migration.

## Context

ADR 0258 gave the UCP buyer MCP transport but flagged a real honesty gap: the buyer invokes a
**host-assumed** tool convention — `ucp.discover` / `ucp.search` / `ucp.checkout` /
`ucp.order-status`, each returning a **bare structured** result — with **no real merchant to
validate it against**. Its two open questions were "a real UCP-over-MCP merchant to validate the
convention" and "a sample `reach:'mcp'` descriptor pack for operators." We treated both as an
external dependency.

They are not — we can ship the merchant ourselves. Two facts shaped the decision:

- **The app is already a UCP seller too** (ADR 0178, `features/commerce/ucp/`). But its MCP surface
  (`ucpMcpTools.ts`) uses a **different convention**: `ucp-catalog-search` / `ucp-place-order` (2
  ops, `content`-wrapped `CallToolResult`s, gated by the inbound MCP server's non-anon auth +
  `commerce-ucp`). So the seller's `ucp-<op>` and the buyer's `ucp.<op>` **diverge** — this IS the
  ADR 0258 "host assumption" made concrete.
- Pointing the buyer at the seller surface (dogfooding) would require reworking the **inbound MCP
  server's auth model** (the runless buyer's `Bearer <connection-secret>` resolves to
  `mcp-anonymous`, so tools are denied) **and** the tool result shape — a security-surface change
  far larger than "a seed."

## Decision — a demo-gated, stateless reference merchant + seed (architect Option B)

Ship a **reference UCP-over-MCP merchant** that conforms to the **buyer's** `ucp.<op>` convention,
so the buyer is validated end-to-end against a conformant merchant now; document the seller
convergence as a follow-on.

- **`features/commerce/ucp/referenceUcpMerchant.ts`** — a **stateless projection over
  `commerceService`** (the same class of artifact as the seller-side `ucpAdapter`, which "holds no
  state"): `ucp.search` → `listProducts`; `ucp.checkout` → `createOrder`; `ucp.order-status` →
  `getOrder`; `ucp.discover` → a static `{ucp,vertical,mode:'demo'}` doc. It projects a fixed
  reference-merchant org (`demo-ucp-merchant`/`ucp-ref-merchant`) so the buyer shops an
  external-shaped merchant backed by **real commerce data**. Transport-agnostic (`handleUcpMerchantRpc`)
  so a route wraps it and a test drives it directly.
- **`routes/ucpRefMerchant.ts`** — a **dev/demo-only** mount `POST /v1/host/openwop-app/dev/ucp-merchant/mcp`,
  OFF unless `OPENWOP_UCP_REF_MERCHANT_ENABLED=true` (boot-warns when on; mirrors `routes/mcp.ts`).
- **`host/ucpReferenceMerchantSeed.ts` + an `ExampleDataSeeder`** — registers the `reach:'mcp'`
  provider (`mcpServer.url` = the deploy's own URL via `OPENWOP_UCP_REF_MERCHANT_URL`, default a
  loopback) and a **workspace-scoped** Connection so the runless/agent buyer path resolves a
  credential (ADR 0258 §Identity). Rides the fail-closed `exampleDataSeedEnabled()` gate (OFF in the
  enterprise/`auth` posture); idempotent; marker-scoped `clear()`.
- **`examples/connection-packs/ucp-reference-merchant`** — the `reach:'mcp'` descriptor pack
  (RFC 0095 content — the second ADR 0258 deliverable).

### Money-safety (the merchant can never move money)
Checkout creates only a **PENDING, unpaid** order (`createOrder` sets `status:'pending'`); the
merchant NEVER calls `markAsPaid`/Stripe, never fulfills, and **ignores the `ap2_mandate`** (demo
data, not a verifiable credential). This is downstream of the buyer's real gates — the fail-closed
org cap, the ALWAYS human approval, the `placing` CAS — which run in `checkoutPurchase` **before**
the merchant is ever called. The merchant output stays untrusted content; it records an order, it
never grants spend.

### Why not a "parallel surface"
The rule is: no bespoke read-model/store. A **stateless projection over `commerceService`** is not
a store — it is the same pattern the accepted seller UCP-REST surface already uses. Hard constraint,
honored: the reference merchant holds no catalog/order map of its own.

## Deferred (documented follow-on)

**Converge the seller `ucp-<op>` surface (ADR 0178) onto the buyer's `ucp.<op>` convention** —
rename/alias `ucp-catalog-search`/`ucp-place-order`, add `discover`/`order-status`, and emit bare
results — so the buyer can dogfood the app's own storefront over the inbound MCP server. That is a
change to a security-sensitive inbound surface (its auth model + tool result shape) and deserves its
own ADR. This reference merchant **de-risks** it: it pins the exact `ucp.<op>` wire the seller would
converge on and is the conformance oracle for it.

## Alternatives weighed

- *Option A — reconcile the seller UCP-MCP surface now* — rejected for this change: it requires an
  inbound-auth-model redesign (runless Bearer → non-anon principal) + a result-shape change; not "a
  seed." Recorded as the follow-on above.
- *A bespoke in-memory merchant store* — rejected: that would be the parallel-surface anti-pattern.
  Project `commerceService` instead.

## Wire honesty (no RFC)

Host acting as an outbound MCP **client** against the reference merchant (FEATURES row 500, ADR
0030/0258). The merchant is a non-normative host-ext dev route under `/v1/host/openwop-app/dev/*`.
The descriptor pack is RFC 0095 content (`category:'other'`, reused). Additive + behind two dev
flags + the demo-seed gate → fully reversible.

## Implementation

| Piece | Files |
|---|---|
| Stateless UCP-over-MCP merchant (projects `commerceService`; money-safe) | `features/commerce/ucp/referenceUcpMerchant.ts` |
| Dev-only route mount | `routes/ucpRefMerchant.ts` (+ `routes/registerAllRoutes.ts`) |
| Seed helpers + `ExampleDataSeeder` | `host/ucpReferenceMerchantSeed.ts` (+ `host/exampleDataSeeders.ts`) |
| `reach:'mcp'` descriptor pack | `examples/connection-packs/ucp-reference-merchant/pack.json` |
| E2E (buyer discover→search→gated-checkout→track over the real route; PENDING-order money-safety; seeder idempotency) | `test/commerce-ucp-reference-merchant.test.ts` (2) |

## Open questions / follow-ons

- **Seller convergence onto `ucp.<op>`** — the deferred item above (needs its own ADR + the inbound
  auth-model work).
- **Operator UX** — a one-click "seed the reference merchant + open the buyer" demo affordance is a
  possible FE refinement (the seed is currently driven via the `/example-data` endpoints).
