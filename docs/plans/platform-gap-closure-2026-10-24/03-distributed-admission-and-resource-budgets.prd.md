# Section 03: Distributed admission and resource budgets

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | SCALE-01 |
| Proposed accountable role | Runtime / storage engineering; staffing unconfirmed |
| Dependencies | 02 |
| Effort | L; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [03-distributed-admission-and-resource-budgets.gaps.md](03-distributed-admission-and-resource-budgets.gaps.md) · [03-distributed-admission-and-resource-budgets.risks.md](03-distributed-admission-and-resource-budgets.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Make configured hard quotas true across instances and all run-creation lanes, while retaining cheap local shedding for general traffic. Add durable run admission to existing run/storage ownership rather than a parallel quota, billing or scheduler system.

## Motivation

Global middleware maps and concurrent slots are process-local (`middleware/rateLimit.ts:186,567,633`); a real reserved slot still gets filtered after 60s. However `host/sharedRateLimit.ts` already offers hashed CAS-backed fixed windows (ADR 0934) and `host/planRunLimit.ts` already owns durable monthly plan usage (ADR 0821). The latter documents fail-open counter errors and a fork-lane follow-up; verify actual callers rather than infer every lane from comments. The shared-limiter test explicitly skips its absent-key Postgres race under pg-mem. Real Postgres is required to substantiate distributed correctness.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S03-R1 (SCALE-01)** — Census manual/API/fork/bulk-redrive/chat/agent/schedule/trigger/sub-run creation and distinguish attempt, idempotent retry, new run and new billable run. Define which nonterminal states, including suspended approvals and queued work, consume each configured concurrency limit. The current >60s active-run expiry shall be corrected.

- **S03-R2 (SCALE-01)** — Reuse sharedRateLimit fixed windows where their semantics fit public/expensive request budgets and planRunLimit for monthly entitlements. Keep local global shedding labeled per-instance; do not convert every cheap GET into a DB write. Benchmark fixed-window boundary bursts and any edge integration before promising a smooth rate.

- **S03-R3 (SCALE-01)** — Introduce durable admission reservations in existing Storage/run creation transaction/outbox path. State machine: reserved→attached-to-run→released; crash recovery uses the authoritative run/dispatch state plus fenced generation, never elapsed wall time alone. Reserve atomically before a hard limit can be exceeded; idempotent retries attach once and release on failed creation.

- **S03-R4 (SCALE-01)** — Enforce all configured hard scopes jointly across instances with deterministic tenant/principal keys; use no raw bearer/IP in records. Batch cost equals minted runs. Concurrent children, forks and recovery paths follow explicit policy rather than a bypass. Strict profile refuses admission if authoritative budget unavailable; existing availability-oriented policy changes require an ADR correction and operator migration.

- **S03-R5 (SCALE-01)** — Expose scope, usage, degraded/strict posture and denied admission through existing metrics/Operations. Terminal transitions and reconciliation release once, with bounded sweeps and no per-request global scan. Do not promise exactly-once billing from an HTTP response.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Define admission units and holding states first; hard ceiling differs from availability-oriented metering. |
| Schema | Reuse Storage and existing counters; new host-local reservation schema requires contiguous migrations if relational, or reviewed KV CAS invariants if portable. |
| Security | Prevent cross-tenant key collision, trusted-proxy IP confusion, quota evasion by fork/batch and raw credential retention. |
| Conformance | Two independent processes/DB clients race and crash on real Postgres; assert limits against persisted admitted runs, not local callbacks. |
| Compatibility | Keep 429 and Retry-After semantics; profile/config behavior migrates explicitly. No new protocol scale promise is introduced. |

### Proposed data and interface impact

Proposed host-local admission row: tenantId, scope/keyDigest, reservationId, requestDigest/idempotency binding, runId?, state, generation, created/updated timestamps. Aggregate capacity update and reservation/run association need a reviewed atomic Storage operation for SQLite/Postgres; an expiring fixed-window counter alone cannot represent active runs. No secret fields or new public wire schema. Review paid monthly counters separately from concurrency.

## Compatibility

Host-internal admission correction. Existing v2 errors/headers remain canonical. Default strictness or counting changes are documented migration decisions; no new protocol capability is needed. A new normative global quota contract or advertised scale profile would need an upstream RFC, separately reviewed.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S03-T1 | At capacity C, two instances jointly persist at most C admitted runs; next request denied | Two-process adversarial driver | Real Postgres; SQLite only for supported local topology |
| S03-T2 | Active run >60s still occupies its slot; suspended/queued states follow declared policy | Controlled long-running/approval fixture | Virtual-time unit plus real multi-process witness |
| S03-T3 | Crash at reserve/insert/outbox/terminal boundaries leaks no permanent slot or duplicate charge | Fault-injection harness | Worker/process crash and authoritative reconciliation |
| S03-T4 | All creation lanes count declared units; retry/refusal/store failure obey policy | HTTP + schedule/chat/tool fixture | Lane matrix and real storage; unavailable authority has explicit status |

## Alternatives considered

- Do nothing: hard scale ceilings remain misleading.
- Put a generic distributed counter on every request: rejected as default; conflates traffic shedding with durable admission and adds avoidable DB work.
- Extend existing shared limiter/plan counter and transactional run admission: chosen; more lifecycle work but one authority.

## Unresolved questions

1. Do waiting approvals/queued runs count toward which resource ceiling? Resolution: Measure resource consumption and approve state-by-scope table. Owner: Runtime + product owners. Blocks: reservation semantics.
2. Which monthly budgets are contractual hard limits versus availability-oriented reporting? Resolution: Trace current lanes and record explicit failure posture/correction. Owner: Billing + runtime owners. Blocks: strict policy migration.
3. Which shared transaction/constraint shape works on both supported DBs? Resolution: Prototype real Postgres/SQLite absent-key and atomic admission races. Owner: Storage owner. Blocks: schema implementation.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | rateLimit/sharedRateLimit/planRunLimit/runStarter/runs | Lane/state census and reproduced >60s failure |
| 2 | Storage transaction/CAS and dispatch outbox owner | Admission schema + atomic transitions + migration fixtures |
| 3 | Every existing run-start lane and terminal/recovery hook | Hard-limit enforcement + no-double-count tests |
| 4 | Operations/OTel and load harness | Capacity/latency/error envelopes with measured DB budget |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] All creation paths and holding states are covered; two-instance ceiling, long-running slot and recovery witnesses pass.
- [ ] Real Postgres concurrent absent-key/rollback tests run; pg-mem skips are not substituted.
- [ ] No duplicate quota/plan owner or extra pool is added; poolMax × maxInstances remains within documented DB budget.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs SCALE-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [Shared limiter ADR](../../adr/0934-shared-rate-limit-for-public-token-surfaces.md)
- [Current limiter](../../../backend/typescript/src/middleware/rateLimit.ts)
- [Monthly plan counter](../../../backend/typescript/src/host/planRunLimit.ts)
- [Dispatch durability](../../adr/0551-durable-workspace-queued-dispatch-and-multi-region-qualification.md)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.
