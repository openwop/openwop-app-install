# ADR 1020 — Campaign Studio end to end: a campaign that reaches its channels, gates that decide, drafts that validate

Status: implemented — P1 (#5434), P2 (#5436) and P3 (2026-10-31 – 2026-11-01, row 70)

Date: 2026-10-31 · Features: `campaign-orchestration`, `campaign-brief`, `campaign-channels`,
`campaign-studio` (all extensions; every toggle id unchanged) · Feature loop round 2, row 70 ·
Extends ADR 0156 (campaign brief), ADR 0157 (channel generation), ADR 0158 (orchestration),
ADR 0472 P4 (chain-backed same-id registration), ADR 0942 (campaign autonomy gate) ·
Files a residue to ADR 0964 (dispatch replay safety)

## Context

Row 70's workflows grade (`docs/steward/workflows-assessment/2026-10-31-campaign-studio-row70.md`,
`CS70WF-*`) graded the unit on `origin/main` @ `001d15ce5`. The doctrine holds: every campaign
workflow is a chain pack registered same-id. What a user meets does not hold:

- **`CS70WF-1`: the orchestration never reaches a channel.** The same-id definition is a deferred
  expansion with no params (`host/chainBackedWorkflows.ts:80`). Deferred expansion freezes a
  whole-value `{{params.briefId}}` in node CONFIG to `undefined`
  (`host/workflowChainPackLoader.ts:1561-1576`, `host/tokenSubstitution.ts:52`). The supervisor's
  `mockDispatchPlan[0].nextWorkerInputs[i].briefId` is config, so it is `undefined`, and the
  dispatcher lets a per-item value override the `inputMapping` value with no `undefined` check
  (`executor/subWorkflowDispatcher.ts:282-284`). Witnessed through the real loader
  (`PROBE-CS70-1`). Every child fails `brief_not_found` after the user approved the kernel.
- **`CS70WF-2`: the consistency check cannot fail.** It scores `inputs.drafts`
  (`packs/feature.campaign-orchestration.nodes/index.mjs:52-55`), which nothing wires. Every run
  reports `score:100, passesThreshold:true, note:'no drafts to compare'`.
- **`CS70WF-3`: every channel is generated, enabled or not.** The fan-out list is fixed, and the
  channel `generate` node never reads the brief's enabled channels.
- **`CS70WF-4`: orchestration on, channels off, fails after the approval.** The children are
  feature-gated on `campaign-channels` (`campaign-channels/feature.ts:30`); the dispatcher turns
  the refusal into `subworkflow_feature_refused`. `campaign-orchestration/feature.ts:148-153`
  says the features are "toggle-decoupled".
- **`CS70WF-12`: the kernel gate decides nothing.** `generate-kernel` saves the kernel, clears
  `kernelStale` and promotes `validated` before `approve` runs. Market-intel saves VOC, angles,
  hooks and targeting before its gate. Channel runs then use a rejected kernel.
- **`CS70WF-13..16`:** brief writers are not side-effect-classified, so a replay fork rewrites
  live state; angle ids are random, so they duplicate; `setKernel` has no precondition; and
  `extract-seeds` returns success with `{}`.
- **`CS70WF-23..25`:** the channel draft is accepted when the item array is empty or the wrong
  type; `creative_briefs` creates managed creative briefs before its gate; the canvas `render`
  node truncates and drops model output before `validateCampaignDoc` sees it (the ABR-RENDER-1
  class CLAUDE.md records).

## Boundaries audit

- **One executor, one dispatcher.** `core.dispatch` (`bootstrap/nodes.ts:233-880`) already
  supports `perWorkerOutputMappings` (`:273`) applied post-join in merge order (`:422-434`) and on
  a resumed wave (`:460-471`). Carrying drafts back needs no new executor feature.
- **Produced-variable precedent.** `examples/workflow-chain-packs/funnels` maps a child's bag
  variable out (`outputMapping {optinStep: step}`), declares `producedVariables[]`, and reads it in
  a collect node through `ctx.variables.get` (`packs/feature.funnels.nodes/index.mjs:175-180`).
  The campaign fan-out follows it instead of inventing a channel-specific read.
