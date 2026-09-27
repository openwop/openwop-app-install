# ADR 0476 — Fleet insights, pre-run cost estimate, and the grounded failure-diagnosis tool

Status: implemented (P3a+P3b+P3c + review fold-in, 2026-07-23 — one PR)
Date: 2026-07-23
Lane: cross-cutting seam (workflow observability) — NO new feature package, NO
new toggle (owner-gated read surfaces + one core agent tool; inert until read)
RFC verdict: **host work only, no new RFC.** The stats/estimate endpoints are
non-normative `/v1/host/openwop-app/*`; the durable cost stamp rides
`run.metadata` (an open map — the ADR 0001 correction precedent); the
diagnosis tool is a chat-time tool through the EXISTING `registerFeatureAgentTool`
seam (its LLM-EXCHANGE-AUDIT row + tripwire land with it). Nothing on the
OpenWOP wire changes.

## Why this exists

Phase 3 of `docs/WORKFLOW-ORCHESTRATION-COMPETITIVE-ASSESSMENT.md` (D8/D9/B3):
we have best-in-class single-run observability but ZERO fleet view — no
per-workflow success rate, duration percentile, or cost trend; no pre-run cost
signal; and failure diagnosis is a human reading an event log. All three
compose from existing substrate (seam exploration 2026-07-23, file:line
verified below).

## Boundaries audit (the load-bearing findings)

- **Run cost is NOT durably queryable.** `observability/costEmitter.ts:115-141`
  folds `provider.usage` into an IN-PROCESS map; `projectRunSnapshot` reads it
  live (`routes/runs.ts:1299`) — gone on restart/other instance. The durable
  precedent is `host/workforceHistory.ts:324` stashing `costUsd` into
  `run.metadata` — but that makes workforceHistory a SECOND writer of the same
  key. This ADR names ONE owner (below) and keeps workforceHistory compatible
  via never-overwrite.
- **`listRuns` is the only list primitive** (`storage/storage.ts:62`) — full
  tenant scan, and its own docblock records the ~4k-rows statement-timeout
  incident. Aggregation must be a BOUNDED single read with the window
  disclosed, never a per-workflow N+1 (the workforce-metrics template:
  `host/workforceService.ts:307` — one `listRuns`, in-memory group).
- **p95 exists nowhere** (only `median()` at `workforceService.ts:291`).
- **Failed-node attribution without event fan-out:** the scheduler stamps
  `currentNodeId` per node start (`executor.ts:375`) and failed runs keep it —
  the hotspot aggregation reads run rows only.
- **Agent-tool seam:** `registerFeatureAgentTool` (`host/agentToolProvider.ts:488`),
  fail-EMPTY-without-acting-user exemplar `features/comments/agentTools.ts:57-64`,
  ownership predicate mirroring `loadReadableRun` (`host/runAccess.ts:54-83`),
  default-on allowlist `host/agentToolAllowlistService.ts:62`
  (`DEFAULT_ON_AGENT_TOOL_IDS`), grounding source = the debug-bundle assembly
  (`routes/runs.ts:1206-1231`).
- **No collisions:** no `…/workflows/:id/stats|metrics|insights` route exists;
  `insights-suite` is NOT prior art (its parallel read-model was deleted by
  ADR 0082 — this ADR aggregates from run rows at read time, no read model).
- **Pricing SSoT:** `providers.json` `cost.{input,output}` per-1K rates
  (FE mirror `byok/lib/providers.ts getProvider`).

## Decision

### 1. Durable terminal cost stamp — ONE owner, spoof-proof
At run-terminal time (the `status:'completed'` transition, `executor.ts:1653`,
and `emitTerminalFailure`, `executor.ts:175` — via one shared helper
`stampRunCostOnTerminal`), fold `snapshotCostRollup(runId)` into
`run.metadata.costUsd` (number, USD) + `run.metadata.costTokens`
(`{input, output}`), **never overwriting an existing value** (so
workforceHistory's earlier stamp — which it derives from the same rollup —
stays authoritative where it fired first; over time the terminal stamp is the
one writer that matters). Guards:
- `costUsd`/`costTokens` join `RESERVED_RUN_METADATA_KEYS` (client-supplied
  values stripped at `buildRunRecord` — a client must not invent spend);
- the **fork path strips them** from the copied source metadata (a fork's cost
  is its own; inheriting the source's stamp under never-overwrite would freeze
  a lie) — redrive already strips via `buildRunRecord`.

