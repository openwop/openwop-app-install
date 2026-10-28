# ADR 0978 — Multi-tab deck: protect the tabs that need you, sweep only what the deck made, keep each workspace's working set

Status: implemented

**Date:** 2026-10-25 · **Extends:** ADR 0140 (multi-tab chat deck) · **Feature:** `multi-tab-chat`
(feature loop round 2, row 55) · **RFC verdict:** host-only. Frontend composition over
existing host-extension routes; no wire field, no capability flag, no `/.well-known/openwop`
change.

## Context

Round 1 graded the deck A / B / A. Every grade was a claim: two workflow passes graded only the
doctrine ("frontend-only, no workflow"), and the code pass graded isolation and the one-chat
rule. The round-2 baseline (`WORKFLOWS-ASSESSMENT.md` § row 55, `MT2WF-*`) re-read the
deck as what it actually decides: **which conversations keep a live subscription, and which
conversations get deleted.**

**Prod fact (read-only, 2026-10-25).** `hostext:feature-toggle:multi-tab-chat` is stored
`status:"on"` (since 2026-06-25), which shadows the declared default `off`. The deck is
therefore the prod chat surface for every user. `FEATURES.md` says OFF.

Measured defects (all on `origin/main` `e774c8561`):

1. **`MT2WF-1` — eviction ignores what matters.** The protected set is `streamingRef`, fed by
   `isSending` (`TabChatDeck.tsx:263-267`, `TabSession.tsx:228`). That is the chat turn
   only. A `/workflow` run has its own subscription map (`chatSession/core.ts:99`), and a
   turn suspended on a HITL interrupt has already settled. So a tab that is **waiting on
   you** or **running a workflow** is an ordinary LRU victim. At the hard wall it is
   sacrificed even when pinned. Unmounting closes its workflow subscriptions. The deck already
   derives both facts for the badges (`deriveActivity`) and never feeds them to eviction.
2. **`MT2WF-3` — the hard ceiling grows.** When no victim qualifies, `open` appends past
   `HARD_MAX_TABS` (round-1 `MTCC-1`). Widening protection (1) makes this reachable.
3. **`MT2WF-2` — the client deletes conversations it never created.** On every mount the
   deck hard-deletes any listed row with `messageCount===0`, `type ∈ {undefined,'agent'}`,
   untouched for 6 h and not open (`selectStaleEmptySessions`). It has no ownership
   predicate. The list route projects a meta-less legacy row as `type:'agent'` and lists it
   to every member. `requireOwner` is permissive when no owner is recorded, so one member's
   deck deletes tenant-shared rows. It also deletes the caller's own feature-bound empty
   conversations: an agent DM loses its `dmKey` meta with it. The close-time adoption
   (`:464-467`) applies the same shape to open tabs. The ChatSidebar one-shot purge
   (`ChatSidebar.tsx:275-290`) is the same generator **with no type filter**: empty
   project, notebook and board group chats that a writer may manage.
4. **`MT2WF-4` — a workspace switch empties the deck.** The descriptor is keyed per user
   (`tabdeck:<uid>`). The workspace switcher hard-reloads. The restored ids belong to
   workspace A while the list is workspace B's, so the dead-tab prune closes every tab
   ("N tabs removed"). The next save overwrites A's set.
5. **`MT2CD-*` — two parity drifts.** A tab of a registered kind whose feature is now OFF
   still mounts its Component. The code comment says it shows "unavailable", but only an
   *unregistered* kind does. Deck composer drafts are keyed `draft:demo:<sid>` because the
   deck never passes `tenantId`; ChatSidebar moved to the uid in CS-FE-6.

## Decision

### D1 — One protected set: streaming ∪ running ∪ blocked ∪ server-known busy

The eviction-protected set is computed from ONE source per tab: the activity report every
`TabSession` already sends (`onActivity(sid, lastInboundId, blocked, running)`, where
`running` already includes `isSending`). A tab is protected when its last report says
`blocked || running`. For tabs with no live report (restored, never visited, so not
mounted), the protected set also includes the **server's** signals the deck already
loads: `reviewCountsByConversation.get(sid) > 0` (waiting on you, ADR 0776) and
`runningConversations.has(sid)` (a run in flight, ADR 0776 P2). No new signal, store or
poll. `streamingRef` stays only as the reap's send→persist race guard. The reap concerns
empty conversations, and there `isSending` is the right fact.

### D2 — The hard ceiling is absolute

`selectEvictionVictim` gains a third outcome: `{ kind: 'refuse' }` when the deck is at
`HARD_MAX_TABS` and every tab is active or protected. `open` then returns the state
**unchanged**. The hook reports the refusal, and the deck shows a toast that says why
("Every open tab is busy — close one to open another") and names no tab. Opening never
grows the deck past 24. Restore already clamps (`sanitizeTabDeck`).

