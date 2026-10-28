# ADR 0950 — Governed auto-promotion: gated, staged, reversible, replayable

Status: Accepted (P0, P1 and P2 implemented 2026-10-20; P3 and P4 open)

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 3. Net-new from David's 2026-10-19
request to "auto-select winning versions of ads/pages and drive traffic to them".
Depends on ADR 0949 (experiments, Decide verdicts) and ADR 0942 (autonomy policy,
the one gate primitive). Uses 0952 (ads budget shift) and 0955 (email winner
send) as adapters. Consumed by 0961 (autopilot). Integrates with, not depends on,
0960 (cockpit "replay this decision", a later tier).

## Context

The 2026-10-19 competitive scan found that **no major experimentation vendor
auto-promotes a winner.** Optimizely, VWO, AB Tasty, Statsig and Amplitude stop at
bandit traffic shifting. Unbounce Smart Traffic routes visitors automatically but
cannot explain why. Meta Advantage+ swaps creative silently and has had public
incidents for it (True Classic, Kirruna). The market therefore offers two options:
a human who reads a dashboard and clicks "ship", or an opaque optimizer.

We can offer a third: **promotion as a run.** The decision is a chain whose gates are
deterministic nodes and whose approvals are role-routed steps. Every input is frozen,
every stage is reversible, and the whole decision can be replayed. "Explain why it
won" means opening the run.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless they start with `docs/`.

- **Today's promote is manual, immediate and 100%.** `promoteExperiment`
  (`features/cms/pageExperimentsService.ts:436-510`) checks only `status ===
  'running'` (`:446`). It does not read results, so a caller can promote a losing arm
  or one with 3 sessions. It then `restoreVersion` + `publish`es, or, with
  `cms-approval-gate` ON, `submit`s and queues a content approval (`:480-497`), and
  sets `promoted` (`:505`). There is no ramp, no holdout, no rollback, and no
  post-promotion monitoring. The funnel equivalent can only `stop` a step experiment
  (`features/funnels/funnelsService.ts:437-447`). It has no promote at all.
- **Two approval lanes exist** (brief duplication list): `PendingApproval` kinds
  (`host/approvalService.ts:40-68`, which already has `content-publish` and
  `campaign-spend`) and `core.approvalGate` interrupts
  (`host/approvalGateTypeIds.ts:20`). ADR 0942 owns the bridge. This ADR uses whatever
  0942's one gate primitive resolves to and adds no third lane.
- **CMS promote is already gated in one org mode.** With `cms-approval-gate` ON, a
  promote queues a `content-publish` approval (`pageExperimentsService.ts:491`).
  0950's own gate must satisfy that queue, not stack a second approval on top (D4).
- **Tamper-evident log exists.** `host/auditChainService.ts:188` `appendAudit` is the
  per-tenant hash chain (CAS-serialized, `verifyChain` at `:240`). Experiment actions
  are recorded today only as plain rows (`pageExperimentsService.ts:90-102`).
- **Replay/fork primitives exist.** `POST /v1/runs/{runId}:fork`
  (`routes/runs.ts:6`), `executor/replayDivergence.ts`, side-effect ledger
  `executor/sideEffects.ts`. A `role:"side-effect"` node does not re-execute on fork
  (ADR 0921 matrix row 9 precedent).
- **Run-start freeze:** `host/runStartContext.ts:62-70` (ADR 0099).
- **Monotone ramps are possible with the existing hash.** `assignWeightedVariant`
  walks cumulative bands in arm order (`host/variantAssignment.ts:55-61`). If the
  winner's band grows contiguously and the holdout band is pinned at the other end,
  raising the winner's weight only moves control users onto the winner, never the
  reverse. D3 relies on this, and a test must prove it.
- **Schedules and timers:** `host/scheduleDaemon.ts:95` `fireJob`; journey timers
  (ADR 0267) are the in-chain wait precedent.

## Decision

### D1 — Promotion is a chain pack, not a service call

`experiments.promote` is a workflow-chain pack (RFC 0013 / ADR 0163) shipped in
`feature.experiments.chains`. One run per promotion attempt:

```
check-gates ─▶ policy-gate(0942: experiment.promote) ─▶ apply-ramp(50) ─▶ wait(stage)
   ─▶ recheck ─▶ apply-ramp(90) ─▶ wait ─▶ recheck ─▶ apply-ramp(100 − holdout)
   ─▶ monitor(window) ─▶ finalize            any recheck/monitor breach ─▶ rollback
```

