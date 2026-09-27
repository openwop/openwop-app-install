# ADR 0480 — Online evals: scoring production runs + daily trend buckets

Status: Accepted (implementation in this ADR's PR)
Date: 2026-07-24
Relates: ADR 0477 (workflow evaluations — the fixture lane this extends), ADR
0476 (terminal stamp seam + daily-bucket precedent), the 2026-07-24
competitive re-assessment (whitespace item 2: the D5 frontier —
LangSmith/Vellum online evals, Inngest Agent Evals).

## Context

ADR 0477 shipped fixture evals (cases + pinned mocks + a promote gate). The
2026-07-24 re-survey found the eval frontier moved to ONLINE evaluation —
scoring live production traffic, not just fixtures (LangSmith online evals +
trends, Vellum "results on every production execution", Inngest delayed-
outcome scoring). Our assertion engine is already pure over
`(RunRecord, events)` (`collectRunEvidence`/`evaluateAssertions`), so the
missing piece is a terminal-time scoring lane + a trend surface.

## Decision

1. **Opt-in per eval set**: `WorkflowEvalSet.online?: { enabled: boolean;
   sampleRate?: number (0..1, default 1); judge?: boolean (default false);
   assertions: EvalAssertion[] (required, ≤10) }` — explicitly validated +
   row-assembled (the closed-world validator drops unknown fields by design).
   **Self-correction during design**: the online lane carries its OWN
   assertions — CASE assertions pair with fixture inputs (an
   `output-path-equals` written for a specific input would misfire on live
   traffic); online assertions are input-independent INVARIANTS, matching
   the field's shape (LangSmith online evaluators score traces, not dataset
   comparisons).
2. **The hook**: `scoreOnlineEvalsOnTerminal(storage, runId)` fire-and-forget
   at the TWO executor terminal sites, beside `stampRunCostOnTerminal`. NOT
   at the cancel sites — cancellation is an operator act, not a workflow
   outcome (the ADR 0476 OQ2 doctrine). Non-production runs
   (`metadata.debug`/`metadata.eval`/`launch==='draft'`) are skipped — the
   segmentation doctrine. In-process loss on instance death mid-terminal is
   accepted and disclosed (the lane is sampled anyway).
   `OPENWOP_ONLINE_EVALS=off` is the global kill switch.
3. **Scoring** reuses `collectRunEvidence` + `evaluateAssertions` verbatim.
   ONE rule, no hidden gating (/architect §1): deterministic assertions
   always evaluate — a failed production run scoring red is CORRECT signal
   (that is what a production quality trend is for), and `output-contains`
   against absent output is an honest assertion failure. The one carve-out:
   **`llm-judge` never dispatches for a non-completed run** (no spend to
   grade absent output) — recorded as a failed judge kind without a call.
