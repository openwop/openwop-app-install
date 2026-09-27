# ADR 0689 — KickBot speaks first, in a conversation that is the participant's own

Status: Accepted (implemented; see § Implementation record)

## Context

The founding deck's coach "reminds, encourages, celebrates milestones, and
never makes you feel guilty." ADR 0442 built the named guide, its memory, its
bounded specialists and its fail-closed autonomy — and left it mute until spoken
to. Measured at HEAD before this ADR:

| promise | what ran |
| --- | --- |
| the coach reminds you | `remind-today` → `routeReminder` emits a generic `task.assigned` notification titled "KickTodo reminder" (`calendarWriteService.ts:137-162`). KickBot's name appears nowhere. |
| the coach celebrates | `evaluateAwards` stores `first-check-in`, `streak-7`, `streak-30`, `comeback`, `challenge-complete` and logs a line (`engagementService.ts:245-279`). Nothing announces them — zero notification emits in `kicktodo-engagement`. |
| the coach is yours | the reminder job is ALREADY stamped `rosterId: host:kickbot, agentId: user.kicktodo-guide` (`enrollmentService.ts:376-392`). The attribution existed; the voice did not. |

The KickTodo report card graded P3 at A− for exactly this: "the nudge is an
anonymous notification".

### The conversation trap, found while building this

`ensureKickBot` mints a "welcome conversation" as
`subjectConversationId(tenant, { kind: 'agent', id: 'host:kickbot' })`
(`kickbotService.ts:355`) — deterministic per TENANT. In a personal tenant that
is one chat per person by accident of tenancy. In the ADR 0684 shared participant
workspace it is ONE conversation for every member. A proactive turn posted there
would put one participant's pending action in front of everyone.

The SPA never opens that id. The Guide page embeds an ephemeral agent-scoped
session, and the durable 1:1 a participant keeps with KickBot is opened through
`POST /chat/conversations/open { type: 'agent', subjectRef: 'agent:host:kickbot' }`
(`routes/chatSessions.ts`), keyed `dmKeyOf(userRef(owner), subjectRef)` — per
owner. So the transcript was never shared; the welcome id is vestigial. But it is
the id a naive implementation reaches for, and `convene` only avoids it because
the chat scope hands it the live conversation.

## Decision

**1. A proactive turn is a scheduled agent-runner turn, not a heartbeat.**
The same lane `convene` uses (ADR 0442 P5), and the SAME workflow: a fire-now
one-shot scheduler job on `openwop-app.kicktodo.convene-turn` (one host
`agent-runner` node), `configurable: { agentId: host:kickbot, task, conversationId,
credentialRef: managed:openwop-free }`. A second in-tree turn-workflow was written
and withdrawn: the pin-site ratchet (`test/workflow-pin-site-ratchet.test.ts`)
quarantines in-tree `WorkflowDefinition` literals shrink-only, and the convene
workflow already is this shape — only the agent and the task differ. KickBot's heartbeat stays `-1` and its
autonomy `review`; the P4 tripwire (`kicktodo-kickbot-connections.test.ts`) is
unchanged. The run carries `metadata.actingUserId = participant`, so the guide's
actingUserId-gated read tools (today, progress, journal) authorize (ADR 0324).
The run-lane firewall gates the same allowlist as chat, so `log-checkin` still
raises an approval card: **the turn is advisory by construction**.

**2. The turn targets the participant's DM, opened by the chat route's own key.**
`kickbotConversationFor(tenant, participant)` open-or-resumes
`findByDmKey(tenant, dmKeyOf(userRef(participant), agentRef(rosterId)))`, creating
the session + meta exactly as the route does when absent. The welcome id is never
a target. The route and the service now agree on ONE conversation per participant.

**3. Two occasions, both gated, both idempotent.**
`enqueueKickbotCoachTurn(tenant, { ownerSubject, enrollmentId, occasion, awardKind? })`:

