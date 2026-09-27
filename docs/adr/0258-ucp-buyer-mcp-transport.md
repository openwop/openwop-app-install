# ADR 0258 — UCP buyer MCP transport (+ correction to ADR 0254's run-coupling finding)

Status: implemented

Relates to: ADR 0188 (UCP buyer / AP2), ADR 0254 (which DEFERRED this, citing a run-coupling
that turns out to be soft — corrected below), ADR 0030 (outbound MCP client), ADR 0028
(connections governance), ADR 0024 (BYOK). No OpenWOP wire change (UCP/AP2 are external
client protocols — FEATURES.md row 500); no migration.

## Context

The UCP buyer (ADR 0188) reaches EXTERNAL merchants over REST only. ADR 0254 deferred MCP
transport, citing that `host/mcpClient` (ADR 0030) is "run-execution-coupled" (requires
`deps.runId` and stamps run-scoped provenance) while the buyer is runless — "phase-sized."

**Correction to ADR 0254's finding.** On close reading, the coupling is soft:
- Of `mcpClient.call`'s six steps, only step 5 (`stampConnectionUse(deps.runId)`) is
  run-dependent; steps 1–4 (manifest resolve → governance allowlist → BYOK credential →
  audited JSON-RPC egress) are run-independent, and `deps.signal` is already optional.
- `stampConnectionUse` already **no-ops a missing run** (`getRun(runId); if (!run) return`),
  so a runless caller never throws.

So the "runless seam" is a **3-line change**, not a phase: `McpClientDeps.runId` becomes
optional and the stamp is skipped when it's absent (the buyer keeps its own
`recordCommerceAction` audit). The real work was the transport abstraction + preserving the
money-path invariants — a contained feature-package change.

## Decision

### Runless MCP use
`McpClientDeps.runId?: string` (optional); `if (stamp && deps.runId) await stampConnectionUse(...)`.
Run-path callers pass `runId` unchanged → identical behavior (verified: `outbound-mcp` /
`notebooks-mcp` suites green).

### Transport abstraction
A merchant is addressed by **exactly one** transport: `MerchantRef = {url}` (REST, unchanged)
| `{serverId}` (a `reach:'mcp'` Connection). `UcpPurchase` gains optional `merchantServerId`
(pre-0258 rows carry `merchantUrl` → back-compatible). `normalizeMerchantRef` validates
exactly-one; `merchantLabel(ref)` feeds approval proposals + notifications (no `new URL()` on
a non-URL). For REST it's the network **origin** (the real payee, self-verifying); for MCP the
`serverId` is only a local alias, so the label resolves the connection manifest to append the
declared **display-name + endpoint host** (`MCP:<serverId> (<name> · <host>)`) — so the
money-approver can see WHO they're paying, at REST parity (ux-review). A single `merchantCall(tenantId, ref, op, ctx)`
dispatches: REST via the egress-gated `merchantFetch`, MCP via the runless `mcpClient`
invoking the `ucp.<op>` tool (`discover`/`search`/`checkout`/`order-status`). MCP's
governance allowlist + BYOK credential + https-pin + audited egress are enforced inside
`mcpClient`.

### UCP-over-MCP tool convention (host assumption)
There is no public UCP-over-MCP standard, so the buyer assumes a convention: each UCP
operation is an MCP tool `ucp.<op>` whose **structured JSON result is the tool result**
(mcpClient passes through a result with no `content` wrapper). Documented as an assumption;
**REST stays the interoperable floor**.

### Money-path invariants (the deferral's core concern) — UNCHANGED and transport-agnostic
Every gate runs in `checkoutPurchase` **before** `merchantCall`: the fail-closed org spend
cap, the ALWAYS human sign-off on the ONE queue, the `placing` CAS, and the authoritative
post-CAS cap re-check. The MCP branch swaps only the merchant POST. Critically, the
**unknown/failed mapping is preserved across transports** and is **default-ambiguous** (a
failure is `'unknown'` unless we can PROVE the merchant did not place): a `'failed'` (safe
to blind-retry) is emitted ONLY for a **definitive** failure — for MCP a pre-flight gate
error (`server_not_found`/`insecure_mcp_endpoint`/`connector_not_allowed`/`mcp_not_connected`,
the request never egressed) or a JSON-RPC `mcp_error` / tool `isError` (the server responded
without acting); for REST a clean `Merchant returned <status>` (it responded without placing).
**Every other failure — timeout, connection drop, oversized/garbled body (`mcp_bad_response`,
`mcp_response_too_large`), unreachable host — is AMBIGUOUS** → `'unknown'` → blocks a blind
re-checkout that could double-buy. `merchantCall` normalizes both transports into a
`MerchantCallError.ambiguous` flag. The idempotency key rides the tool args (and the REST
header). MCP tool output stays `untrustedContent` — data, never authorization.

