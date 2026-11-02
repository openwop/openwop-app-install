# ADR 1019 — Chat auto-titling: name only placeholder chats, once, on the conversation's own credential, and show it

Status: implemented (2026-10-31; accepted after the adversarial /architect pass)

**Extends:** ADR 0151 (conversation auto-titling). Toggle `chat-autotitle` is unchanged (id, default ON, `bucketUnit: user`).
**Feature loop:** round 2, row 69 (`docs/steward/FEATURE-LOOP-2026-10.md`). Grade record:
`docs/steward/workflows-assessment/2026-10-31-chat-autotitle-1019.md`.
**RFC verdict:** host-extension only. No wire change: `chat_sessions.title_source` is a host
column, `openwop-app.conversation.titled` stays a non-normative host event, and the session
header read is the existing `/v1/host/openwop-app/chat/sessions/:id`.

## Context — what the grade measured

ADR 0151 promises four things: it names a **new chat** by its topic, **once**, on **the
conversation's credential** ("the cheapest fast model on the active credential — managed
MiniMax for the free tier, or the user's BYOK model"), and the rail/tab **update live**. Read
against `origin/main` @ `caabea6cf`, each promise is false:

1. **It renames chats that were never placeholders.** The binding titles any session whose
   `titleSource` is still `'default'` (`features/chat-autotitle/binding.ts:73`). Only a PATCH
   rename ever moves it off `'default'` (`routes/chatSessions.ts:503`). Every session a
   feature creates with a real name keeps `'default'`: advisory-board rooms
   (`features/advisory-board/routes.ts:178`, "X · board"), project rooms
   (`features/projects/routes.ts:509`), notebook rooms (`features/notebooks/routes.ts:547`),
   channels (`features/channels/channelService.ts:108`, the channel name), agent/person DMs
   opened with a title (`routes/chatSessions.ts:1115`), branches ("X (branch)", `:731`),
   imports (`features/chat-export/importService.ts:148`), KickBot coach rooms
   (`features/kicktodo-core/kickbotCoachTurnService.ts:108`) and the workflow-activity room
   (`host/chatSurface.ts:74`). The first agent exchange in any of them replaces its name with
   a five-word model guess. Worse, `'default'` is ALSO what `refreshEntityChatTitle`
   (`host/conversationStore.ts:485`) uses to mean "follow the entity's name", so once the
   autotitler writes `'auto'`, renaming the board or project no longer reaches its chat.
2. **It is not once.** The binding fires on every exchange and only stops when a title is
   written. A dispatch that fails, times out, or returns output `sanitizeTitle` rejects
   leaves `'default'`, so the next turn pays for another call — on that turn's text, not the
   first exchange's.
3. **It ignores the conversation's credential.** `generateTitle` calls
   `resolveHeadlessAi(tenantId, 'text', …)` (`titleGenerator.ts:101`), the resolver for work
   that has *no* user-selected provider. A conversation running on the user's own Anthropic
   key, a GitHub Copilot subscription, or a self-hosted compat endpoint has its first
   message and reply sent to the platform's managed provider instead, and the platform pays.
   It also omits `actingSubject` (memory extraction passes it, `persistExchange.ts:158`), so a
   managed title draws the pooled workspace bucket rather than the person's (ADR 0721). The
   transcript reaches the model unfenced.
4. **Nobody sees it arrive.** The only reader of the `titled` event is the per-exchange run
   stream (`useTurnTransport.ts:402`), which is closed in `finally` when the exchange settles
   (`:550`). The title call starts after the exchange is durable and takes ≥ 1 s, so the
   event lands after the stream is closed. Even when it is caught, `applyAutoTitle` sets only
   the active session's `title`, which neither the rail (`chat/conversations/ConversationsRail.tsx:449`, server
   headers from `useChatSessions`) nor the tab label (`TabChatDeck.tsx:735`) reads, and no
   `session:renamed` reaches other tabs. The title shows up only after a reload.

### Production measurement (read-only, 2026-10-31)

- **9 managed title calls, 1 title, 0 `titled` events ever.** `managed:feature-spend` for
  `chat-autotitle`: 2 tenants, 9 calls, 3 112 in / **216 out** tokens (charged 0),
  2026-10-09..10-26. 216 / 9 = 24 = the old `maxTokens` cap on **every** call. The managed
  model reasons in a `<think>` block that the dispatcher strips, and the block counts
  against the cap, so the visible title came back empty, `sanitizeTitle` returned null —
  silently, which is why the logs show 0 `autotitle_generate_failed` in 30 days — and the
  next turn paid again. A fifth defect, fixed here: the managed route gets 512 output tokens.
