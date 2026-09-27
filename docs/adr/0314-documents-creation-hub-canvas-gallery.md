# ADR 0314 — Documents creation hub: first-class canvas creation, a canvas picker, and project attachment

Status: implemented (2026-07-07) — P1+P2 in PR #1485 (the canvases browser follow-on rode ADR 0316 / PR #1487).

## Context

ADR 0310 shipped six first-party canvas editors (app-builder, slides, drawings,
CAD, campaign-studio) plus generic editors for pack-declared types — but the only
ways to GET a canvas are a chat artifact's "Open in editor" card or a raw deep
link. Meanwhile the Documents "New document" modal offers Blank/Template cards
and a tacked-on "From canvas" footer link that demands a raw `canvas:…` id in a
text input (the user must know the id scheme and spell it). And although the
documents backend has carried `ownerSubject` (project ownership, ADR 0046/0053)
end-to-end since ADR 0153 §R6, no UI lets a user attach a document to a project.

Three user-visible gaps, one surface: **creation**. David's direction: canvas
types must be first-class creatable items in "+ New Document", the From-canvas
flow must be a picker, and documents must attach to projects.

## Decision

1. **Blank-canvas creation becomes a factory capability.** The canvas-editor
   route factory (`features/canvasEditorRoutes.ts`) gains an optional
   `blankState?: (name: string) => state` config and, when present, registers
   `POST <base>/orgs/:orgId/canvases` `{ name?, projectId?, ownerSubject? }` →
   201 canvas. The blank state runs through the type's `validate` exactly like
   a save — a type whose blank cannot satisfy its own schema fails closed with
   422 (relevant for pack types, whose blank is derived from editor hints +
   first-adder defaults). The five first-party types supply hand-written valid
   blanks (one title slide / one rect / one box / one email channel / one Home
   screen). The caller-asserted `user` ownerSubject keeps the F13 spoof guard.

2. **The New-document modal becomes a three-group creation gallery** —
   Write (text document) / Design (one card per *toggle-enabled* canvas type,
   including pack types) / Start from existing (template, canvas picker).
   Grouping is the information: canvases become peers of text documents, not an
   appendix. Cards render only for enabled toggles (live `useFeatureAccess`) —
   no dead tiles, honest per tenant. Creating a canvas lands the user in its
   editor (`<editorPath>/<canvasId>`; pack types `/canvas/<typeId>/<canvasId>`).

3. **First-party type metadata lives in a shared data registry**
   (`frontend/react/src/canvas/creatableTypes.ts`: canvasTypeId, toggleId,
   basePath, editorPath, i18n name keys in the `canvas` ns). The documents
   feature may not import five sibling feature definitions (cross-feature
   coupling + it would pull renderers into the documents chunk); `canvas/` may
   not import `features/*` (ADR 0310 rule). A pure-data registry in the shared
   layer satisfies both; a drift test pins it against the real definitions.
   Pack types are enumerated live via a new
   `GET /v1/host/openwop-app/canvas-packs/orgs/:orgId/types` (gated by the
   `canvas-packs` toggle; `orgs` cannot collide with per-type base paths, whose
   next segment always matches `canvas\.<slug>`).

4. **From-canvas becomes a picker.** New `listCanvasesForTenant` on
   `host/canvasSurface.ts` (bounded `listForTenantIndexed` scan — the tenant
   index shipped in the ADR 0310 grade pass) projected to light rows, served to
   the documents feature via `GET <documents>/orgs/:orgId/canvas-sources`
   (documents-toggle-gated — it is the documents feature's read, usable while
   individual editor toggles are off, matching `materializeCanvasToDocument`
   which already works for ANY canvas type). Click a row → materialize.

5. **Project attachment rides the EXISTING ownerSubject plumbing** — no new
   model. Create-time: the modal's blank-document and new-canvas steps gain an
   optional project select (documents: `createDocument` client passes
   `ownerSubject {kind:'project'}` — the POST route already accepts it and
   `resolveOwnerSubject` already validates tenant/org; canvases: `projectId`
   passthrough that `materializeCanvasToDocument` already carries into the
   document). Row-level: an "Add to project" action on document rows PATCHes
   `ownerSubject` (route + service already support it).

## Alternatives weighed

- **Per-type "New" buttons on each editor's (nonexistent) landing page** — six
  scattered entry points, and the Documents page remains the place users go to
  create things; rejected.
- **A flat card grid without groups** — visually simpler but encodes nothing;
  the tacked-on-afterthought complaint is precisely a hierarchy problem.
- **FE-only blank creation (client POSTs a synthesized doc via from-artifact or
  first-save)** — from-artifact requires a run artifact; a client-invented
  state bypasses server validation until first save. A validated server-side
  create is smaller and honest.
- **Importing feature definitions into the modal for metadata** — rejected
  (chunk bloat + cross-feature imports); the data registry + drift test wins.

## Wire / RFC

Host-extension routes under `/v1/host/openwop-app/*` only — non-normative, no
RFC needed (the standing rule). No new toggles: each card is gated by the
already-existing per-type editor toggle; the picker + project attach ride the
`documents` toggle.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Backend: factory `blankState` + POST canvases; five first-party blanks; pack blanks from hints; `listCanvasesForTenant`; documents `canvas-sources`; canvas-packs `types` | PR #1485 |
| 2 | FE: creation gallery, canvas picker, project selects, row-level Add to project; `creatableTypes` registry + drift test; i18n ×4 | PR #1485 |
