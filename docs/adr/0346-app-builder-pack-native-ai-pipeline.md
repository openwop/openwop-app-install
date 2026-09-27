# ADR 0346 — App-builder pack-native AI pipeline (workflows pack, typed artifacts, repair loop)

Status: implemented (2026-07-10) — 4a+4b #1690, 4c #1692, 4d (this PR); AI-08 clarify + prd/plan capture = recorded deferrals

**Program:** ADR 0342 Phase 4. **Depends on / composes:** ADR 0152 (workflow-chain
pack loader), RFC 0013 (chain packs; Path-A param freezing) + RFC 0124
(deferred parameters), ADR 0157/0072 (`builtinWorkflows` — the seam this
retires), ADR 0305 F (the original `feature.app-builder.workflows` promise),
ADR 0325 (the design chain + its correction notes), ADR 0343 (the facets the
AI emits), RFC 0071 (artifact types).
**Research:** gap doc §5.4 AI-01..12, §7 pack topology.
**Toggle:** `app-builder` (unchanged; packs stay decoupled from toggle state).
**Surface:** host packs + boot glue + FE workbench renderer; no wire.

---

## Context (pipeline seam audit, 2026-07-10)

- `app-builder.design` is HOST-BUNDLED (`feature.ts:72 builtinWorkflows`,
  `designWorkflow.ts` — a concrete `WorkflowDefinition`), though its content is
  RFC 0013-portable (all typeIds are published `core.*`/`feature.app-builder.nodes.*`).
- **No feature has ever pinned a `workflow-chain` pack** — chains reach the host
  via the in-tree `examples/workflow-chain-packs/` root or `OPENWOP_INSTALL_PACKS`;
  `requiredPacks` + chain packs is net-new composition, not a copy.
- `feature.*` packs live natively in this repo's `packs/` and reach runtime via
  the dev-mount symlink (`bootstrap/mountLocalPacks.ts`, prefix `feature.`);
  `installRegistryPacks.ts:50` skips on-disk packs, so a pinned in-tree pack
  never hits the registry. Ed25519 signing/publishing lives in the SIBLING
  registry repo — the in-tree unsigned mount is the established local path for
  every `feature.*` pack today (nodes + agents included).
- The chain `idea` input is a RUNTIME variable — under RFC 0013 Path A a plain
  chain param would FREEZE at expansion; **RFC 0124 deferred parameters** are
  exactly the mechanism that materializes it back into a workflow variable.
- Provider/model are hard-coded in the chain config (`designWorkflow.ts:33-34`
  et al) because `ctx.callAI` has NO host default (ADR 0325 correction 3). A
  host resolver EXISTS — `host/modelClassResolver.resolveModelForClass`
  (chat/reasoning/coding/extraction classes) — but only agent dispatch uses it.
- Artifact-type packs register schemas server-side (`artifactTypePackLoader`),
  but the FE workbench has NO generic schema-driven renderer — an unmatched
  `artifactTypeId` falls back to inert Markdown (`rendererRegistry.ts:9-11`).

## Decision

