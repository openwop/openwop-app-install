# Section 06: Release qualification, full recovery and measured reliability

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | OPS-03, REL-01, QA-01 |
| Proposed accountable role | Reliability / release qualification; staffing unconfirmed |
| Dependencies | 01, 02, 03, 04, 05 |
| Effort | XL; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [06-release-qualification-recovery-and-slos.gaps.md](06-release-qualification-recovery-and-slos.gaps.md) · [06-release-qualification-recovery-and-slos.risks.md](06-release-qualification-recovery-and-slos.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Build a release-specific qualification and recovery contract that demonstrates the advertised reliability, performance and portability. Separate deterministic correctness tests, real fault witnesses, elapsed SLO measurement and independent assurance.

## Motivation

The app has transactional run/dispatch outbox, replay/effect claims, OTel metrics/probes and a local CI/browser gate. ADR 0551 P3/P4 and ADR 0556 operational assurance remain evidence work; do not rebuild already-implemented P0–P2. `docs/SLO.md:3` describes targets without a production baseline. `scripts/ci.sh` leaves real Docker adapters opt-in. The audit ran 57 selected tests but no full gate, real Postgres crash lane, install/upgrade/restore drill or independent signed-bundle verification. DB backups alone cannot restore media, encryption/key access and deployment identity.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S06-R1 (QA-01)** — Extend existing CI/release/attestation ownership to record exact source/artifact/config/schema/app versions, suite version, test environment and every executed/failed/skipped/blocked/inapplicable requirement. A test mock, fake success or static shape check cannot substantiate a production property. Preserve Tracegate evidence and appropriate full-lane/audit semantics.

- **S06-R2 (REL-01)** — Qualify run/effect lifecycle on real Postgres with independently running API/worker processes: crash before/after run commit/outbox/lease/provider effect/approval/terminal; duplicate accepted work; poisoned retries; cancellation; provider ambiguity; version rollout; replay and fork. Provider-side idempotency or effect fencing must be shown, not inferred from a client retry.

- **S06-R3 (OPS-03)** — Inventory coherent restore set: DB and migration metadata, objects, BYOK wrapping keys or cloud KMS access and rotation versions, configuration, signing/identity/domain bindings, installed pinned packs and historical runtime dependencies. Exercise backup encryption, integrity, off-host retention and access separation; restore to empty isolated infrastructure and prove tenant/media/secret/workflow correctness.

- **S06-R4 (REL-01)** — Define single-node, multi-instance and regional-failover profiles separately. Run representative read/write/SSE/workflow/money/AI-stub mixes over graduated concurrency/data volumes, hot tenants, slow providers and large graphs. Record saturation, queue lag, p50/p95/p99, errors and poolMax×maxInstances. Initial load points and stop/budget thresholds are agreed test inputs, not invented capacity promises.

- **S06-R5 (REL-01)** — Collect actual declared SLIs for the existing 28-day window, exercise alert routing and runbook actions, and record missing telemetry/degraded periods. Restore RPO/RTO and failover timings are measured against buyer-approved objectives; an objective without a witness remains open.

- **S06-R6 (QA-01)** — Verify signed conformance and supply-chain/deploy provenance against the exact candidate and serving revision; add independent cross-host exchange with pinned packs/keys and recorded effects. Existing self-measured bundle remains self evidence. Publish current supported topology/capacity/recovery limits and regress them at each release.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | An SLA/profile has explicit workload, topology and failure scope; no generic enterprise-ready badge. |
| Schema | Use existing attestations/Operations metrics and backup manifests. Schema/run eras and pinned dependencies are part of recovery identity. |
| Security | Restores preserve tenant isolation, revoked credentials and KMS boundaries; confidential dumps/keys stay in controlled test storage. |
| Conformance | Separate observable effect from causable crash; restart/partition cannot be replaced by ordinary idempotent HTTP retry. All unavailable causes get blocked dispositions. |
| Compatibility | Backward-compatible deploys use backend-first; incompatible migrations drain and recover coherently. Cross-region claims stay gated on actual effect safety, not replication latency alone. |

### Proposed data and interface impact

Extend existing release evidence/attestation record, not new runtime truth: artifact/config digests, schema versions, topology, SLI window, workload definition, outcome dispositions, logs and reviewer. Evidence excludes subject data/credentials. Restore manifest identifies secret/key references and recovery procedures, never copies plaintext into public reports.

## Compatibility

Qualification uses existing accepted contracts (including RFC 0150/0151/0158 and current v2 core where relevant), not new guarantees written into the app. Any additional advertised production/scale profile requires accepted upstream specification. No full-CI result is claimed by this planning task.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S06-T1 | Persisted accepted work resumes and does not duplicate a committed external effect after targeted crash | Controlled process/DB/provider fault harness | Real topology + receiver/provider evidence |
| S06-T2 | Empty-environment recovery resolves keys, media and old runs with measured RPO/RTO | Separate restore operator | Complete release-specific restore, not DB import alone |
| S06-T3 | Agreed workload meets recorded SLO/error/capacity thresholds without pool or tenant-starvation breach | Budgeted load/soak driver | Real deployment; simulated AI only for infrastructure profile |
| S06-T4 | Every claim has exact signed artifact/bundle and disposition; unsupported/seam-less cases stay visible | Release verifier + independent host/operator | Actual release artifacts and cross-host exchange |

## Alternatives considered

- Do nothing: controls exist but operational claims remain unqualified.
- Treat unit tests and self-reported green counts as proof: rejected; cannot cause production failures or validate recovery.
- Extend release evidence around real fault/restore workloads: chosen; requires infrastructure, elapsed time and independent participation.

## Unresolved questions

1. What buyer-approved SLO, RPO/RTO and capacity bounds apply per topology? Resolution: Translate declared objectives/customer needs into workload/threshold manifest. Owner: Product + reliability owners. Blocks: claim and pass criteria.
2. What isolated infrastructure, provider fixtures, budget and fault authority are available? Resolution: Provision disposable resources; approve destructive fault boundaries and limits. Owner: Infrastructure/security owners. Blocks: live qualification execution.
3. Who operates independent restore and cross-host exchange? Resolution: Assign non-author reviewer/operator and obtain host participation. Owner: Release/security sponsor. Blocks: independent evidence.
4. How are 28 days of SLIs collected before a new release claims attainment? Resolution: Start measurement on qualified baseline; separate elapsed evidence from code delivery. Owner: Reliability owner. Blocks: SLO attainment closure.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | Existing CI + artifact/attestation/Operations lanes | Qualified profile and witness manifest |
| 2 | Real Postgres/process/provider fault environment | Crash/effect/approval/version matrix + reproducible failure reports |
| 3 | Backup/object/key/config and deploy pack owners | Empty-infrastructure full restore and failover timing |
| 4 | Load driver + current metrics and SLO runbooks | Measured capacity envelope and 28-day SLI evidence |
| 5 | Conformance/release verifier + independent operator | Signed candidate/deployed provenance and cross-host report |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] Full applicable app gate and mandatory real-database durability/migration lanes pass on the candidate; no forced Tracegate enforcement or ledger deletion.
- [ ] Complete restore and requested topology failover meet agreed measured objectives.
- [ ] Missing independent participation, provider accounts or elapsed SLO window remain explicit open evidence, not regraded A.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs OPS-03, REL-01, QA-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [SLO contract](../../../docs/SLO.md)
- [CI owner](../../../scripts/ci.sh)
- [Durability ADR](../../adr/0551-durable-workspace-queued-dispatch-and-multi-region-qualification.md)
- [Observability ADR](../../adr/0556-production-metrics-workload-identity-and-assurance-operations.md)
- [Attestation ADR](../../adr/0550-conformance-provenance-ci-and-claims-attestation.md)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.
