# ADR 0477 — Workflow evaluations: eval sets, assertion runs, the LLM-judge option, and the evals-green promote gate

Status: implemented (P4a+P4b+P4c + review fold-in, 2026-07-23 — one PR)
Date: 2026-07-23
Lane: cross-cutting seam (workflow quality) — NO new feature package, NO new
toggle (owner-gated authoring surfaces; inert until a set exists). The existing
`evals` feature (model arena) is NOT extended — only its ledger/math idioms are
copied (see Boundaries).
RFC verdict: **host work only, no new RFC.** Eval sets/results are host-ext
`DurableCollection`s; the run lane is the EXISTING debug-run dispatch template
(ordinary runs + synthetic pinned checkpoints); the promote gate extends a
host-ext lifecycle verb. Nothing on the OpenWOP wire changes.

## Why this exists

Phase 4 of `docs/WORKFLOW-ORCHESTRATION-COMPETITIVE-ASSESSMENT.md` (D5, graded
F): evaluations are the widest open gap in the 2026 market — only n8n has
workflow-level evals in the no-code tier. We already own every ingredient:
pinned upstream data (ADR 0475), revision pinning (ADR 0474), a run-output
contract, an event-log path record, and a promote gate to hang "evals green"
on. This ADR composes them into named, repeatable, assertable eval sets.

## Boundaries audit (seam exploration 2026-07-23, file:line verified)

- **The pin store cannot hold eval fixtures** — its key is
  `${tenant}:${wf}:${nodeId}` (`workflowDebugPins.ts:46`): one pin per node,
  NO case dimension. Eval cases get their OWN store; the pin `output` shape
  and sanitize discipline are reused verbatim.
- **The run lane is the debug-run template** (`routes/workflowDebug.ts:213-320`):
  ordinary run (`runs:create` scope, quota, capability refusal, ADR 0474
  revision pin) + self-describing synthetic prefix + fork-checkpoint
  `resumeSnapshot`. Eval semantics differ from debug in ONE way: pinned nodes
  are MOCKS (marked completed with the case's data) and everything else runs —
  no subgraph pruning (the case exercises the whole workflow).
- **Run output** = the terminal-node aggregation in `run.completed.payload
  .output` (`executor.ts:1593-1665`); **path record** = the ordered
  `node.completed` sequence — both already assertable (the
  `chain-backed-flagship-e2e` pattern).
- **The promote gate** is ONE clause: `hasRunForWorkflow(id,
  {status:'completed'})` → 409 `workflow_untested` (`routes/workflows.ts:448`).
  "Evals green" is a second clause with its own reason (`evals_failing`), NOT a
  parallel verb.
- **There is NO existing LLM judge.** `features/evals` is a HUMAN-rated model
  arena (`arena.ts:37-56`); reusable idioms are the `evals:*` ledger shape and
  Elo/leaderboard math only. The judge dispatch is new, on the same provider
  path AI nodes use, with typed unavailability (never silent pass/fail).
- **Terminal notification**: `onRunTerminal(runId, cb)` (the rateLimit
  slot-release bus) is the existing hook for "evaluate when the run settles".
- **No route collisions**: `…/workflows/:id/eval-sets*`/`eval-results` are free.

## Decision

### 1. The eval-set store — `host/workflowEvalSets.ts`
`DurableCollection('workflow:eval-set', key = ${tenantId}:${enc(workflowId)}:
${evalSetId}, tenant extractor)`. A set is ONE row holding its cases (atomic
edits; bounded):
```
{ key, tenantId, workflowId, evalSetId, name,
  requiredForPromote: boolean,          // the §4 gate opt-in
  cases: [{ caseId, name?,
            inputs?: Record,            // run inputs for this case
            pins?: [{nodeId, output}],  // mocked nodes (the ADR 0475 output shape)
            assertions: Assertion[] }],
  createdAt, updatedAt, createdBy? }
```
Caps: ≤10 sets/workflow, ≤20 cases/set, ≤256KB/row, ≥1 assertion/case.
Writes sanitize pins + inputs (the pin-store discipline). Assertions are a
CLOSED WORLD (invalid kind = 400, never stored):
- `{kind:'status', value:'completed'|'failed'}` — expected terminal status
  (negative tests are first-class);
- `{kind:'output-contains', value}` — substring over the JSON of
  `run.completed.output`;
- `{kind:'output-path-equals', path, value}` — dot-path deep-equal;
- `{kind:'node-completed', nodeId}` / `{kind:'node-not-run', nodeId}` — path
  assertions over the `node.completed` sequence;
- `{kind:'llm-judge', criteria, threshold?}` — §3.
Cascades: delete-with-workflow + ADR 0464 subject-eraser (createdBy redacted;
sets are tenant work-product — the revision-store precedent).

### 2. Running a set — `POST …/workflows/:workflowId/eval-sets/:evalSetId/run`
Owner-gated; `runs:create` scope; `runQuotaMiddleware` with
`res.locals.runQuotaUnits = cases.length` (the ADR 0475 batch discipline) +
`reserveConcurrentSlot` per run. Per case: an ORDINARY draft run of the FULL
head — `metadata: {launch:'draft', eval:{evalSetId, caseId, resultId}}`, the
ADR 0474 revision pin, audit row — with the case's pins applied as a
self-describing synthetic prefix + `resumeSnapshot` (pins present) or a plain
fresh run (no pins). The route answers 202 with a `resultId` immediately.

**Evaluation at terminal** (`onRunTerminal`): load the run + events, evaluate
each assertion → per-case `{caseId, runId, status: 'passed'|'failed',
assertions: [{kind, pass, detail}]}` written into the RESULT row
(`workflow:eval-result`, key `${tenant}:${enc(wf)}:${evalSetId}:${resultId}`,
keep-20 prune per set). A case whose run never terminates (an interrupt gate)
is marked `timed_out` by a per-run best-effort timer (default 120s,
`OPENWOP_EVAL_CASE_TIMEOUT_MS`) — an eval suite must always FINISH with an
honest per-case verdict. The result row records the head `revisionHash` it
evaluated (evals are revision-scoped facts).
Reads: `GET …/eval-sets` (+ per-set), `GET …/eval-results?evalSetId=…`.

### 3. The LLM-judge assertion (optional per assertion, never silent)
`{kind:'llm-judge', criteria, threshold?}` — at evaluation time the judge
dispatches ONE model call on the host's existing provider path (the tenant's
default/managed provider — the same resolution AI nodes get), with a fixed
rubric prompt: criteria + the run output excerpt → `{pass, score, reason}`
parsed closed-world. Rules: judge output is a TYPED verdict (unparseable ⇒
`judge_error`, counted as FAILED with the reason visible — never
success-with-empty); no provider configured ⇒ `judge_unavailable`, counted as
FAILED-with-reason (an assertion you cannot evaluate is not passing); the
judge NEVER sees pins/inputs beyond the output excerpt (size-capped); one
bounded retry on transport error. The LLM-EXCHANGE-AUDIT gains a row (a new
model-facing exchange: rubric out, verdict in, closed-world parsed).

