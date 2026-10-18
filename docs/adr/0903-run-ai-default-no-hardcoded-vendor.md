# ADR 0903 — No hard-coded AI vendor: a run default, resolved once, for nodes that name none

Status: Accepted (implemented in this PR; live re-qualification on Gemini pending)

## Context

On 2026-10-17 the first live `/qualify-live` run of Campaign Studio, on the
user's Gemini key (`google:testing`, `gemini-3.8-flash`), failed before any model
call:

> This step needs a anthropic API key and this workspace has none.

The run asked for Google through `configurable.ai`, and the user had no Anthropic
key. Two things combined to send it to Anthropic anyway:

1. **The node packs hard-coded the vendor.** Twelve `packs/feature.*.nodes`
   filled a missing provider with `'anthropic'` and a missing model with a
   pack-local `DEFAULT_MODEL = 'claude-sonnet-4-6'` (ten as
   `str(i.provider) || 'anthropic'`; `podcasts` by guessing `anthropic` for any
   model id it could not place; `kicktodo` through `FACTORY_AI_DEFAULT`). The
   DEBT-3 note justifying the constant said "`ctx.callAI` REQUIRES an explicit
   model and standalone .mjs packs cannot import the catalog".
2. **The Campaign Studio chains never named a provider.** ADR 0498 bound
   `config.provider`/`config.model` to chain params on the ~78 `core.ai` nodes;
   the feature-pack AI nodes these chains use were not part of that sweep. So
   the node's own fallback decided, and the fallback was Anthropic.

`configurable.ai.provider` (the wire field, `runs.md` §configurable) was read by
nothing that chose a vendor. The host used only `configurable.ai.credentialRef`.

The user's decision (2026-10-17): every pack uses the provider and model the
user set; failing that, the system's default. Not a hard-coded vendor. Where the
system default comes from: **the workspace's active AI binding, then the
catalog**. Replay must stay deterministic.

## Decision

**D1 — One resolver in the host, three rungs** (`host/runAiDefault.ts`):

1. the run's own choice, `configurable.ai.provider` / `.model` (an unknown
   provider id is ignored; a provider with no model takes that provider's
   catalog default);
2. the workspace's active AI binding (ADR 0517, `getChatByokConfig`), when it
   names a selectable BYOK provider. Managed (`managed:*`) and subscription
   bindings are chat-only and are skipped;
3. the catalog's recommended default: the first selectable provider in
   `providers.json` and its `recommended` model.

**D2 — Rungs 2 and 3 are frozen at run creation.** A run-start contributor
(ADR 0099, `runAiDefaultContributor`) stamps `run.metadata.aiDefault =
{provider, model, source}` once. A derived (`:fork`) run contributes nothing and
inherits the source's value, present or absent (ADR 0604). Rung 1 is read from
`run.configurable`, which is fixed when the run is created. So a replay sees the
provider its source ran on, even if the workspace binding or the catalog has
changed since.

**D3 — `ctx.callAI` / `callAIWithTools` fill only the gap**
(`withRunAiDefault`). A call that names a provider keeps it; its missing model is
that provider's catalog default (the run default's model belongs to the run
default's provider only). A call that names neither takes the run default's
provider and model. A run created before this ADR, with no frozen value and no
run choice, behaves as before: a call without a provider is refused.

**D4 — Packs pass what they were given.** All twelve packs now pass
`str(i.provider) || undefined` and `str(i.model) || undefined`; the
`DEFAULT_MODEL` constants are gone. `podcasts` still maps a model id it
recognises (`claude*`, `gpt*`/`o1*`/`o3*`, `gemini*`) to its provider and leaves
an unrecognised one to the host. The two author packs record the model that
actually ran (`ai.model`) in their outputs and provenance. A ratchet test
refuses any `|| '<vendor>'` fallback or pack-local default model in
`packs/*/index.mjs`.

**D5 — The Campaign Studio chains take the user's choice.** The eight
`campaign-studio.*` chains declare optional `provider` and `model` params, frozen
into every AI node's inputs at instantiation (RFC 0013 Path A, the ADR 0498
binding). The params have **no default**: a default would freeze `anthropic` into
the boot-registered channel chains the orchestration dispatches as children, and
those could then never follow a run's choice. Unset, the key is absent and D3
applies. The orchestration hands the same values to each of its five channel
children as RFC 0126 per-item inputs (`nextWorkerInputs`).

