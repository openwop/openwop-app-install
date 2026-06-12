# ADR 0030 — Outbound MCP client (per-user-authed external tool calls)

**Status:** Accepted — Phase 1 (HTTP JSON-RPC client + `serverId`→provider
resolution + `ctx.mcp.{invokeTool,readResource,listTools}` + per-user Connection
auth + the 0028 governance gate + untrusted-output marking) **implemented +
tested**; Phase 2a (parse a `text/event-stream` JSON-RPC response — MCP
Streamable HTTP — for the request/response methods) **implemented + tested**;
Phase 2b (`subscribe-resource` — **bounded in-band change-detection polling**)
**implemented + tested** (`outbound-mcp.test.ts`). A host-curated non-provider
server registry remains **deferred**.
**Date:** 2026-06-11
**Depends on:** ADR 0024 (Connections — the per-user credential broker +
`reach:'mcp'` `ProviderManifest.mcpServer`), ADR 0028 (connector governance —
`isProviderAllowed`), ADR 0027 (connected-content source trust — external tool
output is untrusted). Reuses RFC 0093 egress (the pinned-resolution dispatcher),
RFC 0079 provenance (`run.metadata.connectionUse[]`).
**Consumed by:** `core.openwop.mcp.{invoke-tool,read-resource,list-tools}` nodes;
ADR 0023 (assistant) MCP read-path; any agent using `core.agents.tool-mcp`.
**Surface:** host-internal `ctx.mcp` (the executor builds it). **NON-NORMATIVE —
no RFC.** RFC 0020 governs *exposing* the host AS an MCP server; *consuming*
external MCP servers is host-side runtime, not a wire claim.

## Why this exists

ADR 0024 §4 / D1 routes `reach:'mcp'` providers (Google, Slack) through
`core.openwop.mcp.*` — but the host has **no outbound MCP client**. It only
*exposes itself* as an MCP server (RFC 0020, `routes/mcp.ts`); `ctx.mcp` is an
`expose`-only stub, so `core.openwop.mcp.invoke-tool` throws
`host_capability_missing` at exec. So the broker's MCP leg (D1: "a provider MCP
server registered with an auth reference, minted per-user at invoke-tool /
read-resource time") has nowhere to plug in. This ADR builds the missing client
and wires the per-user credential — the same brokered pattern as the http /
integration adapters, but over JSON-RPC.

## Decision

**A host-side MCP client (`host/mcpClient.ts`) that the executor exposes as
`ctx.mcp.{invokeTool, readResource, listTools}`.** Each call resolves a
**registered MCP server** from `serverId`, checks governance, mints a per-user
token from the matching Connection, performs the JSON-RPC call over the audited
egress path, stamps provenance, and returns the result **marked untrusted**.

### 1. `serverId` resolution (the one real decision)

`serverId === the connections provider id` for `reach:'mcp'` manifests. The
manifest's `mcpServer: { url, transport }` (declared in ADR 0024 §2, populated
here for the providers that ship a real endpoint) supplies the URL; the same
provider id resolves the Connection. So one identifier ties **endpoint** +
**credential** together — no second registry to drift.

- A `serverId` that is **not** a `reach:'mcp'` provider → `server_not_found`
  (fail-closed). A future host-curated non-provider server registry is additive.
- The host MUST NOT let a workflow author supply an arbitrary server **URL** —
  the URL comes only from the host-curated manifest (an author-supplied URL would
  be an SSRF + token-exfiltration vector). Author input is the `serverId` only.

### 2. Per-call pipeline (authz → resolve → invoke → mark)

For `ctx.mcp.invokeTool(serverId, tool, args)`:

1. **Resolve server.** `getProvider(serverId)`; require `reach:'mcp'` +
   `mcpServer.url`. Else `server_not_found`.
2. **Govern (ADR 0028).** `isProviderAllowed(tenantId, serverId)` — fail-closed;
   a disabled connector cannot be invoked even with a live Connection.
3. **Authenticate per-user (ADR 0024).** `resolveConnectionCredential({tenantId,
   provider: serverId, actingUserId: ctx.actingUserId, orgId})` — `connections:use`
   enforced for org connections, fail-closed. No connection ⇒ `not_connected`.
4. **Invoke.** JSON-RPC `tools/call` `POST` to `mcpServer.url` with
   `Authorization: Bearer <token>`, over the **RFC 0093 dispatcher** (SSRF +
   pinned resolution), `redirect:'error'`, bounded timeout. `read-resource` →
   `resources/read`; `list-tools` → `tools/list`.
5. **Provenance.** Stamp `run.metadata.connectionUse[]` on success (RFC 0079).
6. **Mark untrusted (ADR 0027).** The tool **result is external content** — it
   carries `contentTrust:'untrusted'` (the `prompt-injection-mcp-marker`
   invariant). A node forwarding it to an LLM MUST route it through
   `promptInjectionGuard` / `wrapForLLMPrompt`, exactly like inbound MCP
   `tools/call.arguments`. The client returns the result tagged so the boundary
   holds by construction.

### 3. Security invariants

- **Token host-side only** — never in node config, an event, the run doc, or a
  log (the brokered-egress discipline).
- **No author URL** — endpoint is manifest-curated; author supplies `serverId`.
- **Fail-closed at three gates** — unknown server, governance-denied, no
  per-user connection each return a typed error, never a fallback credential.
- **Untrusted output** — every external result is tainted (ADR 0027); the host
  never auto-approves an action derived from it (ADR 0028 default).

