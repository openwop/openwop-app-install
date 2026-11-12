# ADR 1069 — Site design batch Phase 3b1: plan cards and the callout footnote

Status: Accepted (2026-11-07). D1 and D2 are implemented in the PR that records them. D3 (2026-11-10, DeckTalk) is implemented in the PR that records it.

Part of Phase 3 of myndhyve-1e's myndhyve.ai design batch (David approved the
work), owned by f2. It follows [ADR 1066](1066-site-p3a-hero-visuals.md) and
ADR 1067 (Phase 3a). It is host CMS rendering only, so no wire RFC is involved.

## Context

The pricing page and the home page show three ways to start as **plan cards**
(PRC-11 to PRC-15, HOME-36/37/39):

- **Each card:**
  - a mono accent eyebrow ("RUN IT YOURSELF · FOR DEVELOPERS");
  - a big price with a small unit beside it ("$299", "a month, per app");
  - a check list with no dividers;
  - its own button at the foot. The featured plan is a dark card with a
    full-width primary button, raised a little; the free plan has a ghost
    button.
- **Under the grid:** a boxed "Not included" callout with a mark.

Live, both sections use the columns `list` layout, and it fell short in five
ways:

- **Eyebrow:** never drawn, so the authors bolded it into `text`.
- **Price:** the whole price was one heading, with no unit.
- **Buttons:** cards had none.
- **Checks:** every item had a hairline.
- **Footnote:** a quiet grey line.

## Decision

### D1. Plan cards: `unit`, `ctaLabel`/`ctaUrl`, and the eyebrow on `list`

- **Eyebrow:** the `list` layout draws a column's `eyebrow`. The validator
  already kept it.
- **`unit`:** a column's price unit (≤ the badge cap). It is drawn small
  **inside** the price heading, so the heading reads "$299 a month, per app".
- **`ctaLabel` + `ctaUrl`:** a column's own button. The link goes through
  `safeLink`, and a link without a label is dropped. The button's look follows
  the existing `highlight`: primary on the featured plan, ghost elsewhere. That
  avoids a second presentation enum.
- **Plan list:** a `list` section with any `unit` or button, and no status
  column (`future`/`partial`), becomes a plan list (`fp-cols--plans`):
  - boxed cards of equal height;
  - a big price (`calc(var(--text-display) * 2)`);
  - checks with no dividers;
  - the button pinned to the foot (`margin-top: auto`);
  - the highlighted plan as the dark card (the band tokens, scoped with
    `fp-tone--inverse`), raised 12px from 900px.
- **Status lists:** a status list never becomes a plan list.
- **Crawlers:** they read the unit with its price, and the button as a link.

### D2. `noteStyle: 'callout'`

A closed enum on `columns`, kept only with a `note`. The footnote becomes a
boxed callout behind a decorative "!" mark (`aria-hidden`), at 16px.

## Alternatives

- **A new `pricing` columns layout.** Rejected: plan cards are titled lists
  with a price and a button. The existing `list` layout already validates,
  prerenders and edits them; a new layout would copy all of that.
- **A `ctaStyle` enum per card.** Rejected: the design ties the primary button
  to the featured plan, which `highlight` already names.

## Brand stylesheet (myndhyve-app, for the Codex sync)

`brand.css` 303–307 and 365–367 add a coloured top border to `fp-cols--list`
columns. Scope them to `:not(.fp-cols--plans)` so the plan cards keep their
plain border (PRC-14, HOME-37).

## Implementation

| Phase | What | Where |
|---|---|---|
| D1 | `unit`, `ctaLabel`/`ctaUrl` validator; list eyebrow, unit, card button, plans class + inverse scope; prerender + markdown; editor inputs; i18n ×4 | `cmsService.ts`, `SectionRenderer.tsx`, `sectionHtml.ts`, `sectionMarkdown.ts`, `SectionsEditor.tsx`, `global.css` |
| D2 | `noteStyle` enum; callout note | `cmsService.ts`, `SectionRenderer.tsx`, `global.css` |

Tests:
- `test/adr1069-plan-cards.test.ts`
- `frontend/react/src/features/cms/__tests__/planCards.test.tsx`

