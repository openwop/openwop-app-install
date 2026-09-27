# ADR 0288 — Completing the lifecycle-seam family: roster + conversation

Status: implemented (Phase 1 roster — #1372; Phase 2 conversation — this PR)

## Context

Grade-data items **AGT-1** and **CHAT-1** (`docs/steward/DATA-ASSESSMENT.md`) are the last two
deletion flows whose feature-owned soft references had no cleanup mechanism:

- **Roster deletion**: `host/rosterCascade.ts` hand-cleans everything the HOST owns
  (boards, schedules, approvals, chat agent, org-chart, pins, profile, knowledge,
  memory, twin grants) but cannot reach FEATURE-owned refs — scheduled chats
  (`ScheduledChat.agentId`), public widgets (`WidgetConfig.agentId`), advisory-board
  membership (`advisors[]` / `moderatorRosterId`).
- **Conversation deletion**: the chat delete route cascades messages (the one SQL FK)
  and the conversation-meta sidecar, but orphans the host sidecars (feedback,
  reactions, read-state, exchange-idempotency) and the feature sidecars
  (intent-ledger's per-conversation row; comments on the deleted messages).

The pattern for this is established three times over (`commerce/productLifecycleSeam.ts`
#1337, `host/crmRecordLifecycle.ts` ADR 0283, `host/connectionLifecycle.ts` ADR 0285)
and is a documented ARCHITECTURE.md seam-table row. Rather than two more boilerplate
ADRs, this ONE record completes the family with the two remaining seams and their
per-consumer dispositions.

**Audit correction (AGT-1 scope):** `voice:realtime-config` was listed as a blind spot;
it is keyed by tenantId with no agentId (the per-tenant provider binding) — never a
roster ref. Dropped.

## Decision

Two new seams, identical contract to the family (keyed registration — repeat boots
overwrite; idempotent bounded handlers; best-effort fan-out that never throws; fired
AFTER the owning deletion so partial failure fails closed):

### `host/rosterLifecycle.ts` — `onRosterMemberDeleted({tenantId, rosterId, agentId?})`
Fired at the END of `deleteRosterMemberCascade` (the hand-rolled host cascade STAYS —
host-internal cleanups need no seam). Configs may store either id form; consumers match
both.

| Consumer (key) | Disposition |
|---|---|
| `scheduled-agent-chats` | **DISABLE** — chat `enabled:false` + its scheduler job disabled; the authored prompt/cadence survives visibly paused; re-assigning an agent is a resume |
| `chat-widget` | **DISABLE** — a widget is a live public credential: serving stops immediately, the authored config (domains/caps/token) survives for re-assignment |
| `advisory-board` | **PRUNE** — drop from `advisors[]`; clear a matching `moderatorRosterId`. The board survives (an emptied board is visible breakage the owner resolves — never silently deleted) |
| evals arena rows, proposals, ambient-work-graph suggestions, comment authorship | **TOLERATE ON READ** — historical provenance on append-only records; cleaning would destroy history |

### `host/conversationLifecycle.ts` — `onConversationDeleted({tenantId, conversationId, messageIds})` (Phase 2)
Fired by the chat session delete route AFTER the session + meta are gone (`messageIds`
captured pre-delete). The four HOST-owned sidecars (feedback, reactions, read-state,
exchange-idem) are cleaned by DIRECT calls in the route path — host-imports-host needs
no seam; the seam exists for the feature-owned two:

| Consumer (key) | Disposition |
|---|---|
| `intent-ledger` | **PRUNE** — point-delete the `${tenantId}:${conversationId}` row (a mission record for a gone conversation is meaningless) |
| `comments` | **PRUNE** — delete `chat_message`-typed threads on the deleted messages (user content with no reachable surface) |
| evals ratings (feedback-derived), publishing/forms conversationId meta | **TOLERATE ON READ** — derived/historical |

## Alternatives weighed

- Extending the host cascades to import features directly — the boundary inversion the
  whole family exists to avoid.
- One generic "entity deleted" bus — rejected across all five seams: typed per-domain
  events keep handlers honest and greppable; a stringly-typed generic bus invites
  silent mismatches.
- Per-seam ADRs (as 0283/0285 did) — the pattern is now established convention; one
  family-completing record with the disposition tables carries the decision content
  without boilerplate.

## Phase → artifact

| Phase | Artifact |
|---|---|
| 1 (roster) | `host/rosterLifecycle.ts`, `rosterCascade.ts` fire, consumers in scheduled-agent-chats/chat-widget/advisory-board, `test/roster-lifecycle.test.ts` |
| 2 (conversation) | `host/conversationLifecycle.ts`, chat delete-route direct sidecar cleanup + fire, consumers in intent-ledger/comments, tests |
