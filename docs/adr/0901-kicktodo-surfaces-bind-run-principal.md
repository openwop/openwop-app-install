# ADR 0901 — KickTodo workflow surfaces bind to the run principal (DEC-1)

Status: Accepted — P1 + P2 implemented (#4952); P3 (enforce) waits on a production log read, the user's call

Date: 2026-10-17

Decision owner: the user (KickTodo Track 2, DEC-1, recorded in the kicktodo
ledger 8e00e396): "bind workflow surfaces to the RUN PRINCIPAL; ADR first; RFC
only if wire; ship behind a toggle that defaults to today's tenant-trust posture
until verified."

KickTodo tracker IDs this closes (they live in the kicktodo repo's trackers,
not here — two of them collide with older IDs in this repo, so this ADR names
them with the `KT:` prefix): KT:KTC-2, KT:KTE-4, KT:KTX-3, KT:KTO-3, KT:KTI-7,
KT:KTY-6, plus the gaps the inventory below found that no ID covered.

## 1. Context

The nine `ctx.features['kicktodo-*']` surfaces were written under the CTI-1
posture ("the run's tenant trust"): a surface closes over `scope.tenantId`, and
any participant-owned operation takes the person it acts for as an ARGUMENT
(`ownerSubject`, `creatorSubject`, `coachSubject`, `buyerSubject`, `subject`,
`authorSubject`, `createdBy`). Manage-only reads and writes skip the
`requireKicktodoManage` / `host:org:manage` check their HTTP routes make.

That was safe while the only callers were host-authored chains. It is not safe
now: any workspace member can start any chain through `POST /v1/runs` or the
`/` picker WITH ARBITRARY PARAMS, so a member can enrol, check in, read
progress, read revenue analytics or change a calendar AS ANOTHER PARTICIPANT.

### 1.1 Who reaches a surface, and with which identity (MEASURED on 8de325237)

`BundleScope` (`host/inMemorySurfaces.ts:243-310`) carries two identity fields,
both stamped host-side from run metadata (`executor/executor.ts:723-774`):

| Lane | `actingUserId` | `orgScopeSubject` (cause) |
|---|---|---|
| Person: `POST /v1/runs`, `/` picker, from-chain, fork | the caller (`routes/runs.ts:698`, `routes/workflows.ts:1119`, `routes/runs.ts:2002`) | – |
| Person via chat tool (replan, factory) | the chatting user (`kicktodo-core/agentTools.ts`, `kicktodo-creator/agentTools.ts:233`) | – |
| User-created schedule | the schedule's creator (`host/scheduleDaemon.ts:209-221`) | – |
| Event trigger / kanban / channel post / approval resume | absent | the binding creator / requester / author / decider |
| Sub-workflow child (ADR 0832 D3) | absent | the parent's person |
| **Feature-created scheduled job** (every KickTodo loop) | **absent** | **absent** |
| Webhook / system job | absent | absent |

Every lane a PERSON controls carries a person (`actingUserId`, or the causing
`orgScopeSubject`). The only lanes with neither are host-authored: the
KickTodo daily-loop, reminder-loop, calendar-sync and session-reminder jobs,
whose inputs the host wrote itself (`enrollmentService.ts:259-280,378-389`,
`calendarSyncService.ts:73-82`, `sessionService.ts:112-127`).

### 1.2 The methods (summary of the inventory)

- **Subject-arg methods (24):** core `enroll`, `setSchedulePreference`,
  `today`, `checkIn`, `lifecycleStatus`, `substitute`, `applyRevisionCommands`,
  `evaluate`, `kickbotCoachTurn`; accountability `listCircles`, `feed`,
  `caseload`, `propose`; commerce `seatAvailability`, `entitlement`,
  `referralCode`; community `analytics`; engagement `leaderboard`, `awards`;
  integrations `consents`, `calendarSync`, `remindToday`; creator
  `createCandidate`, `draftFromPlan`. Each has an HTTP twin that takes the
  subject from the CALLER, never the body.
- **Enrollment-keyed methods with no authority check (6):** core
  `getEnrollment`, `materializeToday`, `progress`, `enrichPlanRevision`,
  `applyMissedWindow`, `freezeEvidence` — the routes use
  `hasKicktodoEnrollmentAuthority`.
- **Manage actions the route gates and the surface does not:** metrics
  `activation`/`engagement`/`factory`/`verifierQuality`; organizations `report`
  (the person lane is already gated by `methodScopes` since `07b4ea814`);
  creator `recordResearch`, `setLessonMedia`, `recordSimulationVerdicts`,
  `submitPublication`, and the candidate reads; accountability
  `sendSessionReminder`.
- **A privilege escalation:** `kickbotCoachTurn` mints a scheduled
  convene-turn job stamped `metadata.actingUserId = args.ownerSubject`
  (`kickbotCoachTurnService.ts:163`). A member who starts reminder-loop with
  someone else's `(enrollmentId, ownerSubject)` gets a run that ACTS AS that
  person.

## 2. Decision

**D1 — The person lane binds.** When the run has a person — `actingUserId`, or
else the causing `orgScopeSubject` (the same "actor, else cause" order the seam
floors and `assistant`/`documents`/`bi` surfaces already use) — every KickTodo
surface method acts for THAT person:

- a subject argument may be omitted (it defaults to the person) or must EQUAL
  the person; anything else is `forbidden` (`subject_mismatch`), never a silent
  substitution;
- an enrollment-keyed method requires `hasKicktodoEnrollmentAuthority(person)`
  — the predicate its HTTP route calls (`features/featureRoute.ts:132`);
- a manage action requires `hasKicktodoManageAuthority(person)`
  (`featureRoute.ts:107`), or `host:org:manage` for organizations `report` —
  one predicate per method, SHARED with the route (CLAUDE.md: a tool and its
  route share the predicate);
- a coach/creator/buyer subject is checked against the SAME relation the route
  checks (coach grant, creator ownership, buyer = person).

**D2 — The system lane keeps tenant trust, explicitly.** A run with no person
and no cause can only be started by the host (§1.1), so its arguments are
host-authored. Those runs keep today's behaviour. This is written into the
helper as a named branch (`lane: 'system'`) and logged, not left implicit, and
the helper refuses a system-lane call to a method declared PERSON-ONLY (the
participant reads and the manage reads, which no host job calls).

**D3 — `kickbotCoachTurn` may only mint an actor the lane already has.** On the
person lane the minted job's `actingUserId` is the run's person (D1 makes
`ownerSubject` equal it). On the system lane the reminder-loop is host-authored
and keeps working. A person can no longer mint a job that acts as someone else.

**D4 — One helper, every surface.** `bindKicktodoSurfaceCall(scope, method,
args, spec)` in `features/kicktodo-core/surfaceBinding.ts` (the seam feature
every other `kicktodo-*` already depends on). `spec` declares, per method:
`subjectArg?`, `enrollmentArg?`, `authority: 'none' | 'enrollment' | 'manage' |
'org-manage' | 'coach' | 'creator'`, `personOnly`. A table-driven test asserts
EVERY method of the nine surfaces has a spec entry, so a new method cannot ship
unbound.

**D5 — Behind a toggle that defaults to today's posture.** A per-tenant
sub-toggle `kicktodo-core.run-principal-binding` (`extraToggleDefaults`,
`status: 'off'`, `bucketUnit: 'tenant'`; read with `resolveOne(id, { tenantId,
userId: actingUserId })` as the seam does). OFF: the helper computes its verdict
and LOGS what it would refuse (`kicktodo_surface_unbound` with method, lane,
reason — never the subject value), then proceeds as today (shadow mode). ON:
it enforces. The flip is per tenant, after the shadow log for that tenant is
clean.

**D6 — No wire change, no RFC.** Everything here is host-internal: the surfaces
are `ctx.features` host extensions (ADR 0014), `BundleScope` is host state, the
error codes are the host's existing `forbidden` / `not_found` shapes, and no
run event, capability flag or endpoint contract changes.

## 3. Alternatives weighed

- **Strict binding to `actingUserId` only.** Breaks every KickTodo loop (they
  have no person) and the cause lanes. Rejected (D1/D2).
- **Declarative `methodScopes` only (the organizations precedent).** It checks
  scopes, not subject equality or enrollment ownership, and skips the check when
  there is no person. Kept where it fits (org `report`), not sufficient alone.
- **Carry the scheduled job's binding into `BundleScope` and check system-lane
  args against it.** Stronger for the system lane, but the system lane is not
  person-reachable today; deferred as D2's follow-up if a person-reachable
  no-actor lane ever appears.
- **Remove subject args entirely.** The system lane needs them (a daily-loop
  acts for the enrollment's owner). Rejected.

## 4. Phases

| Phase | What | Gate |
|---|---|---|
| P0 | This ADR | review |
| P1 | `surfaceBinding.ts` helper + per-method specs for all nine surfaces + the completeness test; toggle declared OFF; shadow logging — **implemented (pending verification)**, see §6 | targeted tests: every method × {person-match, person-mismatch, cause, system} |
| P2 | `kickbotCoachTurn` D3 + tests proving a person cannot mint a job for another subject — **implemented (pending verification)**, see §6 | sabotage-witnessed |
| P3 | Flip ON for the test/demo tenant; read the shadow log in prod for the KickTodo tenant | user go (prod read) |
| P4 | Default ON; remove shadow branch after one clean release | user go |

## 5. Open questions

- [ ] Should a coach's `caseload`/`propose` on the cause lane (approval resume
      by a coach) count the decider as the coach? (Current reading: yes — the
      decider is the person who acted.)
- [ ] `freezeEvidence` / `applyMissedWindow` have no HTTP route; are they
      system-only (personOnly = false, authority = enrollment on the person
      lane)? (Proposed: yes.)
- [ ] P3 needs a production log read on the KickTodo deploy — the user's call.

## 6. Implementation record (P1/P2 — verified, #4952)

Verified on the rebased branch (f68255e37): `kicktodo-surface-run-principal` +
`adr0900-log-reason-code` 49/49; all 124 `*kicktodo*` files plus the trust,
fence, compaction and prompt-parity ratchets 1281/1281; tsc 0. Sabotage: the
toggle-gated `boundActor` reds the toggle-OFF D3 case; disabling the coach-turn
`actor_mismatch` refusal reds the direct-service and toggle-OFF cases.

| Phase | Where | Test |
|---|---|---|
| P1 | `features/kicktodo-core/surfaceBinding.ts` (`bindKicktodoSurface`), a `KICKTODO_*_SURFACE_SPECS` table in each of the nine `surface.ts`, the sub-toggle in `kicktodo-core/feature.ts` `extraToggleDefaults` | `test/kicktodo-surface-run-principal.test.ts` §1–§3 |
| P2 | `CoachTurnRequest.boundActor` + the mint-time assertion in `kickbotCoachTurnService.ts`; the core surface passes the person when enforced | same file §4 (the direct-service case is the sabotage witness) |

Decisions the implementation made that the text above left open:

- **The helper's shape.** `bindKicktodoSurface(surfaceId, scope, impl, specs)`
  wraps a whole surface rather than one call (D4 named
  `bindKicktodoSurfaceCall`). The spec type requires a spec for every impl key,
  and the build throws on a mismatch in either direction.
- **`personOnly` is wider than D2's wording.** D2 named "the participant reads
  and the manage reads". The specs mark every method that no host job calls as
  person-only, writes included (`enroll`, `checkIn`, `substitute`,
  `setSchedulePreference`, `applyRevisionCommands`, `propose`, `referralCode`,
  the creator writes). The reason: the system lane also covers an inbound
  webhook (§1.1), whose args are not host-authored, so a system-lane write that
  names a participant is the same hole. The system-callable set is the host
  jobs' ops (`materializeToday`, `evaluate`, `kickbotCoachTurn`, `remindToday`,
  `calendarSync`, `sendSessionReminder`), `applyMissedWindow` and
  `freezeEvidence` (§5, as proposed), and the reads that touch no person's data.
  The test pins that set.
