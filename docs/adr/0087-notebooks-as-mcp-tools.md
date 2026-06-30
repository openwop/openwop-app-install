# ADR 0087 — Notebooks as MCP tools (expose the Research Notebooks feature to inbound MCP clients)

**Status:** **implemented** (6 READ tools — `notebook-list`, `notebook-get`, `notebook-list-sources`, `notebook-list-notes`, `notebook-search`, `notebook-ask` — PLUS the 2 WRITE tools `notebook-add-source` + `notebook-create-note`, **OQ-1 RESOLVED**: each WRITE workflow is a 3-node chain `expose → core.hitl.approval-request → decision-gated write node`, so a `tools/call` SUSPENDS for a human approval and the mutation lands only on resume-with-accept — an untrusted MCP client can never silently mutate the workspace. WRITE descriptors carry `safetyTier:'write'` + `approval:'always'` + the `workspace:write` scope; `core.openwop.hitl` added to `requiredPacks`; backing nodes `mcp-add-source`/`mcp-create-note` + the narrow `addNote` surface write). Phase 1 — the registry tenant-scoping gap is closed FOR THE NOTEBOOK TOOL SET via a generic gate: `mcpServerRegistry.isToolAllowed/listToolsForPrincipal` deny an anonymous principal and require the tool's `mcpFeatureToggle` (`notebooks`) enabled for the caller's tenant; the MCP registry now also scans the BUILTIN workflow catalog (not just the builder registry) so feature-shipped expose-tool workflows are visible. Phase 2 — the six `notebooks.mcp.*` expose-tool built-in workflows (an `expose-tool` manifest node + an ordering edge to a backing `feature.notebooks.nodes.*` read node whose output is the CallToolResult; the gate hints ride the workflow `metadata` since the expose-tool config schema is `additionalProperties:false`); `core.openwop.mcp` added to the notebooks `requiredPacks`; `runWorkflowSync` now seeds the run variable bag from the inbound MCP args (the subWorkflowDispatcher precedent) so `{type:'variable'}` backing inputs resolve. Phase 3 — `GET /v1/tools` + `GET /v1/tools/{toolId}` (RFC 0078, BARE `ToolDescriptor[]` / descriptor per openapi.yaml + the SDK, NOT the prose `{tools}`), authorization-scoped + non-disclosing, served + `capabilities.toolCatalog:{supported,sources:['mcp']}` advertised ONLY when `OPENWOP_MCP_SERVER_ENABLED=true` (404 otherwise). Phase 4 — auth is fail-closed at the gate: the synthetic `mcp-anonymous` principal (and any `*`/empty-tenant principal) is denied every notebook tool; a real principal (cookie session or bearer) runs the tool in ITS OWN tenant, so a cross-tenant notebook is invisible (`ctx.features.notebooks` org-visibility). Phase 5 — `test/notebooks-mcp.test.ts` covers tools/list + tools/call roundtrip, tenant IDOR, the anon/toggle gate, and the `/v1/tools` projection. **Connecting a client:** point an MCP client (Claude Desktop / Cursor) at `<host>/v1/host/openwop-app/mcp` (streamable-http) with the caller's bearer credential; `tools/list` then surfaces the notebook tools when `notebooks` is on for that tenant. The full Connections-brokered bearer issuance (vs. the existing auth middleware populating `req.principal`) remains a follow-up; the write tools' approve→resume→write cycle uses the standard interrupt resume routes (the `tools/call` returns an `awaiting-input` result the client re-checks).
**Date:** 2026-06-20
**Toggle:** the notebook **tools** ride the existing `notebooks` toggle (ADR 0084; default **OFF**, `bucketUnit: tenant`); the **server mount itself** is infra, gated by the env switch `OPENWOP_MCP_SERVER_ENABLED=true`. Both gates must be true for a notebook tool to be reachable from an external client — the server is the door, the toggle decides which tools walk through it.
**Surface:** the host-mounted MCP-server endpoint (`POST /v1/host/openwop-app/mcp`, RFC 0020) + a set of `core.openwop.mcp.expose-tool` workflows that register the notebook operations as MCP tools. No new endpoint; tools are discovered declaratively from workflow definitions.
**Depends on / composes:**
- ADR 0084 (Research Notebooks — the feature whose Phase 3 nodes back every tool)
- ADR 0030 (outbound MCP **client** — the existing host MCP plumbing this app already runs)
- ADR 0024 (Connections / per-user + per-org credential broker — external-client auth)
- ADR 0001 (feature-package architecture) · ADR 0006 (RBAC)
- **RFC 0020** (host-side MCP server composition — **Accepted**) + **RFC 0078** (tool discovery / `ToolDescriptor` — **Accepted**)
**RFC verdict:** **host work that RIDES Accepted RFC 0020 + RFC 0078 — NO new RFC.** Inbound MCP server-mount, the `serverMount` capability block, the 8 `core.openwop.mcp.*` nodes, and the `/v1/tools` `ToolDescriptor` projection are all already on the wire and Accepted. This ADR only *assembles* them around the notebook operations.

