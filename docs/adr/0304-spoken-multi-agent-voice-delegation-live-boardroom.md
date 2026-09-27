# ADR 0304 — Spoken multi-agent conversations: voice delegation + the live boardroom

Status: Accepted (2026-07-06)

## Context

Live voice today is **single-agent by construction**, on both paths:

- The **realtime S2S** path (ADR 0141/0147/0199) binds one `agentId` at mint
  (`voice/realtime/routes.ts` → `composeRealtimeInstructions`), speaks one
  provider voice, and has no notion of another agent entering the call.
- The **walkie** path (ADR 0138, `chat/voice/useVoiceMode.ts`) voices only the
  reply the *user's own* committed turn awaited (`awaitingReplyRef`); any other
  assistant turn that lands in the conversation is silent.

Meanwhile the **board of advisors** (ADR 0040/0043/0054/0277/0278) already
produces exactly the multi-agent turn stream a spoken boardroom needs: a
`@@<board>` summon routes the user's turn to the chair, and the FE cadence
(`chat/conversations/useBoardroomCadence.ts`, a self-clocking queue on the
`isSending` falling edge) dispatches one ordinary chat `send()` per advisor in
`planBoardroomTurns` order, each turn **attributed** (`message.agentId` →
avatar/name in `MessageBubble`). Those turns are real runs grounded in each
advisor's own knowledge (ADR 0038) — and today they are never voiced.

Two further facts shape the design (verified in source):

1. **Per-agent voice already exists.** `agentProfile.configParameters.voice =
   { provider, voiceId, credentialRef }` (ADR 0031 seam), resolved by
   `resolveAgentVoice()` (`features/voice/voiceSession.ts:97`) and treated as
   authoritative in `/speak` (W6). No new voice store is needed — only
   per-*turn* resolution.
2. **The OpenAI sideband can re-instruct and re-voice a live session.**
   `openaiSideband.ts` owns a long-lived host-side WS and already builds
   `session.update` frames (instructions + tools + voice). **Gemini Live
   cannot**: the RT-7 token-locked constrained setup (`buildGeminiConstraint`,
   empty `fieldMask`) fixes config at token mint — no mid-session persona/voice
   swap without a new session.

### What the user asked for

1. When the active voice agent (e.g. Iris) verbally delegates to another roster
   agent mid-call, that agent answers **in the same live session, in its own
   voice**, and both turns persist attributed in the one transcript.
2. When a board conversation and live voice are both active, the board speaks —
   chair framing, each advisor, synthesis — each in its own voice; and the board
   is a **first-class target** wherever the user picks who to talk to.

## Decision

Five decisions. The through-line: **voice is a delivery channel over the
existing conversation machinery — never a second generator.** (The
no-parallel-architecture law: the boardroom stays the FE cadence over real chat
runs; delegation stays a real roster agent resolved through `agentIdentity` +
`composeChatContext`.)

### D1 — Spoken delegation is a host-side session-control tool, OpenAI-realtime only

A new **host builtin realtime tool** `voice.delegate_to_agent(agentId,
question)` is declared at session mint **in addition to** the agent's
allowlisted tools, only when: provider is `openai-realtime`, the session is
agent-scoped, and the tenant roster has at least one other enabled agent. The
tool is *session control*, not an agent capability — it is executed entirely in
the host sideband and never dispatched through `executeTool`:

1. Resolve the target via `resolveAgentIdentity` (tenant-scoped; reject
   unknown/disabled/self → the model gets a structured error output, not a
   silent failure). The tool's parameter schema enumerates the roster (id +
   name) so the model calls by id, not by fuzzy name.
2. Compose the target's instructions with the **same**
   `composeRealtimeInstructions` (persona + `composeChatContext` + degraded
   honesty) — the target is a real agent with its own context, not a costume.
3. `session.update` → target's instructions, **target's voice**
   (`resolveAgentVoice`), and target's **own tool projection**
   (`resolveAgentToolDecls`) *plus* a `voice.return_to_agent()` control tool;
   re-bind the session registry entry to the target's `agentProfileId` so the
   ADR 0142 boundary (allowlist default-deny → Capability Firewall → executor)
   now enforces the **target's** allowlist. The delegator's allowlist is
   *removed* for the duration — no privilege union.
