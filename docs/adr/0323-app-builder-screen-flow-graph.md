# ADR 0323 — App-Builder screen-flow graph: a core `graph` trait + additive schema

Status: Accepted (2026-07-09)

## Context

The MyndHyve app-builder's flagship interaction is a **screen-flow graph**:
screens are freely-positioned, device-framed nodes on an infinite canvas;
connectors (edges) between them are editable; you drag a screen to move it and
double-click to edit its components. openwop-app's app-builder (ADR 0305/0310)
has no graph surface — screens are a linear ARIA tablist with no position, and
`connectors[]` exist in the `canvas.app-builder` doc but render only as a
read-only text list. The gap analysis
(`docs/research/myndhyve-app-builder-migration.md`) identifies this as the single
biggest missing capability, and shows MyndHyve already solved it with a clean
**core-vs-type split**: a domain-neutral node/edge/pan-zoom engine in
`core/canvas-shell` (shared with a workflow canvas), switched on for app-builder
by one config flag, with screen semantics layered on top.

This ADR records the decision to reproduce that split on openwop's ADR 0310
canvas chassis, and lands the **additive schema** the rest of the work needs.

## Decision

### 1. A core `graph` trait on the canvas chassis (Phase 1)

Add a fourth, orthogonal **`graph` trait** to `CanvasEditorPage`
(`frontend/react/src/canvas/`), alongside the existing `frames` / `tree` /
`elements` traits. It is **domain-neutral**: a surface of movable, resizable
nodes with ports and SVG connectors, pan/zoom, marquee/keyboard selection, and
four edge-routing styles (bezier / orthogonal / straight / step). It routes every
gesture through the chassis `useHistoryState` (one undo step per drag) — the
openwop idiom, not a second history stack. It is placed in **core** because it is
reusable across canvas types (the workflow builder wants the same movable-node +
edge surface) — the same call MyndHyve made (`core/canvas-shell`).

**Accessibility is a gate:** openwop's own workflow canvas is capped today for
lacking a keyboard path to create an edge (`builder/canvas/BuilderCanvas.tsx`).
The `graph` trait MUST ship keyboard node-move AND keyboard connect, or it caps
its consumers at a failing UX grade.

### 2. App-builder screen semantics on top (Phase 2)

The app-builder feature supplies the trait config: a node **is a screen**, its
body a live scaled render of the screen's component tree inside a device frame;
double-click enters the existing component editor (the `tree`-trait editing
openwop already has); drag-to-connect writes a `connector`; node-move writes the
screen's position. All mutation flows through the existing backend-authoritative
`PATCH …/canvases/:id` CAS write — no client-side position store (MyndHyve's
fragile two-model split is deliberately not reproduced).

### 3. Additive schema (this phase — Phase 0)

The `canvas.app-builder` **host-owned artifact type** gains optional fields:

- **Screen:** `x`, `y` (node position). Absent ⇒ the editor auto-lays-out.
- **Connector:** `sourceEdge` / `targetEdge` (`top|right|bottom|left`),
  `transition` (`push|replace|modal|fade|slide|none`), `routingStyle`
  (`bezier|orthogonal|straight|step`), `animated` (boolean). Existing
  `from`/`to`/`trigger`/`label` unchanged.

All optional, `additionalProperties:false` preserved. Positions and connector
semantics live in the **one artifact doc** — the single source of truth — so they
flow through snapshot / version / restore / `:fork` verbatim (replay-safe) and
are tenant-isolated by construction. A side-channel position store would break
exactly this.

**Enforcement seam (architect finding).** The editor PATCH path runs only the
feature validator (`validateAppDoc`), NOT the artifact JSON Schema
(`canvasEditorRoutes.ts` applies `cfg.validate` only). So the new closed-world
enums + a **finite, bounded** position are enforced HARD in `validateAppDoc` —
mirroring how it already hard-enforces id slugs even though the schema has a
pattern. The JSON Schema still documents the shape and validates the producer
(emit) path.

### Wire/RFC

`canvas.app-builder` is `registrationSource:'host'` — a non-normative host-ext
artifact type. Optional additive fields are not a wire change and need **no RFC**
(the ADR 0317 rotation-field precedent). Compatibility: **Additive**.

## Alternatives weighed

- **A side-channel position store** (a separate collection keyed by canvas id).
  Rejected: not replay/fork-safe, needs its own tenant-scoping, reproduces
  MyndHyve's two-model split and `projectId`-stamp data-loss bug. The doc is the
  correct home.
