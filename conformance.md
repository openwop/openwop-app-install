# Conformance evidence — openwop-app reference host

Per-RFC evidence that this reference host actually serves the capabilities it
advertises at `/.well-known/openwop`. Each entry pins the advertisement, the
implementing seam, the automated witness (a test in the suite), and a real
captured transcript. The honest-witness rule applies: **do not advertise a
capability this host cannot serve for real on its deployed runtime.**

---

## RFC 0117 — Front-end plugin packs (ui-plugin/1 host-RPC witness)

**Status:** implemented on the demo host (ADR 0153 Track 2). openwop-app is the
**reference implementation + witness #1** while RFC 0117 is `Active`; graduation to
`Accepted` additionally requires a second independent non-steward witness.

**Advertisement** (root-level `uiPlugins`, `routes/discovery.ts`, single-sourced from
`host/uiPluginRpc.ts:uiPluginsCapability()`):

```json
{ "supported": true, "isolation": "cross-origin-iframe",
  "surfaces": ["artifact-viewer", "route", "settings-panel"],
  "hostApi": ["artifact.read", "artifact.write", "host.toast", "host.navigate"],
  "maxEntryBytes": 2097152 }
```

`isolation` is a schema `const` — in-process plugin loading is a protocol-tier MUST NOT
(`frontend-plugin-isolation`). The closed `hostApi` carries no credential/secret method
(`frontend-plugin-no-byok`).

**Implementing seam.** `POST /v1/host/openwop-app/ui-plugin/rpc` (product, always on) and
the conformance alias `POST /v1/host/sample/ui-plugin/rpc` (env-gated
`OPENWOP_TEST_SEAM_ENABLED`) share one handler (`routes/uiPlugins.ts`). `artifact.read`/
`artifact.write` bind to the live `host.canvas` store; the opaque `version` token is the
canvas version. A write carrying a token the host did not mint (stale OR unknown) →
`artifact_conflict` + `currentVersion`, **with no persist**; an absent artifact →
`artifact_not_found`; an undeclared method → `method_not_allowed`. The host provisions a
`conformance-canary` artifact under the test seam so the §Concurrency leg conflicts against
a real current version.

**Automated witness** — `@openwop/openwop-conformance@1.44.0`,
`src/scenarios/frontend-plugin-packs.test.ts`, run NON-VACUOUSLY under
`OPENWOP_REQUIRE_BEHAVIOR=true`:

```
OPENWOP_CONFORMANCE_ROOT=<vendored-suite> OPENWOP_REQUIRE_BEHAVIOR=true \
  npm run test:conformance -- --filter frontend-plugin
# → frontend-plugin-packs.test.ts: 10 passed / 4 capability-gated soft-skips; exit 0
```

Verified legs: `frontend-plugin-isolation` (advertised `cross-origin-iframe` const),
`frontend-plugin-rpc-allowlist` (undeclared method → `method_not_allowed`),
`frontend-plugin-no-byok` (no credential-bearing envelope field admitted), and
`frontend-plugin-packs.md §Concurrency` (a stale `artifact.write` → `artifact_conflict` +
`currentVersion`, no persist). Suite version cited: **1.44.0** (the version that first ships
this scenario; suite total 378). Host rev: the merge of openwop-app#973 + the §Concurrency
fix.

---

## RFC 0118 — Parallel sub-workflow fan-out + join (dispatch witness)

**Status:** implemented on the demo host (ADR 0165). openwop-app is the **reference dispatch
host + witness #1** while RFC 0118 is `Active`; graduation to `Accepted` additionally requires a
second independent non-steward witness.

**Advertisement** (root-level `dispatch`, `routes/discovery.ts`, single-sourced from
`host/dispatchFanOut.ts:dispatchCapability()`):

```json
{ "supported": true, "fanOutSupported": true,
  "fanOutPolicies": ["sequential", "reject", "parallel"],
  "joinModes": ["wait-all"], "onChildFailureModes": ["collect", "absorb"], "maxFanOut": 16 }
```