- **One launch gate.** `assertWorkflowFeatureLaunchable` (via `resolveLaunchWorkflow`) is the
  toggle + plan check `startWorkflowRun` applies. The orchestration preflight calls it for each
  child id rather than reading toggles itself.
- **One brief owner.** `features/campaign-brief/briefService.ts` owns briefs; the channel and
  orchestration nodes read it through `ctx.features['campaign-brief']`. No second brief read.
- **No new route, toggle, envelope or agent.** All four features keep their ids. No new
  `/.well-known/openwop` advertisement.

## Decision

### Phase 1 — the orchestration runs end to end (this row's PR)

- **D1 (`CS70WF-1`). Dispatch-seeded inputs ride `inputMapping` only.** The orchestration
  chain deletes `nextWorkerInputs` and maps `briefId`, `provider` and `model` through
  `inputMapping` (the funnels precedent). That also drops the chain's dependency on
  `OPENWOP_DISPATCH_PER_ITEM_INPUT` (`bootstrap/nodes.ts:577-581` fails closed without it).
  `briefId` reaches the parent bag under its bare name on all three definition paths: same-id by
  the rename in `buildChainBackedDefinition` (`chainBackedWorkflows.ts:94-112`), a Path A copy and a
  deferred `from-chain` copy through ADR 0964 D2's `forwardedParams` / `forwardedParamAliases`
  (`workflowChainPackLoader.ts:1797-1836`, `variablesRuntime.ts:237-254`).
  > **History this reverses.** `briefId` went into `nextWorkerInputs` on purpose on 2026-10-18 (ADR
  > 0903) because `from-chain` copies failed `brief_not_found`; it became redundant when ADR 0964 D2
  > forwarded params into the bag, and harmful on the same-id path, where deferred expansion
  > freezes it to `undefined`. `test/adr0903-run-ai-default.test.ts:128-138` pins the old shape and
  > changes with this ADR.

  **The generator cure is in the dispatcher:** an `undefined` per-item value is skipped, so it can
  no longer erase a mapped value. The stronger reason than "JSON has no `undefined`": the recorded
  supervisor decision is JSON, so today the live path (where `undefined` overrides) and a recorded
  path (where the key is dropped and the mapping wins) diverge. D1 makes live match recorded.
  `null`, `''` and an embedded `[missing: x]` marker still override, as before.

  **Residue (filed `CS70WF-30`).** Tenant copies minted from-chain before this change keep the
  per-item literal. In a deferred copy that literal is the author-time brief, so a per-run `briefId`
  override still dispatches the author-time brief. Measure how many exist (read-only SQL) before
  deciding between a migration and a re-instantiate notice.
- **D2 (`CS70WF-2`). Every child reports back through the bag, skipped or not.** Each channel
  `generate` writes one bag variable, `channelResult`, on both paths: `{channel, skipped: true,
  reason}` or `{channel, draft}` (declared in each channel chain's `producedVariables`, producer
  `generate`). The orchestration's `channel-dispatch` maps each child out with
  `perWorkerOutputMappings` (`campaign-studio.channel.landing-page` → `channelResult_landing_page`,
  …), declared in its `producedVariables`. `consistency-check` takes the variable names in config
  (as funnels `collect-steps` does, so a tenant copy stays editable) and reads a result only for a
  child whose `dispatched` entry is `completed`; the bag value of any other child is ignored,
  because a declared produced variable can also be seeded from run inputs
  (`variablesRuntime.ts:150-153`). A completed child with no `channelResult` is a typed
  `drafts_missing` failure; every completed child skipped is `no_channels_enabled`; no completed
  child is `channels_all_failed` (unchanged). "No drafts to compare" is gone as a success. Drafts
  are keyed by channel, never by `childRunId` (ADR 1002: the judge prompt carries no run-scoped id).
  The node also returns the per-channel summary as its output, so the result is recorded even if
  the bag's fire-and-forget persist (`variablesRuntime.ts:44-57`) loses a cross-instance race.
