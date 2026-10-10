# ADR 0788 — MCP client / server: tenant-scoped tool registry, host-side fences, and a "connect an AI client" surface (feature loop 2026-10 row 11)

Status: implemented (2026-09-30; accepted after an adversarial /architect pass — see § Implementation record)

- **Row:** feature loop 2026-10 row 11, `core:mcp` (the external-process lane, one of
  the three AI-exchange lanes in `CLAUDE.md`).
- **Grade that drives it:** `docs/steward/WORKFLOWS-ASSESSMENT.md` § "MCP client / server"
  (`MCPWF-1..14`, opening **C**, baseline `cc0a8ae48`).
- **Competitive input:** `docs/research/2026-06-23-ai-chat-competitive-analysis.md`
  (LibreChat `MCPBuilder` runtime add/remove + OAuth, LobeChat connector manifests,
  AnythingLLM per-tool suppression).
- **Composes:** ADR 0030 (outbound client), 0087 (notebooks as MCP tools — the metadata
  gate), 0553 (MCP 2026 codec + fail-closed mount), 0601 (scope enforcement), 0270
  (developer API keys), 0144 (Access Hub), 0369 (catalog visibility), RFC 0020 / 0153.
- **Toggle:** none. This refines an existing always-available core surface whose mount is
  a deployment switch (`OPENWOP_MCP_SERVER_ENABLED`); no feature-package is created.

## Context

The MCP server mount WAS enabled in production. An unauthenticated `POST
https://app.openwop.dev/api/v1/host/openwop-app/mcp` answered **401** on 2026-09-30; the
route is not registered at all when the switch is off (`routes/mcp.ts:42`). After this
row reported `MCPWF-1`, the service was rolled to revision `00801-fl5` with
`OPENWOP_MCP_SERVER_ENABLED=false` (re-probed the same day: `404`, and the service spec
reads `false`). The mount stays off until this ADR ships.

What an external AI client sees is decided by `host/mcpServerRegistry.ts`. It enumerates
`allWorkflowDefs()` (`:50-55`): the 19 host-shipped chain-backed projections, merged with
`listRegisteredWorkflows()`, the process-global builder registry. It filters nothing by
tenant. The per-tool gate `isToolAllowedWith` (`:273`) reads the workflow's OWN metadata,
and a tool with no `mcpRequiresAuth` / `mcpFeatureToggle` is allowed to every caller.

Three consequences, all verified at `file:line` in the grade:

1. **Cross-tenant plant (`MCPWF-1`, Blocker).** Any signed-in user can
   `POST /v1/host/openwop-app/workflows` in their own personal tenant with an
   `expose-tool` node and no metadata. Every tenant's `tools/list` then carries that
   tool's name and description, which is an injection channel straight into the victim's
   AI client. `tools/call` runs the planter's graph under the CALLER's tenant
   (`mcpSemantics.ts:354-377`; `resolveLaunchWorkflow` resolves by id with no ownership
   check). The same unfiltered walk picks resources, prompts and the legacy
   sampling/elicitation handlers, "first workflow wins" across tenants (`:378-394`).
2. **Instance-dependent list (`MCPWF-2`, Blocker).** The tenant half reads a per-instance
   cache that is never hydrated at boot (`workflowsRegistry.ts:146`), so list and call
   disagree across instances.
3. **Fence breakouts (`MCPWF-3`, Blocker).** The vendored `core.openwop.mcp` pack builds
   `<UNTRUSTED tool="…">${raw}</UNTRUSTED>` without defanging `raw`
   (`packs/core.openwop.mcp/index.mjs:79-80`). Its sampling handler skips any message that
   already contains `<UNTRUSTED>` anywhere, and passes non-string content (the
   `{type:'text', text}` objects MCP sampling actually carries) through unfenced
   (`:287-291`). The pack is vendored from `openwop-registry` (`scripts/sync-packs.sh`), so
   a pack-only fix would be overwritten on the next sync.

