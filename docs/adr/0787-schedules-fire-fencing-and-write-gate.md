# ADR 0787 — Schedules: fire once in data, a gated door, one identity, an honest cadence

Status: implemented (2026-09-30, feature loop row 10; Accepted post-/architect with 2 Blockers + 6 Highs + 7 Mediums folded before code — see § "/architect pass")

**Date:** 2026-09-30 · **Feature:** `core:schedules` (always-on core surface; EXTENDS
ADR 0025 / 0046 / 0599 / 0309 and the RFC 0052 host sample; no toggle, no new
package) · **Feature loop:** 2026-10 row 10 · **Grade:**
`docs/steward/WORKFLOWS-ASSESSMENT.md` § "Schedules & triggers" (`SCTWF-1..21`)

**RFC verdict: none for the fencing, gate, identity and cadence work.** All of it is
host-extension behaviour behind `/v1/host/openwop-app/scheduler/*` plus host-private
daemon semantics. It makes the host honour RFC 0052 §B.2 ("a cron tick MUST NOT spawn
duplicate concurrent runs") and §B.3 (reject beyond the horizon), which it already
claims. **One advertised VALUE changes:** `capabilities.scheduling.maxFutureHorizon`
goes from `P30D` to `P366D` (D6). The field is host-chosen by the RFC's own schema
("the farthest-future a run may be scheduled"), and the new value is honest only
because D6 makes the host honour it. That is a host advertisement change, not a spec
change.

## Context

The grade found the scheduler's fleet dedup correct in exactly one shape: two healthy
instances polling at the same instant. Everything else leaks.

| Id | Defect (evidence in the grade) | Effect |
|---|---|---|
| `SCTWF-1` | the daemon fires from a pass-start snapshot; it never re-reads the row after the claim | a disable, delete or DSAR erasure mid-pass still fires, as the erased person |
| `SCTWF-2` | every job mutator is get → blind put | the daemon re-creates a deleted job, re-enables a disabled one, un-scrubs an erased one; a metadata edit rewinds `nextFireAt` |
| `SCTWF-3` | the only fleet dedup is a claim row pruned after 10 min, stamped with the pass START; runs get a random id; no fencing | a pass stalled past the prune (WHD-28's superseded revision) fires the slot again |
| `SCTWF-4` | PATCH copies client `metadata` verbatim | anyone who can PATCH can make a job act as a colleague (`actingUserId` keys credentials) |
| `SCTWF-5` | POST has no scope check; PATCH/DELETE/trigger fall back to tenant co-residency for every owner kind but project/board | a Viewer can create, retarget, fire or delete any automation |
| `SCTWF-6` | the DSAR eraser matches `user:X`/`X`, never the legacy `oidc:<sub>` every pre-ADR 0003 job carries | an erased user's assistant loop keeps firing as them |
| `SCTWF-7` | the personal-schedule door compares one spelling | a legacy-spelled owner cannot see or delete their own schedule |
| `SCTWF-8` | the cron search stops at 30 days; `null` DELETES `nextFireAt` | yearly/quarterly/31st-of-month jobs die silently after (or at) registration |
| `SCTWF-9` | a bad timezone throws out of `Intl` (500); an unparseable cron is accepted and inert | a typo is a dead schedule with a `201` |
| `SCTWF-10` | Run now builds its own run: no `actingUserId`, `inputs`, `configurable`, no feature gate | the button does not test what the schedule does |
| `SCTWF-11` | re-registering a spent one-shot re-arms it with a past fire time | a retried follow-up tool call fires twice |
| `SCTWF-19` | liveness is per process | nobody can see a non-serving revision still ticking |

### How the field does it (competitive frame)

- **Temporal Schedules.** Each action's workflow id is the schedule id plus the
  scheduled time, so a duplicate start is refused by the workflow-id uniqueness rule,
  not by a lease. The overlap policy defaults to SKIP, catch-up is windowed, a pause
  carries a note, and "next N fire times" is visible.
- **Inngest cron.** `TZ=` prefix validated at registration; idempotency keys and
  singleton concurrency per function.
- **n8n Schedule Trigger / Zapier Schedule.** Validate the cadence at save, run in the
  workflow's timezone, no silent backlog.
- **GitHub Actions cron.** UTC only, may be delayed under load; a workflow with no
  repository activity for 60 days is disabled WITH a notice, never silently.

The common rule is that **fire-once lives in the data, not in a lease.** The run
identity is a pure function of (schedule, scheduled time), and a duplicate collapses
at the store. A cadence is validated when it is written, and a schedule that will not
fire again says so. Our scheduler has the primitives for all three
(`startWorkflowRun`'s deterministic `runId` seam, `runStarter.ts:76-86`;
`DurableCollection.compareAndSwap`, `hostExtPersistence.ts:736`) and uses none of
them.

## Boundaries audit

- **One job store, one daemon.** `host/schedulingService.ts` (`scheduler:job`) is the
  only store and `host/scheduleDaemon.ts` the only clock (knowledge sync was folded
  in). No second scheduler is introduced; every change below is to those two files plus
  the one route file.
- **Write authority.** Reuse `requireTenantWrite` / `callerHoldsTenantScope` /
  `callerSubjectSpellings` (`features/featureRoute.ts:296-370`, ADR 0775 D1). Kanban
  already imports them from `routes/` (`routes/kanban.ts:71`), so the import direction
  is established. No new authority predicate.
- **Identity alias.** The DSAR fan-out already expands subject keys through
  registered resolvers (`host/subjectErasure.ts:189`, `:209-290`), and `usersService`
  registers one under a home-tenant guard (`usersService.ts:447-454`). D4 adds a
  sibling resolver there rather than a per-eraser alias. (The draft moved
  connections' `actingUserIds` into `host/`; /architect H7 showed that duplicated the
  resolver seam, and the "host must not depend on a feature" reason was half true
  anyway: `actingUserIds` itself imports `features/users`.)
- **Deterministic run id.** Reuse the `startWorkflowRun` `runId` seam and the kanban
  `stableWorkIdentity` shape (`host/kanbanService.ts:940`). No new id scheme.
- **Frontend.** The ONE schedules panel is `schedules/SubjectSchedulesPanel.tsx`
  (agents, profiles, projects), plus `agents/RecurringTasksPanel.tsx`; the gate helper
  is `lib/writeAccess.ts`. No new component.

## Decision

### D1 — Fire once, fenced in DATA (`SCTWF-1`, `SCTWF-3`)

A fire now has three layers. Each covers a different failure, and none depends on a
lease expiring at the right time.

1. **Claim.** `claimOnce('schedule-fire:<jobId>:<slot>')`, with the key unchanged. It is
   now stamped with the CLAIM time, not the pass start, so a claim minted by a stalled
   pass is not born already prunable. `claimOnce` stores the caller's timestamp and the
   prune keys on it (`postgres/index.ts:1483`, `:1523`).
2. **Slot CAS (the fence).** Right after winning the claim, the daemon RE-READS the row
   and requires all four of the following:
   - the row still exists;
   - `enabled === true`;
   - `workflowId` is still bound;
   - `nextFireAt === slot`.

   Only then does it advance, with `compareAndSwap(fresh, advanced)`.
   - **A lost swap RETRIES.** It re-reads, re-checks the four conditions and swaps
     again, up to 5 times. It skips only when a CONDITION fails. A lost swap on its own
     is not a reason to skip: the claim is already taken, so every later pass would get
     `claimed:false` until the prune, stranding the slot and firing it 10 minutes late.
     *(/architect Blocker 1: a slow previous dispatch's `recordJobRun`, or a label
     edit, races the row routinely.)*
   - **The next slot is computed from `max(now, Date.now())`**, so a stalled pass cannot
     mint a slot that is already in the past (/architect L16).

   A pass that wakes after the claim prune finds `nextFireAt` already past its slot, and
   fires nothing. So does a superseded revision running THIS code, a clock-skewed
   instance, and a pass that read a row the user has since disabled. **The fence is the
   row, not the claim table**, and the row is never pruned.
3. **Deterministic run id.** The id is
   `schedule-run-<stableWorkIdentity([tenantId, jobId, String(slot)])>`, the kanban
   shape (`kanbanService.ts:940`), and it is passed to `startWorkflowRun`. A second start
   for the same (tenant, job, slot) returns the existing run and schedules no second
   executor wakeup.
   - The TENANT is in the hash because `jobid_conflict` only protects live rows, so
     another tenant can reuse a deleted job's id (/architect M9).
   - It collapses a slot that a POST-fix instance fired and that something (a pre-fix
     blind put, a restore) then rewound.
   - **It cannot collapse a fire made by a PRE-fix revision**, because pre-fix code mints
     random ids (`runStarter.ts:125`) (/architect H8).

Everything after the CAS (the gates, dispatch, attribution) reads the ADVANCED row,
never the list snapshot. **Stated residue:** a disable that lands AFTER the swap and
before dispatch (the feature-toggle and budget reads) still fires that one slot. The
window is bounded by one fire, where before it was bounded by a 50-job pass.

**This ADR does not fence revisions running pre-0787 code, and no host code can.** They
keep firing from snapshots, minting random run ids, and writing blind puts until they
are gone. They also write no D7 heartbeat, so D7 cannot see them either (/architect H8).
Two things cover them, both operational:
- **Seeing them:** Cloud Run's revision and instance listing (the WHD-28 runbook).
- **Curing them:** removing superseded revisions.

What this ADR guarantees is that every revision running it, now and in future, is
fenced by the row.

### D2 — Every job mutator is a CAS (`SCTWF-2`)

One internal `mutateJob(jobId, fn)`:
- read the row;
- if the row is missing, return `null`. Nothing is ever written to a missing row, so a
  delete cannot be resurrected;
- apply a pure `fn` to a clone (`fn` may return `null`, meaning "no change");
- `compareAndSwap(read, next)`;
- on a lost swap, re-read and re-apply, up to 5 times;
- after that, throw a typed `ScheduleWriteContention` error, never drop the write
  silently.

These mutators go through it: `advanceJobSlot`, `recordJobRun`, `recordJobSkipped`,
`markJobFired`, `setJobEnabled`, `updateJob` and `eraseSubjectSchedules`. `deleteJob`
stays an unconditional delete, because a delete must win. `registerJob`'s same-tenant
upsert becomes `compareAndSwap(prior, job)` under the same bounded retry. If
`registerJob` exhausts its retries it returns a typed `{ ok:false, error:{ code:
'write_contention' } }`; the route answers **409** and internal callers already handle
`ok:false`.

**How contention is handled at each call site** (/architect M10):

| Where it is thrown | Handling |
|---|---|
| The daemon's `recordJobRun` / `recordJobSkipped`, AFTER a run started | Caught and logged separately, so a run that started is never labelled `dispatch-error`. |
| Route mutators | A 409 `conflict` (the SPA already renders a server sentence). |
| Teardown callers (goals disarm, enrollment teardown, `calendarSync`, `setJobEnabled`, `projectsService` cascade) | Contention cannot occur on a delete. On a disable, the helper's 5 retries against a daemon that writes one row per 30 s make exhaustion practically unreachable. If it does happen, the typed error propagates to the caller's existing `try` (all of them already wrap the scheduler as best-effort). This is stated, not hidden. |

`updateJob` still recomputes `nextFireAt` only when `cronExpr` or `timezone` changes.
Because it now swaps against the row the daemon just advanced, a metadata-only patch can
no longer rewind the slot.

### D3 — One write gate on the door; a retarget is guarded (`SCTWF-4`, `SCTWF-5`)

`routes/scheduler.ts` judges every request with one three-way gate:
`gate(job) → 'none' | 'read' | 'write'`. The arms, in order:

1. **A subject resolver applies** (project, board): its level, as today (ADR 0608).
2. **A PERSONAL job the caller owns:**
   - `job.tenantId === personalTenantOf(req)`, **and**
   - `ownerUserId` (or a user-kind `ownerSubject`) ∈ `callerSubjectSpellings(req)`.

   This arm gives `'write'`, EXCEPT that an `owk_` key whose declaration excludes
   `workspace:write` gives `'read'`. `keyDeclarationPermits` always applies (/architect
   H5). The arm is confined to the personal tenant (/architect H4): a user-owned job in
   a SHARED tenant (KickBot convene/coach, session reminders) is judged by arm 3, never
   by ownership.
3. **A job in the caller's active tenant:** `'write'` if
   `callerHoldsTenantScope(req, job.tenantId, 'workspace:write')`, otherwise `'read'`.
4. **Otherwise:** `'none'`.

Enforcement by route:

| Route | Requirement |
|---|---|
| GET | `read` |
| PATCH, DELETE, trigger | `write`. Unreachable (`none`) stays a uniform **404**, so there is no existence oracle. Readable but not writable is **403 `forbidden_scope`**, which the SPA already maps to `common:error_forbidden`. |
| POST in a shared tenant | `requireTenantWrite(req, tenantId)` before any validation. |
| POST with `owner:'me'` (durable only; creates in the caller's personal tenant) | Allowed, but the api-key declaration check still applies (/architect H5). |

**PATCH metadata MERGES** (/architect M11):
- The client body loses every reserved key. Those are the keys POST strips, now hoisted
  to one module constant `RESERVED_JOB_METADATA_KEYS`.
- The remaining client keys are shallow-merged over the job's existing metadata.
- Every key the client did not name is kept. That includes the reserved markers and
  feature keys such as `tool`, which feeds the scheduled-chat follow-up cap.

**Actor re-stamp on a `workflowId` change only** (/architect M11). A PATCH that changes
`workflowId` re-stamps `metadata.actingUserId` to the patching caller, derived the same
way POST derives it. A label, `enabled`, `cronExpr` or `timezone` edit keeps the
original actor. Otherwise a colleague renaming or pausing a teammate's digest would
become its credential source (e.g. an assistant loop's Google connection,
`loops.ts:209-219`).

**A server-configured job cannot be retargeted** (/architect H4). PATCHing `workflowId`
is refused with **409 `conflict`** ("This schedule is managed by its feature; change it
there.") when the job carries any server-stamped configuration:
- `configurable`;
- `inputs`;
- `featureId`;
- a feature marker: `assistantLoop`, or any `metadata.purpose` / `metadata.tool`.

Such jobs were built by a feature for ONE workflow. Retargeting them would hand a
feature's platform credential (e.g. `KICKTODO_CONVENE_CREDENTIAL_REF`) or its seeded
inputs to a workflow the patcher chose.

**An erased job cannot be re-enabled** (/architect M12). `PATCH enabled:true`, and the
assistant loop's enable path, refuse a job whose `ownerUserId`, user-kind
`ownerSubject` or `metadata.actingUserId` is the `ERASED` sentinel. The refusal is
**409 `conflict`**, and the only way forward is re-creating the job. The refusal lives
in `setJobEnabled` / `updateJob` (a `JobErasedError`), so every lane inherits it.

### D4 — One identity at the door, one alias in the erasure fan-out (`SCTWF-6`, `SCTWF-7`)

- **Door.** Every owner comparison uses `callerSubjectSpellings(req)`: the request's own
  canonical id plus its raw principal. That covers:
  - the personal-job arm;
  - the `?owner=me` list (the union of `listJobsByUser` over the spellings, deduped by
    `jobId`);
  - the idempotent personal create.

  Both spellings belong to the same request, so no alias is looked up.
- **Erasure.** A users-feature **subject-key resolver** (/architect H7, replacing the
  draft's per-eraser alias). This is the structural cure. `eraseSubject` already expands
  keys and runs every eraser once per key (`subjectErasure.ts:209-290`), and
  `usersService` already registers a resolver guarded by the home tenant
  (`usersService.ts:447-454`).
  - **What it returns:** `usersPrincipalKeyResolver(tenantId, subjectKey)` returns
    `User.principalId` when **both** hold: the row exists, and `user.tenantId ===
    tenantId`.
  - **Effect on schedules:** the schedules eraser, unchanged in shape, then also runs
    for `oidc:<sub>` and disables that person's legacy-spelled home-tenant jobs.
  - **Effect on every other eraser (a deliberate widening, recorded):** every one of
    them now also runs for the same human's legacy principal in their home tenant.
    That is what an erasure of that person means.
  - **It never aliases across tenants.** This is the row-8 `CONNWF-5e` lesson: principal
    ids are not issuer-qualified. A refuse-side witness pins that the same principal
    string in ANOTHER tenant is untouched.
  - **Residue:** a shared workspace's legacy `oidc:` job for the erased person is not
    reached. This is the `CONNWF-5e` design constraint, re-filed as `SCTWF-6b`.

  **No `host/userIdAliases.ts` move** is needed any more. The connections eraser keeps
  its local alias. Folding it onto the resolver is a later cleanup, filed as
  `SCTWF-6c`, because it touches row 8's shipped code.

> **CORRECTED 2026-09-30 (ce review, via main) — the "every eraser" widening above is
> WITHDRAWN before merge.** Principal ids are not issuer-qualified. In ONE tenant with
> two IdPs, `scim:jsmith` can be two people, so a registered resolver would have let
> every eraser delete the OTHER person's legacy rows (`CONNCD-15`). The shipped shape
> is scoped to the **scheduler eraser only**: `legacyPrincipalOf(tenantId, userId)`
> (users feature). It derives the principal from the erased user's OWN User row, and
> only when that row's tenant is the tenant being erased. It never searches Users by
> principal string. It **refuses to alias** when more than one User row in that
> tenant claims the principal (a legacy randomUUID-era duplicate). That case is
> logged, and the rows are left for manual review. Both refusals are witnessed. The
> other erasers wait for issuer-qualified principals.
>
> Prod sizing (ce, read-only): 3 jobs carry an `oidc:` actor, all in one tenant, and
> there are 0 `oidc:` owners. So the defect is real but narrow.

### D5 — Run now fires through the daemon's recipe (`SCTWF-10`)

Extract `fireJob(deps, job, { runId?, trigger, triggeredBy? })` from
`processDueSchedules`. Both lanes use it, so both build the same run: the metadata
filter, `inputs`, `configurable`, `ownerScope`, and the ADR 0599 feature gate.

- **The daemon** passes the D1 deterministic id and `trigger: 'schedule'`.
- **Run now** passes:
  - no id, because each click is a new, intended run;
  - `trigger: 'manual'`;
  - the clicker as `schedule.triggeredBy`.

  It keeps the job's `actingUserId`: it runs exactly what the job's definer configured,
  and the clicker is attributed. **The autonomous-run budget STILL applies when the
  clicker is not the actor** (/architect M15). Without it, a workspace writer could fire
  a colleague's credentialed workflow without limit. It is skipped only when the
  clicker IS the actor (a human spending their own credentials by hand), and for a job
  with no actor.
- **Run now NEVER advances `nextFireAt`** (/architect H3). Today `markJobFired` advances
  it, so Run now silently eats the next scheduled slot. The bookkeeping is now:
  - `lastFiredTick` via the deterministic tick seam (kept);
  - `recordJobRun` on a run;
  - `recordJobSkipped(reason)` on a refusal.
  > **CORRECTED during P3 (2026-09-30):** the finding was true for fewer jobs than
  > stated. `markJobFired` recomputes from NOW, so for a RECURRING job whose
  > `nextFireAt` is in the future it lands on the same slot, and nothing is eaten.
  > The slot is lost for a **pending one-shot**, where the recompute deletes
  > `nextFireAt` so the click spends the scheduled fire, and for an **overdue**
  > slot the daemon had not reached yet. The first witness used a recurring job
  > and passed under sabotage (vacuous). It now uses a one-shot.
- **Response contract.** It keeps `runsFired` and `lastFiredTick` (tick-seam
  compatibility), carries `runId` on a run, and adds `skipped: <reason>` otherwise. The
  panel stops rendering "no workflow" for every run-less answer
  (`SubjectSchedulesPanel.tsx:181`) and renders the reason (P5).
- **`scheduler-route.test.ts:136-158`** pins a BOUND unresolved workflow. It keeps its
  assertions (`runsFired>0`, `lastFiredTick` stamped, skip recorded). Its "the slot
  still advanced" comment is corrected to "the tick advanced; `nextFireAt` did not",
  and an assertion for the latter is added.

### D6 — An honest cadence (`SCTWF-8`, `SCTWF-9`, `SCTWF-11`)

- **Search, not scan.**
  - `computeNextFire` jumps over non-matching months, days and hours.
    *(CORRECTED at P3: the first cut also leapt a whole hour when the HOUR
    matched but the minute did not, so `30 2 * * *` never fired. The
    brute-force oracle caught it before commit. The rule is now: jump a wrong
    day, jump a wrong hour, and STEP a right hour.)*
  - Every jump is **verified**: after a jump it compares the target's local wall clock
    to the expected one. If the offset changed during the jump (DST, Antarctica/Troll's
    2-hour shift, Lord_Howe's 30 minutes), it falls back to the minute step from the
    last verified candidate. *(/architect M14: the draft's "assume a 23-hour day"
    overshoots on Troll's 22-hour day.)*
  - A year costs a few thousand evaluations instead of 525k.
  - The witnesses are UTC, Troll, Lord_Howe, Kolkata, Kathmandu and Chatham, each
    compared minute by minute against the brute-force scan across a DST year.
- **The horizon, honoured.** There is one constant pair in `schedulingService.ts`:
  `MAX_FUTURE_HORIZON_MS` (366 days) and `MAX_FUTURE_HORIZON_ISO = 'P366D'`. These all
  derive from it (/architect H6):
  - the search horizon;
  - discovery (`discovery.ts:1857`);
  - the error body (`routes/scheduler.ts:285`);
  - the model-facing tool schema and error text in
    `scheduled-agent-chats/agentTools.ts:74/:107`, which today say "30 days";
  - a test pinning each.

  It covers yearly, quarterly and 31st-of-month cadences. A one-shot can be set up to a
  year out.
- **Validated in the SERVICE** (/architect M13). `validateCadence(cronExpr, timezone,
  now)` returns a typed error:
  - an unknown IANA zone → `invalid_timezone`;
  - an unparseable cron that is not `'once'` → `invalid_cron`;
  - a parseable cron with no fire inside the horizon → `schedule_horizon_exceeded`.

  It runs in:
  - `registerJob` for an ENABLED job;
  - `updateJob` when `cronExpr`/`timezone` changes on an enabled job, or when
    `enabled` flips false → true.

  So every door gets it (the scheduler route, the project schedule door, and
  PATCH-enabling a disabled portability import). Portability's DISABLED import stays
  permissive, and the check bites when someone enables the job. The route maps the
  first two codes to **400 `validation_error`** `{field}`, and the third to **400
  `schedule_horizon_exceeded`**. `computeNextFire` no longer throws on a bad zone (it
  returns `null`), so no path answers 500 or wedges after a claim.
- **Stranded rows are revived** (added after ce's prod sizing). Raising the
  horizon fixes future advances only. Prod had **3 enabled jobs already dead**:
  `0 9 3 * *`, where the Sep 3 → Oct 3 gap is exactly 30 days. Each daemon pass
  runs `reviveStalledJob` over the jobs it already lists. It recomputes
  `nextFireAt`, via a CAS, for an enabled, bound, recurring, parseable cadence
  that has none. It is idempotent, and a concurrent disable, delete or erasure
  wins. The same pass revives a leap-day cadence once its next slot comes inside
  the horizon, and clears the `no-next-fire` note when it does. Witnessed by
  seeding the exact prod shape.
- **Never silently dead.** When the daemon's advance finds a PARSEABLE cadence with no
  next fire, it records `lastSkipReason: 'no-next-fire'` and leaves the row visible,
  with `nextFireAt` absent. For a leap-day cadence this is permanent after one fire, and
  the UX copy says so (/architect L17). A spent `'once'` is not a skip: that is the
  one-shot's normal end.
- **A spent one-shot is not re-fired for the SAME slot** (/architect Blocker 2).
  - The fire records `oneShotFiredAt = slot` on the row.
  - `registerJob` over the same id and tenant, with `cronExpr === 'once'` and a
    `firstFireAtMs <= oneShotFiredAt`, returns the prior row unchanged (`{ ok:true,
    job: prior }`). That is the retried-tool-call case: identical arguments, identical
    fire time.
  - Any LATER `firstFireAtMs` re-arms. This matters because live callers re-register one
    deterministic id with `firstFireAtMs: Date.now()` to fire again, and the draft's
    "at or before now" guard would have silently swallowed every one of those
    re-registrations:
    - `kickbotCoachTurnService.ts:147-158` (the award key has no day in it);
    - `kicktodo-core/agentTools.ts:214-220` (convene);
    - `kicktodo-accountability/sessionService.ts:112` (reminders).

  All three are witnessed in P3.

### D7 — The fleet is visible, for revisions running this code (`SCTWF-19`)

Each daemon tick upserts `scheduler:daemon:<instanceId>` with `{ instanceId, revision:
K_REVISION ?? null, commit: OPENWOP_BUILD_COMMIT ?? null, startedAt, lastTickAt }`.
Rows older than 1 hour are pruned on the tick. `scheduleDaemonFleet()` lists the live
rows.

**Where it is read** (/architect L18): the KickTodo readiness readout
(`kicktodo-core/readinessService.ts:162`) is the only current consumer of
`scheduleDaemonLiveness`, so `fleet` rides that readout for now. A host operations
surface is `SCTWF-19c`.

**Scope, stated** (/architect H8): this makes two POST-0787 revisions ticking at once a
read, not an inference. Pre-0787 revisions write nothing and stay visible only through
Cloud Run (D1).

The rows are host-global operational data, with no tenant data and no subject. Their
storage cost is one row per instance.

Stand-down of a non-serving revision is NOT decided here (see Alternatives).

## Alternatives weighed

- **A leader lease (one instance fires).** Rejected. A lease is time-bounded exactly
  like the claim prune it would replace, and it adds failover latency. It also does
  nothing against the snapshot and blind-put defects. Temporal and Inngest put fire-once
  in the id, not in a leader. (The row-4 lesson applies: a lock would not have helped
  the 2026-08-03 double deploy either.)
- **Keep the claim rows longer (24 h) instead of a slot CAS.** Rejected as the fence.
  Pre-fix revisions still prune at 10 minutes, so the table cannot be trusted, and a
  longer prune does not close the snapshot or blind-put defects. It remains a
  harmless belt, left unchanged.
- **Revision stand-down (a non-serving revision stops its daemons).** Deferred
  (`SCTWF-19b`). Knowing "serving" needs either the Cloud Run Admin API (the memory
  `run-services-update-cannot-be-scoped` reasons about read versus write scope there)
  or a durable "generation" row. A generation row would hand firing to a 0%-traffic
  TAGGED probe revision the moment it boots. D1 already makes a stale post-fix revision
  harmless; D7 makes a pre-fix one visible.
- **Refuse a PATCH of another person's job instead of re-stamping.** Rejected. A
  workspace editor legitimately maintains shared automations. Refusing would strand
  every job whose author left, and re-stamping is what makes the edit honest.
- **Keep `P30D` and reject every cadence whose GAP exceeds 30 days.** Rejected. It
  would refuse a monthly `0 0 31 * *` in some months and not others, and quarterly
  reports are a mainstream use. The RFC leaves the value to the host.

## Deferred, each with a reason

- `SCTWF-12` (DST fall-back double fire). A policy change to existing firing
  semantics; needs a product decision on "first occurrence only". Recorded.
- `SCTWF-13` (overlap policy). New per-job field + UI; Temporal-parity feature work,
  not a correctness fix.
- `SCTWF-14` / `KSTWF-10` (atomic trigger dedup). Claim-before-fire changes redelivery
  semantics after a crash (a stranded claim drops the delivery for 24 h). It needs its
  own decision; it stays with row 4's ADR 0774 follow-ups.
- `SCTWF-15`. The `OPENWOP_AUTHORIZATION_ENFORCEMENT` default is platform posture
  (users row 19 / capability firewall row 20).
- `SCTWF-16`, `-17`, `-18`. Trigger-store durability, erasure and dead-letter recovery.
  Each is a store change of its own; filed to the trigger follow-up.
- `SCTWF-19b` (revision stand-down, above). `SCTWF-20` (a due index). The scan is
  bounded by the job count, and the index needs a migration.
- `SCTWF-21` (consumer pins in rows 27/51/58). Routed to their rows.
- `SCTWF-6b` (shared-workspace legacy spellings). Same design constraint as
  `CONNWF-5e`.
- `SCTWF-6c` (fold the connections eraser's local alias onto the D4 resolver). Touches row 8's shipped code.
- `SCTWF-19c` (a host operations surface for the D7 fleet). The KickTodo readout carries it meanwhile.

## Phased plan

| Phase | Scope | Witnesses (each sabotaged red on committed code) |
|---|---|---|
| P1 | D1 + D2: `mutateJob`, slot CAS with retry, fresh re-read, deterministic tenant-keyed run id, claim-time stamp, `max(now, Date.now())` advance | a stalled pass after the prune fires nothing; a disable, delete or erase between list and fire fires nothing; a lost swap on a HARMLESS write still fires the slot on time (Blocker 1); daemon bookkeeping cannot resurrect a deleted job, re-enable a disabled one or un-scrub an erased one; a metadata PATCH racing an advance cannot rewind; the same (tenant, job, slot) twice gives one run; a post-run contention is not labelled `dispatch-error` |
| P2 | D3 + D4: four-arm gate, api-key narrowing, reserved-key strip + merge, re-stamp on `workflowId`, retarget guard, erased-enable refusal, spelling union, users principal key resolver | a Viewer's POST, PATCH, DELETE and trigger each give 403; a non-member gets 404; a read-only `owk_` key cannot `owner:'me'`-create; a Viewer who OWNS a shared-tenant KickBot job cannot retarget it (H4); a PATCHed `actingUserId` is stripped; a label edit keeps `tool` and the actor; a retarget re-stamps; retargeting a feature-configured job gives 409; enabling an erased job gives 409; a legacy-spelled owner can list and edit their own personal job; a DSAR of `user:X` disables X's `oidc:` home-tenant job; the same principal string in ANOTHER tenant is NOT touched (refuse-side) |
| P3 | D5 + D6: `fireJob`, Run-now parity + response contract, verified-jump cadence search, one horizon constant + the prose derived from it, service-level validation, `no-next-fire`, `oneShotFiredAt` guard | Run now carries `actingUserId`, `inputs` and `configurable`, honours the feature gate, never moves `nextFireAt`, and applies the budget for a non-actor clicker; yearly, quarterly and 31st-of-month cadences compute a next fire; Feb 30 gives 400 horizon; a bad timezone gives 400, not 500, on BOTH doors and on enable; `no-next-fire` is recorded; a same-slot one-shot re-register stays spent, while the three `Date.now()` re-registers (coach award, convene, session reminder) re-arm; the fast search equals the brute-force scan across a DST year in six zones; the horizon prose is pinned to the constant |
| P4 | D7: fleet heartbeat rows + `fleet` on the readiness readout | two instance ids with different revisions are both listed; stale rows are pruned |
| P5 | Frontend (list sent to main for OK first): `SubjectSchedulesPanel` + `RecurringTasksPanel` pre-gate writes via `useScopeWriteAccess('workspace:write')` (personal profile tab exempt), render `skipped` / `no-next-fire` and the refusal reasons, show the server's validation sentence via `writeErrorMessage` | component tests per state, 4 locales |

## /architect pass (2026-09-30, independent reviewer, read-only)

Verdict: **accept with corrections.** Every correction below is folded into the
decision text above. The draft's wording is kept only where this list quotes it.

| # | Sev | Finding | Where folded |
|---|---|---|---|
| 1 | **Blocker** | a lost fence swap stranded the slot: the claim was already taken, so it fired 10 minutes late | D1.2 retry |
| 2 | **Blocker** | the "at or before now" one-shot guard would swallow three live `Date.now()` re-registrations | D6 `oneShotFiredAt` |
| 3 | High | the D5 premise was false: the route test pins a BOUND workflow; Run now ate the next slot; the panel said "no workflow" for every refusal | D5 |
| 4 | High | the owner arm worked in any tenant, so a Viewer-owner could retarget a platform-credentialed job | D3 arm 2 + retarget guard |
| 5 | High | the `owner:'me'` exemption and the owner arm skipped api-key narrowing | D3 |
| 6 | High | the horizon change would drift model-facing prose ("30 days") | D6 one constant |
| 7 | High | a per-eraser alias duplicated the subject-key resolver seam | D4 resolver |
| 8 | High | D1 and D7 overclaimed about pre-fix revisions | D1 residue + D7 scope |
| 9 | Medium | the run id left out the tenant | D1.3 |
| 10 | Medium | contention handling was unstated at the call sites | D2 table |
| 11 | Medium | re-stamping on a metadata edit moved credentials; the PATCH replaced metadata wholesale | D3 merge + `workflowId`-only |
| 12 | Medium | an erased job could be re-enabled | D3 erased-enable refusal |
| 13 | Medium | validation sat only on one door | D6 service-level |
| 14 | Medium | the 23-hour-day jump overshoots Troll's 22-hour day | D6 verified jumps |
| 15 | Medium | Run now let a non-actor spend the actor's credentials without a budget | D5 |
| 16–19 | Low | past-slot advance; leap-day copy; where `fleet` is read; cost | D1, D6, D7 |

Track B: `P366D` is additive and host-chosen (RFC 0052 `:41`); the corpus checks
ISO-8601 only. There is no RFC. A CHANGELOG note ships with the change.

## grade-code pass on the implementation (2026-09-30, independent, read-only)

Grade **C+ → B+ on landing the fixes** below. As in rows 1–9, the High findings were
in the fixer's own change.

| Id | Sev | Finding | Fix |
|---|---|---|---|
| `SCTCD-1` | **Blocker** | `scheduled-followup-tool.test.ts` pinned the 30-day horizon and "an enabled typo stays inert", and I never ran it | test corrected to derive the horizon from the constant, and to expect `invalid_cron` for an enabled typo and inert storage for a disabled one |
| `SCTCD-2` | High | a POST with an explicit `jobId` naming an existing row REPLACED it past the per-job gate and the retarget guard | an explicit-id POST over an existing same-tenant row passes `authorizeJob(write)` and refuses a feature-configured row with 409 |
| `SCTCD-3` | High | arm 2 and `owner:'me'` trusted `personalTenantOf`, which is the host-global tenant under SAML (USERS-19) | both require `isPersonalTenantId`; a non-personal "personal" tenant falls to arm 3, and `owner:'me'` there calls `requireTenantWrite` |
| `SCTCD-4` | Medium | `cadenceChanged` was true whenever the field was present, and the panels always send `cronExpr`, so a label edit moved a due slot past the fence without a trace | compared by VALUE |
| `SCTCD-5` | Medium | Run now skipped the budget for actor-less jobs that carry a platform credential | the budget applies unless the actor fires their own job with no server-stamped `configurable` |
| `SCTCD-6` | Low | the contention log said "left for the next pass" when the claim actually holds the slot for about 10 minutes | the log now says so; releasing the claim needs a storage primitive this ADR does not add |
| `SCTCD-7` | Low | the project door rendered refusals in a third shape | it uses the shared `ScheduleCadenceError`, with contention returned as 409 |
| `SCTCD-8` | Low | the resolver's output was unpinned | pinned: `[principal]` at home, `[]` elsewhere, `[]` for a principal key |
| `SCTCD-9` | Low | Run now fires a DISABLED job | **policy, kept**: a paused schedule can still be run by hand, as Temporal's "trigger" on a paused schedule can. An ERASED job is refused (409) |
| `SCTCD-10` | Low | the fleet readout did not flag two revisions | more than one revision ticking within the hour is a readiness BLOCKER, asserted by name |

## Implementation record

| Phase | Commit | Witnesses (each sabotaged red on committed code) |
|---|---|---|
| P1 D1/D2 + D7 store | `a742cd054`, `da0b76e2f` | `test/adr0787-schedule-fencing.test.ts` (12; the contention witness was vacuous at first and was fixed) |
| P2 D3/D4 + D5 route | `2c96d553c`, `c1589a791` | `test/adr0787-schedule-door.test.ts` (the home-tenant guard and Run-now slot witnesses were vacuous at first and were fixed) |
| P3 D6 | `8297569bc`, `84a174526` | `test/adr0787-schedule-cadence.test.ts` (the brute-force oracle caught a jump-search bug before commit) |
| grade-code fixes | `ad757e75a`, `c145e2137` | door + fencing files (the SCTCD-10 witness was vacuous at first and was fixed) |
| ce re-scope: scheduler-only legacy alias + revival | `c562227ca` | door (ambiguous-claim refuse leg), cadence (revival of the prod shape) |
| P5 frontend | `0817f3849`, `e285abef4` | `SubjectSchedulesPanel.states.test.tsx` (each witness sabotaged red). Residual: no component test for the agent-tab Viewer gate |

## Open questions (resolved at /architect)

1. D3 re-stamp: on a `workflowId` change ONLY (finding 11). A cron or label edit does
   not change whose credentials the job spends.
2. D6 `P366D`: an advertisement change with a CHANGELOG note; no corpus change
   (Track B).
3. D5 budget: applies when the clicker is not the actor (finding 15).
