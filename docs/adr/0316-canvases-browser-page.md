# ADR 0316 — Canvases browser: the find-and-reopen surface for canvas documents

Status: Superseded by [0319](0319-canvases-into-documents-single-type-toggle.md) (2026-07-07)

> **Superseded 2026-07-07 (ADR 0319):** the standalone Canvases browser is
> removed and its inventory folded into the Documents page (a canvas is a
> document row); the toggle-off delete relocated into the Documents feature. The
> shared `host/canvasSurface.ts` this ADR introduced is kept — it was always the
> real owner. "Canvases" is gone from the user-facing UI.

## Context

After ADR 0310 (six canvas editors) and ADR 0314 (the Documents creation
gallery), users can CREATE canvases and OPEN them from chat artifact cards —
but there is no surface listing the canvases they already have. Close an
editor tab and the canvas is deep-link-only again. The ADR 0314 review also
recorded two adjacent finding-things gaps: the From-canvas picker truncates at
200 rows with no search, and a document's project chip says "Project" without
naming which one.

## Decision

1. **A `canvases` feature owns the browser** — backend
   `GET /v1/host/openwop-app/canvases/orgs/:orgId?q=` (own per-tenant toggle
   `canvases`, OFF; `authorizeOrgScope` read; serves `listCanvasesForTenant`
   light rows, case-insensitive `q` over name/type, newest-200 cap + `total`)
   and a frontend `/canvases` workspace page (nav group **Author**, beside
   Documents): server-backed search, grid/list `ViewToggle`, rows showing
   name, type chip (the ADR 0314 `canvas`-ns `type_*` vocabulary; pack types
   fall back to the raw slug), version, and last-edited.
2. **Open rides the TYPE's own surface; delete is browser-owned** — open
   navigates to `<editorPath>/<canvasId>` (pack types `/canvas/<typeId>/<canvasId>`)
   from the drift-test-pinned `canvas/creatableTypes.ts` registry, and renders
   only for types whose editor toggle is enabled (a disabled type's rows stay
   visible — honest inventory — but not openable).

   > **Correction (grade pass DATA-CV-3, 2026-07-07):** this ADR originally
   > routed DELETE through the type's own editor route "so the browser adds no
   > second delete path." That stranded canvases whose editor toggle is OFF or
   > whose pack was uninstalled — the per-type route 404s, so the row could
   > never be deleted. The browser now owns a DELETE
   > (`DELETE /v1/host/openwop-app/canvases/orgs/:orgId/:canvasId`, gated by the
   > `canvases` toggle + `workspace:write`) that REUSES the single cascade owner
   > `deleteCanvasForTenant` + the one canvas share-resource purge
   > (`app_builder_canvas`) — NOT a second cascade implementation, so the
   > drift the original decision feared doesn't materialize. Delete therefore
   > works for ANY tenant canvas the caller can write, independent of the
   > per-type toggle; open still requires it.
3. **A "New canvas" dialog on the page** (type cards → name + optional
   project), reusing `creatableTypes` + `canvasClient.createCanvas` — the
   ADR 0314 creation semantics, scoped to canvases. Deliberate residue: this
   duplicates the NewDocumentModal's canvasNew step (~60 lines); unifying them
   into one shared dialog is a recorded follow-up, not done here to avoid
   churning the just-merged, tested modal.
4. **Picker search** — `?q=` on the documents `canvas-sources` route (same
   filter-before-slice) + a debounced search input in the From-canvas picker.
5. **Project names on document chips** — the Documents page resolves project
   ids to names (lazy `listProjects` when any listed document is
   project-owned) and the chip shows the project's name, falling back to the
   generic label when the project list is unavailable.

## Alternatives weighed

- **Fold the browser into the Documents page** — rejected: canvases are not
  documents (different store, different lifecycle); burying the inventory
  under Documents repeats the "afterthought" mistake ADR 0314 fixed.
- **Reuse the documents `canvas-sources` route for the browser** — rejected:
  it is documents-toggle-gated and semantically "materialization sources";
  the browser must work without the documents feature.
- **A browser-owned DELETE route** — rejected: the per-type factory routes
  own the cascade + share purge; a second delete path would drift (the
  ADR 0310 one-owner rule).

## Wire / RFC

Host-extension only (`/v1/host/openwop-app/*`) — no RFC. One new toggle
(`canvases`, OFF, tenant), acknowledged in seed coverage (user-authored
content; nothing to seed).

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Backend feature + route + toggle + seed ack; documents `?q=` | PR TBD |
| 2 | FE page + New-canvas dialog + nav + i18n ×4; picker search; project-name chips; tests | PR TBD |
