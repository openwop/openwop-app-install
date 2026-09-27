# ADR 0459 — KickTodo participant-loop chat ignition: KickBot drives replanning the way the Challenge Author drives the factory

Status: implemented
Date: 2026-07-21
Relates: ADR 0458 (the pattern + precedents this ADR reuses wholesale), ADR 0442 (KickBot composition), ADR 0429 (plan flexibility), ADR 0444 (coached sessions), ADR 0419 (accountability), ADR 0068/0074 (approvals), ADR 0104/0315 (tool grants)
TODO refs: `docs/steward/TODO.md §6` KT-PORT-1, KT-PORT-2, KT-PORT-3

## 1. Context

ADR 0458 fixed the creator side of the "chat is the interface" law. The
participant side has the SAME ignition gap, one size smaller:

- **KickBot cannot act** (KT-PORT-1). Its allowlist is read + convene
  (`openwop:kicktodo.{today,progress,circles,convene}` — 5 registrations in
  `kicktodo-core/agentTools.ts`); replanning, schedule changes beyond the
  daypart chip, and recovery are route/page acts. The plan-builder specialist
  *proposes text*; nothing applies it. A participant who tells their guide
  "move my rest days to weekends" gets advice, not a change — advisory
  theater where the PRD promised a coach.
- **Coach plan-proposals are inert rows** (KT-PORT-2). `kicktodo-accountability`
  stores proposals a participant applies via page UI. A proposal IS an
  approval decision addressed to one human — the shared approvals owner and
  the circle's conversation (both already instantiated by this family) should
  carry it as a card with the decision recorded in-thread. The bespoke
  apply-UI is the same class ADR 0458 §2.4 demolished for publication.
- **The session-reminder job carries no `workflowId`** (KT-PORT-3, the
  recorded P0 deferral): the one-shot scheduler job arms correctly through
  the owner but fires into nothing. The delivery node was deferred while pack
  pins were frozen; the pins have moved twice since.

## 2. Boundaries audit (evidence from this session's sweeps)

- Owners all exist and are already ridden by this family: goals/kanban/
  scheduling (enrollmentService), conversations (circleService), approvals
  (communityService/sellerRequestService/publishService precedents),
  notifications (mute-respecting, ADR 0457). No new store, no new route
  namespace (all under the existing `…/kicktodo/*` + `…/circles/*` families).
- The chat mechanics are ADR 0458 P1's, verbatim: tool → `startWorkflowRun` +
  the authoritative `workflow_run` conversation turn; gates render inline;
  decisions persist as `HitlDecisionCard` records.
- `applyPlanRevision` (accountability) is the ONE plan-mutation path coach
  proposals ride today — the ported flow keeps it as the single applier.

## 3. Decision

### 3.1 KickBot gains a bounded ACTION surface (KT-PORT-1)

- New builtin `openwop-app.kicktodo.replan` (small, versioned): read the
  enrollment's real state → generate a bounded revision (schedule preference,
  publisher-declared substitutions, missed-window recovery collapse — ONLY
  the ADR 0429 lanes; never new activities, never evidence-policy changes) →
  closed-world validation against the enrollment's challenge version →
  **`core.chat.approvalGate` in the participant's own conversation** →
  applied through the governed surface (`applyPlanRevision` /
  `setSchedulePreference` / the recovery op). Rejection fails typed
  (`core.fail` branch, the 0458 pattern).
- New tool `openwop:kicktodo.replan` (ACTION): participant-authority — the
  predicate is the *participant's own enrollment* (owner-subject check shared
  with the enrollment routes via one helper, the `hasKicktodoManageAuthority`
  discipline at participant scope); fails typed without an acting user;
  dispatches the run + persists the `workflow_run` turn. Allowlisted to the
  KickBot pack ONLY (never baseline).
- The plan-builder specialist becomes the workflow's generation stage
  (convened with its existing return schema) instead of a dead-end advisor —
  its proposals now flow into the gate.

### 3.2 Coach proposals become approval cards (KT-PORT-2)

- A submitted proposal raises a `kicktodo-plan-proposal` approval kind
  (shared owner; decider = the PARTICIPANT — the inverse of publication's
  SoD: the subject of the change holds the authority) surfaced as a card in
  the circle conversation + the participant's reviews rail. Accept applies
  through `applyPlanRevision`; decline records. The proposals page UI
  shrinks to a read-only history; the bespoke apply buttons are demolished
  with regression pins (the 0458 P4 discipline).

### 3.3 Session-reminder delivery (KT-PORT-3)

