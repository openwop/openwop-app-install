# ADR 0192 — Channels UX & identity parity (mentions that work, names not hashes, a rail that signals)

**Status:** Accepted (architect-reviewed 2026-07-02; blocking findings folded in — see §Review corrections)
**Owner:** openwop-app chat + channels
**Date:** 2026-07-02

**Composes (all implemented — this is completion + chrome, not new infra):**
- **ADR 0126 (Team channels)** — the channel model (`type:'channel'` + descriptor +
  membership via `ConversationParticipant`); this ADR closes its UX debt.
- **ADR 0154 (Channels into the unified chat surface)** — the rail/`ConversationView`
  integration this ADR polishes; **carries a correction note** (§Correction below).
- **ADR 0043 (Persistent conversations)** — conversation meta, participants,
  `conversationReadState.ts` read markers.
- **ADR 0041 (subjectRef vocabulary)** — `user:<id>` / `agent:<id>`; this ADR adds the
  single display-resolution seam for that vocabulary.
- **ADR 0002/0003 (users service)** — the identity owner (`User.displayName`,
  PII-declared, keyed by the same `userId` that `user:<id>` carries) that display
  resolution reads through.
- **ADR 0010 (Notifications, Phase 2 preferences)** — the per-(tenant,user) preferences
  blob that gains `mutedConversations`.
- **ADR 0006/0015 (RBAC / workspace tenancy)** — uniform-404 non-member semantics
  unchanged.

**RFC verdict: none.** Host-ext routes + host-internal projections only. Presence /
typing / delivery-receipts remain RFC-gated exactly per ADR 0126; nothing here adds a
capability advertisement or wire surface.

---

## Context — the gaps (verified in-tree)

1. **The advertised mention gesture cannot work.** The composer's `@` autocomplete
   inserts a persona **slug** (`chat/lib/agentMentions.ts:60-66`), but
   `channelAgentDispatch.selectChannelTurnTargets` (`:38-43`) matches tokens against
   the raw **agentId**. In any multi-agent channel a UI-inserted mention silently
   targets nobody; the sole-agent implicit fallback (`:42`) masks the bug until a
   second agent joins.
2. **Raw identifiers render as UI.** `ChannelManageDialog` adds members/agents via
   bare-ID text inputs and lists members as `user:<hash>` tails; messages carry a
   server-stamped `authorSubject` (`types.ts:203`, ADR 0102) the frontend never renders.
3. **The channel surface impersonates the AI chat.** A channel renders the AI
   WelcomeCard, the "Ask anything" composer placeholder, and — in rail Zone 1 — the
   1:1 active-agents lineup instead of the channel's roster.
4. **The rail under-signals.** One unread dot; no counts; no mention tier; no mute.
5. **Small holes:** no self-serve Leave; attachments rejected after the composer
   offered them; create can't invite anyone; names unnormalized (and stored TWICE —
   descriptor + `chat_session.title` — with rename updating only the descriptor);
   "Channels" collides with Campaign Studio's marketing generators.

### Boundaries & pre-existing-surface audit (MANDATORY — corrected per review)

| Concern | Existing owner | This ADR's posture |
|---|---|---|
| Message mutation | `PUT /chat/sessions/:sessionId/messages/:messageId` (ADR 0102) | Untouched here — edit/delete are ADR 0195's, extending that route |
| Per-user prefs | `features/notifications/preferencesRoutes.ts` (ADR 0010) | Mute = a bounded `mutedConversations` field, **merge-on-absent** (D7). No new store. |
| Per-message threads | Comments (ADR 0021, `chat_message` resource) | Never built here; ADR 0195 surfaces Comments in channels |
| `user:*` identity | **`features/users` (`User.displayName`, ADR 0002/0003)** — NOT accessControl members (org-scoped, optional subject binding, and `access-members` reads are full collection scans) | Display resolution reads users via a **registered resolver seam** (D2) — point lookups, no scans |
| Slugs | **`host/slug.ts`** (`slugify` + `uniqueSlug` — the anti-reimplementation owner) | D1 uses it verbatim; no third copy |
| Read state | `host/conversationReadState.ts` (`chat:read-state`) | Gains optional `readMessageCount` / `mentionCount` (D6) |
| **Append paths (enumerated — there are SEVEN, not one)** | bus: `channelService.ts:218`, `agentRunnerNode.ts:131`; direct-storage: generic `POST …/messages` (`chatSessions.ts:620`), `ctx.chat.sendMessage` (`chatSurface.ts:83`), voice sideband, chat-import, branch-seed | D6 **converges** the two non-benign direct paths (generic route ⇒ deny channels / route groups through the bus; `chatSurface` ⇒ through the bus) so the bus becomes a true choke-point for multi-party appends; imports/branch-seed/voice (1:1, fresh sessions) stay direct |
| Membership mutation | channel routes (`assertChannelManage`) — but generic participant routes AND `POST …/board` reach channels too | D3 closes **all three** bypasses |
| Scheduling | `scheduleDaemon` fires arbitrary workflowIds | Untouched (ADR 0196 uses a job template) |

