# ADR 0889 — Agent eval suites: RFC 0081 + RFC 0244 on this host (trajectories, trials, fixtures, a scripted tool-call mock, and the Evals tab)

Status: implemented (P1–P7, 2026-10-14; post-merge review 2026-10-15 `ee7fc1e81`; residue closed 2026-10-15 `79441a593`; grade remediation 2026-10-15: #4841 `17d936b00`, #4847 `80728a9a0`, #4849 `576700ddf`, #4844 `02997f9b1` and the record PR). See §Implementation record, §Residue closure and §Grade remediation. Open items are tracked as `EVR-*` in `docs/steward/TODO.md`, not here.
Date: 2026-10-14
Lane: cross-cutting seam (agent quality). It adds no new feature package and no new toggle. The UI rides the existing `evals` toggle (ADR 0123 / ADR 0820 §8.2).
Implements: OpenWOP **RFC 0081** (Accepted) and **RFC 0244** (`Active`, openwop/openwop#1993). Both are already on the wire, so this ADR needs no new RFC.
Composes: ADR 0477 (workflow eval sets: judge + promote gate), ADR 0480 (online evals), ADR 0123 (leaderboard), ADR 0324/0830 (the one scoped tool provider), ADR 0834 (the lane firewall), ADR 0102/0150 (tool gates)
Source: `docs/research/deep-research-agent-evals.md` (market + methodology + standards survey, 2026-10-14)

## Context

The market survey's verdict:
- Grade the outcome first, and check the trajectory as a constraint.
- Run each case several times, and report pass@k and pass^k.
- Report steps and tokens; do not gate on them.
- Record and replay the tool boundary so CI is deterministic.

RFC 0244 puts that vocabulary on the OpenWOP wire, on top of RFC 0081.

**What this host has today** (measured at `dd682d0c2`):

| Surface | State |
|---|---|
| `agents.evalSuite` advert | **absent**. `agentsCapability()` (`routes/discovery.ts:866-945`) never emits it, so `hostSatisfies('agents',['evalSuite'])` is always false. |
| `POST /runs {mode:"eval"}` | `422 capability_not_provided` (`routes/runs.ts:185-205`, #4318) |
| `GET /runs/{id}/eval-summary` | no route |
| `host/agentEvalGrader.ts` | A stateless golden / substring-rubric / schema grader behind `POST /host/openwop-app/agents/eval-run`. It has no tenant check of its own, creates no run, calls no model, and its `EvalSummary` is not the RFC shape. *(CORRECTED 2026-10-15, §Grade remediation EVAL-8: it was RETIRED, not folded in or aliased. #4847 deleted the route, the module and its two tests; no frontend, pack or example called it.)* |
| `host/workforceEval.ts` | One hard-coded five-task suite for one agent. It uses the deterministic `runAgentDispatch` and writes `eval.*` straight to `storage.appendEvent`, which skips the sequence, bus and closure rules of `getEventLog().append`. It is env-gated and never advertised. |
| ADR 0477 / 0480 | Workflow eval sets and online scoring. They are real and good, but their evidence is only `node.*`/`run.completed`. They never read `agent.*`, so they see no trajectory. |
| Mock provider | `dispatchMock` returns text only. `TOOL_CALLING_PROVIDERS` excludes `mock` (`aiProvidersHost.ts:195`), and `callAIWithTools` throws for it, so **no chat or agent trajectory can run in `npm run ci`**. The workflow lane's `core.conformance.mock-agent` scripts `mockToolCalls`, but only for conformance and only as events. It invokes nothing. |
| Live agent dispatch | `agent.toolCalled` carries `argsHash` and no `inputs` (`agentDispatch.ts:1360`). Every tool call goes through one injectable `deps.executeTool` (`agentDispatch.ts:1364`), and every model round through `deps.callAIWithTools` (`:1172`). |

## Decision

### D1 — The eval run is a real run, created through `POST /runs` and run by a host-side runner

`mode:"eval"` stops refusing once the advert is served (D7). The handler branches **after** the tenant, principal, scope and closed-root checks and **inside** the same Idempotency-Key claim. The claim block is factored into one local function that both branches call, rather than copied.

The eval branch:
1. resolves `evalSuiteRef` (D2) and the agent, behind the same tenant gate as `/agents/:agentId/dispatch` (`resolveAgentForTenant`, 404 for absent or not-yours);
2. validates the suite against the advert (D7), refusing with `400 validation_error` naming the field;
3. builds the run with `buildRunRecord`. `workflowId` is `eval:<suiteId>@<version>`, a synthetic id that is never registered as a workflow and therefore never appears in `/builder` or the `/` picker. `metadata.mode = 'eval'` and `metadata.eval = {suiteRef, agentId}`;
4. inserts it with `insertRunWithStartContext(… enqueueDispatch:false …)` under `withRunLimit`, so quota, run limit and idempotency commit are shared with every other run;
5. returns `201`;
6. starts `runAgentEval()` (`host/agentEvalRun.ts`).

The runner emits through **`getEventLog().append` only**. It never writes events to storage directly.

**Rejected alternative: a pinned in-tree eval workflow** (`openwop-app.eval-suite`). It would grow the ADR 0764 D6 pinned-id ladder, and RFC 0081 §B explicitly says an eval is a projection over runs, not a workflow.

> **CORRECTION 2026-10-15 (grade-workflows Q1) — the runner is a SECOND RUN EXECUTOR, and this section never said what that obliges.** The rejected alternative was a straw man: the alternative the chains-or-stacks doctrine actually prescribes, a node pack driven by the shared executor behind the same `mode:"eval"` wire, was never weighed. The runner stays (it is well built, and a rewrite buys nothing), but it is a *sanctioned* second executor, and every obligation `executeRun` meets it must meet itself. Three had drifted by the grade pass. After #4849 the obligations and where each is met:
>
> | Obligation | Met by |
> |---|---|
> | the advertised `limits.maxRunDurationMs` (a v2 MUST: `cap.breached{run-duration}` + `run_timeout`) | #4849 (WF-EV-1), deadline re-anchored per segment |
> | cancel stops in-flight work | #4849 (WF-EV-2): `armRunAbort`, a per-trial signal through the lane, interceptor and judge. NOT the provider HTTP call itself (`EVR-12`) |
> | the orphan sweeper's abandon ceiling | #4849 (WF-EV-3), aged from `lastProgressAt` |
> | lifecycle events exactly once across crash windows | #4849 (WF-EV-4), decided from the log |
> | lease renewal + fenced progress writes | #4849 (WF-EV-7) |
> | resume refuses changed content | #4847 + #4849 (WF-EV-8), `suiteDigest` for every source |
> | run cost on the run, the cost ceiling inside a trial | #4849 (EVD-8, EVAL-5) |
> | spend folded into the tenant spend-day counter | **not yet** (`EVR-5`) *(CORRECTED 2026-10-19: done by #4864, `fec48d7d1`, merged 2026-10-15. A completed run folds its recorded total (model + judge) and a failed run folds the judge spend of the trials it recorded (`settleEvalCost` in `host/evals/agentEvalRun.ts`). Two limits stand: the counter is keyed per workflow, so eval spend lands under the synthetic `eval:<suite>@<version>` id, and the eval lane is exempt from the ADR 0482 §5 hard cap. The fold therefore makes the spend visible and does not refuse anything. The tenant-wide daily bound is the managed ladder (`daily_limit_reached`), which ends the run as a typed `eval_run_failed` (witnessed in `adr0889-runner-lifecycle.test.ts`). In short: visibility plus managed-ladder bound; BYOK eval spend is bounded only by the $5 per-suite cap (`maxCostUsdPerSuite`).)* |
> | `configurable` honoured or refused | #4847 (WF-EV-9): refused |
> | `:pause` / `:resume` / `:fork` | refused (A2); witnessed by #4849 (M5). *(WF-EV-10: a `:fork mode:"replay"` could be served as a pure log copy, since `eval.scored` holds recorded facts that a replay re-reads; that was consciously NOT built. Refusing is legal: no MUST requires fork support.)* |
>
> A new executor obligation (anything `executeRun` starts enforcing) must be added to this runner or to this table as a stated gap. That is the cost of the second executor.

### D2 — Suites: a tenant store plus pack-shipped suites, one resolver

- **`agent:eval-suite` DurableCollection.** It is keyed `tenant:suiteId@version` and holds RFC 0081/0244 `AgentEvalSuite` documents. CRUD lives at `/host/openwop-app/agent-evals/suites` (`workspace:write` to write, `workspace:read` to read), and erasure is registered like ADR 0477's stores.
  - **A version is immutable once any eval run references it**, so baselines stay comparable. An edit must mint a new version.
- **Pack suites.** An agent manifest's `evalSuiteRef` resolves from the agent's pack, the same way `systemPromptRef` does. *(Added 2026-10-15, NP-EVAL-9, two rules the code had and this ADR did not state: an agent a TENANT owns (`ownerTenant`, a user agent) never gets a pack suite, because its tenant uses its own store; and a pack suite that fails validation is skipped with a `pack_eval_suite_invalid` log only, never surfaced in the Evals tab. Since #4847 a suite whose `targetAgentId` names another agent, and an `evalSuiteRef` outside an installed subdir, are refused rather than listed.)*
- **`resolveEvalSuite(tenant, ref)`** is the one resolver. Tenant store first, then the pack, then `404`.
- **Validation is closed-world:** the vendored v2 `agent-eval-suite` schema plus host limits (task count ≤ `maxTasksPerSuite`, trials ≤ `maxTrials`). A failure is a typed `400`, never a silent drop.

### D3 — One live dispatch composition, extracted rather than copied

The ad-hoc live branch of `POST /agents/:agentId/dispatch` (`routes/agents.ts:316-460`) composes:
- identity,
- the scoped tool provider (ADR 0830 D1),
- memory,
- knowledge,
- borrowed recall,
- compaction,
- the lane firewall.

That body moves into `host/liveDispatchLane.ts` (`buildLiveDispatchDeps`). The dispatch route and the eval runner both call it, and the route's behaviour is unchanged (its existing tests pin it).

The eval runner then **wraps** two seams:

| Seam | Wrapper |
|---|---|
| `executeTool` | **The fixture interceptor** (RFC 0244 §D). It serves the first unconsumed `toolResponses` entry whose tool and args match. On a miss it returns a tool error and counts it under `onMiss:"fail"`, which is this host's default for an absent `onMiss` (the SHOULD). It records `{name, input}` as the observed trajectory (§A grades the call as executed, UQ 6). |
| `memory` | **An ephemeral per-trial port** seeded from `fixtures.memorySeed`. |

**An eval never writes the agent's real memory, and it never reaches a live tool unless the suite says `onMiss:"live"`.** Even then the lane firewall applies, with `lane:'eval'`. This is the safety core of the ADR: a suite is untrusted, authored content, and running it must not send email.

### D4 — Grading: one pure module per concern, reusing the ADR 0477 judge

| Module | What it computes |
|---|---|
| `host/evals/outputGrade.ts` | RFC 0081 golden (`exact` / `contains` / `json-match`). Rubric goes through **ADR 0477's `tenantEvalJudge`**, so there is one judge path and one LLM-EXCHANGE-AUDIT row: weighted criteria, a typed verdict, and unavailable means failed-with-reason. The existing `agentEvalGrader.ts` scoring folds in here. *(CORRECTED 2026-10-15, EVAL-8: nothing folded in. The legacy grader was retired outright in #4847; `outputGrade.ts` was always the only grader on the eval lane.)* |
| `host/evals/trajectory.ts` | RFC 0244 §A: the four match modes, `forbidden`, `argsMatch`, own-agent vs `includeDelegates`, and the counts block. |
| `host/evals/trialStats.ts` | RFC 0244 §B: pass@k = 1 − C(n−c,k)/C(n,k), pass^k = C(c,k)/C(n,k), clustered stderr. Exact integer combinatorics via BigInt, so large n cannot overflow. |
| `host/evals/regressionVerdict.ts` | RFC 0244 §F: paired by `taskId`, `method:"sign-test"` (exact two-sided binomial over per-task `meanScore` deltas, ties dropped), with `alpha` defaulting to 0.05. `inconclusive` when p ≥ alpha. Identical runs ⇒ `unchanged`. |
| `host/evals/efficiency.ts` | RFC 0244 §C: tool calls, model calls and tokens, counted from the trial's own events. Judge calls are excluded. |

### D5 — Events, summary and the read route

Per trial, the runner emits:
1. the RFC 0077 `agent.invocation-*` bracket;
2. the agent's own `agent.*` and `provider.usage` events, re-emitted onto the eval run exactly as `agentRunnerNode` does;
3. `eval.scored {taskId, trialIndex, score, passed, costUsd, latencyMs, scoreLabel, evaluatorType}`.

The bracket is wrapped as a whole:
- before it: `eval.started {…, trialCount}`;
- after it: `eval.completed`, then `run.completed`, with output = `EvalSummary`.

The summary is persisted on the run (`metadata.evalSummary`) and served by **`GET /runs/:runId/eval-summary`**:
- under the run's own read authorization (owner triple; cross-tenant is `404`);
- a non-eval run answers `404 not_found`;
- a non-terminal eval run answers `409`.

Every payload is content-free (`eval-summary-no-content-leak`). An existing pin test is extended to assert that no event or summary field carries a tool name, argument, output or prose.

### D6 — The scripted tool-call mock (`tool-calls`), for CI first

`dispatchMock` gains a **tool-call program**: an ordered list of rounds, each either `{toolCalls:[{name,input}]}` or a final `{content}`. `mock` joins the tool-calling path via a `toolsRoundDispatcher` case and a `callAIWithTools` branch, so **both** `runAgentDispatchLive` and the chat tool loop (`conversationToolLoop.ts`) can be driven through real tool rounds with no key.

| Lane | How it enables the mock |
|---|---|
| Tests | the existing `POST /host/openwop-app/test/mock-ai/program` seam (test-seam gated) |
| Eval runs | `configurable.mockProvider = {id:"tool-calls", rounds:[…]}`. Test keys only, refused `403` on a production credential (`runs.md` §ai section). |

> **CORRECTED 2026-10-15 (#4797 gate):** the mock does **not** join the chat tool loop. Making `providerSupportsToolCalling('mock')` true turned every mock chat turn on a test host into a tool loop (the CS-GB-1 contract, `model-router-conversation-target.test.ts`). The scripted rounds run on the eval lane only, through `callAIWithTools`.

This ADR does **not** advertise `testing.mockProviders`. That list carries a v1 MUST (`stream-text`) and its own conformance burden, and that belongs in a separate decision. The mock is a test seam here, not a wire claim.

### D7 — The advert is honest and staged

`agentsCapability()` emits `evalSuite` from **one** function, `evalSuiteCapability()`, which reports exactly what the code implements:
- `modes:["golden","rubric","regression"]` (`adversarial` and `live-shadow` are not implemented, so they are not advertised);
- `maxTasksPerSuite: 100`;
- `maxCostUsdPerSuite`.

The RFC 0244 facets (`trajectory`, `trials:{maxTrials:10}`, `fixtureMatching`, `regressionVerdict`) are added **only once the published conformance suite carries them**. Until then the closed v2 `agents` record would reject an unknown member and red our own certified cut. The switch is a one-line constant, pinned by a test that compares the advert with the vendored facet schema.

The env flag `OPENWOP_AGENT_EVAL_SUITE_ENABLED` stops gating the protocol surface, because the surface is now real. It keeps gating only the legacy workforce route. That route is rewritten to call `runAgentEval()` with its suite moved into the store, so there is one runner.

### D8 — The Evals tab (UI) and chat reach

**UI.** An **Evals** tab on the agent detail page, gated on the `evals` toggle, built from `ui/` primitives:
- suites list;
- suite editor: a form for tasks / expected / trajectory / trials / fixtures, with a JSON view;
- **Run** button: picks a model, and an optional baseline for regression;
- live scorecard: streams `eval.scored` and shows per-task pass@k / pass^k chips, trajectory counts, efficiency and fixture misses; *(CORRECTED 2026-10-15, EVAL-9: it does not stream. The tab POLLS `…/agent-evals/runs/:id/progress` (`AgentEvalsPanel.tsx`), and since #4841 keeps polling history while a run is unwatched. The scorecard content is the same; the transport claim was false.)*
- run history with the regression verdict.

It deep-links the run in the run viewer. There is **no new chat**: per CLAUDE.md, an "ask the agent why it failed" action deep-links `/?agent=<id>`.

**Chat-drivability (ADR 0058).** Three feature tools via `registerFeatureAgentTool`, sharing their routes' access predicates and pack-allowlisted, never default-on:
- `openwop:agent-evals.list-suites`
- `openwop:agent-evals.run` (returns the runId)
- `openwop:agent-evals.get-summary`

*(CORRECTED 2026-10-15, NP-EVAL-1 / AEV-5: "pack-allowlisted" was FALSE until #4844. No pack allowlisted any of the three, `filterTools` matches exact ids, and the tools are not in the ADR 0315 baseline, so no shipped agent could reach them; the LLM-EXCHANGE-AUDIT row graded that A−. #4844 allowlists them on the Agent Author (`vendor.openwop-app.agent-author.agents` 1.2.0) with a prompt section, and `agent-tool-reach-ratchet.test.ts` now fails any registered chat tool that no agent can reach unless it is a named exception. The Agent Author's toggle is default OFF, so the tools reach chat only where `agent-author` is on.)*

### D9 — Promote a recorded run to a regression case

From a completed agent run, **Add to eval suite** builds a task with:
- the run's input;
- `expected.trajectory` from its observed calls (`match:"in-order"`, `argsMatch:"ignore"` by default);
- `fixtures.toolResponses` from its recorded tool boundary, with `args` and `onMiss:"fail"`.

The author then edits the expected output.

This is the host export that RFC 0244 UQ 7 left out of the wire. **It needs tool results**, and today's log has only `argsHash`. So the eval runner and the live lane record `{name, input, result}` for a run into a run-scoped, tenant-keyed store (`agent:tool-boundary`, retention as runs, erased with the run). It never goes onto the wire.

### D10 — The live-eval command

`scripts/eval-agent-suite.mts` runs a stored or pack suite against a running host over HTTP:
- `--trials N`, `--baseline <runId>`;
- prints the summary, plus pass@k, pass^k, cost and latency;
- exits 1 on `passed:false` or `verdict:"regressed"`, and 2 when skipped (no key). *(Amended 2026-10-15, EVD-3: with `--baseline` it also exits 1 when the run produced no comparison: no regression block, or `inconclusive` with the progress route's `regressionReason: "baseline_unavailable"`. There is no `unavailable` wire verdict.)*

The existing `eval-decision-suggester` and `eval-drift-check` scripts keep their shape. The same command is the "run on a prompt, model or pack change" hook: it has a `--changed` flag that resolves suites bound (`evalSuiteRef`) to agents whose pack, prompt or model changed since a ref. *(CORRECTED 2026-10-15, NP-EVAL-2 / EVAL-3: until #4844 `--changed` could not select anything. It read the FILE name out of a repo-root path, so every run printed "no suite targets a changed agent" and exited 0. It now matches suites to the agents a changed pack declares (`eval-agent-suite-changed.test.ts`). It sees a PACK change; a model change outside a pack is not detected.)*

## Architect review amendments (2026-10-14, before P3/P4)

`/architect` (Track A, plus Track B for the advert) found two blockers and eight lesser findings. Every row below is binding on the implementation.

| # | Sev | Finding | Amendment |
|---|---|---|---|
| A1 | CRITICAL | The orphan sweeper (`runDispatchSweeper.ts`) claims any `pending`/`running` run whose lease expired and hands it to `executeRun`. An eval run holds no lease, so mid-flight it would be redispatched against a workflow id that does not exist. | The runner takes `setRunDispatchLease` and renews it per trial. The sweeper dispatches by kind: `metadata.eval.kind === 'agent-suite'` goes to `resumeAgentEval()`, which skips every (task, trial) that already has an `eval.scored` (recorded facts: never re-run, never re-judged). |
| A2 | CRITICAL | `:fork`, `:pause` and `:resume` resolve the run's workflow; `eval:…` has none. | All three refuse an eval run with `409 eval_run_not_forkable`. Re-evaluation is a new run with `baselineRunId`. **Cancel is supported**: the runner checks status before each trial and stops on `RunLogClosedError`. |
| A3 | HIGH | A new metadata key would need a second exclusion everywhere. | **Use the reserved `metadata.eval`** (`runDispatch.ts:75`) with a discriminator: `{kind:'agent-suite', suiteRef, agentId}`. Online evals (`workflowEvalOnline.ts:229`) and fleet stats (`workflowFleetStats.ts:134`) already skip any run carrying it. This supersedes D1's `metadata.mode`. |
| A4 | HIGH | The host cost ceiling had no defined failure. | The runner keeps a running cost total from `provider.usage`. Crossing `maxCostUsdPerSuite` stops scheduling and ends `run.failed {code:'eval_cost_ceiling_exceeded'}` with no `eval.completed`. The suite's `thresholds.maxCostUsd` only forces `passed:false`. |
| A5 | HIGH | The summary read authz was unspecified. | `GET /runs/:runId/eval-summary` uses `loadReadableRun`, the same gate as `GET /runs/:id`. It returns `404` for a non-eval run and `409` while the run is not terminal. |
| A6 | HIGH | The lane resolves compaction runlessly. An eval trial must instead use the eval run's frozen decision. | `buildLiveDispatchLane` takes a `compaction` override, and the runner passes `readCompactionDecision(run.metadata)`. |
| A7 | MED | D3 named a new `lane:'eval'`. That would change the ADR 0834 census. | Keep `lane:'dispatch'`; the resource is `evalRunId:taskId:trial`. |
| A8 | MED | The tool-boundary store (D9) holds tool inputs and results. | It is erased with its run (retention purger + subject-erasure coverage row). |
| A9 | MED | The synthetic `workflowId` must never deep-link into the builder. | The frontend branches on `metadata.eval.kind`. |
| A10 | MED | A pack-shipped suite could ask for live tools. | `onMiss:"live"` is honoured only for tenant-authored suites. A pack suite's `onMiss` is coerced to `"fail"`, and the summary records the coercion as `fixtureMissCount`. |

## P7 decisions (`/architect`, 2026-10-14)

| # | Decision | Why |
|---|---|---|
| P7-1 | **D9 capture is OPT-IN per agent** (`agent:eval-capture`, default OFF), and it captures at most 50 calls per run. Results are truncated to 16 KB, secrets are stripped, rows age out after 30 days (`kvAgeOut` + the retention purger), and a subject-erasure request deletes any matching row. | Recording every production tool call's inputs and results is an unbounded, PII-bearing store. The run-snapshot scan incident and the DB-growth watchlist are the precedent. |
| P7-2 | Capture **wraps `executeTool` in the run and chat lanes** (`maybeCaptureExecuteTool`). With capture off, the lane gets back the same function object. | The dispatch core is untouched, and the fence and compaction ratchets classify the wrapper as programmatic. |
| P7-3 | A promoted run becomes an **in-order trajectory with `argsMatch: "ignore"`**, plus **exact-args fixtures under `onMiss: "fail"`**. With `expectedContains` it is golden-graded on the output too; without it, it is a `kind: "trajectory"` task. | Outcome first, path as a constraint, and a replay that can never reach a live tool (the market consensus in the research doc). |
| P7-4 | The chat tools are classified **`untrusted`**. `run` is a **declared safe-mode ask**. None are in the default-on baseline. | Suite ids and refs are member-authored text, and widening the pinned trusted set is a security decision this feature does not need. `run` spends model calls. |
| P7-5 | **The workforce eval is not an RFC 0081 suite.** It asserts an escalation, which no suite field expresses. It keeps its own runner, but its events now go through `getEventLog().append`. | This amends D7's "rewrite onto the runner": the semantics do not map. Only the event-log bypass was wrong. |
| P7-6 | **A fail-closed trial scores 0**, not its output score (RFC 0244 §D, amended in 2.46.9). | Converged with MyndHyve. Otherwise `passRule:"mean"` could pass a suite whose every trial failed closed. |
| P7-7 | A run id in a body, query or path is decoded with `fromWireRunId` (`host/evals/runIds.ts`). | v2 run ids are tenant-bound (`<tenant>/<id>`). A raw `getRun` on the wire spelling is a false 404. |

## Post-merge architect review (2026-10-15)

`/architect` reviewed the merged system (`25d5be58c`) phase by phase, because only the pre-implementation review and the P7 decisions had one. It found 0 CRITICAL, 4 HIGH, 4 MEDIUM and 5 LOW. Everything below landed in `ee7fc1e81`, each HIGH with a test that was confirmed red with the fix removed.

| # | Finding | Fix | Test |
|---|---|---|---|
| H1 | The `evals` toggle (+ plan) was enforced only by the SPA: routes, `POST /runs {mode:"eval"}`, the chat tools and resume all ran with it off, so a plan without `evals` could still spend judge calls. | ONE predicate, `host/evals/access.ts` (`requireAgentEvalsEnabled` / `agentEvalsToolGate`): a namespace middleware on every agent-evals route, the runs branch before the idempotency claim (403, no run row), each tool (fails empty/closed), and resume (`eval_feature_disabled`; a resolver fault defers to the next sweep). The discovery advert stays host-global. | `adr0889-toggle-gate.test.ts` |
| H2 | The advertised $5 ceiling could not fail: `costEstimateUsd` was absent for every current catalog model, and judge calls were never counted. | `computeCostUsd` prices from `providers.json` first (the SSoT), the static tables as fallback. A trial with tokens but no price fails the run closed (`eval_cost_unpriced`); only the unpinned scripted mock is exempt. Judge calls are metered at an upper-bound estimate (`host/evals/cost.ts`), since the headless judge returns text only. | `adr0889-cost-ceiling.test.ts` |
| H3 | Capture rows were keyed `tenant:runId:seq` with `seq` restarting per wrap, so chat turn 2 overwrote turn 1 and promote stitched turns together. | Rows are keyed per lane invocation (`wrapId`, chronological) with a `segment` (node id); the 50-call cap is per run; promote takes an optional `wrapId`. | `adr0889-review-fixes.test.ts` |
| H4 | A promoted case copied captured tool inputs/results into the suite, outside the capture TTL and its eraser. | `eraseSubjectEvalSuites` redacts subject forms inside task `input`/`expected`/`fixtures`, overriding `lockedAt`. No age-based purge of suites: a promoted task is authored work-product made by an explicit act, and erasure is the DSAR path. | `adr0889-review-fixes.test.ts` |
| M1 | `eval.scored` was emitted before the trial was persisted, so a crash between them re-ran (and re-paid) the trial on resume. | Persist first, then emit; on resume, re-emit any recorded trial's missing `eval.scored`, never re-run it. | `adr0889-review-fixes.test.ts` |
| M2 | A locked suite could be deleted and the ref re-created with new content; the lock was taken after the run insert. | DELETE of a locked version is `409 conflict` (`suite_locked`); the lock is taken before the insert; the Evals tab hides Delete on locked versions. *(CORRECTED 2026-10-15, EVAL-2 / EVD-1: "closed" was FALSE. The suite was resolved at create, then locked several awaits later, and `putEvalSuite` read-then-wrote with no CAS, so a PUT in that window replaced the content and a run executed the old suite while history attributed it to the new one. #4847 makes every suite write a `compareAndSwap` and the lock digest-conditioned in one swap (`409 suite_changed`).)* | `adr0889-review-fixes.test.ts`; the race: `adr0889-store-integrity.test.ts` (#4847) |
| M3 | The chat tools did not share their routes' access predicate. | `agentEvalsToolGate`: the feature check plus `assertTenantScope` (`workspace:read` for reads, `workspace:write` for `run`), the predicate `requireTenantScope` wraps. | `adr0889-p7-capture-promote-tools.test.ts` |
| M4 | `GET capture/:agentId` scans every captured row of the tenant. | **Closed (`79441a593`).** A per-(agent, run) index `agent:tool-boundary-run` is the list's point-prefix read; see §Residue closure. | `adr0889-residue.test.ts` |
| L1 | The scripted mock program is keyed by node id, not run id, so two concurrent eval runs on a test host could cross. | **Closed (`79441a593`).** The trial node id is `eval:<runId>:<taskId>:<trial>`. | `adr0889-residue.test.ts` |
| L2 | ARCHITECTURE.md's seam table has no row for `liveDispatchLane` / the agent-eval seam. | **Closed (`79441a593`).** One row names the lane, the eval run path, the one resolver, the one enumerator and the one access predicate. | — (doc) |
| L3 | A baseline was checked only for its tenant. | It must be an agent eval run of the same suite id. | covered by `adr0889-eval-run.test.ts` regression path *(CORRECTED 2026-10-15, grade-tests M4: that file had NO regression path; the `l3-same-suite` probe was vacuous. The refusal is witnessed by `adr0889-store-integrity.test.ts` (#4847): `baseline_other_suite`, plus `baseline_not_completed`.)* |
| L4 | A captured result got the free-text pass only. | It also gets `stripSecretsFromPersisted`. | `adr0889-review-fixes.test.ts` |
| L5 | Promote does not check the source run's agent against the suite's `targetAgentId`. | **Closed (`79441a593`).** `400 validation_error`, `details.reason: "agent_mismatch"`, unless `overrideTargetAgent: true` (the `POST /runs` escape); both ADR 0763 spellings of one agent match. | `adr0889-residue.test.ts` |
| kvAgeOut | `agent:tool-boundary` carried a tenant index nobody read, which the age-out lane warned about. | `tenantOf` dropped; every read is a `${tenantId}:` prefix scan. Capture defaults OFF, so production holds no markers to clean. | `adr0889-review-fixes.test.ts` |

## Residue closure (2026-10-15)

`/architect` reviewed the residue plan before coding (Track A; no wire change: RFC 0081 §A already defines `evalSuiteRef`). It raised two blocking amendments and confirmed one earlier decision. Everything landed in `79441a593`; each code fix was confirmed red with the fix removed.

| Item | What landed | Test |
|---|---|---|
| M4 | `agent:tool-boundary-run`, keyed `<tenant>:<agentStorageId>:<runId>`, holds `{calls, lastAt}` and no tool content. It is upserted on capture, aged out on `lastAt` (same 30-day TTL, so it never outlives the run's newest row), retention-purged with the rows, and re-derived or deleted whenever erasure removes a run's calls. Classified in `subject-erasure-coverage`. No backfill: capture defaults OFF. | `adr0889-residue.test.ts` (no `${tenant}:` prefix read; erasure re-derives) |
| L1 | Run-scoped trial node id. | same (the mock program is found under the run-scoped key) |
| L2 | ARCHITECTURE.md seam row. | — |
| L5 | Promote agent check. | same |
| D2 pack suites | **This was specified in D2 and never built.** `packs/agentLoader.ts` reads `evalSuiteRef` path-confined like `systemPromptRef` and keeps the parsed JSON on `ResolvedAgentManifest`; a bad file costs the suite, never the agent. `host/evals/packSuites.ts` validates it lazily and closed-world (`validateEvalSuite`), defaults `targetAgentId` to the shipping agent, and resolves it ONLY through the requested agent's own manifest (by `suiteId@version` or the manifest ref). `resolveEvalSuite` order: tenant → conformance fixture → pack. A pack suite is read-only (not in the tenant store: never locked, edited or deleted; the Evals tab shows a "Pack" chip and no Edit/Delete), never gets live tools (A10), and its run stamps `suitePack` + `suiteDigest`; resume fails `eval_suite_unavailable` if a pack upgrade changed the suite under the same ref. | `adr0889-residue.test.ts` (loads from `evals/`, invalid + escaping refs skipped, lists read-only, runs by both refs, shows in history, unreachable from another agent) |
| Architect amendment 1 (blocking) | `evals` joins `INSTALLED_PACK_SUBDIRS`. Without it a registry install copied only `schemas`/`keys`/`prompts`, so every installed pack silently lost its suite file and the closed-world marker check refused the tree. | same (the fixture pack fails to load without it) |
| Architect amendment 2 (blocking) | ONE enumerator, `listResolvableSuites(tenant, agentId?)`, feeds the suites list, the run history and the `suites` chat tool. The history is indexed per suite ref, so a pack suite missing from the enumerator would have made its runs invisible. A tenant suite with the same ref shadows the pack's. | same |
| UI focus restore | The editor replaces the panel and the scorecard and inline promote form close in place, so focus fell to `<body>`. A trigger carries `data-focus-key` and focus returns to it on close (`agent/focusKey.ts`, matched by attribute value so refs need no escaping); the scorecard returns focus to the run-history heading. | `AgentEvalsPanel.test.tsx` (red with the hand-back removed) |

**Promoted-suite age purge: decision CONFIRMED, no purge.** The architect re-examined the H4 decision and kept it. A suite is authored configuration in the same class as workflow definitions and prompts, none of which has an age purge here. A locked version is the comparability anchor for regression baselines and for any RFC 0082 `requiredEval` gate that cites a run of it, so a TTL would break those. Personal data is removed by the H4 erasure path, which reaches inside promoted task content even on a locked suite. **What would overturn it:** evidence that promote copies data the author cannot see before saving. It does not: the promoted task is shown in full in the editor.

## Grade remediation (2026-10-15)

An eight-skill grade pass ran at `d3495f816` (grade-code, -data, -ux, -tests, -ai-exchange, -i18n, -node-packs, -workflows). It found 3 test blockers, 2 workflow blockers (WF-EV-1, WF-EV-2) and 1 UX blocker (EVUX-1), and 0 chains-or-stacks violations. The fixes shipped as four streams in one combined merge train, each reviewed with `/architect` before it was coded, plus this record:

| Stream | PR · merge | Scope |
|---|---|---|
| A1 runner lifecycle | #4849 · `576700ddf` | `agentEvalRun`/`resumeEvalRun`, judge, cost, sweeper eval branch, lane |
| A2 suite store, create, routes | #4847 · `80728a9a0` | `suiteStore`/`createEvalRun`/`promoteRun`/`toolBoundary`, routes, run-delete cascade, legacy grader |
| B Evals tab UX + i18n | #4841 · `17d936b00` | `frontend/react/src/features/evals/**` |
| C packs, chat reach, CLI, chains, docs | #4844 · `02997f9b1`, and this record's PR | agent packs, `feature.evals.nodes`, the regression-gate chain, `eval-agent-suite.mts`, docs |

The grade reports themselves were session artifacts. Every finding is recorded here; what was not done points at its `EVR-*` row in `docs/steward/TODO.md`.

**Stream C's architect decisions** (the A1, A2 and B decisions are in their PR bodies):
- The eval tools are allowlisted on the Agent Author only. The Workflow Architect authors workflows, and suites target agents.
- The reach ratchet splits its exceptions: `BY_DESIGN` (`workflows.compose-and-run`, zero-granted by ADR 0369) and `UNREACHED_DEBT` (7 tools, shrink-only). Both are exact sets.
- `feature.evals.nodes.run-suite` is `role:"side-effect"`, not `action`. Only the derived side-effect floor is served the recorded outcome on a replay fork; an `action` node is re-executed and would start (and pay for) a second eval run.
- The node cancels its child eval run on abort and on timeout. It starts it through `createAgentEvalRunOnce` keyed `<workflow run>:<nodeId>` (this record's PR), the one idempotency path A2 built, so a crash-retried node gets the same eval run instead of a second one. The child still carries no `parentRunId` (`EVR-25`).
- The regression-gate chain's `suiteRef`/`agentId` default to the Agent Author's shipped suite, and `baselineRunId` arrives as a run input. A param-less copy therefore freezes no empty value (the ADR 0504 ratchet), and the ceiling was not raised.
- WF-EV-12 was declined here; see `EVR-14`.

### Every finding

Legend: a PR number means fixed there; **EVR-n** means open and tracked; *declined* gives the reason.

**grade-code (EVAL-*)**

| Id | Outcome |
|---|---|
| EVAL-1 suite `passed` ignored the trajectory constraint | #4849 (constraint-adjusted gate; the RFC 0244 §A/§B task-level trap needs a corpus note, `EVR-10`/RFC 0246). *(CORRECTED 2026-10-16: #4849 gated only the SUITE. A `passRule: "mean"` task still passed on `meanScore`, so its trials could all fail their trajectory and the task still pass. RFC 0246 §B forbids that; fixed with the 2.46.13 pin, §RFC 0246 below.)* |
| EVAL-2 suite immutability not atomic, tenant suites undigested | #4847 (CAS everywhere, digest-conditioned lock, digest for every source) |
| EVAL-3 `--changed` could not select anything | #4844 |
| EVAL-4 an unfinished baseline silently dropped the regression | #4847 (create refuses `baseline_not_completed`), #4849 (summary `inconclusive` + `regressionReason`), #4844 + this PR (CLI fails) |
| EVAL-5 cost ceiling checked only between trials | #4849 |
| EVAL-6 raw agent-id compare (ADR 0763 spellings) | #4847 |
| EVAL-7 the form round-trip dropped `includeDelegates` and coerced strings | #4841 |
| EVAL-8 the legacy `/agents/eval-run` grader | #4847 **retired** (corrections at §Context, D4, Alternative 2, §Consequences, and ADR 0547 D1) |
| EVAL-9 stale ADR text | this PR (the :274 and D8 "streams" corrections) |
| EVAL-10 history fan-out, no paging | #4847 (agent-scoped, paged); per-agent run index → `EVR-15` |
| EVAL-11 pack suites listed but not readable; "forkd" typo | #4847 |
| EVAL-12 observability | #4849 (structured logs; trials skip borrowed recall, so no production audit rows); metric counters → `EVR-11` |

**grade-data (EVD-*)**

| Id | Outcome |
|---|---|
| EVD-1 the suite lock is not atomic | #4847 |
| EVD-2 run delete orphaned `agent:tool-boundary` rows | #4847 (pg + sqlite, end-to-end) |
| EVD-3 a failed baseline silently drops the regression | #4847 + #4849 + #4844/this PR (CLI) |
| EVD-4 promote / editor lost updates | #4847 |
| EVD-5 capture opt-in outlived its agent | #4847 |
| EVD-6 per-run capture cap not atomic | #4847 |
| EVD-7 chat-tool run had no idempotency, owner or personalTenant | #4847; the run-suite node rides the same path (this PR) |
| EVD-8 `costUsd` excluded judge spend, truncated at 5 000 events | #4849 |
| EVD-9 a refused insert left the suite locked | #4847; concurrent-create residual → `EVR-17` |
| EVD-10 erased fixtures failed with no marker | #4847 (`erasedAt`/`erasedTasks`, Redacted chip in #4841) |
| EVD-11 tool-boundary eraser inconsistent | #4847 |
| EVD-12 erasure-coverage ledger row | #4847 |
| EVD-13 pack version history; tenant shadowing a pack ref | #4847 (`409 pack_suite_ref`); history by run index → `EVR-15` |
| EVD-14 no pack ships a suite | #4844 |

**grade-node-packs (NP-EVAL-*)**

| Id | Outcome |
|---|---|
| NP-EVAL-1 eval tools allowlisted by no pack | #4844 (+ reach ratchet) |
| NP-EVAL-2 `--changed` cannot fail | #4844 |
| NP-EVAL-3 no shipped pack suite | #4844 (Agent Author, Workflow Architect; hand-authored to the D9 shape, NOT promoted from captured runs). Chief-of-staff and app-builder → `EVR-25` |
| NP-EVAL-4 `evalSuiteRef` outside an installed subdir is lost on install | #4847 (refused on both lanes) |
| NP-EVAL-5 resume digest refusal untested | #4847 |
| NP-EVAL-6 a pack suite targeting another agent | #4847 |
| NP-EVAL-7 legacy-spelling refusal at create | #4847 |
| NP-EVAL-8 the ADR contradicted itself at :274 | this PR |
| NP-EVAL-9 two undocumented pack-suite rules | this PR (D2 note); a degraded-suite surface in the tab is *declined* (an invalid pack suite is a pack-author defect the pack checks should catch, not a tenant-facing state) |

**grade-workflows (WF-EV-*, Q1/Q2)**

| Id | Outcome |
|---|---|
| WF-EV-1 `maxRunDurationMs` not enforced (blocker) | #4849 |
| WF-EV-2 cancel did not stop the in-flight trial (blocker) | #4849; the provider HTTP call itself → `EVR-12` |
| WF-EV-3 sweeper abandon ceiling | #4849 |
| WF-EV-4 duplicate/missing lifecycle events on resume | #4849 |
| WF-EV-5 resume path untested | #4849 (sweeper → resume) + #4847 (digest) |
| WF-EV-6 pause/resume refusals and cancel untested | #4849 (M5) |
| WF-EV-7 progress merge under a lost lease | #4849 |
| WF-EV-8 digest every suite source on resume | #4847 + #4849 |
| WF-EV-9 `configurable` silently dropped | #4847 (refused) |
| WF-EV-10 refusal polish; fork posture | #4847 (typo, `eval_run_not_redrivable`); fork posture recorded in D1's correction |
| WF-EV-11 no chain can trigger an eval | #4844 (`ctx.features.evals`, `run-suite`, `agents.eval-regression-gate`) + this PR (once-only start); RFC 0082 `requiredEval` → `EVR-25` |
| WF-EV-12 two eval systems | *declined here*: ADR 0477 eval sets stay the chain-evaluation path; a trajectory assertion and chain-pack `evalSets[]` need their own ADR (`EVR-14`) |
| WF-EV-13 pack-suite lane has no consumer | #4844 |
| Q1 synthetic eval id vs "never hard-code" | complies with the letter; the spirit gap is recorded in D1's correction (sanctioned second executor + its obligations) |
| Q2 can a chain be evaluated / trigger an eval | trigger: #4844; evaluate: `EVR-14` |

**grade-ai-exchange (AEV-*)**

| Id | Outcome |
|---|---|
| AEV-1 unfenced judge input | #4849 |
| AEV-2 judge model unrecorded | #4849 (per-trial identity; mismatched judges ⇒ `inconclusive`); the judge's actual-model description → `EVR-5` |
| AEV-3 unbounded rubric, ceiling between trials | #4847 (caps) + #4849 (in-trial ceiling) |
| AEV-4 `allowedModels` unenforced, class unrecorded | #4847 (create) + #4849 (run) |
| AEV-5 tools reachable by no agent | #4844 |
| AEV-6 promote replays a failure as success | #4847 host stopgap (`errored_call`); the wire half is RFC 0245 → `EVR-8` |
| AEV-7 judge told it grades a "workflow output" | #4849 |
| AEV-8 judge never sees task input or fixtures | **open** → `EVR-21` |
| AEV-9 truncation not recorded | #4849 |
| AEV-10 judge failure by string prefix | #4849 |
| AEV-11 `list-suites` answers empty when refused | **open** → `EVR-20` |
| AEV-12 `run` tool cannot pin a model | **open** → `EVR-20` |
| AEV-13 `run` trust comment inaccurate | **open** → `EVR-20` |
| AEV-14 redacted args break exact-match fixtures | **open** → `EVR-22` (the `erasedAt` marker from #4847 now explains the miss) |
| AEV-15 partly scripted run reaches a real model | #4849 (`eval_mock_unscripted`); program cleanup → `EVR-13` |
| AEV-16 memory seed trust / redaction | #4849 |
| AEV-17 eval lane ≠ chat lane | **open** → `EVR-23` |
| AEV-18 no attempted-call count | **open** → `EVR-23` |
| AEV-19 weight-0 criteria cost a judge call | #4849 |

**grade-ux (EVUX-*)** — all 21 fixed in #4841, EVUX-1 (blocker) included. EVUX-4's "ask why" lands on the Agent Author, which can reach the eval tools since #4844.

**grade-i18n**

| Id | Outcome |
|---|---|
| AE-1..AE-6 | #4841; lifting `parseDecimal` to `i18n/format.ts` → `EVR-18` |
| BE-1..BE-3 | #4841 (on A2's `details.reason`/`details.rule` contract) |
| BE-4 run-start prose stays developer-facing | *declined, by design*: it is the `message`, and the UI keys on codes |
| NS-1..NS-3 native-speaker review | `EVR-4` |

**grade-tests (M*)**

| Id | Outcome |
|---|---|
| M1 mock 403 on production posture | #4847 (`mock-403` witnessed) |
| M2 trajectory as a pass constraint | #4849 |
| M3 first-unconsumed fixture | #4849 |
| M4 regression end to end; the line-214 L3 citation | #4847; citation corrected in §Post-merge review |
| M5 pause/resume refusals, cancel stop | #4849 |
| M6 summary 409 while running | #4847; cross-tenant 404 → `EVR-16` |
| M7 the remaining §G refusals | #4847 |
| M8 judge cost through the runner, thresholds | #4849 |
| M9 a real never-re-run witness | #4849 |
| M10 get-summary cross-tenant | #4847 |
| M11 pack DELETE | #4847 |
| M12 resume toggle / digest / deleted suite | #4849 |
| M13 workforce event-log witness | **open** → `EVR-24` |
| M14 locked-Delete UI case | #4841 |
| M15 `includeDelegates` round trip | #4841 |

### Correction notes made by this record

All are inline at the claim, dated 2026-10-15:
- §Post-merge review **M2** "closed": false until #4847's CAS.
- §Post-merge review **L3** test citation: the cited file had no regression path.
- §Implementation record **"pack suites unbuilt"** (:274): stale since `79441a593`.
- D8 **"streams `eval.scored`"**: the tab polls.
- §Consequences **"RFC 0084 budgets"** bound cost: nothing read a budget.
- D8 **"pack-allowlisted"**: false until #4844.
- D1 **executor obligations** (grade-workflows Q1) and the fork posture (WF-EV-10).
- **EVAL-8**: the legacy grader was retired, not folded or aliased (§Context, D4, Alternative 2, §Consequences, and ADR 0547 D1).
- Alternative 1 (**ADR 0477 reuses `trajectory.ts`**): it does not (`EVR-14`).
- D2 **pack-suite rules** (NP-EVAL-9) and D10 **`--changed`** and **`--baseline`**.

Outside this ADR, #4844 also corrected `FEATURES.md` (the "pack-allowlisted" row), `ARCHITECTURE.md` (the false "ADR 0477 reuses `trajectory.ts`" seam-row claim) and the `LLM-EXCHANGE-AUDIT.md` rows.

## RFC 0246 (2026-10-16, corpus pin 2.46.13)

RFC 0246 (`Active`, safety-fix, `GHSA-ffx7-pm5h-v6pq`) makes both pass decisions read a **gating score**: a trial that failed its trajectory, or failed closed on a fixture miss, contributes 0. Reported scores do not change (§C). Its implementation note says this host "needs only the two summary fields". That was half true. The suite verdict already gated (EVAL-1, #4849), but the task verdict under `passRule: "mean"` read `meanScore`, which is the §B defect itself.

- **§A/§B.** `buildSummary` computes the task gating score once (the EVAL-1 rule, `CONSTRAINT_LABELS` → 0). It feeds both the suite aggregate and `taskPassed(…, gatedScore)` under `mean`. `all`/`any` are unchanged: they count trial verdicts, and a trajectory-failed trial already did not pass.
- **§D.** `gatedScore` is carried on every task with `expected.trajectory`, and otherwise only when it differs from `score` (never today: a fail-closed miss already scores 0). `gatedAggregateScore` is carried on any suite with a trajectory task. Both are emitted only on the RFC 0244 wire, and only when the vendored `eval-summary` schema defines them (`rfc0246FieldsAvailable()`), because that schema is closed. This follows the RFC 0244/0247 precedent.
- **Fixtures.** `conformance-eval-trajectory-gate` and `-gate-mean` are vendored with the pin. They load under the same posture gate as the other eval-suite fixtures, so the auth deploy lists none of them and the two host legs are `inapplicable` there.
- **Tests.** `adr0889-runner-lifecycle` § RFC 0246 has three cases: the mean task, the suite, and no trajectory. With the §B argument removed and `gatedAggregateScore` dropped, the first two go red.

## Alternatives considered

1. **Extend ADR 0477 workflow evals to agents.** Rejected as the *primary* path. Its unit is a workflow case keyed by node pins, and its evidence ignores `agent.*`. It stays the workflow lane, and it gains trajectory assertions later by reusing `host/evals/trajectory.ts`, the one grader. *(CORRECTED 2026-10-15, WF-EV-12: it has not. `workflowEvalRunner.ts`/`workflowEvalSets.ts` import nothing from `host/evals/`, and a chain pack cannot ship an eval set. Declined in this ADR and moved to a follow-up ADR (`EVR-14`).)*
2. **Keep the host-ext `/agents/eval-run` grader as the eval API.** Rejected. It is not RFC-shaped, creates no run, and calls no model. It folds into D4 and its route becomes a thin alias that is deprecated in FEATURES.md. *(CORRECTED 2026-10-15, EVAL-8: no alias was ever built, and none will be. #4847 RETIRED the route, `host/agentEvalGrader.ts` and its two tests: it was env-gated off by default, had no tenant check, and only its own tests called it. A deprecated alias would have kept a second grader alive for no consumer. The conformance eval seam is a different path, `/v1/host/sample/agents/eval-run`.)*
3. **Advertise everything now.** Rejected (D7). An advert the published suite cannot validate reds our own certified cut, the "fixing a reader changes what serves" class.
4. **Let eval trials share the agent's real memory.** Rejected. Trial isolation is a MUST in RFC 0244 §B, and eval writes leaking into a production agent's memory would be a data-integrity bug.

## Consequences

- **Run quota.** One eval run consumes one run slot, regardless of task × trial count. Cost is bounded by `maxCostUsdPerSuite` and RFC 0084 budgets. *(CORRECTED 2026-10-15, WF-EV-9: "and RFC 0084 budgets" was FALSE. The eval branch passed `configurable: {}` to `buildRunRecord`, so no budget was ever read; a client's `budget` was accepted and ignored. #4847 now REFUSES unsupported `configurable` sections (`unsupported_configurable`), and #4849 enforces `maxCostUsdPerSuite` inside a trial, not only between trials. Eval spend still does not reach the tenant's ADR 0482 spend-day counter (`EVR-5`).)* *(CORRECTED 2026-10-19: it does now. #4864 (`EVR-5`) folds eval spend into the spend-day counter. That counter is per workflow, and the eval lane is exempt from its hard cap, so this is visibility plus managed-ladder bound; BYOK eval spend is bounded only by the $5 per-suite cap. See the D1 table.)*
- **The deprecated route.** `POST /host/openwop-app/agents/eval-run` is retained as a thin, deprecated alias. *(CORRECTED 2026-10-15, EVAL-8: retired, not retained; #4847.)*
- **Chat tool loop.** It becomes testable with real tool rounds (D6), which also unblocks the builder-pair cases that are manual today (`docs/evals/builder-pair-architect.md`).

## Implementation plan

| Phase | Scope | Gate |
|---|---|---|
| P1 | pure modules `host/evals/{trajectory,trialStats,regressionVerdict,efficiency,outputGrade}.ts` + exhaustive unit tests (formula tables, every match mode, sabotage-witnessed) | backend vitest |
| P2 | `dispatchMock` tool-call programs + `mock` in the tool-calling path; chat tool loop + `runAgentDispatchLive` driven through scripted rounds | backend vitest |
| P3 | `liveDispatchLane.ts` extraction (route behaviour unchanged) + fixture interceptor + ephemeral memory | backend vitest |
| P4 | suite store + resolver + CRUD routes + erasure; `runAgentEval` runner; `POST /runs {mode:eval}` branch + idempotency refactor; `GET /runs/:id/eval-summary`; advert (RFC 0081 base); workforce route onto the runner | backend vitest + `npm run ci` |
| P5 | RFC 0244 facets in the advert once the suite publishes them; conformance run against the published suite | conformance lane |
| P6 | Evals tab (suites, editor, run, live scorecard, history, regression) + 4-locale i18n | frontend build + vitest |
| P7 | chat tools + tool-boundary store + "Add to eval suite" + `eval-agent-suite.mts` + FEATURES.md + LLM-EXCHANGE-AUDIT row | `npm run ci` |

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P1 pure graders | `650333445` · #4797 | `adr0889-eval-graders` (29 tests; three deliberate breakages each turn it red) |
| P2 scripted mock tool rounds | `05709dfbf` · #4797 | `adr0889-mock-tool-rounds` (3) + the chat and agent tool-loop suites |
| P3 shared live-dispatch lane | `8c051ddba` · #4797 | the 5 structural ratchets move with the code; dispatch route suites |
| P4 eval runs, suite store, summary, advert | `628857e3e` · #4797 | `adr0889-eval-run` (7 end-to-end HTTP); #4318 test rewritten; run-limit and erasure rows |
| P5 corpus pin 2.46.8, fixtures, scripted agent | `628857e3e` · #4797 | conformance `v2-eval-trajectory-trials`: **8 executed-pass**, 1 inapplicable (the refusal leg) |
| P6 Evals tab | separate PR (`feat/agent-evals-ui`) | frontend build + vitest |
| P7 capture, promote, chat tools, live-eval command, pin 2.46.9 | this PR | `adr0889-p7-capture-promote-tools` (8); safe-mode, compaction-exemption, trust, fence and compaction ratchets; `workforce-eval` (7); conformance still 8 executed-pass at 2.46.9 |

Residue, recorded rather than silently dropped:
- **Pack-shipped suites.** No agent manifest field resolves an `evalSuiteRef` from a pack today, so suites come from the tenant store and the conformance fixtures only. *(CORRECTED 2026-10-15, NP-EVAL-8: stale. The loader landed in `79441a593` (§Residue closure), and since #4844 two flagship packs ship suites.)*
- **RFC 0244 G2/G3/G5.** These are corpus gaps, tracked in the corpus `TODO.md`.
- **This host's own certified cut** recording the 0244 rows follows its next deploy.
