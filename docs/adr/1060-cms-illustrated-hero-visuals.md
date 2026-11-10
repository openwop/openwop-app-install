# ADR 1060 — CMS illustrated hero visuals

Status: implemented (2026-11-04: P1–P7 on `feat/adr-1058-hero-visuals`; see § Implementation record).

**Renumbered 1058 → 1059 → 1060 (2026-11-04).** This record was drafted under the number 1058; #5583
(bounded refine loopback) claimed 1058 in an open PR while these phases landed, so
this record moved to 1059 before its own PR opened; #5585 then added
`1059-interrupt-resolved-via-token-resolutions.md` first, so it moved again to 1060. The P1–P7 commit subjects below cite
the old number (pushed history is not rewritten); they implement THIS record, not
`1058-bounded-refine-loopback.md`.
Builds on ADR 1029 D5 (activity card), ADR 1038 (motion vocabulary, D8 flow) and
ADR 1047 (hub hero).

## Context

A marketing site's inner pages (pricing, agencies, comparison, a feature, the
templates, security, the roadmap) each want a hero picture that says the page's
point at a glance: a receipt with nothing hidden on it, the same app with
three clients' names, loose tools against one product, one document fanning
out into three, a phone collecting the overnight work, a wall between two
workspaces, three numbers that add up to the roadmap. The hero today offers a
fixed schematic, an image, and four data-driven cards (plan, activity, hub,
flow). An image of words fails translation, crawlers and screen readers; none
of the cards draws these pictures.

## Decision

Seven new hero visuals, each CLOSED, bounded, brand-neutral content drawn
from CMS fields, in the activity card's grid beside the copy (under it below
900px). One declarative spec per visual (`backend/typescript/src/features/
cms/heroArt.ts`) drives the validator, and its byte-for-byte mirror
(`frontend/react/src/features/cms/heroArtSpec.ts`) drives the editor fields
and the renderer's caps; a test deep-compares the two.

### Shared rules

- **Closed keys.** Only the keys the spec names survive, at every depth.
  Every string is scrubbed and capped like its neighbours (`cleanContent`).
  No links, media or colour strings: an accent is a token NAME from a closed
  set, mapped to a theme token by the stylesheet.
- **Refusal, not truncation, over a cap.** A list longer than its cap is a
  typed `400 validation_error` naming the field and the cap
  (`receipt.lines: at most 8 items…`), on the base layer and on a locale
  overlay alike, as ADR 1038 D8 refuses a seventh flow step. A styling enum
  outside its set is dropped (the stock look), as everywhere in ADR 0920.
- **Autosave-safe lists.** A list item is kept even when empty, so the
  editor's autosave round trip never wipes a row being written (the ADR 1038
  P8 lesson). Renderers and crawlers show only complete items; each visual
  shows only when it has enough to draw (stated per visual below).
