# ADR 0117 — Conversation branching/forking + multi-model compare

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): branch lineage + route. `ConversationMeta.branchedFrom` (+ `toConversation` projection for the FE indicator); `POST …/chat/sessions/:id/branch { fromSeq }` forks the message lineage — a child conversation seeded with the parent's settled prefix, participant-scoped 404, bounds-checked fromSeq (422 past-end / 400 negative). Replay-safe: the child opens its OWN lazy conversation run (ADR 0043), so no run-fork nondeterminism; server-side agent-context `:fork` is a documented refinement. **Phase 2a (client) implemented** (2026-06-24): `branchConversation(sessionId, fromSeq?)` in `chatSessionsClient.ts` calls the Phase-1 branch route + returns the child conversation. The `MessageActions` 'Branch from here' button (threads onBranch through the chat tree) + the compare layout + richer strategies (Phases 2b–4) pending. **Date:** 2026-06-23
**Toggle:** none — *core-chat architecture* (see Scope note); no feature-package, no node/agent pack, no `ctx.<feature>` surface.
**Surface:** host-extension `/v1/host/openwop-app/chat/*` (the ADR 0043/0102 conversation-meta projection) + the **already-normative** `POST /v1/runs/{runId}:fork` wire op. No new wire contract.
**Depends on / composes:** ADR 0043 (persistent conversations — meta + participants + `dmKey`), ADR 0067 (AI chat = the RFC 0005 conversation run; `conversationRunId` reuse), ADR 0102 (chat-history projection + canonical message id + `author_subject`), ADR 0073 (embeddable `ConversationView` — the compare panes), ADR 0006 (RBAC), RFC 0005 (conversation primitive), `POST /v1/runs/{runId}:fork` (run fork).
**RFC verdict:** **host-extension — NO new RFC.** Branch lineage + the compare layout are the non-normative `/v1/host/openwop-app/chat/*` projection; the *fork* itself is the already-Accepted `:fork` wire op (RFC 0005 + rest-endpoints), used as-is. Nothing new lands on the wire. (If a future need wants a normative cross-host "conversation tree / branch pointer" advertisement, that earns an RFC then — not now.)

> **Scope note.** This is a *core-chat architecture* ADR (the ADR 0102 shape), not a feature-package (ADR 0001). Chat lives in core (`frontend/react/src/chat/`, `backend/typescript/src/routes/chatSessions.ts`, `host/conversation*`), so there is **no toggle, no node/agent pack, and no `ctx.<feature>` surface** — those evaluation-matrix rows are **N/A**. The live concerns are **replay/fork safety** (central here), RBAC/authorship, branch-lineage correctness, and a11y.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 (conversation management) + §11 (gap ranking — B7, HIGH). Competitor implementations: LibreChat `client/src/components/Chat/Messages/Fork.tsx` + `api/server/utils/import/fork.js` (four strategies — `DIRECT_PATH` / `INCLUDE_BRANCHES` / `TARGET_LEVEL` / `DEFAULT`) and `client/src/components/Chat/AddMultiConvo.tsx` (side-by-side compare); Open WebUI tree message-history + `Overview/` branch graph; LobeHub `packages/conversation-flow/`. OpenWOP has **neither** branching **nor** compare today.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a message-tree store + a fork engine + a compare runtime." Each already has a single owner; re-implementing any is the `no-parallel-architecture` violation. Critically, **the run already forks** — the gap is a *UI surface + a lineage projection*, not new infra.

