# ADR 0350 — Documents surface: per-document URLs, a markdown-native full-screen editor, and opt-in promotion to rich documents

**Status:** implemented (Phases 1–3) — 2026-07-11
**Date:** 2026-07-11

> **Renumbered 0348 → 0350 (2026-07-11):** authored as 0348 but collided with a
> parallel session's `0348-app-builder-production-output-contract` (merged to
> `origin/main` first, so canonical per `docs/adr/README.md`); `0349` was also
> taken (app-builder governed deployment). Renumbered to the verified next-free
> slot. Code comments cite ADR 0350 throughout.
**Depends on / builds-on:**
- **ADR 0336** — "Deep-linkable URLs for every list/grid item + honest notification
  targets." That ADR sequenced *net-new detail surfaces* as follow-ons; the markdown
  Documents detail surface is one of them. **Phase 1 of this ADR completes ADR 0336's
  documents follow-on.**
- **ADR 0053** — the markdown business-document store (`documents` feature). Canonical
  format = markdown; render pipeline = pdf / pptx (slides) / csv (sheet) + templates.
- **ADR 0334** — the `canvas.document` rich-text editor (ProseMirror JSON on
  `host.canvas`). The single-owner-per-store rule: `documents` (markdown) and
  `canvas.document` (rich) are **distinct stores**, each with one authority.
- **ADR 0319** — the unified Documents list (markdown documents + canvases as peer rows).

## Context

On the "Documents & Templates" page, markdown documents opened in an **inline editor
panel** below the list, addressed only by a one-shot `?doc=<id>&org=<id>` query param
(ADR 0308). Canvases already opened at real routes (`/document-editor/:id`, etc.). The
user asked: *"Documents and Markdowns need their own URLs so that clicking the title or
'Open' opens them in a full document canvas — and will the markdowns also open in a
document-canvas editor?"*

Two questions are entangled:

1. **Addressing** — should every markdown document have its own URL (like canvases do)?
   Unambiguously yes; it is exactly ADR 0336's mandate applied to this surface.
2. **Editor** — should a markdown document open in the *rich* `canvas.document` editor
   (ADR 0334)?

### Research verdict (deep web research on editor/store architecture, 2026-07-10)

Best-in-class editors pick **ONE canonical format** and never run lossy bidirectional
live conversion between two authoritative stores:

- **Pattern 1 — rich canonical, markdown import/export** (Notion, Google Docs, Coda,
  TipTap "store ProseMirror JSON"): the rich JSON is the source of truth; markdown is an
  import/export edge.
- **Pattern 2 — markdown canonical, live rich *view* over the source** (Obsidian's
  CodeMirror-6 live-preview, HackMD): markdown text is the source of truth; the rich
  rendering is a projection, not a second store.
- **Anti-pattern — two authoritative stores + lossy bidirectional live conversion.**
  `prosemirror-markdown` is explicitly lossy; TipTap's bidirectional markdown is
  CommonMark-only (cannot represent tables, math, charts, comments, or track-changes).
  Editing the same content in both a markdown store and a rich store guarantees
  dual-write drift.

