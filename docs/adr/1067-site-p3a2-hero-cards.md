# ADR 1067 — Site design batch Phase 3a2: checklist card, log terminal, fan-out

Status: Accepted (2026-11-07). D1–D3 are implemented in the PR that records them.

Follows [ADR 1066](1066-site-p3a-hero-visuals.md) (Phase 3a1: hero placement
and body). This is part of Phase 3 of myndhyve-1e's myndhyve.ai design batch
(David approved the work), owned by f2. It is host CMS rendering only, so no
wire RFC is involved.

## Context

The gap analysis found three hero pictures off the design:

- **Contact, the log (CONTACT-02/03).** The design draws a terminal card
  (`.term`): a body darker than the band, a hairline edge, a title bar, 14px
  mono on 1.7, and one event per line.
  - **Live:** the stock card's background *was* the inverse band colour, so on
    an inverse hero the lines floated on the band.
  - **Live, phone width:** long rows wrapped and broke the columns.
- **Campaign Studio, the fan-out (CS-01).** In the design, the waiting output
  has no meter and an uppercase mono status with a dot; finished checks fill
  in the accent; the outputs sit well apart.
  - **Live:** green meters, a sentence-case status, and cards nearly touching.
- **Home, the activity card (HOME-05).** The design is a launch checklist: a
  browser bar with its address words, the title with a "5/5 done" count and a
  filling bar on top, then rows that each lead with an icon tile, a name over
  its detail, and an uppercase status pill.
  - **Live:** the ADR 1029 approval list, with the count at the foot (and only
    while playing) and a dot per row.

## Decision

### D1. The log card reads as a terminal on any band

- **Card:** its body is `color-mix(in oklab, var(--tone-inverse-bg) 45%,
  black)`, so it is darker than the inverse band it usually sits on. It has a
  hairline edge, a deep shadow, and a 38px title bar in the band tone.
- **Lines:** 14px mono on 1.7, one event per line (`white-space: nowrap`).
  A long detail is cut off visually (`text-overflow: ellipsis`) and stays real
  text.
- **Foot:** it fades into the card over its own padding (`mask-image`), which
  is decoration and covers no line.

### D2. The fan-out's waiting output is the loud one

- **Waiting status:** uppercase mono with a warning dot. The dot has a
  forced-colors fallback.
- **Finished check:** its meter fills in the accent (`--clay-strong`), not
  green. The status words say it passed.
- **Spacing:** the outputs sit `--space-6` apart.
- **Content, not code:** the waiting output has no meter, which follows when
  its `check` is left empty, since the meter belongs to the check line.
  "No status on done outputs" is content too.

### D3. `activity.style: 'checklist'`

- **Fields:** a closed enum (absent means the approval list, byte-identical);
  `barLabel` (≤ 80), the words in the browser bar; and a per-row `icon` slug
  from the column icon set. An unknown slug draws no tile, and the row keeps
  its dot.
- **Layout:** the same DOM classes as the approval list, so ADR 1038 D1's
  play-once timing still applies. The checklist puts the title and the tally
  on top and always shows the count; the rows stack the name over its detail.
- **Crawlers:** they read the bar's words first, then the title, the rows and
  the result, in the prerender and the markdown export.
- **Icons:** `SectionRenderer` passes the icon lookup in (`iconFor`), so
  `sectionStyles` does not import the renderer (no cycle).

## Alternatives

- **A separate `checklist` hero visual.** Rejected: it would duplicate the
  activity card's data shape, validator, prerender and play timing for what is
  a different look of the same content.
- **Hiding the waiting output's meter in CSS.** Rejected: it would hide the
  authored `check` words. Leaving `check` empty is the honest way to say
  "not checked yet".

## Implementation

| Phase | What | Where |
|---|---|---|
| D1 | terminal card, title bar, nowrap lines, foot fade | `global.css` (`.fp-log*`) |
| D2 | waiting status + dot (+ forced colors), accent meter, output spacing | `global.css` (`.fp-fanout*`) |
| D3 | `style`/`barLabel`/`icon` validator; checklist layout; icon lookup; prerender + markdown | `cmsService.ts`, `sectionStyles.tsx`, `SectionRenderer.tsx`, `sectionHtml.ts`, `sectionMarkdown.ts`, `global.css` |

Tests:
- `test/adr1067-activity-checklist.test.ts`
- `frontend/react/src/features/cms/__tests__/heroCardsP3a2.test.tsx`

Both are sabotage-witnessed (see the PR).

**Content for 1e after deploy and sync:**
- **Home:** `activity.style: 'checklist'`, a `barLabel`, a shorter `title`, and
  row `icon`s (lock, …) with actor = name and action = detail.
- **Campaign Studio:** clear `check` on the waiting output, and `status` on the
  done ones.
