# ADR 0908 — Standing goals: who may act on a goal, and what the judge may read

Status: implemented (2026-10-17, feature loop round 2 row 51; phase record and the closing-grade corrections at the end)

**Extends:** ADR 0039 (the `features/goals` owner) and ADR 0412 (the RFC 0097 controller) **in place**.
No new feature, toggle, store or route.
**Rides:** RFC 0097 (standing goals), RFC 0090 (verifier), RFC 0058 (bounds), RFC 0052 (scheduling).
**Composes:** ADR 0787 D3 (the scheduler POST's write gate), ADR 0815 (the member-removed cascade and the
actor-inactive skip), ADR 0823 (`resolveTenantWorkflow`), ADR 0837 D2 (`tenantMethodScopes`), ADR 0774 D5
(`callerSubjectSpellings`), ADR 0476 (host-stamped run cost), ADR 0464 (subject erasure), ADR 0414
(KickTodo, the one consumer).
**Origin:** feature loop round 2, row 51. `/grade-workflows goals` graded the feature **D**
(`docs/steward/WORKFLOWS-ASSESSMENT.md` § "Standing goals", `GL2WF-1..10`). 11 of 14 route probes in
`backend/typescript/test/adr0908-goals-authority.test.ts` are RED on `3c61a1fc4`.

## Context

A standing goal is an objective the host pursues across runs until a JUDGE says it is satisfied or a
BOUND stops it. Prod advertises the capability (`agents.goals = {judge: verifier, continuation: [schedule,
manual], requiresBounds: true}`), and the eleven `/host/openwop-app/goals` route registrations are served whether or not
it is advertised. KickTodo (ADR 0414) creates one goal per enrollment, arms its daily loop through the
goal, and registers the only verifier.

ADR 0412 made the controller real: it gave goals a verifier, contributing runs, bounds, events and a
scheduler-armed continuation. It checked one authority question, whether the acting principal owns a
principal-owned goal. It did not check:

1. **What the judge reads.** `evaluate` takes the evidence ref and hash from the request body. The
   KickTodo verifier parses the tenant OUT OF THAT REF (`kicktodo-core/progressService.ts:258-262`) and
   never checks the snapshot belongs to the goal. A caller can satisfy a goal with another enrollment's
   completed snapshot, including **one from another tenant** (probe D3, RED). The client cannot write the
   verdict (`goal-completion-judge-only`), but it chooses the evidence, which amounts to the same thing.
2. **Who may arm.** `POST /goals/:id/arm` registers a scheduler job, so it is a scheduler write. It has
   none of the scheduler POST's checks: no `workspace:write`, no `actingUserId` on the job, no check that
   the tenant can run the workflow, and no refusal to replace a job a feature armed. ADR 0787 closed the
   same hole on the scheduler route (`SCTWF-5`: "This door had no scope check at all"), but this second
   door was never added to that fix.
3. **Who may mutate at all.** No route checks a scope. Principal-less goals (every goal the run surface
   creates, and the seeded demo row) are open to any member, a viewer included.
4. Six smaller dishonesties, listed under D4–D9.

**Competitive note.** No `docs/research/*` or `UX_UPGRADE-*` analysis covers agent standing goals (the
nearest, `strategy-gap-analysis.md`, mentions RFC 0097 only to say that strategy is NOT goals). ADR 0820
§8.5 relabelled goals "agent run-continuation, not planning". It has no first-party screen, and the CLI,
the chat tool and KickTodo are its faces. So this ADR measures goals against the bar the ecosystem's
standing-task primitives share, rather than against a market scan. Those primitives are scheduled agent
tasks, durable objectives with budgets, and judge-gated completion, and the bar has three parts:

- the schedule acts as the person who set it, and stops when they lose the right;
- the budget is metered by the platform;
- completion is decided by evidence the platform holds.

D2, D5 and D3 are those three parts. A goals screen is deliberately not in scope (OQ-2).