| Concern | Existing owner (file:line) | How branching/compare reuses it |
|---|---|---|
| Fork a run from a point | `POST /v1/runs/{runId}:fork` (`backend/typescript/src/routes/runs.ts:816`, the pinned `:fork` route; `rest-endpoints.md POST /v1/runs/{runId}:fork`, `runs.ts:843`) — replays events `[0..fromSeq)` then accepts new ones | A conversation branch **maps a fork point (a turn's wire seq) to a run `:fork`**. The branched conversation's `conversationRunId` is the forked run. **No new fork engine.** |
| Run state stamped verbatim on fork | `host/connectionInjection.ts:138` (broker stamps `run.metadata` "verbatim on `:fork`, never recomputed") | Branch metadata (parent conversationId + fork seq) is host-ext **meta**, not run metadata — the run's own replay/fork stays byte-identical (see Replay/fork). |
| Conversation existence + meta + `dmKey` | ADR 0043 `host/conversationStore.ts` (`ConversationMeta`, participants, read state) | A branch is a **new `ConversationMeta`** (its own `conversationId`/title/participants) with a `branchedFrom` pointer. No new table. |
| The transcript projection | ADR 0102 `chat_messages` (`storage/sqlite/schema.ts` `chat_messages`) + `host/conversationStore.ts` | The branch's history is re-derived from its forked run's events into its own `chat_messages` rows (ADR 0102 `rehydrateWorkflowRuns`/`mergeConversationTurns`). No tree table — lineage is a single parent pointer per conversation. |
| Canonical message id (the fork anchor) | ADR 0102 `conversationMessageId(wireId)` = `${runId}:gate:0:N:role` sanitized (`0102` §2) | The fork point is expressed as the wire turn seq `N` behind that id — the same id used live + stored + on reopen. No new id scheme. |
| Author attribution on branched turns | ADR 0102 `author_subject` (server-stamped; `routes/chatSessions.ts` PUT gate) | Branched turns carry the **original** authorship from the replayed events; new turns stamp the brancher. No new identity model. |
| The two compare panes | ADR 0073 `chat/ConversationView.tsx:66` (`ConversationViewProps`, scopeable, no rails) | Compare mode = **two scoped `ConversationView`s** side-by-side, each driven by its own `useChatSession`/`conversationRunId`. No new chat runtime; no second composer logic. |
| Route namespace | `routes/chatSessions.ts` already owns `/v1/host/openwop-app/chat/sessions/*` | Branch create/list ride sub-paths there — no shadowing. |

**Net new (small):** a `branchedFrom` pointer on `ConversationMeta` (parent conversationId + fork wire-seq + strategy), one `POST …/chat/sessions/:id/branch` route that (a) calls `:fork` on the parent's run at the seq and (b) creates the child `ConversationMeta` bound to the forked run, a "Branch from here" affordance in `MessageActions` (`MessageBubble.tsx:53`), and a two-pane compare layout composing two `ConversationView`s.

---

## Decision

Surface the **already-existing run-fork** as a first-class **conversation branch**, and a **compare** layout that runs two conversations side-by-side. A branch is a new `ConversationMeta` whose `conversationRunId` is a `:fork` of the parent's conversation run at the chosen turn's wire sequence. **The branch tree is a thin parent-pointer projection over forked runs — the run event log stays the authoritative, replay-safe transcript.**

### The central design decision — fork point ↔ run fork (flag LOUDLY; recommend `/architect`)

This ADR's load-bearing decision is that **a branched message-tree MUST preserve run replay**. The fork point is not a UI bookmark over a copied transcript — it is the seq passed to `POST /v1/runs/{runId}:fork`:

1. User clicks "Branch from here" on a settled assistant/user turn whose canonical id encodes wire seq `N`.
2. Host calls `POST /v1/runs/{parentRunId}:fork` with `fromSeq = N` (the `:fork` route at `runs.ts:816`; a `fromSeq` past the head is rejected — `runs.ts:843`).
3. Host creates a child `ConversationMeta { conversationId: new, branchedFrom: { parentConversationId, parentRunId, forkSeq: N, strategy }, conversationRunId: forkedRunId }`, copies the participant set, and titles it ("Branch of …").
4. The child's transcript is **re-derived from the forked run's replayed events** into its own `chat_messages` (ADR 0102), exactly like reopening any conversation — never copied row-by-row from the parent projection (which would drift from the run).

Because the transcript is always re-derived from a real forked run, replay/fork of *either* conversation is unaffected, and the brancher can continue the child independently (new turns are new `conversation.exchanged` events on the forked run). **This fork-point↔run-fork mapping is exactly the wire-shape/replay-safety call that `/architect` (track B) should review before implementation** — get the seq semantics, the gate-run state at the fork point, and the suspended-interrupt handling right (a branch from mid-HITL must fork into a coherent gate state, not an orphaned interrupt).

### Branch strategies (LibreChat parity, projected — not on the wire)

LibreChat's four strategies are a *display/derivation* choice over the lineage, all expressible on the host-ext projection (none touches the wire):

- **`DIRECT_PATH` (default, v1):** the child shows only the linear path to the fork point — the natural result of `:fork {fromSeq:N}` (events `[0..N)`). Recommended default.
- **`TARGET_LEVEL`:** branch a conversation at a sibling round (re-ask the same turn). Same `:fork` op at the prior seq; the new turn is the sibling.
- **`INCLUDE_BRANCHES` / `DEFAULT`:** richer tree views (show sibling branches inline). **Deferred** — these need a multi-child lineage index (OQ-2); v1 ships single-parent linear branches.

### Compare mode (multi-model side-by-side)

Compare = **two scoped `ConversationView`s** (ADR 0073) in a split layout, each its own conversation + `conversationRunId`. The common case is the **same prompt, two models** (ties to ADR 0124's in-chat model switch — each pane's run carries its own `provider`/`model` in `run.inputs`). A synchronized composer (optional, OQ-3) sends the same user turn to both panes; otherwise each pane is independently driven. No new runtime — two existing chats, laid out together.

### Data model — one pointer, no tree table

```ts
// Additive to ADR 0043 ConversationMeta (host-ext, NOT a new table):
interface ConversationMeta {
  // …existing (conversationId, type, title, ownerUserId, participants, conversationRunId)…
  branchedFrom?: {
    parentConversationId: string;
    parentRunId: string;        // the run we :fork'd
    forkSeq: number;            // the wire sequence the fork anchored on
    strategy: 'direct' | 'target-level';   // v1 strategies (display derivation)
    branchedAt: string;
  };
}
```

Lineage is a **single parent pointer per conversation** (a forest of linear branches), not a materialized tree — the child's content lives in its forked run's events, re-derived on open. Listing "branches of X" is a cheap `branchedFrom.parentConversationId === X` filter.

### RBAC & isolation (fail-closed)

Branching a conversation requires the **same visibility + manage posture ADR 0043 Phase 6 + ADR 0102 already enforce**: the brancher must be owner-or-participant of the parent (else uniform **404**, no existence leak — `routes/chatSessions.ts` participant-scoped gate), and the underlying `:fork` is authorized against the parent **run** (RFC 0005 run authz) — a member who cannot read the parent run cannot branch it. The child conversation is **owned by the brancher** (a fresh `ownerUserId`), with the parent's participant set copied; branched turns keep their original `author_subject` (ADR 0102), new turns stamp the brancher. Compare panes inherit each conversation's own gate independently. No cross-tenant fork (the `:fork` route is tenant-scoped).

### Replay / fork safety (the central invariant)

- The **run event log stays authoritative and untouched.** A branch is a *real* `:fork` of the conversation run, so each branch IS a replay-safe run — `:fork`-ing the branch again, or replaying it, reads its own events verbatim (`connectionInjection.ts:138` — run metadata stamped verbatim, never recomputed).
- **No transcript copy:** the child's `chat_messages` are re-derived from the forked run's events (ADR 0102 live-rebuild), never duplicated from the parent projection — so the projection can never diverge from the run.
- **Nothing new is stamped on a run by this ADR.** `branchedFrom` is host-ext display/continuity meta (like `conversationRunId` in ADR 0102), not run state — a `:fork` of either conversation re-derives the thread from its own run.
- **Mid-HITL fork** is the sharp edge: forking at a seq inside a suspended gate must land a coherent interrupt state in the child run (or refuse). v1 restricts the fork anchor to **settled turns** (post-terminal of that exchange); mid-interrupt branching is OQ-4 and an `/architect` review item.

---

## Evaluation matrix

| # | Dimension | Verdict |
|---|---|---|
| 1 | Feature-package architecture | **N/A** — core-chat (ADR 0102 scope note); extends `chat/` + `routes/chatSessions.ts` + `host/conversation*`, no `features/<x>` package. |
| 2 | Toggle / admin UI / `bucketUnit` | **N/A** — core chat, always-on, no toggle. |
| 3 | Workflow node pack | **N/A** — no node pack; reuses the existing `:fork` run op + chat.turn/conversation run. |
| 4 | Agent pack / persona | **N/A** — not agent-scoped; any conversation can branch. |
| 5 | AI-chat envelope / `ctx.<feature>` | **N/A** — no new envelope; rides RFC 0005 conversation turns. |
| 6 | RBAC | **Yes** — owner-or-participant on the parent (uniform 404) + run-fork authz; child owned by brancher; fail-closed. |
| 7 | Replay / fork | **Central** — branch = real `:fork`; run log authoritative; transcript re-derived, never copied; nothing new stamped on a run. |
| 8 | RFC gate | **host-ext, NO new RFC** — lineage + compare are the non-normative chat projection; `:fork` is an already-Accepted wire op used as-is. |
| 9 | a11y | **Yes** — "Branch from here" is a labeled `MessageActions` button (`aria-label`); compare panes are two `region`s with distinct accessible names; branch lineage announced (parent title), never color-alone. |
| 10 | Tests | Branch route (404 non-participant; fork at seq; child bound to forked run), re-derive parity (child transcript == forked-run replay), authorship preservation, compare two-pane independent sessions, mid-HITL refusal. |

---

## Phased plan

1. **Branch lineage + route (backend).** Add `branchedFrom` to `ConversationMeta` (`host/conversationStore.ts`); `POST …/chat/sessions/:id/branch { fromSeq, strategy }` → `:fork` the parent run + create the child meta bound to the forked run; participant-scoped 404 + run-fork authz; restrict anchor to settled turns. Route + storage tests.
2. **"Branch from here" affordance (frontend).** A labeled action in `MessageActions` (`MessageBubble.tsx:53`) on settled turns → calls the branch route → navigates to the child conversation (open-or-resume, ADR 0043). Branch-of indicator in the conversation header.
3. **Compare layout (frontend).** A split surface composing **two `ConversationView`s** (ADR 0073), each its own conversation/`conversationRunId`; an optional synchronized composer (OQ-3) sends one prompt to both. Reuses the BYOK gate per pane.
4. **(Deferred) Richer strategies + tree view.** `INCLUDE_BRANCHES`/`DEFAULT` sibling-branch views (the LibreChat full set) on a multi-child lineage index + an Open-WebUI-style branch graph. OQ-2.

## Alternatives weighed

1. **A bespoke message-tree store + a copy-on-branch transcript.** Rejected — it shadows the run (`no-parallel-architecture`) and the copied transcript would drift from the run event log (replay would disagree with the displayed branch). The whole point is that a branch is a real run fork.
2. **In-conversation branching (variant siblings on one run, the RFC 0005 §195 path).** ADR 0102 already records RFC 0005 §195 *rejected* in-conversation branching; true variant-compare is the **sibling-conversation** mechanism — which is exactly this ADR (a forked run = a sibling conversation), not a new layer.
3. **Compare as one split run.** Rejected — two independent runs (one per model) is the honest model: each carries its own `provider`/`model` in `run.inputs` and forks/replays independently. A single shared run can't carry two model identities replay-safely.

## Open questions

1. **OQ-1 — Fork anchor granularity.** Branch only at assistant turns, or any turn (incl. the user prompt that produced it)? Propose: any *settled* turn; the fork seq is the turn's wire seq.
2. **OQ-2 — Multi-child lineage + tree view.** v1 is single-parent linear branches. A full `INCLUDE_BRANCHES` tree + Open-WebUI graph needs a child-index (`parentConversationId` is already filterable, but a graph wants ordering). Deferred.
3. **OQ-3 — Synchronized compare composer.** Send one prompt to both panes (a "broadcast" composer) vs each pane independent. Propose: independent by default, an opt-in sync toggle.
4. **OQ-4 — Mid-HITL fork.** Forking at a seq inside a suspended gate. v1 refuses (settled turns only); `/architect` review for the coherent-interrupt-state semantics before lifting the restriction.
5. **OQ-5 — Title/dedup.** A branch is never a `dmKey` 1:1 (it's a distinct conversation) — confirm branches are excluded from `dmKey` canonicalization so "open chat with agent X" never resolves to a branch.

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** The branch-lineage pointer (`branchedFrom`) + the compare layout are the non-normative `/v1/host/openwop-app/chat/*` projection (ADR 0043/0102). The fork itself is the **already-Accepted** `POST /v1/runs/{runId}:fork` wire op (RFC 0005 + rest-endpoints), consumed as-is — no new event field, endpoint contract, or capability claim. A new RFC is warranted only if a *normative cross-host* conversation-tree / branch-pointer advertisement is later required — the design deliberately avoids it.

> **Phase 2c (branch affordance) implemented** (2026-06-24): a "Branch" action in `ChatHeader` (beside New chat) → `branchConversation(session.id)` (fork-from-end; the per-message fromSeq mapping is a later phase) → `sessionsCollection.refresh()` → `selectConversation(child)`. Extends the ONE chat (no new panel/router path); reuses the Phase-2a client + the existing navigation. Unblocked by PR #804's entry-budget reclaim. i18n×4; aria-labelled. /architect GO, /code-review + /ux-review clean. The compare layout (Phase 3) pending.

> **Phase 3 (compare layout) implemented** (2026-06-24):** `CompareView` — a lazy, READ-ONLY side-by-side of two conversations (a Compare button in ChatHeader beside Branch → modal: left = the current conversation, right = a picker of the caller's OTHER sessions). It FETCHES each transcript (`listChatSessionMessages`) and renders two columns — it does NOT spin up two live sessions (the run event log stays authoritative; no second chat runtime), matching the ADR's read-only-projection intent. Lazy-split (its own ~1 kB chunk; entry 162.4 kB). Inline structural styles use design-token color refs (no raw hex). /architect (inline — composes the Phase-1 lineage + the ADR 0073 read-only transcript; no new runtime), /code-review + /ux-review clean (select + button aria-labelled; i18n×4). 2 tests (left pane + picker-excludes-current; right pane loads on pick). ADR 0117 is now functional (branch + compare). Richer fork strategies (Phase 4) remain.

> **Phase 4 (branch-from-here) implemented** (2026-06-24):** a per-message **Branch** action in `MessageActions` forks a new conversation seeded THROUGH that turn — `branchConversation(session.id, fromSeq=i+1)` (the Phase-1 route bounds-checks fromSeq) → `selectConversation` (the existing flow, no new router path). Threaded ChatSidebar → ConversationView → MessageFeed → MessageBubble → MessageActions (mirrors the `onRegenerate` seam). Offered ONLY on a fully-loaded conversation (`!hasOlderMessages`), so a settled turn's render index equals its server seq (the `normalizeWorkflowMentions` transform is same-length; client-only-message drift is a documented edge, bounds-checked). Passed as a STABLE callback + a `branchSeq` number (NOT a per-item closure) so MessageBubble's memo isn't defeated during streaming. /architect (inline — composes the Phase-1 branch route + the existing thread; no new runtime), /code-review + /ux-review clean (button aria-labelled + titled, i18n×4, memo-safe, entry 163.1 kB). 2 client tests (fromSeq threaded / omitted) + 53/53 chat regression. ADR 0117 is now substantially complete (branch-from-end + branch-from-here + compare).


## § Follow-on — Counterfactual Replay (innovation strategy, 2026-06-24)

The innovation strategy proposes "what-if" replay: fork a run with **mutations**
(replace model, disable a tool, change input, freeze retrieval, mock a tool output) and
show a **diff** across decisions / tool calls / artifacts / cost / final output. This
**extends THIS ADR** (branch + multi-model compare): add a replay-mutation layer on the
existing `:fork` op + a deterministic tool-result cache (read-only / mocked replay so
external side effects don't re-fire) + a decision-timeline diff over the recorded event
log. Same fork/replay invariants; host-extension, no new RFC.
