# Live voice (unit A7) — chat-first port review

**Scope:** `backend/typescript/src/features/voice/` (ADR 0138 walkie, 0141 realtime
S2S, 0304 spoken delegation + live boardroom, 0324 tool-scope parity) + the frontend
voice surfaces under `frontend/react/src/chat/voice/` and `.../chat/conversations/`.

**Headline verdict:** Live voice is a **model citizen of the chat-first architecture** —
it is an *audio adapter on the ONE chat*, not a parallel AI surface. It declares no
workflow, no node pack, no second chat panel, and no second tool executor. The single
real gap is on the HITL dimension of the realtime speech-to-speech path: a capability
firewall `require-approval` verdict has nowhere to render as a shared interrupt/approval
card, so a governed voice action that needs a human decision **dead-ends** instead of
routing to the shared approval machinery.

---

## Contract scouting (pinned mechanics)

**Declares vs ignites.** Voice creates **no workflow runs of its own** and ships **no
node pack** — deliberate, and documented: `feature.ts:47-50` ("No NODE pack: voice is
ctx-method + transport plumbing, not workflow nodes"). Every "run" a voice turn produces
is a real chat turn on the ONE chat:
- Walkie/board: `useVoiceMode.commitAndSend` calls the surface's own `onSend`
  (`useVoiceMode.ts:233`) — the committed transcript is a normal chat send that the real
  chat responder answers. Voice adds zero orchestration.
- Realtime S2S: the provider runs the turn; the host **captures** it and persists each
  transcript turn into the ONE chat via the conversation store + message bus
  (`openaiSideband.ts:75-101`, `persistTranscript` → `publishChatMessageAppended`). No
  shadow turn store.
- Boardroom voice: each committed utterance is submitted as a `@@<handle>` summon
  (`useVoiceMode.ts:233`) — the **same** text path as a typed board summon, so the
  existing board interceptor + `useBoardroomCadence` own the flow (voice "adds zero new
  orchestration", `useVoiceMode.ts:19-22`).

**Tool allowlist vs what tools can do (ADR 0324 — the ONE `createScopedAgentToolProvider`).**
Confirmed shared: the realtime tool bridge executes through the **same** owner the chat
agent loop uses — `toolBridge.ts:129` `createScopedAgentToolProvider(...)`, gated by the
**same** `effectiveToolAllowlist` (`toolBridge.ts:38-42`, honoring the ADR 0104
super-admin override on **both** the decl side and the execute side) and the **same**
`buildFirewallHook` capability firewall (`toolBridge.ts:116-122`). The realtime model can
only *request* a call; allowlist → firewall → executor all run host-side
(`toolBridge.ts:100-137`). The default voice-assistant pack allowlist is read-only
(`packs/feature.voice.agents/pack.json`: `knowledge.search` + `ai.research.web`), but a
**scoped** session inherits the scoped agent's own allowlist — action tools are not
withheld by voice, so the persona is not toothless-by-design.

**Owners instantiated (the RIDES grep), not shadowed:**
- Chat context / persona: `composeChatContext` + `composeVoicePreamble` — same brain as a
  typed turn (`routes.ts:97`, `routes.ts:45-130`).
- Roster / agent identity: `listRoster`, `resolveAgentIdentity` (`routes.ts:31-32`,
  `delegation` compose in `routes.ts:294-326`).
- Per-agent voice: `agentProfile.configParameters.voice` via `resolveAgentVoice`
  (`voiceSession.ts:97-113`) — the ADR 0031 seam, **no new per-agent voice store**.
- BYOK credentials: `resolveSecret` on the tenant `credentialRef` (`routes.ts:182`,
  `config.ts`) — one secret store, superadmin-gated config write (`routes.ts:469-486`).
- Durable transcripts: the conversation store + `publishChatMessageAppended`
  (`openaiSideband.ts:94-100`).
- Session state: `VoiceSession` is **ephemeral**, point-get keyed `tenant:session`,
  GC'd, replay-exempt (`voiceSession.ts:1-84`) — explicitly *not* a second conversation
  store.

**Executor/chassis constraints that bound the port:**
- The realtime tool path does **not** flow through `agentDispatch`/the run loop — it calls
  `executeTool` directly (`toolBridge.ts:135`). Consequence: the run-layer interrupt/gate
  machinery is **not reachable** from a realtime tool call. This is the root of the HITL
  gap below (the walkie path is unaffected — it rides a real chat run).
- Spoken delegation is **OpenAI-realtime only**: the sideband can `session.update` to
  re-instruct/re-voice mid-call; Gemini's token-locked setup cannot, so the delegate tool
  is never declared there (`delegation.ts:5-9`) — an **honest capability gap**, not a
  workaround.
- The Gemini realtime path relays tool calls from the browser to the host bridge
  (`realtimeClient.ts:316-319`); OpenAI runs them on the host-owned sideband
  (`openaiSideband.ts:138-204`) so the browser never holds the session id (firewall-bypass
  + no-audit findings retired for OpenAI).

---

## Verdict table

| # | Capability | Today | Verdict | Port target / note |
|---|---|---|---|---|
| 1 | Walkie voice turn (mic→STT→chat reply→TTS) | audio adapter; reply via `onSend` to the real chat | **ADAPTER** | Leave. Rides the ONE chat; reply is never re-derived (`voiceTurns.ts:1-12`) |
| 2 | Realtime S2S voice turn | host-mediated sideband; persona from `composeChatContext` | **ADAPTER** | Leave. Same brain + transcript persisted to the ONE chat |
| 3 | Realtime tool execution | shared allowlist + firewall + `createScopedAgentToolProvider` | **RIDES** | Leave. ADR 0324 parity verified (`toolBridge.ts:129`) |
| 4 | Spoken multi-agent delegation | session-control tools inside sideband; delegate is a real agent | **ADAPTER** | Leave. Rides roster/identity; honest Gemini gap (`delegation.ts`) |
| 5 | Live boardroom voice | `@@handle` summon → existing board interceptor + cadence | **RIDES** | Leave. Same text path as a typed summon (`useVoiceMode.ts:233`) |
| 6 | Per-agent voice config | reads `agentProfile.configParameters.voice` | **RIDES** | Leave. ADR 0031 seam, no new store (`voiceSession.ts:97`) |
| 7 | Realtime provider config (admin) | superadmin GET/PUT + member capability probe | **ADAPTER** | Leave. Rides BYOK `secretResolver`; key never returned (`routes.ts:446-486`) |
| 8 | Voice target picker (unscoped chat) | roster-backed modal choosing agent/generic/board | **PAGE-LEGIT** | Keep. Selection UI, not a second chat; rides `listRoster` |
| 9 | Barge-in | cancel in-flight TTS, no partial leak | **ADAPTER** | Leave. Transport mechanic (`voiceTurns.ts`, `routes.ts:212-225`) |
| 10 | Degraded-context surfacing | chip/toast + persisted system notice in chat | **PAGE-LEGIT** | Keep. Honest deferral loop (ADR 0277; `openaiSideband.ts:55-71`) |
| 11 | Realtime approval checkpoint (HITL) | firewall `require-approval` → **text string to the model** | **THEATER** | See Blocker 1 — route to the shared interrupt/reviews machinery, or narrow + defer honestly |
| 12 | Transcript persistence / audit | writes to the ONE chat conversation store | **RIDES** | Leave. `persistTranscript` → conversation store + bus |

**Totals:** R=4, A=5, P=0, T=1, PL=2.

---

## Blockers (from scouting) — each with the honest alternative

### Blocker 1 (THEATER, cap #11) — realtime voice has no path to the shared HITL machinery

**Evidence.** When the composition-aware capability firewall returns `require-approval`
for a realtime tool call (`toolBridge.ts:121`), the outcome is serialized and the client
turns it into a **plain string handed back to the model** — both providers:
- Gemini relay: `realtimeClient.ts:59` → `` `This action needs approval: ${reason}` ``.
- OpenAI sideband: `openaiSideband.ts:196` → `` `[requires_approval] ${reason}` `` as the
  function-call output.

No interrupt card renders, no reviews-inbox row is created, no durable decision record is
written (grep confirms **zero** `interrupt`/`reviewsInbox`/`approvalService` references in
`features/voice/` and `chat/voice/`). The chat baseline renders HITL through
`chat/MessageFeed.tsx`; the realtime tool path never reaches a chat run, so nothing
consumes an approval. **Net effect:** a governed action that in typed chat renders an
approval card the human resolves (and the tool then runs) simply **cannot be completed by
realtime voice** — the model is told "needs approval" and the action is unreachable. The
`voice-assistant` persona's "confirm before acting" instruction
(`prompts/voice-assistant.md`) is a *spoken* confirmation, not the durable HITL gate — it
does not substitute for the shared primitive.

Note the **walkie path is NOT affected**: it submits via `onSend` → a real chat run, whose
interrupts render inline in `MessageFeed`. The gap is realtime S2S only.

**Honest alternatives (pick one; do not paint it green):**
1. **Route `require-approval` to the shared machinery.** When the firewall requires
   approval on a realtime tool call, persist a shared interrupt/approval into the bound
   conversation (voice already has the gated `conversationId` +
   `actingUserId` on the session record — `openaiSideband.ts:31-48`) and return a
   `[pending approval — resolve it in the chat]` tool output. The human resolves the same
   card the typed flow uses (reviews inbox / inline), and on approval the action executes.
   This reuses the ONE approvals owner and leaves a durable decision record — the only
   option that makes "governed voice action" real.
2. **Narrow + defer honestly.** If (1) is out of scope for this unit, explicitly restrict
   realtime-declared tools to the non-approval-requiring set at decl time
   (`resolveAgentToolDecls`, `toolBridge.ts:57-65`) so the model is never offered a tool
   whose only outcome by voice is a dead-end, and record the deferral in the deferred list
   below. **Do not** leave the current state undocumented — a firewall verdict the platform
   can't act on is exactly the "fake gate" the skill's HITL test flags.

### Blocker 2 (lifecycle, minor) — the Gemini realtime firewall seen-set has no reaper

**Evidence.** The per-session composition seen-set (`toolBridge.ts:76-78`,
`seenBySession`) is only released by `clearRealtimeSessionTools`, which is called **only**
from the OpenAI sideband teardown (`openaiSideband.ts:284,338`). The **Gemini** path keys
the seen-set on the host-issued `hostSessionId` (`routes.ts:409-437`) but has no sideband
and no teardown call — so a Gemini realtime session's seen-set (and, if ever added, any
sibling per-session map) **leaks in-memory** until process restart. Same-instance and
bounded per session, so not a correctness bug for a single call, but it violates the
skill's lifecycle test (every session-keyed registry needs a death seam wired to its
parent). **Alternative:** call `clearRealtimeSessionTools(hostSessionId)` from a Gemini
session-end signal (the FE already ends the realtime handle; add a host end route or reap
on `resolveRealtimeSession` expiry).

