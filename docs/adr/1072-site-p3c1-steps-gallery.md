# ADR 1072 — Site design batch Phase 3c1: step cards, lead gallery, figure caption

Status: Accepted (2026-11-07). D1–D3 are implemented in the PR that records them.

Part of Phase 3 of myndhyve-1e's myndhyve.ai design batch (David approved the
work), owned by f2. It follows [ADR 1071](1071-site-p3b3-feature-head.md) (Phase 3b3). It is host CMS rendering
only, so no wire RFC is involved.

## Context

- **CS-03, DP-11: steps as cards.** Campaign Studio and design partners draw
  their steps as boxed cards with a "01" number chip and an arrow to the next.
  On design partners, one step is the dark card. Live, steps are unboxed. The
  `numbers: 'circle'` option gives a circle with "1", not a chip.
- **FEAT-04: a lead gallery.** The features canvas gallery leads with one tall
  picture on the left and stacks the rest on the right.
- **AGEN-05: four across.** The agencies proof gallery of four sits four
  across.
- **TEMP-12: the figure caption.** On templates, a browser-framed picture's
  caption is left-aligned.
  - **The muted band behind it is not this repo's.** The MyndHyve brand
    stylesheet paints it on every `fp-figure--browser` (`brand.css` 258).

## Decision

### D1. `cards: true` on a steps section

- **Cards:** each step is a boxed card with a two-digit number chip (accent on
  a tint), even when the section asks for circle numbers.
- **Arrow:** on a wide screen an arrow leads to the next card. It is drawn
  with borders, so it is decoration a reader never hears, and it is mirrored
  in RTL.
- **Highlight:** a step with `highlight` is the dark card (the band tokens,
  scoped with `fp-tone--inverse`). Outside cards, `highlight` still draws
  nothing on steps.
- **Without the flag:** a steps section is unchanged.

### D2. `galleryLayout: 'lead'`, and a gallery of four

- **Lead:** a closed enum, kept on galleries only. With two or more pictures,
  the first spans the rows of a wider left column and the rest stack on the
  right. On a narrow screen they keep their order in one column.
- **Four:** a gallery of exactly four goes four across from 1024px and two by
  two on a tablet. No seeded gallery exists, so no stock page moves.

### D3. A browser figure's caption reads from the start

`.fp-figure--browser .fp-figure__cap` is start-aligned, like the frame's
address bar.

## Brand stylesheet (myndhyve-app, for the Codex sync)

`brand.css` 258 paints the muted dotted band on every `fp-figure--browser`.
Scope it to a figure whose section sets `tone: 'muted'` (TEMP-12).

## Implementation

| Phase | What | Where |
|---|---|---|
| D1 | `cards` (steps only); chip numbers; highlight dark card; drawn arrow | `cmsService.ts`, `SectionRenderer.tsx`, `global.css` |
| D2 | `galleryLayout` (galleries only); lead grid; four-across rule | `cmsService.ts`, `SectionRenderer.tsx`, `global.css` |
| D3 | browser figure caption alignment | `global.css` |

Tests:
- `test/adr1072-steps-gallery.test.ts`
- `frontend/react/src/features/cms/__tests__/stepsGalleryP3c1.test.tsx`

Both are sabotage-witnessed (see the PR). These are presentation options set
through the CMS API, like `filter`; the editor gains no controls, and the
prerenders do not change.

**Content for 1e after deploy and sync:**
- **Campaign Studio `sec:mh-campaign-loop` and design partners
  `sec:mh-design-partners-next`:** `cards: true`; on design partners,
  `highlight` on the dark step.
- **Features `sec:mh-features-canvas`:** `galleryLayout: 'lead'`.
