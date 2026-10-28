# Section 05: Data integrity, lease fencing and lifecycle completeness

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | DATA-01 |
| Proposed accountable role | Storage / data integrity engineering; staffing unconfirmed |
| Dependencies | 02 |
| Effort | L; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [05-data-integrity-leases-and-lifecycle.gaps.md](05-data-integrity-leases-and-lifecycle.gaps.md) · [05-data-integrity-leases-and-lifecycle.risks.md](05-data-integrity-leases-and-lifecycle.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Prove and enforce business invariants under concurrent writers, retries, partial failures and lease expiry. Complete the data-lifecycle census across every feature without replacing its authoritative stores.

## Motivation

DurableCollection provides per-row CAS and awaited persistence (`host/hostExtPersistence.ts`), not a universal multi-entity transaction. `host/tenantOpLock.ts:35–82` may steal an expired lease without fencing or cancelling the original function. Current direct callers found are `host/seedLock.ts` and `features/crm/crmMergeService.ts:345`; that is a specific caller risk, not proof every money operation uses this lock. Owner invariants, erasure registry, lifecycle hooks and retention workers already exist. The audit did not reproduce data corruption.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S05-R1 (DATA-01)** — Inventory multi-row money/entitlement, last-owner, merge/rekey, unique identifier, seed/import, delete/cascade and subject-erasure invariants. For each, record authoritative owner/keys, allowed transient states, transaction/CAS/compensation behavior and real caller paths; do not classify every KV write as unsafe.

- **S05-R2 (DATA-01)** — For seed and CRM merge lease callers, choose a proven transactional operation or renewed, fenced lease whose generation is checked by every authoritative write. A stale holder cannot commit after successor acquisition. Cancellation alone is insufficient; external effects require provider idempotency/recorded effect identity.

- **S05-R3 (DATA-01)** — Use existing Storage transactions/constraints where the invariant is relational; where portable CAS is retained, define recovery transitions and durable reconciliation with bounded tenant-indexed scans. No new private database, global process mutex or unrelated lock namespace.

- **S05-R4 (DATA-01)** — For each subject-bearing store/derived index/cache/object, register an existing eraser/lifecycle hook or a reviewed lawful-retention exemption. Validate tenant fold/merge/rekey updates row keys as well as content; repeatable seeds/imports remain idempotent. Recover interrupted jobs without orphaned credentials/media references.

- **S05-R5 (DATA-01)** — Cover migrations with current forward-only counters and release metadata. Enumerate old/new writers, backfill restart and rollback by coherent restore. Add redacted invariant health to existing Operations/metrics; avoid payload/subject identifiers in metric labels.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Enumerate invariants and tolerated transient states before choosing locks or transactions. |
| Schema | Record row-key as well as value lineage; one migration counter; no generic shadow ledger that duplicates money/data ownership. |
| Security | Tenant-bound keys, least-authority lifecycle jobs, durable erasure/exemptions and fenced writes preserve authorization under delayed work. |
| Conformance | Kill or delay the original holder past TTL, let a successor commit, then resume old code; inspect real DB invariants and indexes. |
| Compatibility | Host-local strengthening; preserve recorded replay/effect keys and old run readability. New protocol guarantees require separate review. |

### Proposed data and interface impact

Prefer strengthening current keys/constraints/transaction APIs. Any proposed operation lease adds monotonic generation/fencing and bounded ownership state under the existing store; exact schema follows caller proof. New reconciliation state belongs to the owning feature, uses tenant-index/erasure registration and is not a second source of business truth.

## Compatibility

Host-internal data changes, no new wire contract. Forward-only migration and original payload/readers retained. Adding fencing to the operation helper is not proof that every write honors it; caller adaptation and mixed-version safety are required before rollout.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S05-T1 | Expired original CRM/seed holder cannot overwrite successor; owner/identity indexes remain valid | Two processes + pause/resume write barrier | Real SQLite/Postgres as supported |
| S05-T2 | Concurrent last-owner/money/merge operations preserve the named invariant or return explicit conflict | Adversarial domain fixtures | DB rows plus HTTP outcome; mocks insufficient |
| S05-T3 | Interrupted delete/rekey/import rerun yields no orphan, duplicate or foreign-tenant record | Fault-injection lifecycle harness | Owning store/index/blob assertions |
| S05-T4 | Erasure reaches each subject-bearing store or documented legal exemption | Privacy fixture with canary subject | Data census + actual durable cleanup outcome |

## Alternatives considered

- Do nothing: unbounded stale-holder risk remains unqualified.
- Global lock/private transaction store: rejected; duplicates ownership and blocks unrelated work.
- Per-invariant transactions/fencing through existing owners: chosen; requires caller census and migration evidence.

## Unresolved questions

1. Which invariants need serializability versus bounded compensation? Resolution: Review invariant inventory with precise failure windows. Owner: Data + domain owners. Blocks: implementation choice.
2. Which delayed writes and effects must honor a fencing token? Resolution: Trace actual call graph, database transaction and provider boundaries. Owner: CRM/seed/runtime owners. Blocks: lease repair.
3. Which retention exemptions are legally required and who approves them? Resolution: Record scope/owner/duration and test permitted erasure outcome. Owner: Privacy/security owners. Blocks: privacy closure.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | Storage/feature/lifecycle inventory | Complete invariant and subject-store ledger |
| 2 | tenantOpLock/seedLock/crmMerge owners | Fenced or transactional operations with stale-holder witness |
| 3 | Feature-specific merges/import/deletes/money invariants | Forward migration, retry and fault fixtures |
| 4 | Existing erasure/retention/Operations | Full lifecycle reconciliation and regression evidence |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] Every known TTL-lock caller and high-risk multi-row invariant has a validated strategy and failing-before/fixed-after witness where a defect exists.
- [ ] All source-inventoried subject stores are registered or explicitly exempted; no unknown owner remains.
- [ ] No global corruption claim is made without reproduction, and no risk is closed by adding a type alone.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs DATA-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [Current operation lock](../../../backend/typescript/src/host/tenantOpLock.ts)
- [CRM merge](../../../backend/typescript/src/features/crm/crmMergeService.ts)
- [Persistence owner](../../../backend/typescript/src/host/hostExtPersistence.ts)
- [Architecture/lifecycle seams](../../../ARCHITECTURE.md)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.
