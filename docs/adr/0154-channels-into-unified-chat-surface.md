# ADR 0154 — Channels INTO the unified chat surface (retire the standalone page; agents in channels)

**Status:** implemented — Phases 1–4 + follow-ups FU-1/FU-4/FU-5/FU-6 shipped (PRs #971, #980); deployed to app.openwop.dev 2026-06-27. Supersedes ADR 0145 §4 (standalone `/channels` page).

**Owner:** openwop-app frontend platform + chat

**Composes (all implemented/Accepted — this is assembly + a re-home, not new infra):**
- **ADR 0043 (Persistent conversations)** — the `Conversation` model; `type:'channel'`
  is already a first-class `ConversationType` discriminant. Core owns it.
- **ADR 0067 (conversation-run default)** — the turn transport a channel conversation
  rides; an agent reply in a channel is an ordinary conversation-run on the channel's
  `conversationId`.
- **ADR 0073 (Embeddable `ConversationView`)** — the binding rule: **chrome composes
  AROUND the slim `ConversationView`; never bake chrome in.** Channel management is
  chrome; the channel feed/composer IS `ConversationView`.
- **ADR 0126 (Team channels)** — the feature this completes. This ADR delivers its
  **Phase 2** (rail + `ConversationView`, "No second chat surface") and **Phase 4**
  (agent membership → `@agent` post routes a `chat.turn`) **as originally specified**.
- **ADR 0145 (Surface re-homing)** — extends its "a destination, not a setting" pattern;
  **supersedes its §4 decision** that `/channels` is a standalone page in the Workspace
  nav (this ADR dissolves the page into the chat rail).

**Supersedes:** ADR 0145 §4 (Channels → standalone Workspace-nav page) and the
ADR 0126 Phase 3b/3c implementation notes (the bespoke `ChannelsPage`/`ChannelMessages`
standalone renderer). ADR 0126's **decision and data model stand unchanged**; only its
*frontend realization* is corrected back to its own Phase-2 spec.

**RFC verdict:** **none — host-side information-architecture + local-host orchestration
over already-Accepted RFCs.** No wire surface is added. The cross-host / presence
triggers ADR 0126 already flagged remain the (unchanged) RFC boundary; this ADR does not
cross them.

> **Origin.** A maintainer reviewing `https://app.openwop.dev/channels` asked: *"shouldn't
> Channels be a feature of the AI Chat UI instead of its own page?"* — and a competitive
> read of Slack / Microsoft Teams / Discord / Google Chat confirmed the universal pattern:
> **one messaging client = a conversation list (rail) + a message pane**, where "channel"
> is one *type* of entry alongside DMs, groups, and bots — never a separate destination.
> The audit found the app's own **ADR 0126 §Phase 2 already decided exactly this** ("a
> 'Channels' section in the Conversations rail… reuses `ConversationView`… No second chat
> surface"), but the implementation (Phase 3b/3c) drifted to a standalone page and
> ADR 0145 §4 codified the drift. This ADR ends the drift.

---

## Context — the record contradicts itself

Three facts, all verified in-tree:

1. **The data layer already unified channels into chat.** A channel is `type:'channel'`
   on the one `ConversationMeta` (`host/conversationStore.ts`); its posts are ordinary
   `ChatMessageRecord`s on the channel's `conversationId`; membership, read-state, and
   SSE delivery all reuse existing seams (ADR 0126 §boundaries-audit). There is **no
   second chat system at the backend.** Nothing here changes.

2. **The frontend forked anyway.** `features/channels/ChannelsPage.tsx` ships a **bespoke
   `ChannelMessages` renderer** (`{role}: {content}` in a 40vh scroll box) that does
   **not** use `ConversationView`, `useChatSession`, turn dispatch, interrupts, A2UI
   cards, the unified composer, or the mic UI. `chat/conversations/conversationGroups.ts`
   `sectionOf()` has **no `'channel'` case** — so channels never appear in the
   Conversations rail. This is precisely the "fragments capabilities and drifts" failure
   CLAUDE.md names (the removed `AiAuthorPanel`), and it directly violates ADR 0073.

3. **ADR 0126 §Phase 2 says the frontend should be the opposite of (2)**, and **§Phase 4**
   ("an `@agent` post in a channel routes the existing `chat.turn`") was specced but never
   built. So the unified outcome is not a new idea — it is the feature's own unfinished
   plan.

The pain is the same shape ADR 0145 fixed for the Platform junk-drawer — *information
architecture* — but ADR 0145 stopped one step short: it correctly re-tiered `/channels`
from `admin` to a Workspace *destination*, yet kept it a **separate page** rather than
folding it into the destination users already know (the chat). The right end state is the
Slack model: **channels are entries in the one conversation rail, not a sibling page.**

## Boundaries & pre-existing-surface audit (MANDATORY — Step 3)

- **No backend change. No new owner, store, route, endpoint, or wire.** `channelService`,
  the `/v1/host/openwop-app/channels/*` routes, the presence tracker, and the SSE seam are
  all kept **verbatim**. This ADR moves **frontend chrome + rail wiring** and adds
  **client-side turn dispatch wiring** that reuses the existing run path.
- **Rail integration is a generic core edit, not a feature→core inversion.** `'channel'`
  is *already* a value of the core `ConversationType` (`conversationStore.ts`). Teaching
  the core rail (`chat/conversations/`) to bucket it is the same kind of edit that already
  handles `'group'`/`'workspace'` — **core gaining awareness of a core type**, not core
  importing a feature. The change is ~3 lines in `conversationGroups.ts`
  (`ConversationSection` union + `sectionOf()` case + `SECTION_ORDER`) + an icon/label
  pair in `ConversationsRail.tsx` (`SECTION_ICON`/`SECTION_LABEL_KEY`).
- **Channel management is core chrome calling a shared client.** Create / rename /
  archive / members / visibility call `client/channelsClient.ts` (it lives in `client/`,
  **not** `features/`, so chat chrome calling it is **not** a chat→feature import). The
  details panel/create affordance live in `chat/` as core, exactly as the rail already
  renders `'group'`/`'workspace'` conversations without importing those features.
- **Import-direction consequence (stated honestly):** the **frontend** `features/channels/`
  package is **dissolved** — its page is retired and its capabilities re-expressed as
  core chat chrome over the shared client. The **backend** `features/channels/` package is
  **untouched** (it remains the single owner of the channel routes/service). This is the
  intended payoff of the unification, not a boundary violation: a conversation *type* is a
  core concern; only the *transport/service* is the feature.
- **No parallel read model / demo-seed (the `build-on-orchestration` invariant).**
  Channels render from the same conversation list the rail already loads; no `*Registry`,
  no second nav, no bespoke dashboard.
- **Capability honesty unchanged.** Presence stays env-gated
  (`OPENWOP_CHANNEL_PRESENCE_ENABLED`, ADR 0126); `channelPresence` is advertised only when
  honored. This ADR adds no advertisement.
- **Agent-turn collision check.** `grep` confirms channel posts have **no** server-side
  turn dispatch today (Phase 4 unbuilt). The turn path (`openwop-app.chat.turn` /
  conversation-run) is the single owner of agent replies; channels add **no** second
  runtime — they dispatch into it (see Decision §3).

## Decision

Fold channels into the **one** chat surface and complete ADR 0126 §2+§4. Four moves:

### 1. Channels become a section in the Conversations rail (retire the page)

- Add `'Channels'` to `ConversationSection`, a `case 'channel': return 'Channels'` to
  `sectionOf()`, and place it in `SECTION_ORDER` (between `Agents` and `Groups` is the
  natural read; final order tuned in `/browser`). Add `SECTION_ICON.Channels`
  (`MessageCircleIcon`, the existing channels glyph) + `SECTION_LABEL_KEY.Channels`.
  Channels then bucket and render through the **existing** `groupConversations` →
  `SECTION_ORDER` path with **zero** new rail machinery.
- A channel conversation opens into the **standard chat surface**: chrome + the slim
  **`ConversationView`** (feed + composer + interrupt/A2UI cards + states) driven by the
  same `useChatSession`/`useConversationController` as every other conversation. The
  bespoke `ChannelMessages` is **deleted**.
- **Retire `/channels`.** Remove the route + nav entry from `features/channels/routes.tsx`.
  Keep a thin redirect shim for link-rot safety: `/channels` → `/` (chat, Channels section
  focused) and `/channels/:id` → `/?conversation=:id` (the existing deep-link precedent).

### 2. Channel management is chat chrome, not a page (the Slack model)

Per ADR 0073, management is **chrome composed around `ConversationView`**:
- **Create** via a `+` affordance on the rail's "Channels" section header → an inline
  name + visibility (`public`/`private`) popover calling `channelsClient.createChannel`.
- **Manage** (rename · archive · members · visibility) via a **channel-details panel** in
  the chat header / right rail, shown only when the active conversation is `type:'channel'`
  and the viewer is the owner (mutations stay owner-gated server-side, unchanged).
- These widgets live in `chat/` (core, type-aware) and call `client/channelsClient.ts`.
  No standalone page, no `ChannelsPage`.

### 3. Agents in channels — `@agent` post dispatches a `chat.turn` (ADR 0126 §4)

An `agent:` subjectRef can already be a channel member (ADR 0126 §11/§Phase-4). This ADR
wires the turn — through the existing server-side run owner, not a new path:

- **Dispatch via the single server-side run owner (`startWorkflowRun`).** In a 1:1 agent
  chat the *client* drives the turn. A channel has *N* connected clients — if each drove the
  turn on a human's post, the agent would reply *N* times. So channel turns are dispatched
  **server-side**, and they MUST use the one server-side run owner —
  `host/runStarter.ts` `startWorkflowRun(deps, { workflowId:'openwop-app.channel.turn',
  conversationId, … })` (a channels-owned workflow over the CORE agent-runner — no
  feature→feature edge) — the exact run path scheduled-chats (`scheduleDaemon.ts`),
  heartbeat, approval, and trigger already funnel through. **No inline run insert, no
  second dispatcher** (ARCHITECTURE.md §"Run side effects must flow through the existing
  run/event/interrupt/idempotency machinery"). The reply is appended as an ordinary
  `ChatMessageRecord` on the channel conversation (the agent-runner's ADR 0125 Phase-2c
  projection). **Capability-honesty correction:** there is **no channel
  message-delivery SSE** (only a presence SSE), so the reply is **not** live-pushed —
  members see it on the next load (post→reload, parity with the retired view). Live
  multi-member delivery is FU-6.
- **Trigger = an explicit `@agent` mention (deterministic, server-parseable).** When
  `postChannelMessage` accepts a post that names an agent member, the host parses the mention
  to exactly one agent and dispatches one turn. **No `useActiveAgents`** — that is a
  frontend-only React hook (`chat/activeAgents/useActiveAgents.ts`) with no server
  equivalent; a server dispatcher cannot call it. Multi-agent auto-arbitration ("which of
  several agent members answers, unprompted") is therefore **out of scope** and deferred; the
  only no-mention case is a channel whose sole agent member is the implicit addressee
  (OQ-3). This is the binding correction from the `/architect` review.
- **Idempotent by a deterministic key.** `postChannelMessage` is at-least-once on
  multi-instance Cloud Run; the dispatch MUST be guarded by
  `storage.claimIdempotency('channel-turn:' + triggeringMessageId)` (the scheduler's
  fire-once pattern, `scheduleDaemon.ts:76`) so a retried/duplicated post yields exactly one
  agent turn across the fleet.
- **System-fired identity + attribution (a real authz decision).** A channel agent turn has
  no logged-in user: it carries **no `actingUserId`** → user/org BYOK fails closed (the
  honest posture) → it uses the managed/workspace credential, exactly as a scheduled run
  (`scheduledChatTurnWorkflow.ts`). It stamps `run.metadata.channel =
  { source:'channel', channelId, triggeringMessageId, agentId }` at creation, read verbatim
  on `:fork` (ARCHITECTURE.md §"Keep replay and fork deterministic").
- **The UI is mostly free.** Because the channel feed is now `ConversationView`, the
  agent's reply, interrupt/HITL cards, and A2UI surfaces render with **no channel-specific
  code** — the unification's payoff. (It renders on reload, not as a live token stream —
  see the no-message-SSE correction above.)
- **Scope guard:** agent membership management (add/remove an agent) reuses the existing
  participant routes; this ADR adds only the **post→turn** dispatch + the mention parse.

### 4. Data model — none new

No schema change. `type:'channel'` + the `channel` descriptor (ADR 0126) are unchanged.
Agent turns are normal conversation-runs; channel meta/membership/read-state remain
host-ext `DurableCollection` rows. Nothing new touches replay/fork (an agent's channel
post is the same replay-safe `chat.turn` ADR 0126 §replay already accounts for).

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | **Backend `features/channels/` untouched** (single owner of routes/service, gains only the post→turn dispatch hook). **Frontend `features/channels/` dissolves** into core chat chrome + a redirect shim — a conversation *type* is core; only the transport is the feature. No new package. |
| 2 | **Toggle + admin UI** | **No toggle change.** `channels` is graduated/always-on (ADR 0134); presence stays env-gated (`OPENWOP_CHANNEL_PRESENCE_ENABLED`). |
| 3 | **Workflow surface (ADR 0014)** | None net-new — an agent's channel post rides the existing `chat.turn`/conversation-run. |
| 4 | **Node pack** | None required. (A `core.chat.postToChannel` node remains optional sugar, deferred — ADR 0126 OQ.) |
| 5 | **AI-chat envelopes** | None — channel posts are ordinary conversation messages; A2UI/interrupt cards already render in any `ConversationView`. |
| 6 | **Agent pack** | None — any roster agent is added as a channel member (subjectRef); no channel-specific persona. |
| 7 | **Public surface** | None added. (The retired `/channels` page was authed-only; the redirect shim is authed. A public embeddable channel remains out of scope, ADR 0126 §7.) |
| 8 | **RBAC + isolation (ADR 0006)** | **No new authz.** Membership/owner gates stay server-side, fail-closed, uniform-404 (ADR 0126 §RBAC). Rail visibility of a channel follows the same membership the list query already enforces; the details panel's mutations stay owner-gated server-side. Server-side turn dispatch authorizes the agent member exactly as a participant. |
| 9 | **Replay / fork** | A human channel post is product state (unchanged from ADR 0126). A **server-fired agent turn** stamps `run.metadata.channel = { source:'channel', channelId, triggeringMessageId, agentId }` at creation, read verbatim on `:fork` — the only new `run.metadata` (the ADR 0125 scheduled-run attribution pattern). System-fired ⇒ no `actingUserId` (user/org BYOK fails closed; managed credential). |
| 10 | **Frontend** | Rail section (`conversationGroups.ts` + `ConversationsRail.tsx`); channel feed via the shared `ConversationView`/`useChatSession` (delete `ChannelMessages`); create affordance + channel-details panel + **presence bar** as chat **chrome around** `ConversationView` (ADR 0073 — never inside the slim unit), shown only for `type:'channel'`; `ui/` cohesion + a11y (roving focus, `aria-live` presence) + tokens + light/dark (`/ux-review`, `/browser`); the unified composer + mic UI come for free via `ConversationView`. |

## Phased plan

1. **Rail integration (frontend, read path).** Add the `'channel'` section to
   `conversationGroups.ts` + `ConversationsRail.tsx`; render a channel into the standard
   chat surface (`ConversationView` over `useChatSession`). Move the presence subscriber +
   bar (`ChannelsPage.tsx:54,99`) into the **full-chat chrome** (`ChatSidebar` header/right
   rail), shown only when the active conversation is `type:'channel'` — **NOT** into
   `ConversationView`, which is the slim, chrome-less embed unit (ADR 0073: "No header") and
   must not leak channel presence into the widget/`EmbeddedChatPanel`. **Delete
   `ChannelMessages`.** Verify a channel reads/posts through the unified surface.
2. **Management chrome.** `+`-create affordance on the rail section header; the
   channel-details panel (rename · archive · members · visibility) in the chat header/right
   rail, owner-gated, calling `channelsClient`. Remove the `ChannelsPage` management UI.
3. **Retire the page + redirects.** Drop the `ChannelsPage` + its nav entry; keep a
   **minimal `FrontendFeature` route** (stays in the `FRONTEND_FEATURES`/`chrome/features.tsx`
   seam — not a core router edit) rendering `<Navigate>`: `/channels` → `/` (Channels section
   focused) and `/channels/:id` → `/?conversation=:id`. The create-popover + channel-details
   panel land in `chat/` as **type-dispatched chrome** (a `type:'channel'` slot, not
   `if (channel)` branches), calling `client/channelsClient.ts`. Update i18n (remove
   `channelsLabel`/`channelsHint`; add the section label; en/es/fr/pt-BR).
4. **Agents in channels (ADR 0126 §4).** In `postChannelMessage`: parse an explicit
   `@agent` mention → resolve to one agent member; guard with
   `storage.claimIdempotency('channel-turn:'+messageId)`; dispatch **one** turn via
   `host/runStarter.ts` `startWorkflowRun({ workflowId:'openwop-app.chat.turn',
   conversationId, … })` (no inline insert), system-fired (no `actingUserId`, managed
   credential, `run.metadata.channel` attribution). Deliver the reply over the existing
   channel SSE. **No `useActiveAgents`** (frontend-only); multi-agent auto-arbitration
   deferred. **Route-level tests** (`createApp` + cookie jar): `@agent` post → exactly one
   run; retried post → still one; non-member/absent agent → denied/no-op; no managed key →
   fail-closed.
5. **Verify.** `( cd frontend/react && npm run build )` (tsc + token/CSS/i18n gates);
   `( cd backend/typescript && npm test )`; a render/router test asserting channels appear
   in the rail, open in `ConversationView`, `/channels` redirects, and an `@agent` post
   yields exactly one turn; `/browser` light + dark + ARIA tree.

## Alternatives weighed

- **Hybrid — keep a slim `/channels` admin page, move only the conversation into chat.**
  Lower risk, preserves a management home. Rejected as the end state: it still leaves a
  second destination for one concept (the very IA smell this fixes) and splits "create a
  channel" from "use a channel." Slack/Teams/Discord all manage *inside* the client. Kept
  as the fallback if Phase 2's chrome proves heavier than expected (OQ-1).
- **Additive — add the rail section but keep `/channels` + `ChannelMessages`.** Rejected:
  leaves the bespoke renderer + duplication (two message UIs over one store) — does not
  resolve the ADR 0073 violation; it *adds* a surface instead of removing one.
- **Defer agents-in-channels to a later ADR.** Viable (it is ADR 0126 §4, independently
  shippable). Folded in here because the unification *is* what makes it nearly free
  (`ConversationView` renders agent turns with no channel code), and the industry pattern
  the origin cited is specifically "AI woven into channels." The one real cost — server-
  authoritative dispatch — is called out as a correction, not hidden.
- **Client-driven agent turns in channels (reuse the 1:1 path verbatim).** Rejected: N
  connected clients → N duplicate replies. Dispatch MUST be server-side + idempotent (§3).

## PRD-vs-architecture corrections

- **"Make channels part of the chat UI"** → expressed as **core chat gaining a `'channel'`
  rail section + `ConversationView` reuse**, with the frontend feature-package
  *dissolving* (a conversation type is core; only the transport is a feature). The naive
  read ("move the ChannelsPage component into the chat folder") would have carried the
  bespoke renderer along; the correct move is to **delete it** and drive channels through
  the shared session.
- **"@mention an agent in a channel"** → corrected from the chat's client-driven turn to
  **server-authoritative, idempotent dispatch**, because a channel is multi-client where
  the 1:1 chat is not. This is the single non-trivial piece of new behavior.
- **Retire vs redirect** → full retirement of the page, but with a **redirect shim** (not a
  hard 404) for `/channels` deep links, following ADR 0145's link-rot care.

## RFC gate (the spec question, explicitly)

**None.** Every move is host-side: rail wiring + chat chrome (pure frontend IA) and
local-host post→turn dispatch over the already-Accepted conversation-run path (ADR 0067)
and the non-normative `/v1/host/openwop-app/channels/*` namespace. No run-event type,
capability flag, endpoint contract, or normative MUST is added or changed. The RFC
triggers ADR 0126 already named — **presence/typing/receipts on the wire** (covered by the
already-Accepted **RFC 0110**, emit env-gated, untouched here) and **cross-host channel
members or cross-host agent turns** (still deferred, needs a new RFC) — are **not** crossed
by this ADR. Advertisement honesty is unchanged (`OPENWOP_CHANNEL_PRESENCE_ENABLED`).

## Open questions

1. **OQ-1 — Channel-details panel weight.** Does rename/archive/members/visibility fit
   comfortably in the chat header/right-rail panel, or does it warrant a modal? Decide
   after `/browser` on Phase 2; the Hybrid fallback (a slim admin page) is the escape
   hatch if the chrome reads heavy.
2. **OQ-2 — Rail section order.** `Channels` between `Agents` and `Groups`, or after
   `Groups`? Tune in `/browser` against real conversation mixes.
3. **OQ-3 — Agent-trigger convention (narrowed by the `/architect` review).** v1 triggers a
   turn ONLY on an explicit `@agent` mention (deterministic + server-parseable — required
   because there is no server-side `useActiveAgents` arbiter). The one no-mention case: a
   channel whose **sole** agent member is the implicit addressee (the "DM-with-a-bot" feel).
   Multi-agent auto-arbitration is explicitly deferred. Confirm the single-agent
   auto-address in Phase 4.
4. **OQ-4 — Create affordance placement.** A `+` on the section header (proposed) vs a
   global "new" menu entry. Lean header `+` (locality); revisit if the rail already crowds.
5. **OQ-5 — Redirect lifetime.** How long to keep the `/channels` shim before dropping it
   entirely? Lean: keep one release cycle, then remove (greppable via the redirect).

## Implementation follow-ups (from per-phase reviews)

These surfaced in the Phase 1–3 `/code-review` + `/ux-review` passes; none block the
phases that shipped, but they are tracked here:

- **FU-1 — Multi-tab deck create/manage parity.** Phase 1 gave the deck channel
  *posting* + presence (TabSession), but the deck's rail (`TabLibraryPicker`/Runs+Reviews)
  carries no `+`-create or settings affordance, so channel *creation/management* is
  standalone-only. The deck is default-OFF; fold the create dialog + settings control into
  the deck as a fast-follow (the [[chat-three-surfaces-parity]] track).
- **FU-2 — Archived-channel visibility.** Archiving is one-way and an archived channel
  drops out of the rail (Phase 2 H2 fix) with no "archived" view or un-archive route
  (neither existed on the retired page either). Consider an archived filter + an
  un-archive route (a backend addition) later.
- **FU-3 — Deep-link soft-edge (pre-existing).** `/?conversation=<id>` for a channel the
  viewer can't see / a stale id silently no-ops and leaves the param in the URL — the same
  behavior as the existing `?agent=`/`?conversation=` deep-links. Out of scope here.
- **FU-4 — Public-channel discoverability.** The rail sources from `/chat/sessions`
  (owner-or-participant visibility), so a **public** channel a user hasn't joined isn't
  listed and there is no self-join route (`addChannelMember` is owner-gated) — public
  channels are reachable only by deep-link. The retired page's `listChannels` showed all
  non-archived channels. Restore discovery (a "browse/join public channels" affordance +
  a self-join route) as a follow-up. (Private-channel handling *improved* — the rail no
  longer over-shares them.)
- **FU-5 — Dispatch integration test.** The agent-turn *targeting* (`selectChannelTurnTargets`)
  + agent add/remove authz are tested; the end-to-end **dispatch** (post → exactly one
  `channel.turn` run → reply persisted → no re-dispatch loop) is verified by review/reading
  but not yet by an integration test (the dispatch is fire-and-forget, so the test must poll
  for the run). Add it.
- **FU-6 — Live message delivery.** There is no channel message-delivery SSE; posts +
  agent replies appear on reload, not via live push. A `channel.message` SSE (the ADR 0126
  Phase-3 idea that wasn't fully built) would make channels live for all members.

**Correction (Phase 4 §3 — idempotency).** §3 specified a `claimIdempotency` guard on the
agent-turn dispatch. Implementation + review found it unnecessary *and* a storage leak (no
daemon prunes a route-written claim): each post has a unique `messageId` handled by exactly
one request, so dispatch already fires once per (post, agent); a crash-recovered re-run
reuses its `runId` and the agent-runner's reply append is idempotent on it. The claim was
**dropped**; exactly-once is preserved by single-handling (documented in
`channelAgentDispatch.ts`). The ADR's *intent* (no duplicate agent turns) stands.