> **Origin.** `lfnovo/open-notebook` ships an **MCP server** so external AI clients (Claude Desktop, Cursor, VS Code) can operate notebooks/sources/notes/search remotely. This ADR brings that *inbound MCP* capability to openwop-app by exposing the ADR 0084 Research Notebooks feature as MCP tools. We port the *capability intent* (your notebooks, reachable from any MCP client), re-expressed on this app's already-mounted RFC 0020 server.

---

## Context — boundaries audit first (MANDATORY, per the scope rule)

The naive read of "port open-notebook's MCP server" is *build an MCP server*. **The audit overturns that: this app already mounts an RFC 0020 inbound MCP server.** Re-implementing one would be the `no-parallel-architecture` violation. What is genuinely new is *a thin pack of expose-tool workflows* over the notebook operations, plus the `/v1/tools` discovery projection (RFC 0078), which this app does **not** yet expose.

**What already exists in THIS repo (verified, with file:line):**

| Capability | Owner in this repo | Status |
|---|---|---|
| Inbound MCP server endpoint (JSON-RPC over streamable-HTTP) | `backend/typescript/src/routes/mcp.ts:35-58` — `POST /v1/host/openwop-app/mcp`, env-gated `OPENWOP_MCP_SERVER_ENABLED !== 'true'` returns early (`:36`) | **mounted** |
| JSON-RPC dispatch (tools/list, tools/call, resources/*, prompts/*, sampling, elicitation) | `backend/typescript/src/host/mcpServerRouter.ts` (dispatch at `:64`; sampling bridge `:336-360`, elicitation bridge `:381-394`) | **present** |
| Declarative scan of `expose-{tool,resource,prompt}` + `handle-{sampling,elicitation}` nodes | `backend/typescript/src/host/mcpServerRegistry.ts:60-65` (all 6 type ids) | **present** |
| JSON-RPC envelope parsing | `backend/typescript/src/host/mcpJsonRpc.ts` | **present** |
| `capabilities.mcp.serverMount` advertisement (transports, samplingBridge, elicitationBridge) | `backend/typescript/src/routes/discovery.ts:1090-1105` — advertised only when `OPENWOP_MCP_SERVER_ENABLED === 'true'` | **present + honest** |
| Host-surface registry entry `host.mcp` | `backend/typescript/src/bootstrap/hostSurfaceRegistry.ts:105` (RFC 0020, OFF by default) | **present** |
| Route registration | `backend/typescript/src/routes/registerAllRoutes.ts:51,141` | **wired** |
| Outbound MCP **client** (`ctx.mcp.*`, ADR 0030) | `backend/typescript/src/host/mcpClient.ts` | present (the *other* direction) |

**What is MISSING (net-new in this ADR):**
- **No `/v1/tools` / `/v1/tools/{toolId}` route** (RFC 0078 `ToolDescriptor`). Grepping `backend/typescript/src/routes` for `/v1/tools` returns nothing; the only RFC 0078 references are an in-process agent-tool projection (`host/agentToolProvider.ts:10`, `host/agentDispatch.ts:213`), **not** the HTTP discovery endpoint. **P3 builds it.**
- **No notebook expose-tool workflows.** Nothing registers `list-notebooks` / `search-notebook` / etc. as MCP tools.
- **No notebooks feature at all yet** — `backend/typescript/src/features/notebooks/` does not exist; ADR 0084 is itself Proposed. **This ADR is blocked on ADR 0084 Phase 1-3 landing.**
- **A known tenant-scoping gap in the registry.** `mcpServerRegistry.ts:14-23` documents honestly that the underlying `workflowsRegistry` is process-global and enumerates **all** workflows without a tenant filter — "Real hosts MUST tenant-scope every lookup … before returning entries to the MCP wire, or cross-tenant workflow disclosure occurs." Exposing org-scoped notebook tools **forces** us to close this for the notebook tool set (see RBAC, below) — we cannot ride the sample's "single shared workflow space" honesty waiver once real org data is behind the tools.

**Namespace check.** The MCP server lives under the sample-vendor prefix `/v1/host/openwop-app/mcp` (host-extensions.md canonical prefix) — no collision with the notebooks routes (`/v1/host/openwop-app/notebooks/*`, ADR 0084). Tool names will be `notebook-<verb>` (e.g. `notebook-search`), a clean namespace in `tools/list`.

**Net:** server-mount = **already present, reused as-is**; tool pack + `/v1/tools` projection + the registry tenant-scoping fix = **net-new, but small assembly** over Accepted seams.

---

## Decision

Expose the ADR 0084 notebook operations as **MCP tools**, each backed by a notebooks workflow (ADR 0084 Phase 3 node pack) registered via the already-recognized `core.openwop.mcp.expose-tool` node. External MCP clients discover them through the existing RFC 0020 `tools/list` and a new RFC 0078 `/v1/tools` projection, and invoke them through `tools/call`. **No bespoke "AI-clients API" — the door already exists.**

### The tool set

| MCP tool | Backed by (ADR 0084 P3 node / service) | Class |
|---|---|---|
| `notebook-list` | `notebooksService.listNotebooks` (project Subjects, `facet:'notebook'`) | read |
| `notebook-get` | `notebooksService.getNotebook` | read |
| `notebook-list-sources` | `ctx.notebooks.listSources` (ADR 0084 Phase 2) | read |
| `notebook-search` | `ctx.notebooks.searchNotebook` (text + vector over the notebook's KB collection + notes) | read |
| `notebook-ask` | `notebooks.ask` node (multi-query `ctx.kb.search` → synthesize-with-citations) | read (model-driven) |
| `notebook-list-notes` | `ctx.notebooks.listNotes` | read |
| `notebook-add-source` | `notebooks.ingest-source` node (KB ingest → bind) | **write** |
| `notebook-create-note` | `notebooksService` note CRUD (subject memory) | **write** |

**v1 ships the read tools (`list`, `get`, `list-sources`, `search`, `ask`, `list-notes`); the two write tools (`add-source`, `create-note`) are gated behind a flag and deferred pending the HITL decision** (Open questions OQ-1). Read-first matches the trust posture: an untrusted external model should not silently mutate a research workspace in v1.

### Execution model

Every `tools/call` **starts a new openwop run** (RFC 0020 §A.2 state projection) — there is no synchronous path, consistent with ADR 0084's `ctx`-only AI constraint. The run is scoped to:
- **the caller's auth** (the external client's principal, resolved via Connections — see P4), and
- **the notebook's org** (RBAC from ADR 0084 carries over verbatim: `workspace:read` to read, `workspace:write` to mutate; uniform 404 on insufficient scope, no existence leak).

`runOptions.trustBoundary: 'untrusted'` is set for all inbound calls (already the server's behavior). **Inbound `params.arguments` are UNTRUSTED** — validated against each tool's `inputSchema` before the run starts (the `mcp-server-untrusted-args` SECURITY invariant), and any tool output feeding a downstream LLM stays `untrusted` (the `<UNTRUSTED>…</UNTRUSTED>` marker discipline from `core.openwop.ai@1.1.2`).

The **`sampling/createMessage` bridge** is the key BYOK win for `notebook-ask`: when the workflow uses `handle-sampling`, the host bridges the inbound sampling request into `ctx.callAI` — **the external client's model + key drive the answer**, under the user's consent, never the server's key (`mcpServerRouter.ts:336-360`; RFC 0020 §A.3).

---

## Phased plan

**Phase 1 — Server mount (mostly DONE; document + verify).** The RFC 0020 server is already mounted (`routes/mcp.ts`), env-gated (`OPENWOP_MCP_SERVER_ENABLED`), and advertised under `capabilities.mcp.serverMount` (`discovery.ts:1090`). P1 here is: (a) confirm it boots with the env set; (b) **close the registry tenant-scoping gap for notebook tools** — `mcpServerRegistry.ts` MUST filter exposed tools to the caller's tenants before returning them on the wire (the file's own TODO at `:14-23`); (c) no schema/advertisement change needed — the block is already correct and honest.

**Phase 2 — Author the expose-tool workflows.** A small set of workflows, one per tool, each a `core.openwop.mcp.expose-tool` node + the ADR 0084 P3 node(s) that fulfil it. Tool `inputSchema` declares `notebookId` + the operation args; the expose-tool manifest carries `name`/`description`/`inputSchema` consumed by `mcpServerRegistry.listTools` (`:74`). These are notebooks-pack artifacts (signed; ride ADR 0084 Phase 3), so they appear in `tools/list` only when registered — i.e. only when notebooks is enabled and the packs are loaded.

**Phase 3 — `/v1/tools` projection (RFC 0078).** Build the missing `GET /v1/tools` + `GET /v1/tools/{toolId}` returning the normative `ToolDescriptor` (stable `toolId`, I/O schemas, auth/egress/approval requirements, safety tier) — an **authorization-scoped projection** (a caller sees only tools their RBAC scope permits, fail-closed). The notebook tools surface here for discoverability alongside their `tools/list` registration. Reuse the in-process descriptor shape already present (`host/agentDispatch.ts:213`) rather than inventing a second one.

**Phase 4 — Auth (Connections / bearer).** An external client authenticates with a credential brokered by Connections (ADR 0024 — the existing `api_key`/`bearer` create flow, `features/connections/`). The MCP server's `principalFromReq` (`routes/mcp.ts:60-71`) must resolve a real principal from that credential — **the synthetic `mcp-anonymous` fallback (`:66`) MUST NOT reach notebook tools** (fail-closed). RFC 0020 §unresolved-Q2 leaves the auth surface to the host; we bind it to Connections, not a bespoke token store.

**Phase 5 — Tests + docs.** Backend `test/notebooks-mcp.test.ts`: (a) `tools/list` then `tools/call` roundtrip for `notebook-search`; (b) untrusted-arg validation (malformed `arguments` rejected per `inputSchema`); (c) org-scope / IDOR (a caller scoped to org A cannot `tools/call` a notebook in org B → uniform not-found); (d) `mcp-anonymous` cannot reach any notebook tool. Docs: a **"Connect Claude Desktop to your notebooks"** snippet mirroring open-notebook's MCP config (server URL `…/v1/host/openwop-app/mcp`, streamable-http transport, the Connections bearer), added to the notebooks feature docs.

---

## Matrix coverage

- **RBAC.** Runs are org-scoped to the notebook's org; `workspace:read`/`workspace:write` gating from ADR 0084 carries over; **fail-closed** (synthetic anon principal denied; insufficient scope → uniform 404, IDOR-guarded). The registry tenant-scoping fix (P1.b) prevents cross-tenant tool disclosure.
- **Trust boundary.** All inbound MCP requests are `untrusted` (RFC 0020 §D); args validated against per-tool `inputSchema` before run start (`mcp-server-untrusted-args`); tool outputs feeding downstream LLMs keep the `<UNTRUSTED>` marker. The `prompt-injection-mcp-marker` invariant applies symmetrically.
- **Replay.** Each `tools/call` **is a run** — fully recorded/replayable like any other openwop run; no out-of-band mutation. `notebook-ask` sampling bridges into `ctx.callAI`, which is replay-cached like every AI call.
- **Capability honesty.** Advertise `capabilities.mcp.serverMount` **only when** `OPENWOP_MCP_SERVER_ENABLED=true` (already enforced, `discovery.ts:1090`); a notebook tool appears in `tools/list` / `/v1/tools` **only when** notebooks is enabled, the pack is loaded, and the caller is RBAC-authorized. No tool is advertised that cannot be honored (`OPENWOP_REQUIRE_BEHAVIOR=true` clean).

---

## Alternatives weighed

1. **A bespoke REST-for-AI-clients API** (a hand-rolled `/v1/host/openwop-app/notebooks-for-ai/*`). Rejected — MCP is the de-facto standard for client↔tool, it is already specced (RFC 0020) **and already mounted here**. A parallel API fragments the surface and re-litigates auth/trust/replay that the MCP mount already solves.
2. **Expose ALL features as MCP tools now** (a generic "every workflow is a tool" sweep). Rejected — scope to notebooks first to prove the seam end-to-end (auth, untrusted args, org-scope, discovery) on one feature; generalize later. A broad sweep would also detonate the registry tenant-scoping gap across every feature at once.
3. **No auth / open server.** Rejected outright — fail-closed, Connections-gated. The `mcp-anonymous` fallback exists only for the conformance harness's bypass mode and MUST NOT reach real org data.

## Open questions

1. **OQ-1 — Write tools + HITL.** Should `notebook-add-source` / `notebook-create-note` require per-tool approval? RFC 0078 `ToolDescriptor` carries an **approval requirement**; the natural mapping is: a write tool's `tools/call` suspends via the `elicitation/create` bridge → `ctx.suspend({kind:'approval'})` (RFC 0020 state-projection row `awaiting-input (approval)`), so the workspace owner approves before the untrusted client mutates. **Recommendation: ship read tools in v1; gate writes behind a flag + this HITL path in v1.1.**
2. **OQ-2 — Inbound rate-limiting.** _(Implemented 2026-06-22, grade-code MCP-1 — `enforceMcpPrincipalRateLimit` in `middleware/rateLimit.ts`, called from `routes/mcp.ts` for `tools/call`; env `OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN` (default 60); canonical 429 envelope; +`test/mcp-principal-rate-limit.test.ts`.)_ An external model can fan out many `tools/call`s. The MCP POST is **already covered by the global per-IP budget** (`ipRateLimitMiddleware`, `index.ts`), so this is a refinement, not an open hole. **Decision: add a per-principal budget layered ON TOP of the per-IP floor, keyed on the authenticated MCP principal (the brokered credential / `principal.principalId` from `routes/mcp.ts`), NOT a new transport-level "connection" concept.** Rationale + shape:
   - The per-IP budget is the wrong granularity (the IP is the MCP *client's* — Claude Desktop, a shared gateway — not the user's), but it is the right **floor** (a cheap DoS backstop), so it stays.
   - The new budget reuses the existing token-bucket in `middleware/rateLimit.ts` (no parallel limiter), keyed by `principalId` instead of IP, applied **only on the MCP mount** (`routes/mcp.ts`) for `tools/call` (reads via `tools/list` are cheap and stay on the IP floor). `mcp-anonymous` is already denied every gated tool (ADR 0087 RBAC), so an anonymous flood hits the per-IP floor + the uniform `not exposed` deny — no run is created.
   - **Honest residual:** like the per-IP limiter, a per-principal in-process bucket is per-instance under Cloud Run scale-out (the same accepted reference-host posture as `SEC-2`); the distributed-limiter production path is infra, not code. Config: `OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN` (default reuses the read budget), env-gated.
   - **Observability already landed (MCP-2, PR #636):** `mcp_tool_call` / `mcp_tool_denied` give the per-tool count + denial-rate this budget would act on, so the limiter ships with a measurement surface from day one.
3. **OQ-3 — Resources/prompts, not just tools.** RFC 0020 also covers `resources/*` and `prompts/*`. Should a notebook (or a source) be exposed as an MCP **resource** (readable URI) in addition to tools? Deferred — tools first; the `expose-resource` node is already recognized (`mcpServerRegistry.ts:61`) if we want it.
4. **OQ-4 — Cross-notebook tools.** `notebook-search` is scoped to one `notebookId` (matches ADR 0084 OQ-2). A workspace-wide `search-all-notebooks` tool is a later additive entry once ADR 0084 adds the cross-notebook surface.

## RFC verdict (Step 5)

**Rides Accepted RFC 0020 + RFC 0078 — NO new RFC.** Inbound MCP server-mount, the `serverMount` capability block, the 8 `core.openwop.mcp.*` nodes, the untrusted-boundary discipline, and the `/v1/tools` `ToolDescriptor` projection are all normative-and-Accepted; this ADR is pure host assembly over them. We advertise `capabilities.mcp.serverMount` **only when actually mounted and honored** (`OPENWOP_MCP_SERVER_ENABLED=true`) and each notebook tool **only when** notebooks is enabled and the caller is authorized — `OPENWOP_REQUIRE_BEHAVIOR=true` honesty preserved. The single net-new wire-adjacent surface (`/v1/tools`) is the *implementation* of an already-Accepted RFC, not a new one.
