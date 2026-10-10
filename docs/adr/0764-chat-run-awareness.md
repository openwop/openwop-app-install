# ADR 0764 — Chat run awareness: workflow runs are conversation context

Status: implemented (P1–P5; follow-ups listed below are NOT shipped)

Date: 2026-09-28

Relates to: ADR 0067 (the conversation run is the sole chat transport), ADR 0089
(deep-investigation agent-mention runs), ADR 0491 (turn-run dispatch — ONE turn-index
allocator), ADR 0308 (tool-grounded reads fail empty without an acting user), ADR 0476
(`openwop:runs.diagnose`), ADR 0531 / ADR 0635 (replay effect guard + the RFC 0173
effect-seam manifest), ADR 0665 (untrusted fencing of composed content), ADR 0163 /
ADR 0524 (backend is the workflow SoT, localStorage a cache), ADR 0472 (the retired
builtin seam). Source grade: `docs/steward/WORKFLOWS-ASSESSMENT.md` § "AI chat
(feature loop 2026-10 row 1)" (`CHATWF-1..10`). Competitive basis:
`docs/steward/UX_UPGRADE-chat.md`.

## Context

The chat is the product's front door and the `/` picker is how a user runs a
workflow from it. Graded as a unit for the first time (C+, three Blockers), the
orchestration half of the chat has one structural gap and a cluster of defects.

**The structural gap — the agent cannot see what ran.** Two facts, both measured:

1. A `workflow_run` turn in the RFC 0005 turn log (written by the deep @mention path,
   `conversationExchange.ts:452-457`, and by every feature tool through
   `turnRunDispatch.ts` `buildRunDispatchTurns`) reaches the model as the literal
   string `{"kind":"workflow_run","runId":"…","agentId":"…"}` — `turnsToMessages`
   (`host/exchange/dispatchTurn.ts:147-193`) renders it through `asText`, which
   `JSON.stringify`s non-text content (`contentParts.ts:122`). No status, no error, no
   output. The model is told a run exists and nothing about it.
2. A run the USER starts with `/slug` never enters the turn log at all. The SPA calls
   `POST /v1/runs` directly with `metadata.chatSessionId`
   (`useWorkflowRunMentions.ts:529-544`) and persists the bubble only as a chat-session
   message (`role: 'workflow_run'`). The model's next turn is built from the turn log,
   so "now summarize that" after `/research-topic …` is answered blind.

Every competitor the chat was benchmarked against treats in-thread work as context:
ChatGPT agent mode and Copilot actions report the task outcome in-thread and the
assistant reasons over it (`UX_UPGRADE-chat.md` catalog). Our run bubble is richer
than theirs for the HUMAN; it is invisible to the MODEL.

**The defects (`CHATWF-1..8`)**, each re-read at the cited line:

- `CHATWF-1` (Blocker) a server-owned builder workflow (`wf_…`) the picker lists from
  the ownership index is refused as "deleted" unless it is also in this browser's
  localStorage (`useWorkflowRunMentions.ts:299-324`) — backwards since ADR 0163 made
  the backend the SoT (`builder/persistence/backendStore.ts:1-13`).
- `CHATWF-2` (Blocker) the picker preserves an `@agent ` prefix on apply
  (`SlashAutocomplete.tsx:151-157`) but `detectWorkflowSlashMention` matches only
  `^/` (`lib/workflowMentions.ts:184`): `@devon /summarize x` goes to the model as
  text and the picked workflow never runs.
- `CHATWF-3` (Blocker) `startWorkflowRun` (`host/runStarter.ts`) is not an effect
  seam — no `assertEffectAllowed`, no manifest row (`effectSeamManifest.ts:73-84`).
  The agent-runner node is deliberately unclassified (`agentRunnerNode.ts:28-36`), so
  a `:fork` re-executes it, its provider calls are served from the invocation log,
  the same tool calls re-fire, and every run-starting tool **starts a duplicate real
  run**.
