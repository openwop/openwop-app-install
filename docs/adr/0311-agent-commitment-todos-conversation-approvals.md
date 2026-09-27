# ADR 0311 — Agent commitment todos on the kanban board + conversation-linked approval cards in chat

Status: implemented (2026-07-07) — P1–P3 landed; OQ-5 (auto-arming the todo column) deferred to its own review

> Numbering: 0310 is reserved by the canvas-framework rearchitecture analysis.

## Context — the ask, and the correction it needs

The ask (in-conversation plan, 2026-07-07): *(1)* anything an agent says it is
going to do in a chat must land as a card in **its todo column on the kanban
board**, and the agent must report that it did so; *(2)* "the kanban board
handles all HITL and approval notifications"; *(3)* HITL approval cards from
kanban tasks surface **in the app chat** when related to the current
conversation.

**Plan-vs-architecture correction (the one reshape):** clause (2) is honored as
a **view** claim, never a **state** claim. The app already has exactly two
human-review owners — runtime interrupts and pending approvals — and ADR 0068's
unified review projection exists precisely to present them without minting a
third owner (`host/reviewProjection.ts:8` — "NEVER becomes a third state
owner"; actions are DERIVED and dispatched to the sources' existing resolve
paths). Kanban therefore *renders* review state (P3) and *links* to it (the
`boardId`/`cardId` fields approvals already carry); it never stores a decision.
Notifications keep their single emitter (ADR 0010/0050 + the existing
`kanbanAssignmentNotify`).

## Boundaries audit — the proposal is mostly already built (verified)

- **Agent-owned todo columns are ALREADY the work-intake contract.** The roster
  heartbeat lists the agent's boards (`listBoardsForSubject({kind:'agent'})`)
  and picks cards from **the column with id `todo` / name "To Do"**
  (`host/heartbeatService.ts:72-76`), then runs or proposes them under the
  autonomy rules (`auto`/`guided`/`review` → `createApproval`, ADR 0033). The
  ask's exact phrase — "its todo column in the kanban board" — is the existing
  mechanism, not a new one.
- **Agent cards are a designed-for case:** `KanbanCard.source` includes
  `'agent'` with `sourceLabel`/`createdBy`/`dueAt` (`host/kanbanService.ts:57,
  73-91`).
- **Idempotent agent-board provisioning exists:** `ensureSubjectBoard(tenantId,
  {kind:'agent', id})` with a deterministic board id
  (`host/kanbanService.ts:283-297`), and `DEFAULT_COLUMNS` ships the exact
  `todo` column the heartbeat consumes (`:183`).
- **Approvals are already kanban-linked:** `createApproval` takes
  `boardId`/`cardId`/`cardTitle` (`host/approvalService.ts:204-206`); the
  ADR 0025 §4 rule stands — "no new approval store", new kinds join the one
  queue (`PendingApproval.kind`, `:47`).
- **Chat already renders one HITL family inline:** run-interrupt cards
  (`chat/HitlDecisionCard.tsx`, `activeInterrupts`) for the conversation's own
  run. Approvals are the family chat does NOT yet surface — that is the
  genuinely new half of clause (3).
- **The commitment discipline exists:** ADR 0308 P0 (tool-grounded
  commitments) + the deliverable tools + ADR 0309 (schedule-followup). This ADR
  adds the third grounding path; it must not dual-write with the other two.
- **No route/namespace collisions:** no new routes in P1 (a builtin tool); P2
  adds one additive field + a chat read; P3 is FE-only over `/reviews/*`.
- **`host.kanban` is CORE** (untoggled host surface, FEATURES.md:230), so the
  new tool is a **static core builtin** in `agentToolProvider.ts` (core→core —
  the `knowledge.search` precedent), NOT a feature-registered tool; there is no
  toggle to re-check (same posture as `notify-me`, ADR 0308 correction 2).

## Decision

### D1 — `openwop:kanban.add-todo`: the third grounding path for promises

A static core builtin (ADR 0308 D2 enforcement stack unchanged: allowlist
default-deny → Capability Firewall → executor):