- **Re-fire exposure:** 5 placeholder sessions with ≥ 4 messages (60 messages, max 28).
- **Entity-name exposure, none overwritten yet:** 6 system-named sessions at NULL title
  source (3 board groups, 2 channels, 1 workspace DM) plus 1 "Workflow activity". The one
  `'auto'` session is an ordinary agent chat, so no repair backfill is needed.
- **Credential:** chat runs managed 44 (openwop-free 28, provider-null 13, minimax 3), BYOK
  google 22 (0 in the last 30 days). **BYOK-to-managed exposure: 0, measured.** On every
  autotitle spend day (10-09: 7 calls, 10-23: 1, 10-26: 1) the tenants' exchanging chat runs
  were all managed (2, 1, 1) and none BYOK; the tenant holding the 22 BYOK runs last
  exchanged on 2026-07-25, before every spend day.
  Tenants with a headless BYOK default: 1, `preferForText`: 0.

## Decision

> **Revised after the adversarial `/architect` pass (2026-10-31, before code).** It found 1
> Blocker and 8 Majors in the first draft: no first-exchange rule (imports, promotions and
> legacy rows still titled on a later turn), an incomplete creator list (the assistant
> 'Workspace' DM), a claim written through `casChatSessionTitle` (which rewrites `title` and
> `updated_at`), D3 keyed on `run.inputs.provider` instead of the provider that actually
> served the turn, a second key ladder inside the feature, and a D4 poll comparing title text
> when `titleSource` is already on the header. The text below is the corrected decision.

### D1 — Only a chat's first exchange, on a placeholder title, is titleable

Eligibility (all must hold; any miss ⇒ no claim, no model call):

1. **First exchange.** No prior `user` turn exists in the conversation run when this
   exchange starts (`conversationExchange.finishExchange`, `existing`). A promoted chat, an
   import, a branch, a later turn after a failed first call: none is a first exchange.
2. **Placeholder title.** `titleSource` is `'default'` (NULL). `ChatSessionRecord.titleSource`
   gains `'given'`: the session was named at creation by its source. Every non-placeholder
   creator writes it: advisory board (`features/advisory-board/routes.ts:178`), project
   (`features/projects/routes.ts:509`), notebook (`features/notebooks/routes.ts:547`), channel
   (`features/channels/channelService.ts:108`), the persistent 1:1 open with or without a
   title (`routes/chatSessions.ts:1117`, a DM is one long multi-topic thread), the assistant
   'Workspace' DM (`features/assistant/routes.ts:138`), branch (`routes/chatSessions.ts:733`),
   import (`features/chat-export/importService.ts:148`), KickBot coach
   (`features/kicktodo-core/kickbotCoachTurnService.ts:108`) and the workflow-activity room
   (`host/chatSurface.ts:74`). `POST /chat/sessions` keeps `'default'` (the main chat; its
   client sends the substring placeholder).
3. **Legacy guard** (rows created before this ADR with NULL): the session's conversation
   meta, when present, is `type: 'agent'` with no `boardId`, `ownerSubject`, `dmKey` or
   `branchedFrom`. Any other type (group, person, workspace, channel) is not titleable.
   > *Implementation note (grade-code, 2026-10-31):* `POST /chat/sessions` still writes
   > NULL, so this guard runs on EVERY titleable row, not only legacy ones. That is
   > stricter than "legacy-only" and intended: a group created through that POST is not
   > titled either.

`refreshEntityChatTitle` follows the entity when `titleSource` is `'default'`, `'given'`, or
`'auto'` on an entity-bound meta (`ownerSubject` or `boardId`): an `'auto'` there is this
bug's damage, not a user choice, so the next entity open or rename repairs it without a data
migration. `'user'` is never touched.

### D2 — One model call per chat, recorded

- After eligibility and after the dispatch resolves (D3), the binding **claims** the session
  with a new storage primitive `claimChatSessionTitleSource(tenantId, sessionId, from, to)`
  that changes ONLY `title_source` (`'default'` → `'claimed'`), not `title` or
  `updated_at` (so the rail does not reorder). Both backends, SQL parity tested.
- On a usable title: `casChatSessionTitle(…, expect 'claimed')` → `'auto'`; announce only
  when won.
