# ADR 0854 — Approval handoffs, and a channel card when a handoff reaches a person

Status: Accepted (maintainer decision 2026-10-07: hand-offs only to people already eligible) — P1–P2 implemented

- **Program:** ROADMAP § "Collaborative orchestration program", item 1 — the two
  open items ADR 0829 left: handoffs on approvals (out of its scope) and the
  channel card (its D6, third bullet, deferred).
- **Composes:** ADR 0829 (the handoff record and `normalizeHandoffRecord`; the
  `host/handoff/handoffObservers.ts` seam), ADR 0075 / 0070 (approvals, quorum),
  ADR 0198 (`approval-delegations`, the one eligibility join in
  `host/approverResolution.ts`), ADR 0852 D5 (a project's chat or bound channel).
- **Toggle:** `structured-handoffs` (default ON).
- **RFC verdict:** host-only.

## 1. Context

ADR 0829 found approvals are never reassigned one at a time:
`approval-delegations` is a standing coverage window, so a per-transfer note had
nowhere to attach. But "can you take this one?" is real: an eligible approver who
should not decide (conflict, missing context, away) has no way to hand ONE
approval to another eligible person with the context they would need.

ADR 0829's channel card was deferred because the assignee's inbox notification
already carries the note's intent. That serves the assignee and nobody else: the
rest of the project does not learn that work changed hands, or why.

## 2. Decision

### D1 — "Ask someone else to decide" (one approval)

- `POST /approvals/:approvalId/handoff {to, note}` by a person who is ELIGIBLE for
  that approval (`isEligibleApprover`). `to` must ALSO be eligible under the
  same resolution — **a handoff moves the work and adds a note; it never grants
  authority**. An ineligible `to` is a 422 naming why ("not an approver for this
  request"), never a silent success.
- The approval records `handoff: {to, by, at, note}` (the note is a
  `HandoffRecordV1`, `producedBy:'human'`, normalized and redacted by ADR 0829's
  builder). One active handoff; a new one replaces it.
- Effects: `to` gets an inbox notification carrying the note's intent; the review
  card shows the note (`<HandoffNoteCard>`). The handing person stays eligible
  (no lock-out, the ADR 0198 rule).
- The vote is unchanged: it records who acted (`actedBy`) and whom they counted
  as (`countAs`) as today; the handoff is context, not a vote.
- DSAR: the note is the handing person's free text — erased with them, like a
  card note (ADR 0829 P4).

### D2 — A channel card when a handoff reaches a person

A `handoffObservers` subscriber posts ONE host card into the project's chat (or
the project's bound channels) when a handoff note is recorded on work that
belongs to a project: a card note on the project's board, an approval handoff on
a stamped run, a run escalation on a stamped run. The card says who handed what
to whom, the intent, and links to the work; it never includes the decisions or
"tried" text (those stay with the assignee and the work). Idempotent on the
handoff's ref; nothing is posted for work outside a project.

## 3. Phased implementation

| Phase | Scope | Exit |
|---|---|---|
| P1 | D1 route + record + notification + review-card note + DSAR | Tests: eligible → eligible succeeds; ineligible caller 403; ineligible `to` 422; the handing person can still vote; the vote shape is unchanged; erasure |
| P2 | D2 card | Tests: one card per ref in the project chat and each bound channel; nothing outside a project; the card carries no decisions/tried text |

## 4. Implementation record

| Phase | Branch | Evidence |
|---|---|---|
| P2 | `feat/handoff-cards` | `features/structured-handoffs/handoffCards.ts` via the handoff observer seam; posting through `host/projectConversations.ts` (shared with ADR 0855 D3). `adr0854-handoff-cards.test.ts` (3, card leg over real HTTP). **Sabotage-witnessed:** no dedupe |
| P1 | `feat/approval-handoffs` | `POST /reviews/:id/handoff` + `GET`, in `features/structured-handoffs/approvalHandoffs.ts`. Both ends checked through the review projection (caller can decide + holds respond; target sees it as themselves, holds respond, and is not ruled out by the approver list); decide routes unchanged. `adr0854-approval-handoffs.test.ts` (3, a real approval gate with an approver list), frontend `reviewHandoff.test.tsx` (3). **Sabotage-witnessed:** no target check, no caller check, the approver list ignored, send without an intent. **CORRECTED:** the review card's note is a section of the card (`<ReviewHandoff>`), not a separate surface; the target's eligibility for an inbox approval that is not a quorum with a declared list is "can see it + holds respond" (the projection computes no stricter `canDecide` there; the decide route still applies its per-kind rules) |
