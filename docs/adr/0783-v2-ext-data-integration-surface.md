# ADR 0783 — v2 ext `data-integration`: what serving `ctx.dataIntegration` would take

Status: Accepted (2026-10-07) — option B, the phased surface; implemented (2026-10-08): phases 1, 2a, 2b and the 2c claim; phase-2 correction D1–D9 Accepted, D7 corrected below

Follows ADR 0765 (the family is withheld) and ADR 0769 (the messaging precedent).
There is no RFC: `spec/v2/ext/dataIntegration/` is a discovery-only reservation
with a `claims-check` witness. The record is organization-defined, so nothing
here changes the wire.

## Context

`vendor.myndhyve.data-integration` has 8 nodes, and every one calls only
`ctx.dataIntegration.*`. The executor wires no such surface, so all 8 fail
`host_capability_missing`. The pack's `ensureDI` also requires `fetchRest` before
ANY node runs, so a partial surface that omits it makes every node fail, not just
the missing ones.

| Node | Method | What this host has today |
|---|---|---|
| `data.source.mcp` | `fetchMCP({serverId, operation, args})` | `host/mcpClient.ts` `invokeTool` / `readResource`, already on `ctx.mcp`. It maps close to 1:1. |
| `data.variable.fetch` | `fetchVariable({variableName})` | `variablesRuntime` via `ctx.variables.get`. |
| `data.variable.compute` | `computeVariable({variableName, expression, language})` | Nothing: no expression engine. The host must also WRITE the variable. |
| `data.transform` | `transform({expression, language, data})` | Nothing: no JSONata / jq dependency. |
| `data.source.rest` | `fetchRest({sourceId, method, path, params, body, paginate})` | `ctx.connectors.invoke(url, …)` brokers egress, but nothing maps a `sourceId` to a pinned base URL, and nothing paginates. |
| `data.source.graphql` | `fetchGraphql({sourceId, operation, variables})` | Same gap as REST. |
| `data.source.a2a` | `fetchA2A({peerId, taskType, payload})` | `A2aSurface` is keyed by `baseUrl` (SSRF-guarded). There is no `peerId` registry and no `taskType` concept. |
| `data.binding.apply` | `applyBinding({targetType, targetPath, updateMode, preserveUndo})` | `CanvasSurface.write` exists, but has no path-level set, no batched mode and no undo stack. |

Replay is already safe: all 8 typeIds are in `MANIFEST_FAST_PATH_SERVED` (ADR
0341), so a `:fork` serves the recorded outcome and never re-invokes the surface.

## Forces

- **Claim only what executes** (ADR 0765). A record naming the family is read as
  "this pack works here".
- **Egress must stay pinned.** `sourceId` must resolve to a host-owned,
  tenant-scoped source whose base URL the host fixes. The pack must never be able
  to name an arbitrary URL. This is the security core of the decision.
- **One owner per concept.** Sources are credentials plus endpoints, which is what
  Connections already own (ADR 0037/0076). A second "data sources" store beside
  Connections would be the parallel-system smell.
- **No new envelope or wire.** Transform and compute are pure evaluation. The
  engine is a dependency choice, not a protocol one.

## Options

| Option | Cost now | What it leaves or forecloses |
|---|---|---|
| **A. Keep withheld** | Nothing | The family stays single-witness (MyndHyve). This is honest as it is today. |
| **B. Phased surface** (recommended) | Four phases, below | Each phase is claimable only when `ensureDI`'s precondition holds, so the claim waits for phase 2. |
| **C. Thin shim** that implements every method and returns `unavailable` errors | Low | A claim over a pack that mostly fails. This is the exact dishonesty ADR 0765 rejected. |

## Recommended plan (option B)

1. **Phase 1: the surface plus the zero-new-concept methods.**
   - `ctx.dataIntegration` becomes an executor adapter, like messaging (ADR 0769).
   - `fetchMCP` delegates to `ctx.mcp`, keeps `untrustedContent` on the result
     (the pack drops it), and is `<UNTRUSTED>`-fenced as ADR 0358 requires.
   - `fetchVariable` delegates to `ctx.variables`.
   - `transform` / `computeVariable` use a pinned JSONata dependency, evaluated
     with a time and size budget. `computeVariable` writes through
     `setRunVariable`. `jq` refuses with `unsupported_language` until a vetted jq
     engine exists.
   - No claim yet: `fetchRest` is still absent, so `ensureDI` fails every node.