**Honesty note — why `joinModes: ["wait-all"]`, not all four.** `foldJoin` implements all four
modes, but `quorum`/`first`/`race` (and `onChildFailure:'fail-fast'`) require cancelling in-flight
children, which `executor/subWorkflowDispatcher.ts` cannot do (it always awaits a child to terminal;
no mid-run cancel hook, ENG-9). The host advertises and accepts only `wait-all`, so the claim stays
honest under `OPENWOP_REQUIRE_BEHAVIOR=true`. The other modes light up when child cancellation lands.

**`onChildFailureModes` (RFC 0118 §seam amendment, openwop#789).** The second join axis
(`mode` × `onChildFailure`) is capability-gated, mirroring `joinModes`. This host advertises
`["collect","absorb"]` — both honored (neither short-circuits/cancels losers, so neither needs the
cancellation the executor lacks); `fail-fast` is omitted and rejected at `POST /v1/workflows`
(`validation_error`), now **discoverably** from `/.well-known/openwop` rather than as an
undiscoverable registration footgun. Per the amendment, absent ⇒ `["collect"]` and a non-advertising
host MUST reject `fail-fast`/`absorb`; advertising the descriptor is what lets this host keep
honestly accepting `absorb`. Single-sourced off `dispatchCapability()`.

**Implementing seam.** `POST /v1/host/openwop-app/dispatch/fanout` (product, always on) and the
conformance alias `POST /v1/host/sample/dispatch/fanout` (env-gated `OPENWOP_TEST_SEAM_ENABLED`)
share one handler (`routes/dispatchFanOut.ts`) running the REAL `runParallelFanOut` coordinator +
`foldJoin` — the normative RFC 0118 join semantics (`joinOutcome` × counts × `mergeOrder`, per
`joinPolicy.mode` × `onChildFailure`; bounded by `min(maxConcurrency, maxFanOut)`). The seam folds
deterministic `completed` child terminals so the witness is non-vacuous without registered child
workflows.

**Executor-integrated path (landed, ADR 0165 executor arm).** A *registered* workflow now runs
`fanOutPolicy:'parallel'` for real: `POST /v1/workflows` accepts the parallel config
(`host/workflowDefinitionValidation.ts`, single-sourced off the same capability), and the
`core.dispatch` node (`bootstrap/nodes.ts`) drives the same `runParallelFanOut` coordinator over the
existing `dispatchSubWorkflow`, emitting `core.dispatch.fanOut`/`join` and producing the
`{joinOutcome, children[]}` output. Replay/fork determinism (R1): `outputMapping` is re-applied once
in the recorded `mergeOrder`, never recomputed from child wall-clock — gated by
`test/dispatch-fanout-executor.test.ts` (first-dispatched child made to terminate last must win a
colliding mapping).

**Automated witness** — `@openwop/openwop-conformance@1.45.0`,
`src/scenarios/dispatch-fanout-parallel.test.ts`, run NON-VACUOUSLY under
`OPENWOP_REQUIRE_BEHAVIOR=true`:

```
OPENWOP_CONFORMANCE_ROOT=<vendored-suite> OPENWOP_REQUIRE_BEHAVIOR=true \
  npm run test:conformance -- --filter dispatch-fanout
# → dispatch-fanout-parallel.test.ts: 10 passed; exit 0
```

Verified: the `DispatchConfig`/event-`$def` schema legs (server-free), and the capability-gated
behavioral leg — a wait-all/collect parallel fan-out over three children joins with
`joinOutcome: 'satisfied'`, a `children[]` of length 3, and a `mergeOrder[]` (the replay-
deterministic merge tiebreak). Suite version cited: **1.45.0** (first ships this scenario). Host
rev: ADR 0165.

---

## RFC 0120 — Connection-pack provider `apiHosts` (egress allow-list witness)

**Status:** implemented on the demo host (ADR 0169). openwop-app is the **reference connection
host + witness #1** for RFC 0120 (`Active`). Graduation to `Accepted` is recorded as a
**single-witness** (tier-2 + reference-host) pass: the second arm — a brokered-connector-egress
host — is honestly absent (myndhyve-1 opted out; no brokered egress), so there is no second
independent witness to require.

**Advertisement** (`connections.packsSupported: true`, `routes/discovery.ts`) — already served;
the apiHosts allow-list is read by `host/brokeredEgress.ts` for every credentialed connector call.

**What closed.** A pack-delivered provider could not declare its credentialed-egress hosts, so
`brokeredEgress` could pin only built-in `ProviderManifest`s and a pure ad pack failed closed
(openwop-app#1006): the schema now carries `provider.apiHosts` + the `openapi ⇒ apiHosts`
conditional-MUST, `connectionPackLoader.ts` reads it into the manifest, and all 8 in-tree
`openapi` packs declare an eTLD+1 apiHost. `host/connectionInjection.ts::hostMatchesApi` (the
dot-anchored eTLD+1 matcher) was already correct — unchanged.

**Implementing seam.** `POST /v1/host/{openwop-app,sample}/connection-packs/egress-check`
(`routes/connectionPackSeam.ts`, env-gated `OPENWOP_TEST_SEAM_ENABLED`, 404 in production) — a pure
DECISION probe `{provider, requestHost} → {allowed, code?}` that reports the verdict of the SAME
`hostMatchesApi` against the resolved provider's `apiHosts`. No credential is read, no outbound
request made. Each connection-pack seam handler (`install`/`resolve`/`consent-plan`/`egress-check`)
is now registered at BOTH the product and the spec-canonical `sample` base — the suite drives
`sample`, so the alias is what makes the behavioral leg run instead of 404-soft-skipping. Pinned
deterministically in-repo by `test/connection-pack-egress-seam.test.ts` (13 cases: permit
`graph.facebook.com`/`facebook.com`; fail-closed `evil.com`/`notfacebook.com`/`facebook.com.evil.com`
with `egress_host_not_allowed`; unresolved-provider + no-apiHosts fail-closed; 400s; and 404 when
the seam is disabled) so a regression fails here, not silently in the suite.

**Automated witness** — `@openwop/openwop-conformance@1.46.0`,
`src/scenarios/connection-pack-apihosts.test.ts`, run NON-VACUOUSLY under
`OPENWOP_REQUIRE_BEHAVIOR=true`:

```
OPENWOP_REQUIRE_BEHAVIOR=true npm run test:conformance -- --filter apiHosts
# → connection-pack-apihosts.test.ts: 8 passed; exit 0
```

Verified: the schema legs (server-free — `apiHosts` shape + the `openapi ⇒ apiHosts` conditional
MUST + entry-shape rejections), the matching-rule legs (item-10 dot-anchored eTLD+1 containment, no
substring escape), and the **capability-gated behavioral egress leg** — install the `meta-ads`
fixture (`apiHosts:["facebook.com"]`), then `egress-check` PERMITS `graph.facebook.com` and
FAILS CLOSED on `evil.com`/`notfacebook.com`/`facebook.com.evil.com`. Suite version cited:
**1.46.0** (first ships this scenario; suite total 380). Host rev: ADR 0169 + openwop-app#1006.

**Witness finding filed back to the steward (suite self-inconsistency in 1.46.0).**
`connection-pack-reach-exclusive.test.ts` (an always-on, server-free schema probe, host-independent)
mutates the mcp-reach `github` fixture to `reach: openapi` WITHOUT adding `apiHosts` and asserts it
validates — but 1.46.0's own schema now *requires* `apiHosts` for `openapi` reach (the conditional
MUST this very RFC added). So that positive case fails for **every** host on 1.46.0. Not a host
defect (no `driver` call, no host state); the fix is suite-side (give reach-exclusive's openapi case
an `apiHosts`, or exempt it). Reported on the 0117 crosstalk queue; expected a 1.46.1.

---

## RFC 0115 — Run Transport Economy (conditional GET + Content-Encoding)

**Status:** implemented on the demo host (Phase 1 of the token-economy program).

**Advertisement** (`capabilities.restTransport`, `routes/discovery.ts`):

```json
{ "conditionalRunGet": true, "contentEncodings": ["br", "gzip"] }
```

**Honesty note — why `["br","gzip"]`, not `["gzip","br","zstd"]`.** The advert is
derived at runtime from `SUPPORTED_RUN_ENCODINGS` (`host/restTransport.ts`), which
includes an encoding only if `node:zlib` can encode it on this build. The deployed
runtime is **Node v22.13.1, which has no `zstdCompressSync`** (zstd landed in
`node:zlib` after the 22.15/23 line) — but it does have gzip + brotli. Advertising
`zstd` here would be a dishonest wire claim. Per the RFC 0115 enum
`["gzip","br","zstd"]` (gzip = SHOULD baseline; br/zstd OPTIONAL — Unresolved Q2
resolved by the steward 2026-06-26), this host advertises `br` + `gzip`. When the
runtime gains zstd, the same constant flips it on automatically; no change to the
advert site. Server preference is `zstd > br > gzip` (better ratio first).

**Implementing seam:**
- `backend/typescript/src/host/restTransport.ts` — `runEtag()` (strong validator
  `"<runId>.<maxSequence>"`), `ifNoneMatchSatisfied()`, `sendNegotiatedRunJson()`,
  `SUPPORTED_RUN_ENCODINGS`.
- `backend/typescript/src/routes/runs.ts` — `GET /v1/runs/:runId` computes the
  ETag from `storage.getMaxSequence(runId)` (the run's **latest persisted
  event-log sequence**, per RFC 0115 §Proposal + architect pin 2026-06-26 — NOT
  a wall-clock/cached projection), evaluates `If-None-Match` and short-circuits a
  `304` **before** the snapshot projection + tenant-sibling scan, then negotiates
  `Content-Encoding`.

**Automated witness:** `backend/typescript/test/run-transport-economy.test.ts`
(6 cases, all green): advert shape; strong ETag on 200 + `If-None-Match` → 304
empty; ETag stable with no transition and changes after one; **every advertised
encoding** decodes byte-identically to identity; server preference (br before
gzip); identity fallback when no served encoding is acceptable. The encoding
assertions read the host's own advert so the test can't drift from what the host
serves. Gated conceptually on
`capabilityFamily(d,'restTransport')?.conditionalRunGet === true` (the suite's
`run-transport-economy.test.ts` scenario, owned by the steward).

**Captured transcript** (in-process boot, `memory://` storage, `openwop-app.uppercase` run):

```
# restTransport advert
{"conditionalRunGet":true,"contentEncodings":["br","gzip"]}

# 200 carries a strong, sequence-derived ETag
GET /v1/runs/ba5c3fc8-…  ->  200  ETag: "ba5c3fc8-….5"  Vary: Accept-Encoding

# If-None-Match matching the current ETag -> 304, empty body
GET (If-None-Match: "ba5c3fc8-….5")  ->  304  body bytes: 0

# after a real state transition the ETag changes, old validator is stale
prev ETag: "ba5c3fc8-….5"   new ETag: "ba5c3fc8-….6"
GET (stale If-None-Match)  ->  200  (re-download, not a spurious 304)

# every advertised Content-Encoding round-trips byte-identically to identity
identity: 200  Content-Encoding: (none)  bytes: 248
br:       200  Content-Encoding: br    bytes: 153  decode==identity: true  Vary: Accept-Encoding
gzip:     200  Content-Encoding: gzip  bytes: 193  decode==identity: true  Vary: Accept-Encoding

# server preference (Accept-Encoding: gzip, br) -> br
```

**Reviewer curl recipe** (against a running host; `$T` = bearer token, `$R` = run id):

```sh
# strong, sequence-derived ETag on 200
curl -sD - -o /dev/null -H "authorization: Bearer $T" "$BASE/v1/runs/$R" | grep -i '^etag\|^vary'
# matching If-None-Match -> 304 empty
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $T" \
  -H 'if-none-match: "<etag>"' "$BASE/v1/runs/$R"        # -> 304
# gzip round-trip (curl --compressed auto-decodes; decoded body == identity)
curl -s --compressed -H "authorization: Bearer $T" "$BASE/v1/runs/$R" | diff - <(curl -s -H "authorization: Bearer $T" "$BASE/v1/runs/$R")
```

**Cross-impl witness:** the live Active→Accepted graduation witness is served by a
second host (MyndHyve, task T-0115-myn) against its real origin. Note for that
host: it must advertise only encodings its own Node build can serve (same zstd
caveat).

---

## RFC 0112 — Compact tool projection

**Status:** implemented on the demo host (Phase 2). Route ships ready; the
`toolCatalog.compactView` advert is **held dark** until RFC 0112 is `Accepted`
(env `OPENWOP_TOOLCATALOG_COMPACTVIEW=true` flips it on — honest-advert rule).

**Advertisement** (`capabilities.toolCatalog`, when the MCP catalog is mounted
AND the compact-view env is on):

```json
{ "supported": true, "sources": ["mcp"], "compactView": true }
```

**Endpoints:** `GET /v1/tools?view=compact` → `{ "tools": CompactToolDescriptor[] }`
(enveloped); `GET /v1/tools/{toolId}?view=compact` → one bare `CompactToolDescriptor`.
The compact projection maps the **same** `listToolsForPrincipal(principal)` set as
the standard view, so the compact `toolId` set equals the standard view's for the
same principal (RFC 0074 authorization-scoping + non-disclosure preserved; an
unauthorized id still 404s).

**Shape** = the steward-owned `compact-tool-descriptor.schema.json`: required
`toolId`+`source`+`safetyTier`; optional `title`/`description`/`inputSchema`;
`auth`/`egress`/`approval`/`replayPolicy`/`outputSchema`/`costHint`/`latencyHint`
DROPPED. `inputSchema` is included **only when it already satisfies the
self-contained structural subset** (top-level `type:object`+`properties`, no
`$ref`/`oneOf`/`allOf`/`anyOf`/`not`/`patternProperties`/`dependentSchemas`);
otherwise OMITTED (optional — an honest omission beats a fabricated lossy schema).

**Relationship to ADR 0148 A3** (`providers/toolSchemaCompaction.ts`): SIBLING,
not the same shape. A3 strips inputSchema *annotations* but PRESERVES `$ref`/`oneOf`
(functional-preserving, wire-invisible host→provider transform); this projection is
the stricter wire-facing view. They share the annotation-strip primitive only. The
full `inputSchema` remains the validation authority on tool dispatch — the compact
view is a read projection, replay-neutral.

**Implementing seam:** `backend/typescript/src/host/compactToolDescriptor.ts`
(`CompactToolDescriptor`, `toCompactDescriptor`, `compactInputSchema`);
`routes/toolCatalog.ts` (`?view=compact` branch on both routes).

**Automated witness:** `backend/typescript/test/compact-tool-projection.test.ts`
(7 cases): advert; enveloped list dropping non-compact fields; compact==standard
toolId set; bare by-id + 404; subset keep/omit ($ref→omit) unit tests.

**Captured transcript** (in-process boot, MCP catalog on, authed owner, notebook tools):

```
# advert
{"supported":true,"sources":["mcp"],"compactView":true}

# GET /v1/tools  vs  ?view=compact  (same authorized principal)
standard: 3651 bytes, 8 tools (bare array)
compact:  2663 bytes, 8 tools (enveloped { tools: [] })
reduction: 27.1%
toolId set identical: true

# one descriptor: standard vs compact (dropped fields)
standard keys: toolId,source,title,safetyTier,auth,egress,approval,replayPolicy,inputSchema,description
compact  keys: toolId,source,safetyTier,title,description,inputSchema
```

**Re-gate:** against the steward's published 1.39.0 `compact-tool-projection` scenario
on their ping, and flip the `compactView` advert env once RFC 0112 is `Accepted`.

---

## RFC 0113 — Memory injection budget

**Status:** implemented on the demo host (Phase 3).

**Advertisement** (`capabilities.memory.injectionBudget`):

```json
{ "supported": true, "tokenCounter": "chars" }
```

**Honesty note — `tokenCounter: "chars"`.** The lever is `tokenBudget`, but this
host counts **content chars**, not BPE tokens (it reuses the ADR 0148 A4
`budgetByChars` primitive, "~chars/4" as a directional token proxy). The advert
declares the real unit rather than claiming a token count it doesn't compute —
same honest-unit discipline as RFC 0115's runtime-detected encodings. (If the
steward's `tokenCounter` enum excludes `"chars"`, flag it — the host adds a
chars→token approximation or the enum widens.)