- **D3 (`CS70WF-3`). A disabled channel is skipped, visibly.** `generate` reads the brief's channel
  list; a channel the brief does not enable returns success with top-level `skipped: true` (set only
  by the node, never spread from model data; model fields stay nested under `draft`) and no model
  call. The channel chains' `generate → approve` edge carries `{type: 'falsy', left: 'skipped'}`
  (an absent key is falsy, so an enabled channel still reaches `approve`, `scheduler.ts:262`), so no
  approval is asked for a skipped channel. Standalone runs behave the same; the Channel Generator
  tool says so. **Finalize is not changed in P1:** it records the channels the brief enables at
  finalize time (`campaignService.ts:291`), which matches the generated set only when nobody edits
  the channel list mid-run. That race is part of `CS70WF-7` (filed).
  Channel copies minted before this change lack the falsy edge and will still raise a gate for a
  skipped channel (`CS70WF-30`).
  > **CORRECTED during implementation (2026-10-31).** Three things the decision text did not
  > foresee. (1) A run whose only terminal is condition-skipped counts as FAILED
  > (`scheduler.ts` `inspectDisposition`: no terminal completed ⇒ failed), so a skipped
  > channel ends on a `core.noop` terminal reached by `truthy(skipped)`, whose input is a
  > sentence saying why; that terminal is a primary output (the two branches are exclusive).
  > (2) The skip is OPT-IN by `config.skipDisabledChannel`, set only by the 1.2.0 channel
  > chains: grade-code found that a tenant copy of an older chain has an unconditional
  > `generate → approve` edge, so an unconditional skip would ask a person to approve a draft
  > that does not exist. (3) The enabled set is the surface's top-level `enabledChannels`
  > (`validateBrief`, spread by `assembleContext`), not `brief.channels`, which the projection
  > never carried. The Channel Generator tool refuses `channel_disabled` before starting a run.
- **D4 (`CS70WF-4`). Refuse before the first model call, honestly.** The Strategist's `run` tool
  calls `assertWorkflowFeatureLaunchable` with subject `{}` (what the dispatcher evaluates,
  `subWorkflowDispatcher.ts:253`) for the five child ids, after `assertEffectAllowed` and before
  `claimIgnition` (a refusal after the claim would latch the 5-minute dedup). It returns a typed
  refusal naming the feature that is off. The preflight is advisory: the gate is re-evaluated at
  dispatch, after the human approval, so a toggle or plan change inside that window still ends in
  `subworkflow_feature_refused`, which the run reports under its own code. The "toggle-decoupled"
  comment is corrected. `recommends` stays (alternative weighed below).
- **D5 (`CS70WF-6`). Start failures keep their code.** The three run tools relay an
  `OpenwopError`'s `code`, `details.reason` and message: `forbidden` + `not_entitled` /
  `feature_disabled` / `feature_unavailable` (`workflowFeatureGate.ts:88-92`), `rate_limited` +
  `workflow_budget_exhausted` (`runStarter.ts:143`), `rate_limited` / `service_unavailable` +
  `plan_run_limit_*` (`planRunLimit.ts:86-107`). Anything else stays `dispatch_failed`, so internal
  error text does not leak. (A budget or run-limit refusal after `ensureDraftCampaign` leaves a draft
  campaign behind; filed with `CS70WF-7`.)
- **D6 (`CS70WF-29`, `PROBE-CS70-2`). A witness that runs past the gate.** The chain-backed e2e
  approves `kernel-approve`, lets the five real channel children run against the real pack nodes
  (stub `callAI`), approves the enabled ones, and asserts: every child got the brief id, a disabled
  channel raised no gate, consistency scored real drafts, finalize recorded the campaign. A second
  case asserts the child `inputs.briefId` when the parent is a Path A and a deferred `from-chain`
  copy. The shape test stops using `JSON.stringify` for values that can be `undefined`.
- **D7 (`CS70WF-17`).** The in-tree consts shrink to what is read: the id lists that feed
  `registerWorkflowsFeature` and the exact output-role map `registerLegacyDefsChainBacked` restores
  (it deletes any role not in the map, `features/index.ts:291`). The stale `builtinWorkflows` and
  kill-switch prose goes. Tests that import the old shapes change with it
  (`campaign-workspace-gates-production.test.ts:32`, `campaign-orchestration.test.ts:301-327`,
  `campaign-channels.test.ts:103-133`, `campaign-brief-intel-workflow.test.ts:45`,
  `chain-backed-flagship-e2e.test.ts:144`).
