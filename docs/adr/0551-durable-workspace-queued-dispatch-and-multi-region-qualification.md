# ADR 0551 — Durable workspace, queued dispatch and multi-region qualification

Status: Accepted — P0 implemented 2026-08-12 (`9bd1377e2`, plus the ledger half in `bfec8b9e4`); P1 implemented 2026-08-16 (`28740fb4d`, #3275); P2 implemented 2026-08-16 (`699a9b17b`, #3284); P3 (multi-instance chaos matrix) and P4 (cross-region qualification — still a `host-evidence` row in `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md`) open. Merge provenance reconciled 2026-08-17 (H44)

Date: 2026-08-11

Composes: RFC 0059 workspace, `Storage`, `host/workspaceStore.ts`,
`host/runDispatch.ts`, `host/runDispatchSweeper.ts`, `host/runEventBus.ts`, ADR
0532 DLQ and ADR 0395 Operations. RFC 0150 gates multi-region effect claims.

## Context

Discovery advertises workspace support, but `host/workspaceStore.ts:17-18`
states that it is process-local and `:47-60` stores files in a module `Map`.
Restart or a second instance loses visibility and makes CAS instance-local.

Accepted runs begin through `setImmediate` (`host/runDispatch.ts:85-113`). The
durable lease sweeper can recover crashes, but Cloud Run CPU throttling can
delay detached work substantially. The initial accepted-work handoff is not a
durable queue acknowledgment.

The app has multi-instance recovery primitives, but no published split-brain,
regional-failover, or effect-fencing qualification. It must not infer
multi-region safety from unit seams.

> **CORRECTION 1 (2026-08-11, pre-implementation verification) — this is a
> DISHONEST WIRE CLAIM, not merely a durability gap.**
>
> The Context above says "Discovery advertises workspace support" as though the
> advert were fine and only the backing store were weak. Verified against the
> corpus, it is worse than that:
>
> - `routes/discovery.ts:392` advertises `workspace: { supported: true,
>   maxFileBytes: 65536 }` **unconditionally** — no adapter check, no env gate.
> - `schemas/capabilities.schema.json` defines that flag as a "**durable**,
>   path-addressable file layer" and a "**Versioned**, tenant·workspace-scoped
>   ground-truth file store".
> - `spec/v1/agent-workspace.md:9` makes it normative and cross-host: *"a run
>   replayed on another host **MUST observe the same workspace snapshot**"* — an
>   explicit "cross-host portability and replay-determinism guarantee", called
>   out as "not an implementation detail".
> - `host/workspaceStore.ts:48` is `const store = new Map<...>()`, module scope.
>
> A module `Map` cannot satisfy any of that. It dies on every Cloud Run instance
> recycle, is invisible to the second instance of a multi-instance service, and
> makes the `If-Match` CAS instance-local — so two instances can each believe
> they won the same compare-and-set. The advertised replay-determinism guarantee
> is unreachable by construction.
>
> RFC 0059 is `Active`, so the shape is locked and the capability is real; the
> host simply does not honour it. **This is precisely the failure ADR 0548
> invariant 3 names** — "a capability is absent unless the active deployment
> profile passes its behavioral evidence" — sitting inside the program's own
> repo, on a capability the host has been claiming all along.
>
> `workspaceStore.ts` states both sides itself: line 2 calls the layer
> "durable", and line 17 admits "Process-local (best-effort)". Fifteen lines
> apart, in the same header.
>
> **Consequence for P0's sequencing.** P0 as written is "durable workspace
> schema/adapters/route". The advert half is separable and strictly more urgent:
> until the durable store exists, `supported: true` is false on every deployment
> profile, and the honest advertisement is `false`. But flipping it off has its
> own cost — the RFC 0059 conformance scenarios are gated on `supported: true`
> and would go from executing to skipping, which ADR 0550 P1 has just finished
> establishing is NOT the same as passing. Which of those two harms to accept
> first is a real decision and belongs in an architecture review, not in an
> implementer's judgement call.
>
> **CORRECTION 2 (same day, options review) — CORRECTION 1 OVERSTATED IT twice,
> and both walk-backs matter.**
>
> 1. **"A dishonest wire claim" / "the advert is FALSE" is too strong.** I quoted
>    the capability object's PARENT description ("durable, path-addressable file
>    layer"). But `supported`'s own definition is narrower: *"Host implements the
>    RFC 0059 workspace file store + endpoints + `workspace.updated` event."* A
>    module `Map` does implement those. The accurate statement is **the surface
>    is implemented; the durability guarantee the surrounding prose attaches to
>    it is not** — a partial claim, not a false one.
> 2. **It is NOT a security breach.** `workspace-cross-tenant-isolation` is a
>    protocol-tier SECURITY invariant, and its two conformance scenarios PASS:
>    keys carry the owner triple, so WCT-1 holds. An instance-local `If-Match`
>    CAS loses updates WITHIN one owner triple. That is **data integrity**.
>    Calling it security was inflation.
>
> **The measurement that decided the sequencing.** None of the 8 shipped RFC 0059
> conformance scenarios test durability, restart or multi-instance — they assert
> CRUD, `If-Match` → 409, `maxFileBytes`, snapshot-at-run-start and cross-tenant
> isolation, all in one process. So gating the advert off FIRST would skip 8
> currently-passing scenarios, two of them witnessing a protocol-tier security
> invariant, while none of them would ever have caught the durability gap.
>
> **Decision: store-first — the ADR's original order was right and my proposed
> reordering was wrong.** Do not trade passing coverage of a security invariant
> for a partial honesty gain on a dimension the flag does not clearly assert.
>
> Also killed: gating the advert on the STORAGE ADAPTER's durability while the
> workspace stays a `Map`. That makes one flag report a fact about a different
> subsystem — a second owner for one concept, guaranteed to drift the moment the
> two diverge.
>
> **And a sharper reading of the spec than CORRECTION 1 had:** single-instance
> SQLite does NOT rescue this. `agent-workspace.md` §9 requires that *another
> host* observe the same snapshot, so the guarantee is about portability across
> hosts, not concurrency within one. There is no deployment profile where a
> process-local Map conforms.
>
> **Interim measures shipped (no coverage cost, no wire change):**
> `storageDurability(dsn)` in `storage/index.ts` — derived at DSN parse because
> that is the only place that knows (`memory://` resolves to SQLite `:memory:`,
> so adapter type cannot answer it); the false "durable" claim in
> `workspaceStore.ts:2` corrected; and `test/workspace-durability-gap.test.ts`
> pinning the limitation so it cannot close silently or be forgotten.

> **Status: verified and scoped, NOT implemented.** No code in this ADR has been
> written. The next session starts from the review of that sequencing question.
>
> *(Superseded as of 2026-08-16 — left in place because it is the state the two
> corrections above were written from. P0 landed 2026-08-12 and P1 on
> 2026-08-16; see the `Status:` line and the P1 implementation record at the end
> of this file.)*

## Decision

### Durable workspace through `Storage`

Add workspace CRUD/CAS methods to the existing `Storage` interface and adapters.
Use composite `(tenant_id, workspace_id, path)` identity, monotonically
increasing version, content digest-derived etag, size limit, timestamps and
redacted content. The route becomes async and receives `Storage`; the module
`Map` remains only in the memory adapter used by tests/local development.

Discovery advertises workspace only when the selected adapter passes a boot
readiness check. Production posture fails closed if workspace is requested with
memory storage.

### Durable accepted-work outbox

In the same transaction/atomic storage operation that makes a run visible,
append a dispatch-outbox row keyed by `runId`. The HTTP 201 means both the run
and dispatch intent are durable. A bounded worker claims rows with leases and
invokes the existing `executeRun`; the current run dispatch lease remains the
execution fence. `setImmediate` may wake the local worker, but is never the
durability mechanism.

Managed queue adapters may deliver wakeups, but the database outbox is the
source of truth. This avoids coupling correctness to one cloud vendor and does
not create a second executor.

### Qualification, not assertion

Create a reproducible matrix covering two instances, forced process death,
lease expiry, duplicate delivery, database reconnect, region partition and
recovery. Multi-region capability/marketing stays absent until effect-level
fencing from accepted RFC 0150 and the matrix both pass.

## Boundaries audit

| Concept | Owner |
|---|---|
| Workspace state | `Storage` adapters; existing workspace route/store facade |
| Run creation + dispatch intent | existing run insertion/start-context transaction |
| Execution | existing executor only |
| Lease/recovery | existing run-dispatch sweeper, generalized to outbox claims |
| Dead terminal recovery | existing ADR 0532 DLQ |
| Operator visibility | existing Operations surface |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core host/storage. Operations only adds projections/actions. |
| 2 | Toggle | None. Adapter choice is operator configuration; honest capability gating is mandatory. |
| 3 | Workflow surface | Existing engine; no parallel queue workflow. |
| 4 | Node pack | None. |
| 5 | Envelopes | Existing run events; outbox rows are internal. |
| 6 | Agent pack | None. |
| 7 | Public surface | Existing workspace/run APIs only. |
| 8 | RBAC | Tenant/workspace derived from auth and guarded uniformly; worker is host workload identity. |
| 9 | Replay/fork | Duplicate queue delivery must replay completed nodes and never duplicate effects. |
| 10 | Frontend | Operations queue/workspace-health cards only. |

## Phases and verification

| Phase | Scope | Verification |
|---|---|---|
| P0 | Durable workspace schema/adapters/route | Restart, two-instance CAS, isolation, redaction and etag tests in SQLite/Postgres. **Met only at H59 (2026-08-18) — see the correction below.** |
| P1 | Dispatch outbox and worker | Kill-after-201 and duplicate-delivery tests prove eventual start and one logical execution. |
| P2 | Readiness + Operations | Memory production posture fails closed; backlog/oldest-age/lease metrics and redrive controls. |
| P3 | Multi-instance chaos | Automated two-worker crash/reconnect suite with bounded recovery SLO. **See the P3 scoping note below — as literally written this is not achievable against this host, and the SLO half needs no harness.** |
| P4 | Multi-region qualification | Only after RFC 0150 Accepted; partition/reconciliation/effect-fence evidence published. |

## Alternatives weighed

- Cloud Tasks as sole truth: rejected; deploy portability and local parity would
  depend on a vendor. It can be a wakeup adapter over the durable outbox.
- Keep process-local workspace but advertise “best effort”: rejected; RFC 0059
  names a durable workspace and discovery must be truthful.
- Rely only on the orphan sweeper: rejected; it repairs later but does not make
  the initial accepted-work handoff durable.


## Implementation record — merged-tree provenance, reconciled 2026-08-17 (H44)

The P1 and P2 blocks below were written on their branches and name no merge.
Phase → PR → **merge commit on `origin/main`**, each verified with
`git show <sha> --stat`:

| Phase | PR | Merge commit | Merged | Witness tests |
|---|---|---|---|---|
| P0 — durable workspace through `Storage` | — | `9bd1377e2` (+ the ledger half in `bfec8b9e4`) | 2026-08-12 | `workspace-durability.test.ts`, `workspace.test.ts` (corrected H59 — see below) |
| P0 — the Postgres half of that row | (H59) | — | 2026-08-18 | `storage-adapter-parity-testcontainers.test.ts` § "ADR 0551 P0 workspace CAS" (4 legs), run by `ci.sh` under `OPENWOP_CI_LIVE=1` |
| P1 — durable dispatch outbox (201 means the intent to start is durable) | [#3275](https://github.com/openwop/openwop-app/pull/3275) | `28740fb4d` | 2026-08-16 | `dispatch-outbox.test.ts`, `dispatch-outbox-route.test.ts` (+ `storage-adapter-parity{,-testcontainers}`, `storage-postgres` extended) |
| P2 — readiness-gated workspace advert, outbox metrics, operator redrive | [#3284](https://github.com/openwop/openwop-app/pull/3284) | `699a9b17b` | 2026-08-16 | `workspace-readiness-advert.test.ts`, `dispatch-outbox-observability.test.ts`, `operations-dispatch-outbox.test.ts` |
| P3–P4 | — | — | **open** | — |

### P3 scoping — investigated 2026-08-18, and the phase does not mean what it says

P3 reads "automated two-worker crash/reconnect suite with bounded recovery SLO". Taken literally — crash the
worker that is RUNNING a run, measure how fast another finishes it — **that is not achievable against this host
today**, and the reason is a design property rather than missing effort. Three measured facts:

1. **The durable property is genuinely there.** `routes/runs.ts` commits the dispatch-outbox intent in the SAME
   transaction as the run row (`enqueueDispatch: true`); the `setImmediate` dispatch is explicitly only "a
   wakeup hint". An accepted run survives its accepting instance's death.
2. **Every booted instance sweeps AND executes.** `host/runDispatchSweeper.ts` reads no environment variables at
   all, and there is no read-only / no-execute / sweeper-disabled mode anywhere in `src/`. There is no supported
   way to boot an instance that accepts work without executing it.
3. **Recovery of a run whose executor died is gated by the ORPHAN lease, not the outbox lease.** Once an
   instance starts a run it holds `RUN_DISPATCH_LEASE_MS` = `RUN_DURATION_CEILING_MS` + 120s = **12 minutes**.
   It is not a number a test may shorten, because the ceiling is the value this host ADVERTISES as
   `capabilities.limits.maxRunDurationMs`.

   > **CORRECTION — and the correction is itself a defect worth its own card.** The first draft of this bullet
   > said the lease is "derived from the advertised `capabilities.limits.maxRunDurationMs`". **Nothing derives
   > from anything.** `executor.ts:150` sets `RUN_DURATION_CEILING_MS = 600_000` (what is ENFORCED) and
   > `routes/discovery.ts:466` sets `maxRunDurationMs: 600_000` (what is ADVERTISED) as two INDEPENDENT
   > literals. `discovery.ts` does not import the constant; `grep -rn maxRunDurationMs src/` finds exactly one
   > code hit; and **no test asserts the two agree**.
   >
   > Worse, BOTH files carry a comment claiming the coupling: `executor.ts:147` says it is "advertised as
   > `capabilities.limits.maxRunDurationMs` … MUST equal the advertised value (advertise/enforce must agree)",
   > and `discovery.ts:464` points back at the constant. **I cited that comment as my evidence.** Two comments
   > asserting an invariant nothing enforces, on a wire-advertised limit, is the doc-comment-as-claim failure
   > applied to the exact surface this program exists to keep honest: change the enforced ceiling and the
   > discovery document keeps promising `600000` to every peer.
   >
   > This does not weaken the P3 conclusion — 12 minutes is what is genuinely ENFORCED, so the stall is real —
   > but any text stating "12 minutes" inherits the fragility until the advert is derived from the constant or
   > their equality is pinned by a test. Found by openwop-app-54 while verifying this section rather than
   > accepting it.

So a mid-run crash test is either ~12 minutes long, or a RACE whose duration is 10s or 12min depending on
whether `setImmediate` beat the `SIGKILL`. A test whose runtime forks on a race is a future false red that
someone eventually deletes, taking the real assertion with it. Introducing a no-execute deployment mode purely
to make the test fast would be a production surface nobody owns, invented for a test — the same trade this
program declined for `OUTBOX_LEASE_MS`.

**P3 therefore splits, and only one half is a test:**

- **The bounded recovery SLO is already knowable, and should be STATED rather than measured.** For a crashed
  executor it is **12 minutes**, by derivation from the advertised run-duration ceiling. This is a real
  production property an operator must know — a crashed instance's in-flight runs stall for twelve minutes
  before any peer may touch them — and it is arguably what "bounded recovery SLO" was asking for. If 12 minutes
  is unacceptable, the remedy is a design change (a shorter executor heartbeat lease, decoupled from the
  advertised ceiling), NOT a harness.
- **The achievable automated test is the OUTBOX-INTENT HANDOFF**: an intent committed by an instance that died
  *before starting it* is claimed by another within one sweeper poll (`POLL_INTERVAL_MS` 5s) plus execution.
  Deterministic, needs no seam, and genuinely multi-instance. It must state plainly that it does NOT qualify
  mid-run crash recovery — a test named for the phase while covering the easier half is how a phase gets marked
  done without the evidence.

**Nothing here is a reason to defer P3; it is a reason to re-word it.** The half that needs a decision is the
12-minute stall, which is a product question, and the half that needs code is smaller than the phase implies.

**Re-measured at `fb6cbbcba` (H44):** the five P1+P2 witness files are **5 files
/ 89 tests green**.

**The P1 sabotage table is the part of this record worth re-reading**, because
two of its eleven breaks did NOT go red on the first attempt (S2, the hint grace
window; S4, the `run.status !== 'pending'` fence) — each was green because a
*second* mechanism covered the same scenario, which is the "gate that cannot
fail" shape, not a passing guard. Both were re-pointed at a discriminating
subject and then went red. A sabotage table with no first-attempt greens in it is
usually a table that was not really run.

**Residue, carried not closed:** P4's cross-region effect fencing keeps its row
in `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md` (`host-evidence` on RFC 0150
§D). P1 and P2 shipping did not move it — the register's row was corrected on
2026-08-17 to say so, because its old text still read "P1 outbox in flight" and a
reader could have taken the outbox landing as the row's exit condition. It is
not: the row needs multi-instance chaos (P3) and effect fencing, neither of which
exists.

## P1 — implemented 2026-08-16

Branch `agrade/0551-p1-dispatch-outbox`. Closes the "Durable accepted-work
outbox" decision above; the exit criterion at :183 (kill-after-201 and
duplicate-delivery tests prove eventual start and one logical execution) is met
by `test/dispatch-outbox.test.ts`.

### What shipped

**The intent is written with the run.** `Storage.insertRun` takes an optional
`InsertRunOptions.dispatchOutbox`, and when present the run row and a
`dispatch_outbox` row are committed in ONE operation — a single better-sqlite3
write transaction, a single Postgres `BEGIN…COMMIT` on a dedicated connection.
So `201` now means both the run and the intent to start it are durable. The row
is keyed `run_id PRIMARY KEY`, per the decision's "keyed by `runId`"; the primary
key also makes a second append a write error rather than a second delivery.

**The seam decides, not the route.** `insertRunWithStartContext`
(`host/runInsert.ts`) grew an `enqueueDispatch` flag. Being the single insert
seam is what lets "the run exists" and "something will start it" be stated once
instead of per route. Enqueued at the five paths that today do *insert →
`setImmediate(executeRun)`*: `POST /v1/runs`, `host/runStarter.ts` (scheduled /
trigger / heartbeat / approval / agent / webhook), workflow-author draft,
creative-briefs, and the workflow-debug REDRIVE. Deliberately **not** the
workflow-debug run lane — it executes an ad-hoc `debugDef` that the durable
worker could never re-resolve, so enqueuing there would re-dispatch a run against
the wrong definition.

**One daemon, two lanes.** `startRunDispatchSweeper` now ticks every 5s and runs
`sweepDispatchOutbox` on every tick, `sweepOrphanedRuns` every 6th (preserving
its 30s cadence). This is the boundaries table's "existing run-dispatch sweeper,
generalized to outbox claims" — no second executor, no second daemon, and each
lane caught separately so one failing cannot stop the other.

**`setImmediate` is now a wakeup hint.** A new row's `nextAttemptAt` is
`now + DISPATCH_OUTBOX_HINT_GRACE_MS` (10s). That delay is a DE-DUPLICATION
window against the in-process hint, not the durability mechanism — the row is.
Without it the hint and the worker can both dispatch one run.

> **CORRECTION 2026-08-18 (H59) — the P0 record overstated its own evidence.**
> Two things were wrong, and they compounded:
>
> 1. **The witness cell named the wrong file.** It cited
>    `storage-adapter-parity.test.ts`, which contains no workspace test at all
>    (`grep -i 'workspace_file\|etag\|If-Match'` → nothing; its "workspace"
>    hits are the org-scaffold "personal workspace"). The real P0 witnesses are
>    `workspace-durability.test.ts` (restart survival, content-derived etag,
>    WCT-1 as a DB key) and `workspace.test.ts` (CRUD/CAS/413/isolation/
>    redaction). Corrected in the table above.
> 2. **"Two-instance CAS ... in SQLite/Postgres" was not met.** What existed
>    was a SEQUENTIAL If-Match test on SQLite. There was no concurrent CAS test
>    on either adapter, and the Postgres workspace path was exercised NOWHERE:
>    `storage-postgres.test.ts` stubs `putWorkspaceFile` with a throwing double
>    under pg-mem, and its comment claimed the race was covered "against real
>    Postgres in the testcontainers parity suite" — a file whose workspace
>    coverage was zero.
>
> H59 closes both: four real-Postgres legs (concurrent If-Match with exactly
> one winner, racing no-If-Match etag consistency, stale If-Match returning the
> current version, WCT-1), the false comment corrected in place, and the parity
> file added to `ci.sh`'s `OPENWOP_CI_LIVE=1` lane with a hard Docker require
> (`OPENWOP_STORAGE_PARITY_LIVE=1`) so it fails rather than skips.
>
> It also surfaced a real defect in the adapter, now fixed: the no-If-Match
> write was an upsert `RETURNING version` followed by a SEPARATE
> `UPDATE ... SET etag`. Interleaved, the slower writer stamped an etag for ITS
> version over a row that had already advanced — leaving the row carrying an
> etag derived from content it never held, while everything downstream treats
> the etag as content-derived. It is now one `BEGIN/COMMIT`, matching the
> sqlite adapter, which had always wrapped the pair in `db.transaction`.
>
> **Evidence level — CORRECTED 2026-08-18, upgraded.** When written, this box
> had no Docker, so the legs were typecheck- and skip-verified only and that
> limit was recorded here rather than implied away. Docker became available
> later the same session and they have now **executed against a real Postgres
> container**: 4/4 green, 30/30 for the file. They also FAIL when they should —
> dropping the `AND etag = $10` CAS predicate from the Postgres If-Match path
> reds two of them while the other 28 stay green.
>
> So P0's gate row ("two-instance CAS … in SQLite/Postgres") is met by execution,
> not by a promise, and the etag mis-stamp fix above is covered by a leg that has
> actually run. The hard-require flag was separately proven to fail loudly with
> no daemon, so the lane cannot silently skip in `ci:full` either.

**A row is retired only on OBSERVED evidence.** The worker never concludes "I
dispatched, therefore done". It deletes the row when it can see the run has left
`pending` — a fact `executeRun` writes durably before any node runs — or when the
run is gone, or when an instance holds a live dispatch lease. A healthy run
therefore takes two claims: dispatch, then observe-and-retire. A crash between
them leaves the row present and due, which is the point.

That is also what makes duplicate delivery safe: a re-delivered row is *refused*
up front (run out of `pending`, or live lease) rather than absorbed by replay.
Replay stays the backstop; it is not the mechanism. The run-dispatch lease
remains the execution fence throughout — this queue only decides when
`executeRun` is invoked.

**And redelivery is bounded.** The second claim is SCHEDULED (`nextAttemptAt`)
rather than left to the claim lease lapsing, and it counts the attempt, so a run
that never leaves `pending` retires as `dead` instead of being re-dispatched
until the orphan lane's one-hour ceiling. `executeRun` records a start durably in
two places — the `running` write and the dispatch lease — and either is evidence,
so reaching that state takes BOTH failing. Rare, but `attempts` exists for it and
was otherwise dead on this path.

**A discharged intent is DELETED, not marked.** Same reasoning as ADR 0549's
`releaseIdempotentResponse`: a queue whose completed rows accumulate needs a
retention sweep, and a retention sweep is one more thing that can silently stop
running. `dead` (attempts exhausted) is the one retained state, kept for the P2
operator surface. `deleteRun` deliberately does not clear the outbox row — a
run-less intent self-heals on the next claim, and that path is tested.

### Files

| File | Change |
|---|---|
| `src/types.ts` | `DispatchOutboxRecord` |
| `src/storage/storage.ts` | `InsertRunOptions`; `insertRun(run, opts?)`; `claimDispatchOutbox` / `getDispatchOutbox` / `completeDispatchOutbox` / `rescheduleDispatchOutbox` |
| `src/storage/sqlite/schema.ts` | migration **40** — `dispatch_outbox` + `idx_dispatch_outbox_due` |
| `src/storage/postgres/schema.ts` | migration **38** — the mirror |
| `src/storage/sqlite/index.ts` | `insertRunWithOutboxTxn`, `claimDispatchOutboxTxn`, the four methods |
| `src/storage/postgres/index.ts` | `BEGIN/COMMIT` insert, `FOR UPDATE SKIP LOCKED` claim, the four methods |
| `src/host/runInsert.ts` | `enqueueDispatch`, `DISPATCH_OUTBOX_HINT_GRACE_MS` |
| `src/host/runDispatchSweeper.ts` | `sweepDispatchOutbox`; two-lane tick |
| `src/routes/runs.ts`, `src/host/runStarter.ts`, `src/features/workflow-author/routes.ts`, `src/features/creative-briefs/routes.ts`, `src/routes/workflowDebug.ts` | `enqueueDispatch: true` |

### Tests

| File | Count | Covers |
|---|---|---|
| `test/dispatch-outbox.test.ts` | 16 | atomicity + rollback, the hint window, claim leasing, **kill-after-201**, **duplicate delivery**, the status fence in isolation, the live-lease fence, run-less intent, retry→dead, bounded redelivery, tenant-erasure cascade, forward migration onto a v39 database |
| `test/dispatch-outbox-route.test.ts` | 3 | the `POST /v1/runs` WIRING: the row is committed by the time the 201 is observable; one intent per run; an `Idempotency-Key` replay mints no second intent |
| `test/storage-adapter-parity.test.ts` | +6 | both adapters: insert-with/without intent, claim→reschedule→complete (postgres half skipped — pg-mem rejects the `SKIP LOCKED` AST) |
| `test/storage-adapter-parity-testcontainers.test.ts` | +4 | the same against a REAL Postgres, including the `SKIP LOCKED` claim |
| `test/storage-postgres.test.ts` | — | the hand-rolled hermetic `Storage` grew the four methods |

### Sabotage verification

Every guard was broken, watched go red, and restored. Two did NOT go red on the
first pass and were rewritten — recorded here because the finding is the point:

| # | Sabotage | Result |
|---|---|---|
| S1 | `insertRunWithOutboxTxn` → two sequential statements | RED |
| S2 | `DISPATCH_OUTBOX_HINT_GRACE_MS` → `0` | **first STILL GREEN**, then RED |
| S3 | drop the `claim_expires_at` predicate from the due-scan | RED |
| S4 | remove the `run.status !== 'pending'` fence | **first STILL GREEN**, then RED |
| S5 | remove the live-dispatch-lease fence | RED |
| S6 | worker claims but never invokes `executeRun` | RED |
| S7 | `OUTBOX_MAX_ATTEMPTS` → `99` | RED |
| S8 | drop `enqueueDispatch: true` from `POST /v1/runs` | RED |
| S9 | make sqlite migration 40 a no-op | RED |
| S10 | rename `tenant_id` on the outbox table | RED |
| S11 | remove the post-dispatch attempt count | RED |

**S2** was green because both grace assertions derived their probe from the row's
own `nextAttemptAt` — true for any grace including zero. Rewritten to probe with
a wall-clock offset, plus an explicit floor on the constant.

**S4** was green because the duplicate-delivery scenario is *also* covered by the
live-lease fence, so removing the status check changed nothing observable. Two
fences guarding one path means neither is proven. A test was added that clears
the lease first, isolating the status fence.

The same trap caught S11's test in draft: it neutered only the `running` write,
so `executeRun` still stamped the dispatch lease, the live-lease fence retired
the row after one dispatch, and the loop it claimed to measure never ran. Both
durable start-records have to be suppressed to reach the state the bound exists
for. Two independent fences are good for production and treacherous for tests —
each one has to be isolated to be proven.

### Deliberately NOT done in P1

- **No managed wakeup adapter, and no selection of one.** ADR 0548's open decision
  ("which durable queue adapter is the first managed reference target — Cloud
  Tasks, Pub/Sub, or a database-backed outbox?") is about the optional wakeup
  delivery, and it stays open. What P1 settles is only what :141 and :190–191
  already decided: the **database outbox is the source of truth**, and a managed
  queue may later deliver wakeups over it. Nothing here couples correctness to a
  vendor.
- **No metrics, no operator surface, no redrive control.** Backlog depth,
  oldest-age and lease metrics belong to P2 (and the telemetry half to ADR 0556
  P1). `dead` rows are retained so that surface has something to show, but
  nothing reads them yet.
- **No readiness gating.** "Memory production posture fails closed" is P2.
- **No chaos suite.** Two-worker crash/reconnect with a bounded recovery SLO is
  P3. The multi-instance claim semantics are asserted at the storage layer here
  (one claimer wins; the loser sees nothing until the lease lapses), which is
  evidence about the CLAIM, not about a live two-process deployment — the
  distinction ADR 0548 invariant 3 exists to keep honest.
- **No backfill.** Runs created before the migration have no intent row and keep
  the recovery story they were created under (the orphan lane). Synthesising rows
  would enqueue a re-dispatch of every historical pending run at deploy time.

### Honest caveat on the Postgres evidence

The real-Postgres assertions (`storage-adapter-parity-testcontainers.test.ts`)
are written but were **not executed** on the implementing machine — Docker is not
reachable there, and the whole file soft-skips. They run under `npm run ci:full`
/ any Docker-equipped environment. The Postgres adapter's outbox SQL is therefore
covered locally only by typecheck and by the `pg-mem` half that does not include
the `SKIP LOCKED` claim. Stated rather than glossed, per ADR 0548 invariant 3:
skipped is not passed (ADR 0550 P1's finding).

### No ADR correction required

The P1 sections of this ADR survived implementation intact. `runDispatch.ts:85-113`
and the sweeper still read as the Context describes them, the boundaries table's
"generalized to outbox claims" was implementable as written, and the alternatives
(Cloud Tasks as sole truth; sweeper-only) remain correctly rejected. The only
sharpening worth recording is the **grace window**, which the decision text does
not mention: :138 says `setImmediate` "may wake the local worker", but a worker
that becomes eligible instantly races that hint, so the outbox needs a short
delay before its first claim. That is an implementation detail consistent with
the decision, not a departure from it.


## P2 — implemented 2026-08-16

Branch `agrade/0551-p2-readiness-ops`. Closes the P2 row at :184 ("Memory
production posture fails closed; backlog/oldest-age/lease metrics and redrive
controls") and, with it, the second sentence of the "Durable workspace through
`Storage`" decision at :128–130.

### The advert now follows the guarantee

> **CORRECTION 3 (2026-08-16, P2 implementation) — CORRECTION 2's verdict was
> right for its moment and is now SPENT.**
>
> CORRECTION 2 settled on "the surface is implemented; the durability guarantee
> the surrounding prose attaches to it is not — a partial claim, not a false
> one", and chose **store-first** so that gating the advert would not trade 8
> passing conformance scenarios for an honesty gain. That was correct while the
> store was a module `Map`. P0 replaced the `Map` with `Storage`, so the
> premise the sequencing rested on is gone: the advert can now be gated
> WITHOUT losing coverage, because a durable adapter genuinely satisfies what
> the flag claims. The partial claim is retired rather than merely narrowed.
>
> **What CORRECTION 2 got right and P2 preserves:** it is data integrity, not
> security (`workspace-cross-tenant-isolation` was never at risk — keys carry
> the owner triple), and the ADVERT is the thing that was untrue, not the
> ROUTES. P2 gates only the claim; `/v1/host/workspace/files` answers on every
> profile exactly as before, which is what keeps the scenarios and the unit
> tests exercising a real surface.
>
> **And one line of CORRECTION 2 is now too strong.** It said "single-instance
> SQLite does NOT rescue this … there is no deployment profile where a
> process-local Map conforms". The second half stands forever. The first half
> was reasoning about the `Map` era: §9's requirement is that ANOTHER HOST
> observe the same snapshot, and a sqlite FILE is readable by any process that
> opens it, which a `:memory:` database is not. That is why the line P2 draws
> is memory-vs-durable and not sqlite-vs-postgres.

**There is no "production posture", and P2 did not invent one.** The row's
wording presumes a deployment-profile concept; ADR 0555 CORRECTION 4 established
that none exists in this codebase and that the obvious substitute — a flag —
produces a gate nobody enables. The fact the row is actually about is the
SELECTED STORAGE ADAPTER, and `storage/index.ts` `storageDurability(dsn)`
already answers it at the only place that can (`memory://` resolves to the
sqlite backend at `:memory:`, so adapter TYPE cannot answer it). P0 shipped that
helper with **no consumer in `src/`**; it was waiting for this phase.

`host/workspaceReadiness.ts` owns the three derived questions — advertisable,
warn, fatal — and `routes/discovery.ts` calls exactly one of them.

**Two durability predicates now exist, and they are layered rather than
competing.** `deployPosture.ts` `isDurableStorageDsn()` is stricter (Postgres
only) and answers "is this control plane durable for a MULTI-INSTANCE
deployment", where a sqlite file on stateless compute dies with the container.
The workspace one answers "does the store outlive the process at all". Under
`OPENWOP_DEPLOY_POSTURE=auth` the DUR-1 guard already refuses sqlite outright,
so a real deploy never reaches the weaker line, and a developer on
`sqlite://./data/app.db` gets a workspace that genuinely survives restart.

**Fail closed, at the right thing.** Refusing to BOOT every `memory://` dev box
and test run would be hostile, and a gate people route around is not a gate. So:

| Profile | Behaviour |
|---|---|
| durable DSN | advertised, no warning |
| non-durable DSN | capability ABSENT from `/.well-known/openwop`, one `workspace_capability_withheld` warn |
| non-durable + `OPENWOP_WORKSPACE_REQUIRE_DURABLE=true` | `main()` refuses to start |

Server-only placement (`main()`, never `createApp()`), matching
`enterprisePostureStartupError` — the suite boots in-process apps on `memory://`
by design and must not pay deployment guards.

### The conformance measurement, which changed what P2 had to fix

The brief anticipated that gating the advert would make the 8 RFC 0059
scenarios skip, and asked for a per-run sqlite DSN so they would keep executing.
Both halves turned out to be true in a way no count could show.

`conformance/run.ts:656` hard-coded `storageDsn: 'memory://'` in its `createApp`
call, **silently overriding the `OPENWOP_STORAGE_DSN` it set 15 lines earlier**.
So the first fix — pointing the env at a temp sqlite file — did nothing at all.

And the failure it was hiding is invisible to the suite's own totals.
**MEASURED:** full-suite results are **identical** on both profiles —
`425 passed | 16 skipped` files, `2745 passed | 84 skipped` tests — because
`workspace-behavior` and its siblings SOFT-SKIP (an early `return` when
`capabilityFamily(doc,'workspace')?.supported !== true`) and a soft-skipped
`it()` still counts as a passing test. The scenarios were reported as 4 passing
tests while asserting nothing. This is ADR 0550 P1's "skipped is not passed" in
its least visible form: not a `↓` in the output, a `✓`.

**What actually distinguishes the two profiles** is the database itself:

| | before the fix | after |
|---|---|---|
| `conformance.db` created | **no** (temp dir empty) | yes |
| `workspace_files` rows after a `--filter workspace` run | n/a | **1** (`behavior/SNAPSHOT.md` v1) |
| suite totals | 2745 / 84 | 2745 / 84 |

The row count is the evidence; the totals are not, and recording that is more
useful than the fix. Note the conformance suite reads the capability from the
document ROOT (`lib/discovery-capabilities.ts`, RFC 0073) — the same place this
host serves it — so the gate and the scenario agree by construction.

### Metrics

`docs/SLO.md` listed the outbox trio under "Not yet measurable" and said why:
instrumenting a queue that does not exist yields three metrics permanently at
zero, and a flat zero reads as health. P1 shipped the queue; P2 ships the
signals and promotes them to a **Dispatch queue** section with four objectives
(Q1–Q4), Q3 being the third zero target alongside S1 and F2.

| Metric | Kind | Labels | Emitted from |
|---|---|---|---|
| `openwop.dispatch.outbox.depth` | gauge | `state` ∈ {`pending`,`dead`} — the table's own CHECK constraint | `sweepDispatchOutbox`, once per pass |
| `openwop.dispatch.outbox.oldest_age` | gauge (`s`) | none | same observation |
| `openwop.dispatch.lease.recovered` | counter | `lane` × `outcome` | both sweeper lanes |

Three decisions worth keeping:

- **A new `gauge` kind, synchronous rather than observable.** Depth is already
  computed once per tick by the code holding the storage handle; an observable
  callback would need its own database round trip on the exporter's schedule,
  from a context with no error path. A synchronous gauge also flows through the
  same `guardAttributes` choke and the same emission ledger, so a golden test
  asserts a gauge exactly as it asserts a counter.
- **The observation is taken BEFORE the claim.** A discharged intent is DELETED
  (P1), so a depth read at the END of a pass is 0 on every healthy tick, and a
  queue never observed non-empty is unmonitorable. Sabotage S4 moves it and the
  test goes red.
- **An empty queue records `oldest_age: 0`.** The opposite of the
  `recordAttestationAge` rule, and deliberately: there a zero would be a
  fabricated reading standing in for "no manifest", here an empty queue
  genuinely has an oldest age of zero. Skipping the emission would leave the
  last non-zero value as the newest sample an exporter ever saw — a drained
  backlog that looks permanently stuck.

`lane` exists because the orphan lane is the OTHER half of "lease recovered" and
reaches recovery by a completely different path; one counter without it would
make a spike unattributable to either mechanism. `discharged` and `run-missing`
are healthy outcomes (the duplicate-delivery refusal), and the SLO excludes them
from Q3 for that reason.

### Operator surface and redrive

`GET …/operations/dispatch-outbox/summary` and
`POST …/operations/dispatch-outbox/:runId/redrive`, both superadmin (uniform
404), both following the ADR 0550 attestation card's shape in the same file.

- **Counts are whole-table aggregates** (`COUNT(*) FILTER`, `MIN(created_at)`),
  not counts over the capped `dead` page — a page count under-reports exactly
  when the backlog is deep enough for someone to be looking at it. The webhook
  summary in the same module already carries a `truncated` flag for the version
  of this problem it could not avoid.
- **This is the ONE Operations panel whose numbers are fleet-wide**, because the
  outbox is a durable table rather than this instance's memory. `perInstance:
  false` is on the wire so the console never has to assume.
- **Redrive is a compare-and-set**: `WHERE run_id = ? AND status = 'dead'`
  inside the writing statement, in both adapters. Two concurrent redrives
  re-queue exactly ONE row. A legal-transition check performed before the write
  would let both callers observe `dead` and both write `pending` — the "a state
  machine is not a CAS" failure that has already double-fired a refund in this
  codebase.
- **`attempts` resets to 0.** Re-queueing a row whose budget is already spent
  would have it die again on the next claim: a redrive that does nothing while
  reporting success.
- **`reason` is required**, lands on the row as `last_error`, and is audited
  (`operations.dispatch-outbox.redrive`). The queue carries WHY, the audit chain
  carries WHO; either alone leaves an operator reconstructing the other from
  timestamps.
- **A second redrive 404s** and does NOT overwrite the first one's reason, so
  the row records the transition that actually happened.

Frontend: a Dispatch-queue card on the Operations hub, as the feature matrix
row 10 ("Operations queue/workspace-health cards only") allows. It is the third
INDEPENDENT read in the existing `allSettled` fan-in, with the same per-panel
forbidden/failed/empty states the UX-OPS-1 correction established — a failed
outbox read must never render as an empty queue, which here would read as
"every accepted run started fine".

### Files

| File | Change |
|---|---|
| `src/host/workspaceReadiness.ts` | **new** — advertisable / warn / fatal, over `storageDurability()` |
| `src/routes/discovery.ts` | the `workspace` block is now conditional |
| `src/index.ts` | `main()` fatal + one warn |
| `conformance/run.ts` | per-run sqlite temp DSN; the boot HONOURS `OPENWOP_STORAGE_DSN` |
| `src/types.ts` | `DispatchOutboxStats` |
| `src/storage/storage.ts` | `dispatchOutboxStats` / `listDispatchOutbox` / `redriveDispatchOutbox` |
| `src/storage/{sqlite,postgres}/index.ts` | the three, incl. the CAS |
| `src/observability/metrics.ts` | `gauge` kind + `setGauge` + 3 catalog entries |
| `src/observability/metricSeams.ts` | `recordOutboxBacklog`, `recordDispatchRecovery`, `OutboxOutcome`, `DispatchLane` |
| `src/host/runDispatchSweeper.ts` | backlog observation + 7 outcome emissions across both lanes |
| `src/features/operations/routes.ts` | summary + redrive |
| `frontend/react/src/client/operationsClient.ts` | `getOutboxSummary`, `redriveOutboxIntent` |
| `frontend/react/src/features/operations/OperationsHubPage.tsx` | the card |
| `frontend/react/src/features/operations/i18n/{en,es,fr,pt-BR}.ts` | 21 keys × 4 locales |
| `docs/SLO.md` | Q1–Q4; the "Not yet measurable" note kept verbatim as history |

### Tests

| File | Count | Covers |
|---|---|---|
| `test/workspace-readiness-advert.test.ts` | 8 | DSN semantics, warn, fail-closed, the flag's exact-`true` parse, and TWO REAL BOOTS asserting opposite answers on the same key; plus that the routes still answer where the claim is withheld |
| `test/dispatch-outbox-observability.test.ts` | 15 | catalog shape; depth/oldest-age on an empty queue, before the drain, from `createdAt`, and excluding `dead`; all five outcomes incl. the orphan lane; the redrive CAS + concurrent double-redrive; aggregate-vs-page |
| `test/operations-dispatch-outbox.test.ts` | 7 | the superadmin gate (fail-closed, row untouched), the projection's exact key set, required reason, audit entry, second-redrive 404, live-pending refusal |
| `test/storage-postgres.test.ts` | — | the hermetic `Storage` grew the three methods as real SQL |

Every metric assertion is `toEqual` on the whole attribute object read from the
emission ledger, and every test in the observability file asserts
`labelViolations()` is EMPTY in `afterEach` — an undeclared label is DROPPED,
not refused, so a seam can look instrumented and export nothing useful.

### Sabotage verification

Ten guards broken, each watched go red, each restored. All ten RED on the first
attempt:

| # | Sabotage | Result |
|---|---|---|
| S1 | workspace advert made unconditional again | RED |
| S2 | `workspaceReadinessStartupError` returns null always | RED |
| S3 | delete the `recordOutboxBacklog` call | RED |
| S4 | observe the backlog AFTER the drain instead of before | RED |
| S5 | delete the status-fence `discharged` emission | RED |
| S6 | drop `AND status = 'dead'` from the redrive (CAS → plain update) | RED |
| S7 | redrive keeps the spent attempt count | RED |
| S8 | remove `requireSuperadmin` from the redrive route | RED |
| S9 | make `reason` optional | RED |
| S10 | rename `openwop.dispatch.outbox.depth` in the catalog | RED |

The one that mattered most is **S4**: its first draft asserted depth on a pass
that dispatched rows without retiring them, and a claim does not change
`status`, so moving the observation would have changed nothing observable. The
test was rewritten to use rows the pass RETIRES (the discharged-intent DELETE),
which is the only version that can tell before-the-drain from after it. Same
lesson P1 recorded twice as S2 and S4 — a probe derived from the value under
test measures nothing.

### Deliberately NOT done in P2

- **No chaos suite.** Two-worker crash/reconnect with a bounded recovery SLO is
  P3. The metrics here are observations of a single process's sweeper; that is
  evidence about the INSTRUMENTATION, not about a live two-process deployment.
- **No run-level queue-wait histogram.** `oldest_age` describes intents still
  waiting; a queue-wait distribution describes intents that already started.
  Approximating the second from the first would be a gauge over survivors
  standing in for a distribution over completions. Recorded in `docs/SLO.md`.
- **No general Operations/SLO panels.** ADR 0556 P2 owns those; P2 adds only the
  outbox rows.
- **No SoD on redrive.** The ADR does not require a second approver, and the CAS
  makes the action idempotent, so a replayed request cannot double-queue.
- **No change to `idempotency.crossRegion`.** It stays absent / `single-region`
  (P4, RFC 0150), and `test/agrade-wire-blocked-residue.test.ts` still pins it.
