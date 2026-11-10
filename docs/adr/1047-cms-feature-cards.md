# ADR 1047 — CMS feature cards and the hub hero

Status: implemented (2026-11-03, #5536: D1 + D2 below; see § Implementation record).
Stacked on ADR 1037 (#5523): feature cards reuse its column picture fields.

## Context

A capabilities page lists several places a product works (team chat, the phone,
the terminal…), each with what it does, the problem it solves, what ships today
and what is still rolling out, and a longer "how you use it". The existing
`columns` layouts hold a title and a line each, so such a page fell back to one
long `richText` section per place: walls of prose with the availability buried
in sentences. Its hero also had no way to show "one agent, many places".

## Decision

Two additions, both closed, bounded and brand-neutral (tokens only). Absent
fields render exactly as before.

### D1 — `columns` layout `features`

A two-column grid of cards (one column below 900px). Per item, all optional
except what each layout already requires:

| Field | Shape | Cap |
|---|---|---|
| `eyebrow`, `title`, `text` | as today; `title` keeps heading emphasis (`*…*`) | as today |
| `imageToken`, `alt`, `frameUrl` | ADR 1037; drawn at the card top in a dark media box | ADR 1037 |
| `callout` | `{ label?, text }` — dropped without `text` | label 80, text 280 |
| `tags` | `[{ label, state? }]`, `state ∈ now \| soon` — a pill without a label is dropped | 6 pills, label 60 |
| `more` | `{ label?, text }` — a native `<details>`; dropped without `text` | label 120, text 2000 (markdown) |

The section may carry `tagLegend: { now?, soon? }` (each ≤ 40): the words a
state means. They render as a legend over the grid and are read with each pill
(screen-reader text). A pill's `state` is a styling enum only: the renderer never
prints a fixed "Now"/"Soon" word, so the meaning is always authored, localizable
text. The state is also a shape cue (filled dot vs ring), so it is never carried
by colour alone (WCAG 1.4.1).

### D2 — hero visual `hub`

`hub: { center: { label, eyebrow?, imageToken?, alt? }, spokes: [{ label, index?, icon? }] }`,
2–8 spokes, each string ≤ 40 (`index` ≤ 8). A centre picture always carries its
`alt` (refused otherwise, like ADR 1037). `icon` is a slug from the column icon
set; this ADR adds `users`, `phone`, `code`, `moon` and `device`. Fewer than two
places, or no centre label, drops the hub.

It renders as a `<figure>` whose accessible name lists the centre and every
place (real text, crawler = human, ADR 0593 §C9); the lines and glyphs are
`aria-hidden`. The spokes draw once and the places arrive once on load, on the
ADR-1038 motion guard (`@media screen and (prefers-reduced-motion: no-preference)`
plus `:root:not([data-reduce-motion="reduce"])`, and section `motion: 'none'`
opts out); reduced motion and print show the finished picture. Timing uses
`--dur-enter`, and each place staggers by ADR-1038's `--tick-step` (a
fifth of a tick, 80ms at the 360ms default).

**Boundary with ADR-1038 D8 `flow`.** `flow` is a directed graph with a gate
state. A hub is strictly radial: one centre, no edges between places, no state.
They stay separate visuals.

### Content and overlays

`callout`, `tags`, `more`, `tagLegend` and `hub` are content: a locale overlay
may carry them and is held to the same cleaners (`sanitizeSectionOverlay` runs
the base validator in partial mode). Overlays replace nested objects whole
(RFC 0103 §C).

### Crawlers

The prerender writes the hub as `<figure>` (centre picture with alt, a caption,
a list of places) and each feature card as its eyebrow, title (with `<em>`),
picture, lead, callout, the pills with their legend words, and the disclosure
written out in full. The markdown export carries the same text.

## Consequences

- A capabilities page can be one `features` section instead of eight prose
  sections, with availability visible at a glance.
- New renderer code lives in the CMS section chunk; no new runtime dependency.
- Tests: `backend/typescript/test/adr1047-cms-feature-cards.test.ts` (schema,
  caps, overlays, crawler parity) and
  `frontend/react/src/features/cms/__tests__/featureCards.test.tsx` (render,
  accessible names, legend words, editor). Both sabotage-witnessed.

## Implementation record

| Phase | What | Commit |
| --- | --- | --- |
| Schema + crawler | `columns` layout `features` and hero `visual: 'hub'`, validation caps, crawler output | `c743b3a7d` |
| Renderer, editor, CSS | feature cards and the hub hero in the SPA renderer, editor fields, tokens-only CSS | `5eb87625e` |
| Hub stagger | the hub draws on ADR-1038's `--tick-step` | `bd8c84caa` |

Nothing in this record is owed. The hub RTL, `pathLength="1"` and `HERO_VISUALS` follow-ups
are a separate change, not phases of this decision.
