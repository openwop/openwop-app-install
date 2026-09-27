# ADR 0327 — Conversation-stack decomposition (the god-file program)

Status: Accepted (implemented — Phases 1–3; P3 by correction, see its note)

## Context

The conversation-stack audit (docs/steward/CODEBASE-ASSESSMENT.md 2026-07-09) recorded four
L-effort maintainability gaps and explicitly scheduled them as their own
program: **CS-BE-4** (`handleConversationResolve` — a ~410-line function
braiding validation/idempotency/transcription/authz/routing/dispatch/
streaming/persistence/autotitle inside the 950-line `conversationExchange.ts`),
**CS-FE-3** (`useChatSession.ts`, 1,739 LOC / 32 hooks), **CS-FE-4**
(`ChatSidebar.tsx`, 883 LOC / 33 hooks), and **CS-FE-7** (composer
duplication).

**Corrected finding (this ADR's survey):** the composer WIDGET is already
single-owner — `ChatInput`, composed by `ConversationView` (feed + composer +
interrupt cards), which `EmbeddedChatPanel`/`EmbeddedConversation` reuse per
ADR 0073. The remaining duplication is `ChatSidebar` hand-composing
`MessageFeed`+`ChatInput` in parallel with `ConversationView`'s composition —
so **CS-FE-7 collapses into CS-FE-4** (the sidebar delegating to
`ConversationView` retires both).

These files are the most-exercised surfaces in the app (62 chat FE test files
incl. a 37KB `useChatSession` integration suite; the full exchange/tool-loop/
idempotency/race backend suites). That safety net is what makes a
behavior-preserving decomposition tractable — and why each phase must land as
its OWN PR with the full suites green, not as a batch.

## Decision — the module map

**Invariant for every phase: NO behavior change.** Characterization tests are
added FIRST for any branch the existing suites don't pin (Phase 0 of each PR).
Public exports keep their names/signatures; the old files become thin
composers, never deleted mid-program.

1. **Phase 1 (CS-BE-4)** — `host/conversationExchange.ts` splits into
   `host/exchange/`:
   - `validateTurn.ts` — body/turn/content-parts validation + sanitization
   - `authorizeResolve.ts` — the CS-BE-1 caller-visibility gate + terminal-run
     checks (already a discrete block)
   - `transcribeAudio.ts` — the audio-turn transcription branch
   - `dispatchTurn.ts` — model-target resolution (already ONE resolver via
     ADR 0326/CS-GB-1), tool-loop vs single-completion routing, streaming
   - `persistExchange.ts` — event append + channel mirror + idempotency
     commit/release + autotitle/memory hooks
   `handleConversationResolve` remains the exported orchestrator (~60 lines of
   pipeline). `loadTurns` + the fold cache stay put (fresh, tested, CS-BE-2).

   > **Correction (P1 implementation, 2026-07-10):** two adjustments from the
   > pre-phase architecture review. (1) `loadTurns` did NOT stay put — it moved
   > to `host/exchange/loadTurns.ts` (a leaf), because "staying put" preserved a
   > pre-existing circular import (`conversationExchange ⇄ chatContext`:
   > `composeChatContext` ↔ `loadTurns`); `chatContext` now imports the leaf
   > directly and `conversationExchange` re-exports the same public names. Edges
   > point ONE way (orchestrator → leaves). (2) A sixth/seventh leaf each:
   > `exchange/contentParts.ts` (isContentParts/partHasPayload/asText — three
   > pipeline consumers, so housing them in `validateTurn` would fake a
   > dependency), and the orchestrator is ~490 lines including the verbatim
   > branch comments — the "~60 lines" target was aspiration; the invariant that
   > mattered (no behavior change, one-way edges, ordering visible) held.
   > Characterization bonus: the pass found the interrupts route DROPPING the
   > handler's ADR 0178 `notice` (the BYOK soft-warning never reached the FE) —
   > fixed in the P1 PR with a route-serialization pin
   > (`conversation-exchange-notice.test.ts`).

2. **Phase 2 (CS-FE-3)** — `hooks/useChatSession.ts` splits by concern into
   composed hooks (the reducer + persistence libs already exist as modules):
   - `useTurnTransport` — send/cancel/regenerate + run-SSE subscription
   - `useInterruptResolution` — interrupt cards + resolve plumbing
   - `useTranscriptSync` — voice transcript upsert + newest-refresh
   - `useSessionPersistence` — write-through + backend load + branch/reset
   `useChatSession` keeps its exact return surface (the 37KB integration test
   + multiTab suite are the contract pins).

   > **Correction (P2 implementation, 2026-07-10):** the four-hook map missed a
   > fifth concern — the `@mention` workflow-run machinery (~350 LOC:
   > self-healing run SSE, reopen rehydration, the mount-time stuck/terminal
   > reconcile effect, dispatch/cancel). It became `useWorkflowRunMentions`
   > rather than being folded into `useTurnTransport` (which would have
   > recreated a smaller god-hook). Design notes: a typed internal
   > `ChatSessionCore` (state + ~15 refs + the delta-animation batcher + the
   > localStorage persist effect) is the shared substrate — hooks compose
   > core → persistence → transcriptSync → interrupts → workflowMentions →
   > turnTransport, preserving the original effect-registration order; the
   > `closeWorkflowSub`/`closeAllWorkflowSubs` ref-closures moved into the core
   > (stabilized with useCallback) to break the persistence↔workflow hook
   > cycle; the pre-existing `rehydrateWorkflowRunsRef` indirection carries the
   > load↔workflow edge unchanged. Entry budget 184→185 kB (~0.6 kB of
   > module-boundary overhead, recorded in check-bundle-budget.mjs).

3. **Phase 3 (CS-FE-4 + CS-FE-7)** — `ChatSidebar.tsx` delegates its center
   pane to `ConversationView` (retiring the parallel feed+composer
   composition), keeping only rail/tab/artifact/voice orchestration; target
   ≤300 LOC. `/ux-review` gates the phase (focus order, aria labels, and the
   voice-phase live region must survive the delegation).

   > **Correction (P3 implementation, 2026-07-10): the premise was stale.**
   > Git history disproves the audit's CS-FE-4/FE-7 duplication claim:
   > ChatSidebar has delegated its center pane to `ConversationView` since
   > ADR 0073 Phase 1 (b28d6f34), and the last `MessageFeed` reference left
   > the file in #925 — long before the audit. TabSession delegates likewise.
   > ChatSidebar's 898 LOC are a COMPOSITION ROOT (each concern already lives
   > in an extracted hook — useConversationActions, useComposerModifiers,
   > useChannelRoster, useBoardroomCadence, convene.ts, channelSubmit.ts),
   > so the ≤300 LOC target — derived from removing a feed+composer that
   > doesn't exist — is VOID, and the /ux-review focus/aria/live-region gate
   > premise evaporates with it (no UI structure moves). The one REAL
   > cross-surface duplication the survey found — `channelMessageActions`
   > (reaction/edit/delete, ~40 LOC copy-pasted verbatim between ChatSidebar
   > and TabSession; authz-adjacent, the shared-helper-drift class) — was
   > extracted to `conversations/useChannelMessageActions.ts` per the ADR
   > 0140 parity-hook precedent; both surfaces now compose the one owner.
   > **Re-decomposition trigger (falsifiability):** if a future audit shows
   > the composition root's concerns BRAIDING (e.g. channel state leaking
   > into convene deps such that one can't change without the other), the
   > useChannelSurface/useWorkflowProgressRail split becomes warranted.

