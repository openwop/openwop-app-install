# ADR 1070 — Site design batch Phase 3b2: bento tiles and default cards

Status: Accepted (2026-11-07). D1–D5 are implemented in the PR that records them.

Part of Phase 3 of myndhyve-1e's myndhyve.ai design batch (David approved the
work), owned by f2. It follows [ADR 1066](1066-site-p3a-hero-visuals.md) and
[ADR 1067](1067-site-p3a2-hero-cards.md). It is host CMS rendering only, so no
wire RFC is involved.

## Context

The gap analysis found these differences in the bento and card grids:

- **HOME-14 (high):** the home "How it works" bento has one tile two rows
  tall, and muted tiles.
- **HOME-17:** its "130" number is big and sits under the text, with a label.
- **FEAT-12:** the features page's tiles carry their picture at the top.
- **FEAT-09:** the small tiles carry icons.
- **AGEN-10:** the agencies page needs one dark card in an ordinary card grid.

Live, the renderer had:

- **Bento:** `wide` only. The count always led the tile, at display size.
  The picture always sat at the foot. There were no icons, and the only tile
  tone was `inverse`.
- **Default cards:** they ignored `tone` altogether.

## Decision

### D1. A `tall` tile and a `mist` tone

- **`tall: true`** spans two rows of the bento grid. It reverts to one row in
  the single-column phone layout.
- **`tone`:** a column item's own tone is now the closed set
  `['inverse', 'mist']`. `mist` is a muted tile (`--paper-2`, no border).

### D2. A labelled headline number

- **With a `countLabel`:** a tile's `count` becomes its stat, under the text,
  big (`calc(var(--text-display) * 23 / 7)`), with the label beneath it. It
  reuses the ADR 1038 D3 count-up, whose selectors already target
  `.fp-bento__count .fp-count`.
- **Without a label:** the count still leads the tile as before, so existing
  pages do not move.
- **Crawlers:** a labelled number reads as its words ("130 features, already
  built"). An unlabelled one adds nothing, as before.

### D3. `imagePosition: 'top'`

A closed enum. The tile's picture comes first and bleeds to the tile's top
edge.

### D4. Bento tile icons

A tile draws `CardGlyph` only when its `icon` names a known slug. There is no
node-motif fallback here, so a tile without an icon stays as it was.

### D5. A default card's own tone

The default `cards` layout honours a card's `tone`:
- `inverse`: dark, using the band tokens scoped by `fp-tone--inverse`, as on
  a bento tile;
- `mist`: muted.

The validator already kept `tone: 'inverse'` on every layout; the cards
layout did not draw it.

## Alternatives

- **Moving every count under the text.** Rejected: it would shift every
  existing bento page. The label is the opt-in signal for a stat.
- **A separate "feature" tile variant for FEAT-07's split head with stat and
  picture.** Deferred to Phase 3b3. It is a section-level head, not a tile
  option.

## Implementation

| Phase | What | Where |
|---|---|---|
| D1 | `tall`, tone set `['inverse','mist']`; classes; editor checkbox; i18n ×4 | `cmsService.ts`, `SectionRenderer.tsx`, `SectionsEditor.tsx`, `global.css` |
| D2 | `countLabel`; stat under the text; prerender + markdown | `cmsService.ts`, `SectionRenderer.tsx`, `sectionHtml.ts`, `sectionMarkdown.ts`, `global.css` |
| D3 | `imagePosition: 'top'` | `cmsService.ts`, `SectionRenderer.tsx`, `global.css` |
| D4 | known-slug tile icon | `SectionRenderer.tsx`, `global.css` |
| D5 | default-card tone | `SectionRenderer.tsx`, `global.css` |

Tests:
- `test/adr1070-bento-cards.test.ts`
- `frontend/react/src/features/cms/__tests__/bentoCardsP3b2.test.tsx`

Both are sabotage-witnessed (see the PR). No seeded page uses a bento icon or
a card tone (checked), so stock pages do not move.

**Content for 1e after deploy and sync:**
- **Home `sec:mh-factory-loop`:** `columns[0].wide` and `columns[1].wide`
  false; `columns[2].tall` true; `tone: 'mist'` where the design is muted; the
  "130" tile gets `countLabel`.
- **Features:** tile `icon`s (`plug`, `sparkles`, `terminal`); the picture
  tiles get `imagePosition: 'top'`.
- **Agencies:** `tone: 'inverse'` on the "130 features" card.