- **Coach, creator and buyer relations** are not a separate authority kind.
  Each route passes `subjectOf(req)` to the service, which checks the relation
  (coach grant, circle membership, creator ownership). Binding the subject arg
  to the person makes the surface call the same thing. The one relation the
  services do not check is `sendSessionReminder` (it has no route). On the
  person lane it requires that the person owns the circle, which is the
  authority `scheduleSession` requires.
- **Refusal shapes.** A subject mismatch and a person-only refusal are
  `forbidden`. An enrollment or relation refusal is a uniform `not_found`, as
  the routes answer. Manage is `forbidden_scope` with `requiredScope`, the
  shape `requireKicktodoManage` uses. Org-manage rethrows `assertRunScopeOrg`'s
  own error, and a missing `orgId` is `validation_error`.
- **Manage on the actor lane** also accepts the actor's request-stamped
  `personalTenant === tenantId`. That is the run form of the route's
  `isOwnPersonalWorkspace(req)`, which is how an `anon:` sandbox owner passes.
  It does not apply to the cause lane.
- **Logs.** `kicktodo_surface_unbound` (shadow) and `kicktodo_surface_refused`
  (enforced) carry surface, method, lane, `reasonCode` and runId. The reason
  rides `reasonCode`, not `reason`: the logger hashes every `reason` field
  (ADR 0900 D2), which would leave a P3 read nothing to count. The seven
  `kicktodo_*` codes are added to the closed vocabulary in
  `observability/logReasonCodes.ts`. A personal tenant id
  is logged as `personal` because it is its owner's subject. A shared workspace
  id (the P3 read target) is logged as is.
- **D3 is always on, independent of the toggle.** The first cut enforced it
  only with the toggle ON, which left the escalation open in shadow mode. That
  was overturned before merge: a job that acts as someone else is a privilege
  escalation, not a shadow-log case. On every person lane (actor or cause) the
  surface passes the person as `boundActor`, and the service refuses
  (`forbidden`, `actor_mismatch`) a turn whose job would act as anyone else.
  With the toggle OFF the call is also logged as `kicktodo_surface_unbound`.
  Everything else in shadow mode is unchanged. An empty `ownerSubject` is not
  refused: it can mint nothing and keeps today's `not-found` skip. The
  system-lane reminder-loop passes no `boundActor` and is unaffected.