### 2. Fleet stats — `GET /v1/host/openwop-app/workflows/stats`
The workforce-metrics shape, tenant-scoped: ONE bounded
`listRuns({tenantId, limit: STATS_WINDOW_ROWS=2000})` read, in-memory group by
`workflowId`, response disclosing the window (`rowsConsidered`, `truncated`,
`sinceOldest`). Per workflow: `{runs, completed, failed, cancelled,
successRate, p50Ms, p95Ms, costUsdTotal, costUsdMedian, costDaily[{day,usd}],
topFailures[{nodeId, count}] (from failed runs' currentNodeId, top 3),
lastRunAt}`. A `percentile()` util joins `median()`. Terminal runs only for
rate/duration/cost; non-terminal counted as `active`. Owner surface: the list
is the caller's tenant slice by construction (no per-id IDOR surface; a
per-workflow READ of the same shape is served from the same aggregation,
filtered).

### 3. Pre-run cost estimate — `GET …/workflows/:workflowId/estimate`
Owner-gated (404 posture). Response:
`{historical?: {medianUsd, p95Usd, samples}, static?: {floorUsd, aiNodes,
assumptions}}` — historical from the same bounded aggregation (terminal runs
of this workflow with a cost stamp); static = AI-node count × default-model
`providers.json` rates × a disclosed token assumption (1K in / 1K out per AI
node), labeled an ORDER-OF-MAGNITUDE floor, never a quote. Surfaced: builder
Run affordance + the ADR 0473 review card (the proposal's static estimate,
computed at propose time from the composed definition and carried in the
approval payload — approve-what-you-see includes approve-what-it-roughly-costs).

### 4. The grounded failure-diagnosis tool — `runs.diagnose`
A READ tool (the model does the explaining; the tool does the grounding):
input `{runId}`; output (for an owned, failed run): run summary
(status/error incl. the classified `userMessage`/`action`, failed nodeId,
revision/provenance stamps), the failing node's definition slice
(typeId + sanitized config), the failure-adjacent event excerpt (the
`node.failed` payload + the immediately preceding `node.completed` outputs,
size-capped), and **next-action deep links** (run detail; the ADR 0475
`?debugRun` builder link — diagnose composes the debug loop). Rules:
- registered core-level beside `workflows.compose-and-run`
  (`registerWorkflowRoutes`), id in `DEFAULT_ON_AGENT_TOOL_IDS`;
- ownership predicate: strict tenant match — DELIBERATELY stricter than
  `loadReadableRun` (no wildcard-operator carve-out on a model-facing
  surface; review L3); **fail EMPTY without an acting user** (ADR 0308
  inverse-gate discipline);
- output passes the event-log redaction discipline (excerpts are already
  post-`stripSecretsFromPersisted`, re-sanitized on the way out);
- NOT in `SCHEMA_READ_EXEMPT_TOOLS` (the output is app-state, not schema text
  — compaction is acceptable and the excerpts are size-capped anyway);
- a tracker row + tripwire in `docs/steward/LLM-EXCHANGE-AUDIT.md` lands WITH the tool.

### 5. FE — fleet dashboard + builder failure heatmap
- **WorkflowsDashboard**: a `KeyFigureBand` fleet header (runs, success rate,
  p95, cost — window-labeled) + per-card stat chips (success %, p95, cost
  trend arrow, top-failure chip) from ONE stats call (no N+1).
