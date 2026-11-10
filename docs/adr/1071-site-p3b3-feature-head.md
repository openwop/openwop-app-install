# ADR 1071 — Site design batch Phase 3b3: feature head, number chips, inset aside

Status: Accepted (2026-11-07). D1–D3 are implemented in the PR that records them.

Part of Phase 3 of myndhyve-1e's myndhyve.ai design batch (David approved the
work), owned by f2. It follows ADR 1070 (Phase 3b2). It is host CMS rendering
only, so no wire RFC is involved.

## Context

- **FEAT-07 (high), features "Already built":** a split head.
  - **Left:** the eyebrow, the heading, a big "130" with a mono label
    ("FEATURES, ALREADY BUILT"), then the body.
  - **Right:** a framed screenshot.
  - **Below:** three equal cards.
  - **Live:** a bento with a wide dark tile standing in for all of it.
- **HOME-15:** the home bento's steps are labelled with number chips ("01").
- **HOME-19:** one inset row carries a note on its right ("your-app.com").

## Decision

### D1. A feature head: `stat` + the section picture

- **`stat`:** a columns section field `{value, label}`. The value is a whole
  number from 0 to 9,999,999, the label is capped like a badge, and it is both
  or nothing.
- **The head:** a section with a stat leads with `fp-head--feature`, on the
  cards and bento layouts:
  - **left:** eyebrow, heading, the number (the real digits in the DOM) beside
    its words, then the lede;
  - **right:** the section's picture.
  - Under 900px the two stack.
- **The picture:** reuses the section picture that only timelines had
  (`imageToken`/`alt`/`frameUrl`, ADR 1064 P3f). It is now kept beside a stat
  as well, and it always carries its alt text. The refusal keeps the timeline
  message exact, and a stat section gets its own.
- **Crawlers:** they read the stat as its words and see the picture with its
  alt text. Markdown carries the stat line.
- **Without a stat:** the section keeps the plain head, so nothing moves.

### D2. A number-only bento eyebrow is a chip

A bento eyebrow of one to three digits ("01") draws as a number chip, accent
on a tint (and lighter on a dark tile). Any other eyebrow is unchanged. This
reads the existing field; there is no new key.

### D3. An inset row's `aside`

An inset item (a column `items` row) may carry an `aside` (≤ the meta cap),
drawn mono on the row's other side. Crawlers read it beside the label.

## Alternatives

- **A bento "feature" tile variant for FEAT-07.** Rejected: the design is a
  section head above an ordinary grid, not a tile.
- **A `number` field for HOME-15.** Rejected: the eyebrow already holds the
  words, and a digits-only eyebrow is unambiguous.

## Implementation

| Phase | What | Where |
|---|---|---|
| D1 | `stat` cleaner; the section picture beside a stat; `FeatureHead` on cards and bento; prerender + markdown | `cmsService.ts`, `SectionRenderer.tsx`, `sectionHtml.ts`, `sectionMarkdown.ts`, `global.css` |
| D2 | the digits-only eyebrow chip | `SectionRenderer.tsx`, `global.css` |
| D3 | `aside` on inset items; prerender + markdown | `cmsService.ts`, `SectionRenderer.tsx`, `sectionHtml.ts`, `sectionMarkdown.ts`, `global.css` |

Tests:
- `test/adr1071-feature-head.test.ts`
- `frontend/react/src/features/cms/__tests__/featureHeadP3b3.test.tsx`

Both are sabotage-witnessed (see the PR). Like the timeline picture, the new
section fields are set through the CMS API; the editor gains no controls.

**Content for 1e after deploy and sync:**
- **Features `sec:mh-features-foundation`:** `layout: 'cards'`, `stat: {value:
  130, label: 'features, already built'}`, the section picture (Admin · Feature
  toggles) with alt, and three cards.
- **Home bento:** eyebrows "01" to "04", and `items[0].aside: 'your-app.com'`
  on step 4.