> **Correction (code-review, ADR 0258).** The first cut classified ONLY `mcp_timeout`/
> `mcp_request_failed` as ambiguous, which mapped a post-send `mcp_bad_response`/oversized-body
> to `'failed'` — a double-buy window (the merchant may have placed before the reply garbled).
> Corrected to the default-ambiguous rule above (both transports); regression-covered by the
> `badbody` → `'unknown'` case in `commerce-ucp-mcp-transport.test.ts`.

### Identity (who the MCP credential resolves for)
- **Operator route path** — `actingUserId = the signed-in user` → resolves a user/org
  connection (the human's).
- **Agent/node surface path** — no acting user → resolves a **workspace-scoped** merchant
  connection (an org/user connection needs human attribution via the D2 confused-deputy
  gate, which an autonomous agent can't satisfy). This is the correct fail-closed posture.
  The buyer's `actor` field doubles as an audit label and carries the synthetic sentinels
  `'agent'`/`'system'` on this path; `actingUserOf()` strips them so they are **never
  forwarded as `actingUserId`** (which would ask `mcpClient` to resolve a user/org credential
  for a non-user) — only a real signed-in userId flows through (code-review LOW).

## Alternatives weighed

- *A new runless-MCP seam / synthetic run* — rejected as over-engineering once we saw the
  stamp already no-ops a missing run; `runId?` optional is the minimal, honest change.
- *Overload `merchantUrl` with an `mcp:<serverId>` sentinel* — rejected; `new URL('mcp:x')`
  yields an ugly `null` origin. Separate `merchantServerId` + a `merchantLabel` helper is clean.
- *Defer to a future phase (ADR 0254's call)* — reversed: the discovery de-risked it to a
  feature-package change; the money gate is transport-agnostic and mock-tested.

## Wire honesty (no RFC)

Host acting as an MCP **client** against an external merchant — no OpenWOP wire surface
(FEATURES.md row 500: "outbound consumption of a third-party protocol, like the outbound MCP
client"). Additive-optional `UcpPurchase.merchantServerId`; no migration.

## Implementation

| Piece | Files |
|---|---|
| `runId?` optional + skip stamp | `host/mcpClient.ts` |
| `MerchantRef`/`merchantCall`/`merchantLabel`/`normalizeMerchantRef`; `UcpPurchase.merchantServerId`; MCP checkout + track; ambiguity mapping | `features/commerce/ucpBuyer/ucpBuyerService.ts` |
| Routes accept `merchantServerId` + thread the acting user | `features/commerce/ucpBuyer/routes.ts` |
| Agent surface verbs accept `merchantServerId` (workspace credential) | `features/commerce/surface.ts` |
| Buyer node pack inputs gain `merchantServerId` | `packs/feature.commerce.buyer.nodes/*` |
| Tests (mock MCP merchant: discover/search/gated-checkout/track/timeout→unknown/both-set→400) | `test/commerce-ucp-mcp-transport.test.ts` (3) |

## Open questions / follow-ons

- ~~**A real UCP-over-MCP merchant** to validate the `ucp.<op>` tool convention — until then REST
  is the interoperable floor and the convention is a host assumption.~~
  **ADDRESSED (ADR 0260):** a demo-gated, stateless **reference UCP-over-MCP merchant** (projecting
  `commerceService`, money-safe) validates the buyer's `ucp.<op>` convention end-to-end. It also
  surfaced that the app's own **seller** UCP-MCP surface (ADR 0178) uses a DIFFERENT convention
  (`ucp-catalog-search`/`ucp-place-order`) — converging the two is a documented follow-on in ADR 0260.
- ~~A sample `reach:'mcp'` merchant connection **descriptor pack** for operators (shape-only).~~
  **SHIPPED (ADR 0260):** `examples/connection-packs/ucp-reference-merchant`.