Product-side, the only MCP screen is a read-only list at the bottom of `/capabilities`
(`mcp/McpToolsPanel.tsx`). A user cannot learn the endpoint URL, cannot mint the bearer
credential an MCP client needs (developer keys, ADR 0270, have routes but **no UI
anywhere**), and an admin cannot see or narrow what external clients can call. A network
failure renders as "disabled" (`mcp/mcpClient.ts:40`); a non-JSON 200 spins forever
(`:47`). Every leader in the competitive scan ships an add/connect flow and per-tool
control (LibreChat, LobeChat, AnythingLLM).

## Boundaries audit

- **Single owner of "what an MCP caller may see":** `mcpServerRegistry.ts`. `tools/list`
  (both codecs), `tools/call`, `GET /v1/tools` (`routes/toolCatalog.ts`), resources,
  prompts and the handlers already route through it. The fix lives there, once; no second
  registry.
- **Tenant ownership:** `host/workflowOwnership.ts` (`listOwned`, `getOwned`) is the
  existing index `/builder` and the `/` picker already list from. Durable resolution:
  `getRegisteredWorkflowAsync` (`workflowsRegistry.ts:119`). Catalog visibility (archived /
  transient hidden): `catalogVisible` (`workflowLifecycle.ts:73`). All reused.
- **Fencing:** `defangAngleFence` (`host/untrustedContent.ts:49`) already exists and is the
  codebase's one XML-fence defang; reused, not re-implemented.
- **Credentials for clients:** developer API keys (`features/developer-keys/`, ADR 0270)
  are the existing bearer lane, and ADR 0601 already resolves an `owk_` key's MCP authority
  as its issuer's, narrowed by the key's scopes. No new credential type.
- **Admin authority:** `requireTenantScope` (`features/featureRoute.ts:296`) plus a new
  management scope `host:mcp:manage`, reserved to built-in admin/owner, following the ADR
  0711 / 0786 precedent (`host:byok:manage`, `host:billing:manage`).
- **Access Hub (ADR 0144):** tabs are projected from the `FEATURES` manifest (`hubTab`);
  a new tab is one manifest row, no second registry.
- **Route collision:** new routes live under `/v1/host/openwop-app/mcp/*`
  (`exposure`). The mount is `POST /v1/host/openwop-app/mcp` exactly; Express matches
  paths exactly for `app.post`, so `…/mcp/exposure` does not collide. Checked:
  `grep -rn "openwop-app/mcp" backend/typescript/src` finds only the mount.
- **Row 103 (developer keys)** owns the full key-management page. This ADR adds only a
  client module and an MCP-labelled issue/revoke strip; the page itself stays row 103's.

## Decision

### D1 — The MCP registry is tenant-scoped through the ownership index (MCPWF-1, -2)

**One MCP tenant per request.** The mount computes `mcpTenant = tenantOf(req)` once and
threads it through `McpSemanticDeps`. Listing, gating, launching and the exposure set all
use it. For every non-wildcard lane `tenantOf(req)` equals `principal.tenants[0]`
(`middleware/auth.ts:930,956,1094,1371-1375`). For a wildcard operator key (`k:*`, the
in-process conformance key `conformance/run.ts:487`, local `dev-token:*`) it is
`'default'`, which is exactly where `POST /workflows` records that caller's ownership
(`routes/workflows.ts:431`). `runWorkflow`'s private third spelling (`'mcp-default'`,
`mcpSemantics.ts:357`) is deleted. *(Architect B1: the first draft keyed off
`principal.tenants[0]` and gave wildcards nothing, which would have turned the whole MCP
conformance lane red.)*

**Two sources, and nothing else.** Every MCP enumeration (tools, resources, resource
templates, prompts, sampling/elicitation handlers) walks exactly:

1. **Host projections** (`source: 'host'`) — `listChainBackedWorkflows()`: host-shipped,
   their gate metadata merged from reviewed source at boot (`features/index.ts:308`).
   Visible in every tenant, gated by their own metadata exactly as today (ADR 0087/0601).
