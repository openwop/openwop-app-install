# ADR 0230 — Planning governance wiring: audit rows, lifecycle events, activation gate, version snapshots

Status: implemented (P1–P4, 2026-07-03 — see § Phases; score-history READ surfacing deferred to C7 as planned)

> **Correction (2026-07-03, follow-on batch):** the C7 score-history READ surfacing now
> shipped — the `ScoreHistorySection` in `IdeaIntakePanel.tsx` reads the score-change
> rows this ADR persists (see ADR 0234 correction). The write side (audit rows) was
> already implemented here; the read UI closes the loop.

Date: 2026-07-03
Relates to: ADR 0079/0080 (Strategy), ADR 0058–0061 (Priority Matrix), ADR 0208 (host-event dispatcher), ADR 0028 (audit/governance view), ADR 0066 (the CMS approval-gate composition precedent), ADR 0070/0075/0198 (quorum/routing/delegation), docs/research/strategy-gap-analysis.md (Phase B)

## Context

The strategy gap analysis (E7, grade C+) found the planning features stand
*beside* an A-grade governance substrate and call none of it: no `strategy` or
`priority-matrix` mutation writes an audit row, emits a lifecycle event, or can
be stage-gated; a strategy has no version history; a priority score changes
without a trace. The CRM remediation (ADR 0208 §3, `features/crm/emit.ts`) and
the CMS editorial gate (ADR 0066, `features/cms/contentApproval.ts`) already
established the exact composition patterns — this ADR adopts them for the
planning cluster. **No new orchestration, no new stores beyond append-only
revision/score-history rows, no wire change.**

## Decision

### B1 — Mutation side-channel: audit + host events (one module per feature)

`features/strategy/emit.ts` (`strategyMutated`) and
`features/priority-matrix/emit.ts` (`priorityMutated`), mirroring
`features/crm/emit.ts` verbatim in shape: ONE call per mutation path doing

1. `emitHostEvent({ type: 'host.strategy.<entity>.<verb>', tenantId, payload })`
   — ids-only payloads (id, orgId, changed-field names; never narrative
   content), fire-and-forget by contract. Event catalog:
   - `host.strategy.strategy.{created,updated,activated,paused,completed,archived,deleted}`
   - `host.strategy.links.updated`
   - `host.priority.list.{created,updated,deleted}` ·
     `host.priority.idea.{submitted,scored,voted,scheduled}` ·
     `host.priority.session.{created,decided}`
2. `hostExtStorage().appendAudit({ action: 'strategy.<verb>' | 'priority.<verb>',
   principalId: actor, resource, outcome, payload: { tenantId, orgId } })` —
   `payload.tenantId` REQUIRED (the governance view fail-closed filters on it).

Actor discipline: the HTTP principal for routes; `run:<runId>` when a mutation
arrives through a `ctx.features.*` verb — the audit row then links to replay
provenance. Called from **both** entry paths (routes AND surface verbs), the
ADR 0208 §3 rule.

### B2 — (covered by B1's host events; no second mechanism)

Webhook fanout + event→workflow bindings ride `emitHostEvent` — external
systems subscribe or bind workflows with zero new plumbing. Event types are
host-extension-namespaced (RFC 0086 §E); nothing touches the OpenWOP wire.

### B3 — Strategy activation stage-gate + protected-field re-approval

A new **`strategy-approval-gate`** toggle (OFF by default, `tenant`-bucketed —
the `cms-approval-gate` shape: no routes of its own, composes the shared
approval queue):