- On any failure after the claim (provider error, timeout, unusable output, crash) the
  session stays `'claimed'` with its placeholder. No retry: with the first-exchange rule
  there is no later eligible turn anyway, and the claim also stops a fresh conversation
  run for the same session (the client's dead-run self-heal) from titling again.
- Everything that can refuse WITHOUT spending (toggle, eligibility, no dispatch for this
  credential, BYOK org/personal budget exceeded, key does not resolve, no `quick` model)
  runs BEFORE the claim and leaves `'default'`. The managed daily-limit refusal happens
  inside the managed dispatch, after the claim; it leaves a placeholder for that chat, which
  is the "once" decision of ADR 0151 OQ-3.

### D3 — Title on the credential that served the conversation

One resolver, in the ONE headless module beside the ADR 0821 D5 ladder (SR-1 key handling
stays in one audited place): `resolveHeadlessAiForConversation(run, served, opts)` in
`host/headlessAi.ts`. The feature only calls it. It is keyed on `served` (the provider that
actually answered this exchange, `conversationExchange.ts:717/764/772`) plus
`run.inputs.credentialRef`, not on `run.inputs.provider` (ADR 1016 routes and per-turn
overrides can switch provider):

| Served by | Title call | Who pays / meters |
|---|---|---|
| managed (`served.managed`) | the ADR 0821 D5 headless ladder with `featureId: 'chat-autotitle'` and `actingSubject` = the run's acting user. The tenant's BYOK `preferForText` opt-in is the tenant's own consent (ADR 0821 D5) to move background text to its key and is honoured as such. The managed step is the free tier (`MANAGED_FREE_REF`) whatever managed tier the chat used: a title is not worth a paid-tier draw. | managed: the person's bucket (ADR 0721) |
| BYOK direct (`anthropic` / `openai` / `google`) with a `credentialRef` that does not name another provider (`explicitRefNamesOtherProvider`, ADR 0779 D6) and resolves now | the same key, on the provider's catalog `quick` class model, after `checkByokChatBudget` (org and personal), recorded with `recordByokChatUsage` | the conversation's key, inside its budget |
| anything else: subscription, Copilot, compat (self-hosted), mock, an unresolvable key | **no model call**, no claim; the placeholder stays | nobody |

The user chose where this conversation's text goes; a cosmetic label is not a reason to send
it to another provider, and a personal subscription or self-hosted endpoint is not ours to
spend.

**Prompt.** Slice the transcript body (`User: …\nAI: …`) to `MAX_INPUT_CHARS` FIRST, then
wrap it with `fenceUntrustedBlock` (never slice the fenced string: that drops the END
marker). The system prompt tells the model to title in the language of the fenced
conversation, not of the surrounding text. No run, conversation, ask or message id reaches
the model (ADR 1002, `xch-env-9`).

### D4 — The title reaches every surface that shows the chat

- **`titleSource` is already on the header** (`toConversation` spreads the session,
  `routes/chatSessions.ts:209`); the FE `ChatSessionHeader` type declares it.
- **Follow.** After a chat's FIRST exchange settles (the session had no messages when the
  turn was sent), with `persist` on (never in `EmbeddedConversation`) and the toggle on, the
  client reads `GET /chat/sessions/:id` on a bounded backoff (≈ 2, 5, 10, 18, 30 s) until
  `titleSource` is `'auto'` (apply the title), or `'user'` / `'given'` (stop). Still
  `'default'` / `'claimed'` after the last read: stop silently. Cancelled on unmount. The
  in-exchange SSE `titled` event stays as the fast path; both call `applyAutoTitle`.
- **One signal.** `applyAutoTitle` sets the active session title, announces it (ATU-1), and
  posts `session:renamed` once on the session-list BroadcastChannel from a separate channel
  object, which reaches every `useChatSessions` in this tab and in other tabs. Each refetches
  the header list (the rail row and the tab label both read it; the tab deck's `lastTitle`
  effect persists it).
  > *Correction (implementation, 2026-10-31):* the first text specified a window event
  > `openwop:conversation-titled` that patches each header in place. Built instead: the
  > existing BroadcastChannel `session:renamed`, which already makes every list refetch and
  > reaches other tabs with one mechanism. A notice arriving while a refresh is in flight now
  > queues one more refresh instead of being dropped (that fetch may predate the title). The
  > announcement fires only when the titled chat is the one on screen.

## Alternatives weighed

