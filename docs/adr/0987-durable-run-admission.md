# ADR 0987 — Durable run admission across instances (gap-closure B2)

Status: Accepted (2026-10-27, user; all recommendations). Originally: Proposed. Drafted 2026-10-26 as the decision record that Wave B item B2 of [ADR 0970](0970-platform-competitive-gap-closure-program.md) waits on. It proposes answers to planning questions **S03-G1**, **S03-G2** and **S03-G3**. Nothing here is accepted until the user accepts it, and no code has changed.

Date: 2026-10-26. Plan: [section 03](../plans/platform-gap-closure-2026-10-24/03-distributed-admission-and-resource-budgets.prd.md), requirements **S03-R1 … S03-R5 (SCALE-01)**, witnesses **S03-T1 … S03-T4**, risks **S03-K1** and **S03-K2**. Builds on [ADR 0934](0934-shared-rate-limit-for-public-token-surfaces.md) (shared fixed-window limiter), ADR 0821 D6 / P5 (monthly plan run limit), ADR 0551 P1 (run insert and dispatch outbox in one transaction), ADR 0549 H56 (idempotency commit in the same transaction), ADR 0640 (read/write traffic tiers) and ADR 0771 (operator-key buckets).

**RFC verdict: host-only, no RFC.** Admission stays host-internal. The refusal keeps today's `429` with `Retry-After`, and a strict-profile "authority unavailable" refusal uses the existing `503 service_unavailable` shape. No capability, event or advertised scale profile changes. If a later decision wants to *advertise* a global quota or scale contract, that needs an upstream RFC, which this ADR does not design.

## Context: what exists (measured 2026-10-26 on `e79425222`)

Three different things are called "limits" today, and they have different owners and failure modes.

| Limit | Owner | Shared across instances? | Measured behaviour |
| --- | --- | --- | --- |
| Request shedding (read/write tiers, per IP, per key, MCP principal) | `middleware/rateLimit.ts` | No: maps "reset per process / cold start" (`rateLimit.ts:183`) | N instances give N× the budget. The plan says this is fine for cheap shedding, and the module says so too. |
| Runs per minute / per day (session, operator key, anonymous IP) | `runQuotaMiddleware` (`rateLimit.ts:501`) | No: in-process maps (`:183–199`) | Charged on response `finish` (`:577`). A redeploy resets the day. |
| **Concurrent runs** (session cap 5, key cap 50) | `runQuotaMiddleware` + `reserveConcurrentSlot` (`rateLimit.ts:631`) | No: `sessionInflightRuns` map (`:202`) | **The plan's ">60 s slot loss" is real:** the check counts only entries younger than 60 s (`now - r.startedAtMs < 60_000`, `:567`), so a run still running after a minute stops occupying its slot. Release is an in-process `onRunTerminal` callback (`:649`), so a run that finishes on another instance (or after a restart) never releases. |
| Monthly plan runs | `host/planRunLimit.ts` `reservePlanRun` (`:67`) | Yes: `DurableCollection` + CAS | **Fail-open on both a store error (`:93`) and sustained CAS contention (`:89`).** Counts only runs started through `host/runStarter.ts` `startWorkflowRun` (`runStarter.ts:156`). |
| Public token surfaces | `host/sharedRateLimit.ts` `takeShared` (`:109`) | Yes: `kvCompareAndSwap`, fixed window | Caller-chosen `closed` / `open` failure posture. Used today only by the campaign-ops portal. |

**Lane census** (who passes which check):

- `runQuotaMiddleware` and its concurrency slot cover 6 entry points:
  - `POST /runs` (`routes/runs.ts:182`);
  - fork (`runs.ts:1825`);
  - debug-run and bulk redrive (`routes/workflowDebug.ts:226`, `:354`);
  - eval-set run (`routes/workflowEvals.ts:116`);
  - workflow-author draft (`features/workflow-author/routes.ts:73`).
- `features/creative-briefs/routes.ts:328` calls `reserveConcurrentSlot` **without** the middleware, so it is a no-op there.
- `startWorkflowRun` has **43 call sites in 34 files**: schedules, heartbeats, chat and agent dispatch, approvals, A2A, Kanban delivery, inbound webhooks, and many feature agent tools.
  - Those sites take the **monthly plan** check.
  - They take **no** per-day and **no** concurrency check.
- The six middleware routes take the per-day and concurrency checks. They do **not** take the monthly plan check: `reservePlanRun` has exactly one caller. That widens ADR 0821 P5's recorded fork follow-up to the main `POST /runs` lane as well.