## Decision

### D1. Server-side mention resolution — persist the slug at membership time

`addChannelAgent` (which already fail-closes on unresolvable agents) additionally
derives and persists on the agent's participant record:

```ts
// ConversationParticipant gains (optional, agents only):
mentionSlug?: string;   // via host/slug.ts slugify(manifest.label ?? manifest.persona), uniqueSlug per conversation
displayLabel?: string;  // the human name at add-time
```

- `selectChannelTurnTargets` matches tokens against **slug ∪ agentId**, case-insensitive.
- **Slug freeze is a decision:** stamped at add-time; does not track later persona
  renames (mention tokens in history must keep resolving). Re-adding re-derives.
- **Backfill happens ONLY at membership-mutation time** (add/remove operations already
  rewrite the meta) — **never from a read path**: a read-path meta `put` re-introduces
  the LWW race the read-state split exists to prevent (`conversationStore.ts:356-359`).
  Legacy agent members without a slug keep working via agentId matching; the roster
  projection resolves their display label from the registry at read time (no write).
- JSON participant records ⇒ no migration.
- The composer autocomplete becomes channel-scoped: entries = the channel's agent
  members (slug + label from the roster projection).

### D2. One display-resolution seam for the subjectRef vocabulary

New core seam `host/subjectDisplay.ts`, shaped like the established
`subjectOrgScope`/`subjectAccess` seams (core defines + features register — no
core→feature import):

```ts
setUserDisplayResolver(fn: (tenantId, userIds: string[]) => Promise<Map<string, string>>)
resolveSubjectDisplays(tenantId, refs, opts?): Promise<Map<SubjectRef, { kind: 'user'|'agent'; displayName: string }>>
```

- `features/users` registers the user resolver at feature init — **point lookups by
  `userId`** (the users store is keyed by exactly the id `user:<id>` carries). No
  accessControl scans on any hot path.
- `agent:*` resolves from the participant's `displayLabel`, falling back to a registry
  `resolve()` label, falling back to a humanized id tail.
- Called by the channel-detail (roster), channel-messages, and presence projections;
  raw subjectRefs never leave the API for these surfaces. Batched per request.

### D3. Self-serve leave + closing ALL membership-mutation bypasses

- `DELETE /channels/:channelId/members/me` — any non-owner member leaves; the owner
  gets 409 (archive or transfer first). **Registered BEFORE the existing
  `DELETE …/members/:userId`** (Express first-registrant-wins; otherwise `me` binds to
  `:userId` and the leaver gets the owner-gate 403) — pinned by a route test.
- **Bypass closures (all three, route-level tested):**
  1. Generic `PUT/DELETE /chat/sessions/:sessionId/participants` **reject
     `type:'channel'`** metas (400 with a typed error naming the channel routes) —
     this also closes the ownerless-legacy-channel permissive branch
     (`requireOwner` is permissive when `ownerUserId` is absent; `assertChannelManage`
     404s that same case) and the skipped agent-registry fail-closed check.
  2. `POST /chat/sessions/:sessionId/board` (board promotion) **rejects channels** —
     today `markAsBoardGroup` would rewrite the meta as `type:'group'` and silently
     DROP the `channel` descriptor (destructive; verified `conversationStore.ts:300-310`).
  3. The generic message POST policy is D6's (channels denied there).

