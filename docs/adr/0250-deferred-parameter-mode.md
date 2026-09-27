# ADR 0249 — Deferred-parameter expansion mode for workflow-chain packs (RFC 0124 host impl)

Status: Accepted (implemented — increment 1)

Depends on: RFC 0124 / WCP4 (`../openwop/RFCS/0124-portable-per-run-parameter-deferral.md`, `Active`); RFC 0013 (workflow-chain packs); ADR 0163 (workflow-pack templates); the Path-A expansion-time reconciliation (PR #1245 — `host/tokenSubstitution.ts`, `expandChain` freeze + `metadata.expandedFrom` + canonical-param `expansionId`).

## Context

RFC 0013 requires `{{params.*}}` substitution at **expansion time** — a persisted
`WorkflowNode.config`/`inputs` has no runtime `{{...}}` interpolation surface, so a
token left in the definition ships verbatim to any other host and breaks
portability. Path A (PR #1245) made this host conformant by **freezing** resolved
param values into the definition. That removed the reusable "fill values per run"
ergonomic ADR 0163 wanted (each param-set = a distinct owned workflow).

RFC 0124 (WCP4, now `Active`) adds an **optional, capability-gated deferred mode**
that recovers per-run overridability **portably**: at drop time the host
materializes chain `parameters` into run-overridable `variables[]` and rewrites
`{{params.x}}` into already-spec'd runtime bindings (a PromptTemplate `{{varName}}`
with `source:"variable"`, or a variable-sourced PortValue) — the persisted def
still contains **zero** `{{params.*}}` tokens. This host is RFC 0124 reference
implementer #1. The security delta this host surfaced during review — a
`x-openwop-sensitive` param frozen by expansion-time substitution is a
**secret-at-rest leak** — landed in RFC 0124 §Security as the deferred-only /
fail-closed MUST.

## Decision

Implement deferred mode in `host/workflowChainPackLoader.ts` `expandChain`, gated on
a new `ExpandOptions.deferred` flag (surfaced by `POST /workflows/from-chain
{deferred: true}`). Path A remains the default and the floor.

**Increment 1 (this ADR):**

1. **Materialize params → `variables[]`.** Each declared param becomes a
   collision-safe `${slug}_${expansionId}_${p}` variable; the author value seeds
   `defaultValue`; `required` mirrors the chain's `parameters.required`.
2. **`configurableSchema` bare-param alias.** `{properties: {<bareParam>: {variable:
   <prefixedVar>}}}` so run-time callers pass the bare name (`productIdea`), not the
   prefixed form (RFC 0124 G1/Q1 — resolves the cross-host override-key hazard R6).
3. **Whole-value input rewrite.** A `node.inputs` entry that is exactly
   `{{params.x}}` → a variable-sourced PortValue `{type:'variable', variableName}`
   (the executor already resolves these from the per-run bag). This is the one
   genuinely-deferred/overridable path in increment 1.
4. **Fallback freeze.** Everything else (all `config`, embedded/nested `inputs`
   tokens) falls back to expansion-time substitution — the spec-sanctioned
   §Rewrite-targets fallback. Reuses the shared `host/tokenSubstitution.ts` rule.
5. **`sensitive` fail-closed gate (§Security).** A `x-openwop-sensitive` param MUST
   NOT be frozen. `assertSensitiveDeferrable` refuses (`sensitive_param_not_deferrable`,
   422) if a sensitive param appears in ANY frozen position — all of `config`, any
   embedded/nested `inputs`, or non-deferred (Path A) mode entirely. A sensitive
   param is only accepted in a whole-value input position (→ PortValue, never
   persisted); its materialized variable is `required` with **no** `defaultValue`
   (SR-1 at-rest) and carries `sensitive: true`, and its value never enters
   `resolvedParams`/`expandedFrom`/the `expansionId` hash.
6. **`metadata.expansionMode`** = `'deferred' | 'expansion-time'` records which path
   produced the definition.

**Honest-off advertisement.** The discovery doc is **not** changed: the absence of
`workflowChainPacks.deferredParameters.supported: true` IS honest-off. Per
truthful-advertisement + `OPENWOP_REQUIRE_BEHAVIOR`, the flag flips on only when the
gated conformance scenario passes non-vacuously and RFC 0124 reaches `Accepted`.

## Increment 2a — the `configurable` override + fork/replay determinism (implemented)

Increment 1's `configurableSchema` bare-param alias was **inert**: run-creation
validated `configurable` against the schema but nothing mapped a `configurable`
override onto the materialized (prefixed) variable, so a deferred workflow was not
actually re-runnable per run. Increment 2a wires it:

1. **`configurableSchema` is a real JSON Schema** keyed by the BARE param name (the
   portable override key) — `{properties: {<bare>: {type}}}` — so the existing
   `POST /v1/runs` run-options validation works. (Increment 1 emitted a
   non-JSON-Schema `{variable: …}` shape; corrected here.)
2. **`metadata.deferredParameterAliases`** = `{<bare>: <prefixedVariable>}` carries
   the mapping explicitly.
3. **`host/variablesRuntime.deferredConfigurableInputs(def, configurable, inputs)`**
   translates a `configurable` overlay (bare keys) onto the prefixed variables and
   is applied at BOTH `POST /v1/runs` and `:fork` seed sites — a `configurable`
   override wins over `inputs`; a fork inherits the source `configurable` (+
   `runOptionsOverlay`) and re-seeds through the same path, so the bound value
   replays byte-identically (RFC 0124 R4 / `replay.md` §Determinism). Non-deferred
   workflows (no alias map) are untouched.

## Increment 2b part 1 — G3 inline-prompt-body lift + compose redaction (implemented)

Ref-based, exactly as RFC 0124 §"Deferred-parameter expansion" pins it (openwop
#821): there is no inline-template-on-a-node construct in v1, so a lifted body must
become a host-resident PromptTemplate + a `*PromptRef`.

1. **Host-mint API** — `host/promptStore.registerMintedTemplate(t)` inserts a
   PromptTemplate into the host layer, idempotent by id (deterministic re-mint =
   no-op).
2. **Lift** — in deferred mode, an inline `config.systemPrompt`/`userPrompt`
   carrying `{{params.x}}` is minted into a template (deterministic id
   `chainmint-<expansionId>-<node>-<kind>`; `text` rewrites each `{{params.x}}` →
   `{{varName}}`; `variables[]` declare `source:"variable"` + `sensitive`), the
   inline body is replaced by `config.<kind>PromptRef = {templateId, version}`, and
   the minted templates ride on `metadata.mintedPromptTemplates` so the definition
   is self-contained (a loader re-registers them). Non-prompt config still freezes.
3. **Sensitive gate relaxed** — a `x-openwop-sensitive` param in a *liftable
   prompt-body* config key now DEFERS (lifts) instead of failing closed; a sensitive
   param in any OTHER config key still fails closed (would freeze → leak).
4. **Compose redaction + fence** — `promptCompose` redacts a `sensitive` variable to
   `[REDACTED:<name>]` in the observability payload (SR-1) while delivering the real
   value to the model, and composes it under the `<UNTRUSTED>` fence +
   `contentTrust:"untrusted"` (R1) — orthogonal, both apply. A minted template
   composes directly via an inline `ComposeRequest.template` (it is not a fixture).

## Increment 2b part 2 — run-path binding + gated leg (implemented)

1. **Run-path binding.** `bootstrap/nodes.ts` — both compose sites (the shared
   `resolveAndComposePromptRef` + the mock-ai `composeRef`) now, for a resolved
   template, compose it INLINE (`ComposeRequest.template` — a minted template is not
   a fixture) and resolve its materialized `source:"variable"` slots from the per-run
   variable bag (`snapshotRunVariables`), marking each `untrusted` (R1 fence; a
   `sensitive` var additionally redacts, SR-1). So a lifted `systemPromptRef` resolves
   end-to-end at run time.
2. **`\w`-safe var names.** Materialized variable names are now underscore-based
   (`slug(chainId).replace(/-/g,'_')`), because they become PromptTemplate
   `{{varName}}` placeholders and the composer's placeholder regex is `\{\{(\w+)\}\}`
   — a hyphen would silently break substitution. Matches the RFC 0124 naming example.
3. **Gated end-to-end leg** (`test/workflow-chain-deferred-runpath.test.ts`): a real
   `executeRun` of a deferred-expanded mock-ai workflow proves materialize → a
   `configurable` override flows into the composed prompt → the deferred var rides
   `<UNTRUSTED>` + `contentTrust:"untrusted"` → the sensitive var redacts to
   `[REDACTED:<name>]` in the observability payload while its real value reaches the
   model. This is the non-vacuous leg the server-free scenario + witness #2 mirror.

**Capability advertisement stays OFF.** `workflowChainPacks.deferredParameters.
supported` is NOT flipped on: per the truthful-advertisement guardrail a capability
is advertised only once its RFC reaches `Accepted`; RFC 0124 is `Active`. The flip
is the final step, gated on RFC 0124 → `Accepted` (this host's gated leg + the
server-free scenario + a second witness).

## Alternatives rejected

- **Relax RFC 0013 to persist app-private `{{inputs.*}}` tokens** (the pre-Path-A
  model). Rejected upstream — reintroduces the portability break. See ADR 0163 /
  0237 correction notes.
- **Emit `variables[]` in Path A too.** Rejected — implies runtime overridability
  Path A doesn't provide; the two modes are kept distinct (`expansionMode`).
- **Host-inferred `sensitive`.** Rejected in favor of the declarative
  `x-openwop-sensitive` manifest hint (portable, author-owned) — RFC 0124 Q1.

## RFC gate

No new RFC needed here — this is host work implementing the **Active** RFC 0124
(reference implementer path to `Accepted`). The wire surface it rides
(`variables[]`, PromptTemplate `{{varName}}`, variable-sourced PortValue,
`configurable`) is all existing v1. The `deferredParameters` capability stays
honest-off until the gated scenario passes.

## Implementation

| Item | Location |
| --- | --- |
| `expandChain` deferred branch + `assertSensitiveDeferrable` gate | `backend/typescript/src/host/workflowChainPackLoader.ts` |
| `variables[].sensitive` type | `backend/typescript/src/executor/types.ts` |
| `POST /workflows/from-chain {deferred}` | `backend/typescript/src/routes/workflows.ts` |
| Tests (6: materialize/alias/whole-value, determinism, sensitive-OK, sensitive-config-fail-closed, non-deferred-fail-closed, Path-A-unchanged) | `backend/typescript/test/workflow-chain-deferred-mode.test.ts` |

## Post-merge architect review + hardening (2026-07-04)

A Track-A senior review over the complete merged surface (all 5 PRs) found two real
defects. Fix A landed with this note; HIGH-1 is routed to the spec (openwop-1).

- **HIGH-2 (fixed here) — minted-template durability across instance/restart.**
  `registerMintedTemplate` populated only the EXPANDING instance's in-memory host
  store; a run on another Cloud Run instance (or after a restart) found no template →
  the lifted `*PromptRef` composed an empty prompt. `metadata.mintedPromptTemplates`
  was stamped but never consumed. **Fix:** `executeRun` now re-registers them at
  run-start via `promptStore.ensureMintedTemplatesRegistered` (idempotent, tolerant),
  so `getTemplate` resolves on any instance. Covered by
  `test/workflow-chain-deferred-durability.test.ts`.

- **HIGH-1 (routed to openwop-1 — spec/design) — sensitive value leaks via the
  run-scoped variable bag.** `variablesRuntime` has no notion of `sensitive`: at run
  time a sensitive param's value (supplied via `configurable`) lands in the bag and is
  (a) returned unredacted in `RunSnapshot.variables` (`GET /v1/runs/{id}`) and
  (b) persisted plaintext at rest by `persistBag` (`kvSet`). SR-1 redaction covers only
  `prompt.composed`. This is NOT a clean local patch — `persistBag` can't redact
  without breaking run-resume (the run needs the real value), and the API projection
  lacks the workflow def. The proper fix is a design decision: route sensitive params
  through the BYOK secret pipeline (`source:secret` / credentialRef) rather than the
  plaintext `source:variable` bag, OR extend the SR-1 MUST to cover `RunSnapshot` +
  at-rest. Deferred mode is honest-OFF, so this is a must-fix-before-`Accepted`, not a
  live leak. Flagged to the RFC 0124 §Security owner.

- **Lower:** minted-template Map accumulation (MED, unbounded per distinct param-set);
  two template-resolution systems bridged via inline `ComposeRequest.template` (MED,
  pre-existing); the run-path `await import()` of `variablesRuntime` is cycle-free so a
  static import would be marginally cleaner (LOW).

## Increment 3 — sensitive → `source:"secret"` (RFC 0124 §Security amendment, implemented)

The post-merge review's HIGH-1 (a `sensitive` param's value leaks at run time via the
plaintext variable bag → `RunSnapshot.variables` + at-rest) was adjudicated with the
spec owner and landed as the RFC 0124 §Security amendment (2026-07-04): a `sensitive`
param materializes as a **`source:"secret"`** PromptVariable (BYOK-resolved,
`[REDACTED:<secretId>]`, never bagged), NOT plaintext `source:"variable"`. Host impl:

1. **Lift → `source:"secret"`** (`liftPromptBody`) — a sensitive param's minted-template
   variable is `source:"secret"`; its per-run binding is a credentialRef resolved from
   the run owner's secret store (`resolveBinding` secret path → redaction). Non-sensitive
   params stay `source:"variable"` (overridable plaintext).
2. **Gate tightened to prompt-body-only** (`assertSensitiveDeferrable`) — a sensitive
   param is deferrable ONLY in a prompt-body position; a whole-value `node.inputs` entry
   (or any non-prompt position) fails closed with `sensitive_param_not_deferrable`, since
   there is no `{type:"secret"}` PortValue in v1 (a future RFC). Node-level secrets keep
   the connection-pack / `credentialRef` channel (RFC 0095).
3. **Per-run supply is a secret reference** — `deferredConfigurableInputs` routes a
   sensitive param's `configurable` value (a credentialRef, a safe reference) into the
   bag; the run-path compose (`bootstrap/nodes.ts`, both sites) now passes
   `secretScope: {tenantId: ctx.tenantId}` so the `source:"secret"` slot resolves via
   BYOK. **Plaintext rejection:** `POST /v1/runs` rejects a `configurable` value for a
   sensitive param that does not resolve as a secret reference (`resolveSecret` → null)
   with `validation_error` (400) — a plaintext would be bagged/snapshotted/persisted, so
   it is fail-closed. (A dedicated HTTP route test for the 400 is a follow-up; the logic
   is symmetric to the runpath test's provisioned-secret positive path.)

Tests updated: sensitive whole-value input now asserts fail-closed; the gated runpath
leg provisions a secret, supplies the credentialRef, and asserts the plaintext secret
appears NOWHERE (composed body or observability) while the credentialRef resolves +
redacts. Backend suite green (4806 tests); tsc + build clean. Closes HIGH-1; last piece
before RFC 0124 → `Accepted`.

## Increment 4 — capability advertisement flipped ON (RFC 0124 `Accepted`)

RFC 0124 graduated `Active → Accepted` in the spec repo (`#827`, 2026-07-05), lifting the
dishonest-wire gate. openwop-app is witness #1. The host now advertises:

```json
"workflowChainPacks": { "supported": true, "deferredParameters": { "supported": true } }
```

**SSOT, not a literal.** The block reads from `workflowChainPacksCapability()` in
`host/workflowChainPackLoader.ts` (co-located with `expandChain`), imported into
`routes/discovery.ts` — advertise/serve can't drift. `deferredParameters.supported` is
gated on the schema precondition (`prompts.supported` + `variable` in
`prompts.variableSources`, read from the single `promptHostConfig` module), so a deployer
who tightens prompts drops the deferred claim automatically.

**The parent-gate blocker + its resolution (RFC 0013 erratum #828).** A pre-flight architect
review caught that advertising the nested `deferredParameters` forces the parent
`workflowChainPacks.supported: true`, which — under `@openwop/openwop-conformance` ≤1.48.0 —
coupled to the RFC 0013 `workflow-chain-host-expansion` scenario. That scenario probes
`POST /v1/host/sample/workflow-chain:expand` for a `vendor.openwop.workflow-chain-sample`
fixture pack that was **never published** (the RFC 0013 §checklist "in-memory host serves the
seam" claim was aspirational). Advertising the parent while pinned there would have gone RED
under `OPENWOP_REQUIRE_BEHAVIOR`. The flip was **held**, routed to the spec owner (crosstalk
`b817` → options A/B/C), who chose **(B)** and landed spec `#828`: the host-expansion scenario
re-gates onto a new OPTIONAL sub-flag `capabilities.workflowChainPacks.hostExpansionSeam`
(a conformance-only test-seam advertisement), decoupled from the semantic `supported` claim.
Published as `@openwop/openwop-conformance@1.51.0` (cumulative — RFC 0126 legs from 1.49,
RFC 0124 deferred legs from 1.50, the #828 re-gate). Pin bumped `^1.46.0 → ^1.51.0`.

**Honest soft-skip posture.** This host serves NEITHER `/v1/host/sample/workflow-chain:expand`
NOR `/v1/host/sample/chain/deferred-expand`, so `hostExpansionSeam` is left absent:
- `workflow-chain-host-expansion` gates on `hostExpansionSeam` (absent) → soft-skip;
- the deferred scenario's capability-gated host legs POST the unwired deferred-expand seam
  and **explicitly soft-skip on the 404** (`if (res.status === 404) return`).

The RFC 0124 deferred behavior is witnessed **server-free** by the always-on
`workflow-chain-deferred-parameters.test.ts` legs (materialization, fail-closed
`sensitive_param_not_deferrable`, credentialRef-string supply shape) plus this host's own
gated runpath vitest (`test/workflow-chain-deferred-runpath.test.ts`, plaintext-never-anywhere).
Wiring the two `/v1/host/sample/*` witness seams to make the live-host legs non-vacuous is an
optional follow-up (would strengthen the published behavioral witness; not required for an
honest advertisement). `credentialRef`-string per-run shape (`routes/runs.ts:259-270`)
confirmed against the pinned wire shape by the spec owner.

## Increment 5 — deferred-expand conformance witness seam (Seam A)

`routes/chainDeferredExpandSeam.ts` serves `POST /v1/host/sample/chain/deferred-expand`
(seam-gated on `OPENWOP_TEST_SEAM_ENABLED`, mirroring `dispatchFanOut.ts`; 404s in prod),
driving the `@openwop/openwop-conformance` `workflow-chain-deferred-parameters` **gated
host legs NON-VACUOUSLY**. Before this they soft-skipped on the 404; now they exercise the
REAL pipeline — `expandChain({deferred})` → materialize into `variables[]` (source:"variable";
source:"secret" for `x-openwop-sensitive`) + minted PromptTemplate → `deferredConfigurableInputs`
bare-param override → frozen-def `:fork` byte-stable replay (R4) → `composePromptTemplate`
(contentTrust:"untrusted" R1; `[REDACTED:<credentialRef>]` SR-1, plaintext never appears).
It reuses the SAME compose function the dispatch node uses — a genuine witness, not a mock.

The two `conformance.deferred*` chains are host-synthesized in-handler (steward decision (i),
crosstalk `f475`: RFC 0124 has one chain-compose witness today, so no cross-host parity to
protect yet; publishing them as fixtures is the upgrade path if a second host appears).
Covered by `test/chain-deferred-expand-seam.test.ts` (asserts the exact contract so the
published legs can't pass vacuously). **No prod redeploy needed** — the seam is test-only
(404s without `OPENWOP_TEST_SEAM_ENABLED`); the deferred behavioral witness is the in-process
`test:conformance` run, distinct from the live-prod-curl discovery witness.

**Seam B** (`/v1/host/sample/workflow-chain:expand`, RFC 0013 host-expansion) remains held on
openwop-1 publishing the `vendor.openwop.workflow-chain-sample` fixture (their carry-forward);
host-expansion stays an honest `hostExpansionSeam` opt-out until then.

## Increment 6 — host-expansion witness seam + 2 RFC 0013 host-conformance fixes (Seam B)

`routes/workflowChainExpandSeam.ts` serves `POST /v1/host/sample/workflow-chain:expand`
(seam-gated on `OPENWOP_TEST_SEAM_ENABLED`, 404s in prod), resolving the published
`vendor.openwop.workflow-chain-sample` fixture (openwop-conformance ≥1.52.0, #830) through
this host's `expandChain()` — so `workflow-chain-host-expansion.test.ts` runs NON-VACUOUSLY,
checking output against the reference expander for the identical pack (via the host's returned
`expansionId`, no hardcode). `workflowChainPacksCapability()` advertises
`hostExpansionSeam:true` co-gated on the seam; the `conformance/run.ts` opt-out is dropped.
Pin bumped `^1.51.0 → ^1.52.0`.

Building it surfaced — and openwop-1 confirmed against the spec (`d95b`/`513a`, spec clause #832) —
**two real host-conformance bugs**, both fixed here:
1. **Node-id rewrite** (`workflowChainPackLoader.ts`) — `slug(chainId)` collapsed dots→hyphens;
   the RFC 0013 reference (`workflow-chain-packs.md §Expansion step 6`) is `chainId.replace(/\./g,'_')`
   (dots→underscores, hyphens preserved). Fixed the expansion-time `prefix` + the deferred
   `varPrefix`. This was minting non-conformant node ids in the shipping `/workflows/from-chain`
   path. Changes the deterministic node-id FORMAT of FUTURE expansions only (persisted defs
   replay from storage, never re-expanded — zero interop/replay impact per openwop-1). The
   chain-execution tests that asserted the old hyphen format were updated to the conformant form.
2. **Over-strict node-id length cap** (`workflowDefinitionValidation.ts`) — `NODE_ID_PATTERN`/
   `EDGE_ID_PATTERN` capped ids at `{1,64}`, but `workflow-definition.schema.json` `WorkflowNode.id`
   has NO `maxLength`. RFC 0013 expansion ids are unbounded by construction (a reverse-DNS chainId
   prefix), so any finite cap is over-strict and would wrongly 422 a conformant peer's long id.
   Relaxed to unbounded (`/^[a-zA-Z0-9_-]+$/`).

The seam maps the host's internal `WorkflowDefinition` (executor shape: `nodeId`, `EdgeDef`,
`metadata.capabilities`) onto the RFC 0013 wire shape (`id`, `from`/`to` endpoint refs, per-node
capabilities). Covered by `test/workflow-chain-expand-seam.test.ts`. Verified: conformance
`workflow-chain` 57/0 (host-expansion 6/6) under REQUIRE_BEHAVIOR against the #830 corpus;
full backend vitest green except a pre-existing unrelated `ucp-reference-merchant` description-
length failure (fails identically on origin/main). No prod redeploy required for the seam;
the two host fixes are behavior corrections that ride the next backend deploy.