| gate | behaviour |
| --- | --- |
| enrollment absent or not the caller's | `not-found` (uniform; no existence leak) |
| enrollment not `active` | `not-active` — snooze pauses the guide as it pauses reminders (deck slide 14) |
| reminder with nothing pending today | `nothing-pending` |
| participant muted / quiet hours (ADR 0457) | `muted` — consulted by the producer, as `routeReminder` does |

Idempotence is the scheduler's deterministic `jobId`: `kickbot-coach:<sha256(
tenant|participant|enrollment|occasion|key)>` where `key` is the participant's
LOCAL day for a reminder and the award kind for an award. A replay, a retry, or
two callers on one tick re-put the same row.

**4. The reminder loop gains a second node; the celebration rides the observer.**
`openwop-app.kicktodo.reminder-loop` becomes `remind → coach-turn`
(`feature.kicktodo.nodes.kickbot-coach-turn`, pack 1.28.0; chain pack 1.1.0;
pins bumped in `kicktodo-core` and `kicktodo-commerce`). `onCheckIn` in
`kicktodo-engagement` now announces each NEWLY earned award: one addressed
`kicktodo.award-earned` notification plus one award-occasion coach turn, both
best-effort so a notification or scheduler hiccup never fails the check-in.

**5. Voice — decided, not deferred.** KickBot has no voice modality in this
ADR. ADR 0444 already excludes audio/video for human coaches; the platform's
realtime voice exists and could scope to `host:kickbot` later without a new lane.
Recorded so the report card stops counting it as an open question.

## Alternatives considered

- **Flip the heartbeat on.** Rejected: breaks the ADR 0442 P4 tripwire and makes
  every proactive turn a heartbeat-policy question. The scheduler lane is what
  `convene` already proved.
- **Post into the welcome conversation.** Rejected on the trap above — in a
  shared workspace it is everyone's.
- **Post the turn into the ephemeral Guide session.** Impossible: it is
  per-page-load and has no durable id.
- **Make the reminder node itself enqueue the turn.** Rejected: a second chain
  node is visible in the builder and the `/` picker, and a tenant can remove it;
  an inlined side effect is neither.

## Consequences

- P3's "KickBot speaks first" gap closes: reminders and awards arrive as the
  guide, in the participant's own conversation, with the never-guilt law in the
  task text.
- One more scheduler job per reminder fire and per award. Bounded by the
  reminder cadence (one per enrollment per daypart) and the award set (five per
  enrollment, ever).
- The managed tier pays for the turn. Under ADR 0684's shared workspace the
  daily cap is charged per tenant, which is a separate finding (per-subject
  charging) and not made worse here: a reminder turn is one short turn per
  enrollment per day.
- A participant who never opened the sidebar now has a KickBot conversation the
  moment the guide speaks. It appears under the guide's name, as the route
  would have created it.

## Implementation record

- `kicktodo-core/kickbotCoachTurnService.ts` (rides `conveneTurnWorkflow.ts`), surface
  op `kickbotCoachTurn`.
- `packs/feature.kicktodo.nodes` 1.28.0 (`kickbot-coach-turn`);
  `examples/workflow-chain-packs/kicktodo-loops` 1.1.0 (reminder-loop 1.1.0).
- `kicktodo-engagement/engagementService.ts` `celebrateAwards`.
- Tests: `test/kicktodo-kickbot-coach-turn.test.ts` (DM key parity with the
  route, per-participant isolation, idempotence per day and per award, the four
  honest skips, the chain shape, the node's older-host skip).

## Open questions

1. Whether the reminder turn should ALSO be suppressed when the participant has
   already spoken to KickBot today (a fresh "speak first" after a live exchange
   may read as repetition). Measure with the alpha before deciding.
2. Session co-host (ADR 0444's deferral): the same one-shot lane can post a
   KickBot turn into a circle conversation at session time without touching
   `scheduled-agent-chats`' scope type. Follow-on, not here.