4. **Judge spend cap**: online judge dispatches are capped per tenant-day
   (`OPENWOP_ONLINE_EVAL_JUDGE_RUNS_PER_DAY`, default 50) in a dedicated
   counter store (`workflow:eval-online-judgecap`, CAS-incremented). Cap
   reached ⇒ judge assertions SKIP for that run (counted `judgeSkipped`,
   never a silent pass — the run's deterministic assertions still score);
   the run itself is never skipped. Judge rides `tenantEvalJudge` → the
   existing ADR 0110 BYOK-gated resolver; no provider ⇒ failed-named verdict
   (the 0477 rule).
5. **Outcomes**: daily buckets in `workflow:eval-online`
   (`${tenantId}:${enc(workflowId)}:${evalSetId}:${day}` →
   `{evaluated, passed, failed, judged, judgeSkipped, sampledOut,
   failures: last ≤10 {runId, failedKinds[], at}}`) — counts + OPAQUE run
   references only, never output/detail strings. CAS-loop increments
   (4 attempts; persistent contention drops the increment, logged —
   observability counts, disclosed best-effort). ~35-day prune-on-write.
   Both new stores carry `tenantOf` (ADR 0284 teardown) and REVIEWED_EXEMPT
   coverage rows (no subject content).
6. **Read surface**: `GET /v1/host/openwop-app/workflows/:workflowId/
   eval-sets/:evalSetId/online` — owner-gated 404 posture, the sibling
   pattern (`loadOwnedHead` + protocol scope).
7. **FE**: EvalsDrawer per-set Online section — enabled/sample chip, last-7d
   pass rate, daily pass-rate `Sparkline` (the ADR 0377 primitive), recent
   failures deep-linked to run detail (a retention-deleted run 404s through
   RunDetailPage's existing handling — disclosed). i18n ×4.
8. **No run-quota charge** (scoring an already-terminal run is not a new
   run); no RFC (host-ext only, no wire surface).

## Rulings recorded (from the pre-implementation review)

- Failed-run scoring is signal, not noise — no status-gating of deterministic
  assertions (§3). Negative sets (`status:'failed'`) work unchanged.
- Kill switch yes, config cache no: the per-terminal `listByPrefix` reads ≤10
  indexed rows; a TTL cache would delay enable/disable for zero real win.
- `Math.random()` sampling is legitimate here: the decision is post-terminal
  host accounting, never stamped into run state, unread by replay/fork (the
  `variantAssignment` determinism rule does not apply).
- Redrive/fork runs score independently — each is a distinct production run.
- Sub-workflow children score against their OWN workflow's online sets.
- The judge cap counter is its own typed store, not a shape-mixed row in the
  bucket store.

## What this is NOT (honesty)

No judge calibration, no A/B experiments, no delayed-outcome scoring
(Inngest's lane), no alerting on trend regressions — recorded follow-ons.
The pass-rate trend is windowed (≤35 daily buckets) and sampled; the FE
disclosies sample rate and window.

## Review fold-in (both rounds applied in this PR)

Code review (2 HIGH + 5 MED + 9 LOW):
- **H1** — cap exhaustion previously FAILED the llm-judge assertion
  (`judge_unavailable`) on every over-budget run, manufacturing red trend
  signal exactly when the feature is used most and contradicting §4's own
  SKIP wording. A skipped judge now EXCLUDES its assertions from pass/fail;
  coverage loss is disclosed by `judgeSkipped`, never faked as quality loss.
  Regression-tested (a healthy over-budget run PASSES).
- **H2** — the validator now REJECTS `llm-judge` in `online.assertions`
  without `online.judge: true` (the misconfiguration would permanently
  exclude the judge with no UI hint).
- **M1** — terminal coverage: gate-timeout auto-reject, sub-workflow
  dispatcher child-throw, and the anon-widget settle lane now score (they
  are production outcomes the executor sites never see). EXCLUDED and
  recorded: interrupt quorum-REJECT (an operator act, the cancel doctrine).
  Remaining known non-scoring writers are operator/administrative paths.
- **M2** — a 3-slot in-process semaphore bounds post-terminal scoring
  (it runs outside every run budget). **M3** — sampling draws BEFORE the
  event scan (a low-rate tenant never pays a 100k-event read to sample out).
  **M4** — bucket CAS: 8 attempts + random backoff (correlated retries
  starved the fold and dropped failure REFS, not just counts).
- **L2** — `judged` now means a DELIVERED verdict (a judge_error re-counts
  as skipped). **L3** — online assertion validation errors say
  `online.assertions[i]`, not `cases[-1]`. **L5** — empty env var = unset,
  not zero. **L6** — judge-cap rows prune on day rollover. **L1** (terminal
  status guard in emitTerminalFailure) recorded as a platform follow-on —
  single-score is currently incidental-but-verified, not structural.

UX review (1 CRITICAL + fold):
- **Critical** — the drawer's edit draft omitted `online`, so ANY edit
  through the only configuration surface silently wiped online scoring.
  The draft now round-trips it; the TEMPLATE shows the (disabled) online
  shape so the lane is discoverable.
- "Last 7 days" now means CALENDAR days (bucket rows exist only for
  traffic days — slicing rows made the claim false for sparse workflows);
  the sparkline + window note disclose they plot ACTIVE days only
  (zero-filling would fake 0% days a workflow never had).
- Sparkline: `className` prop (the ui/ primitive no longer bakes in the
  dashboard's BEM class — the intended wrapper color was dead CSS) +
  `domain=[0,1]` (min-max normalization drew a perfect week as a
  bottom-edge flatline). Register decision: CLAY app-wide (the adjacent
  chip carries severity; a state-colored line would double-signal).
- Judge-skip copy no longer blames the budget for every skip; failure
  links carry aria-labels + visible dates; a pre-expand "Online" chip;
  bucket cache clears on drawer open; plural `_one/_other` keys ×4;
  es "de aprobación"; fr `{{pct}}%` file convention.

## Corrections

- §1 sampleRate is (0, 1] — 0 is expressed by `enabled: false` (code L4).
- §4's "skip" is now implemented as EXCLUDE-from-scoring (H1), which is
  what the section always claimed.

## Implementation record

This PR: online field validation + scoring module + executor hook + judge
cap store + outcomes store + read route + EvalsDrawer Online section +
Sparkline trend + i18n ×4 + coverage rows + tests (scoring semantics,
sampling, judge cap, failed-run rule, bucket CAS, route gating).


## Grade-trio fold-in (2026-07-24, whole-program grade)

- **L1** — `scoreOnlineEvalsOnTerminal` now claims a once-per-run ticket
  (`mergeRunMetadata({onlineEvalScored}, {ifAbsentKey})` — the cost fold-ticket
  pattern) so a run reaching two terminal seams can't double-count the trend;
  the marker is reserved + fork-stripped (a fork re-scores). data LOW-1
  disclosure: the ≤35-day bucket prune is prune-on-write (idle-entity tail
  retained until teardown).
