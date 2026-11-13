# ADR 1105 — Site sections: party views, stage chart and two worksheets

Status: implemented (2026-11-11): P1 #5784, P2 #5787, P3 #5785. Target v0.14.0.

Extends [ADR 1080](1080-design-led-site-sections.md), whose touchpoints, posture and tests these
four types reuse. Requested in #5779 (part A) by a white-label adopter (CasaVoga ADR CV-0185),
which built them locally so its site is not blocked and will move to these and delete its own at
the re-pin that carries them. Host CMS rendering only, so no wire RFC is involved.

## Context

A design studio's public site needed four section types the CMS does not have:

- a switch between the parties on a project (a builder, a client, an architect), with what each
  needs and a sample of what each sees;
- a column chart of counts by stage (when a catalog's decisions lock), grouped and totalled;
- a pricing worksheet: cost and markup to price and gross margin;
- an allowance worksheet: a budget per line beside the expected spend, and the total overrun.

None is specific to interior design: an agency has parties, a pipeline has stages, and any
services business prices with markup and tracks budget lines. The adopter's local shapes
(`casavoga/backend/typescript/src/features/cms/extraSections.ts`) are the starting proposal.
This ADR keeps them where they are sound and changes them where they are not (D5, D6, D8).

## Decision

Every decision is additive. A page that uses none of the new types renders exactly as before.
All four take the usual `eyebrow`, `heading`, `lede` and `tone`.

| ID | Decision | Shape |
|---|---|---|
| D1 | `partyViews` section | `parties` (1–4) of `label` (required), `needsLabel`, `needs` (≤6 strings), `viewTitle`, `viewLabel`, `rows` (≤8) of `title` (required), `meta`, `status` and `tone` (`ok`, `warn`, `bad`, `muted`), and `note`. A tone is kept only with its status word, so color never stands alone (ADR 1080 D1). Optional `initial` (a party index, default 0) |
| D2 | `stageChart` section | `groups` (≤4) of `key` and `label`; `stages` (1–14) of `label` (required), `count` (an integer 0–1,000,000, required) and `group` (a group key). A stage naming a group the section lacks is a 400, not a silent drop. Optional `unit` (the noun counted, ≤40, e.g. "decisions") and `note` |
| D3 | `marginCalc` section | Optional `cost` (0–1,000,000,000), `markup` (percent, 0–1000) and `target` (gross-margin percent, 0–99), each a starting value the reader edits. Optional `currency` (a code `strictCurrencyExponent` knows, `host/currencyUnits.ts`; anything else is dropped), per-field labels (`costLabel`, `markupLabel`, `targetLabel`) and `note`. A sibling of `dateCalc` |
| D4 | `allowanceGap` section | `lines` (1–12) of `name` (required), `allowance` and `specified` (0–1,000,000,000), each a starting value the reader edits. Optional `currency`, `label`, per-column labels (`allowanceLabel`, `specifiedLabel`) and `note` |
| D5 | Numbers are the base's | Counts, money and percentages are data, not copy. An overlay replaces a nested list whole (RFC 0103 §C), so dropping a number from an overlay's list would delete it in that locale. Two rules instead. **Item keys:** `count`, `allowance`, `specified` and `group` join `ITEM_BASE_KEYS` (`heroArt.ts`), so `restoreItemStates`, the ADR 1038 write-time pass every lane already runs, copies them from the base by position. This also makes the columns stat-tile `count` (ADR 1063) follow the base, the same class of fix; no CMS validator has a prose field by those names. **Top-level fields:** `cost`, `markup`, `target`, `currency` and `initial` are dropped in a partial, as ADR 1080 D18 does for `scheduleSim` |
| D6 | Crawlers get the worked answer | The adopter's prerender of `marginCalc` emitted only the note. Here both worksheets prerender their starting figures and the computed result, the same pure functions the renderer uses, run on the validated numbers (D7). A crawler or no-JS reader sees "Cost 4,000; markup 25%; price 5,000; margin 20%" rather than an empty form |
| D7 | Fixed arithmetic, shared | One pure module per half (the backend prerender needs it too). Both are run over one shared table of cases, so the copies cannot drift; the ADR 1029 mirror-parity test pins enums only and does not cover arithmetic: price = cost × (1 + markup/100); gross margin = (price − cost) / price; the markup that holds a target margin = target / (100 − target) × 100. A gap is `max(0, specified − allowance)` per line; the total adds the gaps only (a line under its allowance is not netted against one over), and says how many lines are over. A line or input missing a figure shows "No figure" and is left out of the total, never treated as 0 |
| D8 | Chart is a labelled list first | The chart renders as an ordered list of stages, each with its label and count as visible text, drawn as columns from 640px and as horizontal bars below. Groups are told apart by a label in the legend and by pattern as well as color, so color never stands alone. Group totals sit in the legend. Bar heights come from the counts in CSS (an inline custom property, the same inline-geometry carve-out as the scheduleSim tick position), with no chart library |
| D9 | Party switch is a tab list | `partyViews` uses the shared `ui/Tabs` primitive and `ui/rovingTabs` keyboard handling (ADR 0144; WAI-ARIA tabs, arrow keys, Home and End, one tab stop), never a hand-rolled tablist, with every party's panel in the DOM and the inactive ones `hidden`, so a no-JS reader and a crawler get them all (the ADR 1080 D4 rule). It works on the inverse tone |
| D10 | UI words are catalog strings | Column heads, "No figure", "Over by", the result labels and the explanation sentences are `cms` catalog keys in en, es, fr and pt-BR. Money and percentages format through `useFormat` (its currency and percent formatters) in the page locale; with no `currency` a figure is a plain number |
| D11 | Authored nav group headings (#5779 item 8, 2026-11-11) | A page's optional `siteNav.groupLabel` (≤40) names its `group` in the public menu and the grouped footer, in place of the stock heading. The first page in the group, by order then label, that sets it wins (the ADR 1056 `cta` rule), and one source feeds both. It needs `group` (else a 400) and applies in grouped mode only. Like every nav label it serves in the base language: the public nav list (`listPublicNav`) is not localized, an existing gap this does not widen. Unset keeps the catalog heading. Implemented in #5785 (P3) |

### Every surface

The ADR 1080 touchpoints, for each of the four types:

- **Validator:** `designSections.ts` `buildDesignSectionData`, closed fields and bounded plain
  text, `DESIGN_SECTION_TYPES` and the CMS closed-world sets.
- **Crawlers and no-JS readers:** `designSectionHtml` (D6, D9).
- **Markdown and shared links:** `designSectionMarkdown` and the sharing output.
- **Client:** the `cmsClient` section union and picker list, `SectionRenderer`, the
  `SectionPicker` sketch, and `DesignJsonFields` in the Page Builder (the types edit as JSON,
  validated on save).
- **Drift gates:** the ADR 0384 section-HTML and section-markdown fixtures gain all four types.
- **Lists:** every `list-style: none` list carries `role="list"` (DESIGN.md §11, `listRoleRatchet`).
- **Bundle:** the renderers live in `DesignSections.tsx`, the public-page chunk that already
  carries `ProjectSimulator`, never the entry chunk (about 320 B of headroom);
  `check-bundle-budget` proves it in each phase.

## Alternatives considered

- **Keep the four types in the adopter.** Rejected by the adopter and here: each white-label site
  that wants a worksheet would build its own, and the copies would drift (the reason ADR 1080
  exists).
- **A generic chart section (bar, line, pie) on a chart library.** Rejected for now. One chart
  with a fixed, accessible form covers the request, and a library would grow the public bundle.
  A general chart type can come later and absorb `stageChart` data unchanged.
- **One `worksheet` type with a formula field.** Rejected. Author-supplied formulas would be code
  in page JSON; the closed-world rule allows fixed arithmetic only.
- **Net lines under an allowance against lines over.** Rejected (D7). A saving on tile does not
  pay for a plumbing overrun the client has to approve, and netting hides the line that needs
  the conversation.

> **CORRECTED 2026-11-11 (P1, #5784): D7's parity mechanism.** There is no shared
> case-table file. `test/adr1105-worksheets.test.ts` (backend) imports both
> `worksheetMath.ts` modules, the frontend one by relative path as
> `adr1060-hero-art.test.ts` does, and runs both over one inline case table. The
> Verification line that names `test/fixtures/adr1105-worksheet-cases.json` is
> superseded by this.

> **CORRECTED 2026-11-11 (P2 pre-phase architect pass, #5787): D9 does not use
> `ui/Tabs`.** `ui/Tabs` is the app-chrome tablist: `.tabs` editorial CSS and one
> shared `panelId` for every tab. Keeping every party's panel in the DOM would
> have meant extending it for one consumer, and the CMS family would then carry
> two picker shapes. `partyViews` follows the ADR 1080 D4 `featureIndex` picker
> instead: a labelled group of `aria-pressed` buttons, each `aria-controls` its
> own panel, every panel in the DOM and the others `hidden`. A party's sample
> view reuses the hero queue card. D9's other promises (keyboard reachable,
> every panel to crawlers, works on the inverse tone) stand.
>
> **D8 breakpoint (P2 UX review):** columns start at 900px, not 640px. Fourteen
> stages at 640px left a count breaking over three lines; inside a column the
> unit is visually hidden (the legend carries it).

## Architect review (2026-11-11)

Track A; no wire surface. Applied before acceptance: D5 rewritten (dropping overlay numbers
would have deleted them per locale, since overlays replace lists whole), D9 reuses `ui/Tabs`,
currency validated by the host's ISO 4217 table, and the bundle placement made explicit.

## Implementation

Three PRs, so each stays reviewable and gates on its own (P3 added for #5779 item 8):

| Phase | What |
|---|---|
| P1 | `marginCalc` and `allowanceGap`: the shared arithmetic (D7) with tests, validators, prerender with the worked answer, markdown, renderers, catalogs, editor and fixtures |
| P2 | `partyViews` and `stageChart`: validators, prerender, markdown, the tab list and the chart, catalogs, editor and fixtures |
| P3 | D11 `siteNav.groupLabel`: validator, the public shell's `readNav` allowlist and group headings (#5785) |

Each phase gets an /architect pass before it starts and /code-review and /ux-review after, and
every new test is sabotage-witnessed. After P2 the adopter re-pins and deletes its local types.

## Open questions

- [ ] Does the adopter want `initial` on `partyViews`, or always the first party? (Default: the
  field is optional and the first party opens.)
- [ ] Should `stageChart` accept a `highlight` stage? Not requested; left out until asked.

## Verification (planned)

- `backend/typescript/test/adr1105-site-sections.test.ts`: closed validators, the overlay rule
  (D5: a translated `stages` or `lines` list keeps the base's numbers, and a top-level figure in
  an overlay is dropped), the dangling-group 400, and the prerender's worked answers.
- The ADR 1038 overlay tests gain the new `ITEM_BASE_KEYS`, including the columns stat-tile
  `count`.
- `frontend/react/src/features/cms/__tests__/siteWorksheets.test.tsx` and
  `partyViewsStageChart.test.tsx`: the arithmetic edge cases (empty, zero cost, 0 and 99 target,
  lines under and over), keyboard tabs, and the chart's visible labels.
- One shared case table (`test/fixtures/adr1105-worksheet-cases.json`, read by both halves' tests) holds the arithmetic in parity.
