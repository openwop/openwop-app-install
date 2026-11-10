# ADR 1073 — Site design batch Phase 3c2: pull quote and timeline options

Status: Accepted (2026-11-07). D1–D3 are implemented in the PR that records them.

Part of Phase 3 of myndhyve-1e's myndhyve.ai design batch (David approved the
work), owned by f2. It follows [ADR 1072](1072-site-p3c1-steps-gallery.md).
It is host CMS rendering only, so no wire RFC is involved.

## Context

- **ABOUT-07 (high):** the about page's "The one-person company" is one split
  section. The heading is on the left with a big accent pull quote under it,
  and the essay is on the right.
  - **Live, two sections:** a full-width blue quotes banner, then a split
    richText with no heading.
- **ABOUT-10:** "What's built so far" puts the head and the picture on the
  start side and the rail beside them. On a phone, the picture comes before
  the list.
- **ABOUT-11:** the rail's markers are numbered rounded-square badges. The
  live item's badge is green.

## Decision

### D1. A richText `quote`

- **Field:** plain text, capped at 240 (the caption cap).
- **Layout:** the quote renders under the heading as a `<blockquote>`, with
  the head in a lead column. On a split section that is the left column,
  beside the essay.
- **Style:** unboxed, `calc(var(--text-display) * 12 / 7)`, 800-weight
  (`--weight-marquee`), the accent colour, and curly quotes drawn by CSS
  `quotes`, so the stored text stays plain.
- **Crawlers:** they read it as a blockquote before the essay; markdown gives
  a `>` line.
- **Without a quote:** the section is unchanged.

### D2. A timeline's `shotSide: 'start'`

- **Field:** a closed enum, timelines only.
- **Layout:** the head and the section picture (ADR 1064 P3f) form one sticky
  start-side column, with the rail beside it.
- **Phone:** in reading order, and on a phone, the picture comes before the
  list.
- **Without the field:** the head stays on top and the picture beside the
  rail.

### D3. A timeline's `markers: 'badge'`

- **Field:** a closed enum, timelines only.
- **Badges:** each item gets a 40px rounded-square badge with its two-digit
  number in place of the dot, and the rail is recentred on the badges.
- **Live item:** the item with `highlight` (ADR 1037: "the item the section
  singles out") has a green badge. There is no new item field, and outside
  badges a highlight draws nothing on a timeline.

## Alternatives

- **Restyling `quotes` `style: 'pull'`** into the design's unboxed type.
  Rejected: other pages use the pull style, and the design's quote belongs
  inside the essay's section, not in a section of its own.
- **An item `state: 'live'`.** Rejected: `highlight` already names the
  singled-out item, and a second presentation key would drift from it.

## Open item (from myndhyve-1e)

The section picture box (`.fp-shot__img`) is a fixed 16:10 with
`object-fit: cover`. It is shared by every `ColumnShot`: galleries, bento
tiles, timelines and the ADR 1071 feature head. So a picture of any other
shape is cropped.

This PR does not change it. The option is a per-picture `ratio: 'auto'` that
drops the fixed ratio and the cover, rather than changing the shared default
under existing pages. Decide when a non-16:10 picture is needed.

## Implementation

| Phase | What | Where |
|---|---|---|
| D1 | `quote` validator; lead column + blockquote; prerender + markdown | `cmsService.ts`, `SectionRenderer.tsx`, `sectionHtml.ts`, `sectionMarkdown.ts`, `global.css` |
| D2 | `shotSide` (timelines only); start-side aside | `cmsService.ts`, `SectionRenderer.tsx`, `global.css` |
| D3 | `markers` (timelines only); badges; live badge | `cmsService.ts`, `SectionRenderer.tsx`, `global.css` |

Tests:
- `test/adr1073-quote-timeline.test.ts`
- `frontend/react/src/features/cms/__tests__/quoteTimelineP3c2.test.tsx`

Both are sabotage-witnessed (see the PR).

**Content for 1e after deploy and sync:**
- **About:**
  - `sec:mh-about-belief` gets `heading` "The one-person company",
    `head: 'split'` and `quote`;
  - delete `sec:mh-about-quote`;
  - `sec:mh-about-built` gets `shotSide: 'start'`, `markers: 'badge'`, and
    `highlight` on the live item.
