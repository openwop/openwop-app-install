# ADR 0057 — Document rendering (non-markdown output)

**Status:** implemented (PDF + slides (PPTX) + sheet (CSV) — `features/documents/render.ts`,
the `…/documents/:id/render` route + `feature.documents.nodes.render` +
`ctx.features.documents.render` + FE PDF/Slides/CSV downloads; `test/documents-route.test.ts`.
xlsx upgrade for sheets deferred.)
**Date:** 2026-06-16
**Depends on / composes:** ADR 0053 (Documents & Templates — this is its deferred Phase 2),
ADR 0007 (Media Library — rendered bytes live here as RFC 0055 tokens).
**Surface:** host-extension under `/v1/host/openwop-app/documents/*` + the existing
`feature.documents.nodes.render` node. **Host-only — no RFC.**

## Why this exists

ADR 0053 shipped Documents markdown-only and explicitly deferred non-markdown rendering:
*"md→pdf/slides/sheet rendering does not exist today … delivered via a workflow-node render
path or deferred."* A `DocumentVersion` already carries an optional `renderedMediaToken`
(a Media/RFC 0055 reference) and the node pack already declares a stubbed
`documents.render`. This ADR decides **how** rendering actually works and **which formats**
v1 supports — the open call is a new runtime dependency + where the work runs, which is why
it gets its own ADR rather than a silent Phase-2 commit.

## Decisions to confirm (the sign-off)

**1. Formats → PDF, slides (PPTX), sheet (CSV).** PDF is the high-value output (SOW/PRD/RFP
sign-off copies, board packets) and the canonical *shareable* representation (the only one
that stamps `renderedMediaToken`). **Slides** render via `pptxgenjs` (one slide per top-level
heading; rough deck skeleton). **Sheet** renders to **CSV** (zero-dep; emits the doc's markdown
tables, else a one-column line dump) — `xlsx` is a deferred upgrade. A request for any other
format returns a clear 4xx. *(§Correction: the original "PDF only" v1 was widened to all three
when the deferred items were prioritized — pure-JS deps only, no Chromium.)*

**2. Renderer engine → pure-JS (`markdown-it` → tokens → `pdfkit`), NOT headless Chromium.**
- *Pure-JS (recommended):* `markdown-it` to parse + `pdfkit` to lay out (headings, paragraphs,
  lists, tables, code blocks, basic styling). **No native/Chromium dependency**, so Cloud Run
  image size and cold-start are barely affected; deterministic; runs anywhere. Trade-off:
  good-not-pixel-perfect fidelity (no arbitrary HTML/CSS).
- *Headless Chromium (rejected for v1):* markdown→HTML→`puppeteer` PDF gives high fidelity but
  adds ~300MB+ to the image, real cold-start cost, and a heavyweight native dep — disproportionate
  for business documents that are headings + prose + tables. Revisit only if fidelity demands it.
- Both new deps are **pure-JS, zero native** (`markdown-it`, `pdfkit`); recorded here per the
  "no new runtime deps unless justified" bar.

**3. Where rendering runs → a synchronous route AND the node (shared renderer).** Unlike
*generation* (run-scoped because the LLM provider needs a per-node `AdapterScope`, the ADR 0011
§Correction lesson), **rendering is deterministic CPU work with no provider** — so it does *not*
need a run. Therefore:
- **`POST …/documents/:documentId/render` `{format:'pdf'}`** (authed, `workspace:write`) —
  renders the current version's `content`, uploads the bytes to **Media** (RFC 0055), and
  records `renderedMediaToken` on that version. Powers the "Download PDF" UX directly. Bounded:
  a content-size cap + a render-time guard (fail-closed to a 4xx, never hang the request path).
- **`feature.documents.nodes.render`** — the same renderer, for workflow composition (e.g.
  generate → render → email). Calls the shared `renderMarkdownToPdf()` + the Media upload seam.
- The renderer is one shared module (`features/documents/render.ts`); the route and node are thin
  callers, so behavior can't drift.

## Data flow

```
markdown content ─ markdown-it ─▶ tokens ─ pdfkit ─▶ PDF bytes
   └─▶ mediaService upload (RFC 0055 token) ─▶ DocumentVersion.renderedMediaToken
```

The durable source of truth stays the markdown in `documents:version.content`; the PDF is a
*derived representation* referenced by token (the same Media boundary CMS/KB use). Re-rendering
is idempotent per (version, format).

## Phased plan

1. **Renderer module** `features/documents/render.ts` — `renderMarkdownToPdf(markdown): Buffer`
   (markdown-it + pdfkit), bounded; unit-tested on headings/lists/tables.
2. **Route** `POST …/documents/:documentId/render` → render current version → Media upload →
   stamp `renderedMediaToken`; return the token + a download URL. Caps + format guard.
3. **Node** wire `feature.documents.nodes.render` to the shared module + Media seam.
4. **FE** a "Download PDF" action on the document editor (renders, then opens the Media token URL).
5. **Tests** route (render → token, oversized → 4xx, unsupported format → 4xx) + renderer unit.
6. Update ADR 0053 §Phase 2 (markdown-only → "+ PDF") and mark this ADR implemented.

## Alternatives considered

1. **Headless Chromium for fidelity** — rejected for v1 (image/cold-start cost; overkill). The
   `render.ts` seam keeps it swappable if a high-fidelity tier is later justified.
2. **Render-only-in-a-node (no route)** — rejected: forces a workflow run for a plain "download
   PDF", poor UX, and rendering needs no run (deterministic, provider-free).
3. **Store rendered HTML instead of PDF** — rejected: PDF is the portable sign-off artifact; HTML
   adds little over the markdown already stored.
4. **A new host `ctx.render` capability surface** — deferred: a feature-local shared module is
   enough for v1; promote to a host capability only if other features need rendering.

## Open questions

- [x] Slides/sheets generators — DONE (slides via `pptxgenjs`; sheet via CSV). `xlsx`
  (rich spreadsheet) remains a future upgrade over the CSV floor.
- [ ] Should `render` create a NEW version or stamp the current one's `renderedMediaToken`?
  (Proposed: stamp the current version; a content edit invalidates/clears the token.)
- [ ] Theme/branding (logo, fonts) for the PDF — v1 is plain; brand tokens later.

## RFC verdict

**Pure host-extension — no new RFC.** Rendering produces Media (RFC 0055) bytes and stamps a
host-ext field; no wire shape changes. Adds two pure-JS backend deps (`markdown-it`, `pdfkit`).