Both are sabotage-witnessed (see the PR).

**Content for 1e after deploy and sync:**
- **`sec:mh-pricing-offer` and `sec:mh-factory-status`:**
  - add the eyebrows, and strip the bold lead-ins from `text`;
  - split the prices into `title` + `unit` ("$299" + "a month, per app");
  - add the buttons: free → "Read the code" → the open-source page;
    featured → "Book a free call".
- **`sec:mh-pricing-offer`:** `noteStyle: 'callout'`.

## Addendum (2026-11-10): D3, named tier lists with a status pill

Requested by DeckTalk (dev-c5, relaying David): a pricing page whose plans have
names, a status ("Open now", "Coming", "Talk to us") and a button, but no prices
yet. Measured on its live section: it authored `layout: "cards"`, which has no
plan mode, and the `list` plan mode never drew a column's `badge`. A title with
no unit would also have taken the big price type.

- **A `badge` also makes a plan list.** The D1 test (`unit` or `ctaLabel`, no
  status flags) gains `badge`. A status list still never becomes plans.
- **The badge is a status pill** on its own line under the name
  (`fp-col__status`), not inside the heading, so the heading reads as the
  plan's name. In the accent on a light card, in the inverse ink on the
  featured dark card; tokens only, so it holds in both themes.
- **No column with a `unit` ⇒ a named tier list** (`fp-cols--plans-named`): the
  title is the plan name at display size, not price size. `highlight` keeps the
  featured dark card and the primary button, as in D1. Nothing invents a number.
- The prerender already printed `badge` as text (`sectionHtml.ts`), so crawlers
  are unchanged. No validator change: `badge` was already kept.

The authored, price-less tier list for the `pricing` SECTION (the second half of
the ask) is separate: `pricing.tiers` is already an array of billing tier ids, so
it gets a new field rather than a second meaning for that one. That is a later
PR; DeckTalk is covered by D3.

Tests: `planCards.test.tsx` "named tier list (ADR 1069 D3)", sabotage-witnessed
(a badge not triggering plans, the pill not drawn, and the named class dropped
each red a case).

## Addendum (2026-11-10): D4, authored `plans` on the `pricing` section

The second half of DeckTalk's ask: the `pricing` section itself can carry
named plans for a site that has no billing tiers yet. D3 covers DeckTalk's
`columns` page today; D4 lets a site keep its `/pricing` page on the `pricing`
section it already uses.

- **A new field, `plans`:** `[{ name, status?, blurb?, ctaLabel?, ctaUrl?,
  highlight? }]`, at most 8 plans. `name` ≤ 80, `status` ≤ 40 (the badge
  bound), `blurb` ≤ 600, `ctaLabel` ≤ 120. `ctaUrl` goes through the same link
  guard as every CTA (`safeLink`). It is not `tiers`, which stays an array of
  billing tier ids: one field with two meanings would make old pages and
  locale overlays ambiguous (dev-c5's point).
- **No price can be authored.** The validator keeps only those six keys, so a
  `price`, `unit` or `amount` is dropped. That keeps ADR 0391's rule that a
  price comes only from billing.
- **When `plans` is present it replaces the live billing read.** The SPA draws
  the D3 named tier cards (the same classes, so no new CSS) and makes no
  `/public/pricing` request. Without `plans`, nothing changes.
- **A saved plan needs a name.** A locale overlay drops a nameless plan instead
  of failing, like every other overlay field.
- **Every server projection carries the plans**, because they are authored
  content, not a billing read: the prerender (one `<article>` per plan), the
  Markdown view, and a static share. A share of a `pricing` section without
  plans keeps the "live content" note. One reader, `cms/pricingPlans.ts`,
  serves all three, so they cannot disagree.
- **Page Builder:** a "Plans (JSON)" field under the pricing fields (the ADR
  1080 JSON pattern), and the preview counts named plans when they are set.

Tests: `adr1069-pricing-plans.test.ts` (validation, prerender, Markdown),
`sharing-route.test.ts` (the share carries plans; a tier section stays noted),
and `SectionRenderer.pricingPlans.test.tsx` (the cards, no billing fetch, the
highlight, the fallback).