2. **Phase 2: REST and GraphQL over Connections.** `sourceId` is a
   **Connection id** of the run's tenant with a declared `baseUrl`, pinned to the
   provider's `apiHosts`. The request is built as `baseUrl + path` and refused if
   it leaves the pin. Pagination follows `Link` / cursor with a hard page cap.
   Egress goes through `connectors.invoke`, so the SSRF guard, the broker and
   `connections:use` all apply. **Claim the family here**, with `unavailable`
   naming `data.source.a2a` and `data.binding.apply`.
3. **Phase 3: A2A.** A tenant `peerId` → A2A agent-card registry, reusing the A2A
   client ADR. `taskType` becomes the message's skill id.
4. **Phase 4: bindings.** Only if canvas gains path-level writes. Otherwise
   `data.binding.apply` stays `unavailable` permanently.

## Open decisions (for the maintainer)

Decided 2026-10-07 by the product owner, who adopted every recommendation above.

- [x] Adopt option B, or keep A? **B.**
- [x] Add the `jsonata` dependency (MIT, no transitive deps)? It is the one new
      runtime dependency this plan needs. **Yes, pinned.** Re-check the
      no-transitive-deps claim and the added/removed lockfile diff when it lands.
- [x] Is `sourceId` a Connection id? Recommended: yes, one owner. The alternative is
      a new source registry. **Yes: a Connection id.** No second source store.
- [x] Is a family claim with two nodes `unavailable` acceptable after phase 2?
      Messaging shipped with two `unavailable` nodes (ADR 0769). **Yes**, on the
      ADR 0769 precedent. Still no claim before phase 2 (`ensureDI` needs `fetchRest`).

## Falsifiability

- If the spec gains a portable `dataIntegration` contract, the claims-check
  reservation no longer governs. Re-read it before phase 2.
- If a real tenant needs arbitrary-URL REST, that is a different egress decision
  and does not belong to this pack.

## Implementation record