### 4. The evals-green promote gate (opt-in per set)
In `lifecycleVerb('promote')`, after `workflow_untested`: for each eval set
with `requiredForPromote`, the LATEST result must exist, be `complete`, have
zero failed cases, AND match the CURRENT head's `revisionHashOf` — else 409
`evals_failing` (details: set name + failed/stale counts). Edits after a green
result honestly re-arm the gate (stale ≠ green). No set opted in ⇒ the gate is
exactly today's. FE surfaces the reason (locked-toast copy names the set and
offers "Run evals").

### 5. FE — the Evals drawer
`EvalsDrawer` (the HistoryDrawer pattern) from a BuilderToolbar menu entry:
list sets (name, case count, `requiredForPromote` toggle, last result chip
green/red/stale/running), create/edit a set (v1: name + required toggle +
cases as a validated JSON editor — the pin-editor precedent; a form builder is
a follow-on), Run now (progress → per-case results with per-assertion
pass/fail + run deep-links), delete. Save/promote failure with
`evals_failing` gets a named toast. i18n ×4; BULLETPROOF BAR states (empty,
running, judge_unavailable, stale-result).

## Matrix
| # | Dimension | Decision |
|---|---|---|
| 1-2 | package/toggle | none — core quality seam; inert until a set exists |
| 3-7 | packs/envelopes/agents/public | none; the judge is a host-internal dispatch (audit-rowed), not a chat tool |
| 8 | RBAC | all routes owner-gated (404 posture); runs carry the caller's identity + quota |
| 9 | replay/fork | eval runs are ordinary draft runs (revision-pinned, self-describing prefixes); results record the evaluated revision |
| 10 | frontend | EvalsDrawer + toolbar entry + promote-gate copy; i18n ×4 |

## Phased plan
| Phase | Scope | Gate |
|---|---|---|
| P4a ✅ | eval-set store (caps/sanitize/closed-world assertions/eraser/cascade) + CRUD + run route (batch quota, synthetic pins, terminal evaluation, timeout, result store keep-20) + assertion engine + promote gate + tests (CRUD caps + invalid-assertion 400; run→result per-assertion verdicts incl. negative status test; pins mock mid-graph nodes; timeout verdict; gate: failing/stale/green/no-optin; IDOR 404s) | backend vitest |
| P4b ✅ | llm-judge assertion (typed verdicts, unavailability = failed-with-reason, bounded retry) + LLM-EXCHANGE-AUDIT row + tests (parse/refusal/unavailable) | backend vitest |
| P4c ✅ | EvalsDrawer + toolbar entry + promote-toast + i18n ×4 | FE gates + `/ux-review` |

## Alternatives weighed
1. **Extend the `evals` arena feature** — rejected: the arena is a human-rater
   Elo surface for MODELS; workflow evals are owner-authored regression suites.
   Sharing a feature id would couple two unrelated products (the orgs↔
   accessControl lesson). Idioms copied, surface separate.
