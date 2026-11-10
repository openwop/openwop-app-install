# ADR 1069 — Site design batch Phase 3b1: plan cards and the callout footnote

Status: Accepted (2026-11-07). D1 and D2 are implemented in the PR that records them.

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