### D4. One-flow create + name normalization + dual-store reconciliation

- `createChannel` accepts `{ name, description?, visibility, memberUserIds?, agentIds? }`;
  initial members/agents ride the same `addParticipant`/`addChannelAgent` paths (slug
  stamping included).
- Names normalize to `[a-z0-9][a-z0-9._-]*` (≤80) at create AND rename; the UI renders
  `#name`. **Rename updates BOTH stores** — the descriptor and `chat_session.title`
  (today it updates only the descriptor, so the rail drifts). Legacy unnormalized
  names are grandfathered for display and normalize on their next rename.
- `description` (already on the descriptor + create path) becomes settable in the
  create dialog + settings, shown in the header and browse directory.

### D5. Channel posts accept the chat content envelope (attachments)

`postChannelMessage` accepts plain text (back-compat) or the serialized ChatMessage
envelope the 1:1 surface stores (`useChatSession` already dual-parses). Size caps
mirror the chat route; mention parsing reads the text parts. The `channelTextOnly`
toast dies.

### D6. Unread & mention signal — differencing for unread, targeted stamps for mentions

**Unread needs ZERO append-time writes** (architect finding 5): `chat_session.message_count`
is already bumped atomically inside the append transaction, and the list projection
already carries it per header.

- `ReadMarker` gains `readMessageCount?: number` and `mentionCount?: number`
  (`lastReadAt` becomes optional for mention-only markers; the `withReadMarkers` join
  guards absent values so the FE `isUnread` fallback is preserved).
- `markRead` stamps `readMessageCount = messageCount at read` and zeroes `mentionCount`.
- List projection: `unreadCount = max(0, messageCount − readMessageCount)` at the
  existing read-marker join — exact, race-free, no new queries.
- **Mentions** stamp at append time, but only for actually-mentioned participants
  (0–1 writes per typical post): on a multi-party append via the bus, parse tokens;
  `@<agent-slug>` targets dispatch (D1); **`@channel` increments every human
  participant's `mentionCount`** via `compareAndSwap` with bounded retry (the CAS
  primitive exists — `hostExtPersistence.ts:265`). **Per-user mention tokens are
  explicitly out of scope** (no user-mention autocomplete exists; a human's mention
  tier = `@channel` for now — recorded as OQ-2 rather than a half-specified token).
- **Choke-point convergence (architect finding 1):** the generic
  `POST /chat/sessions/:sessionId/messages` route **denies `type:'channel'`**
  (channel posts must use the channel route, which owns the archived check, mention
  dispatch, live publish, and counters) and routes `group` appends through
  `appendChatMessageLive`; `ctx.chat.sendMessage` (`chatSurface.ts`) switches to
  `appendChatMessageLive`. The bus is then the real multi-party append choke-point;
  voice-sideband / chat-import / branch-seed remain direct (1:1 or fresh sessions —
  benign, recorded).

### D7. Mute — a field on the existing notifications preferences

`NotificationPreferences` gains `mutedConversations?: string[]` (≤500 ids, length-capped,
validated like every field on that blob). **Merge-on-absent PUT semantics:** a client
that PUTs a prefs body without the field keeps the stored value (older SPA tabs must
not wipe mutes). Consumers: the rail (dimmed, counters suppressed, dot only) and the
notification emitter — **noting honestly** that `NotificationRecord` carries no
`conversationId` today and no producer emits channel-message notifications yet; the
emitter filter keys on `metadata.conversationId` and stays dormant until ADR 0196's
mention-notification policy lands.

### D8. Frontend chrome pass (all in `chat/`, composing `ConversationView` — never in it)

