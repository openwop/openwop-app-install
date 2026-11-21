# ADR 1130 — Film series

Status: Proposed (2026-11-15). Planning only. Part of ADR 1126, release 1 (user decision).

## Context

Marketers publish recurring films: "one decision a week" (CasaVoga's example, from its decision
register), weekly tips, monthly customer stories. DeckTalk has a series mechanism
(`P/series.mjs`, `B/seriesTemplates.ts`) in production. Upstream has no series concept for film.
It does have the ADR 0311 kanban work-intake pattern (stacks) and chain packs that can be stacked.

## Decision

### D1 — A series is a template plus an ordered episode list

`FilmSeries` (`DurableCollection`, tenant + org scoped):
`{seriesId, orgId, briefId, name, template:{starterId?, themeRef, beatSkeleton, formats,
voiceId?}, cadence?:{every:'week'|'month', on}, episodes:[{episode, productionId, topic,
status}]}`.

An episode is an ordinary FilmProduction (ADR 1126) with `seriesId` and `episode` set. It inherits
the template, then diverges freely. A series never edits an approved episode.

### D2 — Cadence as a kanban stack, never a hard-coded scheduler

A series with a cadence is a **stack**: each upcoming episode is a todo card that enqueues the
`film.series-episode` chain with the series, the episode number and its topic. Topics come from a
list the person maintains on the series, for example rows of an adopter's decision register,
imported as data. The cadence creates the next card. It does **not** auto-approve or auto-export:
every episode goes through the same review gate.

### D3 — Continuity

- **Shared voice and theme:** episodes share the series voice and theme, so narration with
  identical text reuses receipts (ADR 1128 D5).
- **Intro and outro:** a series may define intro and outro beats, saved in the scene library
  (ADR 1129) and inserted into every episode.
- **Numbering:** episode numbers are stable. A deleted draft leaves a gap rather than renumbering.

### D4 — Batch series: produce every episode up front (KickTodo review)

Some series are produced whole, not on a cadence. KickTodo makes one film per challenge day:
7–56 days, about 177 in its first wave.
- **Produce all now:** `film.series-batch` runs `film.series-episode` over every topic with bounded
  concurrency (an operator setting, default 3). It is sized against the render meter (ADR 1127 D5)
  before it starts, and refused typed if the batch would exceed the allowance.
- **One review gate per stage, per batch:** script for all episodes, then narration for all, then
  renders for all. The reviewer sees every episode in one gate and can reject individual episodes,
  which return to that stage while the rest continue. Per-episode gates stay the default for a
  cadence series.
- **Topics as owner data:** the topic list comes from a `FilmSourceRef` resolver (ADR 1126 D2), for
  example a published challenge version's activities. When the owner publishes a new version, the
  series re-derives its episode list. Unchanged days reuse their narration and renders through
  ADR 1128 D5 receipts (same `inputHash`), so only changed days re-narrate and re-render.

## Phases

| Phase | Scope |
|---|---|
| S0 | FilmSeries store + REST + series view in the Film tab; manual "new episode" |
| S1 | `film.series-episode` chain; template inheritance; shared intro/outro |
| S2 | Cadence as a kanban stack (ADR 0311) + topic list import |
| S3 | Batch series: `film.series-batch`, bounded concurrency, per-stage batch gates, re-derivation on a new source version with receipt reuse |

## Alternatives weighed

- **A scheduler daemon that starts episodes.** Rejected: the CLAUDE.md doctrine says workflows are
  chains or stacks, and a stack keeps each episode visible and editable before it runs.

## RFC verdict

**Host extension, no RFC.**

## Open questions

1. Whether a series spans personas (one episode per persona per cadence tick) or is per persona.
   The assumption is per persona.
