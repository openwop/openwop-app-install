# ADR 0140 — Multi-tab chat deck (a bounded working set of live, independent chat sessions)

**Status:** implemented — all 7 phases (2026-06-25), behind the default-OFF
`multi-tab-chat` toggle. Each phase shipped with an `/architect` GO + `/code-review`
CLEAR + (for the UI phases) a `/ux-review`, fixes applied. **Phase → commit:**
P1 backend-keyed persistence mode (`0abb7dac`); P2 working-set state machine
(`f29173b2`); P3 keep-alive deck container (`4ebd7130`); P4 APG tablist strip
(`4c8f39fb`); P5 background badges (`91839c9b`); P6 persist & restore (`1ce8d3e7`);
P7 library integration + keyboard (this commit). Open gaps tracked in the checklist.
**Date:** 2026-06-24 (implemented 2026-06-25)
**Toggle:** `multi-tab-chat` · default **OFF**. When OFF, chat behaves exactly as
today — one active conversation, switched via the sidebar list (`ChatSidebar`
`selectConversation` → `loadSessionFromBackend`). When ON, the chat surface gains a
**tab strip** above the conversation view holding a bounded working set of
**simultaneously-live** sessions; the sidebar list stays as the durable library.
**Surface:** evolves **core `chat/`** (`frontend/react/src/chat/`, the shared RFC 0005
conversation primitive) — **not** a `features/<id>/` package, because chat is core, not
a product feature, and the seam table (`ARCHITECTURE.md` §"Existing extension seams")
has no "modify the core chat surface" row. That is a deliberate, recorded architectural
decision (this ADR), not a parallel path. Frontend-only composition: no new chat system,
no new backend store, no OpenWOP wire field. Each tab instantiates the **existing**
`useChatSession` session primitive — it does NOT shadow it ([[no-parallel-architecture]]
/ no-second-chat-system). **Reversibility guarantee:** with the toggle OFF, `ChatSidebar`
and the single-active path are byte-for-byte unchanged (the deck mounts only when ON).
**Depends on / composes:** `chat/hooks/useChatSession.ts` (the session primitive — per
tab), `chat/ConversationView.tsx` (the slimmed feed+composer+interrupt view — one per
tab), `chat/ChatSidebar.tsx` (the library list + the single-active switch this
generalizes), `chat/EmbeddedConversation.tsx` / `EmbeddedChatPanel.tsx` (ADR 0073 — the
keep-alive precedent of "one session per mount"), `client/streamsClient.ts`
`subscribeToRun` (the per-run SSE subscription that must stay alive in background tabs),
the event-log reconcile/replay path (`useChatSession.ts` self-heal — rehydration when an
evicted tab is reopened), the run store (runs are **orphaned, not killed**, on
front-end teardown today — the property the deck relies on).
**RFC verdict:** **host-extension — NO new RFC.** Multi-tab is pure front-end
composition over already-durable conversations + runs + run-event streams. No new
run-event field, capability flag, event type, endpoint contract, or normative `MUST`.
The backend already keeps a conversation run alive after the front-end stops listening
(`loadSessionFromBackend` nullifies `conversationRef` without closing the run —
`useChatSession.ts:979`); the deck simply stops throwing that liveness away. **No new
authz surface:** opening a tab reuses the server-authz'd `loadSessionFromBackend(id)`
path the sidebar already uses (ownership enforced backend-side per `sessionId`); N open
tabs add no new by-id route to harden.

