# ADR 0358 — App-builder AI-exchange remediation: real tools, SSoT-bound catalogs, authoring-time validation

| | |
|---|---|
| **Status** | implemented (Phase A #1724; Phase B #1733; Phase C+E the pack-rewire PR, 2026-07-12) |
| **Date** | 2026-07-12 |
| **Deciders** | architect review (options evaluation, 2026-07-12) |
| **Relates to** | ADR 0308 (deliverable tools), ADR 0346 (pack-native AI pipeline), ADR 0347 5b (`form`), ADR 0153/0305 (component catalog), ADR 0104 (allowlist overrides), ADR 0132/0135 (capability firewall) |

## Context — the violations (grade-ai-exchange audit, 2026-07-12)

The app builder's LLM exchange broke every rule the app's own reference pattern
(the Workflow Architect, ADR 0072) established, five ways:

- **V1 — dead tool.** The App Architect agent pack allowlisted
  `openwop:feature.app-builder.nodes.render`, but no host registrant provides
  that tool id (`agentToolProvider` `BUILTINS` + the two projected compute
  nodes are the whole universe). `compileAgentTools` resolved zero tools, the
  conversation fell back to a plain completion, and the prompt claimed a
  render capability the model never had — the exact "unfiled promise" incident
  class ADR 0308 was born from.
- **V2 — live drift.** The design chain's plan prompt
  (`examples/workflow-chain-packs/app-builder/pack.json`) hand-copied the
  component type list and was missing `form` (added by ADR 0347 5b). Shipped
  drift, not risk. Fixed by Phase A (#1724) with a both-directions tripwire.
- **V3 — hand-copied catalog, untested.** `prompts/app-architect.md` carries a
  full hand-written catalog (types + props + enums) in direct violation of
  `componentCatalog.ts`'s own SSoT rule ("never a hand-copied type list; that
  drifted once"), with no test pinning it.
- **V4 — no runtime request path.** No catalog tool, no design-read tool: the
  model could neither ask for the schemas it must conform to nor read the app
  JSON it was asked to modify.
- **V5 — no authoring-time validation.** Chat-emitted `canvas.app-builder`
  artifacts validate only against the structural artifact schema (`type` = any
  string); `validateAppDoc`'s closed-world check runs only on editor
  PATCH/export/seed. An invalid design renders in chat and 422s the user's
  first editor save — and the model never sees the error, even though the
  agent loop feeds `isError` tool results back for retry.

## Decision

Converge the app builder on the two sanctioned exchange patterns — tool-mediated
live grounding (the Workflow Architect shape) over the ADR 0308
feature-registered-builtin seam — with catalog knowledge derived from
`APP_BUILDER_COMPONENTS` at call/registration time, never hand-copied.

1. **Three real agent tools** (`features/app-builder/agentTools.ts`, registered
   via `registerFeatureAgentTool`):
   - `openwop:app-builder.catalog` — the machine-readable closed catalog
     (schema-request path).
   - `openwop:app-builder.get-design` — current app JSON + CAS version
     (app-state read path).
   - `openwop:app-builder.render` — normalize through the REAL render node
     (`getNodeRegistry().resolve(...)`, the `computeNodeTool` minimal-ctx
     pattern — one normalization gate with the workflow chain), then
     `validateAppDoc` closed-world **at authoring time** (violations return as
     structured `isError` results → the agent loop's error feedback is the
     repair loop), then persist: create via `createCanvasForTenant`
     (run-scoped deterministic `idempotencyKey`, the ADR 0308 GD-0308-1 rule)
     or update via **`surface.applyRepair`** — the ONE governed CAS write
     owner — returning `{ canvasId, version, screenCount, url }`.
2. **Clean tool ids** (documents convention), retiring the node-typeId-shaped
   id. Zero migration cost: the old id never resolved, so any stored ADR 0104
   allowlist override naming it was already dead, and the node-projection
   namespace stays unambiguous.
3. **Catalog projections in the SSoT module** (`componentCatalog.ts`):
   `projectComponentCatalog()` (one function backing the tool AND
   `ctx.features['app-builder'].getCatalog`) and `catalogTypeListForPrompt()`
   (the one-line type list, constrained containers carrying their child rule
   inline).
4. **Registration-time substitution** (`designWorkflow.ts`): any chain
   chatCompletion prompt containing `Use ONLY these component types:` gets the
   list re-derived live at registration — the pack's portable copy can never
   drift what a run's model sees. Deterministic (pure function of the catalog
   in array order); the Phase A tripwire pins the registered output.
5. **Firewall posture:** render is tenant-store content creation — the
   `documents.draft` classification, deliberately NOT in
   `SENSITIVE_APPROVAL_TOOLS`. Gates mirror the HTTP editor path: per-call
   `app-builder` toggle (fail-closed), acting user required, org RBAC via
   `resolveEffectiveAccess` (write = `workspace:write`, read =
   `workspace:read`).

## Alternatives rejected (architect options evaluation)

- **Tool dispatches the design chain** — degrades the agent to a dispatcher;
  the chain re-authors from an idea via its own PRD→plan, discarding the
  design the agent composed in conversation; duplicates the existing
  chain-launch surface.
- **Inject a workbench artifact from the tool result** — tool results carry no
  artifacts today (`runArtifactStore` is run-scoped); this would stand up a
  second artifact pipeline. The inline-workbench experience remains the design
  chain's job; the tool returns a deep link (`/app-builder/:canvasId`).
- **Keep the node-shaped tool id** — permanently misdescribes a host tool as a
  pack node and reserves a projection-namespace collision, for a migration
  benefit that is zero (the id never worked).

## Phases

| Phase | Scope | Status |
|---|---|---|
| A | Chain-pack drift hotfix (`form` + both-directions tripwire; pack 1.2.0) | shipped #1724 |
| B | `agentTools.ts` (3 tools) + `surface.getCatalog` + catalog projections + registration-time substitution + this ADR + tests | shipped #1733 |
| C | Agents pack 1.3.0: hand-copied catalog deleted from `app-architect.md`, tool-first flow (catalog → compose → render; get-design before updates), allowlist = the three new ids; nodes pack 1.7.0: `deepen`/`repair` read `getCatalog().promptTypeList` with `CATALOG_TYPES` fallback; `surface.getCatalog` grew `promptTypeList` (architect Q-c: never re-implement format logic in pack JS); `feature.ts` pins in lockstep | shipped (pack-rewire PR) |
| E | Folded into C: the `catalogParity` prompt tripwire INVERTED (sentinel-type absence replaces names-every-type — the old test demanded the hand copy stay complete), allowlist↔tool-id parity test, FEATURES.md row | shipped (same PR) |

**Correction note (Phase C):** the ADR 0305 Phase-C test "the App Architect pack
prompt names every catalog type" (`catalogParity.test.ts`) enforced the OPPOSITE
of this ADR — completeness of the hand copy. It was replaced (not deleted) by
the independence tripwire: sentinel catalog types must be ABSENT from the
prompt, and the tool-first protocol present. The parallel 1.6.x catalog wave
(textarea/dateInput/fileUpload) had to hand-update four copies the day before
this landed — the tax this phase retires.

**Sequencing invariant:** Phase B is inert (tools registered, no agent
allowlists them) — the agent stays in its current state until Phase C flips the
pack atomically. No broken intermediate state.

## Consequences

- The App Architect becomes a **pattern-B (tool-mediated) exchange**: the model
  requests schemas, reads app state, and gets validation errors while it can
  still react. The prompt shrinks to workflow + quality guidance (Phase C).
- Catalog knowledge has ONE source and three sanctioned projections; every
  prompt copy is either substituted at registration or deleted.
- No wire change anywhere: agent tools, prompts, and pack fixes are all
  host-internal. No RFC needed (CLAUDE.md rule confirmed at review).
- Replay/fork untouched: runs snapshot their definitions; the tool's canvas
  writes are ordinary tenant-store operations with CAS + idempotency.

## Open questions

- Should `schemaResponder` (RFC 0021 `schema.request`) also serve component
  catalogs (a registry family beyond node types)? Deferred — the catalog tool
  covers the App Architect; widening the responder is host work that can ride
  a later exchange-audit pass.
- Inline chat workbench rendering of tool-created canvases (an ADR 0069
  extension) — deferred until a real need; the deep link + editor covers
  today's flow.
