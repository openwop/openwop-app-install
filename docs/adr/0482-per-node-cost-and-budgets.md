# ADR 0482 — Per-node cost attribution + per-workflow budgets/alerts

Status: Accepted — implemented (this PR)
Date: 2026-07-24
Relates: ADR 0476 (the terminal cost stamp + fleet insights this extends),
the grade-trio fold-in (the provider.usage event fold + mergeRunMetadata),
ADR 0480 (the daily-bucket CAS pattern), the 2026-07-24 re-assessment
(whitespace item 4: per-run cost attribution is "an industry-wide gap" —
the one axis the whole field is weak on; extend it into a moat).

## Decision

1. **Per-node stamp.** `stampRunCostOnTerminal`'s provider.usage fold
   additionally aggregates per `nodeId` and writes
   `costByNode: { [nodeId]: usd }` — top 8 nodes by spend + an `__other`
   remainder, 6-decimal rounding — **inside the SAME atomic
   `mergeRunMetadata(..., { ifAbsentKey: 'costUsd' })` call** (one
   statement; the never-overwrite key guards the pair, so a workforce-
   stamped run never gets an orphan costByNode). `costByNode` joins
   `RESERVED_RUN_METADATA_KEYS` and the fork/redrive strips.
2. **Daily spend counter.** `workflow:spend-day`
   (`${tenantId}:${enc(workflowId)}:${day}` → `{usd, alerted80,
   alerted100}`), CAS-folded at the same terminal seam with the ADR 0480
   bucket discipline (8 attempts + jitter, drop-on-contention logged,
   ~35-day prune-on-write, `tenantOf`, REVIEWED_EXEMPT counts-only coverage
   row). **ALL terminal spend counts** — production, debug, eval: the
   segmentation doctrine governs OUTCOME statistics, never money (the
   `costDaily` doctrine); the FE copy discloses it.
3. **Budgets.** `workflow:budget` (`${tenantId}:${enc(workflowId)}` →
   `{dailyUsd, hardCap, updatedBy, updatedAt}`) with owner-gated
   GET/PUT `/v1/host/openwop-app/workflows/:workflowId/budget`
   (`loadOwnedHead` posture; validation: dailyUsd > 0 finite, hardCap
   boolean). Deletion cascade via the tenant-aware `onWorkflowDeleted`
   hook; ERASED coverage row (updatedBy → [erased], the revisions
   `createdBy` precedent).
4. **Alerts.** At the terminal fold, crossing 80%/100% of `dailyUsd` with
   the counter row's flag unset CAS-sets the flag and emits ONE
   tenant-broadcast notification (`openwop-app.workflow.budget-alert`) through the
   existing emitter — once per threshold per day BY CONSTRUCTION (the flag
   rides the same CAS row as the spend). Bell/inbox only: the ADR 0478
   email chokepoint picks up only ADDRESSED records of specific types, so
   broadcasts are structurally excluded — the email lane is a recorded
   follow-on.
5. **Hard cap.** `budget.hardCap && todaySpend >= dailyUsd` ⇒ run creation
   returns a typed 429 (`workflow_budget_exhausted`), checked at
   `startWorkflowRun` (schedules/triggers/kanban/MCP/CRM) and
   `POST /v1/runs`. **Never** at sub-workflow child dispatch (blocking a
   child strands a mid-flight parent — worse than one overspent child),
   never for debug/eval/redrive lanes (diagnostic spend stays unblocked).
   **FAIL-OPEN on counter/budget read errors** — a budget-infrastructure
   outage must never block production (logged, disclosed).
   TOCTOU accepted + disclosed: two concurrent creates can both pass at
   99% — a budget is a daily-granularity guardrail, not an invariant.
6. **FE.** RunDetailPage per-node cost table (from the stamp; pre-stamp
   runs fall back to client-side aggregation of the already-loaded
   provider.usage events); a builder COST heatmap as a second MODE of the
   existing failure-heatmap slice (same badge infrastructure, mode-labeled
   chip + honest window note); dashboard card budget chip (spent/budget %
   in warn/danger registers, "includes debug/eval spend" disclosure) and a
   Set-budget entry in the existing kebab menu with a small dialog
   (ui/confirm-adjacent pattern; never window.prompt). i18n ×4.
7. **No RFC** — run.metadata stamps + host-ext routes (the 0476 precedent).

## Probed and ruled

- Alert recipient: tenant broadcast (bell for all members); addressed/email
  delivery is the follow-on.