- `CHATWF-4` a failed workflow-list fetch is swallowed (`workflowMentions.ts:86`) and
  renders exactly like "no match".
- `CHATWF-6` undesigned run states: the self-heal gives up after 5 rebuilds and leaves
  the bubble "running" forever (`useWorkflowRunMentions.ts:229`); a failed cancel
  marks a possibly-still-running run `failed` (`:614-621`); the stuck-run probe stamps
  a hard-coded English error (`:101`).
- `CHATWF-7` the catalog source-A `if (workflowId === '…')` ladder
  (`host/index.ts:465-580`) is not enumerated by any ratchet — the ADR 0472 ratchet
  only catches the deleted `builtinWorkflows` field, so a user workflow hidden there
  compiles green.
- `CHATWF-8` `PUT …/chat/sessions/:id/conversation-run`
  (`routes/chatSessions.ts:532-548`) checks only the run id's FORMAT; a caller may
  bind a session to any run id.

## Boundaries audit

- **No second chat, no new package, no toggle.** Everything lands in the existing
  chat (`frontend/react/src/chat/`) and its exchange (`host/conversationExchange.ts`,
  `host/exchange/*`). The fixes are corrections to an always-on core surface; a toggle
  would leave the defective path reachable.
- **Run reads — reuse the `runs.diagnose` posture** (`host/runDiagnoseTool.ts:69-75`):
  `storage.getRun`, absent-or-foreign-tenant ⇒ indistinguishable absence, output
  passed through `sanitizeFreeTextDeep`. No new read route.
- **Untrusted fencing — reuse** `fenceUntrustedBlock` (`host/untrustedContent.ts:59`).
  Run outputs and error text are attacker-choosable (an `http.fetch` body, a form
  field), exactly the class `runs.diagnose` is marked `contentTrust:'untrusted'` for.
- **Turn-log writes — NONE.** ADR 0491 made the exchange the single turn-index
  allocator; `appendRunTurnDirect` is the one tolerated out-of-band writer and its own
  docblock says why that is a compromise. D2 below therefore READS the chat-session
  messages rather than appending turns.
- **Effect guard — reuse** `assertEffectAllowed` + the manifest drift test
  (`effect-seam-manifest.test.ts` enumerates call sites and fails on an unlisted one).
- **Picker data — reuse** `backendStore.loadWorkflow` for a server-owned `wf_` id.
- Route collision: none (no new route).

## Decision

### D1 — A `workflow_run` turn renders as a grounded run digest

A new pure-render + async-resolve pair in `host/exchange/runDigests.ts`:

- `resolveRunDigests({ storage, tenantId, chatSessionId, runRefs })` — for each
  referenced runId (cap **8**, most recent first), `storage.getRun` passed through
  `disposePinnedRun` (the same disposition every authorized run read applies —
  `runAccess.ts:89-95`; without it a pinned run reads `running` forever, architect
  H1); drop it unless `run.tenantId === tenantId` (run read visibility IS the tenant,
  `loadReadableRun`). Total rendered digest text is capped at **6 000 chars**: past
  the cap, older runs render status-only (architect H2 — the ADR 0148 window measures
  the raw turn, not the digest). Terminal digests are memoised in a bounded in-process
  LRU (500 entries) — a terminal run's digest never changes, and this is the per-turn
  hot path (architect M1).

  > **CORRECTED by the grade-code pass (CHATCD-1, CHATCD-2) — both halves of this
  > bullet were wrong as first implemented.** Memoising the whole terminal digest
  > skipped `getRun` on a hit, so a run deleted by retention, the runs DELETE route or
  > a DSAR erasure kept reaching the model until restart — the architect's M1 fix
  > created an erasure bypass. Now the RECORD is re-read every exchange and only an
  > existing completed run's immutable output excerpt is cached. And the cap was
  > applied before admission, ranked by list position: forged session rows spent it.
  > Now: admit every candidate → rank by `ts` → the newest 8 get detail, the rest a
  > real status headline (never "not re-read" for a run we did read). For a completed run, read the tail of its log
  (`getMaxSequence` → `listEvents({ fromSeq: max - 4 })`) for `run.completed`
  `outputs ?? output`. Never throws: a read fault yields the "status unavailable"
  digest for that run and a `run_digest_resolve_failed` warn — **a failed read is
  never rendered as a status**.
