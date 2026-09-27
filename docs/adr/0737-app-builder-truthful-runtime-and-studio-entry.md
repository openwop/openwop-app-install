# ADR 0737 — App-builder truthful runtime and studio entry

Status: Accepted (2026-09-19 — implementation authorized)

## Context

The app-builder document, catalog, mock-operation runtime, export lineage, and
shared canvas chassis are already mature. A cross-feature UX audit found a more
fundamental gap: the generated application renderer approximated interactive
catalog controls as visual `span` elements and the viewer handled only a
delegated click. The model therefore claimed inputs, links, forms, and controls
that keyboard users could not operate. The same audit found the editor hard to
discover without a canvas id, and several application-document facets were
preserved but not sufficiently visible to a human author.

MyndHyve demonstrates the useful product lesson — a visible, artifact-driven
creative flow — but its duplicate controller paths and incomplete keyboard
canvas must not be copied.

## Decision

Extend the existing `app-builder` feature and the existing canvas framework;
do not create a second application store, a second preview runtime, a global
editor state store, or a MyndHyve-derived controller.

1. `InteractiveViewer` remains the sole runtime mechanics owner. It adds a
   narrow, generic event bridge for native form input and submit; the state is
   per mounted preview, ephemeral, and can only update a renderer-stamped,
   declared `state.<id>` binding.
2. The app-builder renderer remains the sole closed component renderer. In read
   mode it emits native controls and semantic headings/progress/link/form
   markup. It continues to use the existing closed action interpreter and
   mock-only operation resolver: no browser egress, expression evaluation, or
   persistence is introduced.
3. Shared graph nodes use a real, sibling keyboard button rather than an ARIA
   button wrapping Connect/Add buttons. The graph keeps its pointer manipulation
   and keyboard nudge contract, but no longer nests interactive controls.
4. Discovery must compose the existing canvas/document inventory and
   type-pinned host surface. It may never introduce a parallel app inventory or
   bypass tenant/owner visibility checks.
5. The remaining application facets are exposed through type-owned workspace
   panels and property widgets. The canvas framework owns only generic slots,
   chrome, history, state recovery, and accessibility contracts.
6. The App Builder home may deep-link only to the shared Workflow Builder's
   normal template preflight. It never instantiates, runs, or persists an
   App-Builder workflow itself: the preflight mints the ordinary tenant-owned,
   editable workflow copy.

## Boundaries

| Concern | Owner |
|---|---|
| Canvas document, versions, tenant isolation, CAS | `host.canvas` / `canvasSurface` |
| Canvas runtime mechanics, viewport, graph, chrome | `frontend/react/src/canvas/` |
| App controls, data/action semantics, preview projection | `features/app-builder/` + app renderer |
| AI design workflow and catalog vocabulary | existing app-builder packs and `designWorkflow` |
| Live operation egress | deferred until an installed operation-adapter pack exists; ADR 0345 3e remains the gate |
| Deploy provider | deferred until an operator selects a provider; no capability is advertised meanwhile |

## RFC verdict

None. This is a host-local frontend/shared-chassis change. It changes no
OpenWOP wire shape, advertised capability, endpoint contract, or normative
behavior.

## Delivery plan

| Phase | Outcome | Status |
|---|---|---|
| 1 | Semantic preview controls, two-way ephemeral state bridge, form submit, graph accessibility repair, contract tests | implemented |
| 2 | Discoverable App Builder entry composed from the single canvas inventory; blank start, existing-design re-entry, and the editable PRD-to-review workflow-template entry | implemented |
| 3 | Logic & Data authoring for declared data sources, bindings/actions, guards, references, and share policy | implemented; reusable-component instantiation remains a separately-scoped catalog/runtime capability |
| 4 | Source review/preflight mapping, quality findings, responsive states, collaboration snapshots | implemented where already hosted: export preflight now surfaces in the UI; responsive device preview and CRDT element collaboration retain their existing chassis owners |
| 5 | Governed live adapters and deployment only after their respective provider/pack gates | blocked on provider decisions |

## Consequences

- Public shares and editor preview become closer to the application semantics
  they represent without widening the browser security boundary.
- Every canvas renderer can opt into the generic state bridge, but no type is
  forced to adopt app-builder fields or interaction semantics.
- The implementation must add semantic DOM, keyboard, form-event, graph, and
  regression tests; visual approximation alone is not acceptance evidence.

## Implementation record

| Phase | Evidence | Verification |
|---|---|---|
| 1–2 | native renderer controls, `InteractiveViewer` input/submit bridge, graph title button, `/app-builder` hub, and the shared-builder template handoff | focused Vitest coverage and the frontend lint gate |
| 3–4 | Data, Logic, and Contract workspaces; export capability caveats shown before source is treated as complete | focused Vitest coverage and the frontend lint gate |

### Correction note — reusable component definitions

`componentDefinitions` is validated and preserved by ADR 0343, but the current
catalog has no `useComponent` node or renderer/export semantics to instantiate
one. Adding a form that creates inert definitions would be dishonest. Its
authoring and invocation remain deferred until a closed catalog addition can
cover validator, renderer, preview runtime, export generators, and component
definition history in one change.

### Correction note — workflow authoring entry

The App Builder's production PRD → research → plan → render → deepen → audit
→ review and repair processes were already chain-pack definitions, not UI
sequences. This ADR's first hub implementation exposed only blank-canvas
creation, however, which made the editable workflow route needlessly hidden.
The hub now opens the existing Workflow Builder preflight for
`app-builder.design`; it remains the sole owner of template instantiation and
creates the usual tenant-owned workflow copy. There is no App Builder-specific
kanban flow to migrate: should a future app-design handoff create work items,
it must use the existing Kanban stack/chain intake rather than add a local task
queue.