> **Origin.** Product ask: "a multi-tab chat interface where each tab has its own full
> instance of a chat, so users can multitask across concurrent sessions." A
> deep-research pass (NN/g, W3C ARIA APG, MDN, React `<Activity>` docs, VS Code, Slack,
> tab-rs; 23/25 adversarially-verified claims) shaped the decisions below — most
> sharply the **keep-background-streams-alive** requirement and the **`<Activity>`
> effect-teardown trap** (§Decision 3).

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "a new tabbed chat panel, each tab a fresh chat." That is the exact
fragmentation `CLAUDE.md` forbids: it would fork the chat machinery
(turns/streaming/interrupts/BYOK/workflow dispatch) into a parallel surface that drifts
(the removed `AiAuthorPanel` is the cautionary tale). A "tab" here is **not a new chat**:
it is one more **instance of the existing session primitive**, the same way ADR 0073's
`EmbeddedConversation` is "one `useChatSession` per mount." The deck is a **container +
a bounded working-set model**, not a chat.

| Concern | Existing owner (file:line) | How the deck reuses it |
|---|---|---|
| A chat session (turns, streaming, interrupts, BYOK, workflow dispatch) | `chat/hooks/useChatSession.ts` — all *in-memory* state is **per-hook-instance refs** (`conversationRef` :275, `conversationTurnsRef` :280, `subRef` :268, `workflowSubsRef` :287); **no module singletons** | One session **per tab**, in a **new persistence mode** (see next row) — NOT `persist:true` as-is. Per-instance refs already isolate N sessions in memory with zero collision. The deck does not touch session internals. |
| Per-conversation persistence | **durable + keyed:** backend `appendChatMessage(sessionId,…)` (`useChatSession.ts:384`) + the localStorage **index** (`upsertSessionIndex` by `sessionId`, `chatPersistence.ts`). **BUT a singleton hot-cache:** `persist:true` reads/writes ONE `LS_CURRENT_SESSION_KEY` with no id (`loadSession()`/`persistSession()`, `chatPersistence.ts:99,111`; the write-effect `useChatSession.ts:327`) | **Load-bearing.** The durable truth is keyed; only the localStorage "current session" cache is a **singleton N tabs would clobber**. The deck adds a **third persistence mode** — backend-keyed via `loadSessionFromBackend(id)`, **skipping** the singleton current-cache. See §Decision 0 + P1. |
| The conversation view | `chat/ConversationView.tsx` (presentational; "never calls useChatSession", :7-8) | Each tab renders one `ConversationView`, fed by its own session — identical to `EmbeddedConversation.tsx:84`. Hidden tabs keep a **windowed** view (`hasOlderMessages`/`loadEarlierMessages`), so N mounted = N *windowed* lists, not N full histories. |
| The library of conversations | `chat/ChatSidebar.tsx` — `sessionsCollection` (the index/list) + `selectConversation` (:339) → `loadSessionFromBackend` (single-active switch); also sets lineups/rail/convene (:341-353) | Stays as the **single** library. `useTabDeck` holds **only** ids + UI state (order/active/pinned) — it does **NOT** stand up a second index; it reads `sessionsCollection`. Opening a sidebar item adds/focuses a tab instead of replacing the one active session; per-tab lineup/rail/convene state is preserved on focus, not reset. |
| Background run survival | run store; `loadSessionFromBackend` **nullifies** `conversationRef` without closing the run (`useChatSession.ts:979`) | The run already survives front-end teardown server-side. The deck keeps the **front-end subscription** alive too (the missing half). |
| Rehydration of a reopened conversation | the event-log reconcile/replay in `useChatSession` (self-heal from the run event log on resubscribe) | An evicted tab (closed from the working set) reopens by remounting its session, which replays from the event log — exactly today's `loadSessionFromBackend` path. |
| Unread / blocked signal | per-session status (`isSending`) + the interrupt/HITL cards already in `ConversationView` | A background tab's badge is derived from its **live** session status — no new notification type, no new store. |

**Net new (all front-end):** a **third per-tab persistence mode** in `useChatSession`
(backend-keyed, no singleton localStorage current-cache — §Decision 0), a `chat/tabDeck/`
container (the tab strip + the working-set state machine: open tab ids, order, active,
pinned, LRU), a **keep-alive mount strategy** so inactive tabs stay live instead of
unmounting, badge derivation from each live session, and persistence of the lightweight
working-set descriptor (conversation ids + UI state — **not** messages, which already
persist). **No new chat, no backend store, no wire change, no second session index.**

