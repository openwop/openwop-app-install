# ADR 0950 — Governed auto-promotion: gated, staged, reversible, replayable

Status: Proposed

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