- Input `{ title, detail?, dueAtISO? }` (dueAt requires an explicit timezone
  offset — the GC-R3 rule).
- Fail-closed floor: `actingUserId` (human-initiated turn) + `agentProfileId`
  (a specific agent to own the todo) — the ADR 0308 pattern.
- Board = `ensureSubjectBoard(tenantId, {kind:'agent', id: agentProfileId})`;
  column = `todo` (the heartbeat contract). Card: `source:'agent'`,
  `sourceLabel` = persona, `createdBy` = the acting user, deterministic
  content-hashed card id from `(runId, tool, title, detail, dueAtISO)` — the
  GD-0308-1 retry-idempotency pattern.
- The tool result's `note` instructs the model to REPORT the todo (title +
  board) — clause (1)'s "report that it added it", grounded the same way every
  ADR 0308 deliverable reports.
- **The P0 scaffold enumerates the three grounding paths** (amended text): a
  promise is legitimate only when, in the same turn, you *did it* (tools),
  *scheduled it* (ADR 0309), or *filed it as a todo and said so* (this tool).
- **The sleeper consequence (why this composes, not just records):** a card in
  the agent's todo column is what the heartbeat already picks up and
  runs/proposes under autonomy + the approval queue — chat promises become the
  intake funnel for the existing agents-propose work loop with zero new
  orchestration. The ADR 0308 "no promising future work" rule is thereby
  honored: the todo is not a promise to act later, it is a FILED WORK ITEM the
  existing machinery owns from that moment.

**No dual-writes across grounding paths:** time-bound promises → an ADR 0309
job (already visible in Schedules); open-ended intentions → a todo card;
immediate work → tools. One commitment, one record.

### D2 — Conversation-linked approvals surface in chat

- Additive `conversationId?` on `PendingApproval`, stamped by `createApproval`
  callers that HAVE a chat context (the heartbeat path leaves it absent; a
  heartbeat-proposed run originating from a todo card that carries a source
  conversation MAY propagate it — see OQ-2).
- The chat feed loads its conversation's pending approvals **through the
  ADR 0068 projection** (which already applies approver authorization via
  `resolveEffectiveAccess`) and renders an inline card in the
  `HitlDecisionCard` family. Approve/reject call the EXISTING claim/reject
  routes — chat is a renderer, never a decision owner.
- **Authorization asymmetry handled:** conversation membership ≠ approver
  rights. Approvers see the actionable card; other members see a neutral
  "awaiting approval" chip (no proposal detail beyond the card title, no
  actions — no existence-oracle beyond what the conversation already shows).

### D3 — Kanban "Needs review" lane (projection, not rows)

The board UI gains a read-time lane fed by `/v1/host/openwop-app/reviews/*`
(ADR 0068) filtered to the board's linked approvals (`boardId` on the
approval). No card rows are minted per approval; the lane is a view. This is
what "the kanban board handles all HITL and approval notifications" becomes —
the board is where you SEE and ACT on review state, while the queue and the
interrupt store remain the owners.

## Evaluation matrix

1. **Feature-package:** none new — core builtin tool (`host/agentToolProvider`),
   additive field on core approvals, chat + kanban FE surfaces. (The tool is
   core because `host.kanban` is core; a feature package would invert the
   import boundary.)
2. **Toggle:** none — all touched surfaces are untoggled core; the tool is
   allowlist-gated per agent (ADR 0104 grants), which IS its enablement story.
3. **`ctx.<feature>` surface:** unchanged — `host.kanban`'s existing surface
   already covers workflow-side card ops; this ADR adds the CHAT-loop tool.