## Boundaries audit (verified on `3c61a1fc4`)

- One owner, one store: `goalsService.ts:33` `DurableCollection<GoalRow>('goals')`, key
  `${tenant}::${id}`, `tenantOf` = `owner.tenant`. `goalsService.ts` is its only writer. Nothing else
  models a goal. Strategy (ADR 0079) is explicitly "not a reuse of `goals`", and territories named its
  entity `quotas` to avoid the collision.
- Doors into the store: the routes (`routes.ts`), the run surface (`surface.ts`, every pack node), the
  chat tool (`agentTools.ts`, read-only), and the KickTodo service imports (`enrollmentService.ts:20`,
  `progressService.ts:27`, `kicktodo-metrics/verifierSampleService.ts:16`).
- The scheduler has two write doors into the same `registerJob`: `routes/scheduler.ts:280` (gated, ADR
  0787 D3) and `goals/routes.ts:173` (ungated). The fire path (`host/scheduleDaemon.ts:94` `fireJob`)
  skips a job whose actor is inactive and, through ADR 0815, cascade-pauses a removed member's job. Both
  key on `jobActors` (`schedulingService.ts:436`), which a route-armed goal job leaves empty.
- Reusable helpers, not reinvented: `requireTenantScope` / `assertTenantScope` (`featureRoute.ts`,
  `accessControlService.ts`), `callerHoldsTenantScope` + `requireTenantWrite` (the ADR 0775 D1 throwing
  wrapper), `actingUserOf`, `callerSubjectSpellings`, `resolveTenantWorkflow`
  (`host/resolveLaunchDefinition.ts:48`), `tenantMethodScopes` (`host/featureSurfaces.ts:76`), the
  scheduled-job read-gate registry pattern (`host/scheduledJobReadGates.ts`), and `registerSubjectEraser`.

## Decision

