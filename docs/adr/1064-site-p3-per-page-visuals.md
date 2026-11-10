# ADR 1064 — Site P3: per-page visuals and motion

Status: Accepted (2026-11-05). P3a (D1) shipped in #5606 (e4f93f0ae). P3b–P3f
(D2–D6) are implemented in the PR that records them. P3 is then complete.

Follows [ADR 1063](1063-site-sections-p2-dark-bands-faq-incidents.md) (P2 of
myndhyve-1e's MyndHyve redesign brief, owner-approved 2026-11-05). P3 is the
brief's per-page visuals and motion. It is host CMS rendering only, so no wire
RFC is involved.

## Context

myndhyve-1e ordered P3 by value:
1. design partners (the conversion page);
2. templates;
3. features;
4. contact;
5. agencies;
6. about.

Two rules hold for all of it:
- **Reduced motion:** the design's reduced-motion rule blanks anything whose
  base style is `opacity: 0`. Every such element needs a visible static end
  state.
- **Pause control:** a loop longer than 5 s gets the existing pause control
  (WCAG 2.2.2).

The site copy stays in the CMS, and the white-label shell gains variants, not
MyndHyve copy.

## Decision

**D1 — Form card (P3a, design partners).** The `form` section gains
`layout: 'card'`, `lede` and `person: { name?, note?, imageToken?, alt? }`.
The validator keeps `person` only on a card and only with a name or a note,
and a person picture requires alt text.
- **Layout:** the head and lede sit beside a card on wide screens and stack
  under 900px. The card holds the person block (avatar, name, and a note such
  as "Read by a person, not a bot") above the form.
- **Fields:** the form's fields stay the form's own. The section never copies
  them, so every field the form has today (Website and timing included) is
  kept.
- **Renderer:** `PublicFormRenderer` gains a `card` prop, off by default so
  every other embed is unchanged. It wraps each one-line field (text, email,
  number) so that consecutive ones pair two to a row on wide screens, with the
  order unchanged. The success state leads with a tick that pops in by scale
  only, so under reduced motion it is simply there. The tick is aria-hidden;
  the Notice carries the words.

**D2 — Tile filter (P3b, templates).** A `columns` section with
`layout: 'tiles'` and `filter: true` gets filter chips: "All (n)" plus each
distinct `badge`, in order, as `aria-pressed` toggle buttons (`ui/Button`) in
a named group.
- **Hidden, not removed:** filtered-out tiles stay in the DOM with `hidden`,
  so the prerender and crawlers see every tile.
- **Count:** a polite status line says how many show.
- **Badge colour:** each badge takes its tile's status flags (`future` /
  `partial` / none = works), not its text, so a pill cannot claim "works" on a
  column flagged future.
- **Phone notes:** the page's phone notifications already exist as the
  ADR 1060 hero visual `phone`, with its loop and pause control.

**D3 — Flow rail (P3c, features).** The existing ADR 1038 D8 flow, in both
the hero visual and the columns layout, gains two options:
- **Numbered marks:** `flow.numbered` / `numbers: 'circle'` puts 01–05 in the
  aria-hidden mark.
- **Run:** `flow.run` / `run: true` lights each mark in turn on a 7 s loop.
  It animates a ring only, never opacity, sits behind the reduced-motion
  gate, and pauses on hover, on focus, and with the shared pause control
  (WCAG 2.2.2).

The waiting state is already amber. `useLoopToggle` moved from `heroArt.tsx`
into `loopToggle.tsx`, so the hero loops and the rail share one control.

**D4 — Run log and gauge (P3d, contact).**
- **Run log:** a new ADR 1060 hero visual `log`, mirrored byte for byte. A
  title bar, then up to 10 lines `{time, event, detail, state: done|waiting}`
  as a real ordered list. Crawlers read the title, then "time — event —
  detail". On the motion path (the ADR 1038 guard) the lines slide in once and
  the cursor blinks four times (under 5 s); nothing loops.
- **Gauge:** a `columns` item `gauge` ("415/415") draws a decorative ring
  filled to the item's own `progress`. The words are real text and reach the
  prerender and the markdown export; the numbers are content.

  > **CORRECTION 2026-11-07:** the SPA drew the ring only in the `cards`
  > layout. A `bento` tile with `gauge` (myndhyve.ai's contact pillars, "418
  > of 418") validated, and the prerender and markdown export showed its
  > words, but the tile had no ring. The bento tile now leads with the same
  > `GaugeRing`, before the count and eyebrow. Found by myndhyve-1e on
  > myndhyve-prod 6fc23b20.

**D5 — The agencies brand swap (P3e)** needs no change. It is the existing
ADR 1060 hero visual `apps` (a 12 s cross-fade of up to three brands, with the
pause control, stacked statically without motion).

**D6 — About pieces (P3f).**
- **(a) Source pills:** `richText` `sources: true` renders inline code spans
  as `<cite>` pills, which is a citation, not code.
- **(b) Pull quote:** `quotes` `style: 'pull'`, one large quote on the accent
  colour, keeping figure/blockquote semantics.
- **(c) Timeline picture:** a `timeline` may carry a picture (alt required)
  beside the rail on wide screens.
- **(d) Portrait chips:** up to four `chips` `{text, at: tl|tr|bl|br}` on a
  hero `image`. They are static, aria-hidden and hidden under 900px, because
  the hero copy carries their words. The site owner approved them through
  myndhyve-1e.

## Alternatives considered

- **Building the card into the hero section.** Rejected: the form is its own
  section with its own reference, and putting a form inside the hero would make
  the hero carry a second, unrelated data shape.
- **Authoring the field pairing per field.** Rejected for now: pairing
  one-line fields is a layout rule, and per-field layout data would be stored
  on the form, which the CMS section must not edit.

## Tests

- P3b–P3f: `tileFilter`, `flowRail`, `logGauge` and `aboutPieces` (frontend);
  `adr1064-tile-filter`, `adr1064-flow-rail`, `adr1064-log-gauge` and
  `adr1064-about-pieces` (backend). Each is sabotage-witnessed, as its header
  records.
- Tidy-up in this PR: #5606 had inserted `cleanFormPerson` between
  `safeLink`'s doc comment and the function. The comment is back above
  `safeLink`.

- `backend/typescript/test/adr1064-form-card.test.ts`: the layout, `lede` and
  person are kept, dropped or refused as described.
- `frontend/react/src/features/forms/__tests__/formCard.test.tsx`: only the
  one-line fields are wrapped, with every field kept in order; the decorative
  tick leads the confirmation; the plain renderer is unchanged; the CMS
  section renders the head beside the card with its person block.
  Sabotage-witnessed: removing the wrapper turns the first case red.
