# Section 08: Functional app-builder output and governed deployment

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | APP-01 |
| Proposed accountable role | App-builder / generated-runtime engineering; staffing unconfirmed |
| Dependencies | 02, 05, 07 |
| Effort | XL; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [08-functional-app-builder-and-governed-output.gaps.md](08-functional-app-builder-and-governed-output.gaps.md) · [08-functional-app-builder-and-governed-output.risks.md](08-functional-app-builder-and-governed-output.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Close the functional-app gap end to end: production-safe live operations, action/binding parity, authenticated generated services and governed deployment. Capability disclosure remains mandatory during rollout but does not count as implementing missing behavior.

## Motivation

Preview closed actions call declared mock operations (`previewRuntime.ts:93`); UI generator capability baseline has empty actionKinds/bindingPathRoots/appContract (`export/capabilityManifest.ts:39`). Existing export preflight truthfully warns; backendGen emits real model CRUD but action/unbound operations return501 (:155). ADR 0345 3e live mode and ADR 0348 6e adapter are unfinished in their recorded status. ADR 0349 explicitly scopes deployment without an executor, so a new deploy implementation requires an accepted amendment/adapter decision. There is already one design model, export lineage, publish/sync and approved-artifact hash; extend them.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S08-R1 (APP-01)** — Build the complete facet × target matrix from existing seven generator targets and model/actions/bindings/auth/env/layout facets. For each, keep current support, implementer and executable parity fixture; unsupported advertised behavior remains open. Do not close APP-01 by renaming the output a design export.

- **S08-R2 (APP-01)** — Implement approved live preview through existing credential/connection/egress/governance owners with explicit sandbox/target selection and user consent. Simulation stays visibly separate and deterministic. Validate operation inputs/outputs, typed errors, timeout/cancel, permission and retry behavior.

- **S08-R3 (APP-01)** — Extend each generator to execute declared closed actions, state/binding roots, data operations and responsive behavior appropriate to its framework. Generate from the same validated application model; capability claims are derived from proven output. Preserve existing navigation, source addresses, hashes, source preview/diff and replay determinism.

- **S08-R4 (APP-01)** — Replace incomplete backend action scaffolds with declared validated operation bindings; unknown/unconfigured custom logic stays blocked, never silently successful or unrestricted arbitrary code. Generated CRUD requires input/output validation, authn/authz, tenant/record policy, bounded pagination/query, migrations, secrets-by-reference and safe error handling before being classified deployable.

- **S08-R5 (APP-01)** — Design and accept the ADR 0349 amendment for an operator-selected first deployment adapter, then implement the existing approved-hash artifact→preflight→approval→deploy→smoke→release evidence chain. Keep full other-target roadmap; no empty deploy button or alternate hardcoded workflow. Extension uses existing chains/registry; a normative new pack kind would need an upstream RFC.

- **S08-R6 (APP-01)** — Qualify generated apps on isolated infrastructure through create/read/update/delete/custom action, sign-in/role denial, restart/migration, media, mobile/theme/AT and version rollback/recovery. Vendor writes need explicit execute-time credentials/approval. Publishing source is not proof the generated service works.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Functional parity is an explicit capability contract, not inferred from visual preview or successful GitHub publish. |
| Schema | Extend AppDoc/target capability manifests from existing schema owner; preserve old document readers and deterministic exports. |
| Security | Generated backend must enforce isolation/validation; live preview and deploy use brokered credentials, egress policies and exact approved artifact. |
| Conformance | Differential fixtures run preview and compiled target apps; negative auth/input/custom-action tests and real deploy smoke prove behavior. |
| Compatibility | App model/export/runtime evolution versioned and old design exports readable; deploy-adapter scope changes need recorded ADR review. |

### Proposed data and interface impact

Keep the validated AppDoc and generator manifest as sources. Operation binding/authProfile/envRequirements must describe references/permissions rather than embedding tokens or a second user store. If new host-local deployment records are needed, attach reviewed artifact hash, tenant/actor, target/config ref, approval and actual status to existing lineage/Operations owners. Runtime design-model changes get backward-compatible reader and fixtures.

## Compatibility

Host-local design/runtime/output changes do not automatically need a protocol RFC. Existing RFC 0021/pack/connection contracts are reused. If the design chooses a cross-host deploy-adapter kind, new event or discovery contract, author a separate upstream Draft; do not mint a kind in the host under a protocol namespace. No scoping ADR is silently overturned.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S08-T1 | Same declared actions/state/bindings produce equivalent observable results in preview and each compiled target | Golden application fixtures | Seven target-specific executable tests; native toolchain absence is blocked |
| S08-T2 | Generated service rejects malformed, unauthorized and foreign-tenant access and paginates safely | App auth/data fixture | Running generated backend, not string snapshot |
| S08-T3 | Live preview refuses unapproved/unknown egress and distinguishes real failure from mock result | Test broker/provider + user consent fixture | No production credential or arbitrary-network fallback |
| S08-T4 | Only reviewed artifact hash deploys; smoke proves real app and rollback/restore route | Authorized disposable deploy operator | Existing approved chain/adapter; source publish alone insufficient |

## Alternatives considered

- Documentation-only downgrade: preserves honesty but does not close requested functional gap.
- New independent app generator/deployer/runtime: rejected; shadows existing AppDoc/chassis/lineage/governance.
- Extend existing model, generators and adapter contract: chosen; requires phased parity and security qualification.

## Unresolved questions

1. Which adapter/stack is first and which credentialed environment qualifies it? Resolution: Accept ADR 0348/0349 amendment and provide isolated target. Owner: App-builder + infrastructure owners. Blocks: live backend/deploy implementation.
2. How are custom action bindings declared and constrained without arbitrary unreviewed code? Resolution: Review closed operation catalog/adapter semantics and schema. Owner: App-builder/security owners. Blocks: backend action implementation.
3. Which targets need platform-specific equivalents rather than identical CSS/runtime behavior? Resolution: Define target parity matrix and executable fixtures. Owner: Generator owners. Blocks: per-target A grade.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | AppDoc/manifest/preflight and existing ADR 0342–0349 | Complete target/facet matrix and accepted scope decisions |
| 2 | Live preview + validated operations + generated backend | Brokered auth/validation/tenant/pagination and negative witnesses |
| 3 | Existing framework/native generators | Behavior parity, deterministic lineage and migration evidence |
| 4 | Governed deploy chain/adapter + isolated target | Approved-hash deploy/smoke/recovery and full target roadmap |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] Every declared generator behavior has compiled execution evidence, and incomplete actions remain explicitly blocked until implemented.
- [ ] Generated applications pass auth/tenant/input/egress/security review before deployable status.
- [ ] Live operation and deployment phases are implemented/qualified; truthful warnings alone do not close APP-01.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs APP-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [Application model program](../../adr/0342-app-builder-application-model-program.md)
- [Interactive runtime](../../adr/0345-app-builder-interactive-runtime.md)
- [Output contract](../../adr/0348-app-builder-production-output-contract.md)
- [Deployment decision](../../adr/0349-app-builder-governed-deployment-scoping.md)
- [Generator source](../../../backend/typescript/src/features/app-builder/export/backendGen.ts)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.
