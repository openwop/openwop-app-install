# ADR 1117 — Deferred chain copies bind the AI provider and model per run

Status: implemented (2026-11-13, one PR for issue #5897 / ISS-045)

Rides **RFC 0124** (portable per-run parameter deferral, already advertised here as
`workflowChainPacks.deferredParameters.supported`). The persisted shape this ADR emits
is the one RFC 0124 §"Rewrite targets" row 3 already specifies, so no new wire and no
new RFC.

## Context
A deferred chain copy (`POST /workflows/from-chain {deferred:true}`, `expandChain`)
declares a run variable for every chain parameter and lists it as a run input. The
host deferred only prompt bodies (lifted into PromptTemplates) and whole-value
`node.inputs` tokens (variable-sourced PortValues). Every other `config` token was
frozen at copy time, including `config.provider` / `config.model`, which the AI
nodes read from `ctx.config` only.

So the Run dialog offered `model`, said the choice was recorded on the run, and the
run used the copy-time value. Live: casavoga run `a7ee7b9a` asked for
`claude-haiku-5-5` and `provider.usage` reported `claude-sonnet-5-5`.

The loader comment called freezing a whole-value config token "the spec-sanctioned
fallback". RFC 0124's table permits a freeze only for an EMBEDDED token in a non-prompt
string (row 4); a whole-value config token binds to a variable-sourced PortValue (row 3).

## Decision
1. **D1, loader.** In deferred mode a whole-value `{{params.x}}` under
   `DEFERRABLE_CONFIG_KEYS = {provider, model}` becomes
   `{type:'variable', variableName}` (`host/workflowChainPackLoader.ts`
   `deferredConfig`). A sensitive param is unchanged (still refused before expansion).
2. **D2, executor.** One resolver, `resolveNodeConfig` in
   `executor/nodeCtxInputs.ts` beside `resolveDeclaredInputs`, resolves a top-level
   config value of exactly that shape from the run's variable bag, drops the key when
   the bag has no value (so the ADR 0903 run default fills `provider`/`model`), then
   interpolates the legacy `{{inputs.X}}` tokens as before. The executor computes it
   once per node and uses that value for `ctx.config`, the RFC 0031 model-capability
   gate (`activeProvider`/`activeModel`) and `applyServed`.
3. **D3, Run dialog.** `getWorkflowRunInputs` offers a deferred-materialized variable
   (a value of `metadata.deferredParameterAliases`) only when the definition names it
   outside `variables[]` and the aliases: a node, an edge or a minted prompt template
   (`runInputsRead`). It fails open when a node holds a `*PromptRef` whose template is
   not in the definition. Computed at read time, so copies that already exist stop
   offering inputs they ignore.
4. **D4, builder inspector.** A config field holding a variable binding renders as
   read-only text ("Set when the run starts (model)") instead of an empty picker whose
   first change would overwrite the binding.

   > **Correction 2026-11-14 (CT-DAC-3 live check):** D4 covered the picker but not the
   > per-field "Fill with AI" button (ADR 0773 D6) beside it, which asks the Architect to
   > write a fixed value and would freeze the copy again. The inspector now withholds it on
   > a run-bound field (`Inspector.tsx`; `inspectorHelpers.ts` `runVariableName`, shared
   > with `ConfigInput`); `Inspector.runBound.test.tsx` witnesses it.

> **Correction 2026-11-14 (DAC-2, DAC-3, found live on prod `10be9c1901`):** D2 let an
> unbound `provider` fall to the ADR 0903 run default, and `withRunAiDefault` then dropped
> a model chosen on its own whenever the default carried a key (the managed tier, or the
> #5764 workspace binding): run `…920f4b0cec88` chose `MiniMax-M3.1-Flash` and ran
> `openwop-free`. The default branch without a key had the opposite flaw, keeping any model
> on the default's provider. Now a model chosen without a provider runs on the provider
> that offers it: the default's when that provider lists it or the catalog does not know
> it, else the single catalog provider that lists it, which never takes the default's key
> (a missing key fails `byok_required` naming that provider). On the managed tier an id the
> catalog does not know still runs on the tier's own model, as before. A model listed by
> several providers is refused (`model_provider_ambiguous`; none is today). The
> `byok_required` text no longer says the provider is fixed at creation (DAC-3). Tests:
> `adr0903-run-ai-default.test.ts` (sabotage-witnessed), `provider-pin-honesty.test.ts`.

## Replay and fork
The bag is seeded once at run creation from the run's inputs (the Run dialog sends
them keyed by the materialized variable) and its `configurable` aliases. `:fork`
re-seeds the child from the source's inherited inputs and `configurable`
(`routes/runs.ts`), so a forked run uses the model its source chose even after the
copy's default changes. It never re-resolves from the current definition. An unset
model falls through to `run.metadata.aiDefault`, which a fork also reads verbatim
(ADR 0903).

## Alternatives
- **All whole-value config keys (full row 3).** Deferred. `orgId` (133 whole-value
  uses in shipped packs), `contactId`, `briefId` and others would become per-run, which
  lets a run caller retarget a node; that needs an authorization review first. Until
  then they stay frozen and D3 stops offering them.
- **Map the param to `configurable.ai` at run creation.** Rejected: a second binding
  path, wrong for a chain with two AI nodes on different parameters, and it gives a
  run-level wire field a node-level meaning.
- **Only D3 (stop offering).** Honest, but takes away a choice users expect and RFC
  0124 provides for.

## Implementation record
| Part | Where | Test |
|---|---|---|
| D1, D2 | `workflowChainPackLoader.ts`, `nodeCtxInputs.ts`, `executor.ts` | `test/issue5897-deferred-ai-config.test.ts` (real `POST /runs` and `:fork`; sabotage-witnessed) |
| D2 gate | `executor.ts` | `test/model-capability-gate-node-scope.test.ts` (call-site pin updated) |
| D3 | `frontend/react/src/workflows/workflowsClient.ts` | `workflows/__tests__/runInputsRead.test.ts` (sabotage-witnessed) |
| D4 | `builder/inspector/ConfigInput.tsx`, builder i18n ×4 | `builder/inspector/__tests__/ConfigInput.runBound.test.tsx` |

## Open
- [ ] Extend D1 to the other whole-value config keys after an authorization review of
  per-run retargeting (`orgId`, `contactId`, …), with an upstream conformance scenario
  for a whole-value config token (RFC 0124 has none; it covers prompt bodies and
  whole-value inputs).