2. **Cases as separate rows** — rejected for v1: a set is edited as a unit;
   one row = atomic edits + one read; caps keep it bounded. Revisit if sets
   outgrow 256KB.
3. **Judge as a chat tool** — rejected: the judge is an internal evaluator
   invoked by the assertion engine, not an agent capability; exposing it as a
   tool would put a scoring oracle in every agent's hands.

## Review fold-in (P4, adversarial code + ux rounds — 2026-07-23)

Code round (1 HIGH proven-with-a-probe + 2 MED + 5 LOW) and ux round
(1 BLOCKING + 7) — applied except the recorded items below:

- **code HIGH-1** — `settleEvalCase` was a read-modify-write `put` on a row
  every case rewrites: the reviewer PROVED a lost update (two concurrent
  settles → a case stranded `running`, the row never `complete`, the promote
  gate wedged, the FE polling forever). The memory-store test suite masked it
  (the sqlite-masks-Postgres class). Settles are now SERIALIZED through a
  per-result promise chain (all settles for an invocation are in-process by
  construction); a concurrent-settle regression test pins it.
- **code M2** — a dispatch throw now fails the RUN closed
  (`failRunClosedOnDispatchError`, the debug-run template's discipline) —
  no zombie `running` runs.
- **code M3 / ux F3** — the drawer's poll loop is guarded by an open-ref AND
  the drawer unmounts on close (no background polling against the per-IP
  read budget).
- **code LOWs** — post-timeout terminal evaluation is skipped (no judge spend
  on a case already settled); `requiredForPromote` must be a real boolean
  (a string "true" silently de-gating promote is the closed world failing
  its own bar); the set-size cap counts UTF-8 bytes.
- **ux F1 (blocking)** — the result chip now reads `revisionHash` against the
  HEAD hash: a green result of an older revision renders "Green — older
  revision" (muted), agreeing with the gate instead of contradicting it.
- **ux F2/F6** — run/save failures surface the server's NAMED message
  (capability refusal, quota); a PUT against an unsynced draft maps to
  actionable copy instead of a raw 404 string.
- **ux F4** — Run-now discloses it runs the last-SAVED draft (the 1.5s sync
  debounce). **ux F7** — the delete confirm is announced (`role="alert"`).

**Recorded items:** (code LOW, for `/grade-data`) eval-case `pins`/`inputs`
survive DSAR erasure with attribution-only redaction while ADR 0475 DELETES
debug pins — the "tenant work-product" ruling is this ADR's §1 decision, but
the tension deserves the data-grade lens. (ux F5) the JSON editor's template
reveals 2 of 6 assertion kinds — the form builder follow-on owns
discoverability. (ux F8) title-only tooltips on the gate chip — pre-existing
app-wide pattern.

## Open questions
1. OQ1 — run cases in parallel or serial? v1: serial with a small stride (2)
   — eval workflows may hit shared external state; the timeout bounds total
   wall-clock either way.
2. OQ2 — auto-run on publish? v1: the GATE checks the latest result instead
   (deterministic, no surprise spend at promote time); a "run at promote"
   convenience button is FE-side.

## Correction note — grade-trio fold-in (2026-07-24)

1. **Unknown assertion kinds fail closed (grade-data M5).** `evaluateAssertions`'
   `switch` had no `default`, so a persisted row carrying a kind this code
   version doesn't know (rollback after a newer kind shipped; hand-edited row)
   was silently OMITTED from verdicts — a case could green the promote gate on
   an assertion that was never evaluated, violating this ADR's own
   "never 'skipped' at evaluation time" contract. Unknown kinds now yield
   `pass:false, detail:'unknown_assertion_kind'`.
2. **Stale `running` results repair to `incomplete` (grade-data M6).** Every
   settle path (timers, `onRunTerminal`, the settle queue) is in-process, so
   an instance restart mid-invocation stranded the row at `running` forever —
   a permanent lie to the FE chip and a permanent `evals_failing` at the
   gate. Reads now repair a `running` row older than 30 minutes to an honest
   `incomplete` (never silently `complete`: unsettled cases were not
   evaluated). The FE renders it as a warning chip with a re-run hint.
3. **Erasure now scrubs CONTENT, not just attribution (grade-data H3).** The
   original "tenant work-product" adjudication covered suite structure but
   not fixture payloads: case `pins`/`inputs` are run outputs users paste into
   the editor, and result `assertions[].detail` embeds run-output excerpts —
   the same content argument ADR 0475 §erasure made for pins. Subject erasure
   now deep-scrubs subject-key forms from both stores' `cases` payloads
   (over-erasure is the safe direction for a DSAR); the coverage-test rows
   record the new posture.
4. **Delete-cascade scans are tenant-bounded (grade-data M7).** The
   `onWorkflowDeleted` hooks for pins/eval sets/eval results ran full
   cross-tenant `list()` scans per deleted workflow — and the retention GC
   deletes archived drafts in a loop (the `host_ext_kv` incident shape).
   Callers that know the owning tenants (the GC, the DELETE route) now pass
   them and the cascades prefix-scan those slices; tenant-less paths
   (boot seeds) keep the full-scan fallback.