- **Submit side** (`queueStrategyActivationIfGated`, one owner shared by the
  PATCH route and any future verb): when the gate is ON and a PATCH moves
  `status` `draft→active`, do NOT transition; queue a
  `kind:'strategy-activation'` `PendingApproval` (new kind on
  `host/approvalService.ts`'s union + a `createStrategyActivationApproval`),
  keyed to the strategy (`strategyId`, `orgId`, title as the proposal line).
  Dedup via a pending-approval-for-strategy check (the
  `hasPendingApprovalForPage` pattern).
  **Mixed-patch semantics (architect Q2, 2026-07-03):** a gated PATCH that
  changes other fields AND requests activation applies the other fields,
  keeps `status:'draft'`, queues the approval, and the read/patch responses
  carry a PROJECTED `activationPending: true` (computed from the pending
  lookup, never stored — the entity enum and replay posture are untouched).
- **Decide side** (`features/strategy/activationApproval.ts`, registered on a
  core handler hook at boot — the ADR 0066 direction rule: feature → core
  only; dispatched from the per-kind branch in `host/approvalDecision.ts`,
  the single decision core, in BOTH the claim and reject paths): enforce org
  RBAC + IDOR (decider needs `host:members:manage` in the strategy's org —
  same bar as content-publish), CAS-resolve the approval, then transition the
  strategy to `active`; **compensate** (reopen) if the transition fails — the
  ADR 0066 HIGH-1 lesson, kept.
- **Protected-field re-approval (architect Q4, 2026-07-03 — visible
  auto-revert, not 409):** with the gate ON, editing `objectives`, `period`,
  `planningHorizon`, or `accountableExecutive` on an **`active`** strategy
  reverts `status` to `draft` so re-activation re-queues the approval. A 409
  was rejected because it trains callers to deactivate→edit→reactivate
  around the gate. The revert is visible, never silent: the response body
  returns `status:'draft'`, the audit row and the
  `host.strategy.strategy.updated` event both carry the changed-field list +
  `autoRevertedToDraft: true`. Gate OFF ⇒ every path byte-identical to today.
- Quorum, routing, and delegation come **free** from the shared inbox
  machinery (ADR 0070/0075/0198) — an executive sign-off with named approvers
  is a `QuorumPolicy` on the approval, not new code.

### B4 — Version snapshots + score history (append-only, no new storage concept)

- **Strategy revisions:** on every content-bearing PATCH and on `replaceLinks`,
  append a `StrategyRevision` row (revision n, snapshot of the strategy body,
  actor, timestamp) with distinct-content dedupe — the CMS version pattern.
  Storage (architect Q3): its own `DurableCollection('strategy:revision')`
  keyed `${tenantId}::${strategyId}::${n}` **with a tenant secondary index**
  (the CRMGAP-3 rule — per-tenant slices, never cross-tenant scans). The
  append happens AFTER the successful `strategies.put` (snapshot what
  persisted), and the dedupe hash EXCLUDES `updatedAt`.
  `GET /strategy/:id/versions` (read-gated like `GET /:id`) + `POST
  /:id/versions/:n/restore` (write + config-authority when the restore changes
  config-sensitive fields). Soft cap: keep the latest 50 revisions per
  strategy (prune oldest; the cap is an implementation guard, not policy).
- **Priority score history:** `IdeaScoreChange` append-only rows (listId,
  cardId, prior/new computedPriority + per-criterion values, actor, timestamp)
  written by `setIdeaScore`/vote application. Read surfaced later by C7 (this
  ADR only guarantees the trail exists).

## What this deliberately does NOT do

- No dashboards, no notification digests (Phase C), no journey/cadence chains.
- No `strategy.*` **wire** events — everything is host-ext (`host.*` types).
- No parallel approval path — ONE queue, ONE inbox, ONE handler hook.
- No mutable version rows — revisions/score-history are append-only.

## Phases

| Phase | Deliverable | Verification |
|---|---|---|
| P1 | `strategy/emit.ts` + calls from every route/verb mutation | route test: mutation ⇒ audit row + captured host event |
| P2 | `priority-matrix/emit.ts` + calls | same |
| P3 | `strategy-approval-gate` toggle + submit/decide/re-approval | route tests: gated activation 202-queues; decide flips; reject reverts; OFF ⇒ unchanged |
| P4 | revisions + score history + versions routes | route tests: PATCH appends revision; dedupe; restore; cap |

RFC gate: host-extension only — **no new RFC** (host-event types are RFC 0086
§E-namespaced; the approval kind is host-internal).
