# ADR 1038 — CMS motion vocabulary: the MyndHyve redesign's animations as core options

Status: Accepted (David, 2026-11-03, in openwop-app-d3's session: "Proceed with your
recommendations. Make a comprehensive plan for updating the CMS to support the
MyndHyve animations built into the core for all future pages."). Builds on ADR 1029;
answers its open question 1 (tilt, counter, sheen) for counters and declines the rest.

## Context

The "MyndHyve Site Redesign" design canvas (2026-11-03) animates its pages with
about twenty effects. ADR 1029 already ships some of them as closed CMS options:
the scroll reveals, the item stagger, the marquee and the bento grid. The rest live
only in the design's hand-written CSS, so a page built in the CMS cannot have them,
and MyndHyve would have to fork its renderer to get them.

David asked for these to be **core**: options every future public page can choose,
not MyndHyve code. ADR 1029's rules still hold, and every option here keeps them:

- closed enums on existing section types, no stored markup or CSS (ADR 0009, 0920);
- CSS only, no JavaScript on public pages for motion (D3);
- the final state is the content: reduced motion (the OS setting AND the in-app
  setting, ADR 0363 P4), print, and browsers without the feature show the finished
  state, never a hidden one;
- nothing moves automatically for more than five seconds without a pause control
  (WCAG 2.2.2); a finite animation that ends is the default answer;
- crawlers get the same words (the semantic prerender, ADR 1030, and `sectionHtml`).

### The inventory

| # | In the design | Core today? | Decision |
|---|---|---|---|
| 1 | Hero "launch" card: rows tick to done, a counter counts 0→5, a progress bar fills, a "live" row lands; a 12-second loop | `activity` card, still | **Build P1**, play once |
| 2 | A struck-through word in the hero title (`.strike`), drawn on load | `*word*` emphasis, still | **Build P2**, an emphasis style |
| 3 | Numbers counting up (the "130", stats) | `stats` layout, still | **Build P3**, count up once |
| 4 | Progress bars filling (app cards, launch card) | `progress` layout, still | **Build P4**, fill once |
| 5 | A "waiting" dot pulsing; the gate ring on the workflow diagram | none | **Build P5**, three pulses then still |
| 6 | Sideways and zoom reveals (`rv-l`, `rv-r`, `rv-z`) | `reveal`, `rise` only | **Build P6**, new `motion` values |
| 7 | Hover: buttons and cards lift, film image zooms | button lift only | **Build P7**, a brand hover preset |
| 8 | Workflow diagram: path, nodes lighting in turn, a gate that waits | stock OpenWOP diagram only | **Build P8**, an authored `flow` visual that draws once |
| 9 | Scroll reveals, stagger, marquee, bento | yes (ADR 1029) | Author them; no work |
| 10 | Infinite loops with no pause: the 12 s hero loop, the feeding "sheets", the drifting chips, the floating cards, the blinking LED, the play-button ripple | — | **Not built** (WCAG 2.2.2; each is played once instead where it carries meaning: 1, 5, 8) |
| 11 | Tilt on hover (`rotate(-.4deg)`) | — | **Not built** (vestibular trigger, no content) |
| 12 | Light sweep across buttons ("sheen") | — | **Not built** (decoration; MyndHyve's earlier guidance) |
| 13 | The working on/off switches section | — | **Not built** here: an interactive demo needs script; a page can embed a real product screenshot or video instead |

## Decision

Eight additive phases, each its own PR, each carried to MyndHyve the usual way
(byte-identical blobs pinned in `myndhyve/scripts/check-boundaries.mjs` `CARRIED`,
a `myndhyve/docs/upgrades.md` row; `myndhyve/scripts/lib/sections.mjs` learns any
new enum or field). Priority is MyndHyve's homepage order: hero first.

### D1 — hero `play: 'once'` (P1)

The hero gains an optional `play` (`'still' | 'once'`, absent = still) and its
`activity` card an optional `result` line (≤ 80, scrubbed like the rows).

> **CORRECTED during P1 build:** `play` was first a key inside `activity`. A locale
> overlay replaces `activity` whole (RFC 0103 §C, a normative shallow merge), so an
> overlay written before P1 would silently stop the card playing on translated
> pages, and changing `play` would have marked every translation outdated. It is a
> hero-level presentation field instead, base layer only like ADR 1029's `motion`.
> It applies to the `activity` card today; the `plan` and `run` cards may adopt it.

- With `once`, the rows rise in as today, then each row's state mark and status
  word pop in one after another (a `--i` index per row; the step is a token,
  `--tick-step`). A header counter shows how many rows ended `done` or `approved`,
  a thin bar fills to that share, and the `result` line lands last. The whole
  sequence is under four seconds and runs once on page load.
- The counter's text is real DOM text ("4 of 5 done", translated). While the card
  plays, that digit is drawn transparent and a `counter()` overlay counts up to it
  from a registered `@property` integer; the overlay is a `::after` with empty alternative text (`content: counter(fp-n) / ""`), which keeps it out of the accessibility tree. A screen
  reader, a copy-paste and every no-animation path read the real digit.
- The final state is today's still card plus the counter, bar and result.
  Reduced motion, print (rules are `screen` only) and the in-app setting show it at
  once.
- Crawlers: `sectionHtml` and `sectionMarkdown` emit the `result` line as text. The
  counter is omitted there, because the crawler renderer has no translations (the
  ADR 1029 D5 correction) and the rows already state each status.

### D2 — Heading emphasis styles (P2)

`*phrase*` in a hero heading already renders `<em>` (SPA and crawler,
`headingEmphasis.ts`). A hero gains `emphasis?: 'accent' | 'strike' | 'underline' |
'highlight'` (absent = `accent`, today's look). `strike`, `underline` and `highlight`
draw their line or wash once on load, left to right in the writing direction
(`scaleX` from the inline start, so RTL draws right to left). The emphasized words
stay real text in `<em>`; the line is a pseudo-element, so a screen reader reads the
sentence unchanged. A struck word is styled, not deleted: `<em>`, not `<del>`,
because the sentence still says it ("The business is taking months").

> **CORRECTED after P2's review (recorded by the grading pass):** the line is a
> background gradient on the `<em>` (`box-decoration-break: clone`, so a mark that
> wraps draws on each line), not a pseudo-element. And `strike` renders
> `<em><s>…</s></em>` in the SPA and the crawler and `~~…~~` in markdown: a
> struck word is still read aloud, but `<s>` carries the "no longer accurate"
> meaning where assistive tech exposes it, which a style alone never did. The
> editor hint asks authors to write the heading so it reads true with the line
> ignored. Marks print (`print-color-adjust: exact`) and fall back to
> text-decoration in forced colours.

### D3 — Count-up stats (P3)

The `stats` layout gains `count?: true` on the section. A stat counts up only when
its title is a whole number with an optional prefix and suffix (`130`, `$4`, `98%`,
`10k+`, digits ≤ 9); anything else stays still. The parser lives in one module shared
by the validator, the SPA and the crawler. The visible value is real text; the
counting digits are an overlay kept out of the accessibility tree (D1) that ends on the same number, driven by
the section's view timeline (scroll-driven, D3 of ADR 1029), so it counts once as
the stats arrive and is finished wherever the feature is missing.

> **CORRECTED before P3 (architect review):** the count is scroll-linked, like every
> ADR 1029 view-timeline motion: it runs backwards when the reader scrolls back up
> and holds wherever scrolling stops inside its range. Each stat binds to its own
> value's named view timeline (`--fp-stat`), so that range is about the height of
> the number. The overlay and the transparent digit live inside
> `@supports (animation-timeline: view())`; everywhere else the real number shows.
> Leading zeros (`007`) stay still. Only the SPA uses the parser, so it is one
> frontend file, not a mirror: the validator keeps `count` by layout, and the
> crawler and custom-domain stylesheet show the plain title. P3 also gives the
> stats crawler the heading and lede it was missing. The P1 counter keyframe is
> renamed `fp-count` and shared.

> **CORRECTED after the P3 code and UX reviews:** the count runs unless the section's
> motion is `none` (the page default counts too), on each stat's own timeline (the
> figure and its label) rather than the number's, so it is visible and still
> always finishes by the end of a page. Only the digit's paint is hidden
> (`-webkit-text-fill-color`), so the overlay keeps the figure's colour; it uses
> tabular figures; it is off in forced colours, where the repainted digit showed
> through ("87" over "130" read "870"), and so is P1's counter. The figure is
> never bidi-isolated (that moved `$`/`%` to the other side on an RTL page). The
> parser accepts one space after the prefix and a five-character suffix (`R$ 4`,
> `98 %`, `10 mil+`).

### D4 — Progress fill (P4)

Bars in the `progress` layout, and the P1 card's bar, fill from zero to their value
once as they enter view (`scaleX`, view timeline). No new field: a `progress`
section whose `motion` is set fills; absent motion keeps today's static bar.

> **CORRECTED before P4 (architect review):** the P1 card's bar already fills on load
> (P1), so P4 covers only the `progress` layout. "Motion set" means a motion other
> than `none`, the ADR 1029 timeline-rail precedent. Because `.fp-progress` clips
> with `overflow: hidden` (a scroll container), the fill uses a named timeline
> declared on `.fp-progress`, not `view()`. The bar stays decorative
> (`aria-hidden`); no progressbar role is added. The P1 fill keyframe is renamed
> `fp-fill` and shared.

> **CORRECTED after the P4 code and UX reviews:** the bar's own 6px range was over
> in one wheel tick, so nobody saw it move. The timeline is the card's
> (`.fp-col`), so the bar fills as the card enters and always finishes. And a
> progress section fills unless its motion is `none`, the same rule as the stats
> count; requiring a set motion left the page default static with no hint why.

### D5 — Attention marks (P5)

A mark that means "waiting for a person" (the activity card's `waiting` and
`flagged` states, the run card's waiting row, the P8 gate node) pulses three times
after it appears, then stays still. One shared keyframe and one class,
`fp-attention`, reusing the app's `openwop-attention` timing (finite iteration
count, never `infinite`). Colour is never the only signal: the status word is there.
The pulse colour is a token, `--attention`, defaulting to `--color-warning`, so a
distribution whose brand forbids amber (MyndHyve's brand test) overrides it.

> **CORRECTED during P5 review:** the ring is a new keyframe (`fp-attention`, a
> box-shadow ring), not the app's opacity `openwop-attention`; the run card's
> waiting pill moved onto it, so one meaning moves one way. A flagged row rings in
> `--color-danger`. `--attention` is a stylesheet token a distribution sets in its
> `brand.css`, not a `BrandTheme` field. Each ring lasts 2.7s (0.9s × 3); in a
> six-row played card the last ring ends about 5.5s after load, each piece of
> motion under five seconds on its own (WCAG 2.2.2).

### D6 — Directional reveals (P6)

The section `motion` enum gains `slide-start`, `slide-end` and `zoom`. They follow
ADR 1029 D3 to the letter (view timeline, `entry 0%`–`entry 100%`, never hidden
before entry, reduced motion still). Directions are logical, so `slide-start` comes
from the reading start in both LTR and RTL. Travel and scale are tokens
(`--slide-distance`, `--zoom-from`) that the D6 brand presets set, and `subtle`
sets travel to zero.

### D7 — Brand hover preset (P7)

`BrandTheme.hover?: 'none' | 'lift'` (absent = `none` for stock brands, so no
existing site changes). `lift` raises public-page cards and buttons a few pixels and
zooms media inside a linked card slightly, on `:hover` and `:focus-visible` alike, as
transitions (no keyframes), off under reduced motion. Tokens `--hover-lift` and
`--hover-zoom`, generated like the D6 motion preset of ADR 1029, identical in light
and dark. Per distribution today; per site with ADR 1030 P2's site brand.

> **CORRECTED before P7 (architect review):** public cards ALREADY lift 3px on
> hover and primary buttons 1px (`.fp-card:hover`, `.fp-btn--primary:hover`), so
> a `hover: 'none' | 'lift'` field defaulting to `none` would have REMOVED an
> effect from every existing site, and added a second setting beside the motion
> preset (open question 1 decided against that). P7 instead makes the lift a
> token, `--hover-lift` (3px, today's value), carried by the existing motion
> preset (`lively` 5px, `subtle` 0); gives a linked card the same lift on
> `:focus-visible` as on hover (keyboard parity); and makes the in-app "Reduce
> motion" setting stop the lift, which only the OS setting did. Media zoom inside
> a linked card waits for ADR 1037's column images, which add the markup it needs.
>
> **P7 review:** the lift uses the `translate` property, not `transform`, because a
> `stagger` reveal holds `transform` (fill-mode both) and silently cancelled the
> lift on every staggered card grid. The showcase and prompt cards moved onto the
> token too (the prompt card at two thirds). The primary button's 1px press stays
> outside the token (a different, smaller scale) and still lifts under `subtle`;
> both reduced-motion signals stop it. A pointer resting in a card's bottom edge
> can make it bounce at 5px (`lively`), as it could at 3px; accepted.

> **CORRECTED 2026-11-04 (recommendation after research):** only a card that is
> a link lifts (`.fp-card--link`, on hover and keyboard focus). A lift on a card
> that does nothing promises a click it cannot keep, which design guidance treats
> as a misleading affordance; a non-link card stays flat.

### D8 — An authored `flow` visual (P8)

A new hero visual and a new `columns` layout value, `flow`: up to six nodes, each a
`label` (≤ 24), `text` (≤ 60) and a closed `state` (`idle | done | waiting`), laid
out on a fixed two-row grid with a connecting path. On entry the path draws once
from the first node to the last, nodes light in order, and a `waiting` node gets the
D5 attention mark. It is a `figure` with an authored accessible name and an ordered
list of the nodes as its real content, so the diagram is a styled list rather than
an image. The crawler gets the ordered list. The stock OpenWOP `workflow` visual is
unchanged.

> **CORRECTED before P8 (architect review):** nodes carry an authored `status` word
> beside `state` (colour and shape are never the only signal), and caps are label
> ≤ 40 and text ≤ 120, matching ADR 1047's hub. The state is `idle | done |
> waiting`, each a distinct mark shape (dashed, filled, ring with a dot). There
> is no two-row grid: the hero and narrow screens use a vertical rail, and a
> `columns` flow is one row of up to six from 900px; the connectors are CSS
> segments per step, so DOM order is visual order. Only the hero's waiting step
> pulses; a `columns` flow below the fold shows the still ring. A columns item's
> `status` and `state` are kept on any layout (ADR 1047's precedent: an overlay
> may not name a layout); a base write with more than six `flow` items is a typed
> 400, not a silent cut. AI translation now puts each list item's `state` back
> from the base by index (`restoreItemStates`), because a model translated the
> enum and the cleaner dropped it, which also affected P1's activity rows and ADR
> 1047's tags. The keyframes are shared: `fp-activity-tick` for the marks,
> `fp-rail`/`fp-fill` for the connectors, `fp-attention` for the hero's pulse.

## Architect review (2026-11-03, before P1)

Track A only (no wire). Findings and what changed:

1. **Boundaries:** every phase extends an existing section type, the brand theme
   generator or the ADR 1029 motion classes. No second renderer, no new section
   type, no new store. Pass.
2. **D1 mechanics (HIGH, fixed above):** "rows start neutral" would duplicate every
   `state` style as a neutral variant. The card now plays its mark and status, and
   the counter keeps the real digit in the DOM with the counting overlay
   `aria-hidden`, so no path ever exposes a mid-count number.
3. **Crawler parity (HIGH, fixed above):** a translated counter cannot reach the
   crawler, which has no translations; it is omitted there, the rows carry the facts.
4. **Shared parser (D3, MEDIUM):** backend and frontend are separate packages, so
   "one module" means a mirrored file with a byte-equal test, the
   `headingEmphasis` precedent, not a cross-package import.
5. **Sequencing against ADR 1037 (MEDIUM):** myndhyve-f0's column-media work
   touches the columns paths in `cmsService`, `SectionRenderer` and `sectionHtml`.
   P3, P4 and P8 (columns layouts) land after it and rebase onto it. P1, P2, P5,
   P6 and P7 do not touch those paths. MyndHyve's priority after that is P8, P3.
6. **Carry budget (MEDIUM):** MyndHyve's entry chunk has about 300 B of headroom.
   A hero cannot be lazy-loaded (it is the first paint), so each phase keeps its
   JavaScript to a few lines and puts the motion in CSS; the carry may need its
   budget raised, which is MyndHyve's call.
7. **D7 (LOW):** the primary button already lifts on hover for everyone
   (`.fp-btn--primary:hover`). `hover: 'none'` keeps that; `lift` adds cards and
   media. No existing site changes.
8. **D6 carry:** the new `motion` values must join `ADR1029.motions` in
   `myndhyve/scripts/lib/sections.mjs` in the same carry.

## Alternatives weighed

- **Port the design's CSS as a MyndHyve-only stylesheet.** Rejected by the request:
  core, not MyndHyve. It would also bypass the editor, the crawler, i18n and the
  reduced-motion rules that a CMS option gets for free.
- **Keep the 12-second loop with a pause button** (the marquee precedent). Rejected
  for the hero: a hero card is content, read once; a loop makes a reader wait for the
  frame they want. The marquee is a strip of names where motion is the point.
- **IntersectionObserver for count-up and play-once.** Rejected for the same reason
  as ADR 1029: script on every public page, and the usual implementation hides
  content until it fires. Page-load animation (P1, P2) and view timelines (P3, P4,
  P6, P8) cover it.
- **A free-form `animation` field.** Rejected: stored CSS (ADR 0009).

## Wire

Not wire-affecting: fields on host section types and on the host brand theme (ADR
0027, ADR 0171), the same class as ADR 1029's `motion`. No RFC.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P1 | D1 activity play-once card + `result` (validator, renderer, editor, i18n ×4, crawler) | built (#5524) |
| P2 | D2 hero emphasis styles | built |
| P3 | D3 count-up stats + the number parser; also the stats crawler's missing heading and lede (ADR 0762) | built |
| P4 | D4 progress fill | built |
| P5 | D5 attention marks | built |
| P6 | D6 directional reveals | built |
| P7 | D7 hover lift as a preset token, focus parity, in-app reduced motion (corrected) | built |
| P8 | D8 authored `flow` visual (hero and columns), plus the translated-state restore | built |

Each phase: `/architect` before, `/code-review` and `/ux-review` after, all fixes
applied, `npm run ci` green, merged through the release manager; then the MyndHyve
carry, which myndhyve-f0 owns. One grading pass (`/grade-code`, `/grade-ux`,
`/grade-workflows`, `/grade-data`) closes the program.

## Open questions

1. Whether the hover preset should also be a per-site choice before ADR 1030 P2's
   site brand ships everywhere. **Decided (recommendation, 2026-11-03): no.** It
   rides the brand; ADR 1030 P2's site brand already makes it per site on custom
   domains, so a second per-site switch would be a parallel setting.
2. Whether `flow` should accept more than six nodes. **Decided: no.** Six fit one
   row at desktop width (the vertical rail on a phone takes any number, but the
   row does not); a longer process is a `timeline`, which already scrolls and
   reads as an ordered list. *(Reworded after P8: the two-row grid it first cited
   was dropped by the D8 correction.)*
3. (Raised 2026-11-03) Custom HTML/CSS/JS pasted into sections. **Out of scope
   here**; recommended as its own ADR: an `embed` section whose code runs in a
   sandboxed, opaque-origin iframe (never in the page), and no raw page CSS for
   tenants.
