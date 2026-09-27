# ADR 0202 — Agent-native channels (response policy · AI catch-up · scheduled agent posts)

**Status:** Accepted (architect-gated 2026-07-03; blocking findings folded in — see §Gate corrections). Ships D1/D2/D4/D5; **D3 (scheduled channel posts) + D6 (create-path hardening) implemented 2026-07-03 via Path B — see the D3 correction note.**
**Owner:** openwop-app chat + channels
**Date:** 2026-07-03

**Composes (all implemented — assembly over existing owners):**
- **ADR 0154 (channels in the unified chat) / ADR 0192 (channels UX parity)** —
  agent membership, the persisted `mentionSlug`, `channelAgentDispatch`, the
  resolved roster.
- **ADR 0154 Phase 4 (`channelTurnWorkflow`)** — the single-node core
  agent-runner run a channel agent turn already rides; a catch-up is the SAME
  run with `conversationId` omitted (no in-channel append).
- **The scheduler (`schedulingService` / `scheduleDaemon`)** — fires arbitrary
  `workflowId`s with a job's `configurable`; scheduled agent posts are a job
  template, **zero scheduler edits**.
- **ADR 0125 (agent-runner conversation projection)** — an agent's reply is
  appended to the target conversation ONLY when `conversationId` is set; a
  catch-up omits it, so the summary never lands in-channel by construction.

**RFC verdict: none** — host-ext + existing run/scheduler owners; no wire surface.

---

## Context — the differentiator nobody else can render

Channels are the product's agent-native thesis (FEATURES.md: *"a workspace where
your team and your agents do work together"*). Three gaps keep it from paying off:

1. **The sole-agent auto-reply is invisible magic.** `selectChannelTurnTargets`
   makes a channel's ONE agent member reply to every post
   (`channelAgentDispatch.ts` — the "a bot in the channel" fallback). Nothing in
   the UI says the agent will do that, and it silently breaks when a second agent
   joins (mentions become required). The behavior should be a **visible,
   per-agent setting**, not a hidden rule.
2. **No catch-up.** A member returning to an active channel scrolls a wall of
   messages. Teams/Slack now sell AI recap as an upsell; we own the run engine,
   so it can be native.
3. **No recurring agent presence.** A standup agent that posts every morning is
   what makes a channel worth checking daily — and it solves the solo-tenant
   dead-room problem. The scheduler already fires arbitrary workflows; nothing
   wires a channel post to it.

### Boundaries & pre-existing-surface audit (MANDATORY)

| Concern | Existing owner | This ADR |
|---|---|---|
| Agent channel turn | `channelTurnWorkflow` + `startWorkflowRun` (ADR 0154) | Catch-up rides it verbatim with `conversationId` omitted |
| Dispatch targeting | `channelAgentDispatch.selectChannelTurnTargets` | Reads a new per-participant `responsePolicy` at dispatch time (read-only); NO second dispatcher, NO dispatch-path write |
| **Recurring agent post to a conversation** | **`features/scheduled-agent-chats` (ADR 0125)** — `createScheduledChat({agentId, prompt, conversationId, cronExpr})` already binds agent+cadence+prompt to a conversation, registers ONE scheduler job (managed credential), and posts the reply per tick | **D3 composes THIS owner, never a bespoke job.** Deferred pending the channel→org derivation (the feature is org-scoped; channels are membership-gated — gate finding C1a) |
| Reply projection | agent-runner (ADR 0125) — appends iff `conversationId` set | Catch-up omits it → no in-channel append (verified `agentRunnerNode.ts` — append is inside `if (conversationId)`); no runner change |
| Run result read | run event log (`run.completed.payload.outputs.text`) — NOT a snapshot field | Catch-up returns `{runId}`; the FE reads the completion event via the existing run-subscription seam (gate finding H2) |
| Agent identity display | ADR 0192 roster (`displayLabel`, `kind:'agent'`) | Bot badge + persona card read the resolved roster; no new resolver |