- Anon tenants may set budgets on workflows they own — harmless, owner-gate
  suffices.
- Estimate-endpoint budget interplay deferred; the dashboard chip is v1.
- The counter and the run stamp can diverge by at most the dropped-on-
  contention increments (disclosed best-effort, same as ADR 0480 buckets).

## Review fold-in (both rounds applied in this PR)

Code review (1 CRITICAL + 2 HIGH + 4 MED):
- **C1** — the spend fold consumed the stamp's COMPUTED figure, so a
  cancel × in-flight-executor race folded one run's spend twice (phantom
  money tripping alerts and the hard cap early). `mergeRunMetadata` now
  returns whether it WROTE, and the stamp returns spend only when its merge
  landed — the counter mirrors the written stamp exactly. Trade disclosed:
  a cancel-time partial figure stays the counted truth (under-counting the
  post-cancel remainder beats double-counting). Regression-tested.
- **H1** — `startWorkflowRun` returning null for budget-exhausted was
  indistinguishable from "definition missing" for ~30 callers: approvals
  stranded `approved`-with-no-run behind a FALSE diagnosis, the compose
  lane looped a lying 409, agents were told the workflow was gone. The
  starter now THROWS the typed 429; approvalDecision compensates by
  REOPENING the approval on a budget refusal; the compose catch + schedule
  daemon catch were verified throw-safe.
- **H2** — "all terminal spend counts" was false at three lanes: gate-
  timeout auto-reject, quorum-reject, and sub-workflow child-throw now
  stamp + fold (money is money — even where online evals stay excluded as
  operator acts).
- **M1** — the cap check moved AFTER the idempotency-cache hit (a retry of
  an already-created run returns the cached 201, never a 429 minted by the
  run's own spend). **M2** — `listRuns` gained a server-side `workflowId`
  filter (the cost heatmap's "latest run" was wrong for busy tenants).
  **M3** — changing a budget resets today's alert flags (raising a budget
  previously suppressed the NEW thresholds for the rest of the day).
  **M4** — recorded here: human-APPROVED dispatches ARE capped (the
  approval reopens with the honest 429 — deciders retry after the budget
  resets). **L1** — sub-cent top-8 entries fold into `__other` instead of
  vanishing. **L2/L4** — child spend lands on the CHILD's counter (a
  parent's chip excludes it — disclosed in the FE tooltip); the alert emit
  after the flag CAS is best-effort (a crash between them loses that day's
  alert — accepted).

UX review (5 blocking + fold): the budget 429 is now classified as its own
kind (never "Too many requests — retry" — a lie when the reset is UTC
midnight) across every create surface incl. the chat dispatch lane; the
100% alert names the blocked schedules/triggers when the hard cap is on;
the cost badge/chip left the WARNING register (cost is a data dimension,
not a fault — neutral register per DESIGN.md §5.3, the derived border via
a named token); the load-bearing disclosures moved from title-only to
InfoTip + a visible capped signal; the dialog validation errors are
reachable (field-level error, Save stays enabled); the failure heatmap
gained the same window-disclosure chip as cost; placeholders/apostrophes
localized; money formatting unified on one helper.

## Implementation record

This PR: stamp extension + spend counter + budget store/routes + alerts +
hard cap + FE (per-node table, cost heatmap mode, budget chip + dialog) +
i18n ×4 + coverage rows + tests (stamp shape, cap behavior incl. fail-open
and child-dispatch exemption, alert once-per-day, route gating).


## Grade-trio fold-in (2026-07-24, whole-program grade)

- **H1 (cross-phase)** — §5's null→throw change (the typed 429 refusal) broke
  the host-event FAN-OUT loop and the inbound-webhook lane: a single
  hard-capped workflow's 429 aborted the whole batch (`hostEventDispatcher`)
  or 500'd the webhook past its `nofire:` sentinel (retry storm). Both now
  isolate per binding / decline gracefully. Regression:
  `host-event-budget-isolation.test.ts`.
- **M1** — the anon-widget settle lane now stamps + folds cost like every other
  terminal seam (managed-AI spend is money; no uncounted seam if the free tier
  bills). `onlineEvalScored` joins the reserved+fork-stripped keys.
- **data LOW-2** — `stampRunCostOnTerminal` returns the 6-dp-rounded figure so
  the spend counter is a byte-exact projection of Σ costUsd.
- **data LOW-1 (disclosure)** — "35-day" is prune-on-WRITE: an idle workflow
  retains its count-bounded (≤35) bucket tail until tenant teardown, not a
  time-TTL sweep.
