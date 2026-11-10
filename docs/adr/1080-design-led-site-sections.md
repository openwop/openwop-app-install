# ADR 1080 — Design-led site sections and the decision simulator

Status: Accepted (2026-11-09). D1–D16 are implemented in the PR that records them.

Follows [ADR 1072](1072-site-p3c1-steps-gallery.md), [ADR 1074](1074-site-p3c3-richtext-image.md)
and [ADR 1062](1062-public-site-chrome-featured-card-cta-split.md). Host CMS rendering only,
so no wire RFC is involved.

## Context

A white-label deployment for residential interior design firms measured its live site against
its design canvas. Most of the header, footer and call-to-action gaps it found are already closed
on main by ADRs 1049, 1056 and 1062. The rest need section capabilities the CMS does not have:

- a table whose rows end in a status word (an order log, a lock board);
- interactive explainers: a date calculator, a sample conversation the reader steps through, a
  feature index, a decision tree runner and a schedule simulator;
- photo heroes laid out three more ways, and a list ("queue") beside the hero copy;
- a card picture beside richText copy, and the picture on the copy's start side;
- edge-to-edge galleries with a short tag over the caption;
- a photo beside the form card, and the form button's own words;
- more than 12 cards in one section.

Two further gaps apply to every install: the Blog link shows even when nothing has been
posted, and a photo hero hides its picture on phones.

## Decision

Every decision is additive. A page that sets none of the new fields renders exactly as before.

| ID | Decision | Shape |
|---|---|---|
| D1 | `statusTable` section | `columns` (≤6), `rows` (≤24) of `cells` plus a `status` word and `tone` (`ok`, `warn`, `bad`, `muted`). A tone is kept only with its word, so color never stands alone. Optional `label` |
| D2 | `dateCalc` section | `needDate` (ISO day), `leadWeeks`, `floatDays`, `approveDays` (integers 0–520), optional labels, `unknownText` and `note`. Fixed UTC arithmetic. A missing value shows no date |
| D3 | `conversation` section | `exchanges` (≤8) of `q`, `a`, `refs` (≤6) and `gate`. Optional `title` and `subtitle` |
| D4 | `featureIndex` section | `groups` (≤24) of `name`, `key`, `lede` and `items` (≤16) of `label` and `id`. Every group is in the DOM; the picker only changes which shows |
| D5 | richText `side: 'start'` | Puts the picture before the copy on wide screens. The DOM order, copy first, is unchanged |
| D6 | hero `placement`: `band`, `card` or `panel` | For a photo hero (`visual: 'image'`). `band` runs the photo full width above the copy. `card` is a rounded photo beside the copy. `panel` is an inverse band with the photo filling half |
| D7 | hero `visual: 'queue'` | `queue`: `title`, `label`, `rows` (≤6) of `id`, `title`, `meta`, `status`, `tone`, and `note`. It sits in the plan-card grid |
| D8 | richText `visual: 'card'` | `card`: `title` (required), `eyebrow`, `body`, `note`, an optional picture (`imageToken` requires `alt`) and up to two `actions`, guarded by `safeLink` |
| D9 | `columns` gallery `bleed` and per-card `tag` | `bleed: true` runs the pictures edge to edge, with no gutter or corners. `tag` is a short mono label over the caption |
| D11 | `columns` cap from 12 to 16 | |
| D12 | form card `imageToken` + `alt`, and `submitLabel` | A photo under the copy, beside the card. `submitLabel` (≤40) replaces "Submit" on that embed |
| D13 | Blog link only when posts exist | The same one-read probe as Docs. A failed read hides the link |
| D14 | Photo hero keeps its picture on phones | Below 720 px the picture stacks under the copy instead of hiding |
| D15 | `decisionTree` section | `trees` (≤16) of `title`, `question`, `evidence` and `nodes` (≤16) of `id`, `text` and `options` (≤6) of `label` with `next` or `outcome`. An option whose `next` names no node in its tree is a 400. The runner keeps the path, and has Back and Start over |
| D16 | `scheduleSim` section | `milestones` (≤24) of `id`, `label`, `startWeek`, `weeks`, `floatDays`, `rework` and `items`. `decisions` (≤80) of `title`, `milestone`, `kind` (`selection`, `approval`, `payment`, `response`), `owner`, `note`, `options` (≤4) of `label` and `delayDays`, and optionally `id`, `element`, `decider`, `choices` (≤5), `leadDays` or `leadUnknown`, `lockWeek`, `dependsOn` (≤6 decision ids), `risk` and `source`. `presets` (≤6) of `label`, `description` and `rules` (≤6) of `delayDays` with optional `kind`, `decider` and `minLeadDays`. Optional `startDate`, `finishLabel` and `note`. A decision naming no milestone, or depending on a decision id the section lacks, is a 400 |

D10 was folded into D4 during review.

### D16 arithmetic

All arithmetic is in whole days from the project start, fixed and deterministic.

- **Decide-by:** a decision's lock day (`lockWeek` × 7, else its milestone's start), plus the slip
  so far, less its lead time and five approval days. A decision with `leadUnknown` gets no date
  and is never counted late.
- **Made:** the decide-by plus the decision's own delay, or a later prerequisite's made day. A
  decision held up by a prerequisite names it as "waiting on".
- **Milestones:** each takes the latest lateness among its decisions. Its float absorbs what it
  can, and the rest slips that milestone and every one after it. The finish moves by the sum of
  the slips. A milestone shows "float absorbed it" when it absorbed a delay, and its `rework`
  text when the delay went through.

The section has two modes over that model.

- **Run the project:** a clock steps through the weeks (play, pause, one week at a time, at 1×,
  2× or 4×). Decisions come due in a queue, each with its element, decider, decide-by date, lead
  time and real choices. An unanswered decision accrues lateness a day at a time until the reader
  decides.
- **What if:** apply a preset (its largest matching rule sets each decision's delay), or set how
  late each decision comes in.

In either mode, a weekly carrying cost the reader enters turns the slip into a cost of delay.
Bars animate to their new dates unless reduced motion is set.

### Every surface

- **Crawlers and no-JS readers:** the prerendered HTML carries every row, answer, tree outcome
  and milestone (`designSectionHtml`).
- **Markdown and shared links:** `designSectionMarkdown`.
- **Page Builder:** the new types edit as JSON (`DesignJsonFields`), because their content is
  nested. The server validates the JSON on save like any other section.
- **Media:** `collectMediaTokens` now also records pictures nested in gallery columns, the
  richText card and the form person. Before this, a gallery picture was missing from the media
  "used by" graph.

## Alternatives considered

- **A separate `gallery` section type.** Rejected. ADR 1063's `columns` gallery already exists,
  and two galleries would drift. D9 extends it.
- **Price cards.** Not needed. ADR 1069's `unit`, `ctaLabel` and `highlight` cover them.
- **A form-builder editor for D15 and D16.** Deferred. JSON with server validation is enough
  for the first adopter. A visual editor can replace `DesignJsonFields` later without a data
  change.

## Verification

- `backend/typescript/test/adr1080-design-sections.test.ts`
- `frontend/react/src/features/cms/__tests__/designSections.test.tsx`
- The ADR 0384 and markdown coverage fixtures gain the six types.