4. `response.create` with the delegated question as the trailing user item.
5. **Return semantics — one-shot with explicit return:** after the target's
   `response.done`, the sideband automatically `session.update`s back to the
   delegating agent (instructions/voice/tools restored) with a conversation
   item summarizing that the delegate answered. `voice.return_to_agent` lets
   the *target* hand back early. Nested delegation is refused in v1 (the
   delegate tool is not declared while delegated).

**Gemini Live: the tool is not declared.** The token-locked setup cannot
re-voice or re-instruct, and its browser-relayed tool bridge is the
lower-assurance path (ADR 0142) — declaring a session-control tool there would
be a dishonest capability claim. Delegation degrades honestly to "not
available on this provider".

*Alternative rejected:* a second concurrent realtime session per delegate —
double token cost, overlapping audio, and two live mics' worth of governance
surface for a one-question handoff.

### D2 — A board is a first-class voice target, voiced via the walkie/TTS loop — not realtime S2S

`VoiceAgentPicker` (ADR 0199 P3) gains a **Boards** section (`listBoards()`),
and its pick contract widens from `rosterId | null` to a discriminated target:

```ts
type VoiceTarget =
  | { kind: 'agent'; rosterId: string }
  | { kind: 'generic' }                 // today's null
  | { kind: 'board'; boardId: string }
```

Picking a board starts **board voice mode**, which runs on the walkie loop
*even when a realtime provider is configured* (`LiveVoiceController` routes by
target kind):

- The summon rides the existing convene path: the controller submits the
  user's committed transcript through the normal chat submit so
  `buildBoardInterceptor` does what it does for text — canonical board
  conversation / `attachBoard` / cadence start / route-to-chair. Voice adds
  **zero** new orchestration.
- Every settled, **attributed** assistant turn the cadence produces is then
  spoken in that agent's own voice (D3).

Why not realtime S2S for boards: the advisor replies are generated by the chat
runs (each grounded in its own knowledge — ADR 0038/0040); a realtime model is
a *generator*, and using one to read other agents' turns aloud would either
re-derive replies (parallel architecture) or misuse the S2S session as a TTS
engine at realtime-token prices. And Gemini could not re-voice per speaker at
all. TTS-per-turn of the real turns is honest, provider-neutral, and
per-advisor-voiced.

### D3 — Board voice mode voices every new attributed assistant turn, sequentially (the auto-voice rule)

`useVoiceMode` gains a **multi-speaker mode** (activated by a board target):
instead of gating on `awaitingReplyRef`/`lastAssistantText`, it observes the
message list and enqueues every **new settled assistant turn** into a strictly
sequential playback queue (one floor — cadence order is the SSoT; the queue
never reorders). Per-turn voice resolution:

- `POST /voice/session/:id/speak` gains an optional **`agentId`** (the
  per-turn speaker). When present, the host resolves **that** agent's voice
  via `resolveAgentVoice` (tenant-scoped, same as today) and the speaker
  agent's configured voice is authoritative per the existing W6 rule. Absent →
  today's behavior (session agent / client hint / host default). Host-ext
  surface only — no wire change.

Controls (composer, board voice mode only):
- **Skip** — stop the current turn's audio, advance the queue (the turn stays
  in the transcript, marked nothing — audio is ephemeral).
- **Mute voices** — per-session toggle: the loop keeps transcribing/committing
  but stops speaking (drops back to text delivery without ending the session).
- **Barge-in** — a tap while speaking stops playback and opens the mic (the
  existing walkie barge-in); the committed turn routes to the chair as a
  normal board turn. Unplayed queued turns resume after the user's turn
  settles. The cadence's own halt/continue semantics are unchanged.

The lineup strip (`ConversationLineup`) reuses its thinking-pulse affordance
for a **speaking** state so the user sees who holds the floor.

### D4 — Voice turns carry the speaker's agent identity

Today realtime voice turns persist **role-only** (`meta.source:
'voice-realtime'`). For multi-agent audio the transcript must say who spoke:

- OpenAI sideband `persistTranscript` stamps the assistant turn with the
  session's **currently bound** agent id (delegator or delegate — D1 rebinding
  makes this correct by construction).
- The Gemini path stamps its single session agent id via the existing
  `upsertTranscriptTurn` meta (parity).
- Board voice mode needs nothing: cadence turns are ordinary attributed chat
  turns already.

### D5 — Toggles, RBAC, and the RFC gate