2. **The MCP tenant's own workflows** (`source: 'workspace'`) — `listOwned(mcpTenant)`,
   rows with `transient` or `archivedAt` skipped BEFORE any definition read
   (`workflowOwnership.ts:44-46`), each remaining row resolved through the SAME
   launch resolution a call runs (`resolveLaunchWorkflow`, published-when-present), so the
   list shows the graph a call would execute, not the builder head. *(Architect H1.)*

The process-global `listRegisteredWorkflows()` is no longer read by MCP at all. That alone
closes the cross-instance half (`MCPWF-2`): the ownership index is durable, and the
catalog resolution falls back to storage on a cache miss.

**One launch predicate for every `source: 'workspace'` entry.** Tools, resources,
templates, prompts and both legacy handlers all start a run, so all of them take the same
gate, on list and on call. *(Architect B2: the first draft gated tools only.)* The gate is
the predicate that let the workflow be authored: `requireWorkflowWrite(req)`
(`host/workflowWriteAuthority.ts:31`, provenance-classified: wildcard operator,
tenant-owner env key, `owk_` key narrowed by its declared scopes with the personal-tenant
short-circuit, and the subject lane via `assertTenantScope` with the personal-owner
short-circuit), PLUS the `runs:create` key-declaration check HTTP launch applies
(`keyDeclarationPermits`, `routes/runs.ts:307`). The mount evaluates it ONCE per request
and passes the boolean in deps; the registry never re-derives it from the principal id.
*(Architect B4: `credentialScopesIn` lacks both short-circuits and the two-spellings
union, so the first draft would have hidden a personal owner's own tools.)*

**Deny-by-default, and the one deliberate exception.** A tool with no ADR 0087 metadata
used to be open to every caller. Every WORKSPACE tool is now gated (authenticated,
`workspace:write` + `runs:create`) whatever its metadata says. The only remaining "no
metadata ⇒ open" branch is a HOST projection's (`requiredScopeForTool` → `null`), kept
because a host projection's metadata is reviewed source rather than a request body,
and none ships without metadata today — the branch is walked by a synthetic manifest
in `mcp-tool-scope-enforcement.test.ts` so it cannot rot unseen.

Author metadata can only NARROW a workspace entry (`mcpFeatureToggle` still applies); it
can never lower the launch gate.

**The descriptor tells the truth about workspace tools.** `ExposedToolManifest` gains
`source`. `requiredScopeForTool` returns `workspace:write` for every workspace tool, and the
RFC 0078 descriptor (`routes/toolCatalog.ts`) derives a workspace tool's facts
conservatively: `safetyTier: 'write'`, egress `host-owned` (the tool-descriptor schema's enum has no `external`), replay `non-deterministic`, approval as
declared or `never`. An advert/enforcement parity test reads the descriptor and the gate
together. *(Architect B3: the first draft would have enforced `workspace:write` while
advertising `scopes: []`, re-opening the drift ADR 0601 closed.)*

**Name precedence.** A host projection's tool name is reserved. A workspace tool (or
resource URI, or prompt name) that reuses one is omitted and logged
(`mcp_tool_name_shadowed`). Within a tenant, the newest-owned wins (the `listOwned`
order), also logged. So `tools/list` never shows two entries with one name.

**List/call parity is structural.** `tools/call` re-derives the tool through the same
scoped enumerator and predicate, never a global name lookup, and runs the definition that
enumeration resolved (it re-checks that the resolved graph still exposes the requested
name).

**Handlers.** `findSamplingHandler` / `findElicitationHandler` search the MCP tenant's own
workflows only and take the launch gate. A tenant with no handler gets method-not-found,
as a host with none does today.

**Cost (architect M2).** One `listOwned` prefix scan plus one catalog resolution per
non-transient owned row, per MCP request, memoised within the request. Accepted for now;
an `mcpSurface` digest on the ownership row (written at `recordRevision`) is the named
follow-up if a tenant's owned count makes it matter.

### D2 — Host-side fences at the two choke points (MCPWF-3)

- **Outbound:** `host/mcpClient.ts` defangs every string inside a peer's tool result,
  resource contents, `tools/list` descriptions (before they are cached) and
  resource-subscription events (`defangAngleFence`, recursively) before returning them.
  The pack's `markedContent` fence then cannot be closed from inside, whatever pack version
  is mounted. Only the fence token changes (`<UNTRUSTED` → `&lt;UNTRUSTED`), so JSON
  consumers (the calendar and UCP buyer adapters) see identical data unless a peer sent the
  literal token.
- **Inbound (legacy `sampling/createMessage`):** the router fences the request itself
  before the handler workflow sees it. Each message's text (string content or
  `{type:'text', text}` objects) is defanged and wrapped in `<UNTRUSTED>`, and
  `systemPrompt` is defanged. A request carrying any non-text part (image, audio) is
  REFUSED with invalid-params ("this host's sampling bridge accepts text only"): the host
  cannot fence an image, and silently dropping part of a request changes its meaning.
  *(Architect M1: the draft said both "dropped" and "refused".)*
