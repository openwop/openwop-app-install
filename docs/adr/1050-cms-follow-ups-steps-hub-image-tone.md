# ADR 1050 — CMS follow-ups: steps that fit their count, the hub in RTL, image tone

Status: implemented (2026-11-03, D1–D5; see § Implementation record). Follows ADR 1047 (the hub hero) and ADR 1038
(motion); stacked on #5553 (ADR 1038 P2–P8).

## Context

Five small defects and gaps, found on the MyndHyve features page and in the
ADR 1047 review, none large enough for its own record:

1. A `columns` section with layout `steps` lays its items out with
   `repeat(auto-fit, minmax(220px, 1fr))`. Two to four steps fit one row of the
   1140px shell; five do not, so the fifth sits alone on a second row
   (myndhyve.ai/p/features, circle numbers).
2. The ADR 1047 hub places its centre and its places with
   `inset-inline-start` plus a physical `translate(-50%, -50%)`, while the SVG
   spokes are drawn in physical x. On an RTL page the inline offset flips and the
   translate does not, so the centre and every place sit off their spoke ends.
3. The hub's spokes draw with `pathLength="100"` and a dash of 100. The journey
   hero, the only other drawn path, uses `pathLength="1"` and a dash of 1.
4. The frontend checks the hero `visual` against a hand-written `||` chain, a
   copy of the server's `HERO_VISUALS` that no test compares.
5. `image` is the only section with a body that cannot take a `tone` band (ADR
   0920 D1), so a screenshot cannot sit on the muted or inverse band that the
   sections around it use. The editor also has no tone control at all (ADR 0920
   P2 named one and it never landed), so tones were authored only through the API.

## Decision

### D1 — Steps fit their count

A steps section with five or six items gets a count class, `fp-steps--n5` or
`fp-steps--n6` (literal class names, like the bento's `--wide`, so the class
gates can see them). From 600px those lay out three columns (5 → 3 + 2, 6 →
3 + 3); from 1024px (the `canvas` breakpoint, the widest in the governed
vocabulary) one row of five or six, with the number above the title so a
narrow column keeps its text width. Below 600px the base rule applies, one
column on a phone. Two to four items keep their exact markup: auto-fit already
gives them one row. Seven or more keep auto-fit too (a longer process is a
`timeline`, ADR 1038 open question 2).

### D2 — The hub is drawn in physical coordinates

The hub's geometry is physical throughout: the centre is `left: 50%; top: 50%`,
each place `left: var(--hub-x); top: var(--hub-y)`, both with the physical
`translate(-50%, -50%)`, and the SVG is in the same physical 0–100 space. The
renderer writes each place's `--hub-x`/`--hub-y` from the same point as its
spoke's `x2`/`y2`, so they agree by construction.

On an RTL page (`:root[dir="rtl"]`, the flow connector's precedent) the whole
picture mirrors: the SVG is flipped with `scaleX(-1)` and each place moves to
`left: calc(100% - var(--hub-x))`. Places still start at the top; they run
clockwise in LTR and anticlockwise in RTL, so the second place is always on
the side the reader moves towards. The text inside each place stays in the
page's direction. Fully logical geometry was rejected: SVG has no logical
coordinates, so it would still need a mirror rule, and the translate would need
one too.

### D3 — The spokes draw on `pathLength="1"`

Each spoke carries `pathLength="1"`; the draw sets `stroke-dasharray: 1` and
animates `stroke-dashoffset` from 1 to 0, the journey path's idiom. #5553
defines no shared draw keyframe (no `fp-draw`), so the hub keeps its own
`fp-hub-draw`. The guards are unchanged: screen, no-preference, the in-app
setting and section `motion: 'none'`; reduced motion, print and forced colours
show the finished lines.

### D4 — One list of hero visuals

The frontend exports `HERO_VISUALS` from `sectionStyles.tsx` in the server's
order (it includes `hub` and `flow`), and `resolveHeroVisual` reads it.
`adr1029-mirror-parity.test.ts` compares it with `cmsService.ts`'s list, the way
it already compares motions, emphases and states.

### D5 — `image` takes a tone

`image` accepts `tone` with the same values and the same cleaner as the other
toned sections (`SECTION_TONES` through the shared `tone()` helper: known values
kept, anything else dropped). The renderer adds the same `fp-tone fp-tone--*`
classes from `sectionStyleClass`, so the band is identical. The crawler HTML and
the markdown export add nothing for it (ADR 0920 D7: tones are presentation), so
a toned image prerenders byte-identically to an untoned one. An absent tone
renders exactly as today.

The editor gains one tone control, on the base layer of every section type that
takes a tone (`richText`, `cta`, `columns`, `faq`, `quotes`, `video` and now
`image`): "Default" removes the key, like the motion control. Its labels are in
all four cms locales.

## Wire

Not wire-affecting: a field on a host section type and renderer CSS (ADR 0027),
the same class as ADR 0920's tones. No RFC.

## Carry

MyndHyve's `scripts/lib/sections.mjs` should learn `tone` on `image` in the next
carry; the CSS and renderer changes ride the usual byte-identical blobs.

## Consequences

- A five-step process reads as one row on a desktop and a 3 + 2 grid on a
  tablet; nothing scrolls sideways at 390px.
- The hub lines up in both directions; the RTL rule is the only direction rule
  in the hub CSS.
- A drifted hero visual list now fails a test instead of silently rendering a
  known visual as the default art.
- Tests: `frontend/react/src/features/cms/__tests__/cmsFollowUps1050.test.tsx`
  (steps classes, hub geometry in LTR and RTL, the spoke draw contract, image
  tone render, the tone control) and
  `backend/typescript/test/adr1050-image-tone.test.ts` (validation, overlay,
  crawler and markdown parity), plus the new mirror-parity case.

## Implementation record

| Decision | What | Commit |
| --- | --- | --- |
| D4 | the exported `HERO_VISUALS`, pinned to the server's list | `ee749b363` |
| D1–D3 | steps count classes, the hub's physical geometry and RTL mirror, `pathLength="1"` | `410f17836` |
| D5 | `image` tone (validator, renderer), the editor's tone control, i18n ×4, the `TONED_TYPES` pin | `6d045bf89` |

Nothing in this record is owed. The MyndHyve carry (`sections.mjs` learning
`tone` on `image`) is MyndHyve's, as for every CMS change.