## Boundaries audit

| Concept | Owner |
|---|---|
| Outbound MCP transport (JSON-RPC/HTTP) | **NEW — `host/mcpClient.ts`** (this ADR) |
| `serverId`→endpoint+provider | `ProviderManifest.mcpServer` (ADR 0024 §2) — reuse |
| Per-user credential | `resolveConnectionCredential` (ADR 0024) — reuse |
| Connector allowlist | `isProviderAllowed` (ADR 0028) — reuse |
| External-content taint | `promptInjectionGuard` / `contentTrust` (ADR 0027) — reuse |
| SSRF egress | RFC 0093 dispatcher — reuse |
| Exposing the host AS a server | `routes/mcp.ts` (RFC 0020) — unchanged, separate direction |

## Phased plan

- **Phase 1 (this ADR)** — HTTP JSON-RPC client; `invoke-tool` / `read-resource`
  / `list-tools`; `serverId`=provider resolution; governance + per-user auth +
  provenance + untrusted marking. A test MCP server validates the round-trip.
- **Phase 2a (this ADR)** — parse a `text/event-stream` JSON-RPC response (MCP
  **Streamable HTTP**) for the request/response methods: the client advertises
  `accept: application/json, text/event-stream` and reads SSE frames
  incrementally, skipping server-pushed notifications and matching the response by
  `id`, then cancels the stream. No persistent connection — bounded by the same
  timeout. (`readSseJsonRpc`.)
- **Phase 2b (this ADR)** — `subscribe-resource`, **bounded in-band
  change-detection polling**. *Correction to the earlier framing:* I'd pinned a
  "deliver change-events as RFC 0083 triggers" design (ADR 0024 D1's
  fire-a-workflow vision), but the **pack contract is in-band** —
  `ctx.mcp.subscribeResource({serverId, uri}, onEvent)` collects events DURING the
  node's execution and returns them (the node blocks for a window, like
  `logListener`). So there is **no separate-workflow trigger and no daemon**: the
  node polls `resources/read` every interval for a bounded window (defaults: 60 s
  window, 5 s poll, 100-event cap), the first SUCCESSFUL read sets the baseline (no
  event), each subsequent differing read fires `onEvent` (untrusted content, ADR
  0027). Reuses the same `call()` gates (governance + per-user auth + one
  provenance stamp for the window). **Hardening (post-review):** every knob is
  clamped to a **host ceiling** (10-min window / 100 ms cadence floor / 1000-event
  cap) so an author-supplied config can't make the node an egress-amplification or
  slot-holding DoS — the caps live in the host client, not the pack. The per-read
  **timeout is decoupled from the poll cadence** (floored at 2 s, capped at the
  default request timeout) so a fast cadence doesn't imply an impossibly short
  request budget. A **gate** error (misconfig — unknown server / not allow-listed /
  not connected / insecure endpoint) on the first poll **fails fast**; a transient
  error — first-poll or mid-window — is logged and retried until the window closes.
  A throwing `onEvent` consumer is isolated from transport errors and the changed
  content is consumed exactly once (the baseline advances before delivery), so a
  failing consumer can't re-fire the same change every interval. This avoids both
  the persistent-SSE daemon AND the trigger-bridge subsystem the earlier note
  reached for. A separate durable "fire a workflow on change" trigger (the ADR 0024
  D1 vision) would be a *different* host surface with no pack consumer today — out
  of scope.
- **Deferred** — a host-curated non-provider server registry (MCP servers not
  backed by a connections provider).

## Known Phase-1 gaps

- **`read-resource` output is flagged but not yet marked.** The client returns
  `untrustedContent:true` for both `invoke-tool` and `read-resource`, but only the
  **`core.openwop.mcp.invoke-tool` pack node honors it** (wraps the result in
  `<UNTRUSTED tool=…>`). The **`read-resource` node drops the flag** (returns
  `content` plain), so a `resources/read` result reaches a downstream LLM
  unmarked — an ADR 0027 (`prompt-injection-mcp-marker`) gap on that path. The fix
  is **upstream in the vendored pack** (have `read-resource` honor
  `untrustedContent` like `invoke-tool`): tracked, not patched in-host (packs sync
  from upstream). The client side is already correct.
- **`subscribeResource` is abort-capable but not yet abort-wired.** The client
  accepts an optional run-cancellation `signal` (it cancels an in-flight request
  AND exits the poll loop), but the executor does **not** thread one in — no
  run-cancellation signal exists in the executor today. So a cancelled run's
  subscribe node still polls until its own bounded window closes (≤ the host
  ceiling). Wiring the executor's run cancellation into `McpClientDeps.signal` is
  the tracked remaining gap; it's bounded, not unbounded, in the meantime.
- **No JSON-RPC response-`id` correlation.** Harmless for the Phase-1 HTTP
  transport (one POST → one response body); it becomes **required** in Phase 2 (SSE
  / batching), where the client MUST match `result.id` to the request `id`.

## Open questions

1. **(Medium) Token audience.** A per-user OAuth token minted for a provider's
   *API* may not be the audience its *MCP server* expects. Where they differ, the
   provider manifest needs an MCP-specific auth reference; today they coincide for
   the reference providers. *Falsifiable:* if a real provider MCP server rejects
   the API token, add `mcpServer.authRef` to the manifest.
2. **(Low) `tools/list` caching** vs. per-call fetch — per-call for v1.
