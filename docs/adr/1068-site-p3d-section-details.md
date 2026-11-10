# ADR 1068 — Site design batch Phase 3d: section details (films, incidents, rows, form card, small fields)

Status: implemented (2026-11-07). D1 #5661; D2 #5665; D3 in the P3d-3 PR.

Follows [ADR 1064](1064-site-p3-per-page-visuals.md) and [ADR 1066](1066-site-p3a-hero-visuals.md).
This is Phase 3d of myndhyve-1e's myndhyve.ai design batch (222 gaps; David approved
the work). Phase 2, the shared site defaults, landed in #5654; Phase 3 is the
components, split between f2 (P3a–P3c) and this session (P3d) so the two never edit
the same section case. It is host CMS rendering only (host-extension routes and the
CMS section shapes), so no wire RFC is involved.

## Context

The gap analysis (myndhyve-1e, `gap/analysis/*.md`) compared the redesign with the
live pages. The P3d items are details inside sections that already exist:

- **Films** (HOME-07, CAP-05, HOME-27, HOME-23): the corner play chip is a
  one-line pill with a ringed disc and the length inline, not a two-line block. Its
  words ("Watch the tour") differ from the film's name, but `title` is also the
  screen-reader name and the VideoObject name, so it cannot carry chip copy. The
  design shows a mono caption under each film, including chip films. The card strip
  ("Already printed") stays one sideways-scrolling row when it is not moving,
  rather than wrapping into a grid.
- **Incidents** (HOME-10/11/12, ABOUT-13): under a split head the list sits beside
  the lede; the glyph tiles are amber; a `card` icon; the closing note is lede-sized
  with highlighted phrases, which needs an inline highlight mark.
- **Rows with toggles** (HOME-30/31): an optional diagram (nodes, one waiting
  flag, a caption) in the side column, with the toggles panel above the rows.
- **Form card** (DP-04/05): the full shell, a 576px card, the design's input
  styles, and a note under the form.
- **Small fields** (CAP-16, RDM-10, AGEN-09, RDM-07): a column link on cards, an
  `arrow` icon, `headSize: 'sm'`, and board column text.

## Decision

Every new field goes through `buildTypedSectionData`: closed-world (an unknown key
is not stored), text cleaned and capped, enums closed. A localization overlay runs
the same builder (`sanitizeSectionOverlay`), so translatable text reaches overlays
with no second list. Visible text also reaches the crawler prerender
(`sectionHtml`) and the markdown export (`sectionMarkdown`). Styling is tokens
only, in both themes, with motion behind the reduced-motion guard.

### D1. Films (P3d-1)

- **`chipLabel`** (video and `film2`, capped at `MAX.label`): the corner chip's
  visible words; absent, the chip shows `title` as before. `title` stays the
  film's name (screen readers, VideoObject, crawler): when the two differ, the
  label is shown `aria-hidden` and the button's accessible name stays "Watch the
  video: {title} {length}", so the film is still named and the action not read
  twice. It is a control label, not prose, so it is not in the crawler render or
  the reading-time count.
- **`caption`** (video and `film2`, capped at `MAX.caption`): a visible line
  under the film (`fp-film__caption`, mono), shown with the corner chip too. It
  reaches the crawler figcaption and the markdown export; `caption` was already
  a `PROSE_KEYS` word for the reading-time count.
- **Chip restyle:** one line, `min-block-size` 52px, a dark translucent pill from
  `--tone-inverse-*` (dark in both themes, because it sits on the poster), blur,
  a 38px disc with an outer ring, the length inline. The disc colours are
  `--fp-film-disc` / `--fp-film-disc-ink` (default `--clay` / on-scrim), so a
  brand sets the design's periwinkle disc with a dark glyph without a selector.
- **Card strip at rest:** a card marquee that is not moving is one row that
  scrolls sideways (scroll snap); its viewport is then a named, focusable region
  (keyboard scrolling, axe `scrollable-region-focusable`). A name-only marquee
  keeps wrapping, so no item hides off-screen. The moving strip keeps
  `overflow: hidden`.
- **Editor:** both fields for each film.

### D2. Incidents and rows (P3d-2)