- **Pins.** `feature.campaign-channels.nodes` `generate@1.2.0` → `1.3.0` and
  `feature.campaign-orchestration.nodes` `consistency-check@1.0.0` → `1.1.0`, the pack versions,
  `features/packPins.ts`, and the chain packs' typeId pins and versions move together (ADR 0600).

- **D2 corrected by grade-ux (2026-10-31).** "Every completed child skipped" and "an enabled
  channel failed while the rest skipped" were one code; the second now fails
  `channels_all_failed` naming the channel, and failed children are listed in the report's
  `channels`. Messages use channel labels, never workflow or brief ids.

### Replay invariant (P1 and later phases)

The bag writes in D2 are not node outputs. On a replay fork the bag is repopulated only because
`generate` is `action` and re-executes (its model call served from the invocation log,
`executor.ts:1184-1191`) and because `core.dispatch` re-dispatches live (`CS70WF-5`). So: **no node
in `MANIFEST_FAST_PATH_SERVED` may write the bag** (pack nodes have no `applyServed`; only
`core.subWorkflow` does, `bootstrap/nodes.ts:882`). That constrains P2's D9 and P3's D14. And the
day ADR 0964 option D1b serves `core.dispatch` from the log, it must re-apply the fold in
`mergeOrder`, or every replay fork of a campaign fails `drafts_missing`. That dependency is recorded
on ADR 0964.

### Phase 2 — the brief gates decide (separate PR)

- **D8 (`CS70WF-12`).** `generate-kernel` stages the kernel (`brief.proposedKernel`); a new
  `feature.campaign-brief.nodes.promote-kernel` node after the approval edge (in the
  messaging-kernel chain and after `kernel-approve` in the orchestration) promotes it, clears
  `kernelStale`, and is the only writer of `validated`. A reject never reaches promotion. Market
  intel stages the same way and promotes after its gate. The channel `generate` node and tool
  refuse `kernel_unapproved` / `kernel_stale`. **Migration rule:** a present `kernel` counts as
  approved, because promotion becomes its only writer; the two seeders that call `setKernel`
  directly (`campaignShowcaseSeed.ts:252`, `demoContentMarketingSeed.ts:253`) stay approved writes.
- **D9 (`CS70WF-13`).** Every persisting step is a `role: "side-effect"` node (promotion is the
  natural cut), so a replay fork serves the recorded outcome instead of writing. Regenerate
  `executor/sideEffectFloor.generated.ts` (its `--check` runs in the gate).
- **D10 (`CS70WF-14`).** Angle ids are content-derived (tenant, brief, normalised claim, sorted
  proof refs) with put-if-absent, as VOC does.
- **D11 (`CS70WF-15`).** Staging carries the brief `version` the context was assembled from;
  promotion refuses `brief_changed` when it moved. A row with no `version` is treated as version 0.
- **D12 (`CS70WF-16`).** `extract-seeds` fails `generation_empty` after one repair.