- Thin pack node `feature.kicktodo.nodes.session-reminder` (notify circle
  members via the notification owner, mute-respecting per ADR 0457, with the
  session context the job already carries); `sessionService` stamps
  `workflowId` on the armed job. The last borderline-parallel-scheduler
  finding (audit-primitives #2) retires.

## 4. Evaluation matrix (deltas only — everything else inherits)

| Dimension | Verdict |
|---|---|
| Feature-package | EXTENDS `kicktodo-core` + `kicktodo-accountability`; no new package |
| Toggle | none new — rides `kicktodo-core` (user) / `kicktodo-accountability` (tenant) |
| Workflow surface | new ops on existing surfaces (`replanPreview`/`applyRevision` reuse); one new builtin |
| Node pack | `feature.kicktodo.nodes` +2 thin nodes (replan-validate if needed, session-reminder) — minor bump + pin lockstep |
| Agent pack | KickBot allowlist +1 tool; plan-builder prompt gains the generation contract — minor bump |
| Public surface | none |
| RBAC | participant-scope predicate shared route↔tool (one helper); proposal approval decided by the participant only |
| Replay/fork | revision runs carry all inputs; deterministic revision ids (enrollment+revision counter) |
| Frontend | NET-NEGATIVE: proposal apply-UI demolished; no new pages (cards render in chat/rail) |
| Lifecycle | no new stores (proposals/enrollments already erasure-covered in P0); approval rows ride the approvals owner |

## 5. RFC verdict

**Host-extension only — no RFC.** Existing interrupt kinds, existing approval
machinery, packs + builtins. Nothing touches the wire.

## 6. Phases

| Phase | Contents | Gate |
|---|---|---|
| 1 | Replan builtin + tool + shared participant predicate + in-chat gate; E2E test incl. reject | — |
| 2 | Proposal→approval-kind + circle-card + demolition of apply-UI (regression-pinned) | Phase 1 review clear |
| 3 | Session-reminder node + workflowId stamp + fire test | — (independent) |

Each phase: /code-review + /ux-review + fixes; grade sweep at the end (the
0458 rhythm).

## 7. Open questions

- OQ1: may KickBot *initiate* a replan suggestion proactively (heartbeat is
  OFF by design — proposal: no; replan is always participant-initiated in the
  conversation).
- OQ2: does a coach proposal ALSO notify outside the circle conversation
  (proposal: ride the existing notification emit + mute, nothing new).

---

## Implementation record (2026-07-21)

All three phases merged (#2318 P1+P3, #2319 P2) + the grade-fix wave landing
with this record. Scout corrections that reshaped §3.1 (recorded, adopted):
`applyPlanRevision` is a blunt re-materialize owner-checked by CALLERS — the
bounded revision became a closed-world COMMAND LIST over the three ADR 0429
lanes executed via `applyRevisionCommands` (owner-checked FIRST); the
generator is the new `replan-composer` persona with its own `plan-revision`
schema (empty commands = honest cannot-express no-op) — plan-builder's
advisory contract untouched; the participant predicate did not exist and was
extracted (`hasKicktodoEnrollmentAuthority`, four routes refactored onto it).

Phase 2 landed with the inverse-SoD card (participant decides;
`resolveProposal` stays the ONE applier, run BEFORE the approval flips) and
two build-time catches: the reviews-rail visibility gate (the coach's PII
note would otherwise surface tenant-wide) and the quorum fast-path finding
(approverRefs is authz-inert at requiredApprovals:1 — authority lives in the
applier's owner check, verified end-to-end).

Grade sweep: pre-fix code A− / data B− / ux B−; ALL findings fixed:
- **Data Blocker**: the approvals store now has erasure reach for this kind —
  coach erasure REDACTS the note copies in place (card stays decidable),
  participant erasure DELETES the rows. First approval kind with declared
  PII in payload; the store-wide gap is recorded platform debt (the
  `capturedBy` sibling).
- **Dual-path desync**: proposals carry `approvalId`; the retained route
  reconciles the linked card; the FE shows the card pointer only when a card
  exists and honest Apply/Decline buttons ONLY in the degraded no-card case.
- **UX HIGH**: the decision card no longer shows raw lane JSON — a compose-
  time enrich node resolves ids to real activity titles into an additive
  `display` block (apply still reads the raw revision off the compose→apply
  edge), rendered by the new typed artifact-renderer registry (rationale as
  prose, humanized lines, raw commands collapsed). Plus: proposals error
  state, pending chip--warning, `<code>` subjects, rail-fallback copy,
  non-proactive discoverability line (OQ1 holds: replan stays
  participant-initiated).
Post-fix scoped grades: **A− / A− / A−**. OQ2 resolved: proposal decisions
ride the existing notification emit + mute, nothing new.