| Phase | What landed | Witness |
|---|---|---|
| 1 | `host/dataIntegrationAdapter.ts`, wired as `ctx.dataIntegration` in `executor.ts`: `fetchMCP` (over the run's own MCP client), `fetchVariable` (presence, so a `null` variable is found), `transform` and `computeVariable` (JSONata 2.2.2, pinned; `computeVariable` writes the variable over the run bag merged with `context`). `jq` and `host-extension` refuse with `unsupported_language`. **No `fetchRest`, so `ensureDI` still refuses every node, and the family stays withheld.** | `test/adr0783-data-integration-adapter.test.ts` (16 tests). The executor-wiring leg is sabotage-red: removing the `ctx.dataIntegration` assignment fails it. |
| 2a | `fetchRest` (GET only; `Link` `rel="next"` pagination, aggregated, every hop confined to the base, capped at 20 pages / 5 MB / 60 s with `pagination_limit_exceeded`) and `fetchGraphql` (queries POSTed to the base; mutations and subscriptions refused before any request; `200 + errors` passed through) over a Connection with an optional `dataSource.baseUrl` (D1). The base is validated at write by `PUT/DELETE …/connections/:id/data-source` (`authorizeManage` + a tenant write) and again at call time (`host/dataSourceUrl.ts`). Every unusable id answers one `source_unavailable` (D2). A workspace Connection is pinnable (D3, widening ADR 0627 D5). `{{var}}` values are encoded as one segment and `..`/`%2e%2e` refused (D4). `connectors.invoke` returns `link` (D5). Writes refuse with `unsupported_operation` until the 2b ledger. **No claim: the family stays withheld until 2c.** | `test/adr0783-p2a-data-sources.test.ts` (28 tests: the real broker, a loopback provider, the pack's own `data.source.rest`/`data.source.graphql` nodes and one real executor run). Ten mechanisms sabotage-red: D4 encoding, D4 dot segments, D2 one code, D1 call-time, D3 workspace pin, D6 per-hop confinement, D6 byte cap, D6 wall-clock cap, D8 mutation refusal and the D1 re-consent carry-over. `crm-gmail-sync-pin` now expects the workspace row instead of `workspace_scoped_pin`. |
| 2b | Writes (D7): `POST`/`PUT`/`PATCH`/`DELETE` and GraphQL mutations go through the egress ledger (`egress:sent`, channel `data`) keyed on the pack's `idempotencyKey`, which is also forwarded as `Idempotency-Key`. The insert-if-absent CAS is the one duplicate check. Put-on-accept: a non-2xx or a transport failure releases the key so a retry re-sends; a duplicate fails `duplicate_result_unavailable` and is never re-sent. A write with no key is `validation_error`; a GET is never ledgered; only a GET paginates. A read-only provider refuses a mutation (`connector_read_only`, D8), and the invoker's existing gate refuses its `PUT`/`PATCH`/`DELETE` with the same code. The D1 SPA field: a **Data source** action on each active row of the Connections table, offered to a workspace writer, with the host's URL rule shown beside the field. | `test/adr0783-p2a-data-sources.test.ts` (36 tests, eight new for D7/D8 writes and one through the pack's own node: a retried node derives the same key, so it sends once). Seven mechanisms sabotage-red: the CAS, release-on-failure, the required key, the forwarded header, the recorded status, the read-only mutation refusal, and mutations being ledgered. `frontend/react/src/features/connections/__tests__/DataSourceDialog.test.tsx` covers set, the host's refusal, clear, and that neither a Viewer nor a revoked row is offered the action. |
| 2c | The D9 claim: `EXT_FAMILY_CLAIMS` gains `data-integration` (`wiring: 'adapter'`, `adr: '0783'`) with the six served methods, and `unavailable` names `data.source.a2a` (needs `ctx.dataIntegration.fetchA2A`) and `data.binding.apply` (needs `ctx.dataIntegration.applyBinding`). The `WITHHELD` pin moves in the same commit. The contract test now accepts a pack call only as a claimed method or as one named in `unavailable`, never both. | `test/adr0765-ext-family-records.test.ts`: contract, execution and wire legs for the new record; the adapter's keys equal the claim's methods; the executor's wiring hands the adapter `tenantId` and `connectors` (without them the REST and GraphQL methods fail `host_capability_missing`). |

> **Follow-up (2026-10-09):** the two nodes the 2c claim names as `unavailable`
> (`data.source.a2a`, `data.binding.apply`) are decided in
> [ADR 0865](0865-data-integration-a2a-and-binding.md). Each of its phases removes
> its own `unavailable` entry in the same commit as its end-to-end witness.

**Correction to "Recommended plan" phase 1 (2026-10-07).** That plan says `fetchMCP` "is
`<UNTRUSTED>`-fenced as ADR 0358 requires", as if the adapter fences. It does not, and
it should not. MCP content is defanged on the way IN by the one MCP client
(`defangPeerFence`), and every model boundary fences it (`toModelToolResult`,
`promptCompose`). A second fence inside node data would corrupt structured output.
The adapter keeps `untrustedContent: true` on its result. The pack drops that flag, so
provenance past the node rests on the boundary fencing, as it does for every other MCP
read.

**The budget, and its limit.** JSONata's own guardrails cap each evaluation: 1 s
`timeout`, 200 `stack`, 100k `sequence`. They are checked as each evaluation step
begins, so ONE long built-in call (a large `$pad`, a pathological regex) is not
preempted. That is why the expression (8 KiB), the input (1 MB) and the result (1 MB)
are size-capped too. A regex-heavy expression over a 1 MB string can still hold the
event loop for longer than the timeout. Revisit before phase 2, when user-authored
expressions meet REST payloads.

**`jsonata` was added as measured.** The lockfile diff was `added: node_modules/jsonata`,
removed none, changed none. `@azure/core-rest-pipeline` is intact, and the
`npm audit` count is unchanged from main.

**Isolated packs need no extra wiring.** The ADR 0555 broker enumerates the ctx the
executor built (`enumerateCtxGrant`), so `ctx.dataIntegration.*` crosses the
isolation boundary like any other surface.

## Correction: phase 2, as measured against the code (2026-10-08, `/architect`)

> **Status of this section: the FINDINGS are measured; the DECISIONS (D1–D9) are
> PROPOSED.** The product owner accepted the original phase-2 text, not this
> correction, and has not yet said proceed. Phase 2 has not started. Do not build
> on D1–D9 until this note records that decision.
>
> **Decision recorded (2026-10-08): the product owner said "proceed" on this
> correction, so D1–D9 are ACCEPTED.** Phase 2a is built on them (implementation
> record above); 2b and 2c follow the phasing at the end of this section.

The accepted phase-2 text describes "a Connection id with a declared `baseUrl`" and
"pagination follows `Link`/cursor" through `connectors.invoke`. Four of its premises are
false in the code:

1. **No Connection or provider declares a base URL.** `Connection`
   (`connectionsService.ts:42-64`) and `ProviderManifest` (`providerRegistry.ts`) carry
   `apiHosts` eTLD+1 pins only. Per-instance providers (`servicenow`: `service-now.com`;
   `workday`) get their base from node config today (`bootstrap/nodes.ts:2690`). The
   pack field that once claimed to supply it, `instanceUrlTemplate`, was retired by
   ADR 0599 because nothing read it. That makes the bar for a new field explicit: it
   ships with its reader, or not at all.
2. **`connectors.invoke` returns no headers** (`connectorInvoker.ts:175-183`), so `Link`
   pagination cannot be built on it as-is.
3. **A pin cannot name a workspace Connection.** `selectPinnedConnection`
   (`connectionsService.ts:536-556`, ADR 0627 D5) refuses `workspace_scoped_pin`, and
   its comment invites widening "with a witness" once a consumer exists. A shared data
   source is that consumer.
4. **"Cursor" pagination has no field names to follow.** The pack's config carries
   only `paginate: boolean`, so a cursor scheme cannot be named. Phase 2 serves `Link`
   only.

### Decisions

- **D1. The base URL lives ON the Connection, owned by Connections.**
  - An optional `dataSource: { baseUrl }` on the row, set through
    `PUT /host/openwop-app/connections/:id/data-source`. This is the `…/:id/inbound`
    sub-resource precedent (`routes.ts:553`), with the same owner gate.
  - The field is additive on a `DurableCollection` JSON row, so no migration is needed.
  - Rejected: node config (the pack schema has no `baseUrl`, and the pack is not ours);
    a base derived from `apiHosts` (eTLD+1 pins name no instance); a separate source
    store (the "one owner" decision already made).
  - **Validated at write AND at call time**, because a provider's `apiHosts` or the
    tenant egress policy can change after the write:
    - `https:`;
    - no userinfo, query or fragment;
    - host matches the provider's `apiHosts` (`hostMatchesApi`) and is not
      SSRF-denied (`isDeniedWebhookHost`);
    - path normalised, with no `.`/`..` segments.
  - The reader ships in the same PR: `fetchRest`/`fetchGraphql`.
  - **The SPA field ships with it.** A claim that no tenant can configure is the
    claim-only-what-executes failure.
- **D2. `sourceId` is a Connection id, resolved before the call.** The host reads
  `getConnection(run.tenantId, sourceId)` (tenant-checked), then calls
  `invoke(c.provider, { connectionId: sourceId, … })`. Authorization stays at the ONE
  choke (`selectAuthorizedConnection`): the provider allowlist, ownership, and
  `connections:use`. All of these, plus "not found" and "no `dataSource`", surface as
  ONE code, `source_unavailable`, so a workflow cannot probe connection ids.
- **D3. Widen the pin to workspace Connections, with a witness.** The unpinned path
  already self-authorizes a workspace Connection for any run in its tenant
  (`connectionsService.ts:498-504`), so an EXACT pin to one is no wider. Tenant, provider
  and `active` are still checked. The user and org arms are unchanged (the ADR 0627
  gmail witnesses must stay green).
- **D4. Path confinement, before the broker.**
  - `{{var}}` placeholders are filled from `params` and **each value is
    `encodeURIComponent`'d**, so a value cannot introduce a `/`, `..` or a scheme.
  - Remaining scalar params become the query string.
  - The joined path is refused, with `validation_error`, if it contains `://`, a
    leading `//`, a backslash, a control character, or a `.`/`..` segment (raw or
    `%2e`-encoded).
  - The resolved URL must keep the base's origin AND sit under the base's path prefix.
  - The broker's `apiHosts`, SSRF and firewall checks then run as defence in depth,
    not as the only check.
- **D5. Headers: a typed `link` field, not a header bag.**
  - `ConnectorInvokeResult` gains `link?: string`.
  - Exposing every response header would hand a pack `set-cookie` and provider
    internals.
- **D6. Pagination: RFC 8288 `rel="next"` only, capped, and failing closed.**
  - Every next URL passes D4 again: same origin, under the base prefix.
  - Caps: **20 pages, 5 MB aggregate, 60 s wall clock.** Each call keeps the broker's
    10 s timeout.
  - Hitting a cap fails `pagination_limit_exceeded`. It never returns a silently
    truncated "success", because a partial list presented as complete is the
    absence-is-a-claim defect.
  - Array page bodies concatenate. A non-array page fails
    `pagination_unsupported_shape`; the pack's contract is an aggregated array.
- **D7. Writes are deduplicated by the egress ledger (the ADR 0619 / 0769 mechanism),
  keyed on the pack's `idempotencyKey`.** That key is stable across retries: a hash of
  run, node and args.
  - **Which calls count as writes:** non-GET REST, and a GraphQL `mutation`.
  - **What is recorded:** status plus a bounded body (64 KB).
  - **A duplicate** returns the recorded result. If the body was over the bound, it
    fails `duplicate_result_unavailable` and never re-sends.
  - The key is also forwarded as `Idempotency-Key`.
  - **Replay:** a replay `:fork` never reaches the adapter (all eight `data.*` are in
    `MANIFEST_FAST_PATH_SERVED`). A `branch` fork re-sends by design (a new run id),
    as ADR 0627 states for every side-effect node.
  > **CORRECTED 2026-10-08 (phase 2b): the ledger records the STATUS only, never a
  > body, so a duplicate always fails `duplicate_result_unavailable`.** As written,
  > D7 would have stored up to 64 KB of the provider's response in `egress:sent`.
  > That collection is exempt from subject erasure (ADR 0464,
  > `subject-erasure-coverage.test.ts`) on the stated ground that it "stores no
  > name/address/body". A body read from a customer's API (a CRM record, a ticket)
  > can carry exactly that, so D7 as written would have made the exemption false
  > without failing any test. The cost is narrow: a duplicate only arises after a
  > write was ACCEPTED and its node then re-ran (a `config.retry` after a later
  > failure, or a same-run recovery restart), and the workflow can branch on the
  > typed code. A failed or timed-out write is released, not recorded, so it is
  > retried; `Idempotency-Key` is the provider-side guard for a timeout. Storing a
  > body would need its own store with a subject eraser, which no consumer has
  > asked for.
- **D8. GraphQL.**
  - **Request:** POST `{ query, operationName?, variables? }` to the base URL itself.
  - **Operation type** is read from the operation's leading keyword, comments
    stripped:
    - `subscription` → `unsupported_operation`;
    - `mutation` → refused on a `readOnly` provider (`connector_read_only`; the
      invoker's method gate cannot see it, because GraphQL is always POST) and
      ledgered per D7;
    - otherwise it is a query.
  - **Response:** HTTP 200 with `errors[]` returns `{data, errors}` (GraphQL partial
    success is legitimate). Non-2xx fails `source_http_error` with the status.
- **D9. The claim, and only after the witnesses.**
  - `EXT_FAMILY_CLAIMS` gains `data-integration` (`wiring: 'adapter'`), with all six
    served methods: `fetchMCP`, `fetchVariable`, `transform`, `computeVariable`,
    `fetchRest`, `fetchGraphql`.
  - `unavailable` names `data.source.a2a` and `data.binding.apply` (the ADR 0769
    shape). The `WITHHELD` pin moves in the same commit.
  - `transform` still refuses `jq`/`host-extension`. That is a declared limit, not an
    unavailable node.

### Witnesses (each must fail when its mechanism is removed)

- **D1:** write refuses `http:`, an off-pin host, an SSRF host, userinfo and a query
  string. A base valid at write time but off-pin at call time is refused when called.
- **D1, route level** (`createApp` + session): a viewer cannot set another member's
  `data-source`, mirroring the `inbound` gate.
- **D2:** a foreign-tenant id, a revoked connection, another user's user-scoped
  connection and a connection with no `dataSource` all return the SAME
  `source_unavailable`.
- **D3:** a pinned workspace Connection resolves; the gmail-pin suite
  (`crm-gmail-sync-pin`) is unchanged.
- **D4** (table-driven): `{{id}}` with `../x`, `%2e%2e`, `//evil`, `http://evil` and
  `a\b` never leaves the base prefix. Encoded values stay single segments.
- **D6:**
  - a `Link` next to another origin, and one outside the prefix, are refused;
  - each cap trips the typed error;
  - a three-page fixture aggregates in order.
- **D7:** a retried POST with the same key sends once and returns the recorded
  result; a GET is not ledgered.
- **D8:** a mutation on a `readOnly` provider is refused; a subscription is refused;
  `200 + errors` passes through.
- **End to end:** the pack's `data.source.rest` node through the real executor and the
  broker, against a test origin admitted the way the connector-invoker tests admit
  one.
- **D9:** `adr0765-ext-family-records` moves `data-integration` from `WITHHELD` to
  claimed. The probe adapter's methods equal the claim's `methods`.

### Phasing (real gates only)

- **2a:** D2, D3, D4, D5, D6 and D8 (read paths), with the D1 backend field and route.
  No claim.
- **2b:** D7 (writes and mutations) and the D1 SPA field.
- **2c:** the D9 claim, once every witness above is green. The claim is the gate:
  nothing is advertised before the end-to-end witness executes.

### Correction: phase 2a parser and completion boundaries (2026-10-08)

Static review of `0aa3dea70` found that an escaped triple quote in a valid
GraphQL block string fooled the handwritten operation scanner: a subsequent
named mutation/subscription could be POSTed as a read, without the future D7
ledger. Operation kinds now come from GraphQL.js's executable AST, not a
parallel lexer; syntax errors, type-system definitions, and documents without
operations fail before the connection broker is invoked. All operations remain
query-only in phase 2a regardless of `operationName`.

Malformed nonempty RFC 8288 Link headers now fail `source_invalid_response`
instead of being mistaken for the final page. The 60 s pagination deadline is
checked before each request, after every awaited broker result, and before a
terminal return; a late final page never returns success. Each in-progress
request retains the broker's 10 s AbortSignal timeout. This correction does not
add an outer cancellation signal: the result deadline is fail-closed, while an
already-started request can consume up to the remaining broker timeout.

Regression evidence must run on the integrated tree: the real broker + loopback
HTTP source witnesses zero provider invocations for escaped-block-string
mutation/subscription, rejects malformed continuation without a partial list,
and refuses a final page delivered after the deadline. These artifacts are
proposed until those tests and the canonical full gate pass; family claim still
withheld, and no write ledger or replay classification is changed.

Follow-up review correction: Link relation parameters are parsed sequentially,
outside quoted parameter contents, with quoted-pair decoding and first-`rel`
semantics (RFC 8288 §3). Missing/empty relation metadata fails closed; legitimate
unknown non-next relations remain a terminal page. Accumulation now iterates
instead of argument-spreading arrays: 200000 zero entries take only 400001 JSON
bytes, but exceeded the JavaScript call-argument limit before the 5 MB cap. The
new regression drives that dense page through the real broker/HTTP boundary.

> **Carried into phase 2b (2026-10-08):** the AST classification is kept, and it
> decides the WRITE path too. If ANY operation in the document is a mutation, the
> whole request is a write: it needs an `idempotencyKey` and goes through the D7
> ledger, whatever `operationName` selects. So a mutation hidden behind a query
> is refused `validation_error` before dialing when it has no key, rather than
> `unsupported_operation`. A subscription is still never served. The escaped-
> block-string witness now pins both outcomes.

> **Delivery correction 2026-10-09 (D1 SPA):** aria-disabled keeps controls focusable, so it must be paired with a synchronous submission guard. The Data source dialog now locks save/clear/close through one in-flight ref, keeps the URL read-only during the request and marks the form busy. A delayed-response regression verifies double clicks, Enter, clear and cancel cannot race the save, and focus is retained. D7 does not promise exactly-once delivery after an ambiguous transport failure on a provider that ignores its forwarded Idempotency-Key.

> **Delivery correction 2026-10-09 (D8):** the generic connector broker permits POST read APIs. Because REST non-GET is explicitly classified as a write by this adapter, it checks the provider's readOnly posture before the ledger or broker for POST as well as PUT/PATCH/DELETE. The HTTP witness covers all four refused verbs and retains the read-only GraphQL query control.