> **Amended by the pre-code `/architect` pass (H1, H3).** "Returns the state unchanged" left
> the callers' side effects behind: `openKindTab` runs the kind's `seed` (Claude Code
> reattach state) before it opens, and `?agent=`, `?newTab=` and `newTab` each write per-tab
> state first. So `openTab` returns `boolean`, decided by a pure `canOpen` evaluated BEFORE
> the dispatch, and every caller does its side effects only when it returns true.
> Protection blocks only **automatic** eviction. A user can close any tab, protected or not,
> and the refusal toast says so. Refusal happens only at the 24 hard wall, never at the soft
> cap of 8. That matters because a workflow message whose subscription died without a
> terminal event stays `running` in message state, so a tab can be protected
> indefinitely, and the way out must always be one click.

### D3 — One "abandoned empty chat" predicate, owner-only, for every automatic delete

`chat/lib/abandonedChat.ts` exports one pure predicate, `isAbandonedEmptyChat(header)`:
`messageCount === 0` ∧ `type === 'agent'` ∧ no `boardId`/`ownerSubject`/`client` ∧
`ownerUserId` recorded ∧ **exactly one** participant, `role:'owner'`, whose `subjectRef` is
`user:<ownerUserId>`. A deck "New chat" has exactly that shape: the server records the
creator as the sole owner participant (`ensureConversationMeta`).

**Why this proves the caller owns it.** The list route shows a non-channel conversation
that is not container-bound only to its owner or a participant (`isVisibleTo`,
`host/conversationVisibility.ts`). A listed row whose only participant is its owner was
therefore listed *because* the caller is that owner. The predicate leans on a server rule
rather than a client comparison, so a backend test pins it: another member never lists an
owner-only conversation.

**Why not `isSelf`.** This was the first draft, and it is wrong. The server stamps
`isSelf` by comparing `callerSubject(req)` with the participant ref. For an anonymous
session, `callerSubject` is `session:<sid>`, but the owner participant is
`user:session:<sid>` (`userRef(actingUserOf(req))`). OIDC subjects have the same mismatch.
`isSelf` is therefore never true for those callers, and 31 of prod's 45 leftovers belong to anon
tenants. The mismatch itself is a chat-core defect (ADR 0192 unread state) and is filed as
`MT2WF-R2`, not fixed here.

Excluded by construction:
- a meta-less legacy row (no owner, no participants), the cross-member vector;
- a DM (it has a second participant);
- every container-bound conversation (project, notebook, board, client).

The deck's stale sweep, its close-time adoption, and the ChatSidebar one-shot purge all
call it. The age guard and the open-tab and deck-minted exclusions stay in
`selectStaleEmptySessions`. Each of the three callers gets a behaviour test, seeded with a meta-less row, a DM and a
project chat, and sabotage-witnessed.

> **Amended by the pre-code `/architect` pass (H2).** The first draft proposed a ratchet:
> "a `.remove(` inside an automatic effect must be dominated by the predicate". Dominance
> is control flow, and a text match passes for a predicate call anywhere nearby. That is a
> gate that cannot fail, so it was dropped for the behaviour tests above.

Not changed: the backend still lets any member delete a meta-less legacy row through the
rail's ⋯ Delete. That is a deliberate user act under the legacy "tenant-owned" policy (ADR
0043 Phase 6). It is filed as `MT2WF-R1` rather than changed here.

### D4 — The working set is kept per workspace

The deck resolves the active workspace once, through the existing single-flight
`ensureWireTenant(listMyWorkspaces)` (`client/v2Wire.ts`), before it restores. It then
persists under subject `${uid}@${workspace}`. On the first visit to a workspace with no
keyed descriptor, it adopts the legacy `tabdeck:<uid>` descriptor, and deletes the
legacy key only after the first clean prune has kept at least one tab. If the first
workspace visited after the deploy is not the one those tabs belong to, they are pruned
there and the legacy key survives for the right workspace.

> **Amended by the pre-code `/architect` pass (M4, M5).** The first draft deleted the legacy
> key on adoption, so a user whose first visit was the wrong workspace lost the set once.
> The busy placeholder costs a request before the first paint of what is, in prod, the
> chat surface for everyone. `ensureWireTenant` is single-flight and usually warm from the
> v2 wire binding; the implementation measures it. While the workspace is
unresolved the deck renders a busy placeholder, never a bootstrapped empty tab: the bootstrap would
mint a conversation into the wrong set. If the workspace cannot be resolved (offline,
signed out), the deck falls back to today's uid-only key rather than refusing to render.

### D5 — Parity fixes

- A kind tab whose feature is not visible renders the existing `multiTabKindUnavailable`
  StateCard. Its Component never mounts while the feature is off, and the code comment
  becomes true. Closing from that card still runs the kind's `onClose`, as the user asked.
- The deck passes `tenantId={user?.uid ?? 'anon'}` to every `TabSession`, so drafts key
  exactly as ChatSidebar's do (CS-FE-6). Drafts under `draft:demo:*` are abandoned. They are
  ephemeral and per-session, and migrating them would carry another user's draft into the
  current account on a shared browser.