- **Builder failure heatmap**: a toolbar toggle painting per-node failure
  counts (this workflow's `topFailures`/full `nodeFailures` map) as danger
  badges via the EXISTING overlay badge pattern — the Camunda-Optimize-lite
  hotspot view on the canvas itself.
- **Run estimate**: shown beside the builder Run verb (fail-soft, absent when
  no data); the 0473 review card renders the proposal's static estimate line.
- i18n ×4; all states designed (empty window, no-cost-data, unlabeled nodes).

## Matrix
| # | Dimension | Decision |
|---|---|---|
| 1-2 | package/toggle | none — core observability seam; surfaces inert until read |
| 3-6 | workflow/node/agent packs, envelopes | none new; `runs.diagnose` is a chat-time tool (Lane 1), NOT an envelope |
| 7 | public surface | none |
| 8 | RBAC | stats = caller's tenant slice; estimate = owner-gated 404; diagnose = loadReadableRun-equivalent + fail-empty-without-user |
| 9 | replay/fork | cost stamp is terminal-only + never-overwrite + fork/create-stripped; stats are pure reads |
| 10 | frontend | dashboard band + card chips + builder heatmap + estimate; BULLETPROOF BAR states |

## Phased plan
| Phase | Scope | Gate |
|---|---|---|
| P3a ✅ | terminal cost stamp (+ reserved-key strips incl. fork) + `percentile()` + fleet stats + estimate endpoints + tests (stamp never-overwrites/never-inherited-on-fork/client-stripped; stats windows + p95 + hotspots; estimate historical/static split) | backend vitest |
| P3b ✅ | `runs.diagnose` tool + allowlist + LLM-EXCHANGE-AUDIT row + tests (empty without acting user; foreign run EMPTY; grounded content + deep links; redaction) | backend vitest |
| P3c ✅ | FE dashboard band/chips + builder heatmap toggle + Run estimate + 0473 card estimate line + i18n ×4 | FE gates + `/ux-review` |

## Alternatives weighed
1. **A durable stats read-model (table updated per run event)** — rejected:
   the exact parallel-read-model shape ADR 0082 deleted; run rows already
   carry everything once cost is stamped; bounded read-time aggregation is
   honest and index-friendly later.
2. **Cost stamp in the storage layer's terminal patch** (like `removalAt`,
   ADR 0371) — rejected: storage would have to reach up into the
   observability rollup (layering inversion); the executor terminal seam
   already owns the run's end-of-life bookkeeping.
3. **Per-node historical medians for the estimate (event-log fan-out)** —
   deferred: N+1 over event logs per estimate; per-workflow history + a
   static composition floor covers the decision the user actually makes
   ("is this $0.01 or $10?"). Revisit if node-level budgeting lands.

## Review fold-in (P3, adversarial code + ux rounds — 2026-07-23)

Code round (2 HIGH + 4 MED + 6 LOW) and ux round (1 CRITICAL + 3 HIGH + 5 MED)
— all applied except two recorded acceptances:

- **code H1** — `currentNodeId` is a start-time stamp: under parallel branches
  a failed run's row named the last-STARTED node, poisoning the hotspot
  aggregation and (worse) `runs.diagnose`'s grounding, which then found no
  `node.failed` event for the wrong id and returned `failedEvent: null`. The
  executor now RE-STAMPS `currentNodeId` at terminal node failure (drain loop
  + `emitTerminalFailure`), and the tool derives the failed node from the
  LAST `node.failed` EVENT (the log is the authority), with `currentNodeId`
  only as legacy fallback.
- **code H2** — `predecessorOutputs` was unbounded in COUNT (fan-in × retry
  re-completions × 4KB each). Now: latest-completion-per-predecessor only
  (what the failing node actually consumed), capped at 8 with a
  `predecessorsTruncated` marker.
- **code M1** — the three cancel terminals never stamped cost: a run
  cancelled after real spend contributed $0 to the money-truth surface
  forever. All three now call `stampRunCostOnTerminal`.
- **code M2** — a 30s per-tenant TTL cache on the aggregation (observational
  stats; the window note already frames them as approximate), and the
  estimate's historical half now READS the cached aggregation
  (`costUsdMedian/costUsdP95/costSamples` joined onto the stats row) instead
  of running its own 2000-row scan. Column projection remains a follow-on.
- **code M3 / ux stale-estimate** — the review card's floor is recomputed
  from the LIVE definition in `withComposedLiveView` (approve-what-you-see
  includes approve-what-it-roughly-costs — the propose-time value is
  replaced, or removed when the live head has no AI nodes).
- **code M4** — the heatmap consumes a FULL `nodeFailures` map (the top-3 cap
  is a dashboard-chip concern only).
- **code L1** — `startWorkflowRun` strips reserved metadata keys (the spoof
  guard no longer anchored solely at `buildRunRecord`).
- **ux C1** — the heat badge carried small TEXT on a `--color-danger` fill —
  3.48:1 in dark mode; restyled to the status-badge register (`--paper` fill,
  `--color-danger-text`, `--danger-rule` border) which also satisfies the §3
  "no status fills behind body text" rule. DESIGN.md badge-family row added.
- **ux H2** — the toolbar estimate chip's "not a quote" disclosure was
  title-only (invisible to keyboard/touch/SR); now an `InfoTip`.
