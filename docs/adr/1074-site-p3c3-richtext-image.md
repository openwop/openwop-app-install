# ADR 1074 — Site design batch Phase 3c3: a richText screenshot beside the copy

Status: Accepted (2026-11-07). D1 is implemented in the PR that records it.

Part of Phase 3 of myndhyve-1e's myndhyve.ai design batch (David approved the
work), owned by f2. It follows [ADR 1073](1073-site-p3c2-quote-timeline.md).
It is host CMS rendering only, so no wire RFC is involved.

## Context

- **CS-04 (Campaign Studio, `sec:mh-campaign-example`, a richText):** the
  design is split copy with a browser-framed screenshot beside it. The frame's
  window bar reads "Approval · waiting for you", and a mono caption sits under
  the frame.
- **Live:** the section is copy only. A richText has one picture today,
  `visual: 'chat'` (ADR 0920 D5), and no way to carry a screenshot.
- Phase 3's plan listed `visual: 'image'` under P3c; P3c1 and P3c2 did not
  cover it.

## Decision

### D1. richText `visual: 'image'`

- **Fields:** `imageToken` (opaque media token), `alt` (≤200, required with a
  token, otherwise a 400), optional `frameUrl` (the window-bar label, ≤120,
  plain text, never a link) and optional `caption` (≤240).
- **Set:** `RICH_TEXT_VISUALS` becomes `['chat', 'image']`.
- **Layout:** the same split as `visual: 'chat'`. The head and the essay sit
  on the start side, and the screenshot on the other. On a phone they stack,
  copy first.
- **Frame:** the picture is the shared section picture (`ColumnShot`). A
  `frameUrl` draws the browser frame around it, the same rule as gallery,
  bento and timeline pictures. It is also 16:10, like them (see ADR 1073's
  open item).
- **Caption:** the stock mono figure caption, reading from the start like
  the frame's address.
- **Switching visuals:** like `chat`, the image fields stay stored when the
  author switches `visual`. The page and the crawler output show the picture
  only while `visual === 'image'` (ADR 0593 §C9).
- **Crawlers:** a `<figure>` with the image and a `<figcaption>`, after the
  essay. Markdown gets an image line and an italic caption.

## Alternatives

- **Reusing the `image` section's `frame: 'browser'` class (`fp-figure--browser`).**
  Rejected: that class names a section, and MyndHyve's `brand.css` 258 paints
  a band on it (ADR 1072's TEMP-12 note). The screenshot gets its own figure
  class.
- **A separate `image` section beside the richText.** Rejected: sections stack,
  and the design puts the screenshot beside the essay inside one section.

## Implementation

| Phase | What | Where |
|---|---|---|
| D1 | `richTextShot` validator; split render; prerender + markdown | `cmsService.ts`, `SectionRenderer.tsx`, `sectionHtml.ts`, `sectionMarkdown.ts`, `global.css` |

Tests:
- `test/adr1074-richtext-image.test.ts`
- `frontend/react/src/features/cms/__tests__/richTextImageP3c3.test.tsx`

Both are sabotage-witnessed (see the PR).

**Content for 1e after deploy and sync:** `sec:mh-campaign-example` gets
`visual: 'image'`, `imageToken`, `alt`, `frameUrl: 'Approval · waiting for you'`
and `caption`.