- **`==text==`** is an inline highlight mark in both inline grammars (the page's
  `inlineMarkdown` and the crawler's `inlineMarkdownHtml`), added as a new last
  alternative so the existing groups keep their numbers. It is a real `<mark>`
  (`fp-mark` on the page): the emphasis is not carried by colour alone; the
  design's ink-highlight band; `Mark`/`MarkText` in forced colours.
- **Incidents under `head: 'split'`:** the renderer lays the split out itself
  (`fp-incidents__split`): the heading in the first column; the lede, the list
  and the closing note in the second. (Not `display: contents` on the
  `<header>`, which drops its semantics in some browsers.) Without split the
  layout is unchanged.
- **Incident glyphs** are amber tiles (`--color-warning` tint, warning-text
  glyph: these are things that went wrong); a **`card`** icon slug (credit
  card); the **closing note** reads at lede size (`fp-incidents__note`).
- **Rows `diagram`** (closed-world, rows only): up to eight boxes (label
  required, text optional), at most ONE `waiting` (a later flag is dropped), a
  caption; fewer than two boxes is no diagram. It is a `<figure>` with an
  ordered list on a dark card (the inverse tokens, dark in both themes); the
  waiting step is ringed in `--color-warning` and says it waits in its own
  label. With a diagram the head and the diagram take the side column and the
  toggles panel moves to the top of the rows. It reaches the crawler (an
  ordered list in a figure) and the markdown export; the editor gets diagram
  fields; strings in four locales.

### D3. Form card and small fields (P3d-3)

- **Form card:** a 576px card at the end of the full shell (36px in, 24px under
  900px, a 24px radius), the design's fields inside it (50px, 1.5px edge, 12px
  radius, 16px text, an accent focus ring), only the first two short fields
  sharing a row (name and email), and an optional `note` under the form. The
  note is kept on the card layout and carried by overlays (which name no
  layout); it reaches the crawler and the markdown export.
- **Column call to action, reused, not added.** This ADR first proposed a column
  `link: { label, href }`. f2's #5660 (P3b, price cards) landed first with a
  per-column `ctaLabel`/`ctaUrl`, validated on every column and already rendered
  by the crawler and the markdown export. A second field for the same idea would
  be duplicate schema, so P3d-3 **draws `ctaLabel`/`ctaUrl` as a visible action
  line** ("For agencies →", a decorative arrow) in the panels and cards layouts,
  while the pricing list keeps drawing it as a button. A card with one is not
  also a whole-card link, so links never nest.
- **Small fields:** an `arrow` icon slug; `headSize: 'sm'` beside `head` (the
  design's 30→44px section-head clamp, a 760px measure); a board lane's own
  `text` under its title (the roadmap's proof line).
- **Split FAQ picture** (security, David via 1e): under `head: 'split'` the FAQ's
  `imageToken` sits under the heading in the first column and the questions take
  the second column across both rows. Auto-placement used to put the picture in
  the second column and push the questions down. Wide screens only; phones stay
  one column.
- **Board text** (RDM-09, David's decision): a lane's `text` renders under its
  title; the lane counts stay the items' count (8/5/4 live), untouched.
- **Correction (2026-11-07):** `link` was never shipped; see above.

## Alternatives

- **Put the chip copy in `title`.** Rejected: `title` names the film for screen
  readers and the VideoObject; "Watch the tour" is not a film's name.
- **Scroll every marquee at rest.** Rejected: a sideways scroller hides items
  off-screen; for a list of names, wrapping shows everything.
- **A myndhyve-only chip in brand.css.** Rejected for the layout: the one-line
  chip is the site default for every white-label site. Only the disc colours
  are brand tokens.

## Phases

| Phase | Scope | PR | Status |
|---|---|---|---|
| P3d-1 | D1 films | #5661 (f234f4708) | implemented |
| P3d-2 | D2 incidents + rows diagram + highlight mark | #5665 (c9b3d0dca) | implemented |
| P3d-3 | D3 form card + small fields + split FAQ picture | this PR | implemented |

## Open questions

- The design's ripple runs forever; ours runs twice (4.4 s), under the WCAG 2.2.2
  five-second bar, so it needs no pause control. Kept.