**Lever:** `tokenBudget` on the memory list options (`MemoryListOpts`,
`host/inMemorySurfaces.ts`), surfaced on `GET /v1/host/openwop-app/memory?tokenBudget=`.
Applied AFTER recency rank + `limit`: keep the highest-priority entries whose
cumulative `content.length` stays within budget; an over-budget entry is **omitted
whole (never truncated)**; **≥1 entry is always kept**.

**One budget model (ADR 0148 A4):** `listMemoryEntries` calls the SAME
`budgetByChars` primitive that A4's `agentKnowledgeComposition` already uses —
there is one budget implementation, not two. A4 stays the KB+memory retrieval
caller; this is the memory-read caller.

**Ranking:** recency-only. This host does NOT advertise `memory.search`
`modes:["semantic"]`, so per RFC 0113 §2 it does not offer `rank:"relevance"`;
`?rank=recency` is honored and any other value falls back to recency (graceful).

**SR-1 + CTI-1 by construction:** the stored rows are SR-1-redacted at write time
and tenant-scoped (read from `req.tenantId`, never the query). Budgeting only
NARROWS the set, so neither invariant is widened.

**Automated witness:** `backend/typescript/test/rfc0113-memory-budget.test.ts`
(6 cases) + `context-economy-memory-budget.test.ts` (A4, unchanged) green.

