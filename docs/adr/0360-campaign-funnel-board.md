# ADR 0360 — Campaign funnel board: stored stage positions on the graph trait (CV-9)

Status: implemented (2026-07-12) — P1+P2 in PR #1761, grade-pass correction #1765, live click-through #1779.

## Context

DESIGN.md §7.12 CV-9 (re-ruled at the Phase-5 architect gate): campaign is the
last canvas type without a spatial surface — its funnel renders as a structured
list, honest but flat. A real board needs HOST-OWNED schema additions, exactly
the shape ADR 0323 used for app-builder screens (x/y as host-additive artifact
fields, no wire change). The §7 program already built everything the board
consumes: `GraphSurface` (zoom cluster, minimap, keyboard connect/nudge,
link-drag hooks), the `graph` trait, and the rails/present chrome.

## Decision

1. **Stored positions, derived chain.** Funnel stages gain OPTIONAL `x`/`y`
   (finite numbers, clamped 0–4000) — validator + artifact JSON schema,
   additive; docs without positions auto-grid (the `GraphSurface` fallback).
   The chain **edges derive from array order** — no connector storage: a
   funnel is a SEQUENCE (the ADR 0328 §"sections are derived, not schema"
   posture). `connect` returns false (free edges are not the model);
   `deleteEdge` is a no-op (derived edges have no identity); reordering stays
   the element list / arrange panel. `addConnectedNode` is not supplied —
   stages come from the closed `STAGES` enum via the existing adders.
   > **Correction (grade-pass round 2, PR #1765):** `campaignGraph` OMITS `connect`
   > and `deleteEdge` ENTIRELY rather than supplying always-failing implementations.
   > A trait that supplies a connect handler renders connect affordances, so an
   > always-failing gesture was dishonest chrome — a derived-edge graph now renders
   > no connect UI at all. The intent (free edges are not the model) is unchanged.
2. **`graph` trait on the campaign definition** (`campaignGraph.ts`):
   `defaultView: 'graph'` (the board becomes the primary surface — the CV-9
   intent), `nodes` = funnel stages (stage-localized title, description
   snippet, KPI count badge), `gridSnap: 20`, `nodeSize` a landscape stage
   card, no device frames (stages aren't screens). Selecting a node maps to
   the funnel element selection so the EXISTING property panel edits it (one
   selection model — no parallel panel).
3. **Wire/RFC: none.** Artifact-type facet fields are host-owned additive
   (ADR 0317/0323 precedent); `host.canvas` docs are validator-governed JSON —
   no `APP_MIGRATIONS` entry. Compatibility: additive (old docs validate
   unchanged; new fields are optional).

## Alternatives considered

- **Stored connectors (free graph)** — rejected: a funnel with skip/branch
  edges is a different product (journey builder); the sequence model matches
  the schema, the AI chain, and the list editor.
- **Projected (unstored) positions** — rejected: a board you can't arrange is
  fake chrome (the Phase-5 re-ruling's core objection).
- **connect = reorder** — considered; rejected for v1 (a drag that silently
  re-sorts the list is surprising; the list is the explicit reorder surface).
  Recorded as a possible follow-up if usage asks for it.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Backend: validator + artifact schema gain optional `x`/`y` on funnel stages (clamped, additive; fixture-tolerance test) | PR #1761 |
| 2 | FE: `campaignGraph.ts` graph trait + `defaultView:'graph'`; node⇄element selection bridge; i18n ×4; tests | PR #1761 |
