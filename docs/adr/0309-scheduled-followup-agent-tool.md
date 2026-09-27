# ADR 0309 — Scheduled follow-through: the `openwop:tasks.schedule-followup` agent tool (ADR 0308 P4)

Status: implemented (2026-07-07)

> Numbering: 0310 is reserved by the canvas-framework rearchitecture analysis.

## Context

ADR 0308 P0 forbids an agent promising future work ("I'll have the report
ready before your meeting") because nothing executes after a chat turn ends —
the promise was structurally unkeepable. This ADR adds the governed way to
KEEP it, deferred from ADR 0308 as P4.

## Boundaries audit (the design fell out of what already exists)

- **Scheduler:** `host/schedulingService.ts` — jobs are Subject-owned, carry
  `metadata` (stamped onto fired runs — including `actingUserId`, which the
  Connections resolver and the ADR 0308 tool scope key off) + `configurable`
  (run variables). `registerJob` already accepts a caller-supplied `jobId`
  (idempotent re-put) and a **`firstFireAtMs`** guarded by
  `MAX_FUTURE_HORIZON_MS` (30 days) — but never *uses* it for `nextFireAt`,
  and the `nextFireAt` doc already anticipates "one-shot/spent" without any
  producer. `markJobFired` (also the daemon's crash-safe advance-before-
  dispatch) recomputes from `cronExpr` and **deletes `nextFireAt` when the
  expression doesn't parse** — the spent state already exists.
- **The dispatch target:** `features/scheduled-agent-chats` (ADR 0125, always-
  on) — `SCHEDULED_CHAT_TURN_WORKFLOW_ID` runs one agent-runner turn with
  variables `{agentId, task, credentialRef, conversationId}`; the reply posts
  back into the conversation as a live assistant turn (`agentRunnerNode`).
- **Cost:** the daemon enforces the tenant autonomous-run budget per fire and
  drops over-budget slots (`scheduleDaemon.ts`).
- **The tool seam:** `registerFeatureAgentTool` (ADR 0308 D2) — allowlist
  default-deny → Capability Firewall → executor, unchanged.

## Decision

### D1 — One-shot scheduling completes the anticipated shape (no new fields)

`registerJob` falls back to `firstFireAtMs` for `nextFireAt` when `cronExpr`
doesn't parse; the follow-up tool registers with the sentinel `cronExpr:
'once'`. On fire, the existing `markJobFired` recompute yields null →
`nextFireAt` deleted → the job is **spent** (row retained, visible in the
owner's Schedules tab, cancellable before it fires by the existing job CRUD).
Zero daemon changes; the crash-safe advance-before-dispatch semantics carry
over verbatim.

### D2 — The tool: `openwop:tasks.schedule-followup`

Feature-registered by `scheduled-agent-chats` (the owner of the workflow it
dispatches). Input `{ task, runAtISO }`. It registers a one-shot job that
fires the existing turn-workflow with the CURRENT agent + conversation:

- **Acting-user-required, and the destination is unforgeable:** the tool takes
  NO conversation input — the chat tool scope now carries the run's
  `chatSessionId` (threaded in `conversationToolLoop` exactly like
  `actingUserId`), so the follow-up can only deliver into the conversation the
  promise was made in. Fail-closed without either.
- **Human gate = the request itself.** The roster autonomy / approval
  machinery ("agents propose, humans dispose") guards UNPROMPTED heartbeat
  work; a user-requested follow-up already has human intent in the turn, and
  cost is bounded at fire time by the autonomous-run budget. Deliberately not
  routed through `createApproval` (which dispatches runs, not job
  registrations) — recorded as the rationale, revisit if agents ever schedule
  unprompted.
- **Idempotent registration:** deterministic `jobId` content-hashed from
  `(runId, tool, task, runAtISO)` — the GD-0308-1 pattern; a provider retry
  re-puts the same row.
- **Bounded:** `runAtISO` must be in the future and inside the existing
  30-day horizon; per-user pending-follow-up cap (10) via
  `listJobsForSubject`; task length bounded.
- **Ownership:** `ownerSubject = {kind:'user', id: actingUserId}` (the human's
  Schedules tab lists + cancels it) with `agentId` attribution; `metadata`
  carries `actingUserId` (flows onto the fired run → the scheduled turn gets
  the same tool scope), the source `runId`, and the tool id.
- **Dispatch key:** managed (`managed:openwop-free`) — scheduled-chat parity;
  no BYOK required at fire.

### D3 — The P0 carve-out (the point of it all)

`TOOL_GROUNDED_COMMITMENTS` changes from "never promise future or background
work" to "…unless you scheduled it with a scheduling tool in this same turn" —
the promise becomes tool-grounded like every other commitment.

### RFC verdict
Host-extension only (scheduler + builtin tool + scaffold text). No wire
change, no RFC.

## Recorded non-ships / follow-ups
- **Completion inbox ping:** the fired turn posts into the conversation (the
  existing live path); an additional `agent.deliverable` notification on
  completion is a follow-up (needs run-completion → notify wiring, not a fire
  hook).
- **Arbitrary-workflow follow-ups:** v1 is frozen-prompt-only (the turn
  workflow); scheduling saved workflows escapes the anti-fabrication framing
  and waits for a real need.
- **Replay note:** the tool executes inside a turn like every ADR 0308 tool;
  the deterministic jobId makes a replayed/retried registration a no-op re-put.

## Phase record

| Phase | Landed |
|---|---|
| P1 (all of it) | landed with this ADR: registerJob one-shot fallback + the tool (features/scheduled-agent-chats/agentTools.ts) + conversationId on the tool scope + the P0 carve-out; 8 tests (scheduled-followup-tool.test.ts) + 187-test neighbor sweep green |
