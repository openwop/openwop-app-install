# KickTodo Integrations (unit G5) — chat-first port review

**Scope:** `backend/typescript/src/features/kicktodo-integrations/` (ADR 0421 consent
lanes + calendar feed/write, ADR 0443 R1 reminders, ADR 0462 wearable lane, ADR 0466
calendar-MCP adapter) plus its frontend surfaces (`frontend/react/src/client/kicktodoIntegrationsClient.ts`,
`frontend/react/src/features/kicktodo-admin/AiConnectionsPage.tsx`, the reminder-daypart
control in `frontend/react/src/features/kicktodo/TodayPage.tsx`).

**Resolved verdict up front:** this is an *infrastructure/consent* feature, not an
"intelligence" feature — most of its surface honestly rides platform owners (scheduler,
notifications, capability tokens, the shared ICS builder, the exception projection, the
subject-erasure + enrollment-lifecycle seams). Two real findings: (1) the **calendar-WRITE
lane is THEATER** — a full node + surface op + two transport adapters are authored but
**nothing creates a run of `calendar-sync`** (no workflow, route, schedule, or agent tool);
(2) **none of the integration setup actions — connect a calendar, link a wearable, grant a
consent, mint a feed — are reachable from the ONE chat or from any UI** (they are REST-only,
and the only frontend read is the admin transport-status page). That is the chat-first port
opportunity, and it is a genuine gap deferred honestly, not fakery.

---

## Contract scouting (pinned evidence)

**Declared orchestration vs. igniters**
- The feature declares **no workflows of its own** and **no agents of its own**
  (`feature.ts:14-41` registers only routes, the surface, the calendar transport adapter,
  and the wearable exception source).
- Its two surface ops that a workflow can drive are `calendarSync` and `remindToday`
  (`surface.ts:17`, `surface.ts:25`). Their node adapters live in the **kicktodo-core**
  node pack: `feature.kicktodo.nodes.calendar-sync` (`packs/feature.kicktodo.nodes/pack.json:188`)
  and `feature.kicktodo.nodes.remind-today` (`packs/feature.kicktodo.nodes/pack.json:100`).
- **`remind-today` HAS an igniter:** the `openwop-app.kicktodo.reminder-loop` builtin
  workflow (`kicktodo-core/builtinWorkflows.ts:86-95`) is armed as a scheduler job per
  enrollment daypart (`kicktodo-core/enrollmentService.ts:381`). RIDES.
- **`calendar-sync` has NO igniter.** The only 4 KickTodo builtins are `enrollment`,
  `daily-loop`, `reminder-loop`, `replan` (`kicktodo-core/builtinWorkflows.ts:30-225`) and
  **none contain a `calendar-sync` node**. There is no calendar-sync route in `routes.ts`
  (only `calendar-status`, `routes.ts:73`), no scheduler arm, and no agent tool. Grep for
  every reference to `syncEnrollmentCalendar`/`calendarSync` returns only the surface op,
  the service, and the adapters — never a caller that starts a run.

**Agent tool allowlists vs. capability**
- The feature registers **zero** `registerFeatureAgentTool` (only kicktodo-core does, at
  `kicktodo-core/agentTools.ts:367+`). None of the kicktodo agents' `toolAllowlist`s
  (`packs/feature.kicktodo.agents/pack.json`) reference any calendar/wearable/remind/consent
  tool — they carry only `openwop:kicktodo.{today,progress,candidates,factory.run,circles}`.
  So **no integration capability is chat-drivable** — there is nothing to silently drop at
  dispatch here, because nothing is offered. (The cross-cutting "allowlisted typeId never
  projected → dropped" pattern does **not** apply to this unit; the gap is the opposite —
  the tools were never created.)

**Owners instantiated (the RIDES grep — all honest)**
- Notifications: `routeReminder` emits through `getNotificationEmitter()` with mute/quiet-hours
  respected (`calendarWriteService.ts:136-160`). RIDES the notification owner.
- Scheduler: reminder + daily loops armed via `armContinuation` (`enrollmentService.ts:258,381`).
  RIDES the single cadence engine.
- Capability tokens: feed + webhook tokens minted/hashed via `host/capabilityToken`
  (`integrationService.ts:139`, `wearableWebhookService.ts:51-60`). RIDES.
- ICS builder: `buildIcsCalendar` from the shared `host/ics` (`integrationService.ts:172`).
  RIDES (no hand-rolled escaping — the ADR 0454 fix).
- Exception projection: `registerExceptionSource('kicktodo:wearable-stale', …)`
  (`exceptionSources.ts:48`). RIDES the ADR 0460 owner.
- Check-in owner: wearable ingest converts through `submitCheckIn` (`integrationService.ts:228`).
  RIDES kicktodo-core.
- Erasure + lifecycle: `registerSubjectEraser(eraseIntegrationsSubject)` (`integrationService.ts:264`)
  and `onEnrollmentDeleted(…)` (`integrationService.ts:272`). RIDES both seams.

