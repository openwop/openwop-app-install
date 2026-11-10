# ADR 1063 — Site sections P2: dark-mode band rhythm, two-column FAQ, incidents

Status: Accepted (2026-11-05). P2a (D1–D3) shipped in #5601 (7d5516c47); P2b
(D4) and P2c (D5) in #5602 (b3c19d4d4); P2d (D6) in #5605 (0cf06aeb1); P2e (D7) in the PR
that records it. P2 is then complete.

Follows [ADR 1062](1062-public-site-chrome-featured-card-cta-split.md) (P1 of
myndhyve-1e's MyndHyve redesign brief, owner-approved 2026-11-05). This is P2:
shared section variants. Host CMS rendering only; no wire RFC is involved.

## Context

The redesign keeps the page's band rhythm (light, mist and navy sections), and
adds a two-column FAQ, an incident timeline, a film card, a roadmap board, a
bento count-up tile and a screenshot gallery. The site owner made two
decisions that bind this work:

1. **Dark mode stays**, and keeps the band rhythm the design gets from
   alternating light, mist and navy. Today every band turns the same dark.
2. Content stays in the CMS; nothing MyndHyve-specific is hard-coded into the
   white-label shell.

The three bands already exist as the ADR 1050 `tone` field: `default`
(`--paper`), `muted` (`--paper-2`) and `inverse` (`--tone-inverse-bg`, clay at
25% lightness). In light mode the inverse band is far darker than the page. In
dark mode the same derivation lands close to the dark `--paper`, so the three
bands read as one.

## Decision

**D1 — Dark-mode band rhythm.** Under both the system dark scheme
(`:root:not(.theme-light)`) and the manual `theme-dark` class:
- `--tone-inverse-bg` is `color-mix(in oklab, var(--paper) 58%, black)`, darker
  than the page;
- `--tone-inverse-panel` is `--paper-2`.

So default (paper), muted (paper-2) and inverse (darker than paper) stay three
distinct steps on any brand. A brand tunes the steps through its existing dark
`--paper` / `--paper-2` / `--rule` overrides (ADR 0171 themeable tokens). The
owner's proposed values (paper `#111A26`, mist `#162130`, lines `#2A394B`)
are MyndHyve brand overrides, set in its app brand, not in shared CSS. With
paper `#111A26` the derived navy band is about `#0A0F16`, the proposed
`#0A1019`.

**D2 — FAQ.** `faq` gains three optional fields:
- `columns: 2` (any other value is dropped) sets the questions in two columns
  on wide screens, with a `+` marker that rotates to `×` when open;
- `openFirst: true` opens the first answer;
- `imageToken` + `alt` (required when a picture is set) + optional `frameUrl`
  render a picture under the head. This follows the columns picture rule and
  reuses `ColumnShot`.

The default FAQ is unchanged.

**D3 — Incidents.** A new `columns` layout `incidents`: timestamped events as
stacked cards, each with an icon (`icon`), the time (`eyebrow`, in mono), an
optional `title`, and one sentence (`text`). It is an ordered list, because the
order is the order things happened, and the HTML prerender and markdown export
lead each item with its time, as for `timeline`. The existing `timeline`
layout is not restyled, because other pages (About) use its rail as is. The
section editor's layout picker lists `incidents`, and its time field shows for
it. Without that, a page saved from the editor would silently switch layouts.

**D4 — Film card (P2b).** `video` gains `chip: "corner"` (any other value is
dropped). The play control becomes a bottom-left chip: an accent disc, the
film's title and its mono `length`. The poster eases to 1.04 on hover. The
disc's ripple runs twice (2 × 2.2 s = 4.4 s), under the WCAG 2.2.2
five-second bar, so it needs no pause control. Reduced motion drops the
ripple and the hover scale. The accessible name keeps the action ("Watch the
video: <title> <length>"), and the title leaves the visible caption so it is
not read twice; a YouTube link stays there. The section's chip applies to
`film2` too.

**D5 — Bento count-up and dark tile (P2c).** A `columns` item gains `count`
(an integer 0–9,999,999; anything else is dropped) and `tone: "inverse"`.
- **Count:** in `bento` it leads the tile as a headline number. `CountUp`
  starts at the final value, so the prerender, reduced motion and browsers
  without IntersectionObserver show the real number, never 0. With motion
  it counts 0 → N once, over 2.6 s, when the tile is half in view, and ends
  on N. Screen readers read the final number once, because the counting
  copy is aria-hidden.
- **Dark tile:** an inverse tile carries `fp-tone--inverse`, so it follows
  the D1 band tokens in both themes.

> **CORRECTED 2026-11-05 (P2d).** The count-up described above was a second
> mechanism. ADR 1038 D3 already counts stats up, in CSS (`StatValue` plus the
> `.fp-stats .fp-count` rules on a view timeline), with the real digits kept in
> the DOM. #5602 added a JS `CountUp` beside it, under the same `fp-count`
> class name. It did no visible harm, because the CSS is scoped to
> `.fp-stats`, but the app is meant to have one count-up. P2d deletes
> `CountUp`. The bento tile now renders through `StatValue`, and its rules sit
> beside the stats rules inside the same `@supports` / reduced-motion /
> forced-colours guards, with the stats rules left byte-identical. Behaviour
> changes as follows:
> - the count is now scroll-linked (it finishes as the tile enters), not a
>   timed 2.6 s run;
> - it shows the plain number wherever scroll timelines are unsupported.

**D6 — Board and stats bars (P2d).** A `columns` layout `board`: one lane per
column, as a heading and a list.
- **Status:** from the same `future` / `partial` flags as a status list (no
  flag = works), shown by a dot beside the lane title. The title states the
  status in words, so colour is never the only signal.
- **Count:** the lane's count is derived from its labelled items, never
  authored, so it cannot disagree with the list.
- **Items:** cards, with `meta` as a small note.

In `stats`, a figure with `progress` gets a bar under its label, marked with
the same status flags. A figure without `progress` keeps its original `dt` +
`dd` markup. The editor's layout picker lists `board`.

**D7 — Gallery (P2e).** A `columns` layout `gallery`: each column with a
picture becomes a figure, made of the screenshot (browser-framed when the
column has a `frameUrl`, through the shared `ColumnShot`) and a caption from
its `title` and `text`. A column without a picture is skipped, because a
gallery item is its picture. Every picture still needs its alt text, by the
existing columns rule. `highlight` makes a proof card that leads with the
screenshot. A gallery of one spans the row. The editor's layout picker lists
`gallery`.


## Alternatives considered

- **Shipping the owner's hex values as dark-mode defaults.** Rejected: they
  are one brand's colours, and every white-label site would inherit them.
- **Restyling `timeline` as incident cards.** Rejected: it changes every
  existing timeline, including pages meant to stay as they are.
- **A rotating `+` on every FAQ.** Rejected for now: it changes other sites'
  FAQs. The marker comes with `columns: 2`, the variant the design uses.

## Tests

- `backend/typescript/test/adr1063-faq-incidents.test.ts`: the FAQ keeps,
  drops and refuses its new fields; `incidents` is accepted and prerenders as
  an ordered list led by its times.
- `frontend/react/src/features/cms/__tests__/faqIncidentsTones.test.tsx`:
  both dark selectors carry the band override; the FAQ's two-column class,
  first-only `openFirst` and picture; the incidents cards, time first.
  Sabotage-witnessed: falling through to cards, or opening every answer,
  turns a case red.

- `backend/typescript/test/adr1063-film-bento.test.ts`: `chip`, `count` and
  `tone` are kept or dropped by the validator.
- `frontend/react/src/features/cms/__tests__/filmCornerChip.test.tsx`: the chip
  content, the accessible name, no duplicated title, `film2`, and a bounded
  ripple.
- `frontend/react/src/features/cms/__tests__/bentoCountInverse.test.tsx`: the
  real number at rest, no observer under reduced motion, a 0 → N run ending on
  N with a static spoken copy, and the inverse class. Sabotage-witnessed: a
  count that starts at 0 turns all three cases red.

- P2d: `boardStatsBars.test.tsx` covers lanes, status, derived counts, cards,
  status bars and the unchanged plain stats markup. `bentoCountInverse` now
  pins the bento count through `StatValue`, with no second count-up. The
  existing `statCount` guard now checks that EVERY line hiding the digit sits
  inside the three guards (it used to require exactly one). It is
  sabotage-witnessed: an unguarded line turns it red.

- P2e: `galleryLayout.test.tsx` covers the figures, captions, frame, the
  skipped picture-less column, the proof card and the single-shot span.
  Sabotage-witnessed: rendering picture-less columns turns it red. The
  `adr1063-faq-incidents` gallery cases check that the layout is accepted and
  that alt text is still required.

## Open questions

- The FAQ picture is not in the HTML prerender (the Q/A and the FAQPage JSON-LD
  are). Add it if the picture carries meaning a crawler needs.
- Section-editor controls for `columns`, `openFirst` and the FAQ picture:
  API only for now, like the rest of the newer section fields.