## Decision

### D1. Response policy — make the sole-agent rule a visible setting

`ConversationParticipant` gains (agents only, optional):

```ts
responsePolicy?: 'mention' | 'all';   // 'mention' = replies only when @mentioned;
                                       // 'all'     = replies to every human post
```

- `selectChannelTurnTargets` honors it (READ-ONLY at dispatch time): an agent
  with effective policy `'all'` is an implicit target on every human post
  (regardless of agent count); `'mention'` requires an explicit `@slug`/`@agentId`.
- **Effective policy is derived, never written on the dispatch path** (gate
  finding H1 — a dispatch-read `metas.put` is the LWW hazard the codebase
  forbids). The rule: `responsePolicy ?? (soleAgent ? 'all' : 'mention')`.
  - **New agents** get a REAL add-time stamp in `addChannelAgent` (a genuine
    membership mutation): the first agent added to a channel is stamped `'all'`,
    subsequent agents `'mention'`.
  - **Legacy sole agents** (added before this ADR, no stamp) resolve to `'all'`
    by the derivation above — matching the pre-existing invisible sole-agent
    rule with ZERO writes. No lazy stamp, no dispatch-path mutation.
- **Transition honesty (gate finding M2):** this is behavior-preserving only in
  the sole-agent steady state. When a 2nd agent joins, agent A retains its
  stamped/derived `'all'` and now auto-replies to unmentioned posts (old rule:
  nobody replied). Intended — the policy is now VISIBLE and owner-editable, so
  the owner sees and can change it; a silent 2-agent channel is no longer a
  silent surprise.
- Owner-editable in Channel details (a per-agent toggle) + surfaced in the bot
  persona card.

### D2. AI catch-up — a no-append channel turn, returned to the requester

`POST /v1/host/openwop-app/channels/:channelId/catchup` (member-gated):
- **Requires a channel agent member** (gate finding M1 — there is no host
  default summarizer; the route 400s a channel with no agent rather than
  advertise a summarizer that doesn't exist). Uses the channel's first agent
  member as `agentId`.
- Resolves the caller's unread span (messages since their `readMessageCount`,
  ADR 0192 D6 via `getReadMarker`) — capped (last 50 unread).
- Fires the **existing** `channelTurnWorkflow` run with a catch-up task
  ("Summarize what I missed:\n<span>"), the managed credential, and
  **`conversationId` OMITTED** → the agent-runner does NOT append the reply
  in-channel (ADR 0125 by construction; the append is inside `if (conversationId)`).
  `run.metadata.channel = { source:'channel-catchup', channelId, requestedBy }`.
- Returns `{ runId }`; the FE reads the completion via the **existing
  run-subscription seam** (`run.completed.payload.outputs.text` through
  `pollEvents`/`workflowRunSubscription` — NOT a snapshot field, which doesn't
  exist; gate finding H2) and renders it as a transient card.
- **Privacy, stated honestly (gate finding H3):** the summary is NOT posted
  in-channel (the load-bearing property), but the run is ordinary
  tenant-visible run history — NOT per-user private. The card is a convenience
  surfacing of the run, not an access boundary; the ADR makes no privacy claim
  it doesn't enforce. (`requestedBy` is tracing metadata, not an ACL.)

### D3. Scheduled agent posts — compose `scheduled-agent-chats`, not a parallel job

**Original deferral (gate findings C1/C1a).** The naive design — register a
bespoke schedule job targeting `openwop-app.channel.turn` — is a **parallel
system**: `features/scheduled-agent-chats` (ADR 0125) ALREADY owns "recurring
agent post to a conversation" (its `scheduledChatTurnWorkflow` is byte-for-byte
the channel-turn shape), with routes, a client, a page, list/pause/delete, and
RBAC. A channel is a conversation, so a channel scheduled post MUST compose
`createScheduledChat({ conversationId: channelId, … })` — not mint a job the
scheduled-chats surface can't see or cancel.