**Chassis/rollout constraints that bound the port**
- Calendar transport is a single global port, honesty-gated: `isCalendarTransportConfigured()`
  reads `transport !== null` (`calendarWriteService.ts:56`); the MCP adapter registers only
  under `OPENWOP_CALENDAR_MCP_ENABLED` + a configured provider URL (`calendarMcpAdapter.ts:177-185`),
  else the REST adapter is the fallback (`feature.ts:23-24`). Both are **off** in this deploy.
- Wearable provider + webhook lanes are gated by `wearableProviderConfigured()` =
  `OPENWOP_WEARABLE_PROVIDER_ENABLED === 'true' && adapters.size > 0` (`wearableProviderAdapter.ts:51`).
  **Off** in this deploy. These gated-off lanes are rollout states, not theater.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Reminder cadence + delivery (P4/0443) | `reminder-loop` workflow armed by scheduler → `remind-today` node → `routeReminder` → notification owner (`builtinWorkflows.ts:86`, `enrollmentService.ts:381`, `calendarWriteService.ts:136`) | **RIDES** | Leave. (Daypart control already in `TodayPage.tsx:91`.) |
| Wearable metric → check-in evidence (P3/0462) | `ingestWearableMetric` → `submitCheckIn` (`integrationService.ts:207,228`) | **RIDES** | Leave; author-a-rule + ingest have no UI/chat path (deferred). |
| Wearable stale-stream → admin Exception Ledger (P3/0462/0460) | `registerExceptionSource` honest join (`exceptionSources.ts:27-49`) | **RIDES / PAGE-LEGIT** | Leave; honesty loop closed. |
| Subject erasure + enrollment-lifecycle cleanup | `registerSubjectEraser` + `onEnrollmentDeleted` (`integrationService.ts:264,272`) | **RIDES** | Leave. |
| Calendar FEED (mint token + public ICS, P1) | `mintFeedToken`/`renderFeed` ride capability-token + `host/ics` owners (`integrationService.ts:137,146,172`); public route `routes.ts:252` | **ADAPTER** | Leave the render/token owners; **no UI/chat mints the token** → build a connect action (below). |
| Calendar MCP transport (ADR 0466) | `calendarMcpTransport` over `makeMcpClient` (`calendarMcpAdapter.ts:183`), gated-off | **ADAPTER** (gated) | Leave; honest rollout state. Blocked by #2 below (nothing ignites it even when wired). |
| Wearable provider link / webhook ingress (P1/P2/0462) | `wearable-link`, `wearable-webhook-register`, public webhook (`routes.ts:126,167,268`), gated by `wearableProviderConfigured` | **ADAPTER** (gated) | Leave the token/webhook plumbing; **no UI/chat links a provider** (deferred). |
| Admin calendar-transport status console (0438 A6) | read-only `getCalendarStatus` → `AiConnectionsPage` (`kicktodoIntegrationsClient.ts:13`, `AiConnectionsPage.tsx:19`, route `routes.ts:73`) | **PAGE-LEGIT** | Keep; honest read. |
| Grant / revoke integration consent (4 kinds) | REST `/consents`, `/consents/revoke` (`routes.ts:90,99`); **no frontend UI, no agent tool** | **PAGE-LEGIT (deferred)** | Consent is a *decision* → an agent-mediated A2UI connect/consent card OR a plain settings surface. Neither exists. |
| **Calendar WRITE — sync enrollment to calendar (P2/6a/0466)** | node + surface op + REST/MCP adapters authored; **no workflow/route/schedule/agent-tool creates a run** (`packs/feature.kicktodo.nodes/pack.json:188`, `surface.ts:17`, `calendarWriteService.ts:87`; absent from `builtinWorkflows.ts:30-225`) | **THEATER** | Ignite it (chat tool + a node in `daily-loop`) or stop advertising the node as a capability. |

**Counts:** RIDES 4 · ADAPTER 3 · PARALLEL 0 · THEATER 1 · PAGE-LEGIT 2.

---

## Blockers (from scouting) — each with the honest alternative

1. **`calendar-sync` node is authored but wired into nothing.** The pack advertises
   "Replay-safe calendar sync for one enrollment" (`packs/feature.kicktodo.nodes/pack.json:188-191`)
   and the service is complete and replay-safe (`calendarWriteService.ts:87-130`), but no
   `WorkflowDefinition` contains the node, no route calls the surface op, no scheduler arms
   it, and no agent tool exposes it. **Honest alternative:** either (a) add the `calendar-sync`
   node to the `daily-loop` builtin (`builtinWorkflows.ts:65`) so the already-scheduled loop
   syncs the calendar each day (the natural igniter, symmetric with `materialize`/`evaluate`),
   gated to no-op when consent/transport are absent (the service already fails closed at
   `calendarWriteService.ts:92-93`); and/or (b) expose an `openwop:kicktodo.calendar.sync`
   action tool so KickBot can sync on request. Until one exists, the node's capability claim
   is theater even after the transport is wired.