> **Revised after the pre-code `/architect` pass (2026-10-17, verdict: accept with changes, 2 Blockers +
> 6 Highs in this section's first draft).** The findings and what changed for each are in § "Pre-code
> architect pass" below. The decisions here are the revised text.

### D1 — One access predicate per lane, the same question everywhere (`GL2WF-3`, `GL2WF-10`)

`features/goals/access.ts` owns the goals authority:

- **`requireGoalsScope(req, scope)`** for the routes. It calls `callerHoldsTenantScope(req,
  tenantOf(req), scope)` (`featureRoute.ts`). That is the provenance-aware predicate the scheduler POST
  reaches through `requireTenantWrite`: an env key is the tenant's operator, an `owk_` key is bounded by
  its declaration and its issuer, and a person is checked under both spellings. Reads ask
  `workspace:read`; every mutation (create, PATCH/POST update, pause/resume/abandon, runs, arm,
  evaluate) asks `workspace:write`. *(A3: the first draft read through `requireTenantScope`, a
  one-spelling, no-provenance predicate. A caller who may write would have been unable to read, and every
  key, the CLI's included, would have got a 403 on GET.)*
- **The chat tool** keeps its fail-empty-without-an-acting-user rule, then calls
  `assertTenantScope(tenantId, actingUserId, 'workspace:read', {personalTenant})`. This is the req-less
  form of the same membership question, and the run surface's seam asks it the same way.
- **The run surface** declares `orgPolicy: { tenantMethodScopes: GOALS_SURFACE_SCOPES }`
  (`get`/`list` read; the rest write). *(A9: the field is `orgPolicy`, not `policy`.)*
- **Owner matching** (`principalDenied`) compares `owner.principal` against a SET of the caller's
  spellings. `ownerSpellings` (today private to `routes/scheduler.ts`, ADR 0787 D4) moves to
  `featureRoute.ts` as `callerOwnerSpellings`, and both the scheduler and goals call it. *(A6:
  `callerSubjectSpellings` drops the pre-bind `oidc:<sub>` spelling a goal created before the bind
  carries.)*

### D2 — Arming is a scheduler write; the scheduler's own doors stop writing goal jobs (`GL2WF-2`)

**Route-only checks.** These stay in `goals/routes.ts`, because KickTodo's `enroll` arms through the
service with no request, and that arm must keep working in a shared workspace (A2):

1. `workspace:write` (D1);
2. `resolveTenantWorkflow(hostSuite.workflowCatalog, tenant, workflowId)`, answering `422
   workflow_not_found` when it does not resolve (the ADR 0823 posture: a foreign id answers like an
   unknown one);
3. a refusal (`409 conflict`) to replace a continuation job that carries `inputs`. Only a service
   caller (KickTodo's enroll) can set `inputs`, and no door can write them onto a goal job (point 3 of
   the next list), so this marker cannot be spoofed.

> **CORRECTED by the closing `/grade-code` (`GL2CD-2`):** stamping a key's ISSUER as the actor
> let the fired run use that person's own credentials past the key's declared scopes and after the
> key is revoked — the reason the scheduler POST stamps the key. As shipped, a key-armed job acts as
> `apikey:<id>` (scheduler parity) and the issuer rides as the narrowing-only `orgScopeSubject`
> (ADR 0879 D7). The paragraph below is the pre-code text.

**Actor stamping, in the service.** `armContinuation` gains `actingUserId?`, and stamps it as
`metadata.actingUserId` when present. The route passes the PERSON behind the credential (A7):

- a session or bearer person: `req.userId ?? principalId`;
- an `owk_` key: its `auth.issuer`. ADR 0815 D4 says a key is a delegation, not an actor, and
  `jobActorIsInactive` reads only `user:` actors;
- an env or wildcard operator: no actor, which is what the scheduler POST stamps for an operator today.

KickTodo passes none, deliberately: its job already names the participant in `inputs.ownerSubject`,
which `jobActors` reads. Stamping `actingUserId` too would change the daily-loop run's Connections/BYOK
resolution, and that is not this ADR's change to make.

**The scheduler's doors.** *(A1, A2.)* A goal's continuation job is owned by goals. Today the generic
scheduler route can re-enable it after goals disarmed it, rewrite its metadata, replace it outright, or
squat its id before the owner arms. That route changes as follows:

1. **`POST /scheduler/jobs` refuses an explicit `jobId` with the `goal:` prefix** (`409 conflict`,
   "managed by its feature"), whether or not the job exists. This closes both replace and squat.
2. **`isFeatureConfigured` treats a `goal:`-prefixed job as feature-configured.** PATCH then refuses to
   retarget it, the way it refuses every feature-built job.
3. **`goalId` and `purpose` join `RESERVED_JOB_METADATA_KEYS`.** A PATCH can neither forge nor drop the
   marker.
4. **A PATCH `enabled: true` on a goal job is refused (409).** Enabling is goals' `resume`, which checks
   the goal is active. Disabling stays allowed, because it only takes authority away.

### D3 — The judge reads only the goal's own evidence (`GL2WF-1`)

- **The contract.** `goalVerifiers.ts` states it for every verifier: *resolve evidence only inside
  `goal.owner.tenant`, and only evidence bound to this goal. Anything else is a thrown failure, never a
  verdict.* Goals already passes the stored goal, and `owner.tenant` survives `toWireGoal`.
- **The KickTodo verifier** (the only registration) enforces it. It refuses unless all three hold:
  - the ref's tenant equals `goal.owner.tenant`;
  - `getEnrollment(goal.owner.tenant, snapshot.enrollmentId)` exists with `goalId === goal.id`;
  - `snapshot.challengeContentHash === enrollment.challengeContentHash`.

  A refusal surfaces as `VerifierFailedError` → 502. The goal is untouched and no replay key is stored.
- **Residue.** A participant can still judge their own goal through `POST /goals/:id/evaluate` with
  their own snapshot and bypass `evaluateEnrollment`'s projection. This self-heals: the next
  `evaluateEnrollment` on unchanged state hashes the same snapshot and replays the recorded verdict,
  which projects. A12 recorded it.

### D4 — The conformance fixture is the harness's, and stays usable (`GL2WF-4`)

- **Who gets it seeded.** `ensureDemoGoal` runs only for an **env-key** credential or the **wildcard
  operator** (`auth.kind === 'env-key' || tenants.includes('*')`). *(A4: the first draft's `auth.kind !==
  'subject'` also matched anonymous visitors and personal `owk_` keys.)* The prod harness binds
  `OPENWOP_API_KEYS` keys (`publish-evidence.sh` `CONF_SECRET`), so it is an env-key.
- **Who sees it.** `isFixtureGoal(row)` (id `demo-standing-goal`) is filtered out of every list a
  non-operator receives, the chat tool included. That hides any row already seeded into a real tenant
  at once, with no migration.
- **Nobody mutates it.** arm, pause/resume/abandon, runs and evaluate answer the uniform 404 on it. The
  generic update keeps refusing `state: satisfied` (422) BEFORE the lookup, so the judge-only leg stays
  non-vacuous.
- **It stays usable.** *(A5.)* The fixture carries no wall-clock bound (`maxLoopIterations: 10` only),
  and `ensureDemoGoal` re-seeds it when the row is missing OR not `active`. A fixture flipped to
  `bound-exceeded` in the past therefore cannot make `?state=active` empty and the leg vacuous.
- **Acceptance criterion:** a run with the prod harness credential in which both behavioural legs of
  `goal-standing-continuation` PASS, not soft-skip (D1 + D4 together).

### D5 — A contributing run is a run of this tenant, and its cost is never below the host's (`GL2WF-5`)

- **Storage.** *(As shipped: the service reads the host-ext storage handle, `hostExtStorage()`, which
  is the app's one Storage — no separate binding was needed.)*
  The service resolves the run itself, so the route and the surface share one rule. *(A8: `BundleScope`
  has no storage, so "through BundleScope" was false.)*
- **The run must belong to the goal's tenant.** `bindContributingRun` loads the run, and an unknown run
  or `run.tenantId !== goal.owner.tenant` is a typed `RunNotFoundError` → 404.
- **The counted cost** is `max(run.metadata.costUsd ?? 0, asserted ?? 0)`. The stamp is the ADR 0476
  host-written terminal cost, reserved from client metadata at create.
- **Honest limit.** For a TERMINAL run, the bound can never be under-counted below what the host
  measured. For a run still in flight there is no stamp yet, so the cost is whatever the caller asserted
  (OQ-3). A run bound twice is still counted once.

### D6 — The run surface acts for the run's person (`GL2WF-6`)

- Every surface mutation passes the run's person (`scope.actingUserId ?? scope.orgScopeSubject`) as the
  acting principal. A narrowing-only use is consistent with `orgScopeSubject`'s contract.
- `create` stamps `owner.principal` from `scope.actingUserId` ONLY. *(A9: `orgScopeSubject` narrows and
  must never grant ownership.)*
- A system run with no person keeps the ADR 0412 tenant-trusted behaviour, and the seam skips its
  `tenantMethodScopes` check, as it does for every surface.
- KickTodo is unaffected: no pack calls `ctx.features.goals`, and KickTodo calls the service directly.

### D7 — Goals are erased with their person (`GL2WF-7`)

`features/goals/compliance.ts` registers `goalsSubjectEraser(tenantId, subjectKey)`. For each goal in
the tenant whose `owner.principal` is one of the subject's key forms (`subjectKeyForms`, the same
expansion every eraser receives), it disarms the continuation job and deletes the row. It is added to
`EXPECTED_SUBJECT_ERASERS`. Tenant deletion is already covered by the collection's `tenantOf`.

### D8 — Bounds stop the continuation, not only the judge (`GL2WF-8`)

- **The seam.** A new host seam, `host/scheduledJobFireGates.ts`, has the shape of
  `scheduledJobReadGates.ts`: `registerScheduledJobFireGate(name, {owns(job), gate(job)})`.
- **Where it runs.** `fireJob` consults the gate whose `owns` matches **immediately after
  `jobActorIsInactive` and before the agent verdict and budget checks**. A closed goal therefore never
  files a KickBot approval or spends budget. *(A10.)*
- **What a refusal does.** It is a skip with the new `ScheduleSkipReason` **`'goal-closed'`** (corrected
  from the draft's `'gate-refused'`: a gate answers its own reason), added to the union and to the
  scheduler UI's reason labels in four locales. A gate that THROWS refuses the slot as
  `'dispatch-error'` and logs it — never as the closed verdict it did not reach (`GL2CD-4`). The slot advances and nothing is counted.
- **Every fire is covered,** because they all go through `fireJob`: daemon, Run now, approved-proposal.
- **The goals gate.** `owns` = the jobId is `continuationJobId(job.tenantId, goalId)`, a server-owned
  marker (D2 point 1). The gate refuses when the goal is missing, not `active`, or `breachedBound` names
  a bound (all three RFC 0058 dimensions). On a breach it runs `transitionBoundExceeded`, so the goal
  closes, the job disarms, and `host.goals.closed` is emitted, the same path the judge uses. The fixture
  is never armed (D4), so the gate never sees it.
- **Honest scope.** Iterations advance only on an evaluation, so for a goal nobody evaluates, the fire
  gate enforces the wall-clock and cost bounds. The iteration bound is enforced at the judge.

### D9 — Create is closed-world, in every lane (`GL2WF-9`)

One `validateGoalInput` in the service is called by `createGoal`, so the route, the surface and KickTodo
all pass through it. *(A11: the first draft closed only the route.)*

- **The bounds check runs first** (422), keeping the conformance leg's 422 for the right reason.
- **422 for an unadvertised judge or mode:** `completion.check: 'host'`, and continuation `commitment`
  or `heartbeat`.
- **400 for any of these:**
  - a verifier goal without `verifierRef`;
  - a caller-supplied `continuation.armRef`;
  - unknown bounds keys;
  - a non-positive or non-integer `maxLoopIterations` or `runTimeoutMs`;
  - a negative or non-finite `maxCostUsd`;
  - an `objective` that is empty or over 2,000 characters.
- **KickTodo's shape passes.** Its objective is `Complete challenge: ${title}`. *(CORRECTED, `GL2CD-3`:
  challenge titles have NO cap, so "capped well below" was false and a long title would have failed
  every enrolment with a 500. KickTodo now clips the descriptive objective to the cap.)* The route maps the typed errors to
  400/422. The surface returns `{goal: null, error}`.
- **The same objective and length rule applies to PATCH.** A `state` query outside the enum is 400.

## Alternatives weighed

- **Gate the routes on the feature toggle instead of scopes.** Rejected: goals has no toggle (ADR 0412
  kept `OPENWOP_GOALS_ENABLED` as the advertisement switch only), and a toggle answers "is it on", not
  "may this person".
- **Move arming onto the scheduler route and delete `/arm`.** Rejected: the CLI's `goals arm`
  (openwop-cli `goals.ts:36`) and the goal-owned job id contract depend on it. Making the second door
  ask the first door's questions is smaller and keeps both.
- **Have goals freeze the evidence itself.** Rejected for D3 (above): it would invert the ADR 0412
  boundary.
- **Delete the demo seed.** Rejected: the judge-only conformance leg soft-skips on an empty list, so
  deleting it would turn a passing leg vacuous. Scoping it to non-person credentials keeps the leg and
  takes the row out of every person's view.
- **Trust only the host stamp for cost.** Rejected for now: an in-flight run has no stamp, so a bind
  would always count 0. `max(stamp, asserted)` never under-counts what the host measured.

## Matrix

1. **Feature-package:** extends `features/goals`. The one core addition is the fire-gate seam (D8):
   core owns the registry, the feature registers, and core imports nothing from features.
2. **Toggle:** none (unchanged).
3. **`ctx.features.goals`:** gains `tenantMethodScopes` and a person (D1/D6).
4. **Node pack:** none (unchanged).
5. **Envelopes:** none.
6. **Agent pack:** unchanged. The assistant pack's `openwop:goals.list` gains the read predicate.
7. **Public surface:** none.
8. **RBAC:** D1/D2/D6, with read = `workspace:read` and write = `workspace:write`, failing closed.
9. **Replay:** an evaluation replay is still keyed on the stored evidence hash. D3 refuses BEFORE any
   verdict is stored, so no replay key is ever written for foreign evidence. The fire gate (D8) reads
   only stored state.
10. **Frontend:** none. The goals line on the CLI page is unchanged.

## RFC verdict

**Host work. No new RFC.**

- Every decision sits on the non-normative `/host/openwop-app/goals` routes, the host-private
  `ctx.features.goals`, or host internals.
- D9 refuses only inputs the existing advertisement already excludes, and validates against the existing
  `goal.schema.json`. No capability flag, event or schema changes, and the advertisement is untouched.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 (incl. the principal spellings, `GL2WF-10`) + D9 (routes, tool, surface policy) | probes D1, D9 |
| P2 | D2 arm door + the scheduler route's goal-job refusals | probe D2 + scheduler-door probes |
| P3 | D3 verifier binding | probe D3 |
| P4 | D4 fixture scoping, D5 run binding | probes D4, D5 |
| P5 | D6 surface person, D7 eraser, D8 fire gate | surface/eraser/fire-gate tests |
| P6 | docs: FEATURES row, the ADR 0412 cross-reference, tracker | — |

## Pre-code architect pass (2026-10-17)

An adversarial `/architect` review of the first draft returned **accept with changes**:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| A1 | Blocker | The scheduler route can re-enable, rewrite or replace a goal's continuation job, and D8 keyed on client-writable `metadata.purpose` | D2 "The scheduler's doors" (prefix refusal, feature-configured, reserved keys, enable refused); D8 keys on the jobId |
| A2 | Blocker | The "feature-armed" marker (`rosterId`/`agentId`) can be supplied by the scheduler POST; the id can be squatted; route checks written into the service would break KickTodo's arm in a shared workspace | D2 splits route-only checks from the service; the marker is `inputs`; prefix refusal stops squatting |
| A3 | High | The read gate used a one-spelling, no-provenance predicate, so keys (the CLI, possibly the harness) would get 403 on GET | D1 `requireGoalsScope` → `callerHoldsTenantScope` for reads and writes |
| A4 | High | `auth.kind !== 'subject'` also seeds the fixture for anon visitors and `owk_` keys | D4: env-key or wildcard only |
| A5 | High | The fixture's 10-minute wall-clock bound plus the exists-only re-seed can make the judge-only leg vacuous | D4: no wall-clock bound; re-seed when not active; acceptance criterion |
| A6 | High | `callerSubjectSpellings` omits the pre-bind `oidc:<sub>` | D1: shared `callerOwnerSpellings` |
| A7 | High | `actingUserOf` stamps `apikey:<id>` for the CLI; the cascade never sees it | D2: stamp the key's issuer; KickTodo unchanged, stated |
| A8 | High | `BundleScope` has no storage; "fails closed on spend" was overstated | D5: module-bound storage; honest limit |
| A9 | Medium | `orgScopeSubject` must not grant ownership; the field is `orgPolicy` | D6 and D1 |
| A10 | Medium | D8 placement relative to the agent and budget checks; the cost bound was omitted; iterations do not advance on a fire | D8 placement, `breachedBound`, honest scope, new skip reason |
| A11 | Medium | Only the route was closed-world | D9: one `validateGoalInput` in `createGoal` |
| A12 | Low | Bypassing the projection through route evaluate | D3 residue (self-heals on replay); the content-hash check was added |
| A13 | Low | Citation drift: 11 routes not nine, `arm` at `routes.ts:173`, probe labels | corrected below |
| A14 | — | RFC gate: agreed, host work | — |

Citation corrections (A13): goals serves **11** route registrations (`GET` list/one, `POST` create,
`PATCH`+`POST` update, three transitions, runs, arm, evaluate), not nine. The arm handler is
`goals/routes.ts:173`. In the probe file, the closed-world create block is labelled `D6`; it witnesses
**D9**.

## Closing grades (2026-10-17) and what they changed

`/grade-code goals` opened at **B** (2 High, 3 Medium, 6 Low) and `/grade-ux goals` at **C+** (3 High,
4 Medium, 4 Low), both on the first implementation. Closed in this PR, each with a probe in
`adr0908-goals-authority.test.ts` (or the named test):

| Id | Was | Now |
|---|---|---|
| `GL2CD-1` (High) | pause/resume rewrote a judged goal to `active`; abandon replaced a verdict | pause/resume of a non-active goal → 409; abandon of a terminal goal is a no-op |
| `GL2CD-2` (High) | a key-armed job acted as the key's issuer | acts as `apikey:<id>`; issuer as `orgScopeSubject` (D2 correction) |
| `GL2CD-3` (Med) | a long challenge title failed every enrolment (500) | KickTodo clips the objective (D9 correction) |
| `GL2CD-4` (Med) | a throwing gate was swallowed and recorded as `goal-closed` | logged, recorded `dispatch-error` |
| `GL2CD-5` (Med) | Run now fired a paused goal's continuation | refused (409) while disabled |
| `GL2CD-6/7/9/11` (Low) | unqueryable log field; a dead job skipping forever; arm refusals revealed foreign goals; a deleted counted run 404'd on re-bind | `skipReason`; the gate disarms; visibility first; dedup before lookup |
| `GL2CD-8` (Low) | the surface `arm` could replace a feature-armed job | the refusal moved into `armContinuation`: only a caller re-supplying `inputs` replaces one |
| `GL2CD-10`, `GL2UX-11` (Low) | doc drift | corrected above; route header has no `/v1` |
| `GL2UX-2` (High) | the chat tool called every workspace goal "the user's" and carried person ids | each goal says `mine`/`personal`; no `owner` reaches the model; the description says so |
| `GL2UX-3` (High) | a KickTodo journey whose goal closed (now at its wall-clock bound, D8) still read "Day N of M"; the card compared against a `closed` state that does not exist | the Progress card shows Ended / Needs review / Completed from the goal state, with a next move |
| `GL2UX-4` (Med) | an unregistered `verifierRef` was accepted and failed only at evaluate | create refuses it (422) |
| `GL2UX-5/7/8` (Med/Low) | "managed by its feature" named no feature; the skip label gave no next step; the `state` 400 listed nothing | the refusal names the standing goal (`details.managedBy`); "…so nothing more will run for it"; the valid states are listed |
| `GL2UX-6` (Med) | the tool ignored a bad `state` filter | typed `validation_error` |
| `GL2UX-9/10` (Low) | KickTodo evaluate 500'd on a goal refusal; pt-BR terms | mapped as the goals route maps them; "juiz"/"limite" |

Filed, with reasons:
- `GL2UX-1` (High) — **the openwop-cli `goals create` default (`--judge host`) is refused, and the CLI
  has no `--verifier-ref`.** That fix lives in the separate `openwop-cli` repo (release-coupled, as ADR
  0896's CLI change was). It is OQ-1 below, now blocking for the CLI's `create`, not for this host.
- `GL2CD-8` residue — the run surface does not resolve the workflow it arms (it has no catalog);
  a dangling id is skipped at fire as `workflow-unresolved`. No pack calls `ctx.features.goals` today.

## Phase record

| Phase | Shipped | Witness |
|---|---|---|
| P1 | D1, D9, owner spellings | `adr0908-goals-authority` D1, D9; `goals-ownership` spellings |
| P2 | D2 + the scheduler doors | D2, D2b |
| P3 | D3 | D3 |
| P4 | D4, D5 | D4, D4b, D5 |
| P5 | D6, D7, D8 | D6, D7, D8 |
| P6 | FEATURES, ADR 0412 note, trackers | — |
| Closing | the table above | "closing grades" block; `ProgressPage.test`; `SubjectSchedulesPanel.states.test` |

27 backend sabotages on a clean tree, each restored from HEAD: 25 red. The two green ones are layered
defences that a sibling check refuses first: the verifier's ref-tenant check (the enrollment lookup in
the goal's tenant refuses), and the route read floor (the vendor-route key gate refuses a narrow key,
and a person cannot name a tenant they are not in).

## Open questions

- **OQ-1 — the CLI's default judge.** openwop-cli `goals create` defaults `--judge` to `host`, which D9
  now refuses (422). That is honest, because the goal could never complete. The CLI should default to
  `verifier` and require `--verifier-ref`. This is filed for the CLI and is not blocking.
- **OQ-2 — no goals screen.** Goals has no first-party UI. Whether a person should see and manage their
  goals outside KickTodo is a product call. It is deferred, not dropped.
- **OQ-3 — in-flight cost.** A run bound before it ends contributes only its asserted cost. Re-reading
  the stamp when the run ends needs a run-terminal hook into goals. It is deferred.
- **OQ-5 — snooze and the wall-clock bound.** KickTodo's goal bound is 2× the challenge duration from
  enrolment, and a snooze does not extend it. With D8 the daily loop now really stops there (it used
  to stop only at an evaluation). Whether snoozed days should extend the bound is a KickTodo product
  call; the Progress card now says the journey ended either way (`GL2UX-3`).
- **OQ-4 — existing rows. MEASURED in prod 2026-10-17 by the lead (read-only transaction, counts
  only; `host_ext_kv` floor 210,514 rows):**
  - **10 goals in total** (9 under `anon:` tenants, 1 under a `user:` tenant).
  - **6 of the 10 are the seeded `demo-standing-goal`.** The pre-fix `GET /goals` seeded one into
    every tenant that looked, so the real goals are 4.
  - **0 actorless route-armed continuation jobs.** The scope query found exactly 1 goal scheduler
    job, so that 0 is not an empty query.
  - **0 goals with `completion.check: 'host'`.** D9's refusal therefore strands no stored goal.

  Exposure was tiny. Neither the arm hole nor the `host` judge was ever used.
- **OQ-4a — the 6 seeded demo rows (PROPOSED prod write; NOT done).** They are fixture data sitting
  in real tenants. D4 already hides them from every person and from the chat tool, and nothing can
  mutate them. Proposed removal, for the lead's approval and run:
  - **Command:** `DELETE FROM host_ext_kv WHERE k LIKE 'hostext:goals:%::demo-standing-goal' AND k NOT LIKE 'hostext:goals:conformance-%'`,
    plus the matching tenant-index markers `hostextidx:goals:<tenant>:…demo-standing-goal`. Read the
    exact marker key shape before writing.
  - **Exempt:** the harness tenants (`conformance-prod`, `conformance-verify`). The harness's next
    list re-seeds them anyway.
  - **Precondition:** read the 6 keys first and delete only those.
  - **Not deleting is also safe.** The rows are invisible, inert and armless. Deleting them only
    removes stored fixture text from the tenants.
