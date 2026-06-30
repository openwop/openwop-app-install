# Chat parity: standalone `ChatSidebar` ↔ multi-tab `TabChatDeck`

**Purpose.** The chat surface has two implementations behind the `multi-tab-chat`
toggle (`chat/ChatTab.tsx:94` — on → `TabChatDeck`, off → `ChatSidebar`). This
doc tracks the **feature delta** between them so the standalone is not deleted
while the deck is missing affordances users rely on. It is the **gate** on
retiring `ChatSidebar`.

**Headline:** this is **not** "a ton of lost work." ADR 0140 was a deliberate
parity pass that **extracted** the standalone's logic into shared modules both
surfaces import — `useConversationActions` (branch/compare/export/import/share),
`useComposerModifiers` (web/tools/model), `ConversationLineup`, `convene.ts`
(boards/projects), `runCoreSubmit`. Deleting `ChatSidebar` would not delete those.
But two UX affordances were **down-scoped** in the deck; they are tracked below.

## Feature delta

| Feature | Standalone (`ChatSidebar`) | Multi-tab deck (`TabChatDeck`/`TabSession`) | Status |
| --- | --- | --- | --- |
| Active-agents tracking ("In this conversation") | Persistent left-rail panel, **always shown** incl. lone default assistant (`ConversationsRail.tsx:179`) | `ConversationLineup` strip above the feed, **gated** (was `lineup.length > 1`) | **Reduced → being restored** (see R1) |
| Conversation list + full-text search | Persistent left-rail `conversations` tab (`LeftRail.tsx:77`) | Tabs (open conversations) + a searchable **modal** picker (`TabLibraryPicker`); rail omits the panel | **Moved — intentional** (see D1) |
| Branch / compare / export / import / share | `useConversationActions` | same hook, per-tab ⋯ menu (now in composer toolbar) | Parity |
| Composer modifiers (web · tools · capability scope · model) | `useComposerModifiers` | same hook | Parity |
| Convene / Boards of Advisors (`@@`) | `convene.ts` interceptors + `useBoardroomCadence` | same, per-tab | Parity |
| @-mention agents → activate + persist as participant | `useActiveAgents` + `addParticipant` | same, per-tab (`onAddParticipant`) | Parity |
| `?agent=` deep-link (open scoped to an agent) | `useScopeToAgent` | deck opens a NEW tab scoped (G3) | Parity (deck adds tabs) |
| Workflow progress + HITL interrupts + Reviews | left-rail Progress + Reviews tabs | shared deck rail (Progress + Reviews), binds to active tab | Parity |
| Human group chat (Projects / Channels) | conversation **types** (ADR 0054 / 0126) — open from the rail list | same types open as **tabs** via `?conversation=` | No delta (separate features; not a composer feature in either) |
| Voice (live + audio clip), feedback, regenerate, citations, costs | ✓ | ✓ (shared `ConversationView`) | Parity |
| Keep-alive multi-conversation, tab strip, pop-out, shortcuts | n/a (single active) | deck-only additions | Deck superset |

## The two genuine differences

### R1 — Active-agents visibility (REDUCED → restoring)
The standalone always showed the participants lineup in the rail; the deck gated
the per-tab strip on `lineup.length > 1`, so a single-agent chat showed **no**
active-agent indicator. **Restored** by showing the strip once a chat has
substance or a team: `hasTurns || lineup.length > 1` (`TabSession.tsx`). A fresh
empty tab stays clean; any conversation with turns shows who you're talking to.

> Fuller option (not done here): lift the active tab's lineup into the **deck
> rail** as a persistent "In conversation" panel, matching the standalone's rail
> placement exactly. Deferred — the per-tab strip restores the visibility with far
> less plumbing (the deck rail is shared + binds to the active tab; the lineup is
> per-`TabSession`). Revisit if users want it persistent in the rail.

### D1 — Conversation list in the rail (MOVED — accepted design)
The deck **intentionally** replaces the persistent conversation-list rail with
**tabs** (open conversations) + a searchable **modal** picker — that is the point
of the multi-tab deck (ADR 0140). This is an accepted IA change, **not** a
regression: every conversation the standalone listed is reachable as a tab or
through the picker, and the *participants* half of the old rail panel is restored
by R1. Reopen only if telemetry shows users want an always-visible list.

## Pre-deletion gate (do NOT delete `ChatSidebar` until all checked)

- [x] R1 — active-agents visibility restored in the deck.
- [x] D1 — conversation-list-rail decision recorded (tabs + modal is intended).
- [ ] `multi-tab-chat` graduates to **on by default** (currently off) + a
      deprecation window.
- [ ] Confirm Projects (ADR 0054) and Channels (ADR 0126) group conversations
      open cleanly as deck tabs (same `?conversation=` path).
- [ ] No open ADR-0140 question blocks (task-deck double-count, mobile strip).

Until every box is checked, `ChatSidebar` stays as the toggle-off fallback (ADR
0140's "reversibility guarantee" — byte-for-byte unchanged with the toggle off).

_Last updated 2026-06-27._
