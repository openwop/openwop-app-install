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

   > **CORRECTED 2026-10-13 (wave-36 grading, ABR-RENDER-1 / ABR-REPAIR-1 /
   > ABR-GATES-1) — "one normalization gate" was a DATA-LOSS gate on the update
   > path.** The render node rebuilt every document from a fixed field list
   > (`{type, props, children}` per node; a fixed set of top-level keys), and
   > the update half of this very decision CAS-wrote that copy. So the loop the
   > agent prompt prescribes, get-design → render with `baseVersion`, erased
   > `models`, `operations`, `stateVariables`, `authProfile`,
   > `componentDefinitions`, `sharePolicy`, `envRequirements`, the design refs,
   > and every node's `actions`/`bindings`/`hidden`/`locked` (the ADR 0343/0344
   > facets, which all post-date this ADR and never reached the node), and it
   > reported success. The governed repair node ran the same gate, so a repair
   > did the same. Separately, the node DROPPED invalid values (a non-hex color,
   > an out-of-enum trigger, an 11th sample row) before `validateAppDoc` ran, so
   > the "violations return as structured errors" half above never fired for
   > them; and `validateAppDoc` accepted unknown keys the artifact schema
   > refuses, so the editor gate and the emit gate disagreed.
   >
   > **The decision now reads:** the render node NORMALIZES; it does not FILTER.
   > - It starts from a deep copy of the whole document, so a facet survives
   >   by construction, including one added after this note.
   > - The only rewrites left are: slug an id that fails `ID_RE` (a valid id is
   >   kept verbatim; slugging used to lowercase `Products`), then follow every
   >   reference to a renamed id; snap and clamp finite layout coordinates;
   >   collapse duplicate `(from, to)` connectors.
   > - Nothing invalid is removed. It reaches `validateAppDoc` and comes back as
   >   a typed `app_doc_invalid` that names the field. A connector to a missing
   >   screen is kept, because the validator treats it as a legal mid-edit state.
   >
   > `validateAppDoc` takes the artifact schema's `additionalProperties` verdicts
   > directly (`unknown_prop`), so the allowed-key set has one owner,
   > `artifactTypes.ts`. It takes ONLY that keyword: the schema's `required`
   > lists would refuse a screen with no name yet, a legal editor state, and
   > running every keyword failed 17 existing editor-path tests (measured).
   >
   > The repair node:
   > - validates its candidate through the same gate with the host surface;
   > - feeds the first failure back once, the bounded repair;
   > - fails `app_doc_invalid` on a second failure;
   > - carries over any top-level facet the model omitted. Absent means
   >   unchanged; to clear a facet the model emits it empty.
   >
   > Deepen still drops unknown keys, deliberately: it replaces a thin screen
   > with fresh model output, so there is no user data in it to preserve.
   >
   > Witnesses: `src/features/app-builder/__tests__/renderPreservesFacets.test.ts`
   > (19 of 22 red on `d812ae704`; the other three are guards) and two
   > end-to-end tests in `test/app-builder-agent-tools.test.ts` (both red on
   > `d812ae704`). Pack `feature.app-builder.nodes` 1.9.3 → 1.10.0. It is
   > image-vendored and steward-attested, not registry-installed: production's
   > `OPENWOP_INSTALL_PACKS` (57 entries, read 2026-10-13) does not name it, so a
   > deploy ships it and no registry republish is needed.
   >
   > **The open gap, stated plainly:** a repair model that rewrites a node and
   > omits that node's `actions` or `bindings` still loses them. Absent can only
   > be read as "unchanged" at the top level, where keys are stable. Inside a
   > tree that the model is allowed to restructure, there is no identity to
   > carry them over by. The prompt now names those fields, which is the only
   > lever at that depth.
   >
   > > **CORRECTED 2026-10-15 (ABR-REPAIR-2) — "the only lever at that depth"
   > > was too strong. There is a structural lever, but only where the tree was
   > > not restructured.** Components still carry no id, so the repair node
   > > matches by position within a screen with the same id:
   > > - **Same tree of types:** the screen was not restructured, so a position
   > >   identifies the same component. Any `actions`, `bindings`, `hidden` or
   > >   `locked` the model omitted is carried from that position. Emitting
   > >   one empty (`[]`/`{}`) removes it.
   > > - **Restructured:** positions shifted, and guessing would put an action
   > >   on the wrong component. No guess is made. The candidate is refused
   > >   when a non-empty `actions`/`bindings` value is missing from the screen
   > >   and a component of the same type still omits that key, because that
   > >   looks like a drop, not an edit. The refusal is fed back as the bounded
   > >   repair, and if the retry still drops it the repair fails
   > >   `app_doc_invalid`. A value that moved to another component, a removed
   > >   component, or an edited value is not refused.
   > >
   > > What is left is narrower and no longer silent. A model that rewrites a
   > > restructured screen's actions into a different non-empty value replaces
   > > them, and the reviewer sees it at the approval gate. That is an edit,
   > > which is what a repair is for.
   > >
   > > Witnesses: five `ABR-REPAIR-2` tests in `renderPreservesFacets.test.ts`
   > > (the three preservation tests are red on `600cae4f6`; the two guards for
   > > deliberate removal hold on both). Pack 1.10.0 → 1.10.1, still
   > > image-vendored, so no registry republish.
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
