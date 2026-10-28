# ADR 0949 — Unified experimentation engine: one experiment model, Decide and Optimize

Status: Accepted (P0, P1a, P1b, P2a, P2b, P3a, P4a and P4b implemented 2026-10-20; P2c A1 implemented and deployed 2026-10-26 (`7412be26b`); P2c A2 implemented 2026-10-26 (`639a96514`; legacy step splits store the pointer; rollback floor A1); P3b implemented 2026-10-26 (#5254, `f217d9003`); P2c A3 implemented 2026-10-26 (a step stores the pointer wherever A2's `linkedStepExperiment` reads it back; rollback floor A2); P5 open)

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 3. Net-new from David's 2026-10-19
request ("run multivariate tests … auto-select winning versions"), not a port.
Depends on 0941 (canonical `MarketingCampaign.id`) and 0942 (autonomy policy).
Adapters are registered by 0952, 0953 and 0955 (earlier tier). Consumed by 0950
(promotion), 0951 (hypothesis backlog), 0956 (incrementality), 0960 (cockpit), 0961
(autopilot). 0955's email tests wait on this ADR (the program's known soft
dependency).

## Context

Campaign Studio has to test pages, funnel steps, ads, emails and social posts, and
has to decide winners honestly. The app already has several experiment-like pieces
that each grew on their own surface. None of them runs a statistically valid test
under continuous monitoring, and none covers ads, email or social.

The most important defect is E-1 below: today's `significant` flag cannot safely
feed an automated promotion (ADR 0950).

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless they start with `docs/`.

**One bucketing primitive exists and every consumer already uses it.**

- `host/variantAssignment.ts:35-37` `bucketOf(unitId, scopeId, salt)` → 0..9999;
  `:46-63` `assignWeightedVariant`; pure, no clock, no randomness (`:7-9`). The
  toggle engine re-exports it (`host/featureToggles/bucketing.ts:12-14`).
- The shared honesty floor and test live here too: `MIN_SESSIONS_PER_VARIANT = 30`
  (`:66`), `Z_95` (`:68`), `twoProportionZ` (`:74-80`).

**Settled: the CDP journey split DOES use the shared primitive, but has no experiment
record.** `features/campaign-journeys/surface.ts:17-21` `holdoutArm` calls
`bucketOf(contactId, experimentId || 'default', 'journey-holdout')`, exposed as the
`bucketHoldout` surface verb (`:51-54`). So there is no second bucketing path. But
the `experimentId` is a free string from node args: no store, no salt per
experiment (the salt is the constant `'journey-holdout'`, so two journeys with the
same id string are correlated), two arms only, and no results projection. It is a
split, not an experiment.

**Five experiment-shaped consumers, three models, two event sources:**

| Consumer | Model / store | Assignment | Results |
|---|---|---|---|
| CMS page A/B (ADR 0236) | `PageExperiment`, `DurableCollection('cms:pageexperiment')` (`features/cms/pageExperimentsService.ts:50-79`) | `assignWeightedVariant(visitorKey, experimentId, salt, …)` (`:405-409`), served at `features/publishing/publishingService.ts:214-216` behind `visitorAnalyticsAllowed` | read-time projection over **analytics** events (`:552-617`), server-derived stamps only (`:591-593`) |
| Funnel step A/B (ADR 0294 P4) | `StepExperiment` embedded in the `Funnel` row (`features/funnels/funnelsService.ts:54-70`) | `assignWeightedVariant(vk, 'funnel:<id>:step:<id>', salt, …)` (`:451-454`) | projection over the **CDP** event spine, last `EVENT_WINDOW = 50_000` tenant events only (`features/funnels/funnelStats.ts:56`, `:219-253`) |
| Journey holdout (ADR 0267) | none | `bucketOf` (above) | none |
| Discovery rule holdout | rule field | `bucketOf(sessionKey, ruleId, HOLDOUT_SALT)` (`features/discovery/discoveryService.ts:285`) | none |
| Recommendation placement holdout | placement field | `bucketOf(sessionKey, placementId, HOLDOUT_SALT)` (`features/recommendations/recommendationsService.ts:355`) | none |

Defects found while auditing (recorded, fixed by this ADR's phases):

- **E-1 peeking.** Both result projections compute `significant` with a fixed-horizon
  z-test on every read (`pageExperimentsService.ts:602-612`,
  `funnelStats.ts:242-249`). No horizon, no sequential correction, no FDR across arms.
- **E-2 silent truncation.** Funnel step results read only the newest 50,000 CDP
  events for the whole tenant (`funnelStats.ts:226`). A busy tenant's older exposures
  fall out of the window and the verdict changes with no flag.
- **E-3 duplicated projection.** `funnelStats.ts:236-253` is a copy of
  `pageExperimentsService.ts:595-617`. One z-test was extracted (ADR 0294 P4); the
  projection around it was not.
- **E-4 no SRM check.** No surface tests whether observed allocation matches the
  configured weights, so a broken redirect or bot filter can corrupt a verdict.

**Other seams this composes (verified):**

- Run-start freeze: `host/runStartContext.ts:62-70` (ADR 0099); contributors are
  pure and contribute nothing when `derivedFromRun` is set (`:21-47`).
- Feature-variant stamps are a different concept: `run.metadata.featureVariant`
  (FEATURES.md "Replay-safe variant stamps"; ADR 0001). Experiments get their own key
  and never overload it.
- Ingest-side stamp seam: `features/analytics/experimentStampResolver.ts:32-61`. cms
  registers the resolver (`pageExperimentsService.ts:650-657`); analytics never
  imports cms.
- Analytics already defers experiments to their owner
  (`features/analytics/analyticsService.ts:2-4`); this ADR keeps that split.
- Audit: `pageExperimentsService.ts:90-102` `recordExperimentAction`; hash chain
  `host/auditChainService.ts:188` `appendAudit`.
- No bandit, CUPED, SRM or sequential code exists anywhere in `features/`, `host/` or
  `executor/` (grep, 2026-10-19). Ads have copy variants only
  (`host/adsAdapter.ts:78-83`); email has generated subject-line variants only
  (`features/email/surface.ts:21`). Neither can run a test.

## Decision

### D1 — One experiment model, owned by a core seam, surfaced by a feature

- **`host/experiments/`** (core, imported by features, never the reverse) owns the
  model, the store, assignment, allocation epochs and the statistics. It extends
  `host/variantAssignment.ts`; it does not add a second hash.
- **`features/experiments/`** (new feature package) owns the routes, the UI, the node
  pack, the Optimize scheduler chain and the agent tools.
- **Surface adapters** register into `host/experiments/adapters.ts`:
  `registerExperimentSurface(kind, adapter)`. cms registers `cms.page`, funnels
  `funnel.step`, campaign-journeys `journey.split`, email (ADR 0955)
  `email.campaign`, campaign-connectors (ADR 0952) `ad.set`, social (ADR 0953)
  `social.post`. The adapter resolves an arm reference to content, reports exposure
  and outcome counts for an arm, and applies a ramp or promotion (ADR 0950). This is
  the `experimentStampResolver` registry pattern, generalised. No feature imports
  another feature.

```ts
// host/experiments/types.ts
type ExperimentMode = 'decide' | 'optimize';
type ExperimentStatus = 'proposed' | 'draft' | 'running' | 'stopped'
  | 'concluded' | 'promoting' | 'promoted' | 'rolled_back' | 'abandoned';
type UnitKind = 'visitor' | 'contact' | 'platform' | 'geo';
interface Experiment {
  experimentId: string; tenantId: string; orgId: string;   // org = client (ADR 0921)
  campaignId?: string;                                      // MarketingCampaign.id (ADR 0941)
  variantSetId?: string;                                    // ADR 0946
  name: string; hypothesis: string;
  surface: { kind: string; ref: string };                   // e.g. {kind:'cms.page', ref: pageId}
  unit: UnitKind;
  design: { type: 'ab' | 'abn' | 'mvt'; factors?: Factor[] };
  arms: Arm[];                                              // [0] is the control
  mode: ExperimentMode;
  status: ExperimentStatus;
  salt: string;                                             // fixed at creation
  plan?: PreRegistration;                                   // required for 'decide' before launch
  optimize?: { rewardMetric: MetricRef; floorPct: number; epochMinutes: number };
  epochs: AllocationEpoch[];                                // append-only
  createdBy: string; createdAt: string; updatedAt: string;
}
interface Arm { key: string; ref: string | null; weight: number } // null = holdout/live content
interface Factor { factorId: string; levels: { key: string; ref: string }[] }
interface AllocationEpoch { epoch: number; weights: Record<string, number>; at: string;
  reason: 'launch' | 'optimize' | 'ramp' | 'rollback'; decidedByRunId?: string }
interface PreRegistration {
  primaryMetric: MetricRef; guardrails: { metric: MetricRef; direction: 'up_is_bad' | 'down_is_bad'; niMargin: number }[];
  mde: number; alpha: number; power: number; fdrQ: number;
  minDays: number;          // >= 7, enforced
  minSamplePerArm: number;  // derived from MDE/power at lock time
  maxDays: number;
  cuped?: { covariate: MetricRef };
  lockedAt: string; planHash: string;  // sha256 of the canonicalized plan
}
```

Store: `DurableCollection('experiments:experiment')` keyed
`tenant::orgId::experimentId`, with a tenant index (the GOV-1 pattern). A by-id read
compares `row.orgId` to the path org first and returns the same 404 as a missing row
(ADR 0921 D3).

### D2 — Two modes, kept distinct in the model, the API and the UI

**Decide** answers "is B better than A?" and is the only mode that can feed a
promotion.

- **Pre-registration is mandatory and locks at launch.** `launch` refuses a `decide`
  experiment without a complete plan, computes `minSamplePerArm` from MDE, alpha and
  power, sets `minDays = max(7, requested)`, and stores `planHash`. After launch every
  plan field is immutable: an edit returns 409 `plan_locked`. The only verbs left are
  `stop` and `abandon`. A stopped Decide test reports its state, but it cannot be
  promoted by ADR 0950.
- **Fixed allocation.** One `launch` epoch. Only ADR 0950's ramp may add epochs, and
  only after a verdict.
- **Always-valid sequential inference.** A mixture sequential probability ratio test
  (mSPRT) on the difference of means or proportions gives always-valid p-values and
  confidence sequences, so the dashboard can be read at any time without inflating
  error. Benjamini–Hochberg at `fdrQ` across (treatment arms × primary metric).
  Guardrails are one-sided non-inferiority tests at their margin.
- **CUPED** when the plan names a pre-period covariate and coverage is high enough
  (default ≥ 50% of units have it). Coverage is reported. CUPED is skipped with a
  stated reason, never silently.
- **SRM.** A chi-square test of observed against configured allocation on every
  computation. At p < 0.001 the verdict is `srm_halt`: results are withheld, the run
  is flagged, and the owner is notified. A halted test cannot be promoted.
- **Verdict is a closed enum:** `insufficient_data | running | srm_halt |
  winner(arm) | no_difference | guardrail_breach(metric) | inconclusive_at_max`.
  "Significant" is never shown before `minDays` and `minSamplePerArm` are both met.

**Optimize** answers "send more traffic to what is working now" and never claims a
winner.

- Thompson sampling: Beta–Bernoulli for conversion rewards, Normal–Gamma for revenue
  per unit. Each arm keeps `floorPct` (default 5%, minimum 1%) so no arm starves and
  the posterior keeps learning.
- An epoch update is a deterministic computation. The Monte Carlo draws use a seeded
  PRNG (`seed = hashString(experimentId + ':' + epoch)`), so the same inputs give the
  same weights on replay.
- The UI and API show "probability best" and "expected loss" (labelled a model
  estimate), never a p-value or a `significant` field.
- To be promoted, an Optimize result must graduate to a confirmatory Decide test
  (open question Q3).

**MVT.** `design.type = 'mvt'` is full-factorial over at most 4 factors and 16 cells.
Each factor is bucketed independently with salt `${salt}:${factorId}`, so the
factors are orthogonal by construction. Analysis reports main effects, plus an
interaction flag when a factor's effect differs across another factor's levels
beyond the FDR threshold. At lock time, if `minSamplePerArm × cells` exceeds 4× the
trailing 28-day traffic, launch returns `underpowered` (overridable, recorded).

### D3 — Assignment: one function, frozen for runs, stamped for events

- **Web units (`visitor`)** are assigned on the page read, as today
  (`publishingService.ts:214`), by `assignArm(experiment, unitKey)` in
  `host/experiments/assign.ts`. In Decide mode that is `assignWeightedVariant` on the
  launch epoch, the same call `pageExperimentsService.ts:406` makes. **Decide needs no
  assignment store.**
- **Optimize stickiness.** Weights change between epochs, so pure hashing would move
  a returning visitor between arms. Optimize stores a first-exposure row
  `experiments:first-exposure` keyed `experimentId::sha256(unitKey)`, holding only
  the arm and epoch, with a TTL equal to the experiment horizon. Age-out uses the
  ADR 0380 `registerKvAgeOut` seam, and the row count is capped per experiment
  (default 200k; past the cap, assignment becomes per-session and this is reported).
- **Run-based units (`contact`, `platform`, `geo`).** An email send, a journey, an
  ad launch or a promotion is a run. A run-start contributor
  (`registerRunStartContributor`, ADR 0099) stamps
  `run.metadata['openwop-app.experiments'] = { [experimentId]: { planHash, epoch,
  weights, mode } }` for every experiment the run's inputs reference. The contributor
  is pure and returns nothing when `derivedFromRun` is set, so a `:fork` reuses the
  source's epoch even after the bandit has moved on. A contact's arm is
  `assignWeightedVariant(contactId, experimentId, salt, frozenWeights)`. That is the
  journey `holdoutArm` call, now with a real record and a per-experiment salt.
- **`platform` units (ads)** cannot be randomized per person by us. An ad experiment
  either delegates randomization to the platform's split-test API (Meta Experiments,
  Google Ads experiments), recorded as `unit:'platform'` with imported results, or runs
  as Optimize over budget share across ad sets through ADR 0952's governed budget
  action. The UI says which one it is. A platform split is never presented as our own
  randomized test.
- **Exposure stamps** keep the ADR 0651 rule (server re-derives, client claim never
  counted); the stamp resolver delegates by `surface.kind`.

### D4 — Statistics are a deterministic service; the CRO agent narrates

- `host/experiments/stats.ts` is pure: counts in, verdict out, no I/O. It holds mSPRT,
  BH-FDR, CUPED, SRM, the power/MDE solver and the Thompson update, with golden-file
  tests against published reference values. `twoProportionZ` stays for the legacy
  read until P2.
- **Daily rollup cells** `experiments:daily` (experiment × arm × day × metric:
  `n, sum, sumSq, covSum, covSumSq, crossSum`) are a derived cache, rebuilt by the
  `funnelStats.ts` sweep pattern. Rebuilding is idempotent. This fixes E-2: every cell
  records the event-source coverage, and a truncated source turns the verdict into
  `insufficient_data`, never a guess.
- The **CRO Analyst** agent (roster owned by ADR 0943) reads the result through the
  `experiments.get-results` tool, which returns the verdict, the numbers and
  `computedAt`. It writes the narrative, the next hypothesis and the risk notes. It
  never computes a statistic, and its prompt is pinned to the result schema by
  `promptCatalogParity.test.ts`. A narrative that cites a number the tool did not
  return fails the eval (ADR 0889).

> **P0 as built (2026-10-20), with the references the statistics were checked against.**
> `host/experiments/stats.ts` is pure (no I/O, no clock, no randomness) and every
> routine has a golden test (`test/adr0949-experiment-stats.test.ts`):
> - **mSPRT** — Johari, Pekelis & Walsh, *Always Valid Inference: Bringing
>   Sequential Analysis to A/B Testing* (arXiv:1512.04922; Operations Research
>   70(3), 2022). The two-stream CLT form of Appendix E: V̂ₙ from eq. (30), Λ̃ₙ from
>   eq. (37). With H = N(0, τ²) the integral is closed-form,
>   Λ̃ = √(V/(V+τ²))·exp(δ²τ²/(2V(V+τ²))), and inverting Λ̃ ≥ 1/α gives the
>   confidence-sequence half-width √(V(V+τ²)/τ² · (ln((V+τ²)/V) − 2 ln α)).
>   `pValue` is min(1, 1/Λ̃) at one look; the monotone always-valid p-value of
>   Proposition 1 is the running minimum across looks (`alwaysValidPValue`), which
>   needs the look history that P1's daily rollup provides. τ² defaults to MDE²
>   (prior matching, the paper's Prop. 5 and Table 1 robustness result).
> - **BH** — Benjamini & Hochberg (1995), JRSS-B 57(1):289–300; the paper's §4
>   example (15 p-values, q = 0.05 → 4 rejections, Bonferroni 3) is a golden case.
> - **SRM** — Pearson χ² goodness of fit against the configured weights, k − 1 df,
>   alarm at p < 0.001.
> - **CUPED** — Deng, Xu, Kohavi & Walker, *Improving the Sensitivity of Online
>   Controlled Experiments by Utilizing Pre-Experiment Data*, WSDM 2013: θ =
>   cov(Y, X)/var(X) (eq. 4), var reduction factor 1 − ρ² (eq. 5), the eq. (7)
>   difference estimator. θ is pooled over within-arm (co)variances, so a
>   treatment effect on Y's mean cannot leak into θ.
> - **Power** — the Fleiss pooled-null two-proportion sample size without
>   continuity correction (0.10 → 0.12, α 0.05, power 0.8 → 3,841 per arm), with an
>   MDE solver that inverts it.
> - **Special functions** are implemented in the module (Wichura AS 241 for Φ⁻¹;
>   Φ and χ² survival through the regularized incomplete gamma): the backend has
>   no numerical library, and four functions do not justify one.
>
> **Legacy honesty (E-1, E-4).** `host/experiments/legacyHealth.ts` adds a `health`
> block to both legacy projections (CMS page experiments and funnel step
> experiments): an SRM check and the standing notice `fixed_horizon_do_not_stop_early`.
> On an SRM mismatch every variant's `significant` is **withheld** (null, with
> `significanceWithheld: 'srm'`). No toggle: the only reader of `significant` is
> the UI (verified), and a broken split must not read as a winner. The funnel's SRM
> runs over the same 50,000-event window (E-2 stays for P1). Both UIs show the SRM
> warning and the stop-early note in four locales.

### D5 — Migration: the existing surfaces become adapters, not a second model

- `cms:pageexperiment` rows migrate into `experiments:experiment` with
  `surface.kind = 'cms.page'`, `mode = 'decide'`, no plan (`legacy: true`), and the
  same id and salt. A legacy experiment keeps assigning byte-identically and keeps its
  manual promote. It cannot enter ADR 0950 until it is relaunched with a plan. The CMS
  routes (`pageExperimentsRoutes.ts`) stay as aliases.
- Funnel `StepExperiment` moves the same way (`funnel.step`). The `Funnel` row keeps
  `experimentId` only. `funnelStats.stepExperimentResults` is deleted in favour of the
  engine's projection (fixes E-3).
- The journey `bucketHoldout` verb requires a real `experimentId` once
  `experiments` is ON. Off, the old string path is kept for existing chains.
- Discovery and recommendation holdouts stay as they are (permanent ranking-rule
  holdouts, not experiments). Recorded non-goal.

> **Correction 2026-10-20 (P1 architect review) — "rows migrate" is an
> expand/contract, not a move, and P1 is two PRs.**
>
> 1. **Expand/contract.** Moving a row (insert into the engine, delete the legacy
>    row) makes a deploy rollback lose every experiment: the previous image reads
>    only `cms:pageexperiment`. So in P1 the engine row is the record and
>    `cms:pageexperiment` is kept as a **rollback mirror**: every write goes to the
>    engine first, then to the mirror (best effort, logged on failure); a delete and
>    a subject erasure remove or anonymize both. The contract step (stop mirroring,
>    drop the legacy collection) moves to P2, after a release has served from the
>    engine. **Known rollback limit:** rows the old image writes during a rollback
>    land only in the mirror, and the per-org migration marker (below) stops a
>    re-scan when the new image returns. A roll-forward after a rollback must clear
>    the `experiments:legacy-migration` markers so each org re-imports (rows already
>    in the engine are kept: the import is insert-if-absent).
> 2. **Lazy per-org migration with a marker.** The legacy collection has no tenant
>    index, so the import is one full scan per (tenant, org), on that org's first
>    experiment read, ending with a durable marker in `experiments:legacy-migration`.
>    After it, the serving path (`findRunningExperiment`, run on every published-page
>    read) is an org-prefix read. Before P1 it was an unscoped full scan of every
>    tenant's experiments on each page read; that scan is gone (pinned by a spy).
> 3. **P1 splits into P1a and P1b.** Each migration rewrites a live serving path, so
>    each is its own PR: **P1a** is the model, the store, `assignArm` and the CMS
>    migration; **P1b** is the funnel migration
>    (`assignmentScope = funnel:<id>:step:<id>` keeps its hash input), the daily
>    rollup (E-2) and the shared projection (E-3).
> 4. **The `experiments` toggle and feature package move to P2.** P1a adds no route,
>    tool or screen, so a toggle would gate nothing. It lands with the first surface.
> 5. **The surface-adapter registry lands with its first caller.** In P1a nothing
>    would call it (the CMS service maps its own rows), so shipping the registry
>    would be a seam with no user. It arrives with the P1b rollup, which counts
>    through it.

> **Correction 2026-10-20 (P1b, architect review + build) — how the funnel
> migration, the rollup and coverage actually work.**
>
> 1. **Funnel steps: expand/contract, with the funnel row as the pointer.** The
>    engine row (`surface.kind = 'funnel.step'`, `ref = <funnelId>:<stepId>`,
>    `assignmentScope = funnel:<funnelId>:step:<stepId>`) is the record; the
>    step's embedded `experiment` stays as the rollback mirror and says which
>    experiment is on which step. No migration marker is needed: the serving path
>    already holds the funnel row, so a step with no engine row is imported on its
>    first read (insert-if-absent). A stop the previous image wrote only to the
>    mirror converges the engine to `stopped` on read. Convergence only runs toward
>    stopped, the safe direction. A replaced split, a step removed by an edit, and
>    a deleted funnel delete the engine row and its rollup (the legacy model lost a
>    replaced split's data too; an engine row nothing points at is an orphan).
>    A step split records no actor, so `createdBy` is `system`.
> 2. **Rollup cells are cohort cells.** A unit's cell is its arm and its FIRST
>    exposure day, so summing `n` over days counts each visitor once. A conversion
>    is counted only for an exposed unit. The legacy projection counted a stamped
>    completion with no stamped view, which could report more conversions than
>    sessions. The rollup is rebuilt by the existing funnel stats sweep and by the
>    results read (idempotent; it deletes the cells it no longer produces).
> 3. **E-2: the 50,000-event window was a slice, not an I/O bound.**
>    `listCollectedEvents` already loads the tenant's whole index, so the rollup
>    now reads every retained event at no extra I/O. (The funnel day stats keep
>    their disclosed window; that is not an experiment read.)
> 4. **Coverage is a retention watermark.** The CDP retention purger records the
>    cutoff (`cdp:retention-watermark`) whenever it deletes events. A rollup whose
>    experiment began before that cutoff is `partial`, and the projection withholds
>    every verdict (`significanceWithheld: 'coverage'`, with a UI notice). A subject
>    erasure is not recorded: it removes one person's events, not a time range.
>
>    Recovery correction (2026-10-24): commit the cutoff by monotonic CAS inside
>    the delete callback, before deleting any event. A committed delete followed
>    by a lost acknowledgement must still report partial coverage after restart.
>    A failed barrier retains the event; a failed delete can conservatively leave
>    partial coverage. Count-only sweeps call no delete callback and change no
>    watermark. SQLite fault/interleaving witnesses are authored in
>    `adr0949-retention-coverage-fence.test.ts`; recovery execution is pending.
> 5. **E-3: one projection.** `host/experiments/legacyProjection.ts` holds the
>    z-test, the sample floor and the SRM/coverage withholding; the CMS and funnel
>    results both call it.

> **Correction 2026-10-20 (P2 architect review + build) — P2 is three PRs, and
> what Decide mode does and does not do yet.**
>
> 1. **P2a / P2b / P2c.** P2a is the backend: the `experiments` feature and
>    toggle, the surface adapter registry with the `cms.page` and `funnel.step`
>    adapters, Decide mode (plan, lock, launch, stop, abandon, verdict) and its
>    routes. P2b is `ctx.features.experiments`, the node pack and the UI. **P2c
>    is the contract step** (stop mirroring to `cms:pageexperiment` and the
>    embedded step copy, drop the legacy collection). It is **deploy-gated**:
>    it must not merge until P1a and P1b have been deployed and have served in
>    production, because contracting in the same deploy as the expand removes
>    the rollback target (team-lead, 2026-10-20).
> 2. **The plan carries `baselineRate`.** A two-proportion sample size needs the
>    control rate as well as the lift; D1's `PreRegistration` omitted it. `mde` is
>    an absolute lift on it. A draft keeps an unlocked `planDraft`; `plan` exists
>    only once locked.
> 3. **Guardrails are refused at lock** (`unsupported_metric`), not ignored: no
>    surface reports a second metric per unit yet, so a guardrail could never be
>    evaluated, and an accepted-but-unchecked guardrail would be a false promise.
>    `guardrail_breach` stays in the enum for the surface that first counts one.
> 4. **The adapter owns the surface's launch.** A `cms.page` launch runs through
>    the CMS start (its per-page lock, the one-running-per-page rule, the review
>    stamp and the publish blockers); a `funnel.step` launch writes the step
>    pointer the public read follows. The CMS and funnel routes refuse to edit,
>    start, stop, delete or promote an experiment this feature manages (409
>    `managed_by_experiments`), and their write paths merge only the lifecycle
>    fields onto a managed row, so no legacy path can strip a locked plan.
> 5. **Verdict as built.** Per treatment arm, the mSPRT confidence sequence and
>    per-look p-value (τ² = MDE²) against the control; BH at `fdrQ` across arms.
>    The call waits for `minDays` and `minSamplePerArm`; before them a running
>    test reads `running`. `winner` is the best arm whose lift is rejected
>    positive (or the control when every treatment is rejected negative);
>    `no_difference` when every confidence sequence sits inside ±MDE. The
>    monotone running-minimum p-value needs a stored look history and is not kept
>    yet: the p shown is the current look's, labelled as such.
> 6. **The ADR 0942 launch gate is not on main yet.** Launch is gated by
>    `workspace:write` and the surface's own start checks; the 0942 outcome check
>    goes into `launch` when that ADR lands.
> 7. **`analytics` is recommended, not `dependsOn`.** Planning row 2 said
>    `dependsOn: ['analytics']`, but `dependsOn` is a disable-lock that the
>    feature-dependency ratchet ties to a real import, and this package imports
>    no analytics code (the CMS adapter does). Funnel step experiments need no
>    analytics at all. So `analytics` is `recommends`, and the page results
>    route checks it per read (next item).
> 8. **Page results need `analytics`.** A `cms.page` experiment's result is a
>    projection over analytics events, so its results route applies the same
>    ADR 0820 §7 access check as the CMS results. The analytics retention purger
>    now records a watermark, like the CDP one.

> **Correction 2026-10-20 (P2b build) — the surface, the pack and the page.**
>
> 1. **No launch from a run yet.** Planning rows 3 and 4 put `launch` on
>    `ctx.features.experiments` and in the node pack. A launch changes what the
>    public sees, and the rule for when an agent may do that is ADR 0942's, which
>    is not on main. A launch node that always failed would be a dishonest node,
>    so P2b ships none: the surface offers list, get, results, power-calc,
>    create-draft, update-draft, lock-plan and stop (stop only reduces
>    exposure), and launch is a human act on the Experiments page until the 0942
>    gate lands. `optimize-epoch` and `split` are P3/P4.
> 2. **The surface's org floor is the route's.** Every op runs
>    `assertRunScopeOrg` (the run's actor, else the member who caused an
>    actorless run) at `workspace:read` or `workspace:write`. The run-tag client
>    check of ADR 0941 D2b is added when ADR 0941 merges. The surface never
>    returns the assignment salt or the tenant.
> 3. **The page lives at `/experiments`** (Marketing nav), not as a
>    `/campaign-studio/experiments` hub tab: the hub's route reorganisation is
>    ADR 0941 P3, not yet merged. The tab links here once it lands. Decide
>    vocabulary only: a verdict, an always-valid "plausible range" per arm, and
>    the gates; the page never shows a "significant" flag (pinned by a test).

> **Correction 2026-10-20 (P3 architect review + build) — run-based units, as
> built, and the P3 split.**
>
> 1. **One frozen instant, not a per-experiment map.** D3 had the run-start
>    contributor freeze `{planHash, epoch, weights}` for "every experiment the
>    run's inputs reference". A contributor sees no run inputs (ADR 0099), so it
>    cannot know which experiments a run will use. It freezes one instant
>    instead: `run.metadata['openwop-app.experiments'] = { asOf }`. Epochs are
>    append-only and carry their `at`, so the instant fixes every experiment's
>    weights exactly; planHash is immutable once locked. It costs no store read at
>    run start. The key is reserved (a caller cannot set it), the contributor
>    stamps only for a tenant with `experiments` on, and it contributes nothing
>    to a derived run (ADR 0604): a fork keeps the source's instant, and a run
>    born OFF stays unstamped when forked after the toggle turns ON.
> 2. **Assignment for contacts.** `ctx.features.experiments.assign` and the
>    `feature.experiments.nodes.split` node (pack 1.1.0, role action, the arm in
>    the node output) give `assignWeightedVariant(unitKey, scope, salt, weights of
>    the epoch in effect at asOf)`. Only a running experiment assigns.
> 3. **Guardrails are supported where a surface counts them.** A unit observation
>    carries binary guardrail outcomes (`metrics`), an adapter declares
>    `supportedMetrics`, and lock refuses a guardrail on any other metric
>    (`unsupported_metric`). A breach is called when the always-valid confidence
>    sequence for (treatment − control) lies wholly beyond the margin in the bad
>    direction. It is checked at every look, before the gates. CMS pages and
>    funnel steps report no guardrail metric yet.
> 4. **P3a / P3b.** P3a is the shared core above. P3b registers the `journey.split`
>    and `email.campaign` adapters and moves the journey `bucketHoldout` onto
>    engine experiments. It is coordinated with ADR 0955 P3b (build-0905-email),
>    which owns campaign-journeys and email.

> **Correction 2026-10-20 (P3b build) — the shapes agreed with ADR 0955 P3b
> (build-0905-email), pinned.**
>
> 1. **`email.campaign`** (built by ADR 0955 P3b): `ref` is the EMAIL CAMPAIGN id
>    (it owns the approval pin, the send ledger and the batch resume); the arms
>    are the pinned variant ids. Its `validateTarget` refuses a campaign of
>    another tenant or org, one already sending, and arms that are not exactly
>    the pinned variant ids. Primary metric: a CLICK per contact (opens never;
>    Apple MPP inflates them). Exposure is the contact's first `sent` row for
>    the campaign. Guardrails: `unsubscribe`, `complaint`, and `hard_bounce`.
> 2. **Outside a run** (a broadcast sends in passes, across a batch resume and
>    warm-up days): `assignContactArm(tenantId, { orgId, experimentId,
>    contactId, epoch? })` in `host/experiments/contactAssign.ts`. Pure: no
>    write, no clock, no status check; the caller freezes `epoch` (at approval)
>    and passes it on every pass, so a re-run pass derives the same arm even
>    after a re-weight or a stop. Without `epoch`, the launch epoch. `status` is
>    returned so the caller decides whether to send. Inside a run,
>    `ctx.features.experiments.assign` stays the API (the run's frozen instant).
> 3. **`journey.split`** (this phase): `ref` is the journey id; exactly two arms,
>    control then treatment, referencing no content; contact units (an adapter
>    now declares its `unit`); one running split per journey. The journey
>    `bucketHoldout` verb assigns through the engine for an `exp:` id with
>    Experiments ON (D5), at the run's frozen instant, and needs `orgId` (the
>    ADR 0832 floor checks the run's person against it); every other id keeps the
>    string-salted holdout byte-identical. An unstamped run is not in the test
>    (control, `assigned: false`). `observe` re-derives each enrolled contact's
>    arm from its run's stamp rather than recording an exposure, so the split
>    stays a read: conversion is a click after enrollment; guardrails are
>    unsubscribe (engagement), complaint and hard bounce (suppression rows by the
>    contact's address). **`sms_opt_out` is not reported:** no SMS STOP record
>    exists on this host yet; it joins `supportedMetrics` when one does.
> 4. **Packs:** `feature.campaign-journeys.nodes` 1.9.0 (1.4.0 in the 2026-10-20 build; main had moved to 1.8.0 by the merge): the `split` node takes
>    `orgId` and its role is now `read` (it reads the experiment and the run's
>    stamp; it was `pure`).

> **Correction 2026-10-20 (P4 architect review + build) — Optimize, as built.**
>
> 1. **Thompson sampling is seeded and floored.** Beta(1 + successes, 1 +
>    failures) per arm, 10,000 draws from mulberry32 seeded by
>    `hashString(experimentId:epoch)`, Gamma variates by Marsaglia & Tsang. Each
>    arm gets `floorPct` first; the rest is shared by probability-best and
>    rounded to whole percents summing to 100 (largest remainder). The same
>    counts and seed give the same weights on replay (the P4 exit).
> 2. **An epoch's number comes from the run's frozen instant.** N = the epoch in
>    effect at `asOf`, plus one. A fork keeps `asOf`, recomputes the same N, finds
>    it appended and returns `existing`, so it never re-allocates. The new
>    epoch's `at` is the append instant and never earlier than `asOf` + 1 ms, so
>    no run that began before it is re-numbered on its own fork. A run that comes
>    before `epochMinutes` returns `too_soon` and changes nothing; it is an
>    answer, not an error, so a frequent schedule does not fail.
> 3. **The first-exposure store has no counter on the hot path.** D3's
>    per-experiment cap was a counter; on the public page read it would be one hot
>    row incremented by every new visitor. The epoch job counts the rows instead
>    and sets `stickinessCapped` on the experiment; serving reads the flag from the
>    row it already loaded. Past the cap, new units are hashed at the current
>    epoch and results say so. The key is `tenant::experiment::sha256(salt +
>    unitKey)` with no tenant index; rows age out after 180 days, go with their
>    experiment, and are erased per subject (`eraseExperimentFirstExposures`:
>    a unit key is a subject key, so the row is recomputed and deleted).
> 4. **Read-only for the stamp resolver.** The analytics ingest re-derives the
>    served arm from the store and never writes. A recorded exposure answers
>    before the running check, so a stopped experiment's arm is still
>    attributed. A visitor past the cap whose beacon arrives after an epoch
>    change may be attributed to the newer epoch's arm: a documented window.
> 5. **Optimize results are a model estimate.** Probability best, expected loss
>    and the current weights, never a verdict, a p-value or a confidence
>    sequence. Optimize has no plan (`lock` is 409 `not_decide`) and feeds no
>    promotion.
> 6. **The loop is a chain pack.** `core.openwop.workflows.experiments` holds
>    `experiments.optimize-loop`, one `optimize-epoch` node. The operator
>    schedules it with the existing scheduler. It only reallocates an experiment
>    a human launched.
> 7. **P4a / P4b.** P4a is the backend above; P4b is the Optimize screens.






> **Correction 2026-10-26 (P2c rebuild) — the contract step is split in two,
> because the first build was a one-way door for the rollback target.** The
> 2026-10-20 build (#5102, superseded) stored the funnel step POINTER in the same
> deploy that contracted the CMS mirror. Measured on the code production runs
> (P2b and later, `6e1b8df18`): its public serve resolves a step through the
> engine, so a pointer serves; but its `getFunnel`/`listFunnels` return the
> stored row as is, so a rolled-back image would hand the API and the SPA a
> `{ experimentId }` stub with no status or variants. And its
> `resolveStepExperiment`, given a pointer whose engine row is missing, mints an
> engine row with no salt and no arms. So:
>
> 1. **A1 (this rebuild).** CMS: nothing writes `cms:pageexperiment`, and the
>    boot sweep `contractLegacyCmsExperiments` imports never-read orgs' rows and
>    deletes every row, never re-importing an org that has its marker (that
>    would resurrect a deleted experiment). Rolling back is safe: the target
>    reads the engine. Funnels: every read hydrates the step from the engine
>    (`getFunnel`, `listFunnels`, `getPublishedFunnelBySlug`), a pointer the
>    engine does not hold is dropped and never minted, and every write still
>    stores the FULL copy, which is what the rollback target reads. Writes
>    compare against the stored row, not the hydrated read.
> 2. **A2 (after A1 has served at least one deploy).** Funnel writes store the
>    pointer only. Rolling back from A2 to A1 is safe, because A1 hydrates and
>    its next write restores the full copy.
>
>    **Implemented 2026-10-26, after A1 went live** (deploy 100, `7412be26b`),
>    narrower than planned. Every funnel write (`casFunnel`, and the promotion
>    receipt CAS) goes through `dehydrate`, which stores the pointer **only for
>    a legacy step split, running or stopped, that the engine holds for this
>    step** (`storesAsPointer`). Anything else keeps the full copy.
>
>    *Why narrower (code review, 2026-10-26):* A1, the rollback floor, reads a
>    pointer only through `resolveStepExperiment`, which answers for running
>    and stopped experiments. A managed (Decide/Optimize) experiment can be
>    concluded, ramped into `promoting`, promoted or abandoned with no funnel
>    write. Rolled back to A1, its pointer would hydrate to nothing: the
>    promotion's `restoreBaseline` would refuse with `promotion_target_changed`
>    on every retry, leaving the winner page live, and the next funnel write on
>    A1 would drop the link for good. A legacy split cannot move without a
>    funnel write (the engine refuses legacy rows), so A1 always reads its
>    pointer.
>
>    *Read side, also A2:* `hydrate` now prefers the engine's view
>    (`linkedStepExperiment`) over a stored copy. A step stays linked to an
>    experiment the engine has ended, shown as stopped, and a copy that still
>    says `running` for an ended experiment no longer blocks a new split on the
>    step (`managed_by_experiments`).
>
>    **The rollback floor is A1** for every row A2 writes. A revision older than
>    A1 would read the stored pointer as the experiment.
>    Re-measured read-only after A1 went live: `funnels:funnel` 0 rows, engine
>    experiments 0, `cms:pageexperiment` 0, markers 0 (floor: `cms:page` 14 of
>    322,569 kv rows), so A2's first deploy rewrites nothing in production.
> 3. **A3 (after A2 has served at least one deploy).** Managed experiments store
>    the pointer too. A2's `linkedStepExperiment` is then the floor, and it
>    hydrates a pointer to an ended experiment.
>
>    **Implemented 2026-10-26, after A2 served.** A2 went live as `639a96514`
>    (rev `01053-jcf`), and a later deploy (`e79425222`, rev `01054-xbz`)
>    superseded it with no rollback. `storesAsPointer` is now exactly
>    "`linkedStepExperiment` answers for this step". So a launched managed
>    experiment stores the pointer, and so does every status it can reach
>    without a funnel write (concluded, promoting, promoted, rolled back,
>    abandoned: shown stopped). A `proposed` or `draft` experiment, or one held
>    for another step, keeps the copy. Nothing returns an experiment to those
>    statuses, and only a never-launched draft is deleted.
>
>    *Why this is safe:* every read hydrates and prefers `linkedStepExperiment`
>    over a stored copy (A2), so the pointer loses nothing a reader sees, and
>    A2 hydrates it the same way. **The rollback floor is A2** for every row A3
>    writes. A1 would drop a pointer to an ended managed experiment.
>
>    *Found while building A3: an A2 regression, fixed here.*
>    - The funnel approval lane's publish (`publishFunnel` with `expectedDigest`
>      or `requirePublishedPages`) compared and swapped the HYDRATED read against
>      the stored row. Since A2, a step holding a pointer made that compare fail,
>      so `publishFunnelAsApproved` refused every such funnel with
>      `409 stale_review`. It now goes through `swapStored`.
>    - A re-delivered `createFunnel` returned the stored row, pointer and all. It
>      now hydrates, after the tenant check.
>    - Production had 0 funnels, so the regression never fired.
> 4. **Production volume, read-only on 2026-10-26:** `cms:pageexperiment` 0
>    rows, migration markers 0, engine experiments 0, `funnels:funnel` 0 (floor
>    check: `cms:page` 14 and `cms:pageversion` 78 of 322,320 kv rows). The
>    sweep's first production run touches nothing.
>
> The 2026-10-20 note's "one-way door" no longer holds for A1: an image older
> than P1a would still see no CMS experiments, but production has not run one
> since 2026-10-25.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Core seam `host/experiments/` (model, store, assign, stats, adapter registry) + feature `features/experiments/` (`routes.ts`, `feature.ts`, `surface.ts`, `agentTools.ts`). cms/funnels/journeys/email/ads/social register adapters. No feature→feature import. |
| 2 | Toggle | `experiments`, default **OFF**, `bucketUnit: 'tenant'`, `dependsOn: ['analytics']`, `recommends: ['cms', 'funnels']`, category `Marketing`, in the `marketing` bundle. Legacy CMS/funnel A/B keeps working with it OFF (D5). |
| 3 | Workflow surface | `ctx.features.experiments`: `get`, `results`, `createDraft`, `lockPlan`, `launch`, `stop`, `optimizeEpoch`, `assign` (contact/geo units). Every op takes `orgId` and checks the run tag's client (ADR 0941 D2b; the ADR 0921 D3 check). |
| 4 | Node pack | `feature.experiments.nodes`: `create-draft`, `lock-plan`, `launch` (side-effect), `results`, `optimize-epoch` (side-effect, idempotent per epoch), `split` (contact/geo arm). Chain pack `experiments.optimize-loop` (scheduled epoch update). Promotion nodes are ADR 0950. |
| 5 | Envelopes | None. Model output reaches durable state only as a draft through closed-schema validation. Launch passes the ADR 0942 gate. |
| 6 | Agent pack | No new agent. The CRO Analyst lives in ADR 0943's campaign agent pack; this ADR supplies its tools (`experiments.get-results`, `experiments.propose-draft`, `experiments.power-calc`). |
| 7 | Public surface | None new. Assignment rides the existing public page read and beacon; the stamp stays server-derived (ADR 0651). |
| 8 | RBAC | Read `workspace:read` on the client org; draft/stop `workspace:write`; `launch` also needs the ADR 0942 outcome for the surface's own class (`content.publish` for pages/funnels, `ads.launch`, `email.campaign-send`, `social.post`); no new class. Uniform 404 on wrong org. |
| 9 | Replay / fork | Run-start contributor freezes `{planHash, epoch, weights}` (D3). `launch` and `optimize-epoch` are `role:"side-effect"` nodes with idempotency keys `experimentId::launch` and `experimentId::epoch::N`; a fork never re-launches or re-allocates. |
| 10 | Frontend | `/campaign-studio/experiments` tab in the hub (ADR 0941 resolves the route collision). Separate Decide and Optimize screens with different vocabulary: a plan builder with power calc and lock confirmation; a results view with confidence sequences and an SRM banner; an Optimize view with "probability best". |

## Why this is our advantage

- **Replayable decisions.** Every verdict is computed in a run whose inputs are frozen,
  so "why did we call B?" opens the run and re-executes the stats on the same rollup
  snapshot. Optimizely, VWO and Statsig show a result. They cannot replay the
  computation that produced last Tuesday's verdict.
- **A named agent per node, narrating instead of guessing.** The CRO Analyst cannot
  invent a statistic: the stats are a deterministic node, and the agent's eval fails
  if it cites a number the tool did not return. Opal, Copilot and Evi generate ideas
  next to a stats engine they do not answer to.
- **One model across channels, isolated per client org** (ADR 0921), with one
  backlog. The point tools are per channel.
- **Honest modes.** Decide and Optimize are separate types, so a bandit can never be
  presented as a significant win. This is the design the 2026-10-19 scan recommends
  and that nobody ships whole.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `host/experiments/stats.ts` (mSPRT, BH, SRM, CUPED, power) with golden tests; SRM and peeking warnings added to the existing cms and funnel results (E-1, E-4) | Golden tests green; the legacy results show `srm` and "do not stop early" |
| P1 | Model, store, adapter registry, toggle; cms + funnel migration (D5) with byte-identical assignment witness; daily rollup (fixes E-2, E-3) | Assignment witness over 100k keys identical before and after; funnel results no longer windowed |
| P2 | Decide mode end to end: plan lock, verdict enum, routes, `ctx.features.experiments`, node pack, UI | A locked plan refuses edits (409); an SRM fixture halts |
| P3 | Run-start contributor + contact units: journey `split`, email (with ADR 0955) | A fork after an epoch change reuses the source's weights (test) |
| P4 | Optimize: Thompson epochs, first-exposure store + age-out, `experiments.optimize-loop` chain | Same inputs give the same weights on replay; floor respected |
| P5 | MVT; ad (`platform`) and social adapters with ADRs 0952/0953; CRO Analyst tools + eval | MVT orthogonality test; platform split labelled in the UI |

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | #5073 (`feat/0949-p0-experiment-stats`) | `adr0949-experiment-stats.test.ts` (15 golden cases; three sabotage witnesses), `adr0949-legacy-health.test.ts`, SRM route cases in `cms-page-experiments.test.ts` + `funnels-phase4.test.ts`; FE `pageExperimentsHealth.test.tsx`, `funnels/__tests__/experimentHealth.test.tsx` (sabotage-witnessed) |
| P1a | #5079 (`feat/0949-p1a-experiment-store`, stacked on #5073) | `adr0949-p1a-experiment-store.test.ts`: assignment identical to the pre-engine formula over 100,002 keys and three arm layouts; mapping round-trip; lazy per-org migration with no scan after the marker (spy); rollback mirror on write and delete; erasure of engine and mirror. Four sabotage witnesses (hash scope, marker, mirror write, engine erasure), each red. The CMS suites pass unchanged |
| P1b | #5085 (`feat/0949-p1b-funnel-experiments`, stacked on #5079) | `adr0949-p1b-funnel-experiments.test.ts`: assignment identical over 100,000 keys; engine record + mirror; cascades on a replaced split, a removed step and a deleted funnel; import on first serve and mirror-stop convergence; an exposure older than the newest 50,000 events still counts; a retention purge withholds the verdict. Four sabotage witnesses (old window, coverage check, convergence, cascade), each red. `adr0949-legacy-health.test.ts` now runs on real storage; FE `experimentHealth.test.tsx` coverage case (sabotage-witnessed) |
| P2a | branch `feat/0949-p2a-decide-engine` (stacked on #5085) | `adr0949-p2a-decide.test.ts` (route-level): toggle + org scope + closed-world drafts; lock derives 3,841 per arm and the plan hash, then every edit is 409 `plan_locked`; launch through the CMS start, idempotent; CMS legacy verbs refuse a managed experiment; an SRM fixture halts; a real effect is `running` before `minDays` and `winner` after; legacy experiments have no verdict; a funnel step launch writes the pointer and is served; the merge guard keeps the plan. Four sabotage witnesses (plan lock, SRM halt, CMS start guard, merge guard), each red |
| P2b | branch `feat/0949-p2b-experiments-surface-ui` (stacked on P2a) | `adr0949-p2b-surface.test.ts`: the org floor (member writes, non-member refused), lock through the surface, no launch and no salt or tenant on the surface, node map ↔ manifest parity, writers are side-effects, pack pinned. FE `experimentDetail.test.tsx`: live sample size and an outage is not bad input; launch only after a confirm; SRM halt warning and never "significant"; legacy read-only. Six sabotage witnesses (org floor, launch method, salt, launch confirm, sample failure, SRM notice), each red. Pack `feature.experiments.nodes` 1.0.0; side-effect floor 351 → 355, served 276 → 280 (regenerated) |
| P3a | branch `feat/0949-p3a-contact-units` (stacked on P2b, not on the deploy-gated P2c) | `adr0949-p3-run-freeze.test.ts`: stamp ON/OFF and the reserved key; a born-OFF run stays unstamped when forked; **the P3 exit, over the real `:fork` route: after an epoch change the fork gives 400 contacts the source's arms, while a fresh run uses the new weights**; epoch selection; guardrails accepted only on a counted metric and a bad-direction effect halts (`guardrail_breach`). Four sabotage witnesses (derived stamp, reserved key, epoch `at`, guardrail check), each red. Pack `feature.experiments.nodes` 1.1.0 (`split`) |
| P2c A3 | branch `d8/0949-p2c-a3-managed-pointers` | `adr0949-p2c-contract.test.ts` (14 cases): a launched managed experiment stores the pointer and reads back as the experiment through concluded, promoting, promoted, rolled back and abandoned, and the next write keeps the pointer; a draft, or another step's experiment, never stores a pointer; the approval lane publishes a pointer-only funnel; a re-delivered create returns the funnel hydrated. Four sabotage witnesses, each red (legacy-only `storesAsPointer`; any engine row of the step; the approval CAS on the hydrated read; the stored row returned on re-delivery). Funnel/experiment/promotion sweep 45 files / 325 tests |
| P3b | branch `d8/0949-p3b-journey-split` (the 2026-10-20 commit `5d1e43ff6` merged onto main 2026-10-26 by #5254, `f217d9003`) | `adr0949-p3b-journey-split.test.ts`: `assignContactArm` derives the same arm on every pass under the frozen epoch after a re-weight and a stop, writes nothing, and is null for a draft, an unknown epoch or another org; `bucketHoldout` keeps the string holdout byte-identical (and for an `exp:` id with Experiments OFF), assigns engine experiments at the run's frozen instant, requires `orgId` and a journey split, and leaves an unstamped run out; the `journey.split` adapter (contact unit, two content-free arms, `surface_busy`) observes the SAME arm the split routed, a click converts and an open never does, complaint counted after exposure; the split node passes `orgId`. Pack `feature.campaign-journeys.nodes` 1.4.0. **2026-10-26 merge:** the engine split binds its org to the run (`bindJourneyOrg`, `wrong_client` for another client's run); `contactArmAt` reads a ramp epoch's band layout, as `assignAt` does (ADR 0950 P1 had landed); `observe` counts only the experiment's own client (`resolveEnrollmentOrg`), never another client's journey of the same id; the 2026-10-20 cases 3 and 4 were red on their own base (launch needs a locked plan; the node's host check needs `enroll`/`checkEligibility`) and are fixed. Six sabotage witnesses (frozen epoch, toggle check, org binding, open-as-conversion, layout, client filter), each red |
| P4a | branch `feat/0949-p4a-optimize` (stacked on #5108) | `adr0949-p4a-optimize.test.ts`: Thompson weights deterministic for a seed (**the P4 exit**), floor respected, sum 100; epochs `too_soon` / `appended` / `existing` (a fork never re-allocates), stamped strictly after the deciding run's instant; stickiness after the weights move, read-only resolver, cap; subject erasure of first exposures; Optimize results carry no verdict or p-value; a CMS page Optimize experiment serves sticky and a Decide one never writes the store. Five sabotage witnesses (seed, floor, existing, store-first order, eraser), each red. Pack `feature.experiments.nodes` 1.2.0 (`optimize-epoch`); chain pack `core.openwop.workflows.experiments` 1.0.0; side-effect floor 355 → 356, served 280 → 281 |
| P4b | branch `feat/0949-p4b-optimize-ui` (stacked on #5115) | FE: the create form offers Decide or Optimize (a radio group in the field-check register, each kind's help tied by `aria-describedby`); an Optimize experiment gets its settings form (reward, floor, rebalance cadence) and an allocation view in Optimize vocabulary (traffic now, chance it is best, expected loss, labelled model estimates; never a verdict or "significant"), launches without a plan and rebalances on demand. `experimentDetail.test.tsx` (+2 Optimize cases) and `experimentsCreate.test.tsx`, each sabotage-witnessed red. `/ux-review` invoked: one HIGH (option text in the caption register) fixed |
| P2c A1 | #5253 (`7412be26b`, deployed 2026-10-26; supersedes #5102) | `adr0949-p2c-a1-contract.test.ts` (renamed `adr0949-p2c-contract.test.ts` by A2): no CMS mirror write; the sweep imports never-read rows, deletes every row, never resurrects a deleted one and is idempotent; funnel writes store the full copy the rollback target reads; a pointer-only step is hydrated by every read and served publicly; a write over a pointer row succeeds and restores the full copy; a pointer with no engine row is never minted, is dropped on read, and its stop is a 404. Five sabotage witnesses (mirror write, resurrection, stored-row CAS, pointer write, mint guard), each red. The P1a test's mirror case is inverted |
| P2c A2 | #5257 (`d8/0949-p2c-a2-pointer-writes`) | `adr0949-p2c-contract.test.ts`: a legacy split's every write stores the pointer and every read (including the public serve) returns the full experiment; a pre-P1b copy is imported by the read and then stored as a pointer; a copy whose engine row belongs to another step is kept whole; repeated writes over a pointer row succeed; an orphan pointer is never minted, is dropped on read, its stop is a 404, and the next write leaves it out; the promotion receipt CAS stores the pointer; a managed experiment keeps the full copy even after the engine ends it; a step stays linked to an ended experiment, shown as stopped, over a copy that says running. Five sabotage witnesses (identity `dehydrate`, no surface-ref check, `legacy` ignored, copy before link, CAS against the hydrated read), each red |

## Alternatives weighed

- **Grow `pageExperimentsService` into the engine.** Rejected: cms would own email,
  ad and social experiments, and every other feature would import cms.
- **A third-party engine (GrowthBook, Statsig) behind an adapter.** Mature statistics.
  Rejected for v1: assignment and exposure would leave our replay boundary, and
  Statsig is OpenAI-owned.
- **Bayesian-only.** Rejected: promotion needs an auditable pre-registered error
  guarantee.
- **Overload `run.metadata.featureVariant`.** Rejected: different lifecycles, and a
  run can carry both.

## RFC verdict

**Host extension, no RFC.** Routes live under
`/v1/host/openwop-app/experiments/*`. The run stamp is a host-namespaced metadata key
(`openwop-app.experiments`). No capability is advertised at `/.well-known/openwop`.
If ADR 0962 later exposes experiments to external agents, it rides the existing MCP
server router, which is host work too.

## Open questions

1. **(David)** Should Decide default to a frequentist mSPRT (recommended, auditable)
   or a Bayesian decision rule with a loss threshold?
2. **(David)** Default `fdrQ` 0.10 and `alpha` 0.05: acceptable for agency clients, or
   stricter for regulated categories (0942 risk thresholds)?
3. Can an Optimize experiment graduate into a confirmatory Decide test automatically
   (same arms, new salt), or must a human launch it? Proposed: the agent drafts it, a
   human launches it.
4. CUPED covariates for anonymous visitors are mostly missing. Is pre-period engagement
   from the identity link (ADR 0857) enough, or skip CUPED for `visitor` units in v1?

## Planning rows

**ROADMAP (Campaign Studio program table):**

| Order | Item | Toggle | Depends on | Pack slug | Wire / RFC gate | Status |
|---|---|---|---|---|---|---|
| T3-a | **Unified experimentation engine** ([ADR 0949](docs/adr/0949-unified-experimentation-engine.md)): one model across pages, funnels, ads, email, social; Decide (pre-registered, mSPRT + FDR, CUPED, SRM) vs Optimize (Thompson, floors, no significance); run-start frozen | `experiments` | 0941, 0942, 0236, 0294, 0267, 0099 | `feature.experiments.*` | Host extension | 🔵 Proposed |

**FEATURES "Future features":**

- **Unified experimentation engine (ADR 0949, Proposed)**: one experiment model in
  `host/experiments/` with surface adapters (cms page, funnel step, journey split,
  email, ad set, social post). Decide mode is pre-registered and locked at launch,
  with always-valid sequential stats, BH-FDR, CUPED, SRM halt and guardrails. Optimize
  mode is a Thompson bandit with per-arm floors and never claims significance. MVT is
  full-factorial. Assignment extends `host/variantAssignment.ts` (no second hash) and is
  frozen at run start (ADR 0099). The CRO Analyst narrates; it does not compute.
  Toggle `experiments` (OFF, tenant). Host-ext, no RFC.