- **No new feature toggle.** Board voice composes the existing `voice` +
  `advisory-board` toggles (both must be enabled; the picker shows Boards only
  when `advisory-board` is on and boards are visible to the caller — the
  existing `listBoards` RBAC). Delegation rides `voice`.
- `/speak agentId` resolves tenant-scoped only (it selects a voiceId +
  BYOK credentialRef already constrained to the caller's tenant); it grants no
  tool or context access.
- **No RFC.** Everything here is host-extension surface
  (`/v1/host/openwop-app/voice/*`, host builtin tool, SPA). The canonical
  `voice.*` run-event vocabulary (RFC 0118 / ADR 0109) is unchanged; no new
  capability is advertised on the wire.

## Implementation plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** | `/speak` per-turn `agentId` (backend): resolve speaker voice, W6 authority per speaker; vitest for resolution + authority + tenant scoping. | backend vitest |
| **P2** | Board voice mode (frontend): `VoiceTarget` union, `VoiceAgentPicker` Boards section, `LiveVoiceController` routing (board → walkie loop always), `useVoiceMode` multi-speaker queue + skip/mute + barge-in-resume, lineup speaking state, i18n ×4 locales. | frontend `npm run build` + vitest unit tests on the queue reducer |
| **P3** | OpenAI delegation (backend): `voice.delegate_to_agent` + `voice.return_to_agent` builtins in the sideband, `session.update` swap + registry re-bind + allowlist swap, one-shot return on `response.done`, D4 attribution stamp; vitest on the swap/return state machine. | backend vitest |
| **P4** | Docs: FEATURES.md voice row annotation, ADR status sync. | — |

Phase record (updated as work lands):

| Phase | Landed |
|---|---|
| P1 | `/speak` per-turn `agentId` + speaker-authoritative W6 + fallback tests (`voice-session.test.ts` ADR 0304 block) |
| P2 | `VoiceTarget` union + picker Boards section, `LiveVoiceController` path latching (board → walkie multi-speaker), `useVoiceMode` turn queue (`turnQueue.ts`, unit-tested) + skip/mute + barge-in-resume, `voiceBoardActive` threading (ChatSidebar header/cadence, TabSession cadence), i18n ×4. **Residue closed (follow-up PR):** the lineup speaking-pulse — `speakingAgentId` mirrored up via `ConversationView.onVoiceSpeakingAgent` into the ChatSidebar members pane + the TabSession strip (`ConversationLineup` speaking state, speaking outranks thinking); and the Gemini attribution parity — the realtime session's scoped agent rides `onLiveTranscript` so client-persisted assistant turns carry `agentId` (parity with the OpenAI sideband's server-side stamp). |
| P3 | `delegation.ts` (session-control decls + per-call state), sideband intercepts + `session.update` swap/one-shot restore + floor re-binding, mint-time declaration in `/openai/connect`, D4 attribution stamp (row meta `agentId`/`agentPersona` + the FE plain-text-row lift) — 8 tests in `voice-realtime.test.ts` |
| P4 | FEATURES.md voice-row annotation + this phase record |

**Correction (P2, 2026-07-06):** D2/D3 originally implied the `@@<handle>` summon fires
on the FIRST committed utterance only. Implemented as **every committed utterance** in a
picker-targeted board session: that is exactly the text `@@` semantics (each summon = a
fresh board round; the turn policy is the cost control), and it makes barge-in-to-reframe
("skip the finance angle") restart the round with the new framing instead of routing a
board question to the chair alone. Auto-activated board voice (a board conversation
already live, no picker target) submits plain text — the board is already convened and
the user manages `@@` themselves, as in text.

## Open questions / recorded non-ships

- **Gemini delegation** — deferred until Google offers mid-session
  re-instruction on Live tokens (or we accept re-mint-per-handoff cost).
  Recorded, not worked around.
- **Realtime boardroom** (S2S model as chair with delegate-per-advisor) —
  rejected for v1 (see D2 rationale); revisit only if TTS latency proves
  unacceptable in practice.
- **Nested delegation** — refused in v1; a delegation *stack* needs a design
  for barge-in unwinding that one-shot return avoids.
- **Multi-round barge-in during synthesis** — the user interrupting the
  chair's synthesis turn routes to the chair like any turn; whether it should
  *cancel* the synthesis and re-run it post-answer is deferred to real usage.
