# ADR 0214 — Channel-activity notifications (agent posts) + mute enforcement

**Status:** Accepted (2026-07-03) — the ADR 0202 OQ-1 follow-up.
**Owner:** openwop-app chat + notifications
**Date:** 2026-07-03

## Context

ADR 0202 (agent-native channels) added agents that post to channels — on an
`@mention`, on an `'all'` response policy, and (D3) on a schedule. But those posts
signalled members only through the **pull-only** unread/mention counters
(ADR 0192 D6): nobody is *told* an agent did something they didn't trigger. OQ-1
deferred the notifier.

The app already has a first-class notification subsystem (ADR 0010): a durable
inbox, an SSE stream, and web-push (`notifications/emitter.ts` →
`insertNotification` + `fanOut` + `pushNotification`). Two gaps block reuse:

1. **No chat-scoped producer exists** — every current producer is workflow-run
   lifecycle (`notify.ts`: approval/failure/completion). Channel activity has
   never emitted a notification. This is the first chat-scoped notifier.
2. **Mute is stored but unenforced.** `NotificationPreferences.mutedConversations`
   (ADR 0192 D7) + `globalMute` + per-type `muted` have **zero readers** — the
   store was built anticipating exactly this producer. A notifier that ignored
   them would spam a chatty agent's posts to every member's devices.

## Decision

### D1. A channel-activity notifier at the append choke

`host/channelActivityNotify.ts` — `notifyChannelActivity(tenantId, record)`,
called from `chatMessageBus.publishChatMessageAppended` **as a sibling to
`stampMentions`** (the one post-append choke both the agent-runner projection and
the channel post path converge on). It fires only when:

- the message is **agent-authored** (`record.authorSubject` starts with `agent:`)
  — human messages do NOT notify (general channel-message notifications are a
  separate, larger feature; OQ-1 is scoped to *agent* activity); and
- the conversation is a **channel** (`meta.type === 'channel'`).

Recipients = the channel's human members (participant `user:` refs) + the owner
(who isn't a stored participant), **minus** the author. For each, it emits a
`chat.channel_post` notification (title `#<channel>`, body `<agent>: <snippet>`,
`actionUrl` deep-linking the channel, `metadata.conversationId`).

**Scope honesty:** v1 notifies on *every* agent channel post, which is a superset
of "scheduled / `'all'`-policy" (the append choke cannot distinguish a proactive
post from an `@mention` reply — that signal lives at dispatch time). Mute is the
opt-out. A proactive-only filter (thread a marker from the scheduled/`'all'`
dispatch) is a recorded follow-up (OQ-1a), not a v1 blocker.

### D2. Enforce the dormant mute store — a resolver seam

Enforcing mute needs the notifier (in `host/`) to read
`NotificationPreferences` (owned by `features/notifications/`). To avoid a
host→feature import, use the established **core-defines-seam / feature-registers**
pattern (like `subjectDisplay`, `subjectOrgScope`):

- `host/notificationPolicy.ts` — `setNotificationMuteResolver(fn)` +
  `isNotificationMuted(tenantId, userId, ctx)` (default: **not** muted).
- `features/notifications` registers the real resolver at boot, reading its prefs
  store: muted iff `globalMute`, or `mutedConversations.includes(conversationId)`,
  or the per-type `muted` flag.

Enforcement is scoped to **this producer** (the notifier consults the resolver
per recipient), NOT bolted into the generic emitter — so existing run/interrupt
notifications are unaffected (bolting `globalMute`/quiet-hours onto the emitter
could silently drop an approval request). This finally activates the dormant
ADR 0192 D7 store (its first reader).

**Quiet-hours is deferred:** `QuietHours` stores `HH:MM` with **no timezone**, so
server-side evaluation would be wrong for the user. Enforcing it needs a tz on the
prefs model — a separate fix (OQ-1b). v1 honors global + per-conversation +
per-type mute.

### D3. Batched fan-out (the scale decision)

The chosen reach is **in-app inbox + SSE + web-push** to every member. The naive
path (`emit()` per member) re-scans the tenant's push-subscription table **once
per member** (`webPush.pushNotification` → `listPushSubscriptions`). For an
N-member channel that's N full scans per post. So:

- `webPush.pushNotificationsBatch(storage, records[])` — loads
  `listPushSubscriptions(tenant)` **once**, then routes each record to its
  recipient's devices (all records share the tenant).
- `emitter.emitMany(inputs[])` — inserts + SSE-fans-out each record, then a single
  batched web-push. (Teams cards are skipped — channel activity isn't an approval.)

Insert is still per-member (each member owns their inbox row) — that's inherent.
The batching removes the O(members × subscriptions) scan blow-up. Muted members
are filtered **before** the insert, so a muted channel costs nothing.

## Boundaries / RFC

Host-internal: the notifier is `host/`, the emitter/inbox/web-push are existing
host subsystems, mute prefs are a host-ext store. No wire event, capability, or
endpoint shape changes — **no `../openwop` RFC**. `chat.channel_post` is an open
`NotificationType | string` value (no union edit).

## Open questions

- **OQ-1a — RESOLVED BY DECISION (2026-07-03, NOTIF-1).** Precise proactive-only
  filtering (suppress an `@mention` reply the mentioner is watching) was evaluated
  against the code and rejected as worse than the risk it retires: the append choke
  has no routing context, the generic agent-runner `ctx` doesn't expose run metadata
  (`agentRunnerNode`), and threading the triggerer via the durable message `meta`
  would leak an internal identity into the stored record + FE projection. Notifying
  members on agent channel posts is the intended Slack-like behavior; the harm (push
  spam) is now controlled at THREE granularities — global mute, per-conversation mute
  (ADR 0192 D7), and a **first-class per-type toggle** (`chat.channel_post`, seeded in
  `KNOWN_TYPES` + surfaced in the prefs UI) that silences ALL agent-post pushes with
  one switch. A dispatch-time proactive marker remains a genuine future enhancement,
  explicitly deferred (mirrors the ADR's TODO-1/2 "honest-fix wins on evidence").
- **OQ-1b — RESOLVED (2026-07-03, NOTIF-2).** Quiet-hours is now enforced: a
  `timezone` (IANA) field was added to `QuietHours` (the FE stamps the browser zone
  on any quiet-hours edit), and the mute resolver evaluates the window in that zone
  (overnight-wrap aware; `allowUrgent` lets urgent/high through). Absent a timezone it
  still does NOT enforce (honest — the window is meaningless without a zone).

## Phased implementation

- **Phase 1 (this ADR):** the mute-resolver seam + feature registration; the
  batched emit (`emitMany` + `pushNotificationsBatch`); the notifier + its wiring
  at the append choke; tests (agent-only gate, member fan-out minus author, mute
  suppression, batched push loads subs once).