- `renderRunDigest(ref, run | null)` → text:
  `[Workflow run "<name>" — <status>]` + for `failed` the error code + message, for
  `completed` an output excerpt (≤ 1 500 chars of JSON, `truncated` said when cut),
  for `waiting-*` "paused for input". Every run-derived free-text part is
  `sanitizeFreeTextDeep`ed and wrapped in ONE `fenceUntrustedBlock` labelled
  `workflow run <runId>`. **The host frame outside the fence carries only the runId
  and the status enum** — the workflow NAME is user-authored (any tenant member can
  name a workflow) and so goes INSIDE the fence (architect B2).
  An unresolvable run renders `[Workflow run <runId> — status unavailable]`, never
  the raw JSON and never a guessed status.
- `turnsToMessages` gains an optional `runDigestById: ReadonlyMap<string,string>`
  (the same injected-map shape as `personaNameById`, keeping it pure). A
  `workflow_run` turn renders its digest; with no map entry it renders the
  "status unavailable" line — the raw-JSON path is removed.

### D2 — Runs the user started with `/slug` enter the model's context, read-only

At exchange time, the exchange reads the chat session's most recent **40** messages
(`listChatSessionMessages(sessionId, { limit: 40 })`), keeps `role:'workflow_run'`,
and extracts ONLY the `runId` (+ `createdAt`) from the stored content — the client
authored everything else in that row, so nothing else is trusted. Each id is then
admitted only if `run.tenantId === tenantId` **and**
`run.metadata.chatSessionId === chatSessionId` (a forged message pointing at a
foreign or another conversation's run is dropped). Admitted runs not already
referenced by a turn become **transient** `workflow_run` pseudo-turns merged into the
windowed transcript by timestamp (dropped if older than the oldest kept turn), then
rendered by D1. Nothing is persisted; the turn log and its single allocator are
untouched; the prompt prefix stays stable because the pseudo-turn sits where the run
happened, not in the system scaffold.

### D3 — Starting a run is a guarded effect

`startWorkflowRun` calls `assertEffectAllowed('dispatch', 'run-start <workflowId>')`
after the deterministic-`runId` idempotent early-return (a replay that re-presents a
bound deterministic id still resolves to the existing run — no effect) and before any
write. `SEAM_CALL_SITES` + `SEAM_ROWS` gain `queue.run-start` (kind `queue`, an
admitted enum value; `branchReFires: true` like every row). Outside a node execution
the guard is a no-op, so routes, schedules, heartbeats and approvals are unaffected.
Inside a replay fork a re-fired start is refused instead of duplicating a real run —
the ADR 0531 contract ("a replay never fires a new side effect").

> **CORRECTED by the architect pass (B1) — the first draft said the fork "fails the
> node with `replay_source_missing`". It does not.** Both the tool executor
> (`agentToolProvider.ts:685-693`) and the agent loop (`agentDispatch.ts:1265-1273`)
> convert a throw into a tool ERROR RESULT, carrying the thrown `.code` through
> `extractToolErrorCode`. What actually happens on a fork: the tool call returns
> `agent.toolReturned{status:'error', error.code:'replay_source_missing'}`, no run row
> is written, and the node continues. That is honest (the refusal is named on the
> wire, not disguised as `tool_execution_failed`), and it is what the witness pins.
> Making it fail the NODE (the `mcpClient.ts:748` rethrow precedent) would need both
> catches changed and is recorded as a follow-up, not claimed.

### D4 — Picker and run-bubble correctness (frontend)

- `CHATWF-1`: a `wf_` id with no local copy loads the server copy
  (`backendStore.loadWorkflow`) for node names + defaults and is NEVER registered
  (the server already holds it). Only a null from the server yields "deleted".
- `CHATWF-2`: `detectWorkflowSlashMention` accepts the same optional `@agent ` prefix
  `detectSlashTrigger` does and returns the agent slug; `runCoreSubmit` activates the
  agent (so the follow-up conversation routes to it) and runs the workflow.
- `CHATWF-4`: the mention cache records a load error; the picker renders an honest
  "couldn't load workflows" row distinct from "no match".
- `CHATWF-6`: the self-heal give-up marks the bubble `lost` with an i18n notice and a
  Runs link (never "running"); a failed cancel leaves the status as it was and
  surfaces the cancel error; the stuck-run probe uses an i18n string and never
  overwrites an error the event-log rebuild already recorded.

### D5 — Conversation-run binding is validated

The PUT requires the run to exist in the caller's tenant (else the uniform 404), to be
an `openwop-app.conversation` run, and — when the run carries `metadata.chatSessionId`
— to belong to THIS session (400 otherwise).

### D6 — The source-A literal ladder is ratcheted

A test enumerates every `workflowId === '<literal>'` resolved in the `host/index.ts`
catalog and pins the set (shrink-only). A new literal fails with a message pointing at
ADR 0472 (ship a chain pack).

## Architect review (pre-implementation, 2026-09-28)

Track A (+ a Track B check of the manifest row). Findings folded into the decisions
above; recorded here so the trail survives.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| B1 | Blocker | D3 claimed the fork "fails the node"; both catches turn the throw into a tool error | Corrected in D3; witness asserts the tool-error code + no run row |
| B2 | Blocker | the digest frame put the user-authored workflow NAME outside the untrusted fence — a tenant member names a workflow "ignore previous instructions…" and it reaches every chat that runs it as host text | Name moved inside the fence; frame = runId + status enum |
| H1 | High | `storage.getRun` bypasses `disposePinnedRun`; a pinned run would read `running` forever | Read through `disposePinnedRun` |
| H2 | High | 8 × 1 500-char digests sit outside the ADR 0148 transcript budget | 6 000-char total cap, status-only past it |
| M1 | Medium | +1 list + up to 8 getRun + 16 event reads per exchange on the hot path | Terminal-digest LRU; non-terminal runs re-read (their status is the point) |
| M2 | Medium | D3 makes a LIVE run-start record `dispatch` in `observedEffectKinds`, which mints a compensation obligation only for a node that DECLARES compensation or `irreversible` (`compensationRuntime.ts:196-222`) | No run-starting path declares one; the full backend suite is the witness |
| M3 | Medium | D2 assumes the SPA's `/slug` `metadata.chatSessionId` equals the conversation run's | Both are `session.id` (`useWorkflowRunMentions.ts:537`, `conversationTransport.ts:489`); pinned by the D2 route-level witness |
| L1 | Low | system-initiated exchanges (scheduled agent chats) have no acting user; ADR 0308's fail-empty rule is for TOOLS | Digests describe the conversation's OWN runs to that conversation — no new disclosure channel; stated, not gated |

Wire: none. `queue.run-start` matches the manifest `seam` pattern and `queue` is in
the vendored enum; adding a guarded row widens an honest self-declaration.

## Replay / fork

- D1/D2 are exchange-time reads. Exchanges are HTTP-driven and never re-executed by
  the executor (the conversation run replays `conversation.*` from its log), so the
  prompt's dependence on LIVE run state has no replay-divergence surface. It is
  presentation-only, like the ADR 0148 transcript window.
- D3 changes fork behaviour deliberately (duplicate → honest node failure).

## RFC verdict

Host work. No wire change: D1/D2 alter prompt text only (RFC 0005 treats turn content
as opaque; nothing new is persisted); D3 adds a host-declared manifest row with an
enum value the vendored `effect-seam-manifest.schema.json` already admits; D5 is a
host-extension route. No capability is added or advertised.

## Alternatives weighed

- **Append `/slug` runs to the turn log** (a new route calling `appendRunTurnDirect`).
  Rejected: a second out-of-band allocator racing the exchange is the exact ADR 0491
  incident; the read-only merge gives the model the same knowledge with zero writes.
- **Put run digests in the system scaffold.** Rejected: the scaffold is the cached
  prefix (ADR 0315 byte-stable loop); a status flip would bust the whole prefix every
  turn. Inline pseudo-turns only change bytes at the run's own position.
- **A new `openwop:runs.read` tool instead of D1.** Deferred, not rejected: a tool is
  the right lane for DEEP reads, but the model cannot know to call it for a run whose
  status it has never been shown. D1 is the minimum grounding; `runs.diagnose` stays
  the deep path for failures.
- **Classify the agent-runner side-effecting** (serve the recorded outcome on fork).
  Rejected: WF-RCL-2 made it unclassified on purpose so revocations re-resolve live;
  the right grain is the effect, not the node.

## Phased plan

| Phase | Scope | Gaps |
|---|---|---|
| P1 | D3 guard + manifest row + replay witness through the real `startWorkflowRun` | CHATWF-3 |
| P2 | D1 digests + `turnsToMessages` map + tests (tenant drop, fence, unavailable) | CHATWF-5 |
| P3 | D2 session-run merge + forged-message witness | CHATWF-5 |
| P4 | D4 frontend fixes + tests | CHATWF-1/2/4/6 |
| P5 | D5 binding validation, D6 ratchet | CHATWF-7/8 |

**Implementation record.**

| Phase | Shipped | Witness |
|---|---|---|
| P1 D3 | `runStarter.ts` guard + `queue.run-start` row; `LeaseLostError` re-thrown by the tool provider + agent loop (CHATCD-3) | `chat-run-start-replay-guard.test.ts` (sabotage-checked: 2 reds with the guard removed) |
| P2/P3 D1+D2 | `exchange/runDigests.ts`, `turnsToMessages` digest map, exchange wiring; leading digests as a labelled user-role host note (CHATCD-5) | `chat-run-awareness.test.ts` — route-level through the real exchange + mock provider capture (sabotage-checked both halves), store-level erasure + ranking |
| P4 D4 | server-owned `wf_` runs, `@agent /slug`, load-failed picker, `streamLost`, `cancelError`, stuck-run i18n | `useChatSession.integration.test.tsx`, `workflowMentions.test.ts`, `chatSubmit.test.ts` |
| P5 D5+D6 | bind validation; `catalog-source-a-literal-ratchet.test.ts` | `conversations-route.test.ts` |
| grade-ux | pickers as ARIA comboboxes (`chat/lib/comboboxWiring.ts`), embed gate split, touch targets, rail failures | `composerCombobox.test.tsx`, `EmbeddedChatPanel.gate.test.tsx` |

**Follow-ups (not in this ADR's PR, recorded so they are not mistaken for shipped):**
`CHATCD-7` branched sessions omit the parent's `/slug` runs (fails closed);
`CHATCD-8` `compose-and-run` still registers a transient draft on a `:fork` before
the guarded start refuses (no duplicate run; the draft is runless/GC-eligible);
`CHATCD-9` feature tools that catch run-start errors themselves still flatten a lost
lease; `CHATUX-9` double announcement of a failed run; `CHATUX-10` nested labelled
live regions in the feed;
`CHATWF-9` embedded chat's inert "View progress" + non-persisted runs; `CHATWF-10`
builder link for chain instances (`wf.` ids); a `runs.read` deep-read tool;
surfacing runs started by `compose-and-run` and by the nested agent-runner (their
scope carries no dispatch sink).

## Open questions

- OQ1 — digest cap (8 runs, 1 500 chars output). Chosen to bound prompt growth; revisit
  with context-economy telemetry.
- OQ2 — should a `/slug` run's pseudo-turn be attributed to the user (they started it)?
  Rendered as an assistant-side host fact, matching how feature-tool runs already
  render; the digest text says who started it is irrelevant to the model's use.