> **CORRECTED during P2 implementation (2026-10-31).** What shipped differs from the text above
> in five places, each for a measured reason:
>
> 1. **The staged kernel rides the run, not `brief.proposedKernel`.** It is the generator's node
>    output, handed to the approval (whose ADR 0083 preview shows it) and to `promote-kernel` by
>    data edges. The brief only records WHICH run holds a kernel for review (`kernelReview`,
>    never the kernel), so the brief page can say "a kernel is waiting for your approval" and
>    link to that run; the GET route reports it only while the run still waits (grade-ux H1).
> 2. **Staging is opt-in (`config.stageKernel`),** as P1's skip is: a tenant copy of an older
>    chain has no promote node and would otherwise never save a kernel. A ratchet test requires
>    every chain that contains `promote-kernel` to stage its generator and wire both data edges.
> 3. **Market intel is NOT staged.** `generate-angles` and `build-targeting` read the evidence
>    `extract-voc` STORES, so staging would mean carrying the evidence through edges, a redesign.
>    Its gate is now an honest review checkpoint (results are saved to the Intel tab as they are
>    found; approving finishes the run; rejecting removes nothing), and `research.run` refuses
>    before starting without an approved, current kernel. Staging filed as `CS70WF-36`.
> 4. **D9 for the market-intel writers is a label, not a replay fix.** They are `side-effect`
>    but held on the AI invocation log, so a replay fork re-runs them with the model call served
>    from the log. Evidence and angle ids are content-derived, so the repeat adds no duplicate;
>    it can resurrect an item a person deleted while curating, and the targeting upsert overwrites
>    the current pack (`CS70WF-37`). `promote-kernel` IS served, which is the fix D9 was for.
> 5. **Promotion is also conditioned on the kernel it replaces** (grade-code M3): the generator
>    records the stored kernel's `generatedAt` (null when there is none) as `priorKernelAt`, and
>    promotion refuses `brief_changed` if a different kernel was approved in between, so two
>    kernels generated from the same state cannot both be approved. (A first fix bumped the brief
>    `version` on every kernel save; that broke the version history's meaning, "a content edit",
>    and its snapshots, so it was reverted.) A missing revision or prior-kernel input is a refusal,
>    never an unconditioned save (M2). A stale kernel reaches readers as `null` with
>    `kernelStale`, and the channel and angle nodes fail `kernel_stale`; there is no separate
>    `kernel_unapproved`, because a present kernel is by construction an approved one.
>
> Also closed here: `CB-KERNEL-1` (the kernel write is closed-world, typed 422) and
> `CS70WF-18/-19`.

### Phase 3 — channel drafts and the canvas validate before they persist (separate PR)

- **D13 (`CS70WF-23`).** The channel draft is checked closed-world against its channel spec (item
  array present, non-empty, right types), with one error-fed repair, else `generation_invalid`.
  `channel` and `briefId` are set after the model's fields, never by them.
- **D14 (`CS70WF-24`).** Managed creative briefs are created in a `role: "side-effect"` node after
  the `creative_briefs` approval, from the approved draft.
- **D15 (`CS70WF-25`).** The `render` node passes values through; an over-cap, out-of-range or
  unknown value is a typed `validation_error` the model can repair, so `validateCampaignDoc` is the
  single judge.

> **CORRECTED during P3 implementation (2026-11-01).** What shipped, and why it differs:
>
> 1. **D13's check skips length limits** (types, required non-empty fields, no unknown fields, a
>    non-empty list; landing pages count `sections`). Lengths stay with the ADR 0355 platform-limit
>    pass, which regenerates and truncates with a flag; its regeneration must now pass the same
>    closed-world check or the validated draft is kept (grade-code H1). A `null` optional field and
>    malformed `citations` entries are normalized away before the check (citations are not what the
>    quality pass scores), so they cost no repair (M1/M2). The failure message names fields in plain
>    words ("email 1: subject lines must be a list") (grade-ux H2).
> 2. **D14's node is `create-creative-briefs`,** wired `approve → create_briefs` plus the data edge
>    `generate.draft → create_briefs.draft` carrying `falsy(skipped)`. Without that condition the
>    node ran on a SKIPPED channel: a node with one skipped and one successful upstream is ready
>    (measured in the e2e). Its summary ("N creative briefs are on the Creative Briefs page") is the
>    run's primary output, and creating none at all fails the run. Creating them charges nothing
>    (the charged render is a later step); a tenant copy of the older chain, which has no create
>    node, no longer creates managed briefs at all (0 such copies in prod, OQ-3).
> 3. **D15 keeps one drop:** a fully empty asset (`{}` or only blank strings) is still dropped,
>    because `validateCampaignDoc` accepts `{}` and saving a blank card is worse than dropping it.
>    Everything else, including non-text values, reaches the validator. The validator now says a
>    name is too long instead of calling it missing.
> 4. **Per-item refine (`CS70WF-26`):** the five approval prompts no longer promise "refine a
>    platform set / specific emails", which `itemsFrom` never delivered; the config key remains and
>    nothing reads it.

### Filed, not fixed here

- **`CS70WF-5` → ADR 0964.** A replay fork of the parent re-dispatches the children live, because
  `core.dispatch` is not side-effect-classified. ADR 0964:76 already names Campaign Studio. It is
  an executor change across every dispatch consumer.