- **Generate the title in parallel with the reply** (ADR 0151's original "immediate"):
  rejected. Two concurrent calls on a free-tier BYOK key is exactly what draws a 429 on the
  reply the user is waiting for, and it would need the reply-less prompt.
- **Await the title inside the exchange before settling:** rejected — couples a cosmetic,
  best-effort call into the turn's critical path (up to 15 s).
- **Keep the run SSE open after settle to catch the event:** rejected — holds an SSE slot
  against the per-tenant cap (the same cap the transport comment records 429ing every stream
  in prod on 2026-10-09), and still needs the header plumbing. Polling the header is four
  cheap reads on a first exchange only.
- **Migrate legacy rows to `'given'` by title shape** ("% · board"): rejected — guesses from
  display text; the meta guard is exact.
- **Release the claim on transient failures and retry:** rejected — with the first-exchange
  rule there is no later eligible turn to retry on; "once" is the product decision (ADR 0151
  OQ-3). Revisit with a measured failure rate (OQ1).
- **Title on the tenant headless default for BYOK conversations:** rejected — it is not the
  conversation's credential, and for a tenant without the opt-in it is managed again.

## Phased plan

| Phase | Deliverable |
|---|---|
| P1 | first-exchange rule; `titleSource: 'given'` at the ten creators; `refreshEntityChatTitle` follows `'given'` and repairs entity-bound `'auto'`; legacy meta guard (D1) |
| P2 | `claimChatSessionTitleSource` (sqlite + postgres) and claim → title CAS, no retry (D2) |
| P3 | `resolveHeadlessAiForConversation` in `host/headlessAi.ts` + slice-then-fence transcript; the binding takes the run, `served` and the first-exchange flag (D3) |
| P4 | FE `titleSource` on the header type, first-exchange follow, a BroadcastChannel `session:renamed` refetch for the rail/tab/other tabs (D4, as corrected) |
| P5 | docs: ADR 0151 correction notes, FEATURES row, LLM-EXCHANGE-AUDIT row (chat-autotitle is a model exchange, not exchange-free) |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `features/chat-autotitle/` keeps owning the decision; the key ladder lives in `host/headlessAi.ts`; creators set a field on their own row. The host call site passes the run, `served` and the first-exchange flag. |
| 2 | Toggle | unchanged (`chat-autotitle`, ON, `user`). |
| 3 | Workflow surface | none. |
| 4 | Node pack | none. |
| 5 | Envelopes | none. |
| 6 | Agent pack | none. |
| 7 | Public surface | none. |
| 8 | RBAC | the binding acts only on the run's own session; the header follow reads through the existing owner-gated GET. |
| 9 | Replay / fork | unchanged: the title is a host display label written outside any run; the dispatch never runs on replay (exchanges are not re-executed). |
| 10 | Frontend | `session:renamed` on the session-list BroadcastChannel (refetch), first-exchange follow in `useTurnTransport`; no new strings (the announcement exists). |

## Open questions

- OQ3 — a refusal BEFORE the claim (budget spent, toggle off at that moment) leaves the
  session `'default'`; if the client later opens a fresh conversation run for the same chat
  (the dead-run self-heal), that run's first exchange can title the chat from a later turn's
  text. Bounded (one call) and rare; accepted.

- OQ1 — should a failed claim be visible (a "Name this chat" affordance)? Deferred; measure
  the failure rate first (the `autotitle_generate_failed` log carries `timedOut`).
- OQ2 — `'claimed'` rows from a crash are indistinguishable from a failed call. Acceptable
  (both keep the placeholder); revisit with OQ1.

## Implementation record

| Phase | Commit (subject) | Witnesses |
|---|---|---|
| P1–P3 | `fix(chat-autotitle): name only placeholder chats, once, on the conversation's credential (ADR 1019 D1-D3)` | `chat-autotitle-binding`, `-entity-titles` (census), `-conversation-credential`, `-call-site`, `storage-adapter-parity` (claim, sqlite + pg-mem) |
| P3 fix | `fix(chat-autotitle): load the provider list on demand; classify the title fence (ADR 1019 D3)` | `media-intelligence` (the cycle), `fenced-truncation` |
| P4 | `feat(chat): a new chat's AI title shows up in the rail, the tab and other tabs (ADR 1019 D4)` | `followAutoTitle`, `applyAutoTitle` (incl. WIRING), `useChatSessions.refreshAgain` |
| P5 | `docs(chat-autotitle): ADR 1019 with prod measurement; correct ADR 0151, FEATURES and the exchange audit (row 69)` | — |

Sabotage-witnessed (2026-10-31, each red): firstExchange gate, legacy meta guard, no claim,
CAS on `'default'`, managed `actingSubject`, BYOK budget, vendor check, unfenced prompt,
call-site `firstExchange`, entity blind write, managed 24-token cap, creator census; FE:
coalesced rename refresh, any-title follow, announce-always, no broadcast.

Closing grades (independent graders): WF D → A−, UX D → A−, CODE C → A−. Not clicked
through live (`PROBE-ATW-1`).