**D6 — A child run inherits the parent's run choice.** `dispatchSubWorkflow`
copies the parent's `configurable.ai.provider` / `.model` onto the child's
`configurable.ai`, beside the credential refs ADR 0706 already copies.

**D8 — The orchestration gives its channels the brief, and fails when none
succeeds** (found by the live re-run, 2026-10-18; user decision "fix in #4915 +
honest fail"). The live Gemini run of `campaign-studio.campaign-orchestration`
completed as success while all five channel children failed `brief_not_found`
(`Brief not found: `). The dispatch's `inputMapping: {briefId: "briefId"}` reads
the parent run's *variable bag*, but from-chain freezes `briefId` into node
inputs (RFC 0013 Path A) and the parent run's inputs are `{}`, so the children
never received it. This was already true on `main`; it is not caused by D5. Then
`consistency-check` scored 100 with "no drafts to compare", and the run finalized
a campaign with no channel output. Fixed two ways:

1. Each `nextWorkerInputs` entry now also carries `briefId: {{params.briefId}}`
   beside `provider`/`model`, so each child gets the brief as a per-item input.
2. An edge `channel-dispatch.dispatched → consistency.dispatched` hands the
   children's outcomes to `consistency-check`. When the fan-out ran and no child
   completed, the node fails `channels_all_failed`, naming each child's status.
   One completed channel is enough to continue (the join stays `collect`; this
   host advertises only `wait-all`, so `quorum: 1` is not available).

**D9 — A child run gets the host's provider policy.** Re-running orchestration
with D8 (2026-10-18 00:55Z) moved every child past `brief_not_found` to
`capability_missing: host does not expose ctx.callAI`.
`dispatchSubWorkflow` called `executeRun(storage, childRun, def, {})`, and the
executor builds the AI adapter only when given a `policyResolver`. Every other
run path passes `hostSuite.providerPolicyResolver`, so a sub-workflow child was
the one run that could never call a model. Now it gets the same policy. With D8
and D9 (01:00Z) the children got the brief and called Gemini. Two generated and
stopped at their approval gates, and three were `Provider rate-limited`: five
parallel calls on this key's tier.

## D7 — Chain-param defaults removed (follow-up PR, user decision 2026-10-17)

The first PR left the ~73 chain packs whose `provider` param defaulted to
`"anthropic"` (the ADR 0498 sweep). The user then chose to remove those defaults
too, KicktoDo's ADR 0505 / ADR 0706 factory pin included:

- **74 chains in 31 chain packs** keep their `provider` / `model` params (a user
  can still fix a vendor at instantiation) but carry **no default**; their
  descriptions now say what happens when unset. Chain and pack versions are
  bumped (minor).
- **`core.openwop.ai` 1.5.0**: `chat-completion`, `structured-output` and
  `tool-calling` no longer list `provider` / `model` as required config. The
  node passes what it was given and D3 fills the rest. (`embeddings` is
  unchanged: no chain binds it to a provider param.)
- **KicktoDo**: `FACTORY_AI_DEFAULT` is deleted; the parity test now asserts the
  factory chain declares no default and the node pack exports none.
- **Ratchets**: `chain-config-conformance` refuses any chain `provider` /
  `model` default; `provider-pin-honesty` refuses the old "will not fall back"
  copy and requires the new description.

- **Expansion no longer reports an unset AI `provider`/`model` as unfilled**
  (`expandChain`'s `unresolvedParams`). It is absent on purpose and D3 fills it.
  Without this the strategy cadence PUT refused every vendor-free chain ("needs
  `provider`, `model` before it can be scheduled"), found by the pre-merge full
  suite. Other whole-value params are still recorded.
- **The ADR 0504/P3 incident tests now assert at the call.**
  `chain-ai-provider-resolution` and the from-chain route's "incident assertion"
  used to require a frozen `anthropic`. They now require that no AI node carries
  a token, `''` or `"undefined"`, and that what a call dispatches
  (`withRunAiDefault` over the node config) is a concrete provider and model.
  Breaking the fill turns them red.
- `adr0823-launch-ownership-ratchet`: `kicktodo-creator/agentTools.ts` no longer
  reads the Challenge Factory definition (it read the pinned defaults), so its
  allowance shrank to zero.

**Registry.** Prod installs 16 of these chain packs and `core.openwop.ai` from
packs.openwop.dev (`OPENWOP_INSTALL_PACKS`). A merge changes only the vendored
copies; prod changes when the new versions are signed and published and the
pins are bumped. That publish and pin bump are part of this rollout (user
decision 2026-10-17); KicktoDo (downstream white-label) is told when it lands.

## Alternatives considered

- **Patch only the Campaign Studio chains** (D5 alone). That leaves the nodes'
  Anthropic fallback for every other path, and a run's `configurable.ai` choice
  still ignored. Rejected by the user's "all packs" decision.
- **Resolve the default on every call.** Not replay-safe: the workspace binding
  can change between a run and its fork.
- **Freeze at `from-chain` instead of run start.** A definition outlives many
  runs and workspaces' bindings; the run is the unit that must replay.
- **Have each pack read a host-provided default.** Twelve copies of one rule,
  which is how the hard-coded vendor spread in the first place.

## Consequences

- A workspace with only a Gemini (or OpenAI) key can run every feature-pack AI
  node without naming a provider anywhere.
- `provider.usage` and the invocation log record the provider and model actually
  used, as before; the run's `metadata.aiDefault` records which rung chose it.
- The `/refresh-model-catalog` sweep no longer has pack constants to update.

## Implementation

| Part | Where |
| --- | --- |
| D1–D3 resolver, contributor, call fill | `backend/typescript/src/host/runAiDefault.ts`; `aiProviders/aiProvidersHost.ts` (`callAI`, `callAIWithTools`, `AdapterScope.runAiDefault`); `executor/executor.ts`; `index.ts` (wiring) |
| D4 packs | 12 `packs/feature.*.nodes` (minor version bumps, schema `$id`s, `requiredPacks` pins) |
| D5 chains | `examples/workflow-chain-packs/campaign-{brief,channels,orchestration}` → 1.1.0 |
| D9 child policy | `executor/subWorkflowDispatcher.ts` (`executeRun(..., { policyResolver })`) |
| D8 brief + honest fail | `campaign-orchestration` chain (per-child `briefId`, dispatch→consistency edge); `packs/feature.campaign-orchestration.nodes` `consistencyCheck` |
| D6 child inherit | `executor/subWorkflowDispatcher.ts`, `bootstrap/nodes.ts` |
| Tests | `backend/typescript/test/adr0903-run-ai-default.test.ts` (15; ten sabotages each turn it red) |

## Checklist

- [x] Resolver, freeze, call fill, child inheritance, packs, chains, tests
- [x] Re-run `/qualify-live` on Campaign Studio with `google:testing` / `gemini-3.8-flash` on the local stack (2026-10-18 00:27–00:46Z, base 65346ee0f + this PR before D8). 8 passed, 1 failed, 1 no-ai, under $0.03. Every call went to Google; the children inherited `configurable.ai` (D6). `market-intel` fails `missing_input` because the sample brief binds no KB collection (fixture gap, not a product defect). Three chains hit a transient Gemini 5xx on the first pass and passed on retry. Orchestration's pass was false (D8).
- [x] Re-run orchestration live with D8 (00:55Z): honest `channels_all_failed`, which exposed D9. With D9 (01:00Z): children reach Gemini; 2 stop at approval gates, 3 are rate-limited, and production-plan is rate-limited too. Not a clean pass: see the open item below.
- [ ] Open (pre-existing, user decision): `core.dispatch` maps a child that SUSPENDED (`waiting-approval`) to `failed` (`dispatch.joined` failedCount 5 with 2 waiting). Each channel chain has its own approval gate, so the parallel orchestration cannot finish in one pass.
- [ ] Follow-up: an upstream 5xx is reported as `parse-error` / "did not emit valid JSON" (retry reason and node error); it should say the provider failed
- [x] User decision on the ~73 chain-param `anthropic` defaults: remove them (D7)
- [ ] D7 published to packs.openwop.dev and prod `OPENWOP_INSTALL_PACKS` pins bumped; record versions here
