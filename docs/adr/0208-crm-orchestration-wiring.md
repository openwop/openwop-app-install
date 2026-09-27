# ADR 0208 — CRM orchestration wiring: host-event dispatch, governed write verbs, agents + chain pack

Status: implemented (P1 host-event dispatcher + bindings + emissions/audit; P2 write verbs + feature.crm.nodes v1.2.0; P3 feature.crm.agents + crm-ops chain pack — CRM gap analysis §5 C1/C2/C7-audit)
Date: 2026-07-03
Depends on: ADR 0008 (CRM full port, amended), ADR 0014 (workflow surface), ADR 0034 (trigger ingestion), ADR 0058 (chat-drivability = agent + nodes), ADR 0152 (chain-pack loader), ADR 0162 (deterministic idempotency keys), RFC 0086 §E (host-extension event namespace), RFC 0013 (workflow chain packs).

## Context

The CRM gap analysis (docs/research/crm-gap-analysis.md §3 E5) found the app owns a
production workflow engine, yet CRM records can neither trigger workflows nor be
mutated by them: the only emitted event is `openwop-app.crm.contact-triaged`, `ctx.features.crm`
is read-only (5 methods), and no CRM agent or chain pack exists.

**Survey facts that shaped the design (verified in-code):**
- `getEventLog().append` REQUIRES a `runId`; webhook tenant scoping is derived via
  `storage.getRun(event.runId)` (`routes/webhooks.ts:246-248`). A record-change event has
  no run; synthesizing one per CRUD write is unacceptable, and a sentinel runId corrupts
  per-run sequences and collapses tenant scoping to `'default'`.
- The `core.trigger.event` trigger shape (packs/core.openwop.triggers) documents a host
  "event bus dispatch" that was **never implemented** — nothing subscribes the event log
  into trigger ingestion; external ingestion wires only `source ∈ {webhook,email,form}`
  (`triggerIngestionService.ts:61`).
- The RFC 0099 `/v1/trigger-subscriptions` source enum is wire-governed — extending it
  with `event` would need an RFC in `../openwop` first.
- Agent-pack manifests (RFC 0003) have no per-tool approval field; the established safe
  pattern is a read-only allowlist + mutations behind `core.chat.approvalGate` DAG nodes
  in chains (`exec-ops.board-update` precedent). Roster-profile `hitl[]` classes exist but
  apply only to standing `host:` agents.
- Chain packs auto-load from `examples/workflow-chain-packs/*` at boot (ADR 0152); chains
  are inline in `pack.json` and reference only published node typeIds.

## Decision

### 1. `host/hostEventDispatcher.ts` — the ONE host-event seam (C1)

A small host module — not CRM-private, deliberately reusable by any feature:

- `emitHostEvent({ type, tenantId, payload })` (fire-and-forget, never throws):
  1. **Webhook fanout** through the existing seam: `storage.listWebhooks({ eventType: type, tenantId })`
     → the same signed `enqueueDelivery` path `routes/webhooks.ts` uses (the enqueue
     helper is exported/shared, never duplicated). Delivered body:
     `{ eventId, type, tenantId, payload, timestamp }` — a host event, not a run
     `EventRecord`.
  2. **Trigger dispatch** — implements the declared `core.trigger.event` contract
     host-side: exact-match `(tenantId, eventType)` against the **host-event binding
     registry** (below); each match starts a run via the shared `startWorkflowRun`
     with `metadata.triggerData = { eventName: type, payload }` (the same field
     `core.trigger.event` forwards as `ctx.triggerData`). Per-tenant autonomous-run
     budget checks apply exactly as in `scheduleDaemon`.
- **Host-event bindings**: `DurableCollection('hostevent:binding')` rows
  `{ bindingId, tenantId, eventType, workflowId, enabled, createdBy }` managed at
  `/v1/host/openwop-app/host-events/bindings` (list/create/delete), gated
  `host:workflows:manage`-equivalent admin scope. This is host-ext only —
  the RFC 0099 subscription API is untouched (no wire change; no RFC needed).
- **Event names** are host-extension-namespaced per RFC 0086 §E, matching the existing
  precedents: `host.crm.contact.created|updated|deleted|merged`, `host.crm.company.*`,
  `host.crm.deal.created|updated|stage-changed|won|lost|deleted`,
  `host.crm.task.completed`, `host.crm.activity.logged`.
- **Payloads are ids-only** (`{ entityType, entityId, orgId?, changed?: string[] }`) —
  contacts carry PII (`declarePiiFields`); receivers fetch details through the
  authed API under their own authz.

  > **Correction (2026-07-03, CRMGAP-16):** "ids-only" was convention-only and
  > proved unenforceable — the seam's first EXTERNAL consumer
  > (`campaign-brief/briefService.ts`, `host.campaign.brief.*` events) shipped a
  > `name` field in its payload on arrival, which is benign (a brief title is
  > not PII-declared) but showed the discipline had no teeth. The rule is now
  > **enforced at the dispatcher** (`host/hostEventDispatcher.ts`'s
  > `emitHostEvent`): every payload is stripped of exact `email`/`phone` keys
  > and any key ENDING `Email`/`Phone` (e.g. `contactEmail`) before EITHER
  > fanout (webhook delivery body AND `metadata.triggerData.payload` on a
  > triggered run), logging `host_event_payload_pii_stripped` when it removes
  > anything. The corrected, enforceable rule is **"no person-PII fields"**,
  > not "ids only": a non-person artifact's `name`/label (a campaign-brief
  > title, an email template name, an entity's display name) is explicitly
  > ALLOWED — that's the precedent `briefService.ts` set, not a violation of
  > it. Ids + non-person metadata are fine; person-identifying contact fields
  > are the thing this seam must never leak into a receiver that hasn't
  > authenticated for that contact's data.