- `check-gates`, `recheck` and `monitor` are deterministic read nodes over ADR 0949's
  `host/experiments/stats.ts`. Each one writes its full input snapshot (rollup cells,
  `planHash`, `computedAt`) and its result into the node output, so a replay sees the
  same numbers.
- `apply-ramp`, `rollback` and `finalize` are `role:"side-effect"` nodes. Each has an
  idempotency key `experimentId::stage` and a CAS on `(status, lastEpoch)`, so two
  promotion runs cannot interleave and a fork never re-applies a stage.
- The run is started only by the experiments service (agent, schedule or human
  trigger). It carries the ADR 0941 run tag (client checked per ADR 0921 D3), and the run-start
  contributor freezes the policy outcome (ADR 0942) and the experiment's `planHash`.
- One live promotion per experiment: the service refuses a second start with 409
  `promotion_in_progress`.

### D2 — The gates (all must pass; each result is recorded)

| Gate | Rule | Source |
|---|---|---|
| G1 Mode | `mode === 'decide'`, plan locked, not `legacy` | ADR 0949 D2 |
| G2 Duration and sample | `days ≥ max(7, plan.minDays)` covering ≥ 1 full week; every arm `≥ plan.minSamplePerArm` | plan |
| G3 SRM | chi-square p ≥ 0.001 over the whole test and over the last 7 days | stats |
| G4 Primary | verdict `winner(arm)` under mSPRT + BH-FDR at `plan.fdrQ` | stats |
| G5 Practical significance | point lift ≥ `plan.mde` and the confidence-sequence lower bound > 0 | stats |
| G6 Guardrails | every guardrail passes non-inferiority at its margin (no `guardrail_breach`) | stats |
| G7 Novelty stability | lift estimated on the trailing 7 days is ≥ 50% of the full-period lift and has the same sign; no monotone decay across weekly slices | stats |
| G8 Content | the winner's content passes the publish blockers and ADR 0933 content rules at promotion time | adapter |

A failed gate ends the run with a typed outcome (`gate_failed: G5`, …). It never
falls through to an approval with a "looks good" summary. The CRO Analyst (ADR 0943)
writes the narrative from the recorded gate outputs only.

### D3 — Staged ramp, long-term holdout, monotone assignment

- **Stages:** 50 → 90 → (100 − holdout). Each stage appends an ADR 0949 allocation
  epoch with `reason: 'ramp'` and `decidedByRunId`. The defaults are a 24-hour minimum
  wait plus `plan.minSamplePerArm / 4` new units per stage. The plan may lengthen them
  but cannot shorten them below 24 hours.