### D6 — Focus follows the deck's own keyboard actions (round-1 `MTCU-101/102`)

`Alt+1..9` and `Alt+W` move DOM focus to the newly active tab button (the APG tablist
contract the strip already implements for Delete). `Alt+N` moves focus to the new tab's
composer. The tab mounts one render later (the `mountedIds` effect), so this is a
post-mount focus request, not a synchronous call (`/architect` M6). A mouse action never steals focus. Closing a busy tab (D1's set) does not ask
for confirmation: the run survives server-side and the rail shows it (ADR 0776 P2). It
announces where the work went instead ("<title> keeps running — reopen it from
Conversations"), which closes `MTCU-401` without adding friction to every close.

## Alternatives considered

- **Protect only `isSending` and badge harder.** Rejected. A badge on a tab that has been
  evicted cannot be seen.
- **Server-side "abandoned" flag on eager-created rows.** This would be the strongest
  provenance, but it is a store change for a cleanup heuristic. The owner-only predicate is
  already exact for the deck's shape, and the close-time reap re-counts server-side before
  deleting.
- **Delete the sweep entirely.** Leftover empty rows are hidden by the rail filter. Rejected
  only because prod has 45 such rows. The owner-only sweep is safe, and it keeps the rail and
  search clean.
- **Store a per-tab `tenantId` and park foreign tabs.** No extra request, but it keeps two
  workspaces' tabs in one state machine. Every reducer path would have to learn to ignore
  parked tabs. Rejected for D4's one-key-per-workspace.
- **Flip the declared default to `on`.** Prod already behaves as ON. Changing the declared
  default is a product decision for every white-label adopter. Not taken here; `FEATURES.md`
  is corrected to state the prod override instead.

## Phased implementation

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 + D2: protected-set projection, `refuse` outcome, toast | `tabDeckModel.test.ts` (refuse at 24, blocked/running never victims); deck test: a blocked background tab survives opening 8 more |
| P2 | D3: `abandonedChat.ts` + the three callers | predicate table test; deck sweep test with a meta-less row and a DM (both spared); ChatSidebar purge test with a project chat (spared) |
| P3 | D4: workspace-keyed persistence + legacy adoption | `tabDeckPersistence` tests; deck test: restore under workspace B leaves A's descriptor intact |
| P4 | D5 + D6 | kind-off test; draft-key test; focus tests for Alt+1/Alt+W/Alt+N |
| P5 | Docs: FEATURES row (prod ON via override), ADR 0140 correction notes, trackers | — |

Each guard gets a sabotage witness: revert the guard, watch its test go red.

## Implementation record (2026-10-25, branch `feat/fl2-55-multi-tab-chat`)

| Phase | Commit | Witness |
|---|---|---|
| P1 D1+D2 | `8e88359c9` | `TabChatDeck.adr0978.test.tsx` § D1/D2, `tabDeckModel.test.ts` (S1–S5 red) |
| P2 D3 | `8e88359c9`, `20dd652bd` | `abandonedChat.test.ts`, `selectStaleEmptySessions.test.ts`, deck § D3, backend `multi-tab-sweep-predicate-premise.test.ts` (S6–S11 red) |
| P3 D4 | `8e88359c9`, `770569ad5` (warm tenant, M5) | deck § D4 (S12–S14 red) |
| P4 D5+D6 | `8e88359c9`, `6f1dbc383` (Alt+P, CTA, honest prune notice) | deck § D5/D6 (S15–S22 red) |
| P5 docs | `0859303a2` | FEATURES row, ADR 0140 correction, trackers |

M5 (a request before first paint): `listMyWorkspaces` now remembers the active tenant, so
`ensureWireTenant` is warm whenever the shell's workspace switcher has loaded. A cold
resolve still costs one request; it is checked live as `CT-MT2UX-3`.

## Pre-code `/architect` pass (2026-10-25)

0 Critical, 3 High (H1 refusal side effects, H2 vacuous ratchet, H3 permanent protection
wedge), 3 Medium (M4 legacy adoption loss, M5 first-paint request, M6 Alt+N focus timing).
All are folded into the decisions above as amendment notes. Out of scope, filed: the G6
pop-out window shares the descriptor key with its opener, so the last writer wins
(`MT2WF-R3`).

## Open questions / decisions

- [ ] `MT2WF-R1` — should the backend refuse a non-creator's DELETE of a meta-less legacy row?
  This is policy for ADR 0043, not this feature. Filed.
- [ ] Should the declared default become `on`, matching prod? This is a product decision. Filed to the lead.
- [ ] `MT2WF-R2` — `isSelf` is never true for anon/OIDC callers (`callerSubject` vs `userRef(actingUserOf)`). Chat-core (ADR 0192), filed.
- [ ] `MT2WF-R3` — pop-out window and opener share one descriptor key; last writer wins. Pre-existing, filed.
- [ ] Draft migration from `draft:demo:*`: decided no (D5).
