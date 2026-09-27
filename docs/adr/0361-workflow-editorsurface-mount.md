# ADR 0361 — Mounting the workflow builder as a canvas type via the EditorSurface seam (§7.10 end state)

Status: Implemented (Phases 1–2, 2026-07-12) — the observation half of the
Phase-0 gate was satisfied by the live local CT-CV-1..7 pass (see the Phase-0
correction note). **Release gate CLOSED (2026-07-13):** the production deploy
shipped (live asset hash matches the staged build) and the prod re-verify ran —
the builder chrome converged live (canvas, rails, ZoomCluster, `[` fold, `?`
overlay on app.openwop.dev); the canvas-TYPE CT items are unreachable on prod
BY DESIGN (their feature toggles are OFF — the product posture), so they
re-verify when those toggles flip, not before.

## Context

DESIGN.md §7.10 ruled the workflow-builder question in two halves: NO
document-model merge (reaffirming ADR 0310 — the builder edits a DAG through
xyflow, the chassis edits trait documents), but a FULL chrome merge, executed
in §7 Phases 1–4 (one bar grammar, shared rails/registry/⌘K/zoom
cluster/run drawer — PRs #1736/#1742/#1746/#1750). What changed since
ADR 0310's original rejection is the **`EditorSurface` seam** (ADR 0334): a
center surface that owns its own ENGINE and UNDO while the chassis owns the
shell — proven by the TipTap document editor, and extended by ADR 0359 with
chassis-provisioned collaboration (`EditorSurfaceProps.collab`). ADR 0310
carries the correction note pointing here.

The remaining duplication is structural, not visual: `BuilderShell` re-implements
what `CanvasEditorPage` provides (bar mounting, rails, registry keydown owner,
⌘K projection, announcer, focus mode) with ~200 lines of parallel wiring that
§7 Phase 3 made *identical in behavior* but still *separate in code* — the
exact drift risk §7 canon 1 exists to prevent.

## Decision

Mount the workflow builder as a **`CanvasTypeDefinition` whose center is an
`EditorSurface`** (`WorkflowEditorSurface` wrapping today's `BuilderCanvas`),
retiring `BuilderShell`'s duplicated shell wiring. The definition supplies:

- `canvasTypeId: 'workflow.builder'` (a DEFINITION id for chassis routing —
  **not** a `host.canvas` artifact type; see the persistence ruling),
  `toggleId: 'workflow-builder'` (existing), `EditorSurface: WorkflowEditorSurface`,
  `docNameKey: 'name'`, `shortcuts:` the builder-specific registry extras
  (copy/paste/duplicate nodes — the CV-2 entries move from `BuilderShell`
  into the definition's seam), `ToolbarExtras:` Share ▾ / New / Validate /
  Create-with-AI / Run (the builder's view-cluster + CTAs become the
  definition's typed toolbar slots).
- The surface keeps the **zustand store, snapshot undo, xyflow viewport, run
  overlay, and pre-flight logic unchanged** — the EditorSurface contract
  ("surface owns engine + undo; chassis hides its own undo buttons") is
  exactly the DEF-6/TipTap posture. **CV-8 closes as "surface-owned by
  contract"**: the snapshot undo already meets the §7.4 behavior standard;
  the seam makes that ownership explicit rather than migrating it.

### The persistence ruling (the open question this ADR exists to rule)

**Phase 1 mounts the SHELL ONLY; the builder keeps its own persistence**
(localStorage `SavedWorkflow` + debounced backend sync). The chassis
load/save/version/CAS machinery is **bypassed** via the existing
`EditorSurface`-owns-everything posture: the definition sets no
`clientBasePath` canvas client (a null persistence adapter — the chassis
renders shell + surface and never mounts Save/History/versions chrome for
this type; auto-save stays the builder's, as today). Rationale: workflows are
NOT `host.canvas` documents — they are first-class workflow-engine entities
with their own registration, run history, and packs; forcing them into
`host.canvas` would create the parallel-store smell ADR 0310 banned.
**Phase 3 (own decision, recorded not committed):** evaluate moving workflow
persistence onto versioned canvas-style storage IF version-compare/history
UX is demanded for workflows.

### Collaboration (ADR 0359 composition)

Phase 1 declares **no `collab`** — the builder's zustand store has no Yjs
binding, and ADR 0359's element/tree bindings don't fit a DAG store. A
`collab: 'workflow'` binding (Yjs map over nodes/edges) is Phase-3 scope with
its own ADR-0359-style seam work. This ADR only reserves the composition
point; it does not fake the capability.

## Alternatives considered

- **Leave the two shells converged-but-separate** — rejected: behavioral
  parity without shared code is drift on a timer (every §7 chrome change now
  lands twice; the residues sweep already touched both).
- **Full model merge (workflow doc into `host.canvas`)** — rejected again
  (ADR 0310's reasoning stands; the engine, not the canvas store, owns
  workflows).
- **Chassis-as-library (extract shell pieces the builder imports à la carte)** —
  rejected: that is what Phase 3 of §7 already did for primitives; the
  remaining duplication is the composition layer itself, which is exactly
  what `CanvasEditorPage` is.

## Phases

| Phase | Scope | Gate |
|---|---|---|
| 0 | **Prod deploy + CT-CV click-throughs validate the §7 chrome convergence live** | deploy + /browser pass |
| 1 | ~~`persistence: 'surface'` branch in `CanvasEditorPage`~~ → **`canvas/CanvasSurfaceShell`** (see correction note below): the ONE shell-chrome composition for engine-backed editors — rails chrome (collapse/resize/persist, `[`/`]`), registry + keydown owner, `?` overlay, ⌘K projection, live region, zoom-handle slot. `BuilderShell` slims to content + business logic (toolbar verbs, pre-flight, SSE overlay fold, rail bodies) — **DONE** | FE suite + builder behavior parity pins (registry, rails, ⌘K, run drawer) — all verified live |
| 2 | Duplicated shell wiring deleted (BuilderShell −120 lines of chrome); no dead CSS remained (`.builder-bar`/`.builder-rail` stay as the consumer's content classes); DESIGN.md §7.10 + §5 row (`<CanvasSurfaceShell>`) updated; CV-8 ledger row CLOSED as surface-owned-by-contract — **DONE** | /code-review + /ux-review |
| 3 | Workflow collab binding → **ADR 0364** (Phase 1 binding landed; transport phases gated on the canvas-collab canary + the collab product decision). Canvas-style versioning → the recorded TRIGGER in ADR 0364's versioning note (demand signal or destructive-edit incident). Chrome fold → **resolved by ADR 0365** | own ADRs (0364/0365) |

> **Correction note (2026-07-12, Phase 0):** the gate's OBSERVATION half was
> satisfied by the full CT-CV-1..7 pass run live against a locally-launched
> app (headless Chromium, light + dark — PR #1779, which also fixed the 8
> defects the pass surfaced, including chrome-convergence bugs this ADR's
> premise depends on: the fullbleed `.cv-editor` width fix and the
> elements-board rail gap). The prod deploy remains OPEN (blocked on operator
> gcloud reauth) and stays the RELEASE gate: Phases 1–2 may land on main
> behind behavior-parity pins, but the deploy that takes them live should
> re-verify the key CT items on prod first. Two implementation constraints
> recorded at the Phase-1 architect gate: (1) the doc-optional path must be an
> EARLY composition branch in `CanvasEditorPage` (shared chrome primitives,
> never `doc?`-threading through the canvas lifecycle); (2) surface-mode
> definitions need `railL`/`railR`/`Tail` content slots (chassis owns rail
> CHROME — collapse/resize/persistence; the builder owns rail CONTENT), and
> the rail-persistence + ⌘K source keys must stay `workflow-builder` so
> users' saved layouts survive the mount.

> **Correction note (2026-07-12, Phase 1 architect gate):** the Phase-1 letter
> called for a `persistence: 'surface'` doc-optional branch inside
> `CanvasEditorPage`. Implementation ruled that shape riskier than the goal it
> serves: the page's 2.8k lines hang off the org→catalog→getCanvas lifecycle
> (~40 `doc`-guards), and a doc-optional mode for ONE consumer would have
> forced ~6 new definition seams (rail slots, bar slot, banner/tail slots,
> announce plumbing) through every future chassis change. The landed shape
> keeps the ADR's core promise — ONE chrome owner under `canvas/`, BuilderShell
> reduced to content — via the dedicated **`CanvasSurfaceShell`** composition
> (chrome: rails/registry/⌘K/overlay/live-region/zoom-slot; consumer: content
> + verbs + pre-translated labels). This is NOT the rejected "chassis-as-
> library" alternative (à la carte primitives): the composition itself has one
> owner. Residual accepted debt: `CanvasEditorPage`'s inline chrome and
> `CanvasSurfaceShell` are two compositions of the same primitives — folding
> the former onto the latter is recorded as possible Phase-3 scope alongside
> the collab binding. **Resolved by ADR 0365 (2026-07-13):** the duplicated
> chrome BEHAVIOR moved to shared blocks (`useSurfaceChrome` + `RailAside`)
> consumed by both; the two compositions remain an accepted, documented
> split (doc vs engine lifecycle). Parity pins verified live: rail persistence key + ⌘K
> source stay `workflow-builder`; `[`/`]`, `?`, ⇧1/⇧2/⇧0, ⌘Z/⌘D via the
> registry; RunDrawer; xyflow canvas behavior unchanged.

## Wire/RFC

None. Frontend restructuring + one FE seam; workflow engine endpoints,
registration, and run wiring are untouched. Compatibility: none (no wire).