**Storage primitives that already exist:**
- `insertRun` already commits the run row, the dispatch-outbox row (ADR 0551 P1) and the idempotency `complete` (`InsertRunOptions.idempotencyCommit`, ADR 0549 H56) in **one transaction** (`storage/storage.ts:62–111`).
- The Postgres adapter already serializes per key with `pg_advisory_xact_lock(hashtext(…), n)` (`storage/postgres/index.ts:777`, `:820`, `:2636`).
- Run-dispatch leases and outbox claims use `FOR UPDATE SKIP LOCKED`.
- Every run-creating lane funnels into `insertRunWithStartContext` (`host/runInsert.ts:93`; 18 other files call it).

**Test reality:**
- The repo's real-Postgres tests run through testcontainers or an external `OPENWOP_PG_TEST_DSN`. `npm run ci` skips them; only `ci:full` (`scripts/ci.sh:1449`) runs them.
- The ADR 0934 limiter test races on **pg-mem with one pooled client**, because pg-mem cannot migrate a second client (`test/adr0934-shared-rate-limit.test.ts:5–7`, `:45`). That is not a two-process witness.
- **This Mac has neither Docker nor a local Postgres** (`docker`, `postgres`, `psql` all absent, 2026-10-26). So no real-Postgres witness can run here today; see Q4.

## Decision

### D1 — One owner per kind of limit; no new admission service

- **Traffic shedding** stays in `middleware/rateLimit.ts`, per instance, and is labelled per-instance in the Operations summary. Turning every cheap request into a database write is rejected (plan S03-R2).
- **Run-count windows** (per minute, per day) move from the in-process maps to `sharedRateLimit.takeShared` fixed windows. The scope is `runs.session` / `runs.key` / `runs.ip`, the key is a digest of the session, key or IP, and the cost is the units minted. That reuses ADR 0934 instead of adding a counter.
- **Concurrency** becomes a property of the run table itself (D2), not of a counter or a reservation table.
- **The monthly plan limit** stays in `planRunLimit` (ADR 0821), extended to every lane (D3).

### D2 — Concurrency is counted from authoritative run state, inside the run insert

At admission, inside the same transaction that inserts the run, the store counts the scope's runs in the holding states (D4). If the count is under the cap it inserts; otherwise it refuses.
- **Postgres:** take `pg_advisory_xact_lock(hashtext(admissionKey), 3)`, then count and insert. The adapter already uses this primitive in partitions 1–2.
- **SQLite:** do the same inside its single write transaction.

The run row gains one nullable column, `admissionKey`. It is a digest of the scope, never a raw IP, bearer or session id (S03-R4). It has an index on `(admissionKey, status)`.

**Why count rather than reserve (S03-R3, S03-K1):**
- There is nothing separate to release. The slot is freed when the run reaches a terminal status, on whichever instance that happens, and after any crash. A reservation row could leak if a process dies between "reserve" and "attach" or between "terminal" and "release", and that would need its own fenced sweeper.
- Holding a slot past 60 s is automatic, because nothing ages out.
- Idempotent retries attach once, because they already resolve to the existing run before insert (ADR 0549 H56).
- A failed insert rolls back the admission with it.

The plan's sketched reservation state machine (reserved → attached → released) is recorded under Alternatives as the fallback if Q3 measures counting as too slow.

### D3 — Every creation lane passes one admission function

`insertRunWithStartContext` takes an `admission` argument: the scope key, the units, and the policy (D4–D5). All 18 calling files supply it. A lane that is exempt must say so explicitly (`admission: 'exempt:<reason>'`), so an exemption is visible in the code rather than an omission.
- **Monthly plan:** the `reservePlanRun` call moves from `startWorkflowRun` to this same choke point, so `POST /runs`, fork, debug, redrive and evals start counting (closing ADR 0821 P5).
- **Bulk creators:** charge one unit per minted run, as `res.locals.runQuotaUnits` already does for redrive.
- **Sub-workflow children and replay:** see Q1. A replay never counts; that rule is unchanged.

### D4 — Holding states (the proposed S03-G1 answer)

A run occupies its concurrency slot while it is `pending` or `running`, including queued workspace dispatch, which is `pending`.

A run **suspended on an interrupt or approval does not** occupy a slot, because it holds no executor. It does still count toward the per-day and monthly limits, which it was already charged for at creation.

### D5 — Failure posture follows the ADR 0981 profile (the proposed S03-G2 answer)

