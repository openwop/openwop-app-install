# ADR 0334 — `canvas.document`: a rich-text document canvas type on the ADR 0310 framework

**Status:** implemented (2026-07-11) — **ALL phases + sub-phases complete**: 0–6 (seam, engine, editor, slash menu, outline, Markdown export, chat-drive AI, document comments) plus 2b/2b-2/2b-3 (media/tables · math · chart+embed), 3b/3b-2/3b-3 (a11y toolbar · focus+a11y-check · ⌘K palette contributions), 4b/4b-2/4b-3 (Markdown+PDF export · docx export · **docx import**), 5b/5b-2 (improve-selection deep-link · **apply-back as a tracked suggestion**), 6b/6b-2/6b-3 (inline range-anchored comments+click-open · track-changes · multi-step track-changes). Phase 7 (real-time collaboration) split to **ADR 0335** as its own program (the sole remaining item; infra-gated). Correction notes: **5b-2** apply-back shipped as a host-side return-handoff, NOT the ADR's originally-envisioned "RFC 0130 scoped diffs" wire mechanism (RFC 0130 never existed; apply-back is a host UX handoff, not a cross-host protocol need — see the 5b-2 row). **3b-3** extended the pre-existing global ⌘K palette rather than building a canvas-local one. Deferred (non-blocking): 4b materialization fidelity (the documents-hub bridge `canvasContentToMarkdown` still JSON-fences `canvas.document` state — a deliberate duplication decision); cross-block/structural/format track-changes (needs a changeset + deletion-decoration rearchitecture)
**Date:** 2026-07-10
**Depends on / composes:** ADR 0310 (Canvas Editor Framework — the `CanvasTypeDefinition`
contract + shared chassis), ADR 0053 (Documents & Templates — the markdown business-document
store), ADR 0314/0319 (the Documents page as the creation hub that lists markdown docs AND
canvases as peer rows), ADR 0057 (md→pdf render), ADR 0007 (Media), ADR 0013 (Sharing),
ADR 0058 (chat-drivability = agent + node pack), ADR 0325 (AI chain discipline), RFC 0130
(canvas selection/preview seam). **Research:** `docs/research/documents-best-in-class.md`
(the industry deep-dive + full core-vs-document placement table + phased plan).
**Toggle:** `document-editor` (planned Phase 1) · default **OFF** · `bucketUnit: tenant`
**Surface:** host-extension — a new `canvas.document` canvas type riding the existing
`registerCanvasEditorRoutes` factory over `host.canvas` (non-normative, no RFC).

---