**Captured transcript** (in-process boot, demo memoryRef):

```
# advert
memory.injectionBudget = {"supported":true,"tokenCounter":"chars"}

# GET /v1/host/openwop-app/memory  (3 entries x 100 chars)
full:               3 entries
?tokenBudget=250 →  2 entries (over-budget 3rd OMITTED whole, sizes 100+100 ≤ 250)
?tokenBudget=10 on a single 500-char entry → 1 entry kept (≥1 invariant; content len 500, NOT truncated)
```

**Re-gate:** against the steward's published 1.40.0 `memory-injection-budget`
scenario on their ping (and confirm the `tokenCounter` enum admits `"chars"`).

---

## RFC 0114 — A2UI surface delta transport

**Status:** implemented on the demo host (Phase 5). The recorded `ui.a2ui-surface`
envelope stays **full** (schema unchanged, replay-safe, validated once); deltas
are **host-side transport only** to `?a2uiDelta=1` subscribers.

**Advertisement** (`capabilities.a2uiSurface`, gated on `OPENWOP_TEST_SEAM_ENABLED`
— the env where the emit-surface seam serves a non-vacuous witness; the app's
production a2ui surfaces are one-shot, so the transport is witnessed via the seam,
not a production surface-update node — honest-advert):

```json
{ "deltaTransport": true }
```