## Alternatives weighed

- **Big-bang rewrite** — rejected: the audit's own remediation showed drift
  hides in seams; three reviewable PRs with suite gates beat one unreviewable one.
- **Leave as-is (documented debt)** — rejected: both files absorb changes on
  nearly every chat feature; the per-change comprehension tax is the recurring
  cost the A+ bar names.

## Phase record

| Phase | Landed |
|---|---|
| P0 | This ADR (map + invariants + the FE-7→FE-4 collapse finding) |
| P2-slice (landed 2026-07-10) | Channel SSE frames now drive `refreshNewestMessages` (incremental merge — upgraded to adopt lifecycle meta + reactions) instead of `loadSessionFromBackend`'s full session reset; both consumers (ChatSidebar + TabSession) swapped; the redundant FE paged-channel helper deleted (one thread loader). Survey correction: the channel load path was ALREADY paged via the shared loader — the audit's "full-thread refetch per frame" was the session RESET cost, not a full-thread read. The P2 hook split still owns the rest. |
| P1 (landed 2026-07-10) | `host/exchange/{contentParts,loadTurns,validateTurn,authorizeResolve,transcribeAudio,dispatchTurn,persistExchange}.ts`; orchestrator + re-exports in `conversationExchange.ts` (976→~490 LOC, no behavior change); chatContext cycle broken; ADR 0178 notice-drop route fix + pin; 12 pinning suites green |
| P2 (landed 2026-07-10) | `hooks/chatSession/{lib,core,useSessionPersistence,useTranscriptSync,useInterruptResolution,useWorkflowRunMentions,useTurnTransport}.ts`; `useChatSession.ts` 1,754→~165 LOC composer; 22-field return surface frozen (integration 33 tests + full FE suite 1,281 green); budget 185 kB |
| P3 (landed 2026-07-10) | Resolved by correction (premise stale — delegation existed since ADR 0073 P1/#925) + the real fix: `conversations/useChannelMessageActions.ts` one-owner extraction, both surfaces swapped; full FE suite green, entry 184.5 kB |