> **Correction note (2026-07-10, post-merge review of #1601):** several commit messages
> inside the squashed #1601 cite "ADR 0333" for document phases — 0333 is the DRAWING
> program; the document decisions are THIS ADR. The file collision (a second `0334-*`
> for deep-linkable URLs) was resolved by renumbering that ADR to 0336. Grep for
> `canvas.document` rather than the ADR number when tracing #1601's history. Same
> review pass: the unwired `EditorSurfaceProps.readOnly` was removed (6b reintroduces
> it with a real consumer), Markdown export gained character escaping + code-link
> composition + dynamic fences, external re-seeds now reset the editor's undo stack,
> and the slash popup clamps to the viewport and tracks scroll.

## Context

openwop has a mature shared canvas framework (ADR 0310) with five canvas types
(app-builder, slides, drawing, cad, campaign) and ~26 pieces of shared machinery — but **no
rich-text document type**. The "document" name today belongs to the ADR 0053 `documents`
feature, which is a **Markdown store edited in a plain `<textarea>`** (`DocumentsPage.tsx:384`)
— versioned, template-driven, agent-generatable, md→pdf-renderable, but with zero WYSIWYG,
zero rich text, zero collaboration. There is **no rich-text editor engine anywhere in the
repo**.

The full industry analysis (four parallel researchers: Word/Google Docs, the block editors,
the editor-engine/CRDT tech layer, and UX/a11y) lives in
[`docs/research/documents-best-in-class.md`](../research/documents-best-in-class.md) — this
ADR is its decision record. The key finding: a word processor is a **linear flow of tokens
with hierarchical structure and character-level selection** — it fits **none** of the ADR 0310
traits (`frames`/`tree`/`elements`/`graph`). The ADR 0310 research doc already ruled this case
(line 173): *"A type that fits none [of the traits] still gets shell + lifecycle + history +
toolbar and supplies its own center panel."* This is the same reason the workflow builder's DAG
stays a distinct editor (line 121).

## Decision

Add **`canvas.document`** as the sixth canvas type — a **TipTap v3 / ProseMirror rich-text
editor** mounted through a **new core `EditorSurface` seam** (generalizing the existing
`InteractivePreview` seam beyond the elements trait), inheriting the full ADR 0310 chassis
(shell, toolbar, save/CAS/409, version history, share, preview, present, i18n, a11y announcer).
The editor engine and everything prose-specific stay in the **DOCUMENT layer**; the seam, the
`flow` trait projections, and the cross-cutting experience pillars (comments, outline,
mediaRef/embeds, export mechanism, a11y checker, Cmd+K, the collaboration seam) go in **CORE**
where a second canvas type wants them. The complete per-feature CORE-vs-DOCUMENT placement
table is §4 of the research doc.

### Engine (research §2)

**TipTap v3 on ProseMirror (MIT core), headless, ProseMirror-JSON canonical.** ProseMirror's
schema-constrained tree with flat inline runs (marks as metadata on text) makes any position a
single integer offset → tractable position mapping, which is the precondition for comment
anchoring, safe AI patching, and (later) collaborative rebasing. **Canonical storage =
ProseMirror JSON** in the canvas `state` (never HTML). Rejected: Lexical (pre-1.0, collab
caveats), Slate (pre-1.0, batteries-excluded, IME bugs), CKEditor/TinyMCE (GPL-or-metered +
proprietary non-Yjs RTC — license-hostile to the white-label bundle), Quill (lossy HTML).

### The `EditorSurface` seam (Phase 0 — the enabling contract)

`InteractivePreview` (types.ts) lets an **elements-trait** type replace the read-only Renderer
with a direct-manipulation center panel that owns gestures while the chassis owns selection +
history. `EditorSurface` generalizes that for a type whose document is a linear rich flow:

- The type supplies a **full editor center panel** (the TipTap editor). The chassis owns
  **save (CAS/409), version snapshots, and dirty state** via `useCanvasDoc`; the
  `EditorSurface` owns **intra-document selection AND undo/redo** (ProseMirror history).
- **Undo ownership (the load-bearing rule):** `onDocChange(doc)` updates the working copy +
  marks dirty but **does NOT push a chassis-history step** — otherwise two undo stacks fight.
  For `EditorSurface` types the chassis undo/redo toolbar is suppressed (the editor's own
  Cmd+Z / Cmd+Shift+Z govern), and Save/version/CAS still operate on the whole doc.
- **Precedence** in `CanvasEditorPage`'s center dispatch: `graph → EditorSurface →
  PreviewPanel → InteractivePreview → Renderer`.
- The document type sets **no trait** and supplies `EditorSurface` + `coerceDoc` + the
  read-only `Renderer` (chat card + shared view, PM-JSON serialized) + `docNameKey:'title'`.

### The `flow` trait (Phase 0 type; wired Phase 3)

An optional trait exposing projections the chassis reuses without knowing the prose model:
`headings(doc)` → the shared outline / navigation pane. (Block-level property editing is not
modeled — rich-text formatting rides the toolbar/bubble menu, not a property panel.)

### Storage & compat (the boundary/cohesion ruling)

`canvas.document` rides the **existing `host.canvas` store** via `registerCanvasEditorRoutes`
— the SAME store all five canvas types use — with **no backend change**: the factory stores
arbitrary JSON `state`, validates via the type's `validate` (fail-closed 422), CAS via
`expectedVersion`→409, captures snapshots→version history, tenant-scopes by-id (isolation),
and restores non-destructively. **It is NOT a parallel document store** — it coexists with the
markdown `documents:doc` exactly as ADR 0319 already unifies canvases + markdown docs in one
Documents hub. Three "document" nouns now coexist (the ADR 0053 naming note): `documents:doc`
(markdown business docs, ADR 0053), `canvas.document` (rich-text, this ADR), and run artifacts
(`artifacts:read`). **Single-owner-per-store rule:** `host.canvas` owns canvases incl.
`canvas.document`; `documents:doc` owns markdown business docs; the hub (ADR 0314/0319)
composes both. In the "+ New" modal the rich-text document appears in the **Write** group
beside the markdown document; a future **md→PM-JSON importer** bridges them (not v1).

### Replay / fork

None new. `host.canvas` rows are user-edited durable state, not run-stamped; the `from-artifact`
route seeds a canvas deterministically from a run artifact; PM-JSON content is deterministic;
no new run-event, no wire.

### Collaboration (deferred to its own program — Phase 7)

v1 is **single-writer on `host.canvas` CAS + versions** (the slides/drawings posture). Choosing
ProseMirror keeps the collaboration seam genuinely open (ProseMirror ↔ `Y.XmlFragment` is a
documented Yjs binding). **Recorded caveat:** `host.canvas` whole-doc CAS is NOT the CRDT
persistence model — the real-time program (Yjs + awareness presence + a Hocuspocus/y-sweet sync
server + a snapshot/update-log store with `gc=false`) is a cross-cutting infrastructure program
with its own ADR (it also serves chat + every other canvas); do NOT force CRDT through CAS.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `document-editor` FE feature supplying the `canvas.document` definition + the TipTap `EditorSurface` component; backend rides `registerCanvasEditorRoutes` (no new store). Composes ADR 0310/0053; no parallel engine. |
| 2 | Toggle / admin | `document-editor` toggle, default **OFF**, `bucketUnit:tenant` (new editor surface + new dep — gated rollout), one toggle for the type (ADR 0319 one-toggle-per-canvas-type rule). |
| 3 | Workflow surface | Reuses the existing `documents` workflow surface / node pack; a rich-text doc is a canvas the documents surface can produce/reference. |
| 4 | Node pack | Grows `packs/feature.documents.{nodes,agents}` for in-editor AI (Phase 5); no new pack in Phase 0–1. |
| 5 | AI-chat envelopes | Rides the existing chat (ADR 0058) + RFC 0130 selection seam; **no bespoke panel** (CLAUDE.md single-chat rule). |
| 6 | Agent pack | Extends the existing document-author/reviewer agents (Phase 5). |
| 7 | Public surface | Reuses the chassis share seam (approved/final-only, ADR 0013/0053); read-only Renderer for the shared view. |
| 8 | RBAC + isolation | Inherits `registerCanvasEditorRoutes` tenant-scoping + toggle gate; no new IDOR surface. |
| 9 | Replay / fork | None new (durable user-edited state; deterministic from-artifact seed). |
| 10 | Frontend | New editor engine dep in the FEATURE layer; `canvas/` gains only the `EditorSurface` + `flow` seam types. Token-only CSS, i18n ×4, `/ux-review` + `/browser` gated per phase. |

## Phases

Mirrors research §5 (the 8-phase plan). Phase 0 (this ADR): contract foundations only.

| Phase | Scope | Layer | Gate |
|---|---|---|---|
| **0** | ADR; `EditorSurface` seam + `flow` trait types on `CanvasTypeDefinition`; a generic `summarizeVersions` chassis default (non-frames types) | core | tsc + existing suites green + a default test |
| 1 | TipTap editor + `canvas.document` definition + `EditorSurface` mount + undo ownership + toggle + FEATURES row | document | build + route/editor tests + /browser |
| 2 | Insert model: the `/` slash-command menu (accessible listbox, no tippy dep) + placeholder hint (markdown input rules already ship with StarterKit); media/embed/chart/math/table blocks → **Phase 2b** (need cross-feature MediaPickerDialog + sandboxed-embed + KaTeX/table) | document | build + tests |
| 3 | Outline/navigation pane wired from `flow.headings` (chassis `FlowOutline` — heading map + click-to-scroll); pageless measure + line-height already in Phase-1 CSS. Focus mode + Cmd+K palette + a11y-checker → **Phase 3b** | core + document | build + a11y |
| 4 | Markdown export — a PM-JSON→Markdown serializer (`pmToMarkdown`) + a `ToolbarExtras` Copy/Download slot (of-record: exports the saved canvas). JSON→docx, PDF-via-the-existing-ADR-0057-renderer, and DOCX import → **Phase 4b** (need a dep + backend wiring) | document | content-assert tests |
| 5 | AI assist v1 — an "Ask AI" toolbar button deep-linking the EXISTING chat scoped to the `document-author` agent (ADR 0058 chat-drive; single-chat rule; no in-route LLM). Inline improve-selection / `/ai` / ask-doc / scoped diffs via RFC 0130 → **Phase 5b** | document | deep-link test |
| 6 | Document-level comments v1 — reuse the generic `comments` feature: add the `canvas_document` resource type (+ a tenant-scoped, type-checked target validator over `host.canvas`) and open the shared `CommentsPanel` in a modal from the editor toolbar. Inline range-anchored comments + track-changes (ProseMirror marks) → **Phase 6b** | core (comments) + document | build + tests |
| 7 | Real-time collaboration — split out as its own program: **ADR 0335** (Yjs stack, app-wide, RFC-gated if cross-host). Not built inline | core (new infra) | separate program (ADR 0335) |

## Alternatives considered

1. **Upgrade `documents:doc` markdown to rich text in place.** Rejected — it would rebuild the
   ADR 0310 chassis (shell/toolbar/history/versions/share/present) inside the `documents`
   feature; the whole point is to ride the framework as canvas type #6.
2. **Build a contenteditable editor in-house.** Rejected — contenteditable is browser-defined;
   every serious editor exists to paper over it. Buy the engine (research §2).
3. **Overload `InteractivePreview` / `PreviewPanel`.** Rejected — `InteractivePreview` is typed
   to the elements trait (`col/idx`); `PreviewPanel` is a read-only preview seam. A rich-text
   editor needs its own seam (the architect Phase-0 finding).
4. **Real-time co-editing in v1.** Rejected for v1 — net-new CRDT infra with app-wide scope; its
   own program (Phase 7). Ship single-writer; keep the seam open.
5. **Docs-as-database (Notion/Coda tables/relations/formulas).** Rejected — CRM/CMS/kanban/CDP
   already own structured data; a document references them (research §4.3 non-goal).

## RFC verdict

**Pure host-extension — NO new RFC, and none blocks it.** The `canvas.document` type rides the
existing non-normative `registerCanvasEditorRoutes` factory + `host.canvas`; the editor is FE.
Phases 0–6 are host-ext (the ADR 0310/0317/0323 precedent). **The Phase 7 collaboration program
and any normative cross-host document artifact type route through `../openwop` RFCs first**
(the ADR 0053 §RFC-verdict boundary: a cross-host `artifact.created` doc type is a separate RFC
if ever wanted).

## Phase → commit (updated as phases land)

| Phase | Status |
|---|---|
| 0 — contract foundations | implemented — `EditorSurface` + `flow` trait types + generic `summarizeVersions` default (versionSummary.ts) |
| 1 — the rich-text editor | implemented — TipTap v3 dep (lazy-chunked, entry budget held at 184.8 kB); `document-editor` backend feature (`registerCanvasEditorRoutes` over `host.canvas`, PM-JSON structural+DoS validator) + toggle (OFF/tenant); FE `canvas.document` definition (EditorSurface + read-only Renderer + coerceDoc + flow.headings); `EditorSurface` mounted in the chassis center-panel dispatch with undo-ownership (onDocChange = history.replace, chassis undo/redo hidden); creatableTypes row + i18n ×4; FEATURES row |
| 7 — collaboration | split to ADR 0335 (Proposed) — a cross-cutting Yjs program, not built inline (the seam is kept open by the TipTap/ProseMirror choice) |
| 6 — comments (v1) | implemented — document-level comments via the generic `comments` feature: `canvas_document` resource type + a tenant-scoped, type-checked target validator (`getCanvasForTenant`, uniform 404); a "Comments" toolbar button opens the shared `CommentsPanel` in a modal scoped to `(canvas_document, canvasId)`. Inline range-anchored comments + track-changes → Phase 6b |
| 6b — inline comments | implemented — range-anchored comment threads via a `comment` ProseMirror **mark** (carries an opaque `threadId`; `inclusive:false`; in the shared schema so the highlight shows in the read-only view too) + the **composite-resourceId** precedent (`resourceId = ${canvasId}#${threadId}`, exactly the chat_message/priority_idea pattern — zero comment-schema change). The `canvas_document` validator splits on `#` (backward-compatible with whole-canvas threads); a new `pruneThreadsForResourceAndComposites` cascades BOTH the whole-canvas thread and every inline thread on canvas-delete (exact-or-`#`-prefix, so a prefix-sharing sibling id is never swept). The `EditorSurface` seam gains an optional `canvasId`; a "Comment" toolbar button + ⌘K command applies the mark over a selection (or opens the thread under the cursor) and reuses the shared `CommentsPanel` scoped to the composite id — **no new comment UI**. Disabled until the canvas is saved. Tests: schema (mark + attr + `inclusive`), composite validate (accept/reject wrong-type), cascade-on-delete (+sibling-safety). **Track-changes (suggestions/accept-reject) → Phase 6b-2** (a separate change-tracking sub-system). Click-to-open: clicking a highlighted comment range opens its thread (editor `handleClick` → `data-comment-thread` → the shared panel), the Google-Docs affordance |
| 6b-2 — track-changes | implemented — "Suggesting mode": two suggestion marks (`insertion`/`deletion`, each with an `author` attr, in the shared schema so the read-only renderer shows them) + a ProseMirror plugin. When suggesting is ON, `appendTransaction` rewrites each edit into tracked suggestions — inserted text gets `insertion`; deleted text is **re-inserted from the pre-step doc** (the architect's required correction — content is gone by append-time) carrying `deletion` (struck, not removed). The conversion rides the user's own history event (one Cmd⁠+Z reverts edit+conversion together). Toolbar toggle (`PencilIcon`) + accept/reject (all when nothing's selected, at-cursor when the caret is in a suggestion) + ⌘K commands; export maps `deletion` → `~~…~~` (both `pmToMarkdown` twins), `insertion` → plain. Token-only CSS (underline/strike so it's not color-alone). **v1 scope** (a real complexity gate): a single flat `ReplaceStep` per transaction (typing/Backspace/Delete/paste/type-over within a text block); multi-step, structural (`ReplaceAroundStep`, splits/joins), cross-block, and mark/format-change tracking → **Phase 6b-3** (applied untracked in v1). Core unit-proven at the PM-state level (insert, delete-reconstruction, type-over, author, bail-out, accept/reject-all). No backend, no wire, no RFC (marks ride in canvas-state PM-JSON) |
| 6b-3 — multi-step tracking | implemented — generalised `buildTrackTransaction` from 6b-2's single-step case to **N flat `ReplaceStep`s across the batch**, mapping each step's inserted range into final-doc coordinates via `Mapping` composition (`full.slice(j+1)`), so multi-step text edits (multi-step paste/commands) are tracked too — single-step reduces to identical 6b-2 behaviour (no regression, all 6b-2 tests green). Still bailed → applied untracked (a documented boundary needing a changeset + deletion-decoration rearchitecture): cross-block deletions (open slices), non-`ReplaceStep` structural edits (`ReplaceAroundStep`, cross-block splits/joins), and mark/format-change tracking. New PM-state tests: two-insertion multi-step, mixed insert+delete multi-step, structural bail-out |
| 5 — AI assist (v1) | implemented — "Ask AI" toolbar button (`DocumentToolbarExtras`) deep-links the existing chat scoped to `feature.documents.agents.document-author` (ADR 0058 chat-drive; no bespoke panel, no in-route LLM). Inline improve-selection + RFC 0130 scoped diffs → Phase 5b |
| 5b — improve selection | implemented (prefill half) — an "Improve with AI" toolbar button + ⌘K command stages the SELECTED text as a one-shot composer draft (`chat/composerSeed.ts` — a leaf module `ChatInput` consumes on mount / conversation-switch; the "activation survives the async mount" pattern, works in BOTH chat shells with a single composer change, NO `?draft=` param threading) then deep-links the chat scoped to the document-author agent. So the user gets the selection pre-filled with an improve-instruction in the ONE chat — **no bespoke AI panel, no in-editor LLM, no wire** (ADR 0058 + the single-chat rule). Shared `DOCUMENT_AUTHOR_AGENT` const de-duped (`documentAgents.ts`). i18n ×4; seam unit-tested (one-shot stage/take, replace, empty). Apply-back → Phase 5b-2. |
| 5b-2 — apply-back | implemented — **premise corrected:** the ADR framed apply-back as "RFC 0130 scoped diffs" (a wire mechanism), but `/architect` (options-eval) found apply-back is a **host-side UX handoff, not a cross-host protocol need** — so NO wire, NO RFC (RFC 0130 never existed; the corpus tops out at 0126). A generic **return-handoff seam** (`chat/returnTarget.ts`, a leaf like the 3b-3 command seam): the doc editor's "Improve with AI" stages a serialisable return-target (`{label, returnPath, canvasId, from, to}`) before deep-linking the chat; the chat shows a generic **"Apply"** action on assistant bubbles (reusing the `MessageBubble` action row — no new panel, no `chat/`→`document-editor/` import) that stashes the chosen response as a one-shot pending-apply and navigates back; the doc editor consumes it on mount and lands the text over the range **as a tracked 6b-2 suggestion** (old struck-deletion + new insertion — never silently authoritative; the user accepts/rejects). Stale/out-of-bounds range fails closed. No replay/fork impact (normal canvas-state edit, not a run event). Seam + apply-as-suggestion core unit-tested; i18n ×4 (chat + doc). Option A (a scoped-diff wire RFC) remains available later IF cross-host agent-proposed edits ever become a goal |
| 4 — export (Markdown) | implemented — `pmToMarkdown` serializer (headings/paragraphs/lists/quote/code/hr + bold/italic/strike/code/link marks; lossy + schema-bounded) + `DocumentExportButtons` ToolbarExtras (Copy as Markdown / Download .md over the saved canvas, `role=status` feedback, dirty-honest). docx/PDF/import → Phase 4b |
| 3b — a11y toolbar | implemented — roving-tabindex format toolbar (ARIA APG: one Tab stop, Arrow/Home/End move focus). Focus/typewriter mode + Cmd+K palette + a11y-checker pane → Phase 3b-2 |
| 3b-2 — focus + a11y check | implemented — Focus mode (iA Writer: dim all but the active block + typewriter centre-scroll, opt-in, reduced-motion-safe) + an accessibility checker (missing image alt + skipped heading levels, WCAG 1.1.1/1.3.1 — pure `documentA11yIssues`, tested) surfaced in a toolbar Modal. Cmd+K palette → 3b-3 (chassis-wide) |
| 3b-3 — ⌘K palette | implemented — **premise corrected:** the app already ships ONE global ⌘K command palette (`ui/CommandPalette.tsx`, mounted app-shell-wide, self-owns the chord with `preventDefault`); a canvas-local palette would be a CRITICAL duplication (the architect boundary check). Instead added a **contribution seam** — `ui/commandContributions.ts` (a leaf pub/sub with a cached, stable snapshot for `useSyncExternalStore`) — and extended the palette's `Command` with an in-place `run?` (executed instead of navigating). The `DocumentEditorSurface` registers its verbs (insert chart/embed/math/table/image, import Word, focus mode, accessibility check) while mounted and withdraws them on unmount, so ⌘K exposes the document's actions **inside the one palette**. Seam unit-tested (register/collect/withdraw, stable-ref snapshot, replace-by-key, throw isolation). This makes the single palette more capable rather than forking a second one |
| 4b — export (PDF) | implemented — a server-authoritative export verb (`extraRoutes` `POST …/canvases/:id/export {format}`): loads the SAVED canvas, serializes via a backend `pmToMarkdown` twin, streams Markdown or PDF (reusing the ADR-0057 `renderMarkdownToPdf` pdfkit path — no Chromium). Authz=read, type-pinned, format-validated (400), header-injection-safe filename. FE "Download PDF" toolbar button. **docx export (docx.js dep) + DOCX import (mammoth→PM-JSON) → Phase 4b-2** (heavier; deferred) |
| 4b-2 — export (docx) | implemented — a PM-JSON→.docx mapper (`pmToDocx`, docx.js: headings/marks/lists/blockquote/code/table + links; images skipped v1) wired into the export verb (`format:docx`); FE "Download Word" button. DOCX import (upload UI + mammoth→PM-JSON) → 4b-3 |
| 4b-3 — import (docx) | implemented — an org-scoped `extraRoutes` verb (`POST …/orgs/:orgId/import {docxBase64}`, authz=write, 10 MB cap + a scoped 12 MB body parser) runs `mammoth.convertToHtml` → `{html, warnings}`; the FE "Import Word" toolbar button (hidden file input) reads the `.docx` as base64, POSTs it, and parses the returned HTML **through the schema** via `generateJSON(html, documentExtensions())` (script/unknown tags dropped — no XSS) before `setContent` (emits → onDocChange dirties; unsaved until the user saves). Semantic-first: fonts/colours are dropped, warnings surfaced. i18n ×4; route test round-trips a docx.js-built `.docx` |
| 3 — outline/navigation | implemented — chassis `FlowOutline` renders `def.flow.headings(doc)` as a live document map (level-indented rows, click-to-scroll to the Nth heading via the preview content ref), shown for flow-trait types once the doc has headings. Focus mode + Cmd+K + a11y-checker → Phase 3b |
| 2 — insert model | implemented — the `/` slash-command menu (`@tiptap/suggestion` + an accessible `SlashMenu` listbox with aria-activedescendant + keyboard nav, positioned without tippy, Escape/click-away close) over a 9-block catalog; `@tiptap/extension-placeholder` empty-line hint that teaches `/`; StarterKit markdown input rules verified. Editable-surface-only (read-only renderer stays light). i18n ×4; token-only CSS. Media/embed/table/math deferred to Phase 2b |
| 2b — media/tables | implemented — tables (`@tiptap/extension-table`, resizable, GFM export) + images (`@tiptap/extension-image` via the shared `MediaPickerDialog` — tenant-scoped Media asset URL, `allowBase64:false`); slash `table` + Table/Image toolbar buttons; `orgId` added to the `EditorSurface` seam; md-export extended. Math (custom KaTeX node) + chart/embed (NodeViews + security) → Phase 2b-2 |
| 2b-2 — math | implemented — a `mathBlock` KaTeX node (atom; NodeView via `katex.render`, `throwOnError:false` degrades to source) edited through a LaTeX modal (textarea + live preview); `∑` toolbar button (insert/edit selected); md-export → `$$…$$` (FE+BE). KaTeX split into its own lazy chunk (also shrank the markdown chunk 207→52 kB gz). Chart + embed (NodeViews + security review) → Phase 2b-3 |
| 2b-3 — chart + embed | implemented — two atom nodes rendered via **`ReactNodeViewRenderer`** so they render identically in the surface AND the read-only renderer: `chartBlock` (reuses the chat `ChartRenderer` — inline SVG from a JSON spec, no charting lib) + `embedBlock` (reuses the chat `SandboxedArtifactFrame` — `sandbox="allow-scripts"` opaque-origin + `default-src 'none'` no-egress CSP + `srcDoc`-only). Each has a toolbar button (`BarChartIcon`/`MonitorIcon`) opening an insert/edit modal with a live preview. Content stored inline in the canvas PM-JSON (no new route/wire); md-export → fenced ` ```chart `/` ```html ` blocks (FE+BE), docx → italic placeholders; validator caps embed HTML at 512 KB. **Security posture:** an embed's script is neutralised even in a shared/public viewer's browser (no same-origin ⇒ no cookie/token access; no egress ⇒ no exfiltration) — the same isolation boundary the app already accepts for chat `interactive.html` artifacts. i18n ×4; schema + serializer + validator tests |