- **Recheck at each stage:** G3 (SRM at the new weights) and G6 (guardrails on the
  stage's own data). A breach routes to rollback.
- **Long-term holdout:** 1–5% of units (default 2%) stay on control for `holdoutDays`
  (default 28, maximum 90). The holdout measures decay and novelty after promotion and
  is what `monitor` compares against. It ends by schedule or by a human.
- **Monotone layout:** `rampLayout(arms, winnerKey, winnerPct, holdoutPct)` (new, in
  `host/variantAssignment.ts`) orders the bands so the winner's band grows from the low
  end and the holdout band stays fixed at the top. Witness test: over 100k keys, no
  unit ever moves from the winner to control between stages, and no holdout unit ever
  sees the winner.
- **Surfaces without per-unit weights.** Email promotes by sending the winner to the
  rest of the audience in the ADR 0955 send run (a stage is a send batch, and an email
  already sent cannot be rolled back, which the UI says). Ads promote through ADR
  0952's governed budget-share action (stages are budget shares, inside caps). Social
  has no promotion in v1.

### D4 — Autonomy modes, resolved by ADR 0942 and frozen at run start

Action class `experiment.promote` in ADR 0942's table (its chokepoint becomes this
chain's `apply-ramp` node). Rollback is not a policy class (see below):

- **Default: "auto-promote after human approval."** One role-routed approval before
  the first ramp. It goes to the campaign's CRO or owner role, with SLA, escalation and
  delegation from `approvalSla.ts` / `approvalDelegations.ts`. Later stages run
  automatically unless a recheck flags.
- **Full auto (opt-in per campaign, per client org):** no approval. Each stage opens a
  **veto window** (default 24 h, minimum 1 h) with a notification to the role. A veto
  rejects the stage and ends the run as `vetoed`. Silence lets the stage proceed. The
  veto is the 0942 `notify-after` outcome with `vetoWindowMs` set, not a new primitive.
- **Review every stage:** an approval before each ramp.
- **Blocked:** promotion is refused, and the result is reported only.
- **One gate, not two.** When the surface owner has its own gate (CMS
  `cms-approval-gate`), the adapter maps ADR 0942's resolution onto it. An approval in
  0942's gate resolves the `content-publish` row with the same approver, and the
  ADR 0859 self-approval rule applies. A full-auto CMS promotion in an org that has the
  CMS gate ON is refused with `surface_gate_requires_human`: the stricter gate wins.
- **Rollback is never blocked by policy.** It moves toward the known baseline. The
  exception is ads, where restoring a paused control ad is spend and goes through ADR
  0952's caps.

### D5 — Post-promotion monitoring and auto-rollback

- `monitor` re-runs G6 and the primary metric against the long-term holdout every
  6 hours for the holdout period, using one-sided sequential tests (always valid, so
  repeated looks are safe).
- **Breach → `rollback`:** the adapter restores the control content (CMS:
  `restoreVersion` + publish of the pre-promotion version recorded at `finalize`),
  appends a `rollback` epoch, sets status `rolled_back`, notifies the role, and logs
  the decision. Rollback is idempotent per `experimentId::rollback`.
- **One-click manual rollback** from the cockpit (ADR 0960) starts the same node
  through a `rollback` run.

### D6 — Immutable decision log and "explain why it won"

- Every gate result, policy resolution, approval or veto, stage apply and rollback
  appends `experiment.decision` to the per-tenant hash chain (`appendAudit`). The
  payload is `{experimentId, campaignId, orgId, runId, stage, gateResults, planHash,
  snapshotHash, policyRef, actor}`. It never holds content or visitor identifiers.
- **Explain:** the cockpit (ADR 0960) opens the decision run. It shows the frozen gate
  snapshots and the CRO Analyst narrative, and it can `:fork` the run to re-execute
  the gate nodes on the frozen snapshot. A replay that gives a different gate result
  is a P0 determinism defect, caught by `replayDivergence`. `verifyChain` proves the
  log was not edited afterwards.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Extends `features/experiments/` (ADR 0949): promotion service, adapter `ramp/promote/rollback` methods. No new package. |
| 2 | Toggle | Sub-toggle `experiments.auto-promote`, default **OFF**, `bucketUnit: 'tenant'`, AND-gated with `experiments` (the `creative-video.t2v` precedent). Manual promote of a passing Decide test works with the sub-toggle OFF. |
| 3 | Workflow surface | `ctx.features.experiments.{checkGates, applyRamp, rollback, finalize}`; each takes `orgId` and checks the run tag (ADR 0941 D2b). |
| 4 | Node pack | `feature.experiments.nodes`: `check-gates`, `recheck`, `monitor` (read); `apply-ramp`, `rollback`, `finalize` (side-effect). Chain pack `experiments.promote` (builder-editable, instantiated per campaign; per-client overrides via ADR 0959). |
| 5 | Envelopes | None. Approvals and vetoes are ADR 0942 gate interrupts (RFC 0021 lane already used by `core.approvalGate`). |
| 6 | Agent pack | None new. The CRO Analyst (ADR 0943) narrates gate outputs and may start a promotion run. It cannot pass a gate. |
| 7 | Public surface | None. |
| 8 | RBAC | Start: `workspace:write` on the client org plus the 0942 outcome. Approve or veto: the role 0942 resolves. Manual rollback: `workspace:write`. Wrong org → uniform 404. |
| 9 | Replay / fork | Gates record their snapshot; side-effect nodes are keyed and CAS-guarded; the policy outcome and `planHash` are frozen at run start. A fork re-derives nothing. |
| 10 | Frontend | Promotion panel on the experiment page: gate checklist with values, stage timeline, veto button with countdown, rollback button, "explain" link to the run. Cockpit tile (ADR 0960). |

## Why this is our advantage

- **First governed auto-promotion in the market** (per the 2026-10-19 scan). Others
  either stop at "here is a winner" or optimize silently. We promote inside limits the
  client set, with a veto window and automatic rollback.
- **Durable, replayable runs.** A promotion lasts days (stages, holdout). In
  GoHighLevel or n8n that would be a fragile timer. Here it is one durable run, and
  any stage can be replayed with the exact numbers that justified it.
- **Role-routed human gates inside the run**, configurable per campaign by ADR 0942
  with SLA and delegation. Klaviyo or Braze offer one approve button. Ziflow and
  Workfront gate assets, not live traffic decisions.
- **Tamper-evident audit:** "who or what promoted this variant, on which numbers,
  under which rule" is a verified hash-chain entry.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `check-gates` as a read-only node + API; the CMS manual promote shows the gate checklist and warns (does not block) | Gate outputs are deterministic on a fixture; promoting a 3-session arm shows a red G2 |
| P1 | `rampLayout` + monotone witness; adapter `ramp/rollback` for `cms.page` and `funnel.step`; decision log entries | 100k-key witness green; rollback restores the recorded version |
| P2 | `experiments.promote` chain with the default mode (approval before first ramp), stages, rechecks, holdout, monitor | E2E: fixture winner ramps 50→90→98 with holdout 2%; a guardrail breach at 90 rolls back |
| P3 | Full-auto opt-in with veto windows; CMS gate mapping (D4) | Veto ends the run `vetoed`; CMS-gated org refuses full auto |
| P4 | Email and ads adapters (with 0955/0952); cockpit explain view (0960) | Email remainder send uses the winner; ad stages respect caps |

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | branch `feat/0950-p0-promotion-gates` (stacked on ADR 0949 P4b #5116) | `adr0950-p0-gates.test.ts`: a clean winner passes all eight gates, deterministically and independent of cell order (**the P0 exit, first half**); each gate fails for its own reason; a gate it cannot compute is `not_evaluable`, never a pass; **over the real CMS route a 3-session arm shows a red G2 (the P0 exit)**, and the experiments route serves the same report; another org is a 404. FE `promoteGates.test.tsx` (the CMS promote confirm lists the gates, warns and still promotes; an unreadable checklist says so) and the experiment page's checklist. Sabotage-witnessed: not_evaluable counted as pass, G2's sample leg, the hash order, the checklist removed from the confirm, a failing checklist that blocks |
| P1 | branch `feat/0950-p1-ramp-rollback` (stacked on #5121) | `adr0950-p1-ramp-rollback.test.ts`: **the 100k-key monotone witness** over four launch layouts (winner last, in the middle, uneven) across stages 50 → 90 → 98 with a 2% holdout: no unit leaves the winner, launch winners stay, no holdout unit sees the winner; a ramp is idempotent per stage, never shrinks or goes back, and drives the public CMS assignment; **finalize ships the winner's version and rollback restores the recorded baseline** (and is idempotent); a funnel step swaps its page and back; every action appends `experiment.decision` and the chain verifies. Sabotage-witnessed: the original low-end re-layout reds all four witness cases; stage idempotency; the baseline restore; the decision log |
| P2 | branch `feat/0950-p2-promote-chain` (stacked on ADR 0942 P2 `feat/autonomy-0942-p2` and this ADR's P1) | `adr0950-p2-promote-chain.test.ts`, through the real loader, starter, executor, node pack and surface: **the P2 exit, a fixture winner passes the gates, takes one approval (an unbound run is `legacy`), ramps 50 → 90 → 98 with a 2% holdout, each stage rechecked on its own units, is monitored and finalizes** (decision log ramp, ramp, ramp, finalize; a replay fork applies nothing); **a guardrail breach at stage 2 rolls back** (control 100, `rolled_back`, stage 3 never applied); only the claimed run may ramp, finalize or roll back; a second start is `promotion_in_progress`; failing gates refuse to start; the route is sub-toggle gated, refuses a viewer and is a 404 from another org. Pack `feature.experiments.nodes` 1.4.0; chain pack `core.openwop.workflows.experiments` 1.1.0 |

> **Correction 2026-10-20 (P0 architect review + build) — the gates as built.**
>
> 1. **One observation path.** The rollup rebuild moved from the experiments
>    service into `host/experiments/observe.ts`, so the experiments routes, the
>    gates and the CMS promote path share one implementation.
> 2. **The gates are pure and recorded.** `host/experiments/gates.ts`
>    `evaluateGates` takes the cells, the verdict and the instant, and reads no
>    clock. Every gate carries its status, a machine reason and the numbers it
>    read; the report carries `{planHash, cellsHash, computedAt}`. The
>    `check-gates` node (pack `feature.experiments.nodes` 1.3.0, role action)
>    records it all, so a replay shows the same numbers.
> 3. **`not_evaluable` is not a pass.** A gate that cannot be computed (no
>    winner for G5/G7/G8, a surface with no content check for G8) is
>    `not_evaluable`, and only an all-`pass` checklist can promote.
> 4. **"Recent" is cohort-based.** Cells are keyed by first-exposure day, so G3's
>    last 7 days and G7's trailing lift mean units first seen in the last 7 days.
>    Recent cohorts have had less time to convert, which biases both arms alike;
>    G7 compares signs and ratios, never absolute rates.
> 5. **A plan-less experiment is held to floors.** G2 for a legacy CMS test uses
>    7 days and 30 units per arm (labelled `default_floors`), so the CMS manual
>    promote can show a red G2; G1 is always red for it (relaunch with a plan).
>    G2 names both legs when both fail.
> 6. **G8 is the surface's call.** A new optional adapter method,
>    `checkPromotable`: CMS checks the winner version exists, carries the review
>    stamp where the gate needs one, and passes the publish blockers; a funnel
>    step checks the variant page is published.
> 7. **No toggle in P0.** The checklist is read-only; the sub-toggle
>    `experiments.auto-promote` lands with P2. The CMS manual promote shows the
>    checklist in its confirm and never blocks on it.

> **Correction 2026-10-20 (P1 build) — the ramp grows the winner's OWN band;
> D3's "low end" layout was not monotone.** D3 said to order the bands "so the
> winner's band grows from the low end and the holdout band stays fixed at the
> top". At launch the winner's band is wherever its arm order put it (for an A/B
> test, `[50, 100)`), so re-laying the bands as `[winner | control]` moves every
> existing winner unit above the new edge back to control at the first stage:
> exactly what D3 forbids. Measured: that layout reds all four cases of the 100k
> witness. `rampLayout` (in `host/variantAssignment.ts`) instead keeps every unit
> on its launch arm and grows the winner's launch band from its own edges, first
> away from the holdout, then toward it, never into it. The holdout is a fixed
> band at whichever end the winner's launch band does not touch (the low end
> when it can). A ramp epoch stores its band layout (`layout`, a key may repeat),
> and assignment for a ramped experiment (CMS pages, funnel steps, contacts)
> reads the layout. `applyRamp` is keyed by `stage`. `finalize` asks the surface
> to ship the winner and records what it replaced (CMS: the latest published
> version; funnel: the step's page); `rollback` restores it, puts every unit on
> control with a `rollback` epoch and is never blocked by policy. Each action is
> an `experiment.decision` entry on the tenant hash chain with ids and numbers
> only. The CMS manual promote, finalize and rollback now share one
> publish-a-version composition, so they cannot differ.
>
> **Code-review fixes (P1).** The holdout size is fixed for a promotion
> (`holdout_changed`): a different size moves the band edge and sends winner
> units back to control. Every ramp refusal is decided inside the CAS, not on the
> pre-read. `finalize` claims the row (CAS) before the surface ships anything, so
> two concurrent finalizers publish once and log once; a failed ship releases the
> claim, and a rollback that lands mid-ship is honoured when the ship finishes.
> The CMS baseline is the newest `origin: 'publish'` snapshot: the newest row of
> any origin can be a `seed` offer or a `submit` capture that was never live.
>
> **Grade-workflows fixes (P1, replay).** A rolled-back experiment now counts as
> assigning for any run that began before the rollback (`assigningAt`), the same
> rule as a stop: before this, a `:fork` of such a run assigned every unit to
> "untested" while its source had assigned them to arms. A stage retried with
> different numbers is refused (`stage_mismatch`) instead of silently reported as
> `existing`: a replay repeats its inputs exactly, so a difference is a caller bug.

> **Correction 2026-10-20 (P2 architect review + build) — the promotion chain, as built.**
>
> 1. **One run may promote an experiment, and every step checks it.** D1 put
>    "one live promotion per experiment" in the service. The architect review
>    found that insufficient: a chain in the gallery can be instantiated by hand
>    with any `experimentId` and would skip the service's checks. So
>    `startPromotion` CLAIMS the experiment for a fresh run id (CAS on
>    `promotionRunId`, before the run starts; released if the start is refused)
>    and `apply-ramp`, `finalize` and `rollback` refuse any other run
>    (`not_the_promotion_run`). A new start is refused while the previous
>    promotion run is still live (its status is read, so a crashed run never
>    wedges the experiment). The chain is `internal`, owned by the sub-toggle
>    `experiments.auto-promote` (default OFF; the route AND-gates `experiments`).
> 2. **Stage 1 re-checks every gate.** The approval can take days; the data can
>    drift into an SRM or a breach meanwhile. `apply-ramp` stage 1 re-evaluates
>    G1–G8 and refuses `gate_failed` (or `winner_changed`) before anything moves.
> 3. **The policy gate is the experiments pack's own node over the SAME host
>    decision.** D1 drew `policy-gate(0942)`; reusing
>    `feature.campaign-orchestration.nodes.autonomy-gate` would make every
>    promotion depend on the campaign-orchestration feature and pack (the node
>    throws `host_capability_missing` without that surface). The decision is
>    host code (`host/autonomyPolicy` `decideGate`), so `ctx.features.experiments
>    .policyResolve` calls it with `experiment.promote`, and
>    `feature.experiments.nodes.policy-gate` acts on the verdict exactly as the
>    campaign node does (the same `kind:'approval'` interrupt, the same
>    `data.autonomy` block, the same refusals; listed in
>    `APPROVAL_GATE_TYPE_IDS`). The two node bodies are small and duplicated
>    because a pack cannot import host code; the decision is not duplicated.
>    A promotion run is not campaign-bound in P2 (the ADR 0941 run tag is
>    stamped by the campaign feature, which this package does not import), so
>    the policy resolves `legacy`: one approval, the `core.approvalGate`
>    posture. Binding a promotion to its campaign, and with it the full policy
>    and the CMS gate mapping, is P3.
> 4. **Rechecks look at the stage's own units, against the stage's weights.** A
>    stage's cohort is the units first exposed since its epoch (cells are keyed
>    by first-exposure day). SRM is computed against the stage's weights: the
>    launch weights would call an SRM on every ramp. Not enough units yet is
>    `stage_underpowered`, a typed stop with the experiment held at its stage
>    (safe and monotone; a new promotion run resumes, since applied stages are
>    `existing`). A stage is judged no sooner than 24 hours after it applied
>    (`stage_too_soon`); only a test may shorten that (`NODE_ENV === 'test'`).
> 5. **Monitoring is one look in P2.** After the last stage a monitoring window
>    runs, then `monitor` checks SRM, guardrails and the primary metric against
>    the holdout (a breach when the winner's confidence sequence is wholly below
>    zero). The repeated 6-hourly looks of D5 need a scheduled job and land with
>    the holdout's end-of-life in a later phase.
> 6. **Rollback has three nodes, one per breach point.** A node with several
>    incoming conditional edges would wait on edges that never fire.

## Alternatives weighed

- **Promote from Optimize (bandit) results.** Rejected: a bandit has no error
  guarantee, and promoting on it is the opaque behaviour we are positioned against.
- **Immediate 100% promote with a rollback button** (what exists). Rejected as the
  automated path. It is kept as the manual path once the gates pass.
- **A promotion service with a cron instead of a chain.** Simpler, but the multi-day
  state would live outside a run, so there would be no replay, no per-node agent and no
  builder editability. That is the in-tree workflow the CLAUDE.md doctrine forbids.
- **Promote by editing toggle weights.** Rejected: toggles are not org-scoped content.

## RFC verdict

**Host extension, no RFC.** The chain pack uses existing node roles, ADR 0942's
`autonomy-gate` (an interrupt-lane gate) and run metadata keys. Approvals and vetoes ride the already-accepted
interrupt and RFC 0021 lanes. Nothing is advertised.

## Open questions

1. **(David)** Should the default mode be "auto-promote after one human approval"
   (recommended), or "review every stage" for the first 90 days of a client?
2. **(David)** Default long-term holdout of 2% for 28 days: acceptable cost of
   learning, or 1% for small-traffic clients?
3. **(David)** Minimum veto window for full auto: 24 h proposed (1 h hard floor). Should
   regulated categories (0942) forbid full auto entirely?
4. Does the CMS `cms-approval-gate` + full auto conflict resolve as "refuse" (D4) or
   "downgrade to approval mode with a notice"?
5. *Resolved in program review:* ADR 0942 D1 names this chain's `apply-ramp` node as
   the `experiment.promote` chokepoint, and the manual promote calls through it.
6. After promotion, is the losing arm's content archived (kept for replay) or deleted?
   Proposed: kept, since CMS versions are retained.

## Planning rows

**ROADMAP (Campaign Studio program table):**

| Order | Item | Toggle | Depends on | Pack slug | Wire / RFC gate | Status |
|---|---|---|---|---|---|---|
| T3-b | **Governed auto-promotion** ([ADR 0950](docs/adr/0950-governed-auto-promotion.md)): promotion as a chain behind 0942 policy; gates (≥7 d + sample, SRM, FDR winner, practical > MDE, guardrails, novelty); 50→90→100 ramp with rechecks; 1–5% holdout; veto window; auto-rollback; hash-chained decision log; replay to explain | `experiments.auto-promote` | 0949, 0942, 0933 | `feature.experiments.*` | Host extension | 🔵 Proposed |

**FEATURES "Future features":**

- **Governed auto-promotion (ADR 0950, Proposed)**: the `experiments.promote` chain
  checks eight recorded gates, asks the ADR 0942 policy (default: one role-routed
  approval; full auto opt-in with veto windows), ramps 50→90→100 with a 1–5% long-term
  holdout and guardrail rechecks, monitors after promotion and rolls back automatically
  on breach. Every decision is a hash-chained audit entry, and "why it won" replays the
  decision run. Sub-toggle `experiments.auto-promote` (OFF, tenant). Host-ext, no RFC.

### Recovery review correction — promotion ownership, 2026-10-21

The recovered P2 implementation treated a missing run as dead immediately after
reserving its id, so a concurrent request could steal the reservation before the
starter inserted the first run. A reservation now records its creation time:
missing runs retain a five-minute startup grace, terminal runs release at once,
and a corrupt reservation timestamp fails closed. A legacy missing timestamp
starts its grace on the first CAS-guarded observation of a missing run. A crash
before insert therefore has a bounded recovery window without stealing a live
starter's reservation. The starter also pins the trusted chain-backed definition
hash, refusing a changed catalog definition or an old tenant-owned published pin.

The surface's ownership read is also repeated inside each ramp, finalization and
rollback CAS. A competing claim or release between the surface read and the write
must refuse the stale operation. The original P1 trusted service calls remain valid
when the experiment has no promotion-run binding. Deterministic race witnesses and
full canonical validation are pending; this correction is not a shipping claim.

The recovery review also found that filtering daily cells from the stage's date
included units exposed before the ramp earlier that same day. Stage observations
now filter exact first-exposure timestamps before folding cells, while rebuilding
the shared full-experiment cache from all units. Partial source coverage cannot
pass a stage. A same-day mixed-allocation witness also checks the full cache stays
intact; execution remains pending the serial validation slot.

Recovery correction (2026-10-24): a thrown starter can follow a committed run
and dispatch outbox. It no longer releases that run's promotion authority. A
normal null refusal still releases immediately; missing-run recovery uses the
existing startup grace. An inserted-run/lost-read witness covers the ambiguous
acknowledgement. The replay witness now requires an actual 201 fork, a completed
child and the source parent id, instead of accepting an HTTP refusal as coverage.
These witnesses await executable validation alongside the original P2 exits.

Recovery correction (2026-10-24): the initial promotion reservation also freezes
its elected winner and gate hashes. A new run continuing a held ramp checks that
same winner, plan and holdout against the current stage's allocation and exact
cohort (including current content publishability), rather than testing mixed
ramp history against launch weights. The reservation CAS rejects a changed
status, plan, stage or epoch after the checks. Both the starter and the claimed
run's require-gates surface follow this path. A real stage-2 underpowered run,
new observations and continuation witness also assert that no epoch repeats and
the original holdout survives. Execution is pending; finalization/rollback
receipts and replay of the original preflight decision remain release blockers.

### Recovery correction — surface receipts (2026-10-24, in progress)

The P1 claim above that a thrown ship means "nothing shipped" is invalid: a primary write can commit and its acknowledgement fail. The same issue applies to rollback, whose status must not be mistaken for evidence that baseline restoration completed. Publication receipts therefore belong to the surface, atomically with its own content pointer, and are keyed by the experiment rather than the caller's attempt. The engine must reconcile them on retry and only record final completion after the surface confirms it.

The funnel surface now stores its original baseline and finalized/rolled-back receipt on the same funnel primary row as the step pointer. All existing funnel updates use an expected-row CAS so a stale editor/lifecycle/experiment writer cannot erase a committed receipt. A rollback can close an unfinalized receipt, fencing a paused finalizer; a committed finalize or restore with a lost acknowledgement reconciles after restart. Manual edits after publication cause a conflict rather than being silently overwritten. Receipts remain at funnel scope across step edits/removal and are deleted with the funnel. Four file-backed SQLite witnesses cover commit/ack loss, rollback-before-finalize-CAS and stale editor writes. These witnesses are authored but not yet executed. CMS receipts, the engine's final acknowledgement and frozen preflight replay remain release blockers.

Recovery implementation (2026-10-24, unvalidated): the source run now records the actual gate/stage report per executing node with the existing atomic, never-overwrite run metadata merge. Replay inherits these host-owned reports; dashboard reads remain live, current org access still applies, and publication/ramp authority is never inherited from a report. Public and scheduler admissions strip the entire evidence-key prefix. SQLite's conditional metadata merge now compares exact top-level keys rather than interpreting dotted names as JSON paths, matching Postgres. Seven direct storage/surface witnesses cover immutable reports, a lost acknowledgement, mismatched experiments/operations, missing replay evidence, caller forgery and ordinary live reads; the existing real fork completion witness remains.

The engine now records finalization only after the surface confirms its durable receipt, retains pending-approval truth on retries, and retries content restoration even after traffic/status already rolled back. It never treats an exception as proof that no content committed. CMS must still implement its own primary-row receipt before this draft can pass or merge. All new source and witnesses remain pending executable validation.

CMS receipt implementation (2026-10-24, unvalidated): a promotion now pins one immutable original-content capture in the existing page-version owner before its first page change. This internal capture makes no publish/review claim, is hidden from editor history, cannot be an experiment arm and survives ordinary50-version pruning. The page's primary kernel row holds its baseline/public reference, capture reference, winner, owned version/status and phase. Restore and transition advance that phase in the SAME page CAS; a stale editor write cannot erase it, nor can a paused finalizer pass a rollback's closed phase. Existing content blockers, current approval toggle, review queue, self-approval and restore/transition owners remain in force. A never-published original restores to its original draft content and stays offline instead of interpreting null as a no-op. Closed/superseded captures are removed on reconciliation; a capture left by a failed initial prepare remains with its page owner and is deleted with the page. Ten file-backed SQLite cases are authored for restart/ack loss, rollback-before-content-CAS, later human edits, review queueing, history retention and engine retry after traffic/status changed but content restoration failed; execution is pending. Primary content receipts do not strengthen the existing best-effort lifecycle/audit delivery contract.


### Recovery correction: real timer completion and stop races (2026-10-24)

The loader deliberately freezes non-prompt chain config at expansion. Run inputs
could not shorten the promotion chain's 24-hour timers; the ineffective internal
shortening options were removed. The end-to-end fixture advances the existing
timer sweep's explicit clock to the persisted deadline and drives the production
preclaimed resume continuation. The core flow wait node now wraps that resolution
in its declared successful `{resumed, payload}` output rather than returning a
raw payload that the loader rejects. The pack patch is `1.1.4`.

Stopping or abandoning an experiment after its content commit but before the
engine acknowledgement must restore the original baseline through the same
surface receipt. A retry after acknowledgement loss also reconciles that receipt
before refusing the stopped promotion. Two file-backed SQLite interleavings
cover the normal response and a lost response, with restart, unchanged stopped
status and no false `finalizedAt`. These changes still await their focused and
canonical gates.


Recovery validation checkpoint (2026-10-24): all 277 cases across 21 focused
backend files pass, including the original promotion exits and completed replay
fork, thirteen CMS receipt/lifecycle cases, seven frozen-read cases and four
funnel cases. CMS managed lifecycle changes now also use the engine CAS, so a
stop cannot erase a concurrent promotion reservation or intent. The replay
fixture explicitly resolves its reopened human approval before checking that no
publication or allocation repeats. Test observations are frozen at their epoch
instant, within the actual as-of bound.

The wait repair already exists in PR #5110; its original head and dedicated real
timer/executor witness are integrated rather than publishing a second body for
the same 1.1.4 version. The unknown-route page is loaded on demand under the
existing router Suspense boundary (ADR 0874); its entry size still needs the canonical build gate.
Canonical validation and signed registry publication remain required.