- **Residual, stated:** an outcome RECORDED before this change replays verbatim on a
  `:fork` (replay serves recorded outcomes, `executor.ts:1066-1090`), so a pre-fix
  recording can still carry an undefanged token. Rewriting recorded outcomes would break
  replay determinism; the population is bounded by the mount having been off except in
  prod before `00801`. The pack's "already wrapped" skip then only ever sees host-made,
  well-formed fences.
- **Upstream (OWED, not yet filed — a public issue describing a fence breakout waits on the
  orchestrator's disclosure call):** the same two fixes belong in `openwop-registry`'s
  `core.openwop.mcp` (defang `raw`; fence object content; never skip on a substring). The
  host fix does not wait on it and does not depend on it.

### D3 — Projections are infrastructure, not templates (MCPWF-4)

The 19 `*.mcp.*` chains are marked `internal: true` (RFC 0135) in
`examples/workflow-chain-packs/mcp-tool-projections` (pack `1.0.2 → 1.0.3`, AND each
chain's own version bumped: at equal chain versions a higher-precedence root copy wins,
`workflowChainPackLoader.ts:723-734`, so a pack-only bump could be shadowed by a
registry-installed copy — architect L1). *(Confirmed at the gate: `check-pack-version-bump` refuses a content change
without a chain-version bump, since `deterministicExpansionId` hashes the version.
Replay: MCP-started runs stamp the chain id plus `definitionRevision`, and every
chain-backed registration records its revision, so a `:fork` of a pre-bump run
resolves the revision it ran; a side-effecting node whose id is not in the
resolved graph fails closed as `replay_source_missing`, never re-fires.)* They leave the
template gallery; `from-chain` by id still works (RFC 0135 is presentational). A copy is a
tenant-owned tool, so D1 already gates it (`workspace:write`) and D1's name precedence
drops it from `tools/list` while the host projection with the same name exists.

### D4 — Every run-starting MCP method is budgeted and bounded (MCPWF-6, -7)

- The per-principal budget (`enforceMcpPrincipalRateLimit`, today `tools/call` only,
  `routes/mcp.ts:111`) applies to every method that starts a run: `tools/call`,
  `resources/read`, `prompts/get`, `sampling/createMessage`, `elicitation/create`.
- The legacy sampling bridge clamps `maxTokens` to a host ceiling
  (`OPENWOP_MCP_SAMPLING_MAX_TOKENS`, default 4096) and drops `modelPreferences` (the
  tenant's configured model applies; a peer does not choose what the tenant pays for).
  The clamp sits in the router, before `runHandlerWorkflow`, so it holds whatever pack
  version runs the handler.
- The legacy elicitation bridge answers `decline`, never `accept`, when the handler's
  output carries no `action`. A missing decision is not consent.

### D5 — Admins control exposure per tool (AnythingLLM per-tool suppression)

> **CORRECTED during implementation (grade-code MCPCD-3 / grade-ux MCPUX-3).** The
> write below was first built as a whole-set `PUT`. The page computed that set from
> the admin's OWN filtered view, so one click silently re-enabled every disabled
> tool the admin could not currently see, and two admins overwrote each other. It
> shipped as `PATCH {key, disabled}`, merged server-side by compare-and-swap. A
> storage error reading the set now FAILS the request rather than reading as
> "nothing disabled" (MCPCD-8).

`GET/PUT /v1/host/openwop-app/mcp/exposure` stores a per-tenant set of DISABLED entries,
keyed `source:workflowId:toolName` (architect M4: keying by name alone would let a builder
rename silently re-enable a tool). One `DurableCollection` row per tenant.
`requireTenantScope(req, 'host:mcp:manage')` gates the PUT. The new scope joins
`MANAGEMENT_SCOPES` and the admin/owner grants, is refused to custom roles like every
`host:` scope, and is subject-only by construction (`requireTenantScope` keys on the caller
subject), so an `owk_` key can never manage exposure; the GET needs `workspace:read` and returns every tool the tenant could expose with
its gate facts (safety tier, approval, auth, required scope, source: host or workspace) and
its `disabled` flag. The registry's ONE predicate reads the set, so a disabled tool is
absent from `tools/list`, `GET /v1/tools` and `tools/call` alike. Suppression only ever
narrows; it cannot enable a tool the gate refuses. The write is audited
(`mcp.exposure.updated`).

### D6 — "Connect an AI client" in the Access Hub (the product gap)

A new Access Hub tab **AI clients (MCP)** (`/access/mcp`, `hubTab: { group: 'credentials' }`,
`tier: 'workspace'` — corrected from `admin` by grade-ux MCPUX-1: members mint their own
client keys, so an admin-only tab hid the feature from exactly the people it serves)
replaces the `/capabilities` card:

1. **Endpoint.** The absolute URL comes from the BACKEND (the exposure GET), not the SPA:
   `OPENWOP_MCP_PUBLIC_URL` when the operator sets it, else `publicBaseUrl(req)` +
   the mount path, flagged `derived`. The SPA's `/api` base runs through the Firebase
   rewrite, whose request timeout would cut a long synchronous `tools/call`; the direct
   Cloud Run URL does not (architect H2). Then the protocol revisions the host serves,
   and a copyable client config (a generic
   remote-server `{ url, headers: { Authorization: "Bearer <key>" } }` snippet). The copy
   does not claim a named client works: this host has not been driven by Claude Desktop or
   Cursor, so the page says "clients that support remote servers with a bearer header".
2. **Credential.** Create a key for a client, shown ONCE with copy; list and revoke keys
   whose NAME starts `MCP: ` (a naming convention, since `ApiKeyRecord` has no label
   field and the ADR 0270 routes stay unchanged). Two presets map to declared scopes:
   **Read only** (`workspace:read`) sees host read tools only; **Read & act**
   (`workspace:read`, `workspace:write`, `runs:create`) also reaches write tools and this
   workspace's own tools. An admin's list shows every `MCP: ` key in the workspace, and the
   page says so. The tab is admin-tier like every credentials tab, but minting is
   self-service over the API regardless (architect M3); the tab is a convenience, not a
   boundary.
3. **Tools.** What an MCP client signed in as YOU would see (a key sees what its declared
   scopes allow, which the page states),
   each with chips for its gates, plus the admin's per-tool switch (D5). States: loading,
   mount disabled (in plain words, no env-var name), unreachable (network), signed out,
   forbidden, empty, error with retry. `nextCursor` is followed.

The `/capabilities` card is removed; the capabilities page links to the new tab.

## Architect pass (adversarial, 2026-09-30) — recorded, all folded in above

A fresh-context `/architect` pass over the first draft found **4 Blockers, 3 High, 4
Medium, 2 Low**. Every one is folded into the decision text above and marked inline.

| # | Finding | Resolution |
|---|---|---|
| B1 | keyed off `principal.tenants[0]` and gave wildcards nothing; wildcard keys own under `'default'`, so the MCP conformance lane (and 166 `dev-token:*` tests) would go red | one `mcpTenant = tenantOf(req)` through deps; `'mcp-default'` deleted |
| B2 | only tools gated; resources/prompts/handlers launch ungated | one launch predicate for every workspace entry, list and call |
| B3 | `/v1/tools` would advertise `scopes: []` for a tool enforcing `workspace:write` | `source` on the manifest; conservative descriptor; parity test |
| B4 | `credentialScopesIn` is not the authoring predicate (no personal-owner or personal-key short-circuit, no two-spellings union); HTTP launch also needs `runs:create` | `requireWorkflowWrite(req)` + `keyDeclarationPermits(…, 'runs:create')`, once per request |
| H1 | list read the head, call ran the published revision | enumerate through `resolveLaunchWorkflow` |
| H2 | SPA-assembled URL goes through the Firebase rewrite's timeout | backend serves the URL; `OPENWOP_MCP_PUBLIC_URL` |
| H3 | existing tests register without ownership / across anon tenants | test migration is an explicit P1 item |
| M1 | D2 missed cached `tools/list` descriptions + subscription events; "dropped with a refusal" contradicted itself | both covered; non-text sampling REFUSED; replay residual stated |
| M2 | per-request scan cost | pre-filter ownership rows; memoise per request; digest named as follow-up |
| M3 | "exact tools/list for this session" false for keys; no label field; admin-only tab restricts nothing | `MCP: ` name convention; presets; honest copy |
| M4 | name-keyed suppression re-enables on rename; scope ripple unstated | keyed `source:workflowId:toolName`; scope ripple enumerated |
| L1 | a pack-only version bump can be shadowed | chain versions bumped too |
| L2 | clamp placement | in the router, before the handler |

## Alternatives weighed

- **Keep the global registry, require metadata on every tool.** Rejected: metadata is
  author-supplied, so it cannot be the boundary; and it leaves tenant A's name and
  description in tenant B's list.
- **Tenant-scope `workflowsRegistry` itself** (the docblock's residual 3). Correct in the
  long run, but it is the whole workflow platform (runs, fork, agents resolve by id), far
  beyond this row. The MCP registry's scoping is independent of it and complete for MCP.
- **Refuse `from-chain` of the projection chains.** Rejected: RFC 0135 says internal chains
  stay instantiable; D1 already makes a copy safe.
- **Let tenant-owned tools honour author-declared `mcpSafetyTier: 'read'`.** Rejected for
  now: an editor could then hand viewers a write through a mis-declared tool. Open question 2.
- **Fix the fences only in the vendored pack.** Rejected: `sync-packs.sh` would revert it,
  and the next pack version would re-open it silently. Host choke points hold regardless.

## Phased plan

| Phase | Scope | Gaps |
|---|---|---|
| P1 | D1 scoped registry + one MCP tenant + one launch gate + honest descriptor, D3 internal projections; migrate the tests that register without ownership (`mcp-current-codec`, `mcp-tool-scope-enforcement`, `notebooks-mcp`, the handler tests); cross-tenant, cross-instance and per-lane (cookie, OIDC-unbound, `owk_` personal, `owk_` shared, env-key, wildcard) witnesses | `MCPWF-1, -2, -4` |
| P2 | D2 host fences + upstream issue, D4 budgets/clamp/decline | `MCPWF-3, -6, -7` |
| P3 | D5 exposure route + predicate, `host:mcp:manage` scope | competitive |
| P4 | D6 Access Hub tab (endpoint, keys, tools, states), `/capabilities` card retired | UX |

## Deferred, each with a reason

- **Stranded seeded copies (found at the gate).** Four of the projection chains are
  zero-config, so the demo seeder had minted them into every seeded tenant as owned
  `wf.seed.*` dashboard workflows. Marking them `internal` stops new seeding but does
  not retract existing rows (`seedWorkflows.ts` — re-seed skips, never retracts). They
  are inert for MCP (D1 never exposes a public-namespace id) and remain as dashboard
  clutter; a retract migration is owed.
  > **Closed by ADR 0789:** `APP_MIGRATIONS` v22 `retract-internal-seed-ownership`
  > removes the ownership rows (never the definitions), keeping any tenant that
  > edited or schedules its copy.
- `MCPWF-5` gate metadata only in TypeScript: needs a chain-level metadata facet, an RFC
  0013 revision in `openwop`. Owed upstream (not yet filed).
- `MCPWF-8` outbound peer content unfenced by default downstream, and `MCPWF-9`
  `isError` → success: pack contracts owned by `openwop-registry`. Owed upstream (not yet filed); no
  shipped chain or chat lane consumes them.
- `MCPWF-10` idempotency, deadline and cancellation on inbound `tools/call`: MCP carries
  no idempotency key; a host-side dedupe needs a design of its own.
- `MCPWF-11` ADR 0087's "never silently mutate" vs RFC 0153 MRTR self-answer: corrected
  in ADR 0087 with an inline note (doc only); naming the requesting server on the outbound
  elicitation interrupt is deferred.
- `MCPWF-12` audit completeness, `-13` unimplemented outbound nodes, `-14` schema and
  status hygiene.
- **Outbound server management UI** (LibreChat MCPBuilder parity): outbound servers are
  Connections providers loaded from connection packs (ADR 0024 / RFC 0095). Adding one at
  runtime from the UI is a Connections-row decision, not this row's.

## RFC verdict

Host-extension only. The mount and its behaviour ride RFC 0020 / RFC 0153 (both already
witnessed by this host); scoping who sees which tool is host policy those RFCs leave to
the host. `/v1/host/openwop-app/mcp/exposure` is non-normative. No capability
advertisement changes. The upstream pack fixes are bug fixes to an existing pack, not a
wire change.

## Open questions

1. Should the Access Hub tab be visible to non-admin members for the "connect a client"
   half (developer keys are self-service)? v1 ships it admin-tier like the other
   credentials tabs; revisit with row 103.
2. Should a tenant-owned tool be allowed to declare itself `read` so viewers can call it?
   Needs an authoring-time check that the graph has no side-effecting node.
3. Should the admin exposure set also be able to disable host projections for the whole
   tenant? D5 allows it (it only narrows).

## Implementation record

| Phase | Commits | Witness |
|---|---|---|
| P1 — D1 scoped registry, D3 internal projections, test migration | `a8fa753f0`, `ae95b7079`, `2a63699b9` | `test/adr0788-mcp-tenant-scope.test.ts` (cross-tenant list + call, handler, cold instance, key lanes, descriptor) — reintroducing the global walk reddens 5 legs |
| P2 — D2 fences, D4 budgets | `a8fa753f0`, `c4430202a`, `dddc55fcc` | `outbound-mcp.test.ts` D2 leg (real peer → client) and the tenant-scope unit legs; a no-op `defangPeerFence` reddens both |
| P3 — D5 exposure switch | `a8fa753f0`, `e231bfc0d` | tenant-scope D5 legs (PATCH merge, key refused 403) |
| P4 — D6 Access Hub tab | `fb44e43c0`, `e231bfc0d` | `frontend/react/src/mcp/__tests__/McpAccessPage.test.tsx` (9) + `hubProjection.test.ts` member leg |
| grade-code / grade-ux Blockers | `e231bfc0d`, `f024b59c4` | MCPCD-2/3/4/6 each sabotage-checked on committed code |

Gate: `npm run ci` green on `f024b59c4` (2026-09-30 05:44).