- Emission points are the **service mutation choke points** (`crmEntitiesService`,
  `contactsService` callers in routes/surface) — one emit next to each audit append (§3).

### 2. Governed write verbs + `feature.crm.agents` + `feature.crm.workflows` (C2)

- `ctx.features.crm` (ADR 0014) gains mutations, tenant/org from run scope only:
  `createContact`, `updateContactStage`, `updateContactOwner`, `createCompany`,
  `createDeal`, `moveDealStage`, `createTask`, `completeTask`, `logActivity`.
  Creation verbs accept an optional deterministic entity id and **short-circuit if the
  row exists** (the ADR 0162 pattern); pack nodes supply `…:${runId}:${nodeId}` ids so
  re-run/fork never duplicates. All writes flow through the SAME service functions as
  the HTTP routes — caps, link validation, custom-field validation, status derivation,
  events (§1), and audit (§3) apply identically to humans and agents.
- `feature.crm.nodes` → **v1.2.0**: eight `role:"action"` write nodes mapping 1:1 to the
  new verbs (plus the existing 5 reads + 2 pure triage nodes). Feature pin bumped.
- **`feature.crm.agents`** (new pack): `sales-ops` persona. `toolAllowlist` = the read
  nodes + `log-activity` + `create-task` (assistive tier). Stage moves, record creation,
  and conversion are NOT in the allowlist — they ride chains behind approval gates.
- **`feature.crm.workflows`** (new chain pack at `examples/workflow-chain-packs/crm-ops/`):
  - `crm-ops.route-new-lead` — triage → assign owner (param-configured) → create
    follow-up task → notify; designed to be bound to `host.crm.contact.created`.
  - `crm-ops.deal-hygiene` — list stale open deals (no activity in N days, param) →
    per-deal follow-up task behind a `core.chat.approvalGate`.
- The `/crm` chat affordance (Phase B4) re-targets `feature.crm.agents.sales-ops`.

### 3. CRM audit trail (C7-audit)

Every CRM mutation appends best-effort to the EXISTING `storage.appendAudit`:
`{ action: 'crm.<entity>.<verb>', resource: 'crm-<entity>:<id>', principalId: <actor>,
outcome: 'success', payload: { tenantId, orgId? } }` — `payload.tenantId` is REQUIRED
(the governance audit view fail-closed-filters on it). The admin AuditLogPage prefix
presets gain `'crm.'`. No new audit store, no category field.

## Alternatives rejected

1. **Append record-change events to the run event log** — runId is required and
   tenant-scoping is run-derived; a sentinel runId breaks both (survey, above).
2. **Extend `/v1/trigger-subscriptions` with `source: 'event'`** — RFC 0099 wire
   change; needs an RFC. The host-ext binding registry delivers the same capability
   without touching the wire; if a second host wants it, propose the RFC then.
3. **A per-CRUD synthesized run** (the triage pattern generalized) — a run per
   contact-rename is noise in run history and cost.
4. **Direct write tools on the agent with manifest-declared approval** — the manifest
   has no such field; roster `hitl[]` requires a standing profile. Chains + approval
   gates are the established governed-write path.

## Phases

- P1: dispatcher + bindings + CRM event emission + audit appends (+ tests).
- P2: surface mutations + `feature.crm.nodes` v1.2.0 (+ pack/route tests).
- P3: `feature.crm.agents` + `feature.crm.workflows` + chat retarget (+ loader tests).

## Open questions

- [ ] Should the dispatcher also mirror host events onto a `debug` SSE surface? Deferred —
  no consumer yet.
- [ ] Round-robin owner assignment needs member enumeration state; `route-new-lead` ships
  with a param-configured owner. Revisit with C4's routing follow-ups.
- [x] **Binding the shipped chains to events is operator-explicit (no auto-seeding).**
  Closed 2026-07-03: the bindings registry shipped API-only in P1; the gap was that
  the only way to WIRE a binding was a raw `curl`. An admin UI now ships
  (`frontend/react/src/settings/EventBindingsPage.tsx`, `/event-bindings`, "Platform"
  nav group) — list/create/enable-toggle/delete over the existing CRUD routes plus a
  new `PATCH /v1/host/openwop-app/host-events/bindings/:bindingId` (`{enabled}`,
  tenant-guarded like DELETE; `backend/typescript/src/host/hostEventDispatcher.ts`'s
  `updateHostEventBindingEnabled`). This is still **operator-explicit**: the UI makes
  binding a shipped chain (e.g. `crm-ops.route-new-lead` → `host.crm.contact.created`)
  a few clicks instead of a raw API call, but nothing auto-creates a binding — a fresh
  tenant starts with zero bindings, same as before. Demo-mode seeding of default
  bindings stays explicitly OUT of scope: the seeder registry
  (`host/exampleData/registry.ts`) seeds entities, never wiring decisions, and an
  auto-bound chain would silently start running workflows off a toggle a caller didn't
  choose — the operator-explicit posture is a deliberate safety property (autonomous-
  run budgets exist for exactly this class of surprise), not a placeholder gap. Revisit
  only if a future showcase need is explicitly named.