---

## Demolition list (with regression pins to add)

Voice introduces **no bespoke chat panel, no second "talk to AI" textarea, and no parallel
tool executor** — there is nothing to demolish on the parallel-architecture axis. The
`LiveVoiceController` renders **no button** and lifts state to the single `ChatInput` mic
(`LiveVoiceController.tsx:1-21`) — the "no second chat" rule holds. The demolition list is
therefore about **pinning what must not regress**:

- **Pin:** realtime tool execution must keep flowing through `createScopedAgentToolProvider`
  + `effectiveToolAllowlist` + `buildFirewallHook` (a test asserting a revoked/ADR-0104
  override tool is neither declared nor executable over voice — parity with chat).
- **Pin:** delegation session-control tools (`voice__delegate_to_agent`/`_return_to_agent`)
  must never enter an allowlist/firewall/executor (a test that they are rejected as
  ordinary tool names — `delegation.ts:11-16` invariant).
- **Pin (after Blocker 1 fix):** a `require-approval` firewall verdict on a realtime tool
  call produces a shared approval record (a resurrected string-only dead-end fails the
  suite).
- **Pin:** committed voice utterances route through the surface `onSend`/`@@handle` path
  (no bespoke send) so board summons stay on the existing interceptor.

---

## New-code inventory (small — this is mostly a leave-it-alone review)