| Check | Strict profile (`auth`) | Evaluation profile |
| --- | --- | --- |
| Concurrency (D2) | Part of the run-insert transaction, so a store failure already fails the insert | Same |
| Run-count windows (D1) | `takeShared` `closed`: 503 when the counter is unavailable, refuse under contention | `takeShared` `open`: per-process fallback, `degraded: true` |
| Monthly plan | **Closed:** refuse on an error or sustained contention, with a 503 for errors | Open (today's ADR 0821 posture) |

Changing the strict-profile monthly limit from fail-open to closed is an **ADR 0821 correction**, recorded there in the same PR. It reaches operators through the release notes, like ADR 0981 P3.

### D6 — Observable

The Operations surface gains a superadmin `admission` summary. It reports per scope family: the configured cap, the current holding count from the D2 index query (bounded, never a global scan), refusals since boot by reason, and the failure posture in effect. Denials log the scope family and the key digest, never the raw key.

## Alternatives considered

- **Reservation rows with a reserved → attached → released state machine (the plan's sketch).** This is the fallback, not the default. It needs fenced generations and a reconciliation sweeper for every crash boundary that D2's count does not have. It would win only if counting under the advisory lock proves too slow on a hot key (Q3).
- **Put `takeShared` on the concurrency cap.** Rejected. A fixed window counts starts, not active runs, so it cannot release when a run ends (the plan says the same).
- **A distributed lock service or Redis.** Rejected. It is a second authority and new infrastructure, and the run table is already the truth.
- **Keep per-instance counting and document it.** Rejected. SCALE-01 is exactly that state.

## Witness plan — what acceptance requires before SCALE-01 moves

1. **S03-T1 (two processes):** a driver spawns **two separate Node processes**, each with its own Storage pool, against one real Postgres. They race `admit + insertRun` for one scope at cap C. The test asserts at most C rows in the holding states for that key, and that the next request is refused.
2. **S03-T2 (> 60 s):** a run kept `running` past 60 s (virtual clock in the unit test; a real sleep in the live test) still blocks the next admission. A suspended run does not (D4).
3. **S03-T3 (crash matrix):** SIGKILL one process before insert, after insert but before dispatch, and after the terminal transition. Assert no permanent slot, and the monthly count equal to the runs that exist.
4. **S03-T4 (lane matrix):** every `insertRunWithStartContext` caller is listed, and a ratchet test fails if a new caller passes no `admission` argument. HTTP, schedule, chat and agent-tool fixtures each hit the cap.
5. **Shared windows:** per-day and per-minute at cap across the two processes, with `closed` and `open` failure arms.
6. **SQLite** runs the same assertions in-process for the single-node topology it supports.

Each case gets a sabotage witness: drop the advisory lock, drop a lane's admission argument, restore the 60 s filter. The real-Postgres cases run in `ci:full` or against `OPENWOP_PG_TEST_DSN`, never against pg-mem, and the S03-R1 status records where they ran (Q4).

## Phased implementation (after acceptance)

| Phase | Scope | Exit |
| --- | --- | --- |
| P0 | Census test that pins the lane table above; reproduce the > 60 s loss and the cross-instance double admit as failing witnesses | Witnesses red on `main` for the right reason |
| P1 | `admissionKey` column + migration; D2 count-in-insert on Postgres and SQLite | T1, T2, T3 on real Postgres; SQLite parity |
| P2 | D3: every lane through one admission function; in-memory concurrency map and 60 s filter deleted; monthly plan moved to the choke point | T4 lane matrix + ratchet |
| P3 | Per-day / per-minute run windows on `takeShared`; D5 postures; ADR 0821 correction | Window cases + posture cases |
| P4 | D6 Operations summary; release-notes upgrade block | Summary witnessed; notes reviewed |

The connection budget is unchanged: admission runs on the existing Storage pool, so `poolMax × maxScale` (preflight Gate 5) does not move.

## Decisions recorded (2026-10-27)

The user accepted the recommended answer to every question below on 2026-10-27 ("proceed with your recommendations"), including the steps outside the code. The original question text is kept.

- [x] **Q1: sub-workflow children.** Should a child run take its own concurrency slot? **Recommendation: no, while its parent is running.** The parent already holds a slot and the child runs inside its budget, and a parent with N children would otherwise deadlock against a cap below N + 1. Children **do** count toward per-day and monthly limits, as new runs.
- [x] **Q2: monthly plan posture (S03-G2).** Is the plan's monthly run limit a contractual hard limit? **Recommendation: yes under the strict profile, so it fails closed per D5, and it stays fail-open under evaluation.** It is displayed on the pricing page as a limit, so it should behave as one where tenants pay.
- [x] **Q3: count-in-insert vs reservation rows (S03-G3).** **Recommendation: count-in-insert (D2), and accept it only after a measured hot-key load test.** Fall back to reservation rows only if one key's admission p95 under contention exceeds a budget you set (proposed: 50 ms at 20 concurrent creators on one key).
- [x] **Q4: where the real-Postgres witness runs.** This Mac has no Docker and no Postgres, so the two-process and crash witnesses cannot run here today. **Recommendation: install Postgres locally through Homebrew** (free, local only) and point the existing `OPENWOP_PG_TEST_DSN` hook at it. The alternatives are running `ci:full` on the other machine, which has Docker, or adding an embedded-Postgres dev dependency. Installing software needs your go.
- [x] **Q5: holding states (S03-G1).** Do you accept D4: `pending` and `running` hold a slot, and a run suspended on approval does not? **Recommendation: yes.** An approval can wait days, and holding a slot for it would let five pending approvals block a user's work.
