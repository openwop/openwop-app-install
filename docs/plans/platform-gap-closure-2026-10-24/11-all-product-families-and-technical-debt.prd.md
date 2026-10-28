# Section 11: All product families, complete journeys and technical-debt census

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | FAM-01 |
| Proposed accountable role | Product/domain engineering leads; staffing unconfirmed |
| Dependencies | 02, 05, 07, 08, 09, 10 |
| Effort | XL; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [11-all-product-families-and-technical-debt.gaps.md](11-all-product-families-and-technical-debt.gaps.md) · [11-all-product-families-and-technical-debt.risks.md](11-all-product-families-and-technical-debt.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Deep-qualify and close competitive gaps across every product family, including disabled features and verticals. Convert the broad source inventory into a complete evidence/requirements ledger and repair every confirmed in-scope defect/debt item without treating unknowns as failures or directory counts as capability proof.

## Motivation

The audit mechanically inventoried 128 backend and 101 frontend feature directories, not their complete runtime or competitive depth. The dated inventory also contains 3,055 non-test source-line marker candidates; many are legitimate placeholders, simulations or historical comments, not defects. CRM identity, CAS event schemas, segment-entry and BigQuery writes are implemented; older missing-capability claims are stale. CMS translation, service-desk SLA and bounded BI metrics exist. All directory rows are now assigned in feature-census.json, with actual availability/depth still open.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S11-R1 (FAM-01)** — Resolve every row of feature-census.json to its registry/toggles/packs/routes/stores/data owner, current ADR status and target buyer. Pair frontend/backend surfaces without assuming identical directory names; map shared-only code to owning domains. For each deployment collect installed/enabled/entitled/permission/credential state, including OFF/BETA and feature-dependent historical runs.

- **S11-R2 (FAM-01)** — For every family define input→author/configure→execute→approve→outcome→measure→failure recovery→export/offboard journeys, and grade subcapabilities from real code/runtime evidence. Compare with specialist workflows using current primary sources and actual trial evidence where available; vendor claims remain labeled. A focused first bundle sequences execution, not removes the remaining families.

- **S11-R3 (FAM-01)** — Apply five-pass /prd refinement to every newly confirmed domain gap: factual baseline, single owner/schema, threats/authority, falsifiable success/failure witnesses, compatibility/migration and existing ADR/RFC mapping. Keep original finding and closure IDs linked; do not invent feature parity from accepted ADRs or promise equivalent depth without a buyer requirement.

- **S11-R4 (FAM-01)** — Repair confirmed domain correctness/security/data/UX/integration gaps in existing feature packages; expose relevant operations consistently through UI/API, ctx.features surface, nodes/agent and existing single chat, with chains/stacks reachable from builder and slash picker. Pure presentation/infra controls explicitly record why no pack/agent applies.

- **S11-R5 (FAM-01)** — Classify all 3,055 candidate markers plus new census hits into real production debt, deliberate scaffold/mock, ordinary UI placeholder, obsolete comment or false positive; retain verbatim source and disposition. Every real item gets owner, impact, acceptance criterion and remediation link; clear confirmed debt, preserve useful fixtures and historical rationale. No blanket baseline delete or raw-count-as-defects claim.

- **S11-R6 (FAM-01)** — Close each family only when its domain-specific outcomes, permissions, lifecycle and section 07 experience criteria pass, all confirmed required gaps are implemented, and any residual externally gated evidence is explicit. Regrade with confidence and scope; no automatic A+ from passing generic gates.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Define complete buyer outcomes per family, retaining every inventory row and disabled/vertical surface. |
| Schema | Map canonical entities and stores to current owners before changes; no independent CRM, identity, content or workflow schemas. |
| Security | Run cross-lane role/tenant/purpose/money/credential tests for each family; feature toggles never replace auth boundaries. |
| Conformance | Runtime journey + specialist subcapability evidence per row; unverified remains U and new confirmed gaps receive full five-pass refinement. |
| Compatibility | Existing toggles, pins, historical runs and deep links stable unless explicitly migrated; every wire need gates on accepted RFC. |

### Proposed data and interface impact

feature-census.json is a planning inventory, not a new runtime registry. Extend existing steward/manual-test/assessment ownership for runtime witnesses; maintain provenance, exact app/pack/config and data fixtures. Debt classification links original code spans. Subject data and business payloads remain in authorized test fixtures, not public research logs.


### Domain-specific journey requirements

These are acceptance requirements to investigate/implement, not assertions that a named feature is absent today. Every directory in feature-census.json is assigned to one domain; ambiguous ownership is reviewed in step1.

| Domain | Required outcome / failure proof | Primary benchmark context |
| --- | --- | --- |
| Workflow/AI | Author→instantiate tenant-owned chain→schedule/trigger/chat→approval→result→fork/recover; correct effect, cost and identity provenance | Temporal/Camunda/Dify/LangGraph |
| Customer data/sales | Import→deduplicate/merge→golden profile→segment→consented activation→CRM pipeline→sales credit; verify lineage, scoped fields and reversible/error outcomes | HubSpot/Segment/Hightouch; territory/commission-specific research required |
| Marketing/campaigns | Brief→brand/content/channel plan→approved publish/send→journey timer/segment entry→attribution/experiment→suppression/error repair | HubSpot/Braze; current channel contract tests |
| Commerce/billing | Catalog/pricing/tax/shipping→quote/cart→payment→stock/fulfillment→refund/dispute/subscription; financial reconciliation and seller-region bounds | Shopify/Medusa/HighLevel |
| Content/publishing | Structured content→review/translation→publish/domain/SEO→form/media/email output→unpublish/rollback; safe public scope and native-language results | Strapi and target channel specialists |
| Documents/artifacts | Source→generate→edit→review→render/export/publish→reopen; actual file/format fidelity, accessible output, provenance and native performance | Editor/format-specific benchmark trials still required |
| Service operations | Multi-channel intake→dedup/contact→queue/assignment→reply approval→SLA/escalation→resolution/reporting; failures/revoked permissions | Zendesk |
| Analytics/measurement | Known seeded facts→filtered/scoped aggregation→visualization/export→reconciliation; disclose truncation and prove scale path beyond scoped in-memory limits | Metabase; measured result parity |
| Strategy/work | Goal/proposal→prioritization→project/tasks/approval→execution→measured outcome; correct ownership, math, dependencies and notifications | Task-specific current specialist research required |
| App-builder | Seven-target declared semantic parity and secure functional operation/deploy/recovery | Section08; Retool/Appsmith/Budibase |
| Identity/governance | Sign-in/provision→role/group/SSO/SCIM/key/connection→revoke/offboard/erase; same-/cross-tenant and delegated authority | Section02 and accepted auth/identity contracts |
| Platform/operations | Install/configure/toggle/package/monitor/update/restore; truthful admin privilege, failure state and app/runtime readiness | Sections01–06/10/12 |
| Kicktodo vertical | Creator→challenge/review→commerce/seats→participant/group/coaching→engagement/progress→accountability/metrics/offboard | Vertical user research and current competitor trials required; no invented parity grade |
| Job-search vertical | Discover/import listing→authority/answer bank→application/approval→status/funnel/exception→export/erase; truthful provenance and no unauthorized external submission | Vertical user research and current competitor trials required |

## Compatibility

Primarily feature-package extensions. Each discovered change must be classified anew; a domain plan cannot pre-authorize arbitrary wire additions. Preserve disabled/offered states and replay dependencies. No feature is silently removed to improve its grade.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S11-T1 | All229 directory rows have owner, runtime registry mapping and actual deployment availability | Inventory + signed-in operator | Mechanical completeness plus runtime truth; source existence alone insufficient |
| S11-T2 | Each domain completes positive and negative business outcome with reconciled data | Domain fixture + role/tenant users | Specific family witness, not healthcheck |
| S11-T3 | Every real marker/debt item has resolved behavior or explicit still-open externally gated input | Code/domain reviewer | Complete candidate classification ledger and regression evidence |
| S11-T4 | New gap PRD and existing ADR/RFC trace lead to implemented/verified closure | Domain owner + reviewer | No automatic A from document/status/manifest |

## Alternatives considered

- Audit only high-traffic bundle: useful first wave but rejected as total-scope closure.
- Implement every competitor feature without buyer/evidence test: rejected; wastes effort and invents gaps.
- Complete census, refine confirmed gaps and deliver every family in waves: chosen.

## Unresolved questions

1. Which buyer outcomes are contractual per family and which specialist is the meaningful bar? Resolution: Create explicit task/subcapability rubric from current source and primary research. Owner: Product/domain leads. Blocks: domain acceptance thresholds.
2. Which OFF/BETA/vertical fixtures and credentials can be safely enabled for qualification? Resolution: Disposable deployment/tenant fixtures with existing server gates. Owner: Domain/security owners. Blocks: runtime coverage.
3. Which source markers are real deferred work versus valid simulations/placeholders? Resolution: Classify every candidate with code-context evidence. Owner: Domain maintainers. Blocks: debt closure.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | All feature registries/ADRs + feature-census.json | 229-row owner/availability/capability mapping |
| 2 | Domain-specific fixtures and current specialist research | Graded subcapability matrix with confirmed gaps |
| 3 | Per-gap five-pass PRDs and existing feature packages | Implementation + meaningful regression evidence, all families retained |
| 4 | All marker candidates + existing assessment/manual-test ledgers | Classified debt and closure/regrade trail |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] Every inventory row and confirmed new finding has disposition; no unknown gets silently relabeled absent or complete.
- [ ] Domain-specific journey matrix below is satisfied for every owned feature.
- [ ] All real debt candidates remedied or explicitly still open with external gate; grep baseline reduction is not closure.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs FAM-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [Feature census](feature-census.json)
- [Original mechanical inventory](../../research/platform-audit-2026-10-24/inventory.json)
- [Product-family audit](../../research/platform-gap-analysis-2026-10-24.md)
- [Feature catalog](../../../FEATURES.md)
- [Source registry](../../../backend/typescript/src/features/index.ts)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.
