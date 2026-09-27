# ADR 0739 — Shared canvas workbench layout with type-owned studio refinement

Status: Implemented (2026-09-20)

## Context

The MyndHyve App Builder demonstrates a strong spatial authoring model: a
stable command region, a separately legible mode strip, dedicated left/right
tool rails, a calm stage, and a low-noise status footer. Its useful lesson is
the **layout grammar**, not its MUI `CanvasShell`, global stores, local-first
WAL, or plugin lifecycle. Those mechanisms would duplicate OpenWOP's existing
owners for `host.canvas`, collaboration, optimistic save/version history, and
the workflow-builder engine.

OpenWOP already has two valid canvas compositions:

- `CanvasEditorPage` owns document-backed `host.canvas` lifecycle.
- `CanvasSurfaceShell` owns shared chrome for engine-backed surfaces such as
  Workflow Builder; the surface owns its own engine/persistence.

ADR 0365 explicitly accepts that lifecycle split while sharing chrome behavior.
The remaining layout gap was visual and experiential: the editor's persistent
workspaces competed with one-shot toolbar commands, rails read as detached
cards, and neither composition exposed a stable bottom context region.

## Decision

Introduce `canvas/CanvasWorkbench` as the small, lifecycle-neutral visual
contract for both compositions. It supplies a common root marker and semantic
status-bar primitive; the existing composition remains the owner of all state,
authorization, persistence, collaboration, and undo behavior.

The shared workbench contract provides:

1. A continuous command → mode → rails/stage → status layout using design
   tokens only, including the neutral dotted stage treatment and responsive
   collapse behavior.
2. A dedicated, accessible mode strip in `CanvasEditorPage`. Graph and
   type-provided workspace modes leave the dense command bar but retain their
   established actions and document-history seam.
3. A truthful status footer in both compositions. It only describes existing
   state and universal shortcuts; it is not a live region or a new source of
   canvas state.
4. An optional `CanvasTypeDefinition.workbench` presentation seam for a type's
   localized mode-strip label and a narrowly scoped modifier class. It cannot
   register routes, workflows, persistence, or stores.

App Builder adopts that seam only after the core frame is in place. Its
specialization is limited to vocabulary and a local studio accent; no
`canvas/` module imports an App Builder module.

## Alternatives considered

- **Port MyndHyve's CanvasShell and registries.** Rejected: that creates a
  second persistence/controller/plugin system, violating the single-owner
  rules in ADR 0310 and `ARCHITECTURE.md`.
- **Fold both OpenWOP compositions into one lifecycle component.** Rejected:
  ADR 0365 already established the correct split. The document and workflow
  engines have different authoritative stores and undo semantics; a layout
  contract removes visual drift without falsifying either boundary.
- **Make an App Builder-only restyle.** Rejected: every canvas should inherit
  the spatial grammar first, and type-specific polish belongs at the
  definition seam.

## Architecture review

Track A — application architecture only. No backend route, durable data,
authorization, feature-toggle, capability, event, workflow, or wire shape is
changed. The work extends the `frontend/react/src/canvas/` shared chassis seam.

| Category | Status | Notes |
|---|---|---|
| Boundaries and duplication | Pass | One visual contract, both accepted lifecycle compositions preserved. |
| Security and authorization | N/A | No client authority or request path changes. |
| Data integrity and replay | N/A | No canvas documents or workflow records are altered. |
| Coupling and cohesion | Pass | The type-specific class/label flows definition → chassis; no reverse feature import. |
| Performance | Pass | CSS-only stage texture; no network, polling, or storage work. |
| Testability | Pass | Unit pins cover the shared shell marker/status and mode-strip behavior; browser pass covers rendered layouts. |
| Wire / capability / replay | N/A | Frontend-only; no RFC required. |

## Implementation record

| Phase | Scope | Gate | Status |
|---|---|---|---|
| 1 | Shared `CanvasWorkbench`, both composition mounts, rails/stage/status CSS, workspace mode region | canvas unit tests + frontend build | done — 31 focused unit assertions and the full frontend build gate pass |
| 2 | App Builder localized studio adoption and visual refinement | App Builder tests + browser light/dark review | done — verified at desktop, dark theme, and 320px with no horizontal overflow |
| 3 | Engineering/UX review and production verification | review + grades + production smoke | done — architecture, code, UX, data reviews and the clean local CI gate pass; production smoke follows merge |

## Wire / RFC

None. This is a frontend presentation change; existing `host.canvas` and
workflow-engine contracts are unchanged.
