# Section 10: Publisher lifecycle, marketplace trust and financial operations

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | DEV-01, MKT-01, COM-01 |
| Proposed accountable role | Marketplace / billing / developer experience; staffing unconfirmed |
| Dependencies | 01, 02, 05, 06, 09 |
| Effort | XL; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [10-publisher-marketplace-and-financial-operations.gaps.md](10-publisher-marketplace-and-financial-operations.gaps.md) · [10-publisher-marketplace-and-financial-operations.risks.md](10-publisher-marketplace-and-financial-operations.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Make author→publish→install→update→revoke and customer→charge→refund→reconcile complete, observable and independently usable. Preserve the existing trust, entitlement and single-payment-rail architecture.

## Motivation

Marketplace computes listings from installed manifests and real trust verdicts (`listingService.ts:44`). ADR 0826 already implements tree integrity, curation, revocation and trusted installation; do not propose them as absent. Billing/Connect already share stripeApi and one webhook with platform+Connect signing secrets; paid listing approvals and CAS amount/currency fulfillment exist. The assessment did not complete external developer, live settlement or tenant financial reconciliation journeys. Source-level money controls are strengths requiring full lifecycle qualification, not a license to build a second payment system.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S10-R1 (DEV-01)** — Run an independent developer journey for node/agent/connection/artifact/UI/canvas/chain packs supported by the app: discover schema, author, validate, sign, publish through existing registry, install, exercise from UI/chat/workflow and upgrade. Record time, errors and missing docs; resolve every blocker rather than claim DX from examples alone.

- **S10-R2 (MKT-01)** — Qualify publisher identity/support metadata, submission/review, package content/integrity, dependency/pin compatibility, trust classification, curation, installed/available state, update permission/trust diff, revoke/disable/uninstall and rollback/restore. Preserve historical run resolution where safe; revocation policy can forbid execution, not silently bypass trust.

- **S10-R3 (MKT-01)** — Expose supported app/pack versions, real provider qualification, release notes, support owner and permission changes through existing listing/projection UI. Close gaps found in lifecycle tests; keep provenance, review, operational qualification and hostile-code containment distinct.

- **S10-R4 (COM-01)** — Test all subscription, plan/bundle, credits and Connect paid-listing lanes: initial/delayed payment, duplicate/out-of-order webhooks, amount/currency mismatch, refund/partial refund/dispute/payout failure, cancel/downgrade and toggle-off money truth. Order pending→paid CAS remains fulfillment authority; fees computed minor-units-first.

- **S10-R5 (COM-01)** — Use one Stripe client/webhook with two signing secrets and required routing precedence; host-global refs resolve through persistent BYOK and proper Secrets Vault scope. Preserve priced-implies-gated central choke, anonymous seller refusal and both paid listing approvals; fixtures prove all invocation lanes respect entitlements.

- **S10-R6 (COM-01)** — Provide tenant/operator reconciliation of provider costs, billable usage, invoices/credits/fees/refunds/disputes and outstanding obligations through existing billing/usage/obligation-ledger owners. Add missing reseller provision→entitle→rebill→support→offboard workflow with clear seller-region/payment restrictions; do not create a new financial truth from UI estimates.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | End-to-end publisher/reseller task, including failure and offboarding, is the unit of completion. |
| Schema | Existing manifests/listing trust/order/obligation schemas own truth; any added metadata must be compatible and traceable to source. |
| Security | Tenant/role/curation checks, malicious updates, revoked keys, safe pack paths and approval-bound money effects are adversarial cases. |
| Conformance | Independent developer evidence, real signed fixtures and Stripe test-mode order/refund/dispute receipts; no live customer money. |
| Compatibility | Pinned packages/old-run data remain readable; schema/price/entitlement changes have version/migration tests; protocol manifest evolution obeys upstream contracts. |

### Proposed data and interface impact

Extend existing listing/review/pack-trust and billing/usage/obligation records with qualification/support/evidence references as needed. Ledger fields use currency + integer minor units and immutable event/effect references; no raw Stripe/BYOK secrets. Permission-diff metadata derives from signed pack contracts, not a second hand-maintained capability registry.

## Compatibility

Host-product extensions normally need no RFC; a new normative pack kind/permission schema/registry API or install readback contract must map to an accepted upstream RFC first. Existing RFC 0249 is Active on refreshed upstream, not yet Accepted; do not assume a qualified host implementation. Preserve ADR 0176/0385/0419 corrections and existing signed loader/registry; no second Stripe client or webhook.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S10-T1 | Independent author publishes/install/upgrades pack and resolves docs blockers without privileged maintainer help | External developer in isolated registry/tenant | Observed journey + signed artifact, not internal author assertion |
| S10-T2 | Tampered/revoked/incompatible update is refused and permission changes are visible | Adversarial package fixture | Actual installer/executor/UI and historical-run checks |
| S10-T3 | Duplicate/delayed/mismatched money events produce one correct fulfillment and reconciliation | Stripe test-mode sender/operator | Signed two-secret webhook + DB CAS/ledger evidence |
| S10-T4 | All entitlements and operator financial totals reconcile through downgrade/refund/offboard | Two tenant role/plan fixtures | HTTP/chat/node/schedule lane matrix; no live charge |

## Alternatives considered

- More listings without lifecycle proof: rejected; does not improve trust or developer success.
- New billing/registry/credential truth: rejected; breaks explicit architecture and money invariants.
- Complete existing lifecycle and project evidence into existing hubs: chosen.

## Unresolved questions

1. Who is the independent developer and what registry sandbox is available? Resolution: Recruit/assign participant and isolated publishing fixture. Owner: Developer experience owner. Blocks: independent DX closure.
2. Which seller regions, rebilling modes and financial reporting commitments are supported? Resolution: Review code/provider terms with appropriate specialists; approve explicit operator contract. Owner: Billing/product owners. Blocks: commercial rollout.
3. Which permission/version changes require renewed user approval? Resolution: Diff actual signed contracts and test policy decisions. Owner: Pack security + marketplace owners. Blocks: update lifecycle.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | Existing registry/loader/publisher docs | Independent author journey and missing-step fixes |
| 2 | Marketplace/trust/install/update/revocation owners | Full signed lifecycle and permission-diff evidence |
| 3 | One Stripe webhook/billing/Connect/entitlement owner | All test-mode payment/failure/plan cases |
| 4 | Existing usage/obligation/Operations projections | Reconciled reseller/operator financial workflow |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] Independent extension author and every supported pack kind has a passing lifecycle or tracked blocker.
- [ ] Money/entitlement invariants pass across duplicate/out-of-order/failure/toggle/tenant cases and all invocation lanes.
- [ ] Operator reconciles actual usage, cash and liabilities; UI estimates are labeled and cannot become fulfillment truth.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs DEV-01, MKT-01, COM-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [Marketplace hardening](../../adr/0826-marketplace-supply-chain-hardening.md)
- [Billing](../../adr/0176-subscriptions-billing.md)
- [Connect invariants](../../adr/0385-commerce-connect-seller-marketplace.md)
- [Paid bundles](../../adr/0419-paid-feature-bundles.md)
- [Usage/credits](../../adr/0821-usage-metering-and-ai-credits.md)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.
