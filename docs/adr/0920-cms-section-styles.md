# ADR 0920 — CMS section styles: tones, split heads, new column layouts, plan and chat visuals

Status: Accepted (user decision 2026-10-18, via the KickTodo distribution) — implementation in this PR

## Context

A white-label adopter (KickTodo) drew its homepage on a design canvas and then
published the same words through the CMS. The words landed; the look did not.
Measured section by section on 2026-10-18 (design rendered at 1440 px next to
the live page), every gap traced to a renderer limit, not to content:

| Design block | What the renderer could not express |
|---|---|
| Hero | a product picture (an example plan card) beside the copy; a note under the CTAs; a play icon on the second CTA |
| Problem | a tinted band behind the section; filled panels with a small drawing instead of an icon |
| Pillars | columns under a hairline rule, no card chrome |
| People | four compact cards across, a short badge, a dashed "not yet" card |
| Daily list | heading left, lede right; cards with a label line and a progress bar; a footnote |
| Collections | four titled lists, each row a name and a right-aligned length |
| Film | a dark band; split head |
| How it works | circled numerals |
| Guide | copy beside a conversation picture |
| FAQ | heading left, questions right, as ruled rows |
| Closing CTA | a brand-colour band, left aligned |

Headings already had emphasis (`*phrase*`, `headingEmphasis.tsx`), but its
style was hard-coded upright, so a brand could not set it italic.

These are presentation options any adopter can use. A KickTodo-only page was
rejected by the adopter: it would leave the CMS (no editing, no localization)
and fork an upstream file.

## Decision

All fields are **optional and additive**. A page that sets none of them renders
byte-identically to today. Section bodies stay CLOSED per type (ADR 0748): each
new field is validated in `buildSectionData`, unknown values are dropped, and
every string is bounded and scrubbed like its neighbours.

**Not wire-affecting.** `hero`, `columns`, `richText`, `cta`, `faq` and `video`
are host section types (ADR 0027); the protocol's open section body is `fields`
(ADR 0748, RFC 0206), which this ADR does not touch. No RFC is needed.

### D1 — Section tone

`tone: 'default' | 'muted' | 'inverse' | 'accent'` on `richText`, `cta`,
`columns`, `faq`, `video` and `quotes`. It paints a full-bleed band from tokens
only: `muted` = `--paper-2`; `inverse` = `--tone-inverse-bg` (a deep shade of
`--clay`); `accent` = `--clay-strong`. Each declares its own ink, rule and link
colours so text keeps ≥ 4.5:1 in light and dark. A brand overrides the tokens,
never the selectors.

### D2 — Split head

`head: 'stacked' | 'split'` on `columns`, `video`, `faq` and `richText`. Split
puts the heading (and eyebrow) left and the lede right on wide screens; for
`faq` the questions sit right of the heading. Below 900 px it stacks.

### D3 — Hero `visual: 'plan'`

A data-driven example card beside the copy, from a closed `plan` object:
`eyebrow, title, meta, progress (0..1), progressNote, stepEyebrow, stepTitle,
lines[] {label, text} (≤ 3), action, chips[] (≤ 5), note, initial, bubble`. Every
string ≤ 80 chars except `lines[].text` (≤ 160). Accessibility, agreed with the
openwop-app steward session:

- real text, never `aria-hidden`; the card is a `figure` named "Example plan"
  (`aria-label`, localized), and the `bubble` is folded into that name;
- `action` and `chips` are plain text styled as a button and chips, never
  interactive controls;
- progress is a `meter`-free bar plus the `progressNote` text: never colour alone;
- it stacks under the copy on a phone.

The hero also gains `note` (fine print under the CTAs, ≤ 200) and
`ctaIcon2: 'play'`.

### D4 — Column layouts and item fields

New `layout` values: `ruled`, `progress`, `list`, `tiles`, `panels`.
New item fields: `eyebrow` (≤ 80), `progress` (0..1), `badge` (≤ 40),
`future` (boolean), `art` (closed set: `full-week`, `feed`, `solo`), and
`items[] {label ≤ 120, meta ≤ 40}` (≤ 8, `list` only). Section field `note`
(≤ 280) renders a footnote under the grid. `steps` gains `numbers: 'circle'`.

### D5 — `richText` `visual: 'chat'`

A conversation picture beside the copy (split): `chat { title, subtitle, badge,
messages[] {from: 'person' | 'guide', text} (≤ 6), proposal {label, text,
accept, decline}, placeholder }`. Same rules as D3: real text, inert, a `figure`
named by `title`.

### D6 — Emphasis and CTA alignment

`.fp-em` reads `--fp-em-style` (default `normal`, so stock is unchanged).
`cta` gains `align: 'center' | 'start'`.

Links (`safeLink`, every CTA) also accept a **same-page fragment**,
`#` + `[A-Za-z][A-Za-z0-9_-]{0,79}`, so a hero button can jump to the film
section's heading anchor (headings carry stable `headingSlug` ids). A fragment
cannot leave the page, so it adds no open-redirect shape.

### D7 — Crawler and markdown parity

`sectionHtml.ts` (prerender) and `sectionMarkdown.ts` (export) render every new
text field, so a crawler reads what a person reads (ADR 0593 §C9's
crawler = human rule). Tones, heads and art are presentation and add nothing
there.

## Alternatives weighed

- **An adopter-only homepage component.** Rejected: leaves the CMS, forks an
  upstream file, loses localization.
- **Raw HTML or CSS in sections.** Rejected: ADR 0009 (no stored markup).
- **Image uploads for the plan card and chat.** Rejected as the default: text in
  an image is unreadable to screen readers and crawlers and cannot be localized.
  `image` stays available for real artwork.

## Phases

- **P1 (this PR):** D1–D7, renderer and validation, unit tests, editor
  round-trip (unknown-to-the-editor fields are preserved, not stripped).
- **P2:** editor controls for the new fields in `SectionsEditor`.