The real blocker: `scheduled-agent-chats` is **org-scoped**
(`requireOrgScope('workspace:write')`, requires an `orgId`) while channels are
**membership-gated** and carry no org. Composing it needs either a
channel→orgId derivation (via `host/subjectOrgScope`) or generalizing the
feature to accept a membership-gated channel. This ADR originally deferred D3
pending that decision.

> **Correction (2026-07-03, D3 amendment — this section implements D3).** The
> two composition paths were evaluated against the code (see §D3 investigation).
> **Path A (channel→orgId derivation) is rejected:** a channel carries no org
> (`ConversationMeta.channel` has no `orgId`; `ownerSubject` is never set on
> channels — only `tenantId` + `ownerUserId` + `participants[]`), so there is
> nothing to derive; inventing a workspace-root org would still 403 any channel
> member who lacks `workspace:write` in that org. **Path B (generalize the
> feature to a membership-gated scope) ships.** No channel→org derivation, no new
> scheduler — the deferral's blocker is dissolved by making the scope explicit,
> not by deriving an org.

**Path B — scope descriptor (ships).** `scheduledChatService` is generalized
from a bare `orgId: string` to a **scope descriptor**:

```ts
type ScheduledChatScope = { orgId: string } | { channelId: string };
```

- The `ScheduledChat` record gains an optional `channelId` (`orgId` becomes
  optional; **exactly one** is set). The `DurableCollection` key branches on it:
  `channelId` present → `${tenantId}:chan:${channelId}:${chatId}`, else the
  **unchanged** `${tenantId}:${orgId}:${chatId}` — existing org rows keep their
  exact key (back-compat; no migration).
- The tick path is **identical** for both scopes: the same
  `openwop-app.scheduled-chat.turn` workflow fired with `conversationId`, whose
  agent-runner reply projection is keyed purely off `conversationId` (verified
  channel-agnostic). A channel scheduled post sets `conversationId = channelId`,
  so the reply posts in-channel by the same projection the live channel turn uses.
- **New channel-scoped routes** live in `scheduled-agent-chats` (the feature is
  always-on — graduated, no toggle — so authorization is RBAC on the org path and
  channel-membership on the channel path, not a toggle check), importing the
  channel authz predicates from `channels/channelService` (a one-way
  `scheduled-agent-chats → channels` composition edge, the same pattern as
  `commerce → crm`, `comments → cms`, `sharing → cms`; no cycle — `channels`
  never imports back). Create is **owner-gated** (`assertChannelManage`), list is
  **member-gated**; `conversationId` is **forced to `channelId`** (not taken from
  the body); the bound agent **MUST be a channel member** (gate finding M3 —
  parity with live dispatch). System-fired ticks use the managed credential (no
  BYOK exposure), exactly as the org path.

### D6. Harden the existing `scheduled-agent-chats` create path (security)

Independent of channels, the audit found the **org** create path validates
*nothing* about its target: `createScheduledChat` did presence-checks on the
input strings only — no agent-exists check and no caller-access check on
`conversationId`. An org editor could bind any agent to any `conversationId` in
the tenant, including a conversation they cannot see (an IDOR-shaped write) or a
non-existent agent (a job that fails every tick). Hardened at the route boundary
(where the caller identity lives, keeping the service's config-writer unit tests
valid):

- **Agent must resolve** — `getAgentRegistry().resolve(agentId)` or 404
  (mirrors the channel create path).
- **Caller must be able to see the target conversation** —
  `getConversationMeta` + `isVisibleToAsync(meta, tenantId, callerUserId)` (the
  single visibility predicate, ADR 0112) or 404-mask. This closes the IDOR of
  scheduling into **another user's private conversation**. Note the honest limit:
  a legacy/unowned/absent conversation is tenant-visible by the `isVisibleTo`
  contract, so it remains bindable — harmless (the reply posts to an empty/own
  surface, never a foreign private one). The channel path gets the check for free
  (create is owner-gated on the channel, and `conversationId = channelId`).