- **ux H3** — hotspot chips no longer surface raw node ids: the aggregation
  joins the node's display label from the current head; label-less (renamed/
  removed) hotspots render a countable claim instead of an id.
- **ux H4** — success-rate figures CLAMP at 99% whenever failures exist
  (rounding must never display "100%" beside a failure hotspot).
- **ux M5-M8/L10-L12** — heatmap empty-intersection toast; a visible
  "stats unavailable" line distinct from "no runs"; `formatDate`/
  `formatNumber`/sub-cent currency digits; samples plural pair; i18n chunk
  budget 222→224 (documented in the budget script).

**Recorded acceptances:** (code L3) the diagnose tool is DELIBERATELY
tenant-strict — no wildcard-operator carve-out (stricter than
`loadReadableRun`; fail-closed on a model-facing surface). (code L4) adding
`openwop:runs.diagnose` to the ADR 0315 default-on baseline is an explicit
decision of THIS ADR: it meets the baseline bar (platform capability,
read-only, acting-user-gated, tenant-bounded, unforgeable scope) and is
tracker-rowed in docs/steward/LLM-EXCHANGE-AUDIT.md — not a silent addition. (ux M9) the
heatmap menu item announces state via label flip; a `menuitemcheckbox` arm
for the shared Menu is a recorded enhancement, not done here.

## Open questions
1. OQ1 — should the stats window be time-based (30d) instead of row-based
   (2000)? v1: row-based (matches `listRuns`'s shape), disclosed in the
   response; a `sinceOldest` timestamp lets the FE label it honestly.
2. OQ2 — cancelled runs in successRate? v1: excluded from the denominator
   (cancellation is an operator act, not a workflow outcome); disclosed as its
   own count.

## Correction note — grade-trio fold-in (2026-07-24)

1. **Production-only headline stats (grade-data H2).** The aggregation read
   EVERY run row, so the program's own eval-case runs (which include
   first-class negative tests asserting `status:'failed'`), debug subgraph
   runs, and builder draft test-runs tanked successRate, minted false
   hotspots, and skewed percentiles. Outcome/latency/hotspot figures now
   consider only runs without `metadata.debug`/`metadata.eval` and with
   `launch !== 'draft'`; their SPEND stays in `costUsdTotal`/`costDaily`
   (money is real) and the exclusion is disclosed per row
   (`nonProductionRuns`).
2. **The terminal cost stamp now folds the run's own `provider.usage` events
   (RFC 0026) + the in-process rollup (grade-data M4 + a deeper find).** The
   original stamp folded ONLY the in-process rollup — whose sole writer is the
   conformance fixture node, so real AI-node spend (span-only `emitCost`)
   never reached run metadata, and a cancel routed to a non-executor instance
   silently stamped nothing. The event-log fold is durable and
   instance-independent; the two sources are disjoint (the conformance lane
   emits no `provider.usage` event) and are summed.
3. **`Storage.mergeRunMetadata` (grade-code H2).** The stamp (and the
   retention-pin route, and the `connectionUse` writer) performed
   whole-metadata read-modify-writes — the exact ADR 0024 lost-update class
   this program fixed twice elsewhere. Metadata stamps now go through ONE
   atomic merge statement (pg `jsonb ||` / sqlite `json_patch`, RFC 7396
   null-deletes) with the never-overwrite condition folded into the same
   statement (`ifAbsentKey`). Residual: two concurrent appends to the
   `connectionUse` ARRAY itself remain last-writer-wins on that one key — an
   array-append primitive is the recorded follow-on.
4. **`workflow_untested` excludes debug runs (grade-code M4).** A one-node
   'only'-mode debug subgraph run no longer satisfies the promote gate; eval
   runs still count (a completed eval case is a full fresh run — eval QUALITY
   is the separate `evals_failing` gate).
5. **Provenance keys are RESERVED (grade-code M5).** `debug`, `eval`, and
   `redriveOf` joined `RESERVED_RUN_METADATA_KEYS`: clients could previously
   forge them at run creation (hiding runs from stats or faking redrive
   lineage for the diagnose tool). The debug/eval/redrive routes stamp them
   host-side post-strip; fork and redrive strip them from copied metadata.
6. **Doc honesty:** workforceHistory's `costUsd` stamp is the deterministic
   `__showcase__` demo generator writing already-terminal rows — it does NOT
   derive from the executor rollup as §1 previously implied; the
   never-overwrite rule is what keeps the two writers consistent.
