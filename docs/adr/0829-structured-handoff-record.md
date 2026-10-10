# ADR 0829 — Structured handoff record: what the receiver needs, stamped once on the log

Status: Accepted — P1–P4 implemented (P5 open)

- **Program:** ROADMAP § "Collaborative orchestration program", item 1 (structured handoffs).
- **Composes:** ADR 0075 (HITL interrupts), ADR 0725 (the `node.suspended`
  diagnostic allowlist and the RFC 0185 §C vendor carry), ADR 0038 §C
  (`host/untrustedContent.ts`, the one fencing seam), ADR 0136 (intent ledger;
  item 2's team ledger will reference this record, not the other way round).
- **Toggle:** none — **always on since 2026-10-07** (maintainer decision). It
  shipped OFF behind `structured-handoffs`, went default ON on 2026-10-06, and
  the toggle was then removed: a stored per-workspace setting could still hide
  the feature. A config row left under the old id is ignored. Runs recorded
  while it was OFF keep no record; a fork never adds one (D4, stamped once).
- **RFC verdict:** host-only. Every key this ADR writes matches the corpus hatch
  `^(openwop-|x-|vendor\.)` on a def that admits it, so it is legal on both
  majors with no spec change. The protocol candidate ("Structured handoff
  context on `agent.handoff`", `openwop` ROADMAP) is gated on THIS prototype:
  shape stable for 30 days in two real workflows, plus a second host asking.
  §8 records the evidence that gate needs.

## 1. Context

When work moves between participants, the receiver has to reconstruct why it
looks the way it does. The program asks every transfer to carry five things:
the intent, the decisions made (and who made them), the open questions, what
was tried, and a confidence.

### What the code does today (measured on `18b1ad87b`)

The ROADMAP row says this item "extends `agent.handoff` emission". **There is
no production `agent.handoff` emission to extend.** The only emitter is
`bootstrap/conformanceMockAgent.ts:226`. The real transfer points are:

| Transfer | Where | What the log records today |
|---|---|---|
| Supervisor → worker | `core.dispatch` loop, `bootstrap/nodes.ts` (sequential ~L520, parallel wave ~L440) | `runOrchestrator.decided {agentId, decision}` then `node.dispatched {childRunId, childWorkflowId, childStatus}`, plus `core.workflowChain.event` under RFC 0037 |
| Agent → human (low confidence) | `agent.decided {decision:'escalate'}` → suspend → `executor.ts` ~L2563 | `node.suspended {interruptId, kind, reason, agentId, threshold, observed}` then `interrupt.requested` |
| Supervisor → human (`ask-user`, RFC 0039 floor) | `core.dispatch` confidence-floor escalation | the clarify interrupt pair, as above |
| Human → human (reassigning a card or an approval) | kanban / approval routing (ADR 0075) | nothing on a run log; host stores only |

The `agents` facet (`spec/v2/facets/agents.schema.json`, `liveRuntime` step 6)
says "a cross-agent handoff emits `agent.handoff`". The app's dispatch loop
transfers between a supervisor agent and worker *workflows*, which is why it
never needed the event. Where the worker resolves to an agent, this ADR starts
emitting it.

### Which carriers are legal (v2 schema, `run-event-payloads.schema.json`)

| Def | Closed? | Hatch? | Usable for the record |
|---|---|---|---|
| `agentHandoff` | yes | **yes** | yes: agent → agent |
| `nodeSuspended` | yes | **yes** | yes: agent → human escalation |
| `interruptResolved` | yes | **yes** | (not needed: the record travels toward the resolver, not back) |
| `interruptRequested` (`suspend-request.schema.json`, every per-kind `data`) | yes | **no** | **no.** The ROADMAP's "rides the clarification or approval interrupt" is not legal today |
| `nodeDispatched`, `runOrchestratorDecided`, `orchestrator-decision` variants | yes | no | no |

`storage/vendorKeyCarry.ts:98` passes a hatch-matching key through unboxed on
the major-2 read, so `openwop-handoff` reads identically on v1 and v2.

## 2. Decision

### D1 — One record shape, versioned, size-capped

```ts
interface HandoffRecordV1 {
  v: 1;
  intent: string;                         // ≤ 500 chars, required
  decisions: { summary: string;           // ≤ 300
               decidedBy?: string;        // opaque, interrupt.md convention
               sourceRef?: string }[];    // eventId or host URL, ≤ 512; ≤ 20 items
  openQuestions: string[];                // each ≤ 300; ≤ 20 items
  tried: { approach: string;              // ≤ 300
           droppedBecause?: string }[];   // ≤ 300; ≤ 20 items
  confidence?: { value: number;           // [0, 1]
                 basis?: string };        // ≤ 300
  producedBy: 'agent' | 'host' | 'human';
}
```

Serialized ≤ 8 KiB. One pure `normalizeHandoffRecord(input): HandoffRecordV1 | null`
truncates over-long strings, drops over-count items, rejects a missing `intent`,
and runs `stripSecretsFromPersisted`. `decidedBy` reuses the opaque-string
convention of `interrupt.md` (`decidedBy` on resume), and adds no identity
shape. `v` exists so the eventual RFC can lift the shape without guessing
which revision a stored record is.

### D2 — Carriers

| Transfer | Carrier | Notes |
|---|---|---|
| Supervisor → worker, worker resolves to an agent | **new** `agent.handoff {fromAgentId, toAgentId, reason?, "openwop-handoff"}` emitted right after `node.dispatched`'s matching `runOrchestrator.decided`, `causationId` = that decided event | `toAgentId` = the worker workflow's bound agent id. Emitted only when both ids match `ids.schema.json#/$defs/agentId` |
| Supervisor → worker, worker is not an agent | child run `metadata["openwop-handoff"]` at dispatch | Free-form `RunOptions.metadata`, surfaces on the child's `RunSnapshot.metadata` |
| Agent → human escalation | `node.suspended["openwop-handoff"]` | Added at the `executor.ts` suspend site as its own field, **not** by widening `SUSPEND_DIAGNOSTIC_KEYS` (that allowlist is for scalar diagnostics; the record is already normalized and redacted) |
| Human → human reassignment | host store on the card / approval, Phase 4 | No run event; nothing on the wire |

> **CORRECTED in P1 (open question 1 resolved).** v2 has no workflow-level
> agent binding (`workflow-definition.schema.json` has no `agent` property), so
> "the worker workflow's bound agent id" does not exist to read. Row 1 now
> fires only when the supervisor NAMES the receiver:
> `handoffs[workerId].toAgentId`, valid per `ids.schema.json#/$defs/agentId`
> and different from the supervisor. The host never infers it. Every dispatched
> worker gets row 2 regardless.

The interrupt request stays untouched. When the RFC lands it can add a field
there, and the app emits both locations for one sunset window.

### D3 — Who produces the record

- **Supervisor output.** The supervisor's output MAY carry
  `handoffs: { [workerId]: HandoffRecordInput }` beside `decisions`. It sits
  outside `decision`, because every orchestrator-decision variant is closed.
- **Host fallback (always).** When the supervisor gives none, the host builds a
  minimal record with `producedBy: 'host'`. `intent` comes from the decision's
  `reason` (or the run's workflow name), and `confidence` comes from the
  decision's `confidence`. Lists are empty. A thin record is honest; an invented
  one is not.
> **CORRECTED in P1.** The only agent → human escalation production reaches
> is `core.dispatch`'s RFC 0039 confidence-floor breach (a `clarification`
> suspend). The `agent.decided` low-confidence suspend in §1's table is
> emitted only by `conformanceMockAgent`. So P1 builds the escalation record
> from the supervisor's own `handoffs[workerId]` when given (else the host
> fallback), with `confidence = {value, basis: "below the escalation floor
> <f>"}`. The carrier is generic: any suspended `NodeOutcome` may set
> `interrupt.handoff`, and the executor writes it onto `node.suspended`. The
> bullet below describes a live-agent escalation for when one exists.

> **CORRECTED (gate, ADR 0702 payload ratchet).** The host fallback took
> `intent` from the decision's `reason`, but a conforming `NextWorkerDecision`
> has no `reason` (`orchestrator-decision.schema.json`: only `terminate` does).
> P1's tests used `reason` on next-worker decisions, and because the host copies
> the decision verbatim into `core.workflowChain.confidence-escalated`, the
> payload ratchet flagged that event as a new wire violation. Fixtures now
> send conforming decisions. The fallback intent is `Dispatched to <worker>`;
> `reason` is still read, tolerantly, for a non-conforming supervisor. So a
> useful intent needs the supervisor to supply `handoffs[workerId]`.

- **Escalations.** `intent` = the task the agent was given (first 500 chars,
  neutralized). `confidence = {value: observed, basis: "below threshold <t>"}`.
  `tried` = the tool calls the agent made this invocation (names only, not
  arguments).
- **Humans (Phase 4).** A prefilled draft the person edits before sending.
  Nothing is sent without that confirmation.

### D4 — Stamped once, never recomputed

The record is part of the event it rides. Replay and `:fork` re-read it from
the log. A resume or a re-entrant dispatch pass MUST NOT emit a second
`agent.handoff` for the same `(runId, nodeId, iteration, workerId)`. That reuses
the persisted-iteration discipline `core.dispatch` already applies to
`__runOrchestratorIteration`.

> **CORRECTED in P2 — the resume leg asserted the wrong invariant.** "No second
> `agent.handoff` after a resume" is false by design: each re-entrant
> supervisor → dispatch pass is a NEW orchestrator turn with its own
> `runOrchestrator.decided` (and, at version ≥ 5, the next `iteration`). The
> invariant that holds, and that P2 tests, is one `agent.handoff` per
> (`runOrchestrator.decided`, worker), each caused by its own decided event.

### D5 — The receiver reads it as untrusted data

When an agent receives a record (agent → agent via `agent.handoff`, or a child
run's metadata), it reaches the model only through `host/untrustedContent.ts`
(`neutralizeUntrusted` + `fenceUntrustedItems`), never as instructions. Another
model wrote the text, so a handoff is a prompt-injection path between agents.

### D6 — Surfaces

- `RunHandoffMap`: a handoff chip expands to show the record.
- The interrupt card for a low-confidence escalation shows the record above the
  resume form.
- A channel card when a handoff crosses to a person (Phase 4, ADR 0126 channels).

## 3. Alternatives weighed

- **Put the record in `decision` on `runOrchestrator.decided`.** Rejected: the
  variants are closed with no hatch. It would fail validation on both majors.
- **Put it in interrupt `data`.** Rejected for now: every per-kind `data` def is
  closed with no hatch. This is the protocol's gap to close, not the app's to
  work around.
- **A vendor event type (`vendor.openwop-app.handoff.recorded`).** Legal, but it
  splits one transfer into two events and gives the RFC nothing to lift onto
  `agent.handoff`. Rejected.
- **Emit `agent.handoff` with `toAgentId = childWorkflowId`.** Rejected: it would
  claim a workflow is an agent.

## 4. Phased implementation

| Phase | Scope | Exit |
|---|---|---|
| P1 | `features/structured-handoffs/` (toggle, types, `normalizeHandoffRecord`, size and redaction tests). Emission on the escalation suspend (D2 row 3) and on `core.dispatch` (rows 1–2), with the D4 idempotency | Unit tests on normalize; executor test that a low-confidence run's `node.suspended` carries the record; `:fork` test that the forked log's record is byte-identical; resume test that emits no second `agent.handoff`; toggle-OFF test that no payload changes. **P1 shipped all but the `:fork` and resume legs**: D4 holds by construction (one record per `runOrchestrator.decided` record, and the child's copy is written with the child run), but those two legs are owed and move to P2 |
| P2 | Receiver context (D5) | Test that the worker agent's prompt contains the fenced record and that a payload containing `END UNTRUSTED CONTENT` stays fenced |
| P3 | UI (D6, first two bullets), i18n in four locales | Component tests; `/ux-review` |
| P4 | Human-drafted handoffs on card / approval reassignment; channel card | Draft is never sent unconfirmed (test) |
| P5 | Evidence for the protocol gate (§8) | **Instrumented 2026-10-07** (`features/structured-handoffs/evidence.ts`, `host/usageEvidence.ts`): one usage row per (tenant, workflow) whose runs write a record, with the record versions seen; `GET /host/openwop-app/structured-handoffs/evidence` (superadmin) reports which workflows meet the bar (span ≥ 30 days, ≥ 8 active days, one record version) and whether two do. Card notes are not counted. The other half, a second host asking, is outside the app. Test: `test/collab-tripwire-evidence.test.ts` |

## 5. Security and replay checklist

- [x] Redaction: `stripSecretsFromPersisted` before every append (D1).
- [x] Prompt injection: the record reaches a model only fenced (D5).
- [x] Caller-writable key: root-run `metadata` is set by the `POST /v1/runs`
      caller, so a caller can supply their own `openwop-handoff`. Accepted:
      `readHandoffRecord` re-normalizes it at run start, `producedBy` is a
      claim (an unknown value reads as `human`), and the note reaches a model
      only fenced (D5). It grants nothing a caller could not already put in the
      task.
- [ ] Tenant: the record is written into the run's own log and the child's own
      metadata; it never crosses a tenant boundary (the child inherits the
      parent tenant, `subWorkflowDispatcher`).
- [x] Replay / fork: recorded, never regenerated (D4).
- [x] Size: an 8 KiB cap, so a chatty supervisor cannot bloat the log.

## 6. Open questions

1. How does a worker workflow name its "bound agent"? First answer to test in
   P1: the agent id of its first agent node. If that proves ambiguous, fall
   back to child-run metadata only (D2 row 2).
2. Should `tried` on escalation include tool *outcomes* (ok/error), not just
   names? Outcomes help the human; arguments stay out regardless.
3. Phase 4 needs the reassignment hook on kanban cards and ADR 0075 approvals;
   confirm both have one seam.
   **Answered in P4.** Cards: yes, one seam, `POST /kanban/cards/:cardId/assign`
   (ADR 0049), which already carried a `comment` and the assignee notification.
   Approvals: **no**. An approval is never reassigned one at a time; ADR 0075's
   `approval-delegations` is a standing coverage window (from → to, start/end,
   `reason`), not a transfer of one piece of work, so a per-transfer note does
   not fit it. Approvals are out of scope for this ADR. The channel card (D6,
   third bullet) is deferred: the assignment already reaches the assignee as an
   inbox notification, which now carries the note's intent.

## 7. Implementation record

| Phase | Commit | Tests |
|---|---|---|
| P1 | `feat/structured-handoffs` (this branch) | `test/adr0829-structured-handoff.test.ts` (10): normalize bounds and redaction; toggle OFF changes nothing; ON stamps every child and emits `agent.handoff` only for a named agent, caused by its `runOrchestrator.decided`; parallel wave emits in worker order before any child; escalation record rides `node.suspended` through `executeRun` and never `interrupt.requested`; v2 `$defs` admit the key and the v2 projection keeps it flat. **Sabotage-witnessed:** an unhatched key name (`handoff`) is boxed under `vendor.openwop-app` and fails the flat-key leg; deleting the executor spread fails the `node.suspended` leg |

| P2 | `feat/structured-handoffs-p2` (stacked on P1) | `test/adr0829-handoff-receiver.test.ts` (10): the prompt block is one fence and a payload cannot close it or forge `Task:`; `readHandoffRecord` re-normalizes and downgrades an unknown producer; the live dispatch puts the fenced note before `Task:`; `agentRunnerNode` passes it only with the toggle ON; re-entrant passes emit one handoff per (decided, worker); `:fork` over the real route copies the record byte for byte (read back from storage). **Sabotage-witnessed:** dropping the composition, dropping neutralization, and ignoring the toggle each go red |

| P3 | `feat/structured-handoffs-p3` (stacked on P2) | `frontend/react/src/runs/__tests__/handoffNote.test.tsx` (7): the reader refuses malformed shapes and downgrades an unknown producer; the card renders every part and markup in a note stays text; a strip chip with a note is a disclosure button (`aria-expanded`) that opens and closes the card; a chip without one stays inert; an escalation's note (on `node.suspended`) attaches to its escalation chip. **Sabotage-witnessed:** a strip that never reads the note fails both disclosure legs. Full frontend `npm run build` green (typography and raw-button ratchets held at baseline) |

| P4 | `feat/structured-handoffs-p4` (stacked on P3) | Backend `test/adr0829-card-handoff.test.ts` (8, real HTTP for the route): toggle OFF ignores the note; ON stores it normalized with author and time; a note with no intent is a 400; every reassignment replaces the note and unassign clears it; DSAR erases it when the subject WROTE it on a card that is otherwise not theirs, or is named in a decision, or the card is theirs, and leaves it otherwise. Frontend `kanban/__tests__/handoffAssign.test.tsx` (8): ON opens the dialog and sends nothing; "with note" sends the draft, "without note" sends none, cancel sends nothing; OFF assigns in one step; an empty intent cannot be sent; the card shows the note behind a disclosure. **Sabotage-witnessed:** an eraser without the assigner check, a role path that drops the note, and a picker that ignores the toggle each go red |
| P4 (confidence) | `feat/handoff-note-confidence` | A person's note can carry a confidence, picked as low / medium / high (stored 0.3 / 0.6 / 0.9) with an optional reason; the card shows the word, not a percentage, for a human note. `kanban/__tests__/handoffAssign.test.tsx` (+3: the level maps and an unset level sends none; the dialog sends what was picked; the card shows the word) and `e2e/handoff-ledger.spec.ts` (picks Medium, reads it back after a reload). **Sabotage-witnessed:** the dialog dropping the pick, and the card showing a percentage, each go red |

P4 files: `host/kanbanService.ts` (`handoff`/`handoffBy`/`handoffAt` on
`KanbanCard` and its patch; the DSAR eraser checks the note on its own, because
the assigner may be neither the card's creator nor its assignee),
`routes/kanban.ts` (the assign route takes `handoff`; the notification falls
back to its intent), `kanban/HandoffDialog.tsx`, `kanban/AssigneeControl.tsx`
(dialog only for a person and only with the toggle ON; click and keydown
stopped at the wrapper because the portaled dialog still bubbles through the
React tree to the draggable card), `kanban/CardHandoffNote.tsx` (board card and
the assignee's mirror), four locales.

P3 files: `runs/handoffNote.ts` (defensive reader), `runs/HandoffNoteCard.tsx`
(the one renderer: `.surface-card`, a source `.chip` with icon and label,
plain-text body), `runs/RunHandoffMap.tsx` (disclosure chips via `ui/Button`),
`runs/RunDetailPage.tsx` (an open escalation's note above `RenderInterrupt`,
matched by `interruptId`; a child run's received note), `styles/global.css`
(`.handoff-note*`, `--text-*` scale only), four locales. `/ux-review` was not
run; the card was checked by hand against DESIGN.md §5.1–5.3 and §10–11
(heading order fixed: the run page passes `headingLevel={2}`).

P2 files: `host/handoff/handoffRecord.ts` (`readHandoffRecord`,
`handoffPromptBlock`), `executor/types.ts` + `executor/executor.ts`
(`ctx.handoff`, read at ctx build like `trustBoundary`),
`host/agentDispatch.ts` (`LiveDispatchDeps.handoffNote`, a turn that read it
is tagged untrusted-derived), `host/agentRunnerNode.ts` (the toggle gate).

P1 files: `src/host/handoff/handoffRecord.ts` (core, pure plus the toggle
read), `src/features/structured-handoffs/feature.ts` (toggle default only; in
`distributions/bundles.json` `core`, because orchestration substrate is not a
paid bundle), `bootstrap/nodes.ts` (`core.dispatch`),
`executor/subWorkflowDispatcher.ts` (`childMetadata`), `executor/types.ts` and
`executor/executor.ts` (the suspend carrier).

## 8. Protocol-gate evidence (for the `openwop` RFC)

The `openwop` ROADMAP gate is "stable for 30 days in two real workflows, and a
second host asks for it". Record here:

- the two workflows (chain pack ids) that carry the record in production;
- the date the shape last changed (any change to `HandoffRecordV1` restarts the 30 days);
- the second host's request (link).

When all three are filled, open the RFC in `openwop` (`/prd handoff-context`).
It should standardize `agentHandoff.handoffContext` plus a field on the
interrupt request (the gap in §1), behind a capability.
