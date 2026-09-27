# ADR 0362 — Contextual bar formatting via quick-marked prop defs (§7.12 CV-13)

Status: implemented (2026-07-12) — P1+P2 in PR #1764, P3 (v2) #1767, P4 (tree-catalog quick props) #1771.

## Context

§7.1 canon 4 mandates a top bar that morphs per selection. CV-13 v1 (Phase 4)
shipped the identity chip; the residue is the FORMATTING half — the
Slides/Canva pattern where the bar carries the selected element class's
most-used controls. The §7.12 row requires a definition seam.

## Decision

**Derive, don't duplicate.** No new control vocabulary: `CanvasPropDef` gains
an additive `quick?: boolean` marker. When exactly ONE element (elements
trait) or tree node is selected, the bar's contextual cluster renders that
selection's quick-marked prop defs as compact controls, writing through the
SAME setter the property panel uses — bar and panel cannot drift because they
share the definition and the write path.

- **v1 control ergonomics:** `boolean` → an `aria-pressed` toggle button;
  `enum` → a compact `ui/Menu` showing the current value. `number`, `color`,
  `string`, and widget-registry types stay panel-territory (a bar stepper or
  swatch is v2 — recorded, not faked).
- **Budget:** the cluster renders at most 3 quick controls (bar space is the
  §7.2.1 contract; a type marking more is a dev-warning, first 3 win) and
  participates in the ≤920px `⋮` collapse (quick controls hide narrow — the
  panel remains the complete surface, canon 4/5).
- **Selection sources (v1):** a single ELEMENT selection (elements-trait
  `propDefs(el)`), else the ACTIVE FRAME (frames-trait `propDefs(frame)`) —
  both FE-owned def lists, so the inline marker suffices. TREE-node quick
  props are v2 (their defs come from the SERVED host catalog, which must not
  grow FE markers — a definition-level map would be needed; recorded).
- **First consumers:** slides (`variant` enum + `build` boolean —
  FRAME props) and the campaign funnel stage (`stage` enum, ELEMENT prop —
  pairs with the ADR 0360 board). Drawings/CAD wait for v2 color/number
  controls.
- Labels ride the existing type-ns `prop_*`/`opt_*` machinery (ADR 0340) —
  no new i18n surface beyond what the props already have.

## Alternatives considered

- **A `selectionToolbar(sel) → ControlDef[]` seam** — rejected: a second
  control vocabulary parallel to `CanvasPropDef` is drift by design (the
  grade-code "two systems for one concept" failure).
- **Auto-promote the first N props (no marker)** — rejected: which controls
  deserve bar space is a TYPE design decision, not an ordinal accident.

## Wire/RFC

None. FE-only; the marker is FE definition data. The backend catalog's
`ComponentPropDef` is untouched — mirroring `quick` onto the served catalog
would be a wire-relevant change and is explicitly NOT done; tree-node quick
props (whose defs come from that served catalog) are deferred to v2 for
exactly this reason.

> Correction during authoring: the slides quick props (`variant`/`build`)
> are FRAME props (`frames.propDefs`, FE-owned) — not tree-node props — so
> v1 needs NO served-catalog overlay at all; the inline marker covers both
> consumers. Tree-node quick props (served catalog) are the recorded v2.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Chassis: `quick` marker + the bar cluster (toggle/enum, 3-cap, narrow-collapse) writing via the existing `setElField`/`setFrameProp` setters | PR #1764 |
| 2 | Consumers: slides (`variant`, `build`) + campaign (`stage`); tests ×both paths | PR #1764 |
| 3 (v2, residue-final same day) | `number` (draft-on-blur, def-bounds-clamped) + `color` (native input) bar controls; drawings joins (`fill`/`stroke`/`strokeWidth` quick) | done |
| 4 (same day) | Tree-catalog quick props WITHOUT touching the wire: `TreeTraitDef.quickPropsByType` — the FE definition names which SERVED props are quick (the map IS the marking; served `ComponentPropDef` unchanged). Consumer: app-builder (button/heading/text/stack) | done |