---

## Decision

Ship a **multi-tab chat deck**: a tab strip hosting a **bounded working set** of
conversations, each a full, independent, **simultaneously-live** `useChatSession`
instance, with the **sidebar list retained as the library**. Five load-bearing
decisions:

### 1. Sidebar = library, tabs = workbench (NOT tabs-as-navigation)

The research is unambiguous that **tabs are the wrong pattern for an open-ended,
must-monitor-many collection** (NN/g, Fresh Consulting — verified 3-0), and that the
"2–6 tabs max" rule is about *navigational category tabs*, **not** document/session
tabs (refuted 0-3 — document tabs routinely run 10–20+). Chat conversations are an
open-ended growing collection → they belong in a **sidebar list** (which already
exists). Tabs are a **bounded active working set** layered on top — the VS Code model
(editor tabs above the Explorer tree), the closest verified prior art. **Tabs are never
the only way to reach a conversation.**

### 0. A third persistence mode — backend-keyed, no singleton hot-cache (the blocking prerequisite)

`useChatSession` has two modes today, and **neither fits multi-tab**: `persist:true`
binds to a **single** localStorage slot (`LS_CURRENT_SESSION_KEY` — `loadSession()`/
`persistSession()` take no id, `chatPersistence.ts:99,111`; the write-effect fires on
every change, `useChatSession.ts:327`), so N persistent tabs would **clobber one slot**
and all hydrate from the same blob; `persist:false` is ephemeral (ADR 0073) and writes
no backend history. The durable truth is already keyed — backend `appendChatMessage(
sessionId,…)` + the localStorage **index** — only the "current session" *hot-cache* is a
singleton. So the deck adds a **third mode**: per-tab sessions hydrate via the existing
keyed `loadSessionFromBackend(id)` and persist through the keyed backend path, but
**skip the `LS_CURRENT_SESSION_KEY` read/write** (or key that cache by `sessionId`). This
is the **first build task (P1)**, gated by a two-concurrent-session isolation test (a
turn in tab A must never mutate tab B's stored session) — it is a design task, not a
verification checkbox.

### 2. Each tab is the real session primitive, instantiated — never a copy

Each tab mounts one `useChatSession` in the Decision-0 mode, scoped to its conversation
id. The audit confirmed all *in-memory* session state is per-instance refs with no
module singletons, so N live sessions coexist without collision (the only shared slot is
the localStorage hot-cache that Decision 0 removes from the per-tab path). This is
[[no-parallel-architecture]] applied: a tab **instantiates** the chat session, it does
not reimplement it — and the **library stays the one `sessionsCollection`**; the deck's
`useTabDeck` holds only ids + UI state, never a second index.

### 3. Keep-alive by hiding, NOT by unmounting — and NOT via React `<Activity>`

**This is the load-bearing technical decision.** The lifecycle audit found that today
an inactive conversation's front-end stream is **torn down on unmount**:
`useChatSession.ts:433-436` runs `subRef.current?.close()` + `closeAllWorkflowSubs()` in
the unmount cleanup, so switching away closes the SSE subscription (the backend run
survives, but the front end goes blind). For background tabs to keep streaming — and for
unread/blocked badges to update at all — **inactive tabs must not unmount.**

The deck keeps every working-set tab **mounted**, hiding inactive ones with
`display:none` (the verified "keep-alive" pattern). State **and effects** are preserved,
so the in-flight SSE subscription stays open and tokens keep arriving in the background.

> **Correction-prone subtlety — do not "optimize" this into React `<Activity>`.** The
> obvious move is `<Activity mode="hidden">` (state-preserving background rendering).
> But the React docs are explicit and **verified (3-0)**: *hiding an `<Activity>`
> boundary destroys its children's effects.* That would fire `useChatSession`'s unmount
> cleanup (`:433`) and **close the very SSE subscription we need alive** — silently
> re-introducing the background-blindness bug. Plain CSS keep-alive (`display:none`,
> component stays mounted, effects keep running) is therefore the **correct** primitive
> here, and `<Activity>` is the **wrong** one. Revisit only if React ships an
> effect-preserving hidden mode.

Because an **idle** session already closes its subscription in the send `finally` block
(`useChatSession.ts:825`), a quiet background tab holds **no** open stream — the cost of
keep-alive is paid only by tabs with a run actually in flight, which is exactly when we
want it. Net resource cost for a bounded working set is small.

### 4. Bounded working set + LRU eviction to the sidebar

The working set is capped (proposed **default 8**, configurable). Opening beyond the cap
**evicts the least-recently-used unpinned, idle tab** — its run survives server-side and
it returns to the sidebar list; reopening it rehydrates from the event log (today's
`loadSessionFromBackend`). **Pinned** and **streaming** tabs are never auto-evicted.
Eviction is `log()`-loud in dev (no silent truncation). This bounds memory without the
refuted low "6 tab" ceiling. **Memory note:** keep-alive holds N message-DOM trees
hidden, but each is a **windowed** view (`hasOlderMessages`/`loadEarlierMessages`
already cap rendered messages per `ConversationView`), so the cost is *N × a windowed
list*, not *N × full history*; the cap bounds N. An idle background tab additionally
holds **no** open SSE subscription (closed in the send `finally`, `useChatSession.ts:825`),
so keep-alive cost is paid only by tabs with a run in flight — exactly when we want it.

### 5. Accessibility is the APG tablist contract, exactly

The strongest-verified section of the research (11 ARIA claims, 3-0 each, against the
W3C APG + MDN). The tab strip is `role="tablist"`; tabs `role="tab"` wired to
`role="tabpanel"` via `aria-controls`/`aria-labelledby`; `aria-selected` on the active
tab. **Roving tabindex with the `0` on the active tab itself** (the
container-`tabindex=0` variant was **refuted 1-2** — do not use it). **Manual
activation** (arrows move focus, Enter/Space activates) — mandatory here because
activating a tab swaps an entire live conversation view, so auto-activation-on-focus
would thrash expensive panels (the APG's stated condition for preferring manual).
`Delete` closes the focused tab (3-0). **Correction (P7):** the deck shortcuts are
**`Alt`-based**, NOT `Ctrl/Cmd+T/W/1..9` as first drafted — those are browser-reserved
(new/close/switch *browser* tab) and not reliably preventable; `Cmd/Ctrl+W` in
particular would close the whole browser tab and kill every live background run, the
opposite of this feature's thesis. Shipped: **`Alt+N`** new tab, **`Alt+W`** close
active (the focused-tab `Delete` path also works), **`Alt+1..9`** jump to the Nth tab
(the VS Code editor-group precedent; `Alt`+key is preventable). Keyed on `e.code`
(physical key) so it survives macOS Option dead-keys.

---

## Alternatives considered

- **A new tabbed chat panel (each tab a bespoke chat).** Rejected outright — it forks
  the chat machinery and drifts (`AiAuthorPanel` precedent); violates the one-chat rule
  and [[no-parallel-architecture]].
- **React `<Activity mode="hidden">` for background tabs.** Rejected — destroys effects
  on hide (verified), which closes the SSE subscription and re-creates the
  background-blindness bug. See Decision 3. Plain CSS keep-alive is correct.
- **Lazy: unmount background tabs, rehydrate on reopen from the event log.** Rejected as
  the *default* — cheapest, and the backend run does survive, but a background tab is
  **blind while away**: no live progress, and the unread/blocked badge **cannot update
  from a closed subscription**. Fails the multitasking premise (the whole point is "kick
  off work in tab B, watch it land while reading tab A"). It *is* retained as the
  **eviction** path for tabs pushed out of the bounded working set (Decision 4).
- **Multiple OS windows (Slack "open in new window" model).** Verified prior art and a
  reasonable *complement*, but it is per-conversation chrome, not a working-set manager,
  and fragments keyboard/focus. Out of scope; a tab can later offer "pop out".
- **No tabs — just improve the sidebar.** The honest baseline. If the only need were
  *reaching* conversations, the sidebar suffices (this is why ChatGPT/Claude ship a
  list, not tabs — the OpenAI thread is users *requesting* tabs). Tabs earn their
  complexity **only** for the *simultaneously-live, monitor-many* use case — which is
  precisely what was asked for, and what the toggle gates.

---

## Phased implementation plan

- **P1 — Third persistence mode + isolation test (the blocking prerequisite, §Decision 0).**
  Add the backend-keyed, no-singleton-current-cache mode to `useChatSession`; per-tab
  sessions hydrate via `loadSessionFromBackend(id)` and skip `LS_CURRENT_SESSION_KEY`.
  **Gate:** a test mounting two concurrent persistent sessions asserts localStorage +
  backend isolation (a turn in tab A never mutates tab B's stored session). *(P0(b) —
  that `display:none` keep-alive preserves the subscription — is already confirmed by
  React semantics: a CSS-hidden node stays mounted and the unmount cleanup at
  `useChatSession.ts:433` is `[]`-keyed, unmount-only; no code needed to validate.)*
- **P2 — Working-set state machine** (`chat/tabDeck/useTabDeck.ts`): open/close/focus/
  reorder/pin, LRU eviction, max-cap. Holds **only** ids + UI state; reads
  `sessionsCollection`, never a second index. Pure + unit-tested. No rendering yet.
- **P3 — Keep-alive deck container** (`chat/tabDeck/TabChatDeck.tsx`): mounts one
  session+`ConversationView` per open tab; active tab visible, rest `display:none`
  (NOT `<Activity>` — Decision 3). Focus preserves per-tab lineup/rail/convene state
  (the `selectConversation` side-effects, `ChatSidebar.tsx:341-353`). Wire into the chat
  surface behind the toggle. This is where background streaming becomes real.
- **P4 — Tab strip UI** (`chat/tabDeck/TabStrip.tsx`): APG tablist (Decision 5), drag-
  reorder, close ×, pin, **overflow = horizontal scroll + an overflow dropdown listing
  every open tab** (verified: overflow has no single answer; scroll+menu is the robust
  combo). Titles auto-derived from the conversation/agent, renamable.
- **P5 — Background badges:** unread dot when a background tab's session appends a turn;
  a **distinct, higher-urgency** indicator when a background tab is **blocked on a HITL
  interrupt** (the single most important background signal — a blocked agent waiting on
  you outranks "new message"). Cleared on focus.
- **P6 — Persistence & restore:** persist the working-set descriptor (open ids, order,
  pinned, active) so reload restores the workbench; active tab mounts live, the rest
  restore and rehydrate lazily. Conversations themselves already persist server-side.
- **P7 — Library integration + keyboard (DONE):** a lightweight **library picker**
  (`TabLibraryPicker`) over the single `sessionsCollection` index → `openTab` (dedupes/
  focuses), with rename + delete; a `?conversation=<id>` deep-link (open-or-focus, ref-
  guarded, param-cleared); **`Alt`-based** shortcuts (`Alt+N`/`Alt+W`/`Alt+1..9` —
  NOT browser-reserved `Cmd/Ctrl+T/W`, see Decision 5 correction). Reused the existing
  library DATA, not `ConversationsRail` (whose agent-lineup zone describes a single
  active session the deck doesn't have). "Pop out to window" deferred.

Each phase gated `/architect` GO + `/code-review` CLEAR (+ `/ux-review` for the UI
phases P3–P7), frontend `npm run build` green.

## Known gaps after P7 — NOW CLOSED (parity pass G1–G6, 2026-06-25)

The P7 end state left four honestly-recorded parity gaps. They are **now closed** by the
G1–G6 parity pass (each with `/architect` + `/code-review` + `/ux-review`). The closure
preserves the deck's core invariant — **no single-active coupling**: every per-tab concept
is driven by THAT tab's own `useChatSession`, never lifted to the deck.

| Gap | Closed by | How |
|---|---|---|
| Shared submit drift (3 copies) | **G1** `chat/lib/chatSubmit.ts` | One CORE `runCoreSubmit` (command → /workflow → caller interceptors → @agent → send); ChatSidebar/EmbeddedConversation/TabSession all compose it. Behavior provably identical. |
| Per-tab agent management | **G2** `ConversationLineup` | Extracted from `ConversationsRail` zone 1; each `TabSession` renders its OWN lineup (switch/drop/thinking-pulse) from its own `activeAgents`, shown only for a real team (`lineup.length > 1`), with a compact `strip` variant. Participants persist via the deck's `add/removeParticipant`. |
| Convene/board (`@@`) in tabs | **G3** `chat/conversations/convene.ts` | The `@@` convene/board logic extracted into shared interceptors; each tab builds its own cadence + interceptors → `@@<board-handle>` summons a board into any tab, a bare `@@` convenes the owning project's team for a project tab. The "not available yet" notice is gone; a bare `@@` with no project gives honest guidance. |
| `?agent=<id>` deep-link | **G3** | The deck opens a NEW tab scoped to the agent via `useScopeToAgent`. |
| (polish) restored-tab title flash | **G4** | `DeckTab.lastTitle` persisted + restored → real label at first paint. |
| (polish) off-screen blocked tab invisible | **G5** | A pulsing edge cue when a HITL-waiting tab is scrolled out of the strip, click-to-reveal. |
| (polish) pop-out | **G6** | A hover control opens a conversation in a new browser window via `?conversation=` (light deep-link; a chromeless single-conversation window remains deferred). |

Parity-pass commit trail (on `feat/multi-tab-parity`): G1 `aea2df2c`, G2 `9d7f347b`,
G3 `c2fe9001`, G4 `de1ff693`, G5 `fc7928a4`, G6 `00ac6a79`. Entry-bundle budget raised
168→169 kB (the shared submit/convene/lineup code is reached by the entry-loaded
`ChatSidebar`; the deck itself stays lazy).

### Post-merge hardening (full-implementation `/architect` review, 2026-06-25)

- **Per-user persistence isolation (was HIGH).** The working-set descriptor is keyed
  per-user (`…tabdeck:<uid>` + an in-envelope `subject`), but the SAVE side had no
  invariant binding the mounted state to its subject: an in-page identity switch
  (logout→login, no reload) on a shared browser could write user A's tab ids under user
  B's key (ids only — content stays backend-authz'd, so foreign tabs 404 + prune). Fixed
  by keying the deck on the uid in `ChatTab` (`<TabChatDeck key={user?.uid ?? 'anon'}>`)
  — each instance is bound to one identity, remounting fresh from the new user's key; the
  old instance's unmount-flush writes its own state under its own key. Pinned by a
  two-user isolation test.
- **`markRead` on focus (was a gap).** Activating a tab now clears the conversation's
  server-side unread marker (mirrors `ChatSidebar.selectConversation`), once per active-
  tab change, for conversations that exist server-side.
- **`mountedIds` pruned** on close/rekey so the keep-alive set doesn't accumulate stale
  ids over the deck's lifetime.

---

## Open questions / decisions checklist

- [x] **Persistence keying (was P0a) — RESOLVED:** `persist:true` is a singleton
      localStorage slot N tabs would clobber; the durable backend store is already keyed.
      → folded into §Decision 0 / P1 (the third persistence mode). No longer open.
- [x] **Keep-alive subscription survival (was P0b) — RESOLVED:** `display:none` keeps the
      component mounted (unmount cleanup is `[]`-keyed), so the SSE sub survives; confirmed
      by React semantics. `<Activity>` would NOT (effect teardown). → Decision 3.
- [ ] **reset/send overlap (P1 code-review L1):** `send` awaits the mount-load only
      at entry; a `reset()` racing an in-flight keyed send could strand the turn
      against the abandoned run. Pre-existing in the singleton chat too (not introduced
      by multi-tab); revisit if it surfaces.
- [ ] **Convene/board in tabs (P3 deferral):** a fresh-UUID tab lacks the conversation
      context convene needs (`ownerSubject`, board participants), so TabSession surfaces
      an honest "not available in tabs yet" notice on a leading `@@` instead of sending
      it as prose. Wire real convene when P7 opens existing (board/project) conversations
      into tabs.
- [ ] **Submit-path consolidation (P3→P7):** TabSession's CORE submit path is a
      deliberate near-verbatim mirror of `EmbeddedConversation.onUserSubmit` (a 3rd copy
      after ChatSidebar). Extract the shared CORE subset into one hook when P7 integrates
      ChatSidebar (which interleaves convene/board into the same function today).
- [x] **Strip primitive (P3→P4): DONE.** P4 shipped the full APG tablist (`.tabdeck-*`
      styled to the `.tab` clay-underline idiom): role=tablist/tab/tabpanel wired by a
      stable-sessionId id scheme, roving tabindex (single tab stop), manual activation,
      Delete-to-close with neighbour-focus handoff, drag-reorder (pure `dropIndex` helper),
      hover-revealed pin, horizontal-scroll overflow with a right-edge fade affordance.
- [ ] **Strip polish (P4→P5):** a pinned tab shows both a leading status glyph AND the
      (now-visible) pin toggle — collapse to one clay pin. Add a live drop-indicator
      (before/after insertion bar) during drag — the midpoint logic already exists.
      Keyboard pin shortcut is P7.
- [ ] **Restored-tab title lag (P6→polish):** the descriptor persists only ids/order/
      pinned, so on reload the strip shows "New chat" until the conversation list loads.
      Cache the last-known title per tab in the descriptor to restore real labels at first
      paint. (Hydration loading state + dead-tab prune notice already shipped in P6.)
- [ ] **Off-screen blocked badge (P5 limitation):** when the strip overflows, a blocked/
      unread badge on a scrolled-off tab is invisible. An overflow-edge "▸ waiting"
      summary indicator would close the gap (the strip already tracks `data-overflow`).
      Deferred; bounded ~8-tab working set makes it rare.
- [ ] Default working-set cap (proposed **8**) and whether it is per-tenant
      configurable.
- [ ] Eviction UX: silent-with-toast vs. confirm when evicting a tab with an
      **idle-but-recent** run. (Streaming/pinned are never evicted.)
- [ ] Does opening the **same** conversation in a second tab focus the existing tab
      (dedupe by conversation id — recommended) or allow a duplicate?
- [ ] Mobile: tabs degrade to a single active conversation + the sidebar (no strip);
      confirm the strip is desktop-first.
- [ ] Should a workspace be able to default the surface to tabbed (vs. opt-in per user)?
- [ ] Interaction with ADR 0133 run/task deck — a blocked background tab and a "blocked"
      task-deck card are two views of the same suspended run; keep them consistent, do
      not double-count.

---

## Sources (deep-research, 2026-06-24 — 23/25 claims adversarially confirmed)

W3C ARIA APG *Tabs* pattern + manual/automatic examples (primary); MDN
*Keyboard-navigable JavaScript widgets* (primary, roving tabindex); NN/g *Tabs, Used
Right* (primary); React `<Activity>` reference (primary — effect-teardown on hide);
React keep-alive guide; VS Code editor-layout; Slack open-in-new-window; `tab-rs`
session persistence; Fresh Consulting + designforducks (tabs-vs-sidebar). Two refuted
claims recorded inline (container-tabindex variant; the "2–6 tab" ceiling).