- **`CS70WF-11`.** A `from-chain` copy dispatches the host-default children by id. RFC 0133
  nesting rides `core.subWorkflow`, not a supervisor-planned fan-out; expressing it needs an RFC
  0133 revision.
- **`CS70WF-7..10`, `-18..22`, `-26..28`:** the Improvements in the grade file, closed or filed at
  the end of each phase.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | No new package; edits stay inside the four features, their packs and one generic dispatcher line (D1). |
| 2 | Toggle + admin UI | No new toggle. D4 reads the existing ones through the launch gate. |
| 3 | `ctx.<feature>` surface | Unchanged in P1. P2 adds `promoteKernel` / `promoteIntel` to `ctx.features['campaign-brief']`, behind the existing `workspace:write` method scope. |
| 4 | Node pack | P1: `feature.campaign-channels.nodes` (skip + bag write), `feature.campaign-orchestration.nodes` (consistency reads the bag). P2: `promote-*` side-effect nodes. Versions and pins bump together (the ADR 0600 lesson). |
| 5 | AI chat / envelopes | No envelope. The tools keep their ids; their results become typed. |
| 6 | Agent pack | Strategist and Channel Generator prompts change only where they promise behaviour (skipped channels, gate meaning). |
| 7 | Public surface | None. |
| 8 | RBAC | Unchanged predicates; the preflight runs after the existing `workspace:write` check. |
| 9 | Replay / fork | See "Replay invariant": D2's bag writes repopulate on a fork only because `generate` re-executes and dispatch re-dispatches. P2's D9 is the replay fix for the brief. `CS70WF-5` is filed, with the D1b fold dependency. |
| 10 | Frontend | None in P1. P2 shows a staged kernel as "awaiting approval" on the brief page. |

## RFC verdict

Host work. D1 changes no per-item value a client can send (JSON has no `undefined`). D2 rides
`perWorkerOutputMappings` and `producedVariables`, both in RFC 0022 / RFC 0013 today. D3 uses an
RFC 0134 `falsy` condition. No new wire field, capability or event.

## Alternatives weighed

- **Fix only the pack (no dispatcher change).** Closes `CS70WF-1` but leaves the generator: the
  next chain that repeats a mapped key as a per-item literal fails the same way, silently.
- **Fix only the dispatcher.** Closes it too, but keeps the pack declaring a value twice. Both.
- **Consistency reads child runs from storage.** A node reading other runs' events is a new host
  surface and a second read path for the same data the bag already carries.
- **Plan only enabled channels in the supervisor.** The supervisor's plan is a static mock; making
  it input-driven needs a planner node. The skip-at-generate rule also covers standalone runs.
- **`dependsOn` instead of the preflight.** It adds a disable-lock, does not stop enabling
  orchestration with channels off, and changes the toggle console for every tenant.

## Open questions

- [ ] OQ-1: should a standalone Channel Generator run on a disabled channel generate anyway (an
  explicit ask) rather than skip? P1 skips, since the brief is the configuration; revisit if users
  ask.
- [x] OQ-3: how many deferred tenant copies of the orchestration or a channel chain exist
  (`CS70WF-30`)? **None** (measured read-only 2026-10-31: 286 `wfreg:` rows, 0 naming the
  orchestration or a channel chain). `CS70WF-30` closes without a migration.
- [x] OQ-2: prod measurement of how many orchestration runs reached the dispatch (`PROBE-CS70-3`).
  **Zero campaign runs have ever executed in prod** (0 rows for any workflow id containing
  `campaign`, and 0 runs whose metadata mentions it). `CS70WF-1` was latent: no child ever ran, so
  none received `briefId: undefined`. The proof is the chain-backed e2e (C), which goes red when
  both halves of the D1 fix are reverted (witnessed 2026-10-31: every child `failed`,
  `channels_all_failed`). The 1,458 `workflow:ownership` rows that mention "campaign" are not
  Campaign Studio runs or copies: every Campaign Studio chain declares a required `briefId`, and
  `seedWorkflows.ts` seeds only zero-config, non-internal chains (`:86-87`); the zero-config chains
  whose names say "campaign" are `career.campaign` and `tour.campaign-studio.first-brief`.

## `/architect` pass (2026-10-31, before code)

