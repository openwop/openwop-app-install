# ADR 1081 — Fleet Kanban Work-item Delivery Operations

Status: Accepted (2026-11-10).

## Context

The reusable Kanban core starts dynamically selected, tenant-owned workflows through a
durable work-item outbox. Its delivery worker already records local OpenTelemetry-style
measurements, but those measurements are process-local. In a multi-instance deployment,
they cannot answer the operational question that matters: whether the fleet is delivering
Kanban work items, retrying them, or leaving them dead-lettered.

The Operations console already owns superadmin-only, fleet-shared projections for durable
queues. The Kanban service already owns the work-item aggregate, its outbox, and its
append-only audit trail. A second delivery worker, app-builder-specific queue, or separate
metrics database would duplicate those ownership boundaries and could disagree with the
actual executor.

## Decision

1. The core `kanbanService` records a content-minimal durable audit outcome for every
   work-item delivery disposition: `started`, `not-eligible`, `deferred`,
   `workflow-unresolved`, `retried`, or `dead-lettered`. Delivery audit identifiers are
   UTC-day-prefixed, so a rolling 24-hour Operations view reads only the overlapping one
   or two audit slices, rather than scanning the complete append-only history.
2. `kanbanService` builds one aggregate-only fleet summary from that audit window and the
   durable work-item outbox. It exposes counts, queue state, and ages only. It does not
   project tenant ids, board/card/work-item identifiers, workflow inputs, user identity,
   or error text.
3. The existing Operations feature serves the summary at the non-normative host-extension
   route `/host/openwop-app/operations/kanban-work-items/summary`, guarded by the existing
   `requireSuperadmin` predicate. The existing Operations hub renders it as an independent
   panel with explicit loading, forbidden, failed, stale, and healthy states.
4. The summary is explicitly `perInstance: false`: its source is the shared durable Kanban
   store, not local metric instruments. Recent outcome counts are bounded to a declared
   rolling window, while current queue counts come directly from the durable outbox.
5. The audit entries stay attached to their work item and follow the existing item and
   tenant-erasure lifecycle. No new personal-data store or retention program is introduced.

This is host-only observability for an established core feature. It neither changes an
OpenWOP endpoint nor advertises a new capability, so it requires no protocol RFC.

## Alternatives considered

- **Read the local SLO/metrics panel.** Rejected: it is intentionally instance-scoped and
  therefore cannot provide a fleet delivery verdict.
- **Build an App Builder queue or dashboard.** Rejected: Kanban is reusable across canvas
  types and only its core outbox is authoritative.
- **Create an independent metrics database.** Rejected: it introduces a second source of
  truth and an operational migration for state already durably represented by the Kanban
  outbox and audit trail.

## Implementation record

| Phase | Change | Verification |
| --- | --- | --- |
| 1 | Durable delivery outcomes and fleet summary | Service tests simulate start, retry and dead-letter paths |
| 2 | Superadmin Operations route and console panel | Route auth/projection tests; UI state tests |
| 3 | Review, production gate and deployment | `/code-review`, `/ux-review`, grade passes, release evidence |