So the answer to "will markdown open in the rich canvas editor?" is: **not by silently
routing the markdown store through the rich editor** (that is the anti-pattern). Instead:
keep markdown canonical for the `documents` store (Pattern 2 for its own editor), and offer
an **explicit, one-way promotion** into a `canvas.document` for users who want the rich
surface (Pattern 1's import edge).

### Architect review (Track A, options-evaluation, 2026-07-10)

- Option B (rich-over-markdown bidirectional) — **rejected** as the dual-write
  anti-pattern.
- `/documents/:documentId` — **no route collision** (only `/documents` existed).
- Per-document URL: the title should be a real `<Link>` (native middle-click / new-tab),
  not an `onClick` button.
- Phase 2 markdown editor should **not** take a new heavy CodeMirror dependency in v1;
  reuse the existing markdown renderer for a live preview pane.
- Phase 3 promotion must **not** make `documents` import `document-editor`'s schema — the
  md→PM conversion (`generateJSON(html, documentExtensions())`) is client-side and owned by
  `document-editor`; `documents` triggers it via a handoff seam (the composerSeed /
  returnTarget pattern), not a cross-feature import.

## Decision

A three-phase program on the `documents` surface. **Markdown stays the canonical format
of the `documents` store** (render pipeline + templates preserved). No wire, no RFC — all
host-side FE routing + an existing canvas-create API + a client-side conversion.

### Phase 1 — per-document URLs (implemented)

- New route `path: '/documents/:documentId'`, `chrome: 'fullbleed'`, lazy — a
  `DocumentDetailPage` that loads the doc (`?org=` query, else locates it across the
  caller's orgs) and hosts the existing textarea editor + version history + export
  full-screen. Org rides as a query param (workspace context, not doc identity).
- The inline editor panel is removed from `DocumentsPage`; the list is now purely a list.
- `DocumentCard` / `DocumentRow` (and the canvas cells) are real `<Link>`s — middle-click,
  ⌘-click, and "open in new tab" work natively. The "Open" action is a `<Link>` too.
- Backward-compat: a legacy `/documents?doc=&org=` link redirects (`replace`) to
  `/documents/:documentId?org=` so older notification / agent-deliverable links keep working.
- A missing/inaccessible doc lands on a not-found card + back-link (no existence leak — a
  404/403 both read as not-found).

### Phase 2 — markdown-native full-screen editor (implemented)

- The Phase-1 route gained a **Write / Split / Preview** toggle (persisted to
  `localStorage`, default Split). The preview pane **reuses the shared `ui/Markdown`
  renderer** (react-markdown + remark-gfm, XSS-safe, `chat-md`-themed) — a live projection
  of the textarea buffer, **never a second store** (Pattern 2). **No new CodeMirror
  dependency** (react-markdown already ships; the lazy route keeps it out of the entry
  bundle — entry stayed 185.9 kB gzip). Markdown remains canonical; the ADR 0053 render
  pipeline (pdf/pptx/csv) is untouched. The in-place CodeMirror-6 live-preview (inline
  rich rendering over the source, Obsidian-style) remains a later enhancement.
- a11y: the toggle is an aria-pressed button group; the preview is a keyboard-scrollable
  `role="region"`; an empty-preview state is designed. Split stacks at ≤760px.

### Phase 3 — opt-in "Promote to rich document" (implemented)

- A one-way action that converts a markdown document into a **new `canvas.document`**
  (ADR 0334): the backend renders the current version's **markdown → HTML** (`markdown-it`,
  already a dep — mirrors the DOCX/mammoth import; new route `POST
  documents/.../:documentId/promote-html`), and the client converts **HTML → ProseMirror
  JSON** via `htmlToDocumentJson(html)` = `generateJSON(html, documentExtensions())`, then
  creates + seeds a `canvas.document` (`createCanvas` → `saveCanvas`).
- **No cross-feature schema import:** `document-editor` (schema owner) exports
  `htmlToDocumentJson`; `documents` **lazy-imports** it (`await import('../document-editor/
  documentSchema.js')`), so the heavy TipTap engine never enters the documents chunk.
- **One-way + idempotent:** the link is stored as **`promotedCanvasId` on the `documents`
  record** (patched back after canvas creation). Re-promote (or a second promote-html) opens
  the existing canvas; a PATCH to a *different* id is rejected 409 (a doc promotes to exactly
  ONE canvas). The source markdown row is left **as-is but visibly linked** (an info Notice
  "Opened as a rich document →") — a historical artifact, **never a second live-editable
  copy**. Gated on the `document-editor` toggle.

> **Correction vs the proposal (2026-07-11):** the proposal above envisioned a separate
> `documentId → canvasId` map (inverse of `canvasMap`) and reusing the DOCX `/import` route.
> As built, the link lives directly on the `documents` record (`promotedCanvasId`) — simpler,
> single-owner, and it doubles as the "already promoted" indicator with no extra store — and
> markdown→HTML is a **new** small `promote-html` route (the DOCX `/import` is docx-specific),
> both reusing the backend `markdown-it` already present. The HTML→PM step is client-side
> (schema is client-only), exactly as proposed.

## Alternatives considered

- **Route the markdown store through the ADR 0334 rich editor (Option B).** Rejected: two
  authoritative stores + lossy live conversion = dual-write drift; loses tables/math/etc. on
  every round-trip.
- **Auto-migrate all markdown docs to `canvas.document`.** Rejected: destroys the markdown
  render pipeline + templates, and is irreversible; promotion must be explicit + opt-in.
- **A new ADR for the URL work.** Rejected: per-document URLs are literally ADR 0336's
  mandate; Phase 1 completes that ADR's documents follow-on and this ADR cross-references it.

## Consequences

- Every markdown document is now a first-class, shareable, middle-clickable URL — parity
  with canvases (ADR 0319) and honest notification targets (ADR 0336).
- The `documents` store keeps a single source of truth (markdown) with its render pipeline
  intact; the rich surface is reachable by explicit, one-way promotion — no drift.
- Reversible: Phase 1 is a routing change behind the existing `documents` toggle; Phases 2–3
  are additive.

## Open decisions / checklist

- [x] `/documents/:documentId` mounts full-screen (fullbleed), not a list panel.
- [x] Title + Open are real `<Link>`s; legacy `?doc=` redirects.
- [x] Phase 2: live-preview pane reuses the existing markdown renderer (`ui/Markdown`); **no CodeMirror dep**; entry bundle unchanged.
- [x] Phase 3: conversion owned by `document-editor` (schema owner), triggered by a
      `documents` handoff; one-way + idempotent (`documentId→canvasId`); source row linked,
      not dual-edited.

## Grade-pass follow-ups (2026-07-12 — all closed)

- [x] **DOCS-1 / DATA-DOCS-1** — a deleted `canvas.document` no longer leaves
  `promotedCanvasId` dangling: the documents feature registers on the
  `onCanvasDeleted` lifecycle seam (the comments/collab pattern) and
  `clearPromotedCanvasRefs` sweeps the tenant's referencing docs. A cleared doc is
  re-promotable. **Decision — markdown-delete semantics:** deleting a *promoted
  markdown doc* leaves the canvas untouched; the canvas is an independent artifact
  with no back-reference, so only the provenance link dies with the doc row
  (consistent with one-way promotion). No code needed for that direction.
- [x] **DOCS-2** — bare `/documents/:id` no longer probes `getDocument` across
  every org: a host-ext `GET documents/locate/:documentId` does ONE point lookup
  (`getDocumentByIdForTenant`) then re-checks membership against the resolved org
  (`resolveEffectiveAccess`), 404 uniformly (no existence leak to strangers OR
  same-tenant non-members). The FE calls it once, then the normal org-scoped load.
- [x] **UX-DOCS-1** — the Write/Split/Preview toggle now shows visible text labels
  beside the icons (accessible name from content; redundant `aria-label` dropped).

## Phase → commit/test record

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 1 | Per-document URLs + `<Link>` cells + redirect + full-screen `DocumentDetailPage` | implemented | `features/documents/{DocumentDetailPage,DocumentsPage,DocumentViews,routes}.tsx`; FE build + lint + vitest green |
| 2 | Write/Split/Preview toggle; preview reuses `ui/Markdown` (no new dep; entry bundle unchanged) | implemented | `features/documents/DocumentDetailPage.tsx`; `styles/global.css` (`md-editor-*`); `documentDetailView.test.tsx`; FE build + lint + 17/17 vitest green |
| 3 | Opt-in promote-to-rich: `promote-html` route (markdown-it) + lazy `htmlToDocumentJson` + create/seed canvas + `promotedCanvasId` link (one-way, idempotent, 409 on re-point) | implemented | `documents/{documentsService,routes,render}.ts` + `documentsClient.ts` + `DocumentDetailPage.tsx` + `document-editor/documentSchema.ts`; `documents-route.test.ts` (15) + `documentPromote.test.tsx` (2); BE tsc + FE build + lint + 19 FE / 15 BE-route vitest green |