| Slice | Scope | Placement |
|---|---|---|
| **4a — the workflows pack (closes ADR 0305 F)** | `packs/feature.app-builder.workflows/pack.json` (`kind:"workflow-chain"`, v1.0.0): the design chain as a PORTABLE fragment — dag nodes/edges from `designWorkflow.ts`, `idea` declared as an RFC 0124 **deferred parameter** (materializes as the run variable; `\w`-safe). The feature pins it in `requiredPacks` and replaces `builtinWorkflows` with a **minimum boot registration adapter**: expand (`expandChain`) + `registerWorkflow` as `app-builder.design`, idempotent per version, replay-safe (existing runs reference their stored definitions). `designWorkflow.ts` shrinks to glue; the chain JSON is the single source. | in-tree pack (dev-mount path — the same trust posture as `.nodes`/`.agents`; registry signing rides the sibling-repo pipeline when published) |
| **4b — model policy (AI-12)** | Chain AI nodes declare `modelClass` (`chat`) instead of hard provider/model; the 4a boot adapter stamps the RESOLVED `(provider, model)` from `resolveModelForClass` into node config at registration (recording the choice — runs snapshot their definition, so replay reads it verbatim). `OPENWOP_DEFAULT_AI_MODEL`/managed-tier fallbacks come free. `ctx.callAI` still receives explicit values — no node-sandbox change. | boot adapter + chain manifest |
| **4c — typed artifacts (AI-04)** | `packs/feature.app-builder.artifact-types/pack.json` registering `app.prd`, `app.research`, `app.plan`, `app.audit` (bounded schemas); the nodes pack (→1.5.0) emits them as typed SECONDARY outputs (audit's report becomes `app.audit`; research emits `app.research`; prd/plan wrap their text + structured fields); FE: ONE generic structured-artifact renderer registered with a `match` predicate for `app.*` (sections from schema keys — no bespoke component per type). | artifact-type pack + nodes pack bump + one FE renderer |
| **4d — conversation loops (AI-06/07/08, DS-05)** | Clarification: a deterministic completeness node before prd; missing target-users/platform/data triggers the existing chat interrupt. Repair: findings carry stable codes + suggested operations; a `app-builder.repair` chain (same pack) takes `{canvasId, expectedVersion, findingCodes}`, emits a candidate artifact, re-audits, approval-gates; acceptance is a CAS working-copy write. Per-screen review composes existing approval + child-run shapes — **if a collection-review WIRE contract turns out to be required, that is an RFC first (the 0342 watch-item)**. Brand context: an optional node resolving `brandRef` server-side. | nodes pack + chain pack additions |

## Alternatives weighed

- **Keep `builtinWorkflows` and ship the pack as a copy.** Rejected: two owners
  of one chain drift (the reason 0305 F promised the pack in the first place).
- **Auto-register EVERY chain in the pack as a runnable workflow.** Rejected:
  chains are user-instantiated templates (`/workflows/from-chain`); only
  `app-builder.design` (and later `app-builder.repair`) get the boot adapter —
  the chat launches them by id.
- **Resolve provider/model inside the node at run time.** Rejected: nodes are
  sandboxed (no host imports); a per-run resolution would also be
  replay-hostile. Registration-time stamping records the choice.

## RFC verdict

None now — existing pack kinds (`workflow-chain`, `artifact-type`), host-ext
routes, no advertisement. The per-screen collection-review wire shape remains
the flagged RFC gate; 4d must compose accepted shapes or stop and author the RFC.

## Phases

| Slice | Status |
|---|---|
| 4a | landed (this PR) — **with two as-built corrections**: (1) the NORMATIVE chain-pack name grammar (`schemas/workflow-chain-pack-manifest.schema.json`, spec-vendored) forbids `feature.*` — the pack ships as **`vendor.openwop.app-builder.workflows`** at the standard in-tree chain root (`examples/workflow-chain-packs/app-builder/`), the conformant alternative to a wire RFC for a naming nicety; (2) the `requiredPacks` pin is DEFERRED until the pack is registry-published (pinning an unpublished pack would make every boot attempt a doomed fetch — the same posture as the other 25 in-tree chain packs). The adapter (`designWorkflow.ts`) expands RFC-0124-deferred, renames the materialized variable to `idea`, re-stamps output roles (audit=primary), resolves `modelClass` via `resolveModelForClass`, and registers via `registerBuiltinWorkflow` from `registerRoutes` (builtinWorkflows arrays evaluate at import time — before chain packs load) |
| 4b | landed (this PR, folded into 4a) — chain config carries BOTH portable `provider/model` defaults (a plain host expanding the chain still works) AND `modelClass: 'chat'`; the boot adapter overrides from the host policy resolver and strips `modelClass` before registration (the callAI contract stays explicit) |
| 4c | landed (this PR) — `feature.app-builder.artifact-types` pack registers **`app.research` only** (as-built: a registered type with no producer is a DEAD type — prd/plan/audit register WITH their 4d producers); the research node (nodes pack →1.5.0, re-pinned) emits the `.artifact` envelope so the mid-graph deliverable seam persists a schema-validated typed secondary (soft-fail emits NO envelope); FE: ONE generic lazy-split `app.*` match-predicate renderer (schema-blind sections; escaped text; depth-capped) so new app.* types never fall to inert Markdown |
| 4d | landed (this PR) — the GOVERNED REPAIR LOOP: surface ops `getDesign` (tenant-scoped read + CAS basis) and `applyRepair` (full-validator gate + `updateCanvasForTenant` CAS + snapshot; concurrent edit = typed 409); nodes pack →1.6.0 adds `repair` (surface read → one AI call → re-normalized through the SAME render gate; HARD-fails on AI failure), `capture` (config-driven typed envelopes), `apply-repair` (writes only the APPROVED candidate); chain pack →1.1.0 adds the `app-builder.repair` chain (repair → re-audit → review gate → apply, apply triggered only by approval) and inserts the `app.audit` typed record into the design chain; artifact-types →1.1.0 adds `app.audit` WITH its producer; the adapter generalizes to register both chains (param-driven variable renaming). **As-built deferrals:** the AI-08 clarification loop needs an input-COLLECTING interrupt primitive (approvalGate can't carry text back) — deferred with the RFC-gate trigger (compose-or-RFC, the 0342 watch-item) — **[correction 2026-07-18, docs/DECISIONS-adr0342-deploy-stack-clarify.md]: the primitive ALREADY EXISTS — `kind:'clarification'` (`bootstrap/nodes.ts:929`, `core.clarificationGate` with `data.schema`), the generic `resumeValue` answer path (`routes/interrupts.ts` → executor `suspendResolution`), and the Stable wire shape (`spec/v1/interrupt.md` ClarificationData/ClarificationResume). The gap was composition (approvalGate chosen over clarificationGate), not a missing wire surface; NO RFC needed — compose-or-RFC resolves to COMPOSE]; **AI-08 LANDED 2026-07-18**: intake+clarify stages prepended to the `app-builder.design` chain (pack 1.3.0 — VERDICT_CLARIFY/VERDICT_OK conditional routing, any_success fan-in on prd, answers carried on the `clarifications` port); executor-level + chain-expansion tests in `test/app-builder-clarify-loop.test.ts`. `app.prd`/`app.plan` capture stages = recorded follow-up (visible today as plain secondaries); per-screen review remains composed-shapes-only pending real usage |