| Surface | Change |
|---|---|
| `ui/Avatar.tsx` (new) | Initials avatar primitive (deterministic hue from display name), token-driven, dark-parity. `initials()` moves here from `agents/AgentAvatar.tsx` (which re-exports/imports it — ui/ must not import from agents/) |
| Message feed | Multi-party conversations only: author display name + avatar + timestamp, consecutive-author grouping; 1:1 unchanged |
| Channel empty state | Via the existing `renderEmptyState` slot: "This is the very beginning of **#name**" + description + Add people / Add an agent / Set a description (owner) or member variant |
| Composer | `Message #name` placeholder (+ mention hint when agent members exist) |
| Mention autocomplete | Channel-scoped to agent members; inserts the server slug |
| Rail Zone 1 | Channel **roster** (resolved names) instead of the 1:1 lineup when a channel is open |
| Chat header | `#name` + description + member-avatar stack → roster popover with Leave |
| Create dialog | One flow: name (normalized preview) → description → visibility → member + agent **pickers** |
| Manage dialog | Pickers replace both raw-ID inputs; resolved names everywhere |
| Browse dialog | Description, member count, agent count, relative last-activity per row |
| Rail sections | unread ⇒ bold + count chip (from `unreadCount`); mentioned ⇒ distinct badge (`mentionCount`); muted ⇒ dimmed, dot only; mute/unmute in row overflow |
| Vocabulary | `campaignChannels` label → "Placements" (×4 locales); `#` glyph everywhere |
| i18n | Every new string in en/es/fr/pt-BR (parity gate is FATAL) |

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | Backend `features/channels/` extended in place; `host/subjectDisplay.ts` is a core seam features register into (the subjectOrgScope pattern); frontend stays core chat chrome per ADR 0154 |
| 2 | Toggle | None new — `channels` is graduated always-on; presence stays env-gated |
| 3 | Workflow surface | None new (`ctx.chat.sendMessage` behavior preserved, now via the bus) |
| 4 | Packs | None |
| 5 | RBAC | New/changed routes resolve from channel meta, fail-closed, uniform-404; leave self-scoped; three bypass closures REDUCE existing exposure |
| 6 | Replay/fork | Nothing touches run config; slugs/counters/prefs are product state outside run logs |
| 7 | RFC gate | Not needed; presence/typing/receipts stay deferred per ADR 0126 |

## Phased implementation

- **Phase 1 (backend):** D1–D7 + route-level tests: leave authz (incl. owner-409 +
  `members/me` registration-order pin); slug targeting (incl. same-slug dedupe via
  `uniqueSlug`); unread differencing + `@channel` mention CAS; envelope posts;
  prefs bounds + merge-on-absent; **the three bypass closures** (generic participant
  mutation on a channel, board promotion on a channel, generic message POST on a
  channel); rename dual-store reconciliation; `CONVERSATION_TYPES` still omits
  `'channel'` (pin).
- **Phase 2 (frontend):** D8 + component tests + i18n catalogs ×4.
- Gates per phase: backend `tsc --noEmit` + vitest; frontend `npm run build`;
  `/code-review` + `/ux-review` with fixes applied.

## Review corrections (architect pass, 2026-07-02)

The pre-implementation `/architect` review falsified two premises of the draft and
improved a third; the Decision above is the corrected version:
1. **"`appendChatMessageLive` is the single append choke-point" was FALSE** — five
   direct-storage append paths existed. D6 now converges the two non-benign ones and
   denies channels on the generic route.
2. **The participant-route gap was wider than drafted** — including a destructive
   board-promotion path and an ownerless-channel permissive branch. D3 closes all three.
3. **Append-time unread counters were dominated** by `messageCount` differencing —
   adopted; append-time writes remain only for `@channel` mentions (CAS, bounded retry).
4. Identity owner corrected accessControl → users service via a resolver seam;
   slug implementation pinned to `host/slug.ts`; prefs merge-on-absent; rename
   dual-store drift fixed; `lastReadAt` optional with a guarded join.

## Correction note → ADR 0154

ADR 0154 §3 deferred multi-agent `@slug` ("no server-side slug source") while shipping
a slug-inserting composer autocomplete — the deferral and the UI contradict each other
(this ADR's gap #1). The fix persists the slug at membership time, creating the slug
source 0154 said didn't exist.

## Open questions

- **OQ-1:** whether `@channel` (and future user mentions) also emit addressed
  notifications — deferred to ADR 0196's policy work (the D7 filter is ready, dormant).
- **OQ-2:** per-user mention tokens (a human `@dana` tier) — needs a user-mention
  autocomplete + token scheme; deliberately NOT half-shipped here.
- **OQ-3:** avatar imagery (vs initials) — deferred until an avatar source exists.