- **Reuse a graph library (React Flow / Fabric).** Rejected: MyndHyve's flagship
  is bespoke DOM+SVG (its React-Flow `SitemapGraph` is a throwaway approval
  widget; its Fabric controller is superseded). openwop avoids heavy canvas libs;
  the routing math is ~150 lines of pure geometry.
- **An app-builder-only graph surface** (skip the core trait). Rejected: the
  workflow builder needs the same engine; putting it in app-builder would seed a
  second node-graph. Core is the single-source-of-truth home.

## Implementation plan (mirrors the migration doc §6)

| Phase | Scope | Status |
|---|---|---|
| 0 | This ADR + additive `canvas.app-builder` schema (screen x/y, connector semantics) + hard `validateAppDoc` enforcement + tests | **this change** |
| 1 | Core `graph` trait: `canvas/graph/` (GraphSurface, GraphNode, EdgeLayer, pure `edgeRouting` + tests), `GraphTraitDef`, chassis integration (selection + history + keyboard move & connect) | pending |
| 2 | App-builder screens-as-nodes: device-framed node bodies, double-click→editor, drag-to-connect, node-move persistence | pending |
| 3 | Property editors — a declarative **`dataSource`** binding picker (DataBinding); Action + Responsive kept deliberately closed | done |
| 4 | AI generation depth — code-first slice: the App Architect emits graph layout (positions + connectors) + realistic content. The research/quality/content-node program is a sequenced follow-up (pack authoring) | done (slice) |
| 5 | Polish — Fit-to-view/auto-fit/empty state; then (2026-07-09, the audit-polish PRs) preview swipe + tab thumbnails, palette favorites/recents, and large-graph virtualization (LIVE_CAP + viewport cull, fail-open). Remaining recorded follow-ups: insights dashboard (rides the node program); IDE bridge deferred (ADR 0307) | done |

## Phase 3 note (2026-07-09) — property editors, scoped to the closed world

The migration doc §3.6 named three MyndHyve editors (Action / Responsive /
DataBinding). Two are **already declarative in openwop** and stay that way: an
action is `navigateTo` (a `screen`-ref widget); responsiveness is `hideOn`
(enum) + `columnsMobile`. MyndHyve's *free-form* CSS/action/breakpoint editors
are a **deliberate exclusion** (`componentCatalog.ts:11`) — porting them would
break the closed-world `validateAppDoc` gate and export determinism across the
six code generators (a data-integrity/interop regression). Phase 3 therefore
enriches the ONE genuinely-raw field: `list.bind` becomes a **`dataSource`**
property type — a declarative `<select>` over the doc's `dataSources`
(`DataSourceRefWidget`, symmetric to `ScreenRefWidget`) — while the **value stays
a string id**, so the generators and validator are untouched. The chassis gained
a read-only `docState` on `PropertyWidgetProps` (symmetric to the existing
`frames`) so a widget can pick from app-specific doc structure. Widening the
component catalog or the action model further remains a recorded, deliberate
non-ship.

## Phase 4 note (2026-07-09) — generation emits graph layout (code-first slice)

The App Architect `plan` node (a REAL BYOK `core.ai.chatCompletion`,
`designWorkflow.ts`) now emits the **screen-flow layout**: each screen gets
integer `x`/`y` (laid out in user-flow order, under ~4000, non-overlapping) and
connectors carry `trigger` + `transition` + `label`, plus an explicit
"realistic content, never Lorem ipsum" instruction. So a freshly-generated app
opens **already positioned and linked** in the Phase-2 graph view. AI output is
untrusted and validated fail-closed at two gates that now **agree**: the
emit-time `canvas.app-builder` JSON Schema (x/y bounded to ±100000, connector
enums) and the edit-time `validateAppDoc`. This is the code-first slice — no pack
change, honest (real BYOK, ADR 0190).

**Sequenced follow-up (a program, deferred at the pack-authoring gate):**
MyndHyve's persona/brand/moodboard **research** nodes, the **content-generation**
node, the **quality-audit** node, capability-intersection routing, and
server-side per-screen fan-out. These require authoring new nodes in
`packs/feature.app-builder.nodes` (re-version + **Ed25519 sign** +
`INSTALL_PACKS` repin — a supply-chain/deploy gate) plus BYOK prompt
engineering, so they are their own phase, not folded into this slice.

## Consequences

- The one artifact doc now carries graph layout; no new persistence surface, no
  wire change, no migration (additive optional fields; old docs validate).
- Phase 1 introduces a genuinely reusable chassis capability (the workflow
  builder is a future second consumer).
- Reversible: unused optional fields are inert; the trait ships behind the
  existing `app-builder` toggle.