- **Content, with presentation from the base.** The visuals are content: an
  overlay carries them and replaces each whole (RFC 0103 §C). A list item's
  presentation keys (`state`, `accent`, `fill`, `members`; `ITEM_BASE_KEYS`)
  follow the base on every write (ADR 1038 D8's `restoreItemStates`, widened),
  so a model translating values never turns `success` into `succès`. The editor
  offers those fields on the base layer only.
- **Real text.** Each visual is a `<figure>` named by its authored `label`
  caption (≤ 160, read aloud, not shown) or a stock name. Every word inside is
  real, inert text; what looks like a button or chip is a styled span.
  Drawing (slots, wires, marks, bars, walls) is `aria-hidden`.
- **Crawlers.** `publishing/heroArtText.ts` writes each visual's words once,
  in reading order, for both the prerendered `<figure>` and the markdown
  export, only while the hero shows that visual (ADR 0593 §C9).
- **Motion.** CSS only, behind the ADR 1038 guard
  (`@media screen and (prefers-reduced-motion: no-preference)`,
  `:root:not([data-reduce-motion="reduce"])`, and section `motion: 'none'`
  opts out). Outside it nothing is hidden or moved: print, reduced motion and
  no-animation browsers show the finished picture. A visual that loops for
  longer than five seconds carries a visible pause button, and hover or
  keyboard focus pause it too (WCAG 2.2.2, the ADR 1029 marquee's pattern).
- **Layout.** Logical properties only, so RTL mirrors; no fixed width wider
  than a phone, so a 390px viewport never scrolls sideways. Forced colours
  keep the drawn parts that carry structure.

### D1 — `receipt` (pricing)

A receipt prints out of a slot and a stamp lands on it.

| Key | Shape | Limit |
|---|---|---|
| `label` | text, the figure's accessible name | 160 |
| `title`, `subtitle` | text | 40, 80 |
| `lines` | list of `{ label, amount, state? }`, `state ∈ highlight` | 8 lines; label 60, amount 40 |
| `totalLabel`, `totalAmount` | text | 40 each |
| `stamp` | text | 60 |

Shows with at least one line that has both a label and an amount. Lines are a
description list. A highlighted line changes only its amount's colour; the
words carry the meaning. Motion: the paper prints out once (2.8s), the stamp
lands at 3.2s; done before five seconds, so no pause button.

### D2 — `apps` (agencies)

The same app for several clients, taking turns: each its own name, web
address and accent bar, a heading and a few rows, with a badge beside them.

| Key | Shape | Limit |
|---|---|---|
| `label` | text, the figure's accessible name | 160 |
| `chip` | text | 40 |
| `items` | list of `{ name, address?, accent?, heading?, rows? }`, `accent ∈ info \| success \| ai` (theme-token names, shown as blue, green, purple; absent: the brand accent) | 3 apps; name 40, address 60, heading 60 |
| `items[].rows` | list of `{ text, status?, state? }`, `state ∈ done \| waiting` | 3 rows; text 80, status 30 |

Shows with at least one named app. `address` is display text, never a link.
The accent maps to `--color-info`, `--color-success`, `--color-ai` (or
`--clay-strong`) and paints only the top bar and the mark; text stays ink on
paper, so contrast never depends on the accent. A row's status is its words;
the state only tints the pill. Motion: two or three apps cross-fade in one
place, 4s each, looping; a pause button (shown only on the motion path),
hover and keyboard focus pause them. Still, the apps stack, each in full.

> **CORRECTED 2026-11-07 ([ADR 1066](1066-site-p3a-hero-visuals.md) AGEN-01, David's decision):** two or more apps no longer stack in full when still. They fan: the first card in front, in full, and each later card raised behind it so its bar shows. Every card stays in the DOM as text.


### D3 — `versus` (compare)

Loose, tangled tools against one clean set, with a divider between.

| Key | Shape | Limit |
|---|---|---|
| `label` | text, the figure's accessible name | 160 |
| `divider` | text, shown between the sides (e.g. "vs") | 8 |
| `before`, `after` | `{ label?, items }`, `items` a list of `{ label }` | 6 items a side; label 60, item 30 |

Shows with at least one labelled item on each side. A wide picture: it sits
under the hero copy, not beside it; the sides stack below 900px. "Before"
items are chips scattered over drawn wires (one failing, in
`--color-danger`); "after" items are tiles with a success dot. Both sides are
real lists; the wires are `aria-hidden` and mirror in RTL. Motion: the wires
crawl, the failing wire flickers and the chips jitter, looping, with the
pause button, hover and focus pause; the tiles snap in once.

### D4 — `fanout` (a campaign studio)

One source document, a dashed connector, and outputs fanning in from it,
each checked; the one that waits for a person gets a scan sweep.

| Key | Shape | Limit |
|---|---|---|
| `label` | text, the figure's accessible name | 160 |
| `source` | text, the source document's title | 40 |
| `outputs` | list of `{ title, check?, status?, state? }`, `state ∈ done \| waiting` | 3 outputs; each string 40 |

Shows with a source and at least one titled output. `check` is the words
beside a decorative meter; `status` is the output's own word (`waiting`
colours it with the attention token, `done` with success and fills the
meter). Motion: on a 7s loop the outputs fan in from the source (the offset
mirrors in RTL), the meters fill from the inline start and the waiting
output's sweep passes over it; the pause button, hover and focus pause it.

### D5 — `phone` (templates)

A phone's lock screen: the time and day, notifications arriving one by one,
and a last one that waits for the reader with two choices.

| Key | Shape | Limit |
|---|---|---|
| `label` | text, the figure's accessible name | 160 |
| `time`, `day` | text, the clock and the line under it | 12, 40 |
| `notes` | list of `{ title?, time?, text }` | 4 notifications; title 40, time 20, text 160 |
| `reply` | `{ title?, time?, text, primary?, secondary? }` | title 40, time 20, text 160, each choice 20 |

Shows with at least one notification that has text, or a reply with text.
The notifications and the reply are one ordered list; the two choices are
inert spans, never buttons. The phone body and screen use the inverse tone
tokens; the reply is a paper card. Motion: the notifications arrive 1.2s
apart and clear on a 12s loop, pausable by button, hover and focus.

### D6 — `wall` (security)

Two workspaces side by side with a striped wall and a lock between them; a
document runs at the wall and bounces back.

| Key | Shape | Limit |
|---|---|---|
| `label` | text, the figure's accessible name | 160 |
| `spaces` | list of `{ title, members?, docs? }`, `members` a whole count of person dots | 2 workspaces; title 40, members 0–6 |
| `spaces[].docs` | list of `{ label }` | 4 documents; label 40 |

Shows with both workspaces named. Titles and documents are real lists; the
member dots, wall, lock and bouncing document are `aria-hidden` (the caption
says what the wall means). `members` is presentation: a whole number,
clamped to 6, base-layer only. Motion: the document bounces off the wall on a
3s loop (mirrored in RTL), pausable by button, hover and focus.

### D7 — `tally` (roadmap)

Big numbers on cards, each with what it counts and a bar.

| Key | Shape | Limit |
|---|---|---|
| `label` | text, the figure's accessible name | 160 |
| `items` | list of `{ value, label, fill?, state? }`, `fill` a 0–1 fraction (absent: full), `state ∈ done \| partial \| none` | 4 cards; value 12, label 40 |

Shows with at least one card that has a value and a label. A wide picture
under the hero copy. The number and label are real text; the bar is
decoration, its fill presentation (base-layer only, restored from the base on
overlay writes); the state colours the label and bar (success, warning,
neutral) beside words that say it. Motion: each bar grows once from the
inline start, 120ms apart (mirrored in RTL); no loop, so no pause button.

## Consequences

- Seven inner-page heroes become CMS content: translatable, crawlable,
  readable, themeable, with no image of words.
- One spec engine instead of seven hand-written cleaners; a new visual is a
  spec entry, a renderer, its CSS and its crawler reader.
- Tests: `backend/typescript/test/adr1060-hero-art.test.ts` (spec parity,
  per-visual acceptance, closed keys, caps, refusals, overlays, crawler
  order) and `frontend/react/src/features/cms/__tests__/heroArt.test.tsx`
  (structure, accessible names, editor, the CSS motion, static, RTL, width
  and forced-colours guards). Both sabotage-witnessed.

## Implementation record

| Phase | What | Commit |
| --- | --- | --- |
| P1 | spec engine (validator + mirrored spec), generic editor, crawler text, `receipt` | `34bfa17ca` |
| P2 | `apps`, the shared pause button, `accent` in `ITEM_BASE_KEYS` | `dc8c823ff` |
| P2 fix | accents named by theme token (`info`/`success`/`ai`), not colour keywords | `030a9c4f0` |
| P3 | `versus` (wide), a nested `label` is shown text in the editor | `427067686` |
| P4 | `fanout` | `caafb9ace` |
| P5 | `phone` | `9f9570a24` |
| P6 | `wall`, `members` in `ITEM_BASE_KEYS` | `72cdde846` |
| P7 | `tally` (wide), `fill` in `ITEM_BASE_KEYS` | `79cb53a50` |

Nothing in this record is owed. Not done here, by design: the custom-domain
`site-runtime/site.css` gets the crawler figures' plain styling only (as for
the hub and flow), not the drawn pictures.