**Mechanism:**
- `host/a2uiSurfaceDelta.ts` — `diffSurface` (reconstructing RFC 6902 add/remove/
  replace; move/copy accepted-not-emitted; no `test`), `applyPatch` (fail-closed:
  throws on bad path / `test` → caller re-materializes full), and
  `projectA2uiDelivery` (per-subscriber full-vs-delta state machine; `surfaceRef` =
  baseline full event id; chains against the last-delivered tree; a `catalogVersion`
  bump forces a fresh full).
- `routes/streams.ts` — `?a2uiDelta=1` delivers `ui.a2ui-surface.delta` frames
  `{ surfaceRef, catalogVersion, patch }` (transport-only, never recorded); default
  subscribers + replay + event-log read always get the full surface.
- `routes/testSeam.ts` §15 — `POST /v1/host/sample/a2ui/emit-surface { runId, surface }`
  validates through the REAL `acceptEnvelope` closed-catalog gate (out-of-catalog /
  contentTrust-drop → **422**, the emit-side fail-closed leg), then appends the full
  surface as a real run event.

**Automated witness:** `backend/typescript/test/rfc0114-a2ui-delta-e2e.test.ts`
(4 cases, end-to-end through the real seam + gate + SSE transport) + 14 unit cases
in `a2ui-surface-delta.test.ts`:
1. advert present when the seam is enabled;
2. **two surfaces emitted → the 2nd arrives as a `ui.a2ui-surface.delta` frame whose
   `applyPatch(full_A, patch)` equals the materialized full surface B** (delta and
   full agree; `surfaceRef` = A's event id);
3. a non-negotiating subscriber gets BOTH surfaces full, never a delta;
4. **fail-closed: an out-of-catalog surface (`component:"script"`) is rejected 422**
   on the same catalog gate a full receives (no-code-exec boundary holds at emit).

**Reconstruction == full + fail-closed are proven on the real validator**, not a mock
— `acceptEnvelope`'s 422 on the out-of-catalog surface confirms the closed-catalog
check is live. Live-curl on `app.openwop.dev` requires `OPENWOP_TEST_SEAM_ENABLED`
(the steward enables it to drive the 1.42.0 scenario).

---

## RFC 0116 — Prompt-prefix cache

**Status:** implemented on the demo host (Phase 6, final). Provider-scoped to
Anthropic (ADR 0148 A2 ephemeral caching is Anthropic-specific).

**Advertisement** (`capabilities.aiProviders.promptPrefixCache`) — **honestly
key-gated**: present only where a real Anthropic provider is wired
(`ANTHROPIC_API_KEY`) or the witness seam env (`OPENWOP_TEST_SEAM_ENABLED`) is on.
On the MiniMax managed prod neither is set ⇒ **DARK** (advertising Anthropic
prefix-caching on a MiniMax host would be the dishonest claim):

```json
{ "supported": true, "providers": ["anthropic"] }
```

**Cross-tenant isolation** (`prompt-prefix-cache-cross-tenant-isolation`): the
cached Anthropic prefix is namespaced by `(tenant, cachePrefixId)` in
`cacheableAnthropicSystem` (`providers/promptCaching.ts`). Tenant B's use of
tenant A's `cachePrefixId` assembles **different prefix bytes** → Anthropic's
content-addressed cache **structurally misses** (`cacheReadTokens==0`) — the
strongest form, not host bookkeeping. Threaded as an opaque `cachePrefixScope` on
the dispatch request so the provider layer stays tenant-agnostic.

**Witness via `provider.usage`** (1.43.0 `providerUsage` cost-only fields):
`cacheReadTokens` / `cacheWriteTokens` emitted from the Anthropic
`cache_read_input_tokens`/`cache_creation_input_tokens` split. Cost-only, **NOT
replay-asserted** — a hit-vs-miss difference MUST NOT change `inputTokens`/
`outputTokens` or the recorded envelope. **BYOK:** `cachePrefixId` is derived
only from tenant + the client id, never secret material.

**Provider-gating reality:** the deployed managed provider is MiniMax, so the
witness is the host-sample seam (RFC 0108 precedent — what openwop normates is
witnessed via the real host path, not the provider's physical cache).

**Seam:** `POST /v1/host/sample/aiProviders/prefix-cache-probe { tenant,
cachePrefixId }` (gated `OPENWOP_TEST_SEAM_ENABLED`) — REAL `(tenant,
cachePrefixId)` prefix assembly through a content-addressed cache (the Anthropic
model; only the Anthropic *call* is mocked, prod has no key). The 1.43.0 scenario
drives tenant A twice + tenant B once.

**Automated witness:**
`backend/typescript/test/rfc0116-cache-witness.test.ts` (real assembly +
content-addressed cache) + `rfc0116-prefix-cache-seam.test.ts` (HTTP seam, two
tenants) + `rfc0116-prompt-prefix-cache.test.ts` (cross-tenant namespacing units):
- **A primes → A hits (`cacheReadTokens>0`) → B's first use of A's `cachePrefixId`
  is a structural miss (`cacheReadTokens==0`)** — the cross-tenant MUST;
- **outcome-invariance** — identical `inputTokens`/`outputTokens` hit vs miss;
- a negative control proves the leak WITHOUT the namespacing (load-bearing);
- the advert is `["anthropic"]` and dark without a key/seam.
