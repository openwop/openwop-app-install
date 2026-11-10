# ADR 1037 — CMS column media: pictures on columns items, a highlight flag, linked bento tiles and marquee app cards

Status: Accepted (David, 2026-11-03: the MyndHyve site redesign; "make the new
layouts and content look awesome with images").

## Context

The MyndHyve redesign canvas (2026-11-03) shows real product screenshots inside
the "how it works" bento tiles, a marquee of the four live apps as framed
screenshots, and a featured (highlighted) price column. A `columns` item could
carry text, a link and an icon, but no picture; the bento tile ignored `href`;
the marquee drew names only; and no layout could single one item out.

## Decision

Each addition is an optional field on a `columns` item. A section that sets none
of them renders byte-identically (the ADR 0920 / ADR 1032 rule).

- **`imageToken`** (an opaque media reference, charset-checked like
  `image.token`, never secret-scrubbed) with **`alt`**. A picture always carries
  its alt text: an item with `imageToken` and no `alt` is refused with a 400, on
  the base layer and in a locale overlay alike. Pictures load lazily and reserve
  a 16:10 box so the page does not shift.
- **`frameUrl`**: the ADR 1032 browser frame's plain-text address label (a label,
  never a link). Kept only when the item has a picture to frame.
- **`highlight: true`**: the item the section singles out (presentation only;
  any other value is dropped).
- **Bento** (`layout: 'bento'`): the picture sits at the tile's foot, edge to
  edge, or inside the browser frame. A tile with `href` is ONE link (the `cards`
  model: no nested links); `highlight` adds `.fp-bento__tile--highlight`.
- **Marquee** (`layout: 'marquee'`): when any item carries a picture, the items
  drift as app cards (picture, name, line). The readable list comes first; the
  loop's duplicate stays `aria-hidden` and `inert`; the pause button and the
  reduced-motion wrap are unchanged. Without pictures it is the bare-name
  marquee as before.
- **List** (`layout: 'list'`): `highlight` adds `.fp-col--highlight`.
- **Crawlers**: the prerendered HTML adds `<img alt loading="lazy">` to the item;
  the markdown nests `![alt](url)` under it. The frame and highlight are
  presentation and add nothing there.

Styling is brand-neutral: new `.fp-*` rules use existing tokens only (the
highlight is the `--clay-text` accent outline), so each tenant's brand restyles
them.

## Not in this ADR

`cta.note`, `hero.tone` and `image.tone` were considered and left out to keep
this change to the `columns` paths while the parallel CMS motion-vocabulary work edits
the same files.

## Consequences

- No new section type and no protocol surface: host-side presentation and text
  on an existing type (ADR 0748 closed body holds).
- The editor offers a picture picker, alt text and frame address on bento and
  marquee items, and a highlight checkbox on bento and list items (four locales).
- Tests: `backend/typescript/test/adr1037-cms-column-media.test.ts` (validation,
  caps, overlay, prerender, markdown, unchanged output without the fields) and
  `frontend/react/src/features/cms/__tests__/columnMedia.test.tsx` (render and
  editor). Each was sabotage-witnessed.
