# REPORT-E — Slice E: durability / compensation / operations ADRs (pass 2)

Verified against: app `/Users/david/dev/openwop-app` main = `9b2af4839` (#3325 H53 included);
spec `/Users/david/dev/openwop` main = `54f29548`; roadmap `c60ee3645`. Read-only; no suites run.
Prior audit (`PRIOR-AUDIT.txt`) treated as hypotheses; confirmations and corrections are marked.

Artifacts: ADR 0551, ADR 0554, ADR 0556 (existing); proposed ADR 0584.

Line-number convention: `path:line` is the current tree unless a commit is named.

---

## ADR 0551 — Durable workspace, queued dispatch and multi-region qualification

### 1. Identity
- Path: `docs/adr/0551-durable-workspace-queued-dispatch-and-multi-region-qualification.md` (659 lines).
- `Status:` (line 3, verbatim): "Accepted — P0 implemented 2026-08-12 (`9bd1377e2`, plus the ledger half in `bfec8b9e4`); P1 implemented 2026-08-16 (`28740fb4d`, #3275); P2 implemented 2026-08-16 (`699a9b17b`, #3284); P3 (multi-instance chaos matrix) and P4 (cross-region qualification — still a `host-evidence` row in `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md`) open. Merge provenance reconciled 2026-08-17 (H44)".
- Last substantive edit: `a847daa50 2026-08-17 12:22 docs(adr): implementation records 0548–0556 reconciled to the merged tree (H44) (#3314)`. Earlier: `699a9b17b` (P2), `28740fb4d` (P1), `022357c71`, `bfec8b9e4`, `73b7aea1b` (created).
- Sections: Context (+ CORRECTION 1/2), Decision (three sub-decisions), Boundaries audit, Feature matrix, Phases P0–P4 (:180-186), Alternatives, Implementation record (H44 provenance :271-278), P1 record (:290-405, files/tests/sabotage S1–S11/not-done/Postgres caveat), P2 record (:407-659, CORRECTION 3, metrics, operator surface, sabotage S1–S10, not-done).

### 2. What it decides
- Workspace CRUD/CAS moves into `Storage` (composite `(tenant, workspace, path)` key, monotone version, content-derived etag); the module `Map` survives only in the memory adapter (:126-131). Discovery advertises workspace only when the selected adapter passes a boot readiness check; "production posture" fails closed with memory storage (:132-134 — later reinterpreted by P2 as memory-vs-durable DSN, not a posture flag).
- Durable accepted-work outbox: a `dispatch_outbox` row is written in the SAME atomic operation as the run row; 201 = run + intent durable; a bounded worker with leases invokes the existing `executeRun`; the run-dispatch lease remains the execution fence; `setImmediate` is a wakeup hint only; a managed queue may deliver wakeups but the DB outbox is the source of truth (:137-149).
- "Qualification, not assertion": a reproducible matrix (two instances, forced process death, lease expiry, duplicate delivery, DB reconnect, region partition/recovery); multi-region capability/marketing stays absent until RFC 0150 effect fencing AND the matrix pass (:151-156).
- Wire impact: none new — the workspace advert becomes conditional (RFC 0059 stays honoured); `idempotency.crossRegion` stays absent (RFC 0150 §D). Rejected: Cloud Tasks as sole truth; "best-effort" workspace advert; sweeper-only recovery (:188-196).

### 3. Artifact quality
- **Provenance row for P0 cites the wrong witness.** :276 lists `storage-adapter-parity.test.ts` as P0's witness. That file contains no workspace test (`grep -i 'workspacefile|workspace_file|etag|If-Match'` → 0 hits; its five "workspace" hits at :560-591 are the org-scaffold "personal workspace"). The real P0 witnesses are `test/workspace-durability.test.ts` (:45-89 restart survival, :90-118 content-derived etag, :119+ WCT-1 as a DB key) and `test/workspace.test.ts` (:31-91 CRUD/CAS/413/isolation/redaction).
- **P0's verification row is not met as phrased.** :181 promises "Restart, two-instance CAS, isolation, redaction and etag tests in SQLite/Postgres". What exists: restart = sequential reopen of the same sqlite file (`workspace-durability.test.ts:53-59, 73-79`); no CONCURRENT CAS test anywhere (`Promise.all` in workspace tests only at `workspace-tenancy.test.ts:239`, unrelated); Postgres workspace CAS is exercised by NOTHING — the pg-mem double stubs `putWorkspaceFile` with `throw new Error('not exercised')` (`test/storage-postgres.test.ts:349`), and the testcontainers parity file has zero workspace cases (`test/storage-adapter-parity-testcontainers.test.ts` — its `it()` list at :158-602 covers outbox, events, idempotency, JSONB, cascade, lease). The doc comment at `storage-postgres.test.ts:343-345` says "the CAS race is covered against real Postgres in the testcontainers parity suite" — **false**.
- Internal consistency otherwise good: CORRECTION 1→2→3 chain is explicit and dated; the "no production posture" reinterpretation (:428-436) is stated with its rationale; the "Honest caveat on the Postgres evidence" (:381-389) is truthful and STILL current (see §4).
- Part V template: has decision, phase→commit, files, tests, sabotage; **no "Claim record" section** (what is advertised / not advertised lives in `agrade-wire-blocked-residue.test.ts` and the register, not in the ADR); no worker/memory limits or runtime versions in the verification records.
- Register row `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md:92` for 0551 P4 is current (updated 2026-08-17 to say P1/P2 landing does not move it).

### 4. Implementation reality on current main
| Phase | State | Evidence | Level |
|---|---|---|---|
| P0 durable workspace | LANDED `9bd1377e2` (#3167) | `workspace-durability.test.ts`, `workspace.test.ts`; sqlite mig 38 / pg mig 36; postgres CAS = one conditional `UPDATE … AND etag = $10` (`src/storage/postgres/index.ts:1053-1067`) | test-seam (sqlite only); Postgres workspace = **schema only** (untested) |
| P1 dispatch outbox | LANDED `28740fb4d` (#3275) | `dispatch-outbox.test.ts` (kill-after-201 :198, duplicate delivery :224, status fence :246, live-lease fence :320, retry→dead :343, mig 40 :364), `dispatch-outbox-route.test.ts`, testcontainers `FOR UPDATE SKIP LOCKED` :157-213 | test-seam. Both "chaos" tests are ONE process, ONE `Storage` handle on `memory://` (:94-98), two worker-id strings (:210, :228-234). Real-PG lane: **in no gate** (below) |
| P2 readiness + ops | LANDED `699a9b17b` (#3284) | `workspaceReadiness.ts:61` flag, `:103` fatal; `discovery.ts:523` conditional advert; `index.ts:778` main()-only; `workspace-readiness-advert.test.ts` (:135 memory boot does not advertise, :143 sqlite file does, :71 refuses to start); `dispatch-outbox-observability.test.ts`, `operations-dispatch-outbox.test.ts`; `docs/SLO.md` § Dispatch queue (:330) Q1–Q4 | test-seam / local-live |
| P3 chaos matrix | OPEN | `grep -rli chaos test/ src/ scripts/` → 0; no `child_process` process-kill harness for the executor (the only spawn users are unrelated: `deploy-gates-harness`, `metrics-catalog-parity`, `pack-isolation-escape`) | — |
| P4 cross-region | BLOCKED host-evidence (RFC 0150 §D) | pin: `agrade-wire-blocked-residue.test.ts:232-242` (`crossRegion` ∉ {fenced-effects, reconciled-records}) | — |

Real-Postgres evidence gate placement (confirmed): `scripts/ci.sh:262` runs the backend suite with `OPENWOP_SKIP_TESTCONTAINERS=1` unconditionally; the `OPENWOP_CI_LIVE=1` lane (`ci.sh:689-693`) runs only `pgvector-live`, `pg-sql-live`, `opensearch-live`; `storage-adapter-parity-testcontainers.test.ts:40` returns skip under that flag. So `npm run ci:full` still never runs the outbox `SKIP LOCKED` or ledger lease tests against real Postgres. The ADR's own caveat (:381-389) says "written but not executed on the implementing machine" — it is also not executed by any lane.

Changed between `fa968b428` and `9b2af4839`: nothing in this ADR's files (#3325 touched `executor.ts` for the finalizeRun terminal guard — relevant to 0554, not 0551).

### 5. Roadmap bullet-by-bullet (`OPENWOP-A-PLUS-ROADMAP.md:546-561`)
- "Correct the implementation record to reflect the durable workspace and atomic dispatch outbox already shipped" — **DONE before authoring** (H44 `a847daa50` is an ancestor of the roadmap's baseline `10f8ba3c`; Status line + :271-278). One residual: the P0 witness cell is wrong (see §3) — a one-cell fix, not a record rewrite.
- "Run two-instance workspace-CAS and queue-delivery tests" — **OPEN**. Queue: storage-level dual-worker-id tests exist (`dispatch-outbox.test.ts:198-244`), one process. Workspace: no concurrent CAS test at all; Postgres CAS untested.
- "Add kill-after-acceptance and duplicate-delivery chaos tests" — **DONE at storage level / OPEN as chaos** (`dispatch-outbox.test.ts:198,224`; the "kill" is modelled as "nothing ran", :199-203).
- "Define backlog age, lease, redrive, and poison-item SLOs" — **DONE** (`docs/SLO.md` § Dispatch queue Q1–Q4 :330+; `dead` = poison; redrive CAS `operations/routes.ts` + `dispatch-outbox-observability.test.ts` double-redrive).
- "Fail production readiness when only process-local persistence is configured" — **DONE, differently phrased**: a `main()` startup refusal under `OPENWOP_WORKSPACE_REQUIRE_DURABLE=true` (`workspaceReadiness.ts:103-111`, `index.ts:778`) plus the DUR-1 posture guard (`deployPosture.ts:54-76`) — not a `/readiness` 503. Whether prod sets either flag is not tree-verifiable (DEPLOY.md documents `OPENWOP_DEPLOY_POSTURE=auth` :112 but not the workspace flag).
- "Implement RFC 0159 effect fencing" — **UNMEETABLE-AS-PHRASED / EXTERNAL**: RFC 0159 does not exist (`ls RFCS | grep 015[89]` → nothing); the live contract is RFC 0150 §D; a fencing build here is from-scratch, and new optional wire is under the RFC 0147 §A.1 freeze (`RFCS/0147-…md:42`; R3/R9/R14 Open in `RFCS/registers/0147-…risks.md:12,18,23`).
- "Execute region-partition, stale-owner, and failover qualification" — **EXTERNAL** (needs a second region + a harness that does not exist).
- "Advertise multi-region only after black-box evidence passes" — **DONE (already compliant)**: `crossRegion` absent, pinned `agrade-wire-blocked-residue.test.ts:232-242`.

### 6. Cross-artifact
- Depends on RFC 0059 (workspace advert), RFC 0150 §D (P4), ADR 0532 DLQ, ADR 0395 Operations, ADR 0556 P1 (metrics seam it emits through), ADR 0549 (ledger; the run+outbox txn is the same insert seam `host/runInsert.ts` the 0549/0582 admission-crash-window lives in — `routes/runs.ts:363/457/495` per prior audit; not re-derived here).
- Provides: the outbox that any durable A2A push (ADR 0552 P3) or cross-instance compensation resume (ADR 0554 P4) would ride.
- Overlap with proposed ADR 0584: Part III (:793-794) double-owns "multi-instance durability" and "multi-region effect safety" to 0551 AND 0584. Recommend: 0551 owns scenarios; 0584 (if authored) owns only the environment/harness.
- RFC 0162 (proposed) is the protocol owner in Part III; nothing in P0–P2 touched the wire, and the SLO/ops rows need no RFC. Note the corpus dangling reference the harness would inherit: `conformance/src/scenarios/staleClaim.test.ts:3` and `RFCS/0009-…md:149-150` cite `storage-adapters.md §"Claim acquisition"`, which does not exist (`spec/v1/storage-adapters.md` headings: Contract 1/2, naming, checklist, future work, see also).
- Part III row correctness: "two-instance chaos evidence" is right for the residue; the protocol owner cell should read "RFC 0150 (+ a future durability RFC)" — RFC 0162 is unauthored and frozen.

### 7. Defects & gates-that-cannot-fail
1. **False coverage claim** — `test/storage-postgres.test.ts:343-345` says the workspace CAS race is covered by the testcontainers suite; it is not (§3). Owner 0551; fix = add real-PG workspace CAS legs (sequential + `Promise.all` racing writers) to `storage-adapter-parity-testcontainers.test.ts` and correct the comment. Small.
2. **Postgres no-If-Match write is two statements, no transaction** — `src/storage/postgres/index.ts:1023-1046`: upsert (`RETURNING version`) then a separate `UPDATE … SET etag`. Two racing no-If-Match writers can leave row (v3, contentB) stamped with etag(v2, contentA) — violating "the etag is content-derived, not random" (`workspace-durability.test.ts:90`). Only reachable under concurrency, only on the create-or-replace path; sqlite path is one `db.transaction` (`sqlite/index.ts:709`). Fix: `UPDATE … WHERE version = $returned` or wrap in BEGIN/COMMIT. Small. Untestable today (defect 1).
3. **Real-Postgres outbox/ledger parity runs in no gate** — `ci.sh:262,689-693`; the file's own soft-skip. Gate placement, owner 0551/0549. Add it to the `OPENWOP_CI_LIVE=1` list.
4. **H44 P0 witness cell wrong** (:276) — doc fix.
5. No concurrent workspace CAS test on either adapter — the P0 gate row (:181) reads "two-instance CAS" but nothing can turn red if the CAS predicate were dropped from the sqlite path other than the sequential If-Match 409 test (`workspace.test.ts:48`), which does not exercise a race.

### 8. Verdict
The roadmap's 0551 section is ~half stale (bullets 1, 4, 5, 8 done; 2/3 done at storage level) and mis-frames the fencing bullet on an unauthored RFC. The ADR itself is honest and current on P1/P2; it needs three corrections: the P0 witness cell, the P0 verification row (state that concurrent/Postgres CAS is untested), and the false comment in `storage-postgres.test.ts`. The genuinely open work is ONE asset — a bounded two-process harness (two `createApp` boots on one sqlite file / real PG, real process kill, concurrent claim, concurrent workspace CAS) run in the `ci:full` live lane — which also unblocks 0554 P4 / 0556 P4 / 0584. Priority **P1** (harness + the real-PG lane placement); fencing/region **P2/external**.

---

## ADR 0554 — Compensation saga and operator recovery runtime

### 1. Identity
- Path: `docs/adr/0554-compensation-saga-and-operator-recovery-runtime.md` (1480 lines).
- `Status:` (line 3, abridged verbatim): "Accepted — P0–P2 + the wire advert implemented; P3/P4 open. … **P3 Operations recovery SHIPPED 2026-08-17** — three distinct RBAC scopes … The three triggers beyond `node-failure` remain P3 residue. **S36 … honoured end-to-end 2026-08-17**; **S37 DECIDED (A)** … P4 (chaos qualification) open."
- Last edits: `9b2af4839` (#3325, +31 lines: the finalizeRun CROSS-REFERENCE note :534-566), `76a684281` (#3322, P3 record), `a847daa50` (H44), `d209d8009` (wire flip), `800b6f0da` (P2), `4c413d4c0` (P1), `595cb40e9` (P0), `73b7aea1b` (created).
- Sections: Context, Decision (+ CORRECTION 2026-08-14 "THE RFC WINS" table :24-46), Model, Boundaries, Feature matrix, Phases (:98-115 incl. added Wire-flip and P2b rows), Implementation record (H44 provenance :121-160, P0 :162, P1 :197, P2 :255-566, Wire flip :568-730, §21 :731, UQ4 :805, P3 :869-1258, S36 :1260-1450, P4 :1451-1470), Alternatives.

### 2. What it decides
- Compensation is a MODE of the one executor + effect guard, never a second saga engine (:18-20). Model per RFC 0151 (the ADR's own pre-RFC model is explicitly overruled: separate `compensationStatus`, §C identity `(tenant, run, forwardLogicalInvocationId, ordinal, profileVersion)`, six §D events — :24-46).
- Obligation minted durably when the forward effect commits; reverse-committed-order unwind; retry on the SAME identity; partial failure parks in the ADR 0532 DLQ; operators retry/waive/escalate; high-risk composes the approval gate + SoD; forward and inverse effects cross the same broker (:48-70).
- RBAC: start/retry/waive are separate permissions (`host:compensation:start|retry|waive`, MANAGEMENT_SCOPES not PROTOCOL_SCOPES; waive owner-only; substitute filed under waive — :876-912). Operator surface is host-ext under `/v1/host/openwop-app/operations/runs/:runId/compensation[/actions]` (:871-874).
- Wire: advertises `capabilities.compensation` + `compensationStatus` on every RunSnapshot + retires the `openwop-compensation` opt-out from ONE constant (`host/compensationCapability.ts`); §21 recovery seam; UQ4 irreversible entries. No `compensating` run status. Chain lane (P2b) rides RFC 0157.
- Rejected: DB rollback for external effects; feature-local sagas; automatic compensation for every failure (:1472-1480).

### 3. Artifact quality
- **Provenance table stale**: :133 `| P3–P4 | — | — | **open** | — |` — P3 landed as `76a684281` (#3322), and #3322 edited this file without updating the row. (Prior audit: confirmed.)
- **Status line self-inconsistent**: opens "P3/P4 open" then "P3 Operations recovery SHIPPED" in the same sentence chain (:3). Readable, but a `Status:`-line reader stops at the first clause.
- Register drift: `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md:94` (last touched `a847daa50`, before #3322) still says "cancellation-triggered unwind and the sweeper/drain-loop terminal paths … are P3" — P3 shipped WITHOUT them; the ADR's own "What P3 did NOT ship" (:1236-1245) says so. The register test row `agrade-wire-blocked-residue.test.ts:198-207` is labelled `phase: 'P3'` for the same residue — the label has decayed while the residue is real (it now describes un-phased work).
- Correction discipline is exemplary (five dated corrections, an "ASKED, NOT INVENTED" S36 table :1213-1234, the H53 cross-reference :534-566 that explicitly says "This does NOT close the bullet above").
- Acceptance criteria: the P2 gate "Payment/message adversarial fixtures prove no duplicate compensation" (:110) is met with SYNTHETIC inverse nodes only (`compensation-unwind.test.ts:197-360`: effectKind `payment` ×3, `notification` ×1) — not per-effect adapters; the roadmap bullet asks for six kinds.
- Part V template: decision/implementation/verification present; no "Claim record" section (the advert facts are in the wire-flip record :568-730 and the residue test).

### 4. Implementation reality on current main
| Phase | State | Witness |
|---|---|---|
| P0 inventory | LANDED `595cb40e9` | `effect-sender-inventory.test.ts` |
| P1 ledger | LANDED `4c413d4c0` (#3214) | `compensation-ledger.test.ts`, `compensation-seam.test.ts` |
| P2 unwind/retry/approval/DLQ | LANDED `800b6f0da` (#3274) | `compensation-unwind.test.ts` (ADVERSARY 1–4 :197-360), `compensation-policy.test.ts`, `compensation-approval-sod.test.ts` |
| P2b chain carry | LANDED `1b2dd6fbb` (#3292) | `chain-compensation-carry.test.ts` (21) |
| Wire flip + §21 + UQ4 | LANDED `d209d8009` (#3294) | `compensation-operator.test.ts`, `agrade-wire-blocked-residue.test.ts:729-800` |
| P3 operations recovery | LANDED `76a684281` (#3322) — AFTER the roadmap baseline | `compensation-recovery-rbac.test.ts` (:103-422 — ladder, SoD incl. startedBy :325, waiveRequiresApproval :244-292), `-audit.test.ts` (:88-299 chain, omission, mutation, crashed-middle), `-partial.test.ts` (:109-421 concurrent waives/retries, expectedState 409, sub-run through root, audit-append failure), `-route.test.ts` (:181-341 HTTP RBAC/404/toggle), frontend `src/runs/RunCompensationPanel.tsx` + `__tests__/runCompensationPanel.test.tsx` |
| S36/S37 | LANDED (#3322) | rbac test :244-292 |
| Triggers beyond `node-failure` | OPEN | see §7 trace |
| P4 chaos | OPEN | :1451-1470 |

Evidence levels: local strict `compensation-behavior` 6/6, `-recovery` 3/3 (INTEROP-MATRIX:281); **deployed-wire** advert/§B/§D-rollup/ordering/replay-no-refire on `app.openwop.dev` (`756a9938d`), `-recovery` 0/3 `seamAbsent` on the deployed origin (test seam unmounted in prod) — INTEROP-MATRIX:281.

**Changed between `fa968b428` and `9b2af4839` (#3325):** `src/executor/executor.ts` gained (a) `armRunAbort(run.runId, runDeadlineAt)` (:1633) so in-flight MCP calls observe cancel/deadline, and (b) a terminal guard at the TOP of `finalizeRun` (:1912-1946): if the row's recorded status is terminal and differs from the computed disposition, return early WITHOUT appending events — a cancelled run stays cancelled. Side effect the cross-reference note (:534-566) does not spell out: because the guard returns BEFORE the `disposition.status === 'failed'` branch (:2066-2081), **a run cancelled mid-drain whose last node then fails does NOT unwind** either — the guard closes the "cancel silently reverted" hole and, in the same move, forecloses the one path by which a cancelled run could previously have reached `unwindTerminatedRun`. Net: cancel-triggered unwind is now unreachable by any route.

### The initiation trace the brief asked for (every unwind site vs every terminal-failure path)
Sole unwind initiator: `unwindTerminatedRun` is imported once (`executor.ts:79`) and called once (`executor.ts:2081`, inside `finalizeRun`'s failed branch) with NO `trigger` argument → `compensationRuntime.ts:405` defaults to `'node-failure'` and gates on `policyAdmitsTrigger(policy, 'node-failure')` (`compensationUnwind.ts:159-165`; fallback set = `['node-failure']` :157). Trigger vocabulary (closed): `node-failure | run-cancel | cap-breach | operator-request` (`compensationUnwind.ts:141`, `schemas/compensation-policy.schema.json:21-29`).

| Terminal path | Site | Reaches unwind? | Obligations after |
|---|---|---|---|
| Graph build/hydrate error | `executor.ts:1442` `emitTerminalFailure` | no | **never minted** (no node ran) — fine |
| Secret resolution failure | `:1562` | no | never minted — fine |
| Handoff-contract violation | `:1579` | no | never minted — fine |
| Node terminal failure (after retries) | `markFailed` (:1787) → disposition failed → `finalizeRun` → `:2081` | **yes**, label `node-failure` | unwound (the ONE implemented trigger) |
| Node-execution cap (`recursionLimit`) | `:1668-1687` `cap.breached{kind:'node-executions'}` + `markFailed(recursion_limit_exceeded)` → `finalizeRun` → `:2081` | yes, but under the **wrong label** (`node-failure`, not `cap-breach`) | policy `['cap-breach']` → NOT unwound (spec says it should); policy `['node-failure']` → unwound on a breach the author did not list. Two-sided |
| Run-duration cap (RFC 0058) | `breachRunDuration` :1637-1662 → `cap.breached{kind:'run-duration'}` → `emitTerminalFailure` DIRECTLY | **no** | **stranded at `requested`** → snapshot `compensationStatus: pending` forever |
| Scheduler stall | `:1860-1864` `emitTerminalFailure` | no | stranded |
| RFC 0094 cancel | `host/runCancel.ts` (107 lines, zero `compensation|unwind` refs) sets `cancelled` + cascades; executor's `finalizeRun` guard (:1938-1946) then returns early on the failed disposition | **no** (either route) | stranded; `onParentCancel` (validated only, :1236) never consulted |
| Dispatch failure | `host/runDispatch.ts:128` `dispatch_failed` | no | usually never minted (run never started); if a resumed run had prior effects — stranded |
| Chronic orphan (sweeper) | `host/runDispatchSweeper.ts:142` `dispatch_abandoned` after `MAX_REDISPATCH_AGE_MS` | no | stranded (a run that committed node 1 then crashed repeatedly) |
| Operator `start` (host-ext) | `features/operations/routes.ts:637-760` → `resumeUnwindForOperator` (`compensationRuntime.ts:475-520`) | yes — and it deliberately SKIPS `policyAdmitsTrigger` (:461-473) | see defect 3 |

**"Obligation minted after effect commit, outside any txn, fail-quiet" — verified line by line.** `executor.ts:1712-1735`: `runOneNode` returns `success` (the node body's effects have already crossed the effect seam and committed) → `markCompleted` (in-memory snapshot) → `await recordForwardObligation(...)`. `compensationRuntime.ts:168-323`: declaration/irreversible branch → `recordObligation(...)` inside `try { … } catch (err) { log.error('compensation_obligation_record_failed' | 'compensation_irreversible_record_failed', …) }` (:243-249, :316-322) — no rethrow, no node/run failure, no metric (`openwop.compensation.obligation` is emitted only on ledger success, `compensationLedger.ts:447`). Consequence: a committed effect with a failed mint is absent from the plan; a later unwind reports `completed`/`none` for a run that still owes an inverse — the "wrong answer that looks right". Spec `compensation.md:171-172` puts every committed declaring node in the plan. No test covers the mint failing (`grep compensation_obligation_record_failed test/` → 0). Prior audit: **confirmed**.

### 5. Roadmap bullet-by-bullet (:589-606)
- "Implement all accepted triggers, not only terminal node failure" — **OPEN** (trace above).
- "Until completion, advertise only the trigger actually implemented" — **UNMEETABLE-AS-PHRASED**: `capabilities.compensation` is closed over `supported/profileVersion/orderingModels/manualIntervention` (schema; ADR :1236; register :94) — there is no trigger advert surface, and the policy schema mandates refusal only for unadvertised `orderingModel`/`profileVersion` (`compensation-policy.schema.json:13,19`). Honest interim: registration-time refusal, which needs an RFC 0151 erratum (frozen family, but a refusal rule is a safety fix).
- "Add run-cancel, cap-breach, and operator-request initiation" — **OPEN** for run-cancel and cap-breach; operator-request exists as a host-ext `start` that BYPASSES the policy trigger list (defect 3), so "implemented" would be an over-claim.
- "Complete reverse unwind and nested-chain ordering" — **DONE** (`reverse-completion` implemented, `dependency-graph` deliberately not advertised; sub-run ordinal scoping `executor.ts:1416` + `resolveCompensationRoot` :311-322; `compensation-unwind.test.ts:119-196`, `:560-631`).
- "Add retry, approval, waiver, substitution, termination, and DLQ flows" — **DONE** (P2 + P3; S36 honoured; tests in §4).
- "Expose the canonical RFC 0158 recovery surface" — **FALSE-PREMISE / EXTERNAL**: no RFC 0158 exists; the canonical family is `compensation.md` G7, held under RFC 0147 §A.1 (`compensation.md:440`); §21 seam + host-ext is the honest position (ADR :869-874).
- "Add an operator UI with RBAC and separation of duties" — **DONE** (#3322; `RunCompensationPanel.tsx`; SoD extended to `startedBy` — rbac test :325-346).
- "Crash-test every compensation-ledger transition" — **PARTIAL**: mid-unwind resume (ADVERSARY 1), duplicate plan (2), duplicate forward commit (2b), retry exhaustion (3b), crash between action and audit (`-partial.test.ts:390-421`), concurrent operator actions (:115-171) — DONE; the MINT window (defect 1) and cross-instance stale worker (P4) — OPEN.
- "Prove replay and fork do not re-fire compensation" — **replay DONE** (`compensation-seam.test.ts:184-250`, ADVERSARY 4; §F two fences `compensationRuntime.ts:193-197, 425-447`); **branch fork OPEN/UNDECIDED**: host says "a branch fork … unwinds its own" (`compensationRuntime.ts:443`), no test, and the spec leaves the branch rollup open (`compensation.md:437` G4).
- "Add adversarial fixtures for payment, notification, webhook, email, blob, and broker effects" — **PARTIAL**: payment + notification synthetic only (`compensation-unwind.test.ts:197-360`); blob-write classified closed by ADR 0563 per P0.

### 6. Cross-artifact
- Rides RFC 0151 (Accepted; `compensation.md` still `Draft` prose), RFC 0150 §B identity (ADR 0549 P3 `host/effectIdentity.ts`), RFC 0157 (P2b), RFC 0049 (operator authority record), RFC 0051 approvals, ADR 0532 DLQ, ADR 0556 P1 metrics (`openwop.compensation.*`).
- 0551: the terminal chokes it needs to close (`emitTerminalFailure` callers in sweeper/runDispatch) are 0551's dispatch surface; the P4 cross-instance "exactly one wins" needs 0551 P3's harness.
- 0553 P3 (#3325) touched the finalizeRun seam (cross-reference :534-566) — same seam, two ADRs; the ADR handles this correctly by naming it once.
- RFC 0147 §A.1: trigger implementation is host-local (no wire); `supportedTriggers`/G7 endpoints/G6 reasons are frozen (`compensation.md:439-442`); a registration-refusal erratum is arguable as safety.
- Corpus risk register R9 (`0147-…risks.md:18`) still says "no host advertises" — stale since the flip; slice B/A concern but it mis-states this host.
- Part III rows (:795-797): "Compensation trigger over-claim → RFC 0158 / ADR 0554 / one non-vacuous test per advertised trigger" — vacuous until a trigger advert exists; today the honest measure is "one non-vacuous test per trigger the policy schema ACCEPTS". "Operator recovery portability → RFC 0151, RFC 0158 / ADR 0554 / authenticated black-box recovery tests" — cannot be deployed-wire while the only observation path is the §21 seam (G9); the host-ext routes are black-box-testable but non-portable by rule 5.

### 7. Defects & gates-that-cannot-fail
1. **Mint window fail-quiet** (above). Owner 0554. Fix: (a) surface a failed mint as a run-level fault or at minimum a metric + a `manual_intervention_required`-shaped marker so the plan cannot report `completed`; (b) a test that makes `recordObligation` throw after a committed effect and asserts the run does NOT report `compensationStatus: none/completed`. Small.
2. **Three of four triggers never fire; cap breach mis-labelled; run-duration/stall/cancel/sweeper/dispatch chokes strand rows** (trace). Owner 0554. Fix shape the ADR itself names (:1240-1244 → resolve a definition at `emitTerminalFailure` via `resolveDefinitionForRun`, pass the right `trigger`; cancel → `unwindTerminatedRun({trigger:'run-cancel'})` honouring `onParentCancel`; `finalizeRun` guard must not skip the unwind for a cancelled run). Medium. Tests must register a policy naming ONLY the trigger under test (else vacuous — the fallback set already admits `node-failure`).
3. **NEW — operator `start` has no run-state gate and bypasses the authored trigger list.** `operations/routes.ts:637-760` → `decideCompensationOperatorAction` checks tenant + operator only (`compensationOperator.ts:92-106`); `applyRecoveryAction`/`compensationRecovery.ts` never reads `run.status`; `resumeUnwindForOperator` skips `policyAdmitsTrigger` by design (`compensationRuntime.ts:461-473` — argued for RESUMING a plan already authorized into existence). But `start` is not a resume: rows sit at `requested` from mint on EVERY run, including running and successfully-completed ones, so an admin can invoke an inverse against a run that is still executing forward, or undo a healthy completed run's effects, and a policy that omits `operator-request` cannot prevent it (schema :29 "A trigger not listed here does NOT start an unwind"). Fix: for `start`, require `isTerminalRunStatus(run.status)` AND `policyAdmitsTrigger(policy,'operator-request')` (or a plan already frozen — i.e. `compensation.requested` recorded); keep the bypass for retry/skip/substitute/terminate on a plan that exists. Small; test = start on a `running` run and on a completed run with a `['node-failure']`-only policy → 409/403.
4. **NEW — successful run with a declared inverse reports `compensationStatus: pending`.** `foldCompensationStatus` (`compensationLedger.ts:845-889`) reads ROW state; rows are minted at `requested` (:433) on forward commit; a run that then COMPLETES has no unwind, no `compensation.requested` event (emitted only at `unwindRun`, `compensationUnwind.ts:425`), yet the fold hits `:887 if (list.every(r => r.state==='requested')) return 'pending'`. Spec: `compensation.md:301` `pending` = "`compensation.requested` recorded and `compensation.started` has not"; `:169-170` "the run ends with `compensationStatus: none`" when no trigger fires; `run-snapshot.schema.json:39` "`none` when no compensation was ever requested". So every healthy run through a compensator-declaring node carries a false `pending` on `GET /v1/runs/{id}` and in the list projection (`routes/runs.ts:1358`), and the P2 SLO/ops panels would read a stuck unwind. Witnesses cannot catch it: `compensation-ledger.test.ts:224-226` pins the wrong semantic ("none started ⇒ pending" on rows never requested); `agrade-wire-blocked-residue.test.ts:729-775` and corpus `compensation-behavior.test.ts:172-185` fold only a run the seam UNWOUND. Fix: distinguish mint-time `requested` from plan-frozen `requested` (a plan marker, or fold `none` unless the run is terminal-failed/cancelled or a `compensation.requested` event exists), plus a test on a completed run. Small–medium. Owner 0554. This is also the reading that makes the "stranded rows" in defect 2 visible as `pending` — the two interact: fixing 4 naively (`none` for non-failed runs) would HIDE the stranded rows on cancelled/timed-out runs; the marker approach keeps both honest.
5. Branch-fork behaviour untested and spec-undecided (G4) — pin the host's current choice with a test and record it as a G4 input.
6. Register :94 / test row label decay (doc). Provenance :133 (doc).

### 8. Verdict
The roadmap's 0554 section is stale on 4 of 10 bullets (unwind/nested, flows, UI+RBAC+SoD, replay), false-premised on RFC 0158, and unmeetable on "advertise only the trigger implemented". The ADR is the most self-critical document in the program and is broadly accurate; it needs the :133 row and the register :94 fixed, and it should ADD defects 3 and 4 above, which it does not currently name. The A+ work is app-only and needs no RFC: triggers + terminal chokes (defect 2), the mint window fail-visible (1), the `start` gate (3), the fold semantics (4). Priority **P1** — an advertised family whose snapshot lies `pending` on healthy runs and whose fail-quiet mint can report a clean unwind is what an auditor finds first; defect 3 is a P1 safety item (an admin can fire an inverse against a live run).

---

## ADR 0556 — Production metrics, workload identity and assurance operations

### 1. Identity
- Path: `docs/adr/0556-production-metrics-workload-identity-and-assurance-operations.md` (1162 lines).
- `Status:` (line 3, verbatim): "Accepted — P0 (metric catalog, SDK/export/shutdown, cardinality lint) implemented 2026-08-14 (`b62d0080f`, #3202); P1 (seam instrumentation + SLOs) implemented 2026-08-16 (`0433125fa`, #3277); **P3 §A/§B (workload identity + delegated actor chain) implemented 2026-08-16** (`8fbed15d4`, #3278), completed by **H28** — the §B chain-bound reason codes + hop scope narrowing — 2026-08-16 (`3653cd90d`, #3283, `workload-identity-chain-bounds` 0/4 → 4/4); **P2 (Operations projection/alerts) implemented 2026-08-17**; P4 open; §C/§D/§E deliberately not claimed. Merge provenance reconciled 2026-08-17 (H44)".
- Last edits: `2fb186f02` (#3318, P2 record), `a847daa50` (H44), `5a902f30c`, `8fbed15d4` (P3), `0433125fa` (P1), `b62d0080f` (P0), `73b7aea1b` (created).
- Sections: Context, Decision (OTel family / workload+delegated authority / Operations projection :32-72), Boundaries, Feature matrix, Inbound dependency (0549 metrics :101-114), Phases (:116-125), Implementation record (H44 :137-152, H28 :154, P0 :180-294, P1 :295-592 with CORRECTION 1–5 and a 32-sabotage table, Alternatives :593, P3 §A/§B :602-816, P2 :817-1162 with an architecture-review section and a second sabotage table).

### 2. What it decides
- ONE OTel provider family (metrics beside the existing traces), a metric catalog with names/units/owners/cardinality budgets, forbidden labels (tenant/run/user/key/URL/prompt/tool args), a cardinality guard that REFUSES; readiness stays dependency-oriented; production qualification requires a healthy exporter or an explicit local-scrape profile (:34-51).
- Workload identity per RFC 0154: actor vs executing workload as TWO facts; short-lived audience-bound worker credentials; every outbox/A2A/MCP/sandbox/compensation action records both; replay does not remint broader authority (:53-66).
- Operations projection reads aggregated telemetry; it is not a second metrics DB or tracing UI (:68-71).
- Wire: `capabilities.auth.workloadIdentity` advert DERIVED from configured roots (`schemes[]`), `senderConstraint[]` = what the host REQUIRES (default `[]` = the RFC 0154 §C bearer-fallback declaration), `delegation.maxChainDepth` = the enforced bound (`routes/discovery.ts:107-146`). No new wire beyond RFC 0154.

### 3. Artifact quality
- **Provenance row stale**: :149 `| P2 (Operations projection) and P4 | — | — | **open** | — |` — P2 landed as `2fb186f02` (#3318), which edited this file (added the P2 record) but not the row. (Prior audit: confirmed.)
- Status line correct on P2; the phases table (:121-124) already says P2 SHIPPED. Internal inconsistency = the H44 table only.
- The P1 phase row (:121) says "19 catalog metrics wired at 22 seams … 26 objectives"; the tree today has 24 catalog names (`src/observability/metrics.ts` `name: 'openwop.…'` ×24 — the +5 are 0551 P2's three outbox metrics, `openwop.compensation.recovery` (0554 P3), `openwop.pack.isolation.dispatch` (0555)) and `docs/SLO.md` P2 says 31 objectives — a count-drift, not a claim error (the ADR's P2 record notes 31).
- Honesty sections are strong: "What is NOT done" for P3 (:755-782) and P2 (:1008-1024) — the ADR itself names the authz metric gap, sender-constraint non-implementation, no fleet aggregation, no alert delivery, no drill.
- Part V: no "Claim record"; verification records carry counts and sabotage tables but no worker/memory limits or runtime versions.

### 4. Implementation reality on current main
| Phase | State | Witness |
|---|---|---|
| P0 | LANDED `b62d0080f` | `metrics-catalog-parity.test.ts`, `metrics-golden-telemetry.test.ts`, `metrics-cardinality.test.ts`, `scripts/check-metric-labels.mjs` in ci |
| P1 | LANDED `0433125fa` | `metrics-seam-coverage.test.ts`; `docs/SLO.md` (sections :161-374: availability, execution, replay/effect, idempotency, compensation, interrupts, cross-host, providers, sandbox, assurance freshness, dispatch queue, "Not yet measurable") |
| P2 | LANDED `2fb186f02` (#3318) — before the roadmap baseline | `slo-projection.test.ts` (35), `slo-projection-doc-parity.test.ts`, `operations-slo-route.test.ts`, `operations-slo-route-profile-off.test.ts`, `metrics-local-scrape.test.ts`, `docs/runbooks/slo-alerts.md` (27 headings; anchors pinned by `slo-runbook-anchors.test.ts` per :10-12) |
| P3 §A/§B | LANDED `8fbed15d4` + H28 `3653cd90d` + H27 `9b342b3be` | `workload-identity-resolver.test.ts` (§A :113-201, closed shape :202-232, §B chain :233-355, minted creds :356-439, **confused deputy :440-514**, salted subjects :516+), `workload-identity-surface.test.ts` |
| P3 §C/§D/§E | NOT CLAIMED (deliberate) | `senderConstraint: []` derived; no DPoP/mTLS verifier (below) |
| P4 | OPEN | `deploymentAttestation.ts:57-100` has no telemetry/SLO block |

Sender constraint, precisely: `parseSenderConstraints` (`workloadIdentity.ts:381-389`) reads `OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS` (`mtls|dpop`); the resolver enforces at `:774-777` by comparing a LABEL (`identity.keyBinding?.method`) to the configured set. `verifyWorkloadCredential` (`:640-700`) never populates `keyBinding` (identity built at :686-694 without it), so with a constraint configured EVERY real credential is refused `sender_constraint_missing`; the only caller that can set `keyBinding.method` is the test seam (`routes/workloadIdentitySeam.ts:103`, refused unless `OPENWOP_TEST_SEAM_ENABLED=true`). Net: configuring a constraint = advertising `senderConstraint:['dpop']` + a self-DoS, not an accepted-but-unverified proof — fail-closed, but the advert would still claim a scheme with no verifier. RFC 0154 §C makes sender constraint **SHOULD** and the empty array a compliant bearer-fallback advert (`spec/v1/auth.md:189-191`).

Deployed reality: `auth.workloadIdentity` is env-gated OFF in production (INTEROP-MATRIX:289 "`inapplicable` on the wire") — evidence level for P3 = local-live/test-seam; deployed-wire = not applicable. Telemetry: no OTLP collector is tree-verifiable; the P2 projection is per-instance local-scrape by design (:1010-1014).

Changed between `fa968b428` and `9b2af4839`: nothing for 0556.

### 5. Roadmap bullet-by-bullet (:624-640)
- "Instrument execution, dispatch, compensation, interop, authentication, storage, and recovery seams" — **MOSTLY DONE**; missing = authentication/authz decision counter and storage — both named by the ADR (:770-777). `openwop.compensation.recovery` (recovery) exists.
- "Define measurable SLIs and SLOs" — **DONE** (`docs/SLO.md`; bijection-tested per `slo-projection-doc-parity.test.ts`).
- "Add alert thresholds and operator runbooks" — **DONE** (`docs/runbooks/slo-alerts.md`, projection raises; delivery is deliberately not built :1020-1024).
- "Build an RBAC-protected operations projection" — **DONE** (#3318; superadmin host-ext route; `operations-slo-route.test.ts`).
- "Implement sender-constrained workload identity" — **OPEN, and above the RFC bar** (§C SHOULD); DPoP is the realistic first (Cloud Run does not terminate client certs).
- "Add delegation-chain and confused-deputy tests" — **DONE** (`workload-identity-resolver.test.ts:233-355`, `:440-514`).
- "Add mTLS/SPIFFE or DPoP adapters where configured" — **OPEN**; "where configured" is currently unreachable (no verifier; JWT-SVID-shaped root only, :636-641).
- "Bind deployment attestations to telemetry and runtime discovery" — **discovery DONE by ADR 0550** (`deploymentAttestation.ts:82-86` `discoveryDigest`, verify :202-204); **telemetry OPEN** (P4). Prior audit: confirmed.
- "Include SLO evidence in release qualification" — **OPEN** (`scripts/deploy.sh:216-233` certify = conformance only).

### 6. Cross-artifact
- Rides RFC 0154 (§A/§B); ADR 0550 (attestation, P4 target); ADR 0549 (owed metrics, delivered); ADR 0551 (outbox metrics + `sweeperAuthority` on both dispatch lanes :796-807); ADR 0554 (compensation metrics; `sweeperAuthority`); ADR 0553 (MCP metrics); ADR 0555 (sandbox metrics).
- Part III (:800) "Workload identity and delegation → RFC 0154 / ADR 0556 / live sender-constrained identity tests" — the evidence cell over-asks relative to §C; honest cell = "live delegated-identity tests + a sender-constraint witness IF advertised". Part III (:805) "SLO and operations maturity → RFC 0162" — no wire is involved; owner cell should be "no RFC".
- Freeze relevance: none of P0–P4 adds wire.

### 7. Defects & gates-that-cannot-fail
1. `senderConstraint` advert derived from an env knob with no verifier behind either method — a mis-set env var produces a wire claim of `dpop`/`mtls` and refuses every credential (fail-closed self-DoS). Guard: refuse to boot / refuse to advertise a constraint the host cannot verify (i.e. until a DPoP verifier exists, `parseSenderConstraints` should reject non-empty values loudly rather than log-and-continue at :386). Small. Owner 0556 §C.
2. No `openwop.authz.decision` metric — the ADR names it (:770-777); the P2 SLO panel therefore has no identity/authz objective. Small.
3. `deploymentAttestation.ts` payload has `containerDigest` (:69) but the only writer is `scripts/sign-attestation.mjs:125` from `OPENWOP_ATTEST_CONTAINER_DIGEST`, and nothing invokes `sign-attestation.mjs` (`grep sign-attestation scripts/*.sh package.json DEPLOY*.md` → 0); `verifyDeploymentAttestation` (:187-204) checks commit + discovery digest, never the container digest. Owner 0550 (P4 of 0556 should ADD telemetry, not a second attestation).
4. No recovery drill record anywhere (`grep -i 'drill|exercised|game day' docs/runbooks docs/SLO.md` → 0) — the Phase 4 gate "runbooks are exercised" is unwitnessed.

### 8. Verdict
Roadmap treatment mostly stale (5 of 9 bullets done; 1 done-by-0550). The ADR is accurate and self-limiting; it needs the :149 row fixed and, if §C is ever attempted, a decision note that DPoP precedes mTLS on Cloud Run. Open work: authz counter (small), P4 telemetry/SLO block in the attestation (small, host-local), a drill (human), a collector on the live service (ops), sender constraint (design decision, above the RFC bar). Priority **P2/P3**; none of it is wire.

---

## Proposed ADR 0584 — Independent Runtime Qualification Environment (roadmap :747-765)

### 1. Premise check
The roadmap's implicit "why new": no production-shaped qualification separate from unit seams. Half true. What EXISTS: `scripts/ci.sh` live lane (`:689-702`, testcontainers for pgvector/pg-sql/opensearch, opt-in), the release-artifact conformance lane (`:705-735`, container boot, opt-in, 1 remaining dispositioned failure), `deploy.sh --certify` (`:216-233` — strict full conformance, but it boots `createApp` LOCALLY: `conformance/run.ts:769`, never the deployed origin), `scripts/verify-deploy.sh` (commit-binding both halves), `DEPLOY-SMOKE.md` (:66-78 provenance `commitSource: image`; :80+ well-known; :84+ live RFC 0101 witness), and INTEROP-MATRIX rows that ALREADY distinguish DEPLOYED-WIRE from LOCAL-BOOT (`INTEROP-MATRIX.md:281, 289, 294`) with seams unmounted in prod (`OPENWOP_TEST_SEAM_ENABLED=false`). What is MISSING: any multi-process/multi-instance harness (0 chaos hits), any real-PG lane for the outbox/ledger/workspace parity file, an OCI image-digest binding that is actually populated and verified, and resource bounds on the harness.

### 2. Existing owners
- Scenarios: 0551 P3/P4 (:185-186), 0554 P4 (:1451-1470), 0555 P4, 0556 P4 (:124).
- Evidence/attestation/discovery digest: ADR 0550 (`deploymentAttestation.ts`, `--certify`, `verify-deploy.sh`).
- "Prohibit test-only routes and seams from counting as deployed-wire evidence": already the practice — INTEROP-MATRIX:281 records `seamAbsent` on the deployed origin and G9 (`compensation.md:442`) names it; RFC 0148 §A treats "looks fine" as `blocked`.
- Real-PG evidence: 0549/0551 own the parity file; the gap is placement (`ci.sh:262`).

### 3. Genuinely new residue
- The shared multi-process harness itself (two `createApp` boots on one durable store, real process kill, concurrent claim/CAS, cross-instance duplicate delivery) with rule-9 resource bounds; a Docker/testcontainers Postgres in the SAME lane; a populated + verified image-digest binding; the "clean-revision reproducibility" recipe.
- NOT new: scenarios, evidence vocabulary, deployed-wire vs local-boot distinction, discovery digest.

### 4. Wire/freeze/compat
Host-local. No wire. Not affected by RFC 0147 §A.1 (its OUTPUTS feed frozen RFC drafts 0159/0162, which is their problem, not this ADR's).

### 5. Recommendation
**AUTHOR — narrowed to "the shared multi-process qualification harness and its budgets" (environment + budgets + digest binding), NOT a parallel qualification lane and NOT the scenario owner.** Shape: (a) `scripts/ci.sh` live lane grows a `qualification` step that starts real PG via testcontainers, boots N=2 backend processes on it (`OPENWOP_MOUNT_LOCAL_PACKS=false`, bounded `maxForks`), and runs a small scenario pack owned by 0551/0554/0555/0556; (b) `storage-adapter-parity-testcontainers.test.ts` (+ new workspace legs) joins that lane; (c) `sign-attestation.mjs` gains a required `containerDigest` sourced from `gcloud run revisions describe` and `verifyDeploymentAttestation` checks it; (d) explicit CPU/RAM/worker budgets (this box: one backend fleet → 57 MB free, per CLAUDE.md). Acceptance tests that can go red: kill process A between `insertRunWithStartContext` 201 and `executeRun` — B must start the run exactly once (`run.started` count 1) — remove the outbox claim lease predicate and it must go red; two processes racing one workspace `If-Match` — exactly one 200 — drop `AND etag = $10` and it must go red; two processes racing one idempotency claim on real PG — exactly one winner; an attestation whose `containerDigest` differs from the live revision's image digest must FAIL verify (today: not checked). If the harness is not authored, the same content belongs in 0551 P3 + 0550, and Part III (:793-794, :810) should name 0551 once and drop the double ownership.

---

## Corrections to prior audit (PRIOR-AUDIT.txt, verified against `9b2af4839`)
1. **Confirmed** (own citations): 0554 provenance :133 stale; register :94 stale; only `executor.ts:2081` initiates an unwind, no trigger passed; runCancel zero refs; node-exec cap under `node-failure` label; run-duration/sweeper/runDispatch call `emitTerminalFailure` → stranded; mint after commit outside txn with catch-and-log (`compensationRuntime.ts:243-249, 316-322`); no branch-fork test; adversarial fixtures synthetic payment/notification; 0551 kill-after-201/duplicate at storage level (`dispatch-outbox.test.ts:198,224`), 0 chaos; crossRegion pinned :232-242; testcontainers parity in no gate (`ci.sh:262, 689-693`); 0556 :149 stale; discovery-digest binding shipped by 0550; `certify` boots locally.
2. **New since the prior audit (post-`fa968b428`)**: #3325's `finalizeRun` terminal guard (`executor.ts:1938-1946`) means a cancelled run whose last node fails now SKIPS the unwind — cancel-triggered unwind is unreachable by every route, not merely unimplemented in `runCancel.ts`. The prior audit could not have seen this.
3. **New defect the prior audit did not name**: healthy completed runs through a compensator-declaring node report `compensationStatus: pending` (fold `compensationLedger.ts:887` vs `compensation.md:169-170, 301`); no witness can catch it (`compensation-ledger.test.ts:224-226` pins the wrong reading).
4. **New defect the prior audit did not name**: operator `start` has no run-state precondition and bypasses `policyAdmitsTrigger` (`operations/routes.ts:637-760`, `compensationRuntime.ts:461-520`, `compensationOperator.ts:92-106`) — an inverse can be fired against a RUNNING or successfully COMPLETED run, and a policy omitting `operator-request` cannot prevent it.
5. **0551 P0 evidence is thinner than the prior audit's "workspace CAS single-handle"**: there is NO concurrent CAS test on either adapter, Postgres workspace CAS is exercised nowhere (`storage-postgres.test.ts:349` stub throws; testcontainers file has zero workspace cases), the H44 provenance row :276 cites a file with no workspace test, and `storage-postgres.test.ts:343-345` falsely claims testcontainers coverage. Also a two-statement no-If-Match Postgres write (`postgres/index.ts:1023-1046`) that can mis-stamp the etag under a race.
6. **Refinement on 0556 "senderConstraint trap"**: a mis-set env var does not yield an accepted-but-unhonoured claim — it refuses every verified credential (`verifyWorkloadCredential` never sets `keyBinding`, `:686-694`; enforcement `:774-777`), i.e. fail-closed self-DoS; only the test seam can satisfy a configured constraint. The advert would still name a scheme with no verifier.
7. **Refinement on "attestation binds commit, not OCI digest"**: the payload HAS `containerDigest` (`deploymentAttestation.ts:69`); it is fed only by `sign-attestation.mjs:125` from an env var, nothing invokes that script, and `verifyDeploymentAttestation` (:187-204) never checks it — so "unbound in practice", not "absent from the schema".
8. Prior audit's roadmap-wrong list for 0556 ("delegation-chain + confused-deputy tests DONE") — confirmed at `workload-identity-resolver.test.ts:233-355, 440-514` (prior cited `:440`).
9. Prior audit said 0554 P3 "3 RBAC scopes, SoD, audit chain, expectedState CAS" — confirmed by test names (`compensation-recovery-rbac.test.ts:103-166, 325-346`; `-partial.test.ts:109-200`; `-audit.test.ts:88-299`).