An independent adversarial review of the first draft found 2 Blockers, 5 Majors and 7 Minors in the
decision text. All are folded in above:

- **B1** the first D2 failed every run with a disabled channel `drafts_missing`, because the parent
  cannot tell a skipped child from a broken one (`dispatched` carries only status). Now every child
  writes `channelResult` on both paths.
- **B2** the first D1 reversed ADR 0903's 2026-10-18 fix without saying so and argued from the
  same-id path only. Now cited, with the three paths named and witnessed.
- **M1** per-item `provider`/`model` broke D1's own rule in a deferred copy: moved to `inputMapping`,
  `nextWorkerInputs` deleted. **M2** existing tenant copies keep the literal: filed `CS70WF-30`.
  **M3** preflight ordering (before `claimIgnition`), subject `{}`, and advisory honesty.
  **M4** the matrix's replay claim was false: restated as the replay invariant. **M5** "finalize
  ignores skipped children" was not implementable as written: restated as a filed race.
- Minors: config-named variables, recorded output alongside the bag, `skipped` never from model
  data, old copies lack the falsy edge, pin list, D5's exact codes and no message leak, the test
  fallout list, the P2 migration rule and version-less rows.

## Implementation record

| Phase | Commit | What | Witness (each sabotaged red, then reverted) |
|---|---|---|---|
| P1 D1/D2/D3/D6/D7 | `57e494183` | inputMapping only + dispatcher undefined-skip; `channelResult` → `perWorkerOutputMappings` → consistency; skip; consts → role maps; e2e past the gate | `dispatch-per-item-input-executor` (undefined case), `chain-backed-flagship-e2e` (C), `campaign-orchestration`, `campaign-channels`, `adr0903-run-ai-default` |
| P1 D3-D5 (chat-visible) | `a5edc66b9` | run-tool preflight before the claim; `channel_disabled`; `launchRefusalResult` | `campaign-agent-tools` (D3, D4 incl. no latch), `adr1020-launch-refusal` |
| P1 grade-code fixes | `f0e875973` | opt-in skip; skip terminal primary + summary; roles asserted on registered defs; `itemsFrom` kept | `campaign-channels` (opt-out case, registered roles) |
| P1 grade-ux fixes (chat-visible) | `a61e09d41` | H1 cause split; failed channels listed; label-only messages; refusal copy; tool-level D5 | `campaign-orchestration` (H1 case), `campaign-agent-tools` (budget relay) |
| P2 | (P2 PR) | kernel staged in the run + `promote-kernel` after the approval (both chains); CAS brief writes with a revision precondition; content-derived angle ids; typed seeds and kernel failures; closed-world kernel write; brief page + Strategist explain a waiting or stale kernel | `chain-backed-flagship-e2e` (B: nothing saved at the gate, approve saves, reject saves nothing; the standalone kernel chain), `campaign-brief-kernel` (D8/D11/D12, M2, M3, the CAS race, CB-KERNEL-1, CB-SEEDS-1), `campaign-brief-angles` (D10), `campaign-brief-agent-tools` (platform, regenerate after reject, kernel preflight), `campaign-brief-brief` (pending run), `campaign-brief-intel-workflow` (chain ratchet), FE `r2MoneyAndHonesty` |
| P3 | (P3 PR) | closed-world channel drafts with one repair and plain-word failures; managed creative briefs only after approval (`create-creative-briefs`, summary output); canvas render passes values through to the validator; honest gate prompts | `campaign-generation-qa` (D13 empty/off-schema/null/citations/empty landing page, H1 regeneration, D14 no creation in generate, CB-CODE-5 after approval, fail-all), `chain-backed-flagship-e2e` (D: nothing at the gate, approve creates, reject creates none), `campaign-studio-agent-tools` (D15: seven refusals incl. non-text), `campaign-channels` (chain shape + registered roles) |

Sabotages run (12): dispatcher undefined-skip, `briefId` dropped from `inputMapping`, generate
skip disabled, `perWorkerOutputMappings` removed, consistency `drafts_missing` bypassed, D4
preflight removed, `channel_disabled` check removed, refusal relay removed, skip opt-in forced,
D5 `startError` capture removed, H1 split removed, registrar role restore disabled.
