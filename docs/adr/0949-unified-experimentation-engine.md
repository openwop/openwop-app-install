# ADR 0949 — Unified experimentation engine: one experiment model, Decide and Optimize

Status: Proposed

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
