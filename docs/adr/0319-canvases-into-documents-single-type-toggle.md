# ADR 0319 — Canvases are documents: fold the Canvases browser into Documents + one toggle per canvas type

Status: Accepted (2026-07-07)

## Context

The canvas-framework program (ADR 0310) shipped five editable canvas types
(slides, drawing, CAD, campaign, app-builder) plus, for discoverability, a
separate **Canvases** browser page (ADR 0316) reached from a top-level "Canvases"
nav entry. In parallel, ADR 0314 made the **Documents** page's "New document"
modal the creation hub for those same types.

Two problems surfaced in use:

1. **"Canvases" is jargon.** Users don't know what a "Canvas" is. To them a slide
   deck, a CAD model, and a drawing are all just *documents* — things they made.
   A second top-level page called "Canvases" (parallel to "Documents") fragments
   "the stuff I made" across two surfaces and forces the user to learn an
   internal term.

2. **Two toggles per canvas type.** Each type shipped a *generation* toggle
   (`slides`, `drawings`, `cad`, `campaign-studio`) AND a separate *editor*
   toggle (`slides-editor`, …). The editor toggle is the one every runtime gate
   actually consumes (editor routes + the creation gallery + the browser); the
   generation toggle gates nothing at runtime (only an admin-list + seed-coverage
   projection). Enabling the obvious "Slides" toggle therefore did nothing
   user-visible, and the split was a documented UX trap (grade-ux `DOCNEW-1`).

This ADR collapses both: **a canvas is a document**, and **a canvas type is one
feature**.

## Decision

### 1. One toggle per canvas type (drop the `-editor` split)

For each of slides / drawings / cad / campaign-studio, keep the **bare** id
(`slides`, `drawings`, `cad`, `campaign-studio`) as the single feature toggle and
**remove** the `-editor` variant. The surviving toggle now gates the whole type:
generation + full-screen editor + creation + listing. Its label drops "…Editor"
and its description covers both authoring and editing. `app-builder` already had a
single toggle and is unchanged.

- The surviving toggle stays the feature's top-level `toggleDefault` (so
  seed-coverage still sees it; its `ACKNOWLEDGED_UNSEEDED` entry stays valid).
- Every consumer repoints from `<type>-editor` → `<type>`: the editor-route
  factory config (`routes.ts` `feature.toggleId`), each `definition.tsx`
  `toggleId`, `canvas/creatableTypes.ts`, and the frontend `useFeatureAccess`
  gates.
- The four `-editor` ids are added to `RETIRED_TOGGLE_IDS` so any tenant's stored
  per-tenant `-editor` override is purged at boot rather than lingering as an
  orphan (the ADR 0027 retirement convention).

**Migration note (honest):** a tenant that had *only* the old `-editor` override
on (editor on, generation off) will find the type OFF after the merge until they
enable the single `<type>` toggle. These features are pre-deployment (all OFF by
default), so real-tenant impact is minimal; the single surviving toggle is the
clean per-type control going forward.

### 2. Fold the Canvases browser into Documents

Remove the `canvases` feature package (frontend + backend), its nav entry, its
toggle, its client, and its tests. The **Documents** page becomes the one place
"the stuff I made" lives: it lists markdown documents AND the tenant's canvases,
rendered uniformly — a canvas row shows its type (e.g. "Slide deck") and opens its
editor; a document row opens the inline markdown editor as before.

- No new list endpoint: the Documents backend already exposes
  `GET …/documents/orgs/:orgId/canvas-sources` (the ADR 0314 picker source, over
  the shared `listCanvasesForTenant`). The unified page reuses it.
- The one capability unique to the browser — deleting a canvas whose type/editor
  is disabled or whose pack is uninstalled (with the app-builder share-link
  purge) — **relocates** into the Documents feature as
  `DELETE …/documents/orgs/:orgId/canvases/:canvasId`, reusing the single
  `deleteCanvasForTenant` cascade owner (no second mutation path).
- The shared `host/canvasSurface.ts` (list/get/delete/projection) is **kept** —
  it was always the real owner; the browser was a thin shell over it.

**Scope reconciliation:** documents are org-scoped; canvases are tenant-scoped
(as they always were — the browser's `:orgId` was authz context, not a data
filter). The unified list shows the selected org's documents plus the tenant's
canvases. For single-org tenants (the norm) this is seamless; the wrinkle is
documented rather than papered over.

### 3. Purge the word "Canvases" from the user surface

The "Canvases" nav entry disappears with the feature (Move 2). The admin
feature-console **category** for the canvas-type toggles renames `Canvases` →
`Documents` so the internal term is gone there too. Type *names* the user sees
stay concrete ("Slide deck", "CAD model", "Drawing", "Campaign plan", "App
design") — never "canvas".

## Alternatives weighed

- **Keep the `-editor` id, drop generation.** Rejected: the surviving toggle
  would keep the ugly `…-editor` id and "Slides Editor" label; the whole point is
  one clean per-type feature. Repointing consumers to the bare id is mechanical.
- **Migrate `-editor` overrides into the bare id** (preserve editor-on tenants).
  Rejected for now: pre-deployment status makes the migration cost negligible and
  `retireToggleOverrides` only deletes; a value-preserving migration adds risk for
  no real-tenant benefit. Documented instead.
- **Convert canvases into real document records** (one entity). Rejected: lossy
  and heavy — a canvas's typed state isn't markdown. A unified *view* over two
  entity kinds is honest and reversible.
- **Keep the Canvases page, just rename it.** Rejected: it still fragments "the
  stuff I made" into two surfaces and keeps a second list to learn.

## Implementation plan

| Phase | Scope | Status |
|---|---|---|
| 1 | Toggle merge — 4× `feature.ts` (drop `-editor` registration, fold description), 4× `routes.ts` (`feature.toggleId`→bare), 4× `definition.tsx`, `creatableTypes.ts`, `RETIRED_TOGGLE_IDS`, category rename | done |
| 2 | Remove `canvases` feature (FE package + BE feature + registries + nav labels + tests) | done |
| 3 | Documents unified list — fetch canvases via `canvas-sources`, render canvas rows (type chip + open-in-editor), relocate the toggle-off DELETE | done |
| 4 | Repoint `NewDocumentModal` toggle gates to bare ids | done |
| 5 | Tests (documents unified-list + canvas delete; update NewDocumentModal + creatableTypes drift; delete canvases tests), FEATURES.md, DESIGN.md, mark ADR 0316 superseded | done |

## Consequences

- One nav surface for authored work; one toggle per canvas type. The two-toggle
  trap and the "Canvases" jargon are gone.
- `host/canvasSurface.ts` is confirmed as the single canvas owner; the Documents
  feature is now its second consumer (list + delete) alongside the per-type
  editors.
- ADR 0316 (Canvases browser) is **superseded by this ADR**.
- Reversible: the unified list is a view; re-introducing a standalone browser
  would be additive. No data migration performed.
