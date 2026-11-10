# ADR 1032 — CMS canvas layouts: a film pair, a framed screenshot, an inset card and try-it switches

Status: Accepted (David, 2026-11-02: "Fix the CMS to support the artifact layout").

## Context

MyndHyve's homepage was rebuilt from a design canvas on 2026-11-02 using only the
sections and layouts the CMS already had (ADR 0920, ADR 1029). Five parts of the
canvas had no CMS equivalent:

1. two films side by side under one heading, with a footnote;
2. a product screenshot with a heading over it, inside a browser-window frame;
3. a small inset card inside a bento tile ("Ready to print · Agents set up ·
   Workflow tested · Billing switched on");
4. a "Try it: which steps wait for you?" panel of switches beside the statement
   rows of "You stay in charge";
5. a richText section with its heading on the left and its prose on the right.
   `head: 'split'` (ADR 0920 D2) split only the head block; the prose stayed
   underneath in the narrow column.

## Decision

Each addition is an optional field on an existing section type. A page that sets
none of them renders byte-identically, as with ADR 0920.

- **`video.film2`**: a second film with the same fields and the same rules as the
  first (https-only URLs; on the base layer `src`, `poster`, `title`,
  `description` and `length` are required; an overlay may carry its text only).
  It renders beside the first film (stacked below 760px). It gets its own
  VideoObject, prerendered figure and markdown entry. **`video.note`** is a
  footnote under the films.
- **`image.eyebrow` / `heading` / `lede`**: the shared head over the figure.
  **`image.frame: 'browser'`** (a closed enum) draws a window bar with three dots
  and **`image.frameUrl`**, a plain-text address label (never a link). The bar is
  decoration (`aria-hidden`); the image keeps its own alt text.
- **Bento tile `items`**: the column `items` field the `list` layout already
  validates (label + meta) now renders in a bento tile as an inset card: a bold
  line and its detail.
- **`columns.toggles`** (rendered by the `rows` layout): a title and up to six
  `{ label, on }` switches. The head and the panel sit on the left and the rows on
  the right (stacked below 900px). Each switch is a real checkbox with
  `role="switch"` and its state in words ("Waits for you" / "Runs on its own"),
  never colour alone. Flipping one saves nothing and sends nothing; it shows what
  the setting means. The prerender and markdown list the labels.
- **A split richText** (`richText` with `head: 'split'`) now lays the head and the
  prose out as two columns across the full shell, stacked below 900px.

## Consequences

- No new section type and no new protocol surface: every field is host-side
  presentation or text on an existing type, so the ADR 0748 closed-body rule
  holds.
- The editor exposes each field: the frame select and address, a "second film"
  fieldset, the inset card's two lines on bento tiles, and the switches on
  `rows`.
- Tests: `backend/typescript/test/adr1032-cms-canvas-layouts.test.ts` (validation,
  prerender, markdown, JSON-LD) and
  `frontend/react/src/features/cms/__tests__/canvasLayouts.test.tsx` (render and
  editor). Each was sabotage-witnessed.
