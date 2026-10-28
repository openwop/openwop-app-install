# Section 12: Support commitments, unit economics and independent ecosystem evidence

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | SUP-01, MKT-02, TCO-01 |
| Proposed accountable role | Product operations / support / commercial sponsor; staffing unconfirmed |
| Dependencies | 01, 06, 10, 11 |
| Effort | L plus elapsed customer observation; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [12-support-economics-and-ecosystem-evidence.gaps.md](12-support-economics-and-ecosystem-evidence.gaps.md) · [12-support-economics-and-ecosystem-evidence.risks.md](12-support-economics-and-ecosystem-evidence.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Publish a staffed and achievable operator support/release contract, measure actual costs and customer outcomes, and substantiate marketplace ecosystem claims with independently attributable evidence. Close unknowns by observation; favorable market outcomes cannot be guaranteed by writing code.

## Motivation

Selected operator materials defer support/LTS/security-patch policy (ADR 0052 open questions), and the assessment established no published supported-version/escalation contract. This is readiness evidence, not proof no human support exists. No independent external publisher/customer/install/retention/GMV evidence or workload-normalized TCO was verified. Apache-2.0 source access is a narrow declared-license strength; it does not establish support quality, dependency clearance, actual adoption or lower total cost.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S12-R1 (SUP-01)** — Assign actual accountable support/security/release owners and escalation coverage; approve supported app/schema/pack/deployment versions, patch/security response targets, deprecation notice windows and fork/upstream compatibility. Publish versioned terms/runbooks in existing adopter docs; no unstaffed SLA or invented LTS promise.

- **S12-R2 (SUP-01)** — Exercise support incidents, upgrade advisory, security intake/disclosure, key loss and restore escalation with an operator unfamiliar with implementation. Record response/escalation/repair outcome against approved policy and make current support contact/limitations discoverable in product/docs. Preserve confidential/security channels.

- **S12-R3 (TCO-01)** — Measure common workloads across technical-operator, enterprise-host and reseller cases: tenants/users/records/concurrency/workflows/provider tokens/media/storage/egress plus install/upgrade/incident/support/qualification labor. Capture actual prices/quotes and observation period; keep license, infrastructure, AI, support and exit costs separate.

- **S12-R4 (TCO-01)** — Calculate low/base/high workload and labor sensitivity, monthly TCO and cost per successful business outcome. Compare current required competitor editions/embedding/support terms with the same job, deployment scope and service level; no unsupported cheapest/ROI claim or vendor sticker-price shortcut.

- **S12-R5 (MKT-02)** — Define externally attributable active publishers, maintained live-qualified operations, installs/update success, active customer cohorts, retention and paid settlement/revenue metrics with privacy-safe denominator/time-window definitions. Distinguish steward/affiliate/independent evidence; separate local shipped pack count from adoption.

- **S12-R6 (MKT-02)** — Recruit consented independent pilot operators/publishers, observe onboarding/maintenance/support/business outcomes and fix confirmed blockers through existing product sections. Record actual interviews/usage/feedback and negative outcomes; no fabricated customers, synthetic testimonials or code-only adoption grades.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Support commitments name service scope, ownership and measurable response; economics/adoption are outcomes to observe, not features to fabricate. |
| Schema | Versioned support/compatibility matrix and aggregate economics/cohort evidence reference existing facts, never replace usage/financial truth. |
| Security | Handle vulnerability disclosure, customer identity, incident material, spend records and pilot telemetry through consented restricted channels. |
| Conformance | Independent operator incident/restore trial, actual invoices/labor and cohort evidence; unverifiable data remains unknown. |
| Compatibility | Support/deprecation policies preserve prior commitments and clearly date changes; fork/version migrations remain consistent with release contract. |

### Proposed data and interface impact

Reuse existing usage analytics, marketplace/billing/qualification records and support documentation. Planning/measurement report contains cohort definitions, aggregate counts, costs/quotes, workload and uncertainty; raw identifiers/contracts/customer payloads stay controlled. New telemetry needs consent/purpose/retention review and no second billing ledger.

## Compatibility

Commercial/operational documentation and measurement; no new protocol capability. Contractual language requires the accountable owner’s real approval before publication as a commitment. The plan proposes decisions, does not execute procurement, customer outreach or impose an SLA.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S12-T1 | Operator finds correct supported version/contact and rehearses incident/escalation against staffed policy | Independent pilot + support owner | Approved terms and actual rehearsal timestamps |
| S12-T2 | TCO is reproducible from real workload/invoice/usage/labor inputs with sensitivities | Commercial analyst + pilot operator | Current quotes and measured period, not hypothetical winner |
| S12-T3 | External publisher/customer/cohort metrics have attributable source and definitions | Consented independent participants | Observed activity; empty dataset remains U |
| S12-T4 | Measured feedback identifies/fixes adoption blockers without laundering affiliation | Product researcher + external operator | Original evidence, consent and linked repair outcomes |

## Alternatives considered

- Invent aggressive SLA/adoption/ROI targets and call them done: rejected.
- Avoid external measurement and use repository pack counts: rejected.
- Publish feasible staffed commitments and measure real pilots/economics: chosen; success depends on people and elapsed observation.

## Unresolved questions

1. Who can actually staff support/security response and approve contractual promises? Resolution: Confirm people/coverage and approve policy; no commitment until assigned. Owner: David Tufts / commercial sponsor. Blocks: support publication.
2. Which workload/quotes, loaded labor rates and actual customer cohort can be measured? Resolution: Obtain consented pilot data, recent quotes and workload definition. Owner: Commercial/product owners. Blocks: TCO/retention conclusions.
3. What independently attributable evidence may be published with consent? Resolution: Approve aggregate definitions, attribution and disclosure limits. Owner: Privacy/product owners. Blocks: public adoption statements.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | Existing release/adopter/security docs + support ownership | Approved supported-version/patch/escalation contract |
| 2 | Pilot/support/restore operators | Incident and upgrade support rehearsals |
| 3 | Billing/usage/cost/labor data owners | Workload-normalized TCO worksheet and sensitivities |
| 4 | Independent pilots/publishers + existing analytics | Attributable adoption/retention/update and feedback evidence |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] Support policy is staffed, approved, published and rehearsed; implementation authors are not the sole operator witness.
- [ ] Economic/marketplace unknowns have real measured inputs and documented uncertainty; unfavorable results produce new product actions instead of inflated grades.
- [ ] Independent customer/publisher evidence is obtained; tests/internal demos alone cannot close MKT-02.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs SUP-01, MKT-02, TCO-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [Release/support decision](../../adr/0052-versioned-app-releases-and-migrations.md)
- [Economic assessment](../../research/platform-gap-analysis-2026-10-24.md)
- [Current official market sources](../../research/deep-research-platform-2026-10-24.md)
- [Usage/credits owner](../../adr/0821-usage-metering-and-ai-credits.md)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.
