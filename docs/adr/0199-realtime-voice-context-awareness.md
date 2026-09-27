# ADR 0199 — Realtime-voice context awareness (finish RT-2's persona half)

Status: implemented (Phases 1–3, 2026-07-03)

## Phase → commit table

| Phase | What shipped |
|---|---|
| 1 | `host/chatContext.ts` extraction (behavior-identical; 133 conversation tests) + realtime instructions = scaffold + spoken addendum + visibility-gated transcript digest; FE threads conversationId (Gemini path); RT-2 placeholder retired; 26 route tests incl. the mock-echo persona assertions |
| 2 | `voicePreamble.ts` — capability-gated/budgeted memory digest + work snapshot (portfolio names / schedules / open-card count), all fail-soft; 24k instructions ceiling shedding transcript first |
| 3 | `VoiceAgentPicker` (unscoped mic asks; remembered per conversation; explicit workspace-assistant option) + the `voiceConversationId` threading fix across ChatSidebar/TabSession |

## Corrections (implementation vs the proposal)

- **Security finding (self-review, Phase 1):** composing another user's conversation into the
  model's instructions was an exfiltration path ("what was said earlier?") — the realtime
  composition now enforces the canonical `isVisibleToAsync` read gate; an invisible conversation
  composes as if unscoped. Pinned by two route tests (owned-invisible vs ownerless-legacy).
- **Phase 2 snapshot fields:** `ScheduledJob` carries `cronExpr`/`workflowId` (no label/next-fire
  fields), so schedule lines render `workflowId (cronExpr)`; board count keys off `KanbanBoard.id`.
- **Phase 3 found a Phase 1 gap:** `ConversationView` never passed the chat sessionId to the voice
  controller — `voiceConversationId` now threads from both primary surfaces; without it the
  transcript digest could never fire outside embeds.
