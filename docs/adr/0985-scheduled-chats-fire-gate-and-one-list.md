# ADR 0985 — Scheduled agent chats: ask the target before paying the model, one cadence floor, and one honest list

Status: implemented (merged #5270 `f3a80dd9e`, 2026-10-26; Accepted 2026-10-26 after the adversarial `/architect` pass: 0 Blockers; 4 High, 8 Medium and 7 Low folded into D1–D7)

Feature loop round 2, row 58 (Scheduled agent chats: `scheduled-agent-chats`). Amends ADR 0125
(recurring scheduled agent chats), ADR 0309 (the follow-up tool) and the chat-first-port A3 recurring
tool. It uses the ADR 0908 D8 fire-gate seam and does not change it. It is host-only: no wire change,
no new RFC, and nothing new is advertised.

## Context

The round-1 grade was B+ / — / — (workflows only). The chat-first-port audit row A3 named four
defects. Re-measured on `95aaef11e`:

- A recurring-from-chat tool exists (`openwop:tasks.schedule-recurring`, `agentTools.ts`).
- The orphaned FE create client is gone.
- A paused chat reads "Paused".
- Pause and resume have a surface.

`SCC-2` ("the visibility gate is create-only") is closed in effect by ADR 0879 D7: the agent-runner
asks `authorizeRunConversationWrite` before it appends the reply.

**Prod, read-only, 2026-10-26:** 0 `schedchat:config` rows, 0 `recurring:` / `followup:` tool jobs,
and 1 turn-workflow run ever (2026-10-09, completed). Nobody uses the feature yet. Every decision
below is correctness before adoption, and none of them migrates a row.

Eight probes, all red on `95aaef11e` (`test/adr0985-scheduled-chats.test.ts`):

1. **`SC2WF-1` — the model is paid before anyone asks whether the reply can land.** ADR 0879 D7's
   check runs after the model call (`agentRunnerNode.ts`, the verdict after `dispatch`). A schedule
   whose conversation was deleted, or that its person can no longer see, behaves the same way on
   every fire, forever:
   - it starts a run;
   - it pays a managed-key (`managed:openwop-free`) model call;
   - it fails `conversation_write_refused`;
   - it stays armed.

   The scheduler has had a per-feature fire gate since ADR 0908 D8 (`scheduledJobFireGates.ts`), and
   this feature registers none. Probes 1 and 2.
2. **`SC2WF-2` — "at most hourly" holds only where the chat tool creates a job.** The floor lives
   inside the recurring tool (`MIN_RECURRING_INTERVAL_MS`). Two other doors skip it:
   - The org create route takes `*/5 * * * *`. Probe 3.
   - The generic scheduler `PATCH` (the owner's Schedules tab) re-cadences a tool job to
     `* * * * *`, and that job then fires every minute on the managed key. Probe 4.

   A gate on the creation lane is not a gate on the use lane.
3. **`SC2WF-3` — the generic scheduler route re-arms jobs this feature owns.** `schedchat-<id>` jobs
   are re-enabled, re-cadenced and deleted through `/scheduler/jobs/:id`. The feature's config row
   keeps its own copy of `enabled` and `cronExpr`, so the page says "Paused" while the job fires.
   Probe 5.
4. **`SC2CD-1` — the list reads a copy, not the job.** `enabled` comes from the config row. A job
   disabled or deleted by another door still reads "Active". A slot the daemon skipped (budget,
   deactivated actor, paused agent, lapsed plan) reads "Active" with a next run. Probe 6.
5. **`SC2CD-2` — `POST …/pause` with no body RESUMES** (`enabled !== false`). The read-modify-write
   in `setScheduledChatEnabled` has no CAS. Racing the subject eraser, it can write back the erased
   creator's id and re-enable the job. Probe 7.
6. **`SC2CD-3` — an erased creator's schedule can be resumed.** The config row's `createdBy` is
   `erased:subject` and the host eraser set the job's `metadata.orgScopeSubject` to `[erased]`, but
   `isErasedJob` does not read `orgScopeSubject`, so `setJobEnabled(true)` re-arms it. Probe 8.
7. **`SC2UX-1` — chat-created schedules are invisible.** The page and the dashboard tile read config
   rows only. The tools' jobs are scheduler rows owned by the user. The Profile Schedules tab
   (`?owner=me`) lists only the personal tenant, so a recurring chat created in a shared workspace
   appears in no UI at all. Yet the tool tells the model "They can pause or cancel it from their
   Schedules list".
8. **`SC2UX-2` — the empty state is a dead end.** "Create a scheduled chat to run an agent on a cron
   schedule" is printed on a page that has no create action. Rows show:
   - the raw `agentId` and raw cron, with no timezone;
   - no prompt, though search matches on it;
   - no link to the conversation the schedule posts into.
9. **`SC2CD-4` — a Viewer can arm standing autonomous work.** The recurring and follow-up tools check
   only that a human asked. In a shared workspace a Viewer (who writes nothing, ADR 0879) creates a
   job that fires indefinitely. The same Viewer then cannot pause or delete it through the scheduler
   route, which needs `workspace:write`.

## Decision

### D1 — A fire gate for every job this feature owns

`scheduledChatService.ts` registers `registerScheduledJobFireGate('scheduled-agent-chats', …)`.

- **What it owns.** It owns `job.featureId === 'scheduled-agent-chats'`. `featureId` is
  server-stamped: the scheduler route never reads it from a body. This covers `schedchat-*`,
  `recurring:*` and `followup:*`.
- **What it checks, in order.** Before the agent verdict, the budget and the run:
  1. **The cadence floor (D2).** A job whose cron fires more often than hourly is skipped as
     `cadence-too-frequent`. One-shot jobs (`ONE_SHOT_CRON`) are exempt.
  2. **The person.** The human behind the job (`metadata.actingUserId`, else
     `metadata.orgScopeSubject`) must still hold `workspace:read` in `job.tenantId`
     (`hasWorkflowScope`, with `metadata.personalTenant`). A creator who left the workspace or was
     deactivated is otherwise still "visible" to their own conversation (`isVisibleTo` keeps the
     owner, and an unowned conversation is visible to everyone), so the target check alone does not
     stop them (architect H2). Refused as `target-refused`.

     > **Correction (grade-code SC2CD-5, same PR):** this asked `workspace:read`. It asks
     > `workspace:write`, the authority arming the job took (D6): with read, a member
     > demoted to Viewer kept their schedule firing while being unable to resume it.
     > Restoring the role resumes it on the next slot. A job with no human (a pre-ADR-0879 row
     the backfill missed) falls through to the target check, which decides it.
  3. **The target.** It calls `authorizeRunConversationWrite(hostExtStorage(), …)` with the inputs
     the write will use:
     - `conversationId` and `agentId` from `job.configurable`;
     - `actingUserId` and `orgScopeSubject` from `job.metadata`;
     - `personalTenant` from `job.metadata`.

     A refusal skips the slot as `target-refused`.
- **What a skip costs.** A refused slot starts no run, pays no model, files no approval and spends
  no budget.
- **Why a skip and not a pause.** It is not destructive, like every other skip. Restoring access
  resumes the schedule on its next slot. The skip is recorded on the job (`lastSkipReason`), and D4
  shows it.
- **The write-time check stays.** The agent-runner still checks at write time. The pre-flight
  removes the model spend; it does not replace the authority check (TOCTOU).
- **A gate that throws** refuses with the gate's registered `refusal`, which this gate sets to
  `dispatch-error` (as goals and campaign-ops do).
- **A refused follow-up is spent.** A one-shot's slot is consumed whether it fires or skips, so
  "restoring access resumes" holds for recurring jobs only. D6 lists a spent follow-up that ended in
  a skip, so the user learns it was missed (architect M3).
- **An operator `workflowId` override** is checked against `configurable.conversationId`, the
  schedule's declared target, not against whatever that workflow writes. Intended: the schedule
  names its conversation (architect L3).
- **Positive controls are part of the decision** (architect H4): a tool `recurring:` job carrying
  only `metadata.actingUserId`, a channel schedule whose agent is a member and whose poster holds
  `workspace:write`, and a schedule in a personal tenant must each fire. The existing
  `scheduled-chat-firing.test.ts` fixtures fire into a conversation that does not exist; they gain a
  real one.

The tools now stamp `metadata.personalTenant: scope.personalTenant` (they did not), so the person
check and the write gate read the same personal-tenant shortcut a request does (architect M2).

**`isErasedJob` reads `orgScopeSubject` too** (host, `schedulingService.ts`): a job whose
`metadata.orgScopeSubject` is the erased marker never fires and cannot be re-enabled at any door,
including the claim fence. The host eraser already disables such jobs; this makes the state terminal
the way `actingUserId` erasure is (architect H3).

Two `ScheduleSkipReason` members are added: `target-refused` and `cadence-too-frequent`.

### D2 — One cadence floor, in the service

`scheduledChatService.ts` exports `cadenceRefusal(cronExpr, timezone, now)`. It owns the walk that
the recurring tool used to do inline: 25 adjacent fires over more than 24 hours, none closer than an
hour. It has three callers:

- `createScheduledChat` (the org and channel routes): `400 validation_error`,
  `details: { field: 'cronExpr', code: 'cadence_too_frequent' }`;
- the recurring tool: `cadence_too_frequent`, unchanged;
- the fire gate (D1).

The channel panel's presets are already hourly or coarser.

The floor also says "no" on the generic `PATCH` (architect M4). `ScheduledJobFireGate` gains an
optional `cadenceRefusal(cronExpr, timezone, now)`; the scheduler route consults the gate that owns
a job before applying a `cronExpr` or `timezone` change, and answers `400 validation_error`,
`code: 'cadence_too_frequent'`. The fire gate remains the backstop for any other writer.

### D3 — The feature owns `schedchat-` jobs

The D1 gate registers `reservedJobIdPrefix: 'schedchat-'`. Under ADR 0908 D2 the scheduler route
then:

- refuses an explicit job id under the prefix;
- refuses every edit except a pure `enabled: false`;
- refuses "Run now" on a paused job.

Disabling stays allowed because it only takes authority away. D4 makes the list show it.

`ScheduledJobFireGate` gains an optional `managedBy: { id: string; message: string }`, and the
registry gains `reservedJobOwner(jobId)` (prefix → `managedBy`) beside the boolean
`isFeatureReservedJobId`. The route's three 409 sites (create-squat, `PATCH`, "Run now") answer
with that owner's message and `details.managedBy: owner.id` instead of the hard-coded `'goal'`. Today every reserved prefix answers "This schedule
belongs to a standing goal", which is false for campaign-ops reports and would be false here. The
goals gate passes its existing message, so its behaviour is byte-identical. The generic `DELETE`
stays allowed, as it is for goals; D4 reports the orphaned row.

Tool jobs (`recurring:` / `followup:`) are NOT reserved. Their owner pauses, resumes, edits and
deletes them from the Profile Schedules tab, and ADR 0787 D3 already refuses a workflow retarget for
them.

### D4 — The list reads the job

`listScheduledChatsWithStatus` projects from the scheduler row:

- **`enabled`** is `job.enabled`. With no job, it is `false` plus `unscheduled: true`.
- **`lastSkip: { reason, at }`** when the latest skip is newer than the last run (both are ISO
  strings on the row; compared as instants).
- **`agentName`** is the resolved agent's persona, falling back to the id.
- **`timezone`** is the job's timezone.

`lastError` is unchanged.

### D5 — Pause and resume say which, and cannot resurrect

- Both pause routes (org and channel) require a boolean `enabled`. Anything else is a 400.
- `setScheduledChatEnabled` takes the config row through `compareAndSwap` FIRST (re-read on
  conflict, 4 attempts; the `createdBy` check runs inside the CAS callback), and only then flips the
  job. Flipping the job first reopened the race with the eraser (architect H3): the job was armed
  before the erased row was seen.
- Resuming a row whose job is missing (D4 `unscheduled`) is refused: `409 conflict,
  code: 'unscheduled'`. It used to write `enabled: true` to the config and arm nothing (architect M5).
- Resuming a row whose `createdBy` is `erased:subject` is refused:
  `409 conflict, code: 'creator_erased'`. The schedule has nobody to post for; delete it and create
  a new one. The host `isErasedJob` change (D1) refuses the same resume at the job, whichever door
  asks.
- Re-owning on resume (the ADR 0815 D4 move) was considered and deferred: no row in prod needs it.
- **Added in the same PR (grade-code SC2CD-7):** an org resume re-resolves the agent and
  answers `409 agent_missing` when it is gone. Any `workspace:write` member who can see the
  conversation may resume an org schedule; it still posts as its creator, whom D1 re-checks
  every slot.
- **Every config-row writer goes through one compare-and-swap** (`casChat`): the agent-delete
  pause and the subject eraser used to `put` a stale row, which could write back an erased
  creator's id (SC2CD-6).

### D6 — Chat-created schedules are listed and managed by the feature

`GET /scheduled-chats/mine` is gated on toggle and plan (`requireFeatureEnabled`), and anonymous
callers get `[]`. It lists the caller's tool jobs:

- **Which jobs.** `featureId === 'scheduled-agent-chats'` and `metadata.tool` in the two tool ids.
- **Where.** In the active tenant AND the personal tenant.
- **Whose.** In the ACTIVE tenant, only `callerSubject(req)` (`req.userId ?? principalId`), the
  exact spelling the tools stamp as `scope.actingUserId`. In the PERSONAL tenant (only when
  `isPersonalTenantId`), every spelling from `callerOwnerSpellings`. Principal ids carry no issuer,
  and that helper's own contract confines its extra spellings to the personal tenant; matching them
  in a shared tenant could list another member's job (architect H1).
- **Reach.** The active and personal tenants only: a job in another workspace appears while that
  workspace is active (architect L6).
- **Which kind.** By the server-minted job-id prefix (`recurring:` / `followup:`), never
  `metadata.tool`, which the scheduler route's PATCH merged from the client body; `tool` is
  now a reserved metadata key there too (it also fed the tools' per-user caps) (code-review M2).
- **Which rows.** A follow-up that ran (no `nextFireAt`, a `lastRunAt`) is omitted; a follow-up
  whose only slot was skipped is kept, with its skip, so the miss is visible (architect M3). 
  > **Correction (implementation, 2026-10-26):** this said rows are filtered by the
  > conversation predicate `canSeeScheduledChat`. Ownership is the read predicate
  > instead, the one `?owner=me` uses: these are the person's own instructions, and a
  > conversation they lost access to is exactly the case the row must still show (its
  > skip says `target-refused`). Filtering by visibility would hide the schedule that
  > needs attention.
- **The shape.** The D4 projection, with `kind: 'recurring' | 'followup'`, `jobId` and `prompt`
  (the task).

`POST /scheduled-chats/mine/:jobId/pause {enabled}` and `DELETE /scheduled-chats/mine/:jobId`:

- act only on a job that the list above would return, and answer 404 otherwise (no existence
  oracle);
- let the owner pause and delete with no role check, because both remove authority;
- require `workspace:write` in the job's tenant to resume (`hasWorkflowScope`);
- refuse a resume of a job paused because its member left (ADR 0815 D4) with `409
  acting_member_removed`. That state is TERMINAL for feature jobs at every door (`updateJob` throws
  `ActingMemberRemovedError` when `featureId` is set); the row says "delete it and ask again in
  chat" (architect M1);
- honour a narrowed `owk_` key: a key that did not declare `workspace:write` cannot pause, resume or
  delete (architect L7).

Both tools require `workspace:write` in `scope.tenantId` (`hasWorkflowScope` with
`scope.personalTenant`, as `canvasSurface.ts` does). The personal tenant passes through the
implicit-owner shortcut. Both tools refuse an anonymous (`anon:`) actor: its sandbox is ephemeral
and `/mine` lists no anonymous jobs, so the schedule would be invisible (architect M7). Every
model-facing string that said "their Schedules list" (the result notes and the
`too_many_followups` / `too_many_recurring` refusals) says "the Scheduled chats page" (architect L5);
the new refusal codes get an `LLM-EXCHANGE-AUDIT` row.

The org create route refuses a conversation that does not exist in the tenant (404, no chat
session). It used to call that "harmless"; under D1 every slot of such a schedule is a skip
(architect M8). A legacy session with no meta stays bindable.

### D7 — The page tells the truth and names the real create path

`ScheduledChatsPage`:

- **Two sections.**
  1. *From your chats*: `/mine`, independent of the org picker, with its own empty state.
  2. *Workspace schedules*: the org list, as today.
- **Rows show:**
  - the agent name;
  - a prompt excerpt;
  - the cadence, humanized by one helper extracted from `ChannelSchedulePanel` (daily / weekdays /
    weekly / hourly at a time, else the raw cron) so neither page imports the other's chunk
    (architect L4), and its timezone;
  - the next run;
  - a status of Active, Paused, "Not scheduled" (D4 `unscheduled`) or Skipped, with a localized
    reason (D4 `lastSkip`) and `lastError` as today;
  - an "Open conversation" link (`/chat?conversation=…`, the tile's link).
- **The empty state names chat.** The copy is "Ask an agent in chat, e.g. 'every weekday at 9,
  summarize…'", with an **Open chat** button. The org create route stays an API, not a form (ADR
  0058 chat-drivability; one chat).
- **Strings** go in the existing lazy `scheduled-chats` namespace in all four locales, never the
  shared chunk.
- **The two new skip reasons are mirrored** in every FE copy of the union and its label map
  (`agents/scheduleClient.ts`, `features/assistant/assistantClient.ts`,
  `schedules/SubjectSchedulesPanel.tsx` `SKIP_REASON_KEY`, `agents/RecurringTasksPanel.tsx`), with
  keys in all four locales, so the Profile and Agent schedule panels label them (architect M6).

## Alternatives considered

- **Auto-pause after N refused fires.** It is destructive and needs a counter. The skip is free and
  self-healing, and D4 makes it visible. Rejected.
- **Make the chat tools write `schedchat:config` rows**, so there is one store. A tool job has no
  org. Moving it under an org would change who may see and manage it, and the scheduler row is
  already the truth (D4). Rejected: one read projection over both, no second store.
- **Read chat-created schedules from the FE through `?owner=me`.** It misses every shared-workspace
  job (finding 7) and lacks the agent name and skip projection. Rejected.
- **Floor only at create, on every door.** It still misses the generic `PATCH`. The fire gate is
  the one place every door passes through. Kept, alongside create-time errors so users hear "no" at
  the moment they ask.

## Consequences

- **`isErasedJob` reading `orgScopeSubject` reaches goals and campaign-ops** (code-review L6):
  both stamp it (`causedBy`, the report's actor). A goal whose causer was erased can no longer
  re-arm its continuation (`goalsService` logs the refusal), and a client report whose actor
  was erased stays disabled. Both are the erasure posture this ADR wants; neither surfaces the
  refusal to its owner yet (residue).

- A refused or too-frequent schedule costs one KV read and one meta read per slot, not a model call.
- A Viewer can no longer arm recurring work from chat in a shared workspace (D6). Personal
  workspaces are unaffected.
- The campaign-ops and goals 409s name their real owner.

## Implementation plan

| Phase | Scope |
|---|---|
| P1 | D1–D5 backend + `adr0985-scheduled-chats.test.ts` (8 baseline probes) |
| P2 | D6 routes + tool write floor + tests |
| P3 | D7 page + client + 4 locales + FE tests |
| P4 | grades, residue, FEATURES/tracker |

## Implementation record

| Phase | Scope | Commit (on `main` via #5270) |
|---|---|---|
| — | ADR reserved | `bdf2db454` |
| — | ADR accepted + 8 baseline probes (red on `95aaef11e`) | `0c5ff4f1c` |
| P1/P2 | D1–D6 backend: fire gate, cadence floor, reserved prefix + named 409s, job-truth list, pause/resume CAS, `/mine`, tool write floor | `03d2d02aa` |
| P3 | D7 page, client, shared cadence + skip-reason helpers, 4 locales | `55d5020a9` |
| P3 | M2/M8 witnesses, FEATURES row, exchange-audit row, D6 correction | `29c0bdbcc` |
| P4 | tracker IN PROGRESS | `963682974` |
| P4 | `/grade-ux`, `/grade-code`, `/code-review` findings closed (SC2CD-5..11, SC2UX-1..5/8, review M1–M3) | `4e5889ed9` |
| — | merge | `f3a80dd9e` |

Witnesses: `backend/typescript/test/adr0985-scheduled-chats.test.ts` (26 cases), the
scheduled-* suites, `frontend/react/src/features/scheduled-chats/__tests__/`; 33 sabotages
red, then restored. Closing grades: WF C+ → A−, UX C → B+, CODE B− → A−.

### Post-deploy check

Deploy 108, revision `openwop-app-backend-01055-sph` (created 2026-10-26T20:13:27Z),
serving `f3a80dd9e` (`/api/readiness` `build.commit`). Read-only, at 20:16Z, against a
19:45Z snapshot taken while `e79425222` served:

- **Nothing of this feature to observe.** Prod still has 0 `schedchat:config` rows and 0
  `recurring:` / `followup:` jobs, so the fire gate owns no job yet. No job anywhere carries a
  `target-refused` or `cadence-too-frequent` skip.
- **Other jobs unchanged.** Same 15 enabled jobs, same 3 with a run in the last 24 hours (the
  three assistant loops), same 8 skips in 24 hours, all `workflow-unresolved` (below). The one
  goals job is disabled, as before; prod has no campaign-ops report jobs. **No fire has happened
  on the new revision yet:** the 20:00Z fires ran on the previous one, and the next hourly slot
  is 21:00Z. So "goals and campaign-ops still fire" is unobservable here, not confirmed.
- **Logs since the revision was created:** `schedule daemon started` (20:14:41Z) and no
  scheduler or scheduled-agent-chats warning or error, and no ERROR-severity line at all.

## Architect pass (2026-10-26, pre-code)

An independent adversarial pass verified all nine Context findings on `95aaef11e` (one wording fix:
the erased marker on the job is `[erased]`, not `erased:subject`) and confirmed: the gate runs after
`feature-disabled` and `actor-inactive` and before the agent verdict and budget; "Run now" passes
through it; a skip cannot hot-loop (`claimDueSlot` advances first); replay and fork never call
`fireJob`; the heartbeat fallback creates no scheduler job; the feature's own flows never go through
the reserved route. Findings folded:

| # | Sev | Where | Folded as |
|---|---|---|---|
| H1 | High | D6 | active tenant matches `callerSubject` only |
| H2 | High | D1 | person check (`workspace:read`) before the target check |
| H3 | High | D1, D5 | `isErasedJob` reads `orgScopeSubject`; CAS the config before the job |
| H4 | High | tests | tool-job, channel and personal-tenant positive controls; firing fixtures |
| M1 | Med | D6 | member-removed pause is terminal for feature jobs |
| M2 | Med | D1, D6 | tools stamp and pass `personalTenant` |
| M3 | Med | D1, D6 | a skipped follow-up is listed |
| M4 | Med | D2 | gate `cadenceRefusal` consulted on `PATCH` |
| M5 | Med | D5 | resume of an unscheduled row → 409 |
| M6 | Med | D7 | FE skip-reason unions, maps, i18n |
| M7 | Med | D6 | tools refuse anonymous actors |
| M8 | Med | D6 | org create refuses an absent conversation |
| L1–L7 | Low | various | wording, `reservedJobOwner`, override intent, cadence helper, tool copy, reach, narrowed keys |

## Residue (filed, not closed by this ADR)

- `SC2UX-6` the dashboard tile does not merge `/mine` (one more dashboard fetch).
- `SC2UX-7` map `lastError` codes to copy; `SC2UX-9` Open chat as a link scoped to an agent;
  `SC2UX-10`/`-11` copy nits; the feature-off card has no action; live click-throughs
  `CT-SC2-1..5` not run.
- `SC2CD-12` create writes the config before the job (a crash between leaves an
  "unscheduled" row).
- Half-hour DST zones: the cadence floor walks real instants, so `Australia/Lord_Howe`'s
  hourly cron has one 30-minute gap a year and is refused/skipped then. Measure wall-clock gaps.
- Goals / campaign-ops do not surface a refused re-arm after their causer's erasure.
- `XCH-SCH-1` exchange-audit grade owed.
- **Observation, not this ADR's defect (post-deploy read):** 12 enabled roster jobs skip every
  slot as `workflow-unresolved`, 8 of them within the last 24 hours. They bind `sample.agents.*`
  workflows (`follow-up-reminder`, `ticket-classification`, `spend-anomaly`, `lead-routing`,
  `channel-publish`, `release-checklist`) for the roster agents sally / marcus / priya / nora /
  devon, in `user:b67099554…` and `__showcase__`. Each last ran 2026-08-17 to 08-24, so the
  workflows they name have not resolved since then. Owner: the roster / showcase seeding
  (the agents' default schedules), not scheduled-agent-chats.

## Open questions

- [ ] Should the dashboard tile merge `/mine`? It would add a fetch to the dashboard. Filed as
  residue unless the grade says otherwise.
- [ ] Re-own on resume for an erased creator (D5): deferred.
