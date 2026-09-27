# ADR 0706 — The Challenge Factory runs on the workspace's chosen AI provider (Gemini included); Google has no durable search lane to offer

Status: **implemented** 2026-09-17 — Phase 1, the Phase 2 model leg, and the search-backed end-to-end run (§8 Phase E) all measured live
Authors: Claude (session with David), from David's 2026-09-16 direction
Relates: ADR 0505 (provider pin honesty), ADR 0498 (the `anthropic` default), ADR 0110 (headless AI default), ADR 0494 (multi-vendor search + claim entailment), ADR 0502 (durable search refuses synthetic evidence), ADR 0517 (duplicate BYOK keys), ADR 0458 (chat-first factory; §2.2 corrections merged in #3866 / #3867)

## 1. Context — two keys stand between an adopter and a first catalog

Running the Challenge Factory needs two credentials, and neither can be Google's
today:

1. **The AI provider is pinned.** The factory chain (`kicktodo-challenge-factory`
   1.4.0) declares `provider: "anthropic"` / `model: "claude-sonnet-4-6"` as parameter
   defaults, and the Challenge Author's `openwop:kicktodo.factory.run` tool passes
   neither (`features/kicktodo-creator/agentTools.ts`; its `startWorkflowRun` inputs
   are `candidateId / topic / audience / authorSubject`). Every factory run therefore
   dispatches `claim-extract`, `claim-verify`, `plan-generate` and
   `lesson-batch-build` to Anthropic (each node reads `str(i.provider) || 'anthropic'`,
   `packs/feature.kicktodo.nodes/index.mjs:281,429,764,1188`), and a workspace without
   an Anthropic key dies at `extract-claims` with `byok_required` (ADR 0505
   reproduction). ADR 0505 OQ3: "Zero-BYOK users still cannot run the Challenge
   Factory."
2. **The search key must be Exa, Brave or Tavily.** `host/searchVendors.ts` ships three
   `durable` vendors. Google's only presence is Gemini's *Grounding with Google
   Search*, catalogued `searchSuitability: 'answer-only'` (`providers.json`), which the
   factory's `suitability: 'durable'` search nodes refuse (ADR 0502).

The KickTodo distribution hit both on 2026-09-15; its operator has a Google account
and would rather run both legs on it. This ADR grants the first wish and records why
the second cannot be granted.

## 2. What is already true (verified against `origin/main` on 2026-09-16)

- **Google is a first-class AI provider.** `providers/dispatch.ts` dispatches Gemini;
  `host/modelCapabilityProbe.ts` advertises `structured-output`,
  `discriminator-enum`, `long-context`, `reasoning`, `function-calling`,
  `vision-input` for `google`; `providers.json` recommends `gemini-3.1-flash-lite`
  and records the full-3.x reasoning-budget caveat (`thinkingBudget` is forced to 0
  only for `2.5-` ids).
  > **CORRECTED 2026-09-16 (Phase 2) — this caveat is stale in the catalog note that
  > carries it.** `dispatchGoogle` now forces `thinkingBudget: 0` for EVERY
  > `gemini-3[.-]` id, not only `2.5-`, so the empty-completion risk the caveat
  > describes is closed for 3.x. Measured below: zero empty completions on both
  > Flash-Lite and the full-thinking `gemini-3-flash-preview`. Phase 2 found the
  > OPPOSITE defect instead — one 3.x model rejects that parameter outright (§8).
- **The pin is deliberate and must stay frozen.** ADR 0505: `provider+model` hash
  into the Layer-2 invocation cache key and LLM nodes re-execute on replay, so
  resolving at dispatch would silently swap models on replay/fork (DEBT-3 won't-fix).
- **A run input is a frozen value, and it reaches the nodes.** The factory is
  registered via `registerLegacyDefsChainBacked` (`features/index.ts`), which expands
  the chain and restores its parameter names; `seedRunVariables`
  (`host/runStarter.ts:139`) lets `inputs.<name>` override `variables[].defaultValue`
  by name. So a run input `provider` reaches each node's `{{params.provider}}`, is
  recorded on the run, and replays verbatim. This is the case the chain parameters
  exist for; nothing fills them today.
- **The workspace already has a "my AI" binding.** ADR 0110's headless AI default is a
  per-tenant `{ provider, model, credentialRef }` over one of the tenant's own BYOK
  secrets, read by `getHeadlessAiDefault` (`host/headlessAi.ts:70`). Note the
  neighbour `resolveHeadlessAi` (`:152`) is the LIVE resolver and must never run inside
  a recorded run; this ADR reads the stored binding only.
- > **CORRECTED 2026-09-16 (Phase 1 implementation) — two premises above were
  > half-true, and the correction is what Phase 1 actually had to build.**
  > (a) "a run input `provider` reaches each node's `{{params.provider}}`" was
  > true for ONE of the four nodes: only `generate` (plan-generate) declared the
  > token; `extract-claims` and `verify-claims` declared NO inputs, and the
  > lesson-batch child chain had no provider parameters at all — so three of four
  > dispatched on the node's own `'anthropic'` fallback whatever the run said.
  > Chain 1.5.0 wires all four plus the child (§3.1 item 2, corrected).
  > (b) "the dispatcher picks a key from `scope.secrets`" is true, but
  > `scope.secrets` is NOT the vault: `executor.ts prepareRunSecrets` gives a run
  > ONLY the refs listed in `node.config.credentialRefs` or
  > `run.configurable.credentialRefs`. The factory's run tool registered none, so
  > every factory run since 2026-07-29 dispatched with an EMPTY secret set — the
  > incident's `Available refs: (none)` was this, not a keyless tenant, and the
  > `anthropic` pin failed even for a tenant that HAD an Anthropic key. A ref
  > passed only as an input never reaches dispatch (the agent-mention lane hit the
  > same wall first — ADR 0089, `routes/interrupts.ts`). Hence §3.1 item 1's
  > second half and item 8 below. Both corrections are pinned by the chain-backed
  > e2e (`chain-backed-flagship-e2e.test.ts`), which now asserts every LLM node's
  > `ctx.inputs` AND its `callAI` request through the real executor.

- **Without a ref, the dispatcher picks a key heuristically.** `resolveCredential`
  (`aiProviders/aiProvidersHost.ts`) honours an explicit `credentialRef`; with none it
  takes `secrets[provider]`, else the FIRST ref prefixed `provider-` / `provider:`. A
  tenant with two Google keys gets whichever sorts first, not the one the default
  names (ADR 0517's duplicate-keys case is the live example). The sims already pass an
  explicit ref (`credentialRef: managed:openwop-free` in the chain) and it is honoured.

## 3. Decision

### 3.1 The factory runs on the workspace's chosen provider; Gemini works as asked

1. **Ignition carries provider, model AND credential ref.** The run tool resolves, in
   order: an explicit creator choice carried in the tool call, else the workspace's
   ADR 0110 binding (`getHeadlessAiDefault`), else nothing (the chain's pinned defaults
   apply, exactly as today). It passes **three** run inputs: `provider`, `model`,
   `credentialRef`. A ref is a name, never a value, so it is safe on the run record and
   replays verbatim. **And the ref is REGISTERED on the run** —
   `configurable: { credentialRefs: [ref] }` via the ONE recipe
   `host/runCredentials.ts byokRunConfigurable` (the agent-mention lane's copy now
   delegates to it) — so `prepareRunSecrets` resolves it into the run's secret set,
   fail-closed `credential_unavailable` at run start. `:fork` copies
   `sourceRun.configurable` (`routes/runs.ts`), so the registration replays too.
   The ref it registers is the one the pre-flight PICKED (explicit, or the
   ladder's exact/prefix pick), so the run cannot re-pick a different key at
   dispatch; when no binding exists the chain's pinned provider/model are read
   from the registered definition's `variables[]` (never restated in the tool)
   and pre-flighted the same way.
2. **The chain and nodes accept the ref.** New chain parameter `credentialRef`
   (optional, no default) mapped into the four LLM nodes and into the lesson-batch
   child; each node forwards it to `ctx.callAI`'s `credentialRef`, which the request
   type already carries (`executor/types.ts:71`), so this is a pass-through with no
   executor work. Absent ⇒ today's behaviour. **Declare the parameter as a plain
   string and never mark it `x-openwop-sensitive`:** that hint means the parameter's
   VALUE is a secret, so the loader would materialise it as a `source:"secret"`
   variable resolved from the secret store and fail closed on it in a frozen position
   (`workflowChainPackLoader.ts:993`). This parameter carries the ref NAME, not a
   secret. One chain + nodes version bump (1.5.0 / 1.30.0), with the steward
   manifest and the pack-surface parity fixture regenerated in the same PR.
3. **One resolution ladder, owned beside its data.** The ladder (creator choice →
   `getHeadlessAiDefault` → none) lives in `host/headlessAi.ts` as an exported pure
   read, not inline in `agentTools.ts`, so the next headless igniter reuses it.
4. **One credential predicate, shared by pre-flight and dispatch.** The ref-then-
   exact-then-prefix ladder is extracted from `resolveCredential` into one exported
   helper that both the dispatcher and the tool's pre-flight call. The pre-flight runs
   outside a run and has no `AdapterScope`, so the helper is pure over
   `(provider, credentialRef, availableRefs: string[]) → ref | null`: `resolveCredential`
   calls it with `Object.keys(scope.secrets)`, the tool with `listSecretRefs(tenantId)`. The tool refuses
   before creating a candidate when that helper finds no credential for the resolved
   provider, with the same "nothing was created" copy it uses for search. Two copies of
   that ladder would drift, and the tool would refuse runs that work or admit runs that
   die.
5. **Capability check at ignition, against the resolved provider.** The RFC 0031 gate
   is host-scoped (ADR 0505 correction), so the tool checks
   `PROVIDER_CAPABILITIES[provider]` for `structured-output` (every evidence node
   dispatches with a `responseSchema`) and refuses typed if absent. Gemini passes;
   `openwop-free` does not, which keeps ADR 0505 OQ3 honest rather than silently
   downgrading.
6. **The sims stay on `managed:openwop-free`.** Small typed verdicts, never persisted;
   ADR 0505's deferred cost decision is not reopened.
7. **Explicitly not done:** no dispatch-time fallback (DEBT-3 stands), no change to the
   chain's pinned defaults (a gallery-instantiated chain with no caller still needs a
   frozen value), no per-node capability declarations the host-scoped gate would render
   decorative.
8. **A sub-workflow child inherits its parent's registered refs (added in Phase 1).**
   `subWorkflowDispatcher` used to mint every child run with `configurable: {}`, so
   the lesson-batch child started with an EMPTY secret set and could only ever die
   `byok_required` — the parent's binding never reached it. All three
   `dispatchSubWorkflow` call sites (the `core.subWorkflow` node and the two
   `core.dispatch` fan-out paths) now pass the parent's `configurable.credentialRefs`
   (from the node ctx) and the child run is minted with the same list: same tenant,
   same run tree, only refs the parent already carried (never widened), recorded on
   the child run record. This is a host decision, not a wire change: RFC 0022 §B
   defines `inputMapping` and says nothing about `configurable`; `node-packs.md`
   §D (`principalScope`) already has the child inherit the parent's tenant
   principal and may only NARROW it. Secrets are tenant-scoped, so the child could
   have listed the same refs itself — inheritance changes which key it uses, not
   whose. Pinned by the e2e (`childRun.configurable` equals the parent's).
   **Behaviour change for every workflow, stated plainly:** a child of a parent that
   registered refs now fails closed at start (`credential_unavailable`) if one of
   those refs was deleted mid-run; before, it started with no secrets and failed at
   its first BYOK dispatch. Same outcome, earlier and typed.
9. **What the pre-flight refuses (added after the second review).** Each refusal is
   typed, creator-facing and creates nothing: a `managed:*` ref
   (`ai_provider_unsupported` / `managed_tier_no_structured_output` — the managed
   tier refuses `responseSchema`); a ref that is not the provider's own
   (`ai_credential_missing` / `ref_not_for_provider` — the provider's name, a
   `provider-*` / `provider:*` ref, or the workspace default's bound ref); a ref
   that is listed but cannot be decrypted (`ref_unresolvable`, the check
   `setHeadlessAiDefault` already makes); and `model` or `credentialRef` without
   `provider` (`validation_error`, never silently dropped). A creator who names the
   workspace default's own provider keeps the default's bound key and model.

### 3.2 Google offers no durable search lane; the Google-account path is Gemini + a non-Google durable vendor

An earlier draft of this ADR proposed a `google-cse` `SearchVendor` over the
Programmable Search Engine's Custom Search JSON API. **Struck**, on two independent
grounds, each sufficient:

- **The API is closed.** developers.google.com/custom-search/v1/overview, read
  2026-09-16: "The Custom Search JSON API is closed to new customers." and "Existing
  Custom Search JSON API customers have until January 1, 2027 to transition to an
  alternative solution." An adopter cannot obtain access, and an existing customer's
  lane ends in 3.5 months.
- **Its terms fail `durable` anyway.** Programmable Search Engine terms
  (support.google.com/programmable-search/answer/1714300, read 2026-09-16) forbid
  storing or caching Results "in any non-transitory manner", framing, caching or
  modifying Results, and displaying Results to third parties other than End Users, and
  require a Google attribution graphic. Google APIs Terms §5.e forbid permanent copies
  of content. A dossier `sourceHash(url, title)` that a separate reviewer approves
  against is a non-transitory stored Result shown to a third party: `answer-only` at
  best, the same tier as Gemini grounding.

Google's suggested replacement, Vertex AI Search, is scoped to at most 50 domains, not
the open web, and would need its own terms review; it is out of scope here.

So the recorded answer for a Google-account adopter is: **Gemini for every model call
(§3.1), plus one non-Google durable vendor for citations** — Exa's free tier
(~20,000 requests/month) is the cheapest on-ramp. The run tool's not-configured copy
already names Exa first. Gemini grounding stays `answer-only`, unchanged.

## 4. Consequences

- An adopter with a Google account runs every model call on Gemini, with the exact key
  their workspace default names, plus one free Exa key. The Anthropic pin becomes a
  default, not a requirement.
- Replay/fork semantics are unchanged: provider, model and ref are recorded run inputs.
- One more factory pack bump (chain 1.5.0, nodes 1.30.0); no recorded factory run exists anywhere, so it strands nothing.
- `resolveCredential` gains one exported helper; its behaviour does not change.

## 5. Phases

| Phase | Contents | Gate |
|---|---|---|
| **1** | Extract the credential ladder helper (dispatcher + pre-flight share it); the headless ladder in `host/headlessAi.ts`; run tool passes `provider`/`model`/`credentialRef` as run inputs with credential + `structured-output` pre-flight; chain 1.5.0 + nodes 1.30.0 forward `credentialRef`. Route-level tests: a Gemini default resolves and is stamped on the run; **the node's dispatch event records provider `google` and the bound ref** (not only the input); two Google keys dispatch with the bound one; missing key refuses before a candidate exists; a provider without `structured-output` refuses typed. | ADR accepted — **DONE 2026-09-16** (§8) |
| **2** | Live verification on Gemini: one real factory run end to end with an Exa key, the reasoning-budget caveat measured on `plan-generate`, cost per run recorded (ADR 0502 OQ4's unmeasured numbers). | Phase 1 — **model leg DONE 2026-09-16** (§8); search leg needs a durable-search key |

## 6. Open questions

- **OQ1 (closed 2026-09-16)** Could Google back durable citations via Custom Search?
  No — closed to new customers and `answer-only` by terms (§3.2).
- **OQ2** Should the Challenge Author offer the provider choice, or only honour it when
  raised? Decided with the steward: honour when raised, never prompt. The workspace
  default is the sane path, and a question about model vendors is not creator language.
- **OQ3** Whether the sims should follow the workspace provider when it is BYOK. Deferred
  to ADR 0505's cost decision.
- **OQ4** Vertex AI Search for domain-scoped research (≤50 domains) — a separate terms
  review if a curated-source factory mode is ever wanted.
- **OQ6 (found in review)** A creator-named `model` is not checked against the
  provider catalog, so a typo fails at the first node after the candidate exists.
  Not refused at ignition because the catalog lags new model releases and a hard
  refusal would block a correct, newer id. Revisit if it bites.
- **OQ5 (found in Phase 1)** The `/` picker lane. A factory run started directly via
  `POST /v1/runs` (the picker / builder "Run", not the Challenge Author's tool)
  gets none of this: no pre-flight, and the SPA run form sets no
  `configurable.credentialRefs`, so it still dispatches with an empty secret set
  and dies `byok_required` at `extract-claims`. The deferred `credentialRef`
  variable now RENDERS in `ui/RunInputsForm`, but typing a ref there registers
  nothing. The chat-first tool is the factory's designed entry (ADR 0458); the
  picker fix is the same recipe applied at run-create for any workflow whose
  variables name a credential ref — a separate, general decision, not taken here.
  > **Decided 2026-09-16 — ADR 0712.** The wire already names this:
  > `configurable.ai.credentialRef` (v1 `run-options.md:110`, v2 `runs.md:60`), which
  > the host accepted and ignored. ADR 0712 Phase 1 honours it (create/fork check +
  > registration + a run rung in the ladder); its Phase 2 is the SPA run-form picker.

## 7. Review record

- 2026-09-16, steward architect pass (crosstalk `0704`, `openwop-app-1`): accept §3.1
  with two changes — (A, HIGH) pass `credentialRef` as a third run input so the run uses
  the key the default names, not the first prefixed ref; (B, MEDIUM) one shared
  credential predicate and the ladder beside `getHeadlessAiDefault`, plus a Phase-1 gate
  that asserts the dispatch event's provider. Strike §3.2: Custom Search closed to new
  customers (2027-01-01 end) and its terms fail `durable`. Both folded in above; the two
  Custom Search quotes and the `resolveCredential` fallback were re-verified by the
  proposer the same day.
- 2026-09-16 14:14Z, steward second pass on `d828be0b3`: **accepted**, nothing else
  blocks. Three Phase-1 notes folded into §3.1 items 2 and 4: `ctx.callAI` already
  carries `credentialRef`; the chain parameter must not be marked
  `x-openwop-sensitive`; the shared credential predicate is pure over available refs so
  the out-of-run pre-flight can call it. The two code claims were re-verified by the
  proposer the same day.
- 2026-09-16 14:12Z, steward measurement on the production DB: **zero** Challenge
  Factory runs exist on app.openwop.dev at any version (runs, events, invocation log
  and tenant workflows all 0; run retention reaches 2026-05-23). The factory has
  never run on kicktodo.com either. So the chain 1.5.0 / nodes 1.30.0 bump in §3.1
  strands no recorded run and needs no replay note. (#3867 had already merged 1.4.0,
  so the `credentialRef` parameter cannot ride that bump as first suggested; it is its
  own bump, at no replay cost.)

## 8. Implementation record

**Phase 1 — 2026-09-16**, branch `feat/adr0706-factory-provider-choice` (this PR).

| Piece | Where | Pinned by |
|---|---|---|
| The ONE credential ladder | `aiProviders/credentialRefLadder.ts` (`pickCredentialRef`, `isManagedRef`); `resolveCredential` now calls it over `Object.keys(scope.secrets)` | `credential-ref-ladder.test.ts` (explicit / exact / prefix-first / absent-explicit is distinct) |
| The ignition binding | `host/headlessAi.ts resolveIgnitionAiBinding` — creator choice → `getHeadlessAiDefault` → null; a creator's missing model is filled from the catalog | `kicktodo-challenge-author-tools.test.ts` |
| The run-registration recipe | `host/runCredentials.ts byokRunConfigurable`; `agentMentionConfigurable` delegates | e2e + tools tests |
| The run tool | `features/kicktodo-creator/agentTools.ts resolveFactoryAi` — binding → `structured-output` → ladder over `listSecretRefs`; refusals `ai_provider_unsupported` / `ai_credential_missing` (reason `no_default_credential` | `explicit_ref_unresolved`) / `ai_provider_unresolved`, all "nothing was created"; passes the three inputs + `configurable`; tool schema gains optional `provider`/`model`/`credentialRef` with "only when the creator named one" wording (OQ2) | tools tests: Gemini default stamped with the BOUND ref (two Google keys); creator-named provider pins the ladder's pick; chain pin read from the definition; missing key / absent explicit ref / unsupported provider each refuse with no candidate and no dispatch |
| Child inheritance | `executor/subWorkflowDispatcher.ts parentCredentialRefs`; `bootstrap/nodes.ts inheritedCredentialRefs` at all three `core.subWorkflow` sites | e2e: `childRun.configurable` equals the parent's |
| Chain 1.5.0 / lesson-batch 1.2.0 | `examples/workflow-chain-packs/kicktodo-challenge-factory/pack.json` — `credentialRef` param (plain string, not sensitive); provider/model/credentialRef into `extract-claims`, `verify-claims`, `generate`, `build-0..3` inputMapping, and the child's params + node | e2e: all four nodes' `ctx.inputs` and `callAI` requests carry the binding |
| Nodes 1.30.0 | `packs/feature.kicktodo.nodes/index.mjs` — the four `ctx.callAI` sites forward `credentialRef`; manifest descriptions updated; steward manifest + pack-surface parity fixture regenerated (line shifts only) | sabotage-verified: removing one forward reds the e2e |
| Review fixes (second pass, kicktodo-1) | `resolveFactoryAi` refusals of §3.1 item 9; `resolveIgnitionAiBinding` inherits the default's ref for its own provider; `inheritedCredentialRefs` moved below the imports | tools tests (+5 cases); `credential-ref-dispatch.test.ts` drives the REAL adapter with two Google keys and asserts the second key leaves the process and `credentialRefHashed` is `sha256('google:two')` — the Phase-1 gate as §5 words it. Five more sabotages, five reds. |
| Operator copy | `FEATURES.md` row. **Corrected 2026-09-16:** the AI-default card copy change in `byok/i18n/{en,es,fr,pt-BR}.ts` was **withdrawn** — it lengthened the card on the Access → Keys page and reddened the `appearance` route snapshots (merge gate). The web-search card on that page already names the Challenge Factory; the run tool's `ai_provider_unresolved` refusal tells the creator what to configure. | frontend build gate + route snapshots |

Every new guard was sabotaged once and went red on its own assertion (four sabotages,
four distinct reds) before the PR was opened. Architect pass on the diff (Track A +
the RFC 0022 question): no second owner (the ladder was lifted from its only owner;
agent-mention's duplicate recipe removed); replay/fork unchanged (inputs + configurable
are on the run record and `:fork` copies both); child inheritance is a host decision
within the tenant, no wire change; one TOCTOU (a key deleted between pre-flight and
run start) fails closed at `prepareRunSecrets` after the candidate exists — accepted.

**Phase 2 — the model leg, live on Gemini, 2026-09-16.**
`backend/typescript/scripts/adr0706-phase2-gemini-live.ts` drives the factory's REAL
pack node functions through the REAL AI adapter (`createAiProvidersAdapter`, what the
executor wires as `ctx.callAI`) on a real Google key, with the bound ref passed
explicitly. Search and fetch are canned (one practical watercolor page), because the
durable-search leg needs a key this machine does not have. Token counts come from the
adapter's own `provider.usage` events; cost from `providers.json` list prices.

| Model | Nodes | Calls | Tokens in / out | Empty completions | Model-leg cost |
|---|---|---|---|---|---|
| `gemini-3.1-flash-lite` (recommended) | all 4 LLM nodes succeeded: 7 claims extracted, 7 verified, 7-day plan, lesson batch built | 20 | 15,769 / 4,539 | **0** | **$0.0108** |
| `gemini-3-flash-preview` (full thinking model) | claim-extract and **plan-generate succeeded** (7-day plan, 1,486 + 1,046 output tokens); claim-verify and lesson-batch hit the key's rate limit | 16 | — | **0** | not comparable (partial) |

What this settles:
- **Structured output works on Gemini for every factory node**, against each node's
  closed-world validator. `claim-extract` and `plan-generate` each used their one
  bounded, error-fed repair on Flash-Lite and then passed.
- **The reasoning-budget caveat does not bite** on either model (§2 correction):
  `plan-generate`, the largest structured output, returned 1,000–1,500 output tokens
  with no empty completion under the default 4,096-token cap.
- **Cost:** about one cent for the model leg of a run at this size on the
  recommended model. A full 7-day run adds five more lesson calls (roughly 150 output
  tokens each), so the model leg stays near $0.014. The search leg is Exa's price.
- **A provider defect it surfaced:** `gemini-3.5-flash-lite`, a catalog model,
  rejects `thinkingBudget: 0` with 400 INVALID_ARGUMENT, so every call to it failed,
  for every feature. No single thinking parameter works across the 3.x family
  (3.7/3.8-flash reject the alternative). Fixed separately in #3894: retry once without
  `thinkingConfig` on exactly that rejection; live-verified on the model.

  > **CORRECTED 2026-09-17 — "retry once without `thinkingConfig`" describes the first
  > draft of #3894, not what merged.** The merged dispatcher walks a LADDER on exactly
  > `400 INVALID_ARGUMENT`: `thinkingBudget: 0` → `thinkingLevel: "minimal"` → no
  > `thinkingConfig`, and memoises the rung that worked per `(model, thinking on/off)`.
  > Dropping `thinkingConfig` outright was withdrawn in review because it silently
  > re-enables full thinking on models that would then burn the output cap.
  > **MEASURED live 2026-09-17** (main `dispatchChat`, `GOOGLE_API_KEY`, two identical
  > calls): call 1 sent `{"thinkingBudget":0}` → `400 INVALID_ARGUMENT`, then
  > `{"thinkingLevel":"minimal"}` → `200`, completion `"ready"`, finish `STOP`,
  > 8 in / 1 out tokens; call 2 went straight to `{"thinkingLevel":"minimal"}` → `200`
  > (the memo held — one wasted round trip per process, not per call).
- **Transient provider errors are real at this call volume.** One Flash-Lite run lost
  `claim-verify` to a Google 5xx after the adapter's three attempts, and the preview
  model hit per-minute limits. The factory already fails these typed at the node; no
  change here.

> **CLOSED 2026-09-17 — see Phase E below.** This paragraph recorded the last open item:
> "one end-to-end factory run … with a durable-search key (Exa) … what is unmeasured is
> the search leg's cost and a live run's wall time."

**Phase E — the research spine AND the model leg, both live, 2026-09-17.**
`backend/typescript/scripts/adr0706-phaseE-search-live.ts` runs the chain's own spine in
its own wiring (`research-frame → core.web.search (durable) → source-normalize` and
`search → core.web.fetch (6 pages, readable)`, then `claim-extract → claim-verify →
evidence-graph → plan-generate → plan-validate → checkpoint-plan → lesson-batch-build`).
`core.web.search` / `core.web.fetch` are the REGISTERED node modules on the REAL
`host.webResearch` surface, so the durable gate, the vendor inference from the key's
shape, the SSRF-guarded fetch and readable extraction are production code; the model
nodes go through the real AI adapter as in Phase 2. The two human gates are skipped (they
wait on a person). It is still NOT the deployed executor — it is the same node code the
executor runs, driven in chain order.

| Leg | Measured (`gemini-3.1-flash-lite`, topic "Watercolor painting basics") |
|---|---|
| Search | engine **`exa`** (inferred from the UUID-shaped key, no engine env set); **1 request, 8 results**, 1.06 s |
| Fetch | 6 pages requested: **5 ok, 1 failed** (reported as a failed page, not dropped); 133,610 characters extracted; 3.2 s |
| Model | **28 calls**, 45,182 in / 2,758 out tokens, **0 empty completions**; 8 claims extracted, **8 verified**; 3-day plan passed `plan-validate`; lesson batch 0 built |
| Wall time | **107 s** end to end — `claim-verify` 60 s of it (one call per claim, paced at 4 s between nodes for the key's RPM), `plan-generate` 11.6 s |
| Cost | model leg **$0.0154** (`providers.json` list prices); search leg **$0.007** (1 request × Exa's $7 / 1,000 searches, exa.ai/pricing read 2026-09-17 — a list price, not an invoice). **≈ $0.022 per factory run** before media |

What this settles:
- **A Google-account adopter's full factory run works**: Gemini for every model call plus
  one durable search vendor — the §3.2 answer, now measured rather than argued.
- **The search leg is ~30% of the run's cost at one query per run**, and the chain issues
  exactly one search; a wider research frame would scale that leg linearly.
- **Real pages are ~9× the Phase 2 canned text** (133k characters vs one page), and the
  model leg absorbed it: input tokens rose 15,769 → 45,182, cost 1.1¢ → 1.5¢, still zero
  empty completions.

> **CORRECTED 2026-09-17 — Exa's free tier.** §3.2 says "Exa's free tier (~20,000
> requests/month)", copied from `host/searchVendors.ts`'s `freeTier` note. exa.ai/pricing,
> read 2026-09-17: new accounts get **$20 in credits (about 2,800 searches)** and the free
> tier adds **$10 per month**. §3.2's sentence stays as written history. The code note
> (`searchVendors.ts` `freeTier`) is corrected in this change. **The Keys-page web-search
> card still says "about 20,000 searches a month" in all four locales — deliberately
> NOT changed here, and why is its own open item (OQ7):** the gate's
> `route-snapshots` `appearance` spec went red on a shorter corrected sentence, and the
> red was not only the copy. MEASURED 2026-09-17: with the corrected `byok/i18n/en.ts`
> string the **Billing** entry is ABSENT from the admin sidebar (5/5 runs), with main's
> string it is PRESENT (3/3 pass) — same backend binary, same tree otherwise; not the
> 1,500 ms settle (a 6 s settle gives the identical 5,488-pixel diff) and not a dirty
> tree. A copy string cannot legitimately hide a nav entry, so this is a real defect in
> the nav/entitlement path to find before the copy changes.

- **OQ7** Correct the Keys-page Exa free-tier sentence (4 locales) — blocked on explaining
  why changing `byok.webSearch.body` removes the `billing` nav entry in the
  `route-snapshots` appearance render (see the Phase E correction above).

  > **CLOSED 2026-09-17 — and its premise was FALSE.** The copy never hid Billing. MEASURED
  > on untouched main `a3e67b84f` with main's own copy: the admin rail has no Billing entry
  > (a probe mirroring the spec step for step: `Overview · Access & connections · Example
  > data · Users · Knowledge Base` at the capture moment, and still at +4.5 s), and the
  > appearance snapshot differs from its baseline by **1,167 pixels** when the tolerance is
  > set to 0 — just under the spec's `maxDiffPixelRatio: 0.001` (1,228 px on a 1032×1190
  > capture). The baseline dates from #3287 (2026-08-16), when the rail still rendered
  > Billing. Main was already drifting; the tolerance absorbed a whole missing nav row, and
  > the corrected sentence's ~4,300 extra pixels tipped the total over. The "5/5 absent with
  > the new copy, 3/3 pass with main's" comparison recorded above measured the THRESHOLD,
  > not Billing's presence — a pass never meant Billing rendered.
  >
  > Billing's absence is the correct current behaviour: `billing` is `status: 'off'`
  > (`features/billing/feature.ts`), its nav entry carries `featureId: 'billing'`, and
  > `useFeatureVisible` hides an entry whose toggle is not enabled.
  > `OPENWOP_FEATURE_TOGGLES_DEV_OPEN` grants toggle-ADMIN authority (`host/superadmin.ts`),
  > not "every toggle on", so the e2e backend does not turn Billing on. The corrected copy
  > ships with regenerated `route-appearance-{light,dark}` baselines (verified: both
  > re-run green against the new baselines).
- **OQ8** A `maxDiffPixelRatio` of 0.001 on a full-page capture lets an entire nav row
  vanish without a red (1,167 px here). Either tighten the ratio for the rail region or
  assert the rail's entries as text beside the pixel compare — decide in the design-system
  gate owner's ADR, not here.