### D4. Agent identity in the feed — bot badge + persona card

- An agent-authored message (author `kind:'agent'` from the ADR 0192 roster)
  renders a small **bot badge** on its attribution row.
- Clicking the agent avatar/name opens a **persona card**: display label,
  mention slug, and its `responsePolicy` (owner sees a control to change it).
  Reads the resolved roster — no new fetch.

### D5. "New messages" divider + Summarize-what-I-missed

- `MessageFeed` renders a **"New messages"** divider at the caller's
  `readMessageCount` boundary (ADR 0192 D6 already carries the counts).
- The divider hosts a **Summarize what I missed** button → D2's catchup →
  the summary card. Only shown when there's an unread span AND the channel has an
  agent member (no host-summarizer fallback — gate finding M1).

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Backend `features/channels/` extended; catchup route + dispatch policy read. No new package. |
| 2 | Toggle | None new (channels always-on). |
| 3 | Workflow surface | None net-new — catch-up + scheduled posts ride `openwop-app.channel.turn`. |
| 4 | Packs | None. |
| 5 | RBAC | Catchup member-gated; policy edit owner-gated; scheduled-post create owner-gated. System-fired turns use the managed credential (no BYOK exposure). |
| 6 | Replay/fork | `responsePolicy` on participant records; catch-up stamps `run.metadata.channel` read verbatim on `:fork`. |
| 7 | RFC gate | None. |

## Phased implementation

- **Phase 1 (backend):** D1 (`responsePolicy` field + add-time stamp in
  `addChannelAgent` + read-time derivation in `selectChannelTurnTargets`; NO
  dispatch-path write) + D2 (catchup route: agent-member-required, no-append run,
  `{runId}` return) + route tests (policy targeting matrix incl. sole-agent
  derivation + explicit `'mention'`; catchup member-gate + no-agent 400 + no
  in-channel append + metadata).
- **Phase 2 (frontend):** D4 bot badge + persona card (with the owner
  response-policy control) + D5 divider + summarize button (run-event read via
  the existing subscription seam); i18n ×4; `/code-review` + `/ux-review` + fixes.
- **Phase 3 (D3 + D6, 2026-07-03):** generalize `scheduledChatService` to a
  scope descriptor (back-compat key) + export `assertChannelManage` /
  `isChannelAgentMember` from `channels` + channel-scoped routes (owner-gated
  create, member-gated list, `conversationId = channelId`, agent-member check) +
  harden the org create path (agent-resolve + `isVisibleToAsync`) + route tests
  (channel authz matrix + org hardening). FE: a channel-details "Schedule a
  recurring post" affordance (agent picker from channel members) + list/delete.

## Gate corrections (architect pass, 2026-07-03)

Blocking findings folded in: C1/C1a — D3 deferred (would parallel
`scheduled-agent-chats`; needs the channel→org derivation); H1 — no
dispatch-path stamp, effective policy is derived read-only (add-time stamp for
new agents only); H2 — catch-up result read via the run event log
(`run.completed.payload.outputs.text`), not a nonexistent snapshot field; H3 —
dropped the unenforceable "private" claim (the run is tenant-visible history; the
load-bearing property is "not posted in-channel"); M1 — catch-up requires a real
agent member (no phantom host summarizer); M2 — the add-2nd-agent behavior change
is documented + intended; M3 — a scheduled agent (when D3 lands) must be a member.

**D3 amendment pass (2026-07-03):** Path A (channel→org derivation) rejected in
code (channels carry no org); Path B (scope descriptor) ships. M3 honored — the
channel create route asserts the bound agent is a channel member.
`conversationId` is forced to `channelId` (never body-supplied) so a channel
schedule cannot target a foreign conversation. D6 closes the pre-existing org
create-path gap (agent-resolve + `isVisibleToAsync` caller-access) — a security
fix to ADR 0125's surface, folded here because the same validation seam serves
both scopes. Storage stays back-compatible (org rows keep their key).