2. **No integration setup is reachable from the ONE chat or any UI.** Connecting a calendar
   (mint feed / grant `calendar-project`/`calendar-write`), linking a wearable
   (`wearable-link` + `wearable-evidence` consent), authoring a wearable rule, and opting into
   `messaging-reminders` are all REST-only (`routes.ts:90-235`); the only frontend client call
   is the read-only `getCalendarStatus` (`kicktodoIntegrationsClient.ts:13`). **Honest
   alternative:** these are the "connect your calendar / link your device" flows the assistant
   feature already solves with an **A2UI clarification/connect surface** (RFC 0102 / ADR 0051),
   or, if kept page-shaped, a participant **settings surface** driven by real consent reads.
   This is a feature gap to defer *visibly*, not to paint green.

3. **The reminder lane's consent is never granted, so reminders can silently no-op.** The
   daypart control (`TodayPage.tsx:91-93`) sets `schedulePreference` on the core enrollment,
   which arms the `reminder-loop`; but `routeReminder` gates on the **`messaging-reminders`**
   consent (`calendarWriteService.ts:137`) which **no UI grants**. So a user who picks a
   daypart gets `reminded:false, reason:'no-consent'` (`surface.ts:37`) with no visible cue.
   **Honest alternative:** fold a `messaging-reminders` consent grant into the daypart control
   (one call), or surface "reminders need channel consent" inline. This is an honesty-loop gap,
   not theater (the skip is honestly typed), but it makes an armed feature inert.

---

## Demolition list (with regression pins)

There is **almost nothing bespoke to demolish** — this feature has no parallel owners and
almost no UI. The one item:

- **`AiConnectionsPage` (`AiConnectionsPage.tsx:19`)** is legitimately page-shaped (read-only
  transport status). **Keep.** If a chat-first "connect a calendar" flow is built (blocker #2),
  this page stays as the honest *status* projection beside it — do not fold status into chat.
- If blocker #1 is resolved by igniting `calendar-sync` in the `daily-loop`, add a **regression
  test** asserting the `daily-loop` definition contains a `calendar-sync` node instance (so the
  node cannot silently drift back to orphaned), mirroring the pack↔workflow parity discipline.
- Add an **allowlist/parity pin**: if `openwop:kicktodo.calendar.sync` (or a consent/connect
  tool) is added, pin it into the agents-pack allowlist test so a projected-but-unlisted tool
  fails the suite (the dispatch-drop guard the cross-cutting note calls for).

---

## New-code inventory (small — this is mostly ignition, not new machinery)

- **1 workflow edit:** add a `calendar-sync` node instance to `openwop-app.kicktodo.daily-loop`
  (`builtinWorkflows.ts:65`), consent/transport fail-closed (already handled in the service).
- **0–1 agent tool:** optionally `registerFeatureAgentTool('openwop:kicktodo.calendar.sync')`
  sharing the routes' `subjectOf`/consent predicate (action tool, fails typed) so KickBot can
  sync on request — the ADR 0058 chat-drivability pattern.
- **1 consent/connect surface (deferred, blocker #2):** either an A2UI connect/consent card
  driven by an agent, or a participant settings surface calling the existing consent + feed +
  wearable-link routes. No new backend needed — the routes exist.
- **1 UI fold (blocker #3):** grant `messaging-reminders` consent from the daypart control.
- **Regression pins** as above. No new durable store, owner, or wire surface.

---

## Phased plan (gated on real gates; compliance/honesty first)

- **Phase 0 — honesty fixes (no new capability).** Fold the `messaging-reminders` consent
  grant into the daypart control (blocker #3) so the already-armed reminder lane actually
  delivers; surface "reminders need consent" if declined. Close with `/code-review` +
  `/ux-review`, fixes applied.
- **Phase 1 — ignite calendar-write (kills the THEATER).** Add `calendar-sync` to the
  `daily-loop` builtin (+ the parity regression test). Optionally add the chat action tool.
  Verify with backend vitest + the pack↔workflow parity test. This makes the calendar-write
  lane real the moment a transport is wired (MCP or REST), instead of an orphaned node.
- **Phase 2 — chat-first / settings connect surface (blocker #2).** Build the consent + feed
  + wearable-link surface (A2UI-in-chat preferred, per the assistant calendar/email precedent;
  a settings page is the page-shaped fallback), driven by the existing routes with real reads.
  Keep `AiConnectionsPage` as the status projection. Close with `/code-review` + `/ux-review`.
- **Deferred to rollout (not this port):** wiring a live calendar transport
  (`OPENWOP_CALENDAR_MCP_ENABLED` + Google OAuth) and a live wearable provider
  (`OPENWOP_WEARABLE_PROVIDER_ENABLED` + an adapter) — both honestly gated today.

---

## Deferred honestly

- **Calendar transport** is unregistered in this deploy (`isCalendarTransportConfigured()` =
  false, `calendarWriteService.ts:56`); the admin console shows this truthfully
  (`AiConnectionsPage.tsx:25`). Do not paint "connected."
- **Wearable provider + webhook lanes** are gated off (`wearableProviderAdapter.ts:51`); the
  webhook register route honestly 409s when unconfigured (`routes.ts:178`). Rollout state.
- **Calendar-write ignition (Phase 1)** and the **connect/consent chat surface (Phase 2)** are
  real gaps to state, not fake — the routes/service exist; only the igniter + UI are missing.
