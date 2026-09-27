# ADR 0337 — App-builder MyndHyve parity: graph-first editing

**Status:** implemented (2026-07-10) — Phase 1 (graph-first default + Screens rail, #1625), Phase 2 zoom bar (#1626), Phase 3 (Aurora demo app, #1630), Phase 2b device-frame selector + ruler (#1635), Phase 2c shared-viewport adoption / DRAW-1 closed (this change)
**Date:** 2026-07-10
**Depends on / composes:** ADR 0310 (Canvas Editor Framework — the `CanvasTypeDefinition` + shared chassis), ADR 0323 (the `graph` trait + `GraphSurface` screen-flow canvas), ADR 0333 (`ViewportSurface`/`useCanvasViewport` — the shared pan/zoom + zoom chrome), ADR 0305 (app-builder). **Research:** `docs/research/myndhyve-app-builder-migration.md` (PR #1521).
**Toggle:** none new — this changes the app-builder's default editing surface. **Surface:** frontend-only (no wire).

---

## Context

Side-by-side, the openwop app-builder reads as a **flat tree editor** (component palette
+ outline + property panel, one screen at a time) while MyndHyve reads as a **spatial
screen-flow board** — device-framed screen mockups on a pannable/zoomable canvas connected
by labeled navigation edges, with a Screens rail, a device selector, a ruler, and a zoom bar.

The gap is **narrower than it looks**: the screen-flow board already exists — `GraphSurface`
(ADR 0323) renders each screen as a 190×360 device-frame node (`AppScreenPreview`) with
connectors, pan/zoom, fit-to-view, connect-handles, and full keyboard operability. The
disappointment is a **defaulting + chrome** problem, not a missing-capability one:

1. **Wrong default.** `CanvasEditorPage` opens with `graphView = false` — the very first
   view is the tree editor; the board is one un-obvious toolbar click away.
2. **No Screens rail in board mode.** In graph mode the left panel is still the component
   palette (you're looking at *screens* but the rail lists *components*).
3. **Thin board chrome.** The graph toolbar has only "Fit" — no zoom in/out, no percent
   readout, no zoom-to-selection, no device selector, no ruler. (`ViewportSurface` already
   has the zoom chrome; the graph hand-rolls its own viewport — the recorded DRAW-1 gap.)
4. **Empty apps look empty.** A new app has one empty screen, so every surface renders a
   blank frame; MyndHyve's screens look alive because they were generated/seeded.

## Decision

Make the app-builder **graph-first**: open into the screen-flow board, dress it with the
MyndHyve chrome, and seed a populated demo app so it looks alive on open — all by
**extending the existing `graph` trait + `GraphSurface`**, never a second editor.

### Placement (core vs app-builder, the ADR 0310 rule)
- **CORE (chassis / GraphSurface / trait):** the `defaultView` seam, the Screens rail
  (any graph-trait type gets it), the zoom chrome + device-frame presets + ruler on
  `GraphSurface`, and the eventual `ViewportSurface` adoption (closes DRAW-1). Every future
  graph-trait canvas (workflow overview, campaign funnels) inherits them.
- **APP-BUILDER:** opts into `defaultView: 'graph'`, supplies the device-preset list its
  screens support, and ships the demo-app seed content. Screen semantics stay app-builder's.

### Phases
| Phase | Scope | Status |
|---|---|---|
| 1 | **Graph-first default** (`GraphTraitDef.defaultView`) + the **Screens rail** in graph mode (per-row select/rename/duplicate/star/delete over `graph.nodes`) | this change |
| 2 | Board chrome: zoom bar (#1626) + **device-frame selector + ruler** (this change) | done |
| 2c | **Shared-viewport adoption** — `GraphSurface` migrates its hand-rolled pan/zoom state machine onto `useCanvasViewport` (the ADR 0333 hook, keeping the graph's bespoke chrome + node/connect gestures), closing the recorded **DRAW-1** gap. Two additive hook APIs bridge the graph's pins: `backgroundPan` (plain-left-drag pans — the graph has no marquee) and `fitBounds` (canvas-space fit at the ≤1:1 clamp). Nets the free WCAG arrow-key pan; interaction clamp stays [0.25, 2.5]. | done (#TBD) |
| 3 | A populated **demo app-builder** seed (Aurora — 5 screens, real components, connectors) so the board looks alive on open in demo tenants | this change (#TBD) |

### Non-goals (recorded)
- A freeform pixel canvas inside a screen — screens stay the closed-catalog component tree
  (ADR 0305 blocks-not-freeform); the board is screen-level spatial, not element-level.
- Real-time co-editing on the board — ADR 0335's own program.
- Replacing the tree editor — it stays the per-screen component editor (double-click a
  board node → the tree editor for that screen); graph-first changes the DEFAULT, not the set.

## Wire/RFC
None. Frontend-only; the `x/y`/connector data already rides the app-builder artifact
schema (ADR 0323). Compatibility: additive.
