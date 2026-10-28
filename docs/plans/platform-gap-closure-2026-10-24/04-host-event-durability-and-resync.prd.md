# Section 04: Host-event durability, fan-out and resynchronization

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | EVENT-01 |
| Proposed accountable role | Event runtime / storage engineering; staffing unconfirmed |
| Dependencies | 02 |
| Effort | L; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [04-host-event-durability-and-resync.gaps.md](04-host-event-durability-and-resync.gaps.md) · [04-host-event-durability-and-resync.risks.md](04-host-event-durability-and-resync.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Persist and fan out durable host events across processes without changing ephemeral semantics. Add an opt-in interoperable replay/resync guarantee through Draft RFC 0250, and reconcile the application’s views after a real gap.

## Motivation

`host/hostEventStream.ts:34` retains a process-local 1,000-event ring; at :93–98 an oversized NOTIFY payload falls back to local delivery. This is the **protocol** `/host/events` channel (`routes/hostEventStream.ts`), separate from the feature binding-admin route and persisted workflow run-event log. Current v2 events.md §Host events / accepted RFC 0236 defines durable IDs and a SHOULD for replay within retention, not a new resync error. RFC 0247 already owns resumable bounded closes. A new explicit strict replay/resync contract has been drafted as upstream RFC 0250 at spec base 10633f3c; it is not accepted.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S04-R1 (EVENT-01)** — Replace the ring as the durable authority with tenant/workspace-scoped persistent event records and an internal ordered cursor using existing Storage/host event dispatch ownership. Pubsub carries references, not arbitrarily large payloads. Preserve original eventId, payload and delivery class; never persist ephemeral events.

- **S04-R2 (EVENT-01)** — Make append/publication/retry ordering explicit: a durable event accepted for delivery is discoverable by subscribers after restart, and publication failure is retried through existing durable work ownership. Prevent missing updates at backlog/live handoff; do not add a second event bus, runId or wire sequence.

- **S04-R3 (EVENT-01)** — Under existing RFC 0236, fix retained-cursor replay and oversized cross-instance fan-out now while preserving legacy unknown-cursor behavior. Under accepted RFC 0250 only, advertise the optional facet, honor replay=required across restart and return the reviewed uniform pre-stream resync error for an unavailable cursor.

- **S04-R4 (EVENT-01)** — Extend existing stream clients/SDK use with bounded reconnect/backoff, eventId deduplication and explicit resync-required UI state. Reconcile authorized entity state, buffer concurrent new events and reapply by authoritative revision where available. Do not claim a cross-entity atomic baseline without an owning contract.

- **S04-R5 (EVENT-01)** — Define minimum retention, volume/size limits, privacy erasure, legal holds and tenant teardown behavior; register subject erasure/retention handlers with existing owners. Keep diagnostics bounded, with no payload, raw cursor or secret labels.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Existing core Host events owns behavior; distinguish a host implementation repair from new normative resync semantics. |
| Schema | Internal log/index can ship independently; strict mode adds optional hostEvents.replay/query and registered error only through upstream RFC 0250. |
| Security | Authorize before cursor lookup; preserve tenant/workspace/current visibility and uniform foreign/unknown refusal; apply erasure and SR-1. |
| Conformance | Two instances, fresh process, large durable event, mixed ephemeral stream and trim/private cursor fixtures; no run-SSE test substituted. |
| Compatibility | Legacy request/ID/event behavior unchanged; only opting-in clients get strict refusal after accepted RFC. |

### Proposed data and interface impact

Proposed host-local durable event index contains eventId, tenantId, workspace/visibility reference, type/class, internal order, producer timestamp, retention boundary and payload/reference. Review atomic append + dispatch marker within existing storage transactions. Wire envelope unchanged; new optional discovery/query/error semantics are only the RFC 0250 proposal. Event persistence is never enabled for ephemeral records.

## Compatibility

Existing replay/fan-out repair: no new RFC. Explicit replay guarantee/resync response: **Draft RFC 0250 required**; no advertisement or public error ships before accepted upstream owning schema/spec/conformance work. App RFC gate is at least Accepted before/with the host change, per repository instructions. RFC number must be rechecked before public filing.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S04-T1 | Large durable event emitted on A is received on B with same eventId; no local-only fallback | Two routed processes + producer fixture | Actual production pubsub/storage |
| S04-T2 | Fresh process replays retained durable backlog without cursor event or ephemeral frames | Operator crash/restart fixture | Real DB; restart cannot be inferred from a mock |
| S04-T3 | Strict mode gives same safe resync response for unknown/expired/foreign cursor before SSE | Protocol client + second tenant + trim fixture | RFC 0250-gated; legacy requests regression-tested |
| S04-T4 | Application baseline repair and replay/live handoff converge under concurrent writes | UI + producer/reconnect driver | Entity revisions/dedup witnesses; no blanket snapshot atomicity claim |

## Alternatives considered

- Keep the ring and document loss: does not close EVENT-01.
- Persist every frame: rejected; ephemeral no-persistence is a protocol/security invariant.
- Use existing event/storage owners plus optional strict protocol mode: chosen; internal repairs are independently shippable.

## Unresolved questions

1. Which retention interval and privacy/tenant-delete exceptions are supportable? Resolution: Resolve RFC 0250 G2 and capacity/erasure tests. Owner: Storage + privacy owners. Blocks: strict facet advertisement.
2. How are producer ordering and atomic backlog/live handoff implemented? Resolution: Choose one internal log order and prove multi-producer races. Owner: Event/storage owners. Blocks: durable guarantee.
3. How does each affected entity view reconcile without an atomic snapshot API? Resolution: Inventory revision semantics and test buffered resync. Owner: Frontend + entity owners. Blocks: client gap recovery.
4. RFC 0250 governance, SDK owners and gated test conditions Resolution: Review Draft plus registers and complete ordinary acceptance process. Owner: Protocol maintainers. Blocks: new public semantics.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | Existing host event dispatcher/Storage/pubsub | Persistent reference delivery + oversized event repair |
| 2 | Retention/erasure/stream reader | Restart, trim and live-handoff witnesses |
| 3 | Upstream RFC 0250 + current v2 SDKs | Accepted opt-in facet/query/error and conformance |
| 4 | Existing SPA stream/entity clients | Explicit reconciliation UX with failure/retry and privacy tests |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] No durable gap on a supported fresh-process cursor and no oversized loss across two instances.
- [ ] Ephemeral physical persistence/sinks remain absent; tenant/workspace/current visibility tests pass.
- [ ] Strict cursor error/facet is shipped only after upstream acceptance; all new protocol/SDK witnesses have actual dispositions.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs EVENT-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [Current stream implementation](../../../backend/typescript/src/host/hostEventStream.ts)
- [Protocol route](../../../backend/typescript/src/routes/hostEventStream.ts)
- [Upstream RFC 0236](https://github.com/openwop/openwop/blob/main/RFCS/0236-host-events.md)
- [RFC 0250 upstream Draft](https://github.com/openwop/openwop/blob/97def7cf585e2c4f8b428b689a55bd3d5b8412cc/RFCS/0250-opt-in-host-event-replay-and-resync.md)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.