- **OQ-1/2 stand deferred** (OpenAI item-seeding; mid-session refresh). **OQ-3 resolved:**
  session-only scoping (the picker does not rewrite the conversation's agent scope).

**Date:** 2026-07-03
**Toggle:** rides the existing `voice` toggle (ADR 0138/0141) — no new toggle; this makes an
already-shipped surface honest, it does not add a new one.
**Surface:** host-extension only (`/v1/host/openwop-app/voice/realtime/*` session composition +
one frontend picker). **No wire change, no RFC** — instructions/session payloads are provider
egress, not the OpenWOP wire.
**Composes (all implemented):** the ADR 0141 realtime session mint + tool bridge (allowlist ∩
builtins, firewall-gated `executeRealtimeToolCall`); the conversation exchange's prompt assembly
(`host/conversationExchange.ts` + `host/agentPromptScaffold.ts`); the agent registry
(`executor/agentRegistry.ts` — pack/user-authored/roster personas normalize there); conversation
meta (`injectedContextBlock`, `ownerSubject`); owner-subject KB grounding
(`composeKnowledgeForSubject`, topK 6, IDOR-gated); the ADR 0148 budgets (`transcriptBudgetConfig`,
`memoryBudgetConfig`); the agent-knowledge composition (`resolveAgentKnowledgeRetrieve` /
`composeAgentKnowledgeContext`, capability-gated); the roster/profile services backing the agent
work panels; `RealtimeVoiceOnboarding` (the FE first-run modal seam).

---

## Context

ADR 0141 shipped realtime speech-to-speech with the security topology done right (host-side keys,
sideband tool mediation, firewall parity with typed chat) — but **RT-2's persona half never
landed**. The placeholder admits it in its own text
(`features/voice/realtime/routes.ts:28-30`): *"…(RT-2 wires the agent persona + tools.)"*. Both
provider egress points send that hardcoded generic string (`routes.ts:67` → Gemini's token-locked
`systemInstruction`; `:112` → OpenAI's server-side session payload).

Two facts compound into the reported experience ("the voice agent has no context, no awareness of
workflows or agents"):

1. **Awareness in this app is tool-mediated, not prompt-injected** — even text chat injects no
   workspace summary; models learn the workspace by calling tools.
2. **The realtime tool surface = the scoped agent's allowlist, and no agent ⇒ empty allowlist ⇒
   default-deny** (`toolBridge.ts:20-24`).

So an **unscoped** voice session (the default `/` chat) has a generic prompt AND zero tools —
no persona, no memories, and no way to even look. `agentId` already selects the session's voice
and tools; it must also select the brain. The walkie path (ADR 0138) proves the target shape: it
routes through the real conversation exchange and is therefore fully context-aware
(`voiceTurns.ts:5-11` — "the existing chat generates the agent's reply TEXT … no second chat").

## Boundaries audit

- **Single owner of chat context assembly:** `handleConversationResolve`
  (`conversationExchange.ts:502`), with the system-prompt composition **inlined** at `:617-668`
  (registry persona + authored systemPrompt + user name + `injectedContextBlock` + owner-subject
  KB + budgeted transcript). There is no extractable `composeChatContext` today — this ADR
  extracts it; both the text exchange and the realtime routes then call ONE function.
  **Anti-goal:** a voice-only prompt builder (a second owner that drifts).
- **Persona source of truth:** the agent registry (`agentRegistry.resolve`); pack agents,
  user-authored agents, and roster agents all normalize into it. `agentProfile` carries
  capabilities/permissions/knowledge bindings, not prompt prose.
- **Agent memories:** the text CHAT prompt injects none (tool-mediated); the agent-DISPATCH path
  injects a digest (`agentDispatch.ts:460-552`). Voice legitimately differs from text — mid-speech
  tool round-trips are clumsy — so Phase 2 adds a **preamble digest** using the existing,
  capability-gated, char-budgeted composition primitives. No new store, no new retrieval path.
- **Workspace/work snapshot:** no app-context builder exists anywhere; Phase 2's work snapshot
  composes the same services the agent detail panels already read (workflow portfolio, schedules,
  board tasks) into a compact digest — read-only, per-agent, tenant-scoped.
- **Gemini token-locked setup is the friend, not the obstacle:** `geminiLive.ts:39-45` — the
  client's `setup` is IGNORED; whatever the HOST puts in the token is the persona the model gets,
  unspoofable. Same for the OpenAI sideband session payload ("kept off the browser").
- **Capability honesty:** no discovery/capability change; nothing new advertised.

## Decision

**Give the realtime session the same brain as a typed turn, via one extracted owner; scope every
session to an agent; make the unscoped mic ask.**

1. **`composeChatContext` extraction (Phase 1).** Factor `conversationExchange.ts:617-668` into
   `host/chatContext.ts` → `composeChatContext(tenantId, {agentId?, conversationId?, callerUserId?, seedText?})`
   returning `{ systemPrompt, agent }`. `handleConversationResolve` calls it (behavior-identical);
   the realtime `/session` and `/openai/connect` handlers call it and append:
   - the **spoken-mode addendum** (the useful half of today's placeholder: brief, conversational,
     one idea at a time, confirm before acting), and
   - the **budgeted transcript window** of the current conversation (same
     `transcriptBudgetConfig()` gates), so a session opened mid-conversation knows what was said.
2. **Voice preamble digest (Phase 2).** For the scoped agent, append (each independently
   fail-soft, each budgeted):
   - **memories/knowledge** via `resolveAgentKnowledgeRetrieve` + `composeAgentKnowledgeContext`
     (existing capability gate + `memoryBudgetConfig().maxChars` cap), seeded from the recent
     transcript (or the agent's role when none);
   - **work snapshot** via a new small read-only `composeAgentWorkSnapshot(tenantId, agentId)` in
     the voice feature: assigned workflows (names), next few schedules (label + next fire), open
     board-task count — composing the services the agent panels already use.
3. **Agent-scoped sessions as the norm (Phase 3).** The FE already threads `agentId` end-to-end
   when the conversation is agent-scoped. When the mic is pressed in an **unscoped** chat, show a
   **lightweight agent picker** (roster list, in the `RealtimeVoiceOnboarding` modal seam;
   remembered per conversation) instead of starting a blind session. A tenant with zero agents
   falls back to the generic persona — now explicitly labeled as the workspace assistant rather
   than silently contextless.

## Phased plan

- **Phase 1 (M):** extract + wire + spoken addendum + transcript window. Route-level test: open a
  mocked session for an agent with an authored persona and assert the minted instructions carry
  it (and the transcript line), not `DEFAULT_INSTRUCTIONS`.
- **Phase 2 (S/M):** preamble digest (memories + work snapshot), budgeted + fail-soft; unit tests
  for the snapshot composer; instructions-size guard (hard cap with truncation notice).
- **Phase 3 (M):** the unscoped-mic agent picker + per-conversation persistence; i18n ×4;
  ux-review pass.
- **Phase 4 (S):** docs lockstep (this ADR → implemented with phase table; ROADMAP row; UX tracker
  CT item for a live voice-context check).

## Alternatives weighed

- **Route realtime through the conversation exchange per turn (like walkie).** Rejected: realtime
  is speech-to-speech — the provider model IS the responder; there is no per-turn host text hop to
  inject context into. Session-mint composition is the correct (and only) injection point.
- **A voice-only prompt builder.** Rejected: second owner of "what does an agent know" — the exact
  drift the boundaries audit forbids.
- **Prompt-inject a full workspace inventory (all workflows/agents).** Rejected: unbounded,
  stale-prone, and against the app's tool-mediated-awareness design; the agent's OWN portfolio
  digest + its tools cover the honest need.

## Open questions

- **OQ-1:** Seed prior-turn context via OpenAI `conversation.item.create` on the sideband (true
  history items) instead of instructions text? Deferred — instructions-text works for both
  providers; item seeding is an OpenAI-only refinement.
  > **Resolution (2026-07-03, PR #1176):** IMPLEMENTED for OpenAI — `composeTranscriptTurns`
  > (chatContext) + `seedConversationItems` (openaiSideband) inject the windowed transcript as
  > message items after `session.update`, no `response.create`; the instructions block drops the
  > transcript on that provider (`transcriptMode: 'items'`). Gemini keeps the digest.
- **OQ-2:** Mid-session context refresh (e.g. after a tool call changes state) — out of scope;
  the tool result itself returns to the model.
  > **Reassessed (2026-07-03, post-OQ-1):** the MECHANICAL seam now exists — the sideband holds a
  > live WS for the session's lifetime and can send `session.update` / `conversation.item.create`
  > mid-session (OQ-1 proved the injection path). What is still missing is a TRIGGER worth wiring:
  > tool results already return to the model inline, so no current event leaves the model stale.
  > Stays deferred until a real push-source exists (e.g. an external state change the host learns
  > about mid-call); when one does, the implementation is a small composition of the OQ-1 helpers.
- **OQ-3:** Should the picker WRITE the conversation's agent scope (making the whole thread
  agent-scoped) or only scope the voice session? Proposed: session-only in P3, with the picker
  offering "switch this conversation to <agent>" as the follow-up affordance later.
