# ADR 0471 — RFC 0133 workflow-chain composition: host reference-impl + witness

Status: implemented (2026-07-23)

## Context

RFC 0133 ("workflow-chain composition") additively extends the RFC 0013
workflow-chain-pack format with two capabilities that unblock the composed /
stateful builtin workflows from converting to chain packs (the chains-or-stacks
doctrine — a workflow is never a hard-coded in-tree module):

1. **Sub-chains** — a chain fragment declares `subChains[]` (each a sibling
   `chainId` or an external `{packName, chainId, version}` ref) and references one
   from a runtime dispatch node via `config.subChainRef` (a hard-coded
   `config.workflowId` stays INVALID inside a fragment). On `from-chain`
   instantiation the host co-expands + co-registers each child as its own owned
   workflow and rewrites the reference to the minted child id — the parent
   genuinely *holds* the child (workflows hold workflows).
2. **Produced variables** — a chain declares `producedVariables[]` ({name,
   producedBy, type}) — a run-scoped value a node writes to the executor's
   variable bag that a downstream reads via `{type:'variable', variableName}`.

RFC 0133 was authored + merged **Active** on `openwop/main` (#873); its
Active→Accepted gate is **this host's conformance witness** (the RFC 0132
reference-impl-tier precedent). This ADR records the openwop-app host leg.

This was built collaboratively across two sessions over the `crosstalk` bus: the
spec session (`openwop-1`) owned `openwop/RFCS/0133` + the schema/spec/conformance
surface; this host session owned the openwop-app reference-impl + the witness. A
first solo attempt (#2423) was reverted (#2427) so the two repos could land in
lock-step against the *final* spec (this redo).

## Decision

Implement both capabilities inside `host/workflowChainPackLoader.ts` +
`routes/workflows.ts` (from-chain) — no parallel path, reusing the existing
`registerWorkflow` / `recordOwnership` / executor variable-bag / `core.subWorkflow`
seams. Advertise `capabilities.workflowChainPacks.subChains {supported, maxDepth:8}`
in `/.well-known/openwop`, honest-by-construction with the from-chain behavior.

Key host rulings (ruled with `/architect`, aligned with `openwop-1` on the wire):

- **Deterministic tenant-scoped child id** — `mintChildWorkflowId(tenantId,
  childChainId, version)` keys on exactly those three. Tenant-scoping is
  load-bearing: `registerWorkflow` is a GLOBAL by-id registry, so a tenant-less id
  would let two tenants collide on one global workflow (cross-tenant break —
  SECURITY `sub-chain-child-tenant-scoped`). Keying on `tenantId` also dedups a
  child shared across parents in a tenant to one registration, and converges a
  repeat instantiation. The exact string shape is NOT wire-normative (the spec
  pins only keying + determinism + tenant-scope); this host keeps a collision-safe
  sha256 hash form, surfaced verbatim in the `subChainWorkflowIds[]` response.
- **Children-first co-registration** — children register DEPTH-FIRST, BEFORE the
  parent, so the parent's rewritten `config.workflowId` always resolves and a
  mid-way failure leaves at worst a harmless unreferenced child (fails closed —
  never a parent → missing child).
- **Load-time closed-world validation** — a malformed pack fails at load, not
  instantiation. The **7 wire error codes** (final set, agreed with `openwop-1`):
  `sub_chain_unresolved`(400) · `sub_chain_cycle`(400) ·
  `sub_chain_max_depth_exceeded`(400) · `sub_chain_unsupported`(422) ·
  `variable_undeclared`(400, incl. produced↔param collision) ·
  `produced_var_producer_unknown`(400) · `chain_fragment_pins_workflow_id`(400).
- **Refuse, never flatten** — a host without runtime child dispatch MUST refuse a
  `subChains`-bearing chain with `sub_chain_unsupported` (422). `OPENWOP_CHAIN_SUBCHAINS=0`
  flips BOTH the advertisement AND the from-chain refusal off together, so a
  deployer that disables child dispatch never leaves a dishonest wire claim — and
  the negative conformance scenario stays witnessable.

## Witness (Active→Accepted evidence)

Booted the openwop-app reference host in-process
(`conformance/witness-boot-rfc0133.ts`) and ran the sibling
`@openwop/openwop-conformance@1.56.0` RFC 0133 scenarios under
`OPENWOP_REQUIRE_BEHAVIOR=true`:

- **Positive posture** (subChains advertised `{supported:true, maxDepth:8}`):
  **5/5 scenario files, 22/22 tests pass**. The two capability-gated §B legs
  (`chain-subchain-fanout`, `chain-subchain-unsupported-refused`) run
  **non-vacuously** — no soft-skip.
- **Negative posture** (`OPENWOP_CHAIN_SUBCHAINS=0`): the host honestly OMITS the
  `subChains` block; `chain-subchain-unsupported-refused §B` runs its real refusal
  assertion (2/2).
- Host unit coverage: `workflow-chain-composition.test.ts` (15/15 — producedVariables
  emit, all load validations incl. the 7 codes, cycle + depth bound, co-registration
  + deterministic tenant-scoped id + unsupported refuse); backend `tsc` 0 errors; the
  workflow-chain load-path + from-chain route suites green.

## Consequences

The 5 format-ext-blocked builtins (Challenge Factory + `lesson-batch`,
`plan-generation`, `campaign-orchestration`, kicktodo `enrollment`) are now
UNBLOCKED to convert to chain packs (a follow-up, Factory first). No wire surface
was added by this host — `workflowChainPacks.subChains` rides the accepted-pending
RFC 0133; `subChainWorkflowIds[]` on the non-normative `/v1/host/openwop-app/*`
from-chain route needs no RFC. Additive: chains without the new fields behave
exactly as under RFC 0013.