4. **Node pack:** none new (kanban nodes exist; not this ADR's surface).
5. **Envelopes:** none — tools + an additive read, no new envelope types.
6. **Agent pack:** none; grants ride ADR 0104 overrides (assistant + board
   moderators first, with the ADR 0308 tools).
7. **Public surface:** none.
8. **RBAC/isolation:** tool = acting-user + agent fail-closed, tenant-scoped
   board provisioning (deterministic subject ids); chat approvals =
   ADR 0068's approver authorization, verbatim; IDOR posture unchanged.
9. **Replay/fork:** deterministic card ids (GD-0308-1); the approval
   `conversationId` is stamped at creation and read verbatim.
10. **Frontend:** P2 chat approval card (HitlDecisionCard family + the neutral
    chip); P3 kanban review lane; i18n ×4 both; a11y per the existing card
    patterns.

## RFC verdict

**Host-extension only — no RFC.** No wire surface: a host builtin tool, an
additive field on a host-ext store, FE surfaces over existing host-ext routes.

## Phased plan

| Phase | Scope | Verify |
|---|---|---|
| **P1** | `openwop:kanban.add-todo` (static builtin) + agent-board provisioning via `ensureSubjectBoard` + the P0 three-paths scaffold amendment + tests (fail-closed floor; deterministic id retry; heartbeat-compatible column; scaffold pin) | backend vitest |
| **P2** | `PendingApproval.conversationId` (additive) + chat-context `createApproval` callers stamp it + the chat approval card via the ADR 0068 projection (approver-gated; neutral chip for non-approvers) + i18n ×4 | backend vitest + FE gates |
| **P3** | Kanban "Needs review" projection lane (FE over `/reviews/*`) | FE gates + CT item |

## Alternatives weighed

- **Kanban cards as approval state** — rejected: the third-owner drift ADR 0068
  exists to prevent; falsifier recorded below.
- **A new "commitments" store/feature** — rejected: `task-deck` (ADR 0133)
  already established "a task is a view of an existing run — no tasks table";
  priority-matrix established "an idea IS a kanban card". A commitment IS a
  kanban card.
- **Auto-detecting promises in prose** (no tool; NLP over replies) — rejected:
  unenforceable and non-deterministic; the ADR 0308 posture (scaffold contract
  + tool grounding + eval) is the honest mechanism.
- **Dual-writing a card for every ADR 0309 follow-up** — rejected: two records
  for one commitment drift; a later read-time projection of pending follow-ups
  into the board lane can unify the VIEW without a second write (OQ-3).

## Open questions

- **OQ-1 (roster lifecycle):** an agent board on roster-member deletion —
  follow the ADR 0288 pause-don't-delete posture (cards keep history; the
  heartbeat stops with the member). Decide at P1.
- **OQ-2 (provenance chain):** should a heartbeat-proposed run that originated
  from a chat-filed todo carry the source `conversationId` through card →
  approval, so the approval card surfaces back in the ORIGINATING chat? The
  card would need a `sourceConversationId`. Leaning yes (it completes the
  loop); decide at P2.
- **OQ-3 (unified lane):** project ADR 0309 pending follow-ups read-time into
  the todo lane so the board shows ALL commitments? View-only; decide at P3.
- **OQ-4 (eval):** extend the ADR 0308 incident eval with a "promise → todo
  filed + reported" scenario (floor = the scaffold pin test).

## Falsifier

If a future requirement needs approval state ON cards (not linked from them),
that is the signal to revisit ADR 0068 itself — never to fork it quietly.


## Phase record (implementation, 2026-07-07)

| Phase | Landed |
|---|---|
| P1 | `openwop:kanban.add-todo` static core builtin + `ensureSubjectBoard` agent-board provisioning + `createCard` additive deterministic `cardId` + the P0 three-paths scaffold amendment. **Correction (pre-P1 architect):** a bare todo carries NO workflow — the heartbeat's `if (!workflowId) continue` skips it until armed (test-pinned); full auto-arming is OQ-5, its own review. 6 tests. |
| P2 | The provenance chain: `KanbanCard.sourceConversationId` (stamped from the tool scope) → heartbeat proposal → `PendingApproval.conversationId` → ADR 0068 projection `?conversationId=` (post-authz) → `ConversationReviewsStrip` in chat on the SHARED ReviewCard. **Deviation:** no neutral chip — the projection's authz means non-approvers see nothing (stricter). End-to-end chain test. |
| P3 | `?boardId=` projection filter (post-authz over `provenanceRefs`) + `BoardReviewsSection` on the board page (view, never an owner; renders nothing when empty). Filter positive+negative pinned. |