**D3 architect gate (2026-07-03, Track A) — H1 folded:** the first cut checked
`isVisibleToAsync` on the *untrimmed* `conversationId` but the service `trim()`med
before storing, so a whitespace-padded id (`" foreign-id"`) missed the exact-match
lookup (null → tenant-visible → check passes) yet bound the real foreign
conversation — defeating the D6 IDOR control. Fixed by normalizing once at the route
and passing the canonical `conversationId`/`agentId` into the service so **check ==
store** (regression-tested). Non-blocking gaps L1–L3 (padded-id, channel-pause,
cross-scope isolation) added to the route test. Everything else (no route
collision, one-way cross-feature edge, back-compat keying, leak-proof
`matchesScope`, complete channel authz matrix) verified sound.

## Open questions

- **OQ-1:** whether a scheduled/`'all'`-policy agent post should ALSO emit
  addressed notifications (the ADR 0192 D7 mute filter is ready) — deferred; the
  in-channel post + unread counter is the v1 signal.
- **OQ-2:** multi-agent auto-arbitration ("which of several `'all'` agents
  answers, unprompted") stays out of scope — `'all'` on two agents means both
  reply; explicit `@slug` narrows. Recorded, not solved here.
- **OQ-3 (D3) — RESOLVED 2026-07-03 (event-driven cleanup).** Removing a channel
  agent now deletes that agent's scheduled channel posts, so they stop firing
  instead of running on forever. The cycle problem (auto-clean would want
  `channels → scheduled-agent-chats`, closing a loop against the existing
  `scheduled-agent-chats → channels` edge) is solved by a **host-level domain
  event** rather than a direct import: `channels.removeChannelAgent` publishes a
  `ChannelAgentRemoved` signal on the existing host-ext pub/sub
  (`host/channelMembershipEvents.ts`, over `publishHostExtEvent` — Postgres
  LISTEN/NOTIFY cross-instance, in-process on sqlite), and `scheduled-agent-chats`
  **subscribes at boot** (`feature.ts`) and calls a new
  `deleteScheduledChatsForAgent(tenantId, channelId, agentId)` helper. Both sides
  touch only `host/` — no feature-to-feature import, no cycle. The new
  `channelMembershipEvents` module is a **reusable de-provisioning seam** any
  future feature can emit/subscribe on. Caveat: NOTIFY is best-effort
  **at-most-once** / fire-and-forget (same posture as chat live-delivery) — a
  listener that's disconnected at publish time simply MISSES the event (no
  redelivery), so a dropped event re-orphans; the FE still flags an orphaned row
  ("Agent is no longer a member") as the belt-and-suspenders. The cleanup itself is
  idempotent (already-deleted rows are skipped), so the broadcast-to-all-instances
  double-delivery is harmless. A fire-time membership guard (Design B) was considered and
  rejected — it drags in the node/workflow model and only suppresses the post while
  the job keeps ticking; the event-driven delete is the complete fix.
- **OQ-4 (D3) — RESOLVED 2026-07-03.** The fixed presets are replaced by a
  composed picker: frequency (daily / weekdays / weekly / hourly) + a native
  `<input type="time">` + a weekday select (when weekly), composing the cron
  client-side; the list humanizes any composed/legacy cron (locale-correct weekday
  via `i18n/format.formatWeekday`, locale time via `formatTime`). Still browser-tz
  (DST-correct end-to-end via `cronSchedule.computeNextFire`). Also closed a
  **latent backend gap**: `createScheduledChat` now rejects a malformed cron
  (`parseCron` guard) — previously `registerJob` silently omitted `nextFireAt` and
  stored a dead schedule that never fired (a 201 with no schedule). Arbitrary raw
  cron for power users stays on the org page (unchanged).