1. **Blocker 1 fix:** a thin seam in `executeRealtimeToolCall` that, on `require-approval`,
   creates a shared approval bound to `{conversationId, actingUserId}` and returns a
   pending tool output. Reuses the existing approvals owner + conversation store — **no new
   store, no new envelope kind.** (~1 small function + wiring; the FE strings at
   `realtimeClient.ts:59`/`openaiSideband.ts:196` become "pending in chat" copy.)
2. **Blocker 2 fix:** a Gemini session-end reap calling `clearRealtimeSessionTools`
   (~1 route or expiry hook).
3. Regression tests per the demolition pins above.

Everything else (transport, sideband, delegation, boardroom voice, per-agent voice,
config, degraded-context honesty) already rides the engine — no new code.

---

## Phased plan (gated on real gates)

- **Phase 1 — HITL parity (Blocker 1).** Compliance seam first: wire realtime
  `require-approval` to the shared approval/interrupt owner; add the pin test. Close with
  `/code-review` + `/ux-review` (the pending-approval spoken + chat copy), apply fixes.
  *No demolition precedes the replacement — the string path stays until the approval seam
  works.*
- **Phase 2 — lifecycle (Blocker 2).** Add the Gemini seen-set reaper + a test; close with
  `/code-review`.
- **Phase 3 — regression pins.** Land the allowlist-parity, delegation-not-a-tool, and
  onSend-routing pins so the RIDES/ADAPTER verdicts are enforced, not just observed.

---

## Deferred honestly

- **Spoken delegation on Gemini Live** — deferred by provider constraint (token-locked
  session cannot be re-instructed mid-call); declared only on OpenAI, documented as an
  honest gap (`delegation.ts:5-9`). Not a defect to fix here.
- **Realtime approval completion** — if Blocker 1 Phase 1 is not taken now, the *only*
  honest state is Blocker-1 alternative (2): narrow realtime-declared tools to
  non-approval-requiring ones and state here that governed-by-approval actions are
  **chat/walkie-only**, not available on the realtime S2S path. It must not be left as an
  undocumented dead-end.

---

### Bottom line

Live voice is one of the cleanest chat-first citizens in the app: **0 PARALLEL**, it
instantiates every owner it touches (chat context, roster/identity, BYOK, approvals-*where
it reaches them*, conversation store), declares no orphaned orchestration, and reuses the
single tool executor via ADR 0324. The one thing standing between it and a perfect score is
that the realtime speech-to-speech path can *detect* a required human approval but has no
shared primitive to *render and resolve* it — a HITL hole, not a parallel-architecture one.
