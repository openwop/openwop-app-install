# ADR 1062 — Public site chrome: header CTA, featured card, pricing placement, CTA split

Status: Accepted (2026-11-05). P1 is implemented in the PR that adds this ADR.

Extends [ADR 1049](1049-grouped-public-site-navigation.md) (grouped public-site
navigation from per-page `siteNav`) and [ADR 1056](1056-grouped-footer-brand-column.md)
(grouped footer brand column, call to action, bottom bar). Host-extension only:
the nav read lives under `/v1/host/openwop-app/public/*` and the section data
under the host CMS, so no wire RFC is involved.

## Context

The MyndHyve site owner approved closing the gap between the "MyndHyve Site
Redesign" design and myndhyve.ai (myndhyve-1e's brief, 2026-11-05). myndhyve.ai
is a white-label deployment of this app, so the renderer and chrome changes
land here. The site copy stays in its CMS content. P0 of that brief (the
`columns` list layout ignored `future`) shipped separately in #5597.

Most of the design's header, mega menu and footer already exist in ADR 1049/1056:
grouped columns with one-line descriptions, Escape / outside-click / focus
return on the panel, a footer brand column with `brand.footerText` and the
`siteNav.cta` button, a two-column Legal list, and a bottom bar of
`siteNav.utility` links. Five things had no source or were not wired:

1. the header has no current-page marker and no always-visible call to action;
2. the mega menu has no featured card (the design's cobalt film card);
3. `/pricing` is an app route that renders the CMS `pricing` page when one is
   published, but the reserved slug meant that page's `siteNav` was ignored, so
   Pricing could not take a description or move groups;
4. the design's CTA band puts the copy and the button side by side, and a
   short note under the button; the `cta` section has neither;
5. the brand identity already carries `chromePolicy.customCopyright`, but the
   grouped footer always printed the generated "© year name".

## Decision

**D1 — Header.** The primary links render with `NavLink`, so the current page
carries `aria-current="page"` and an inset accent rule. In grouped mode the
page that sets `siteNav.cta` (ADR 1056's single source) is also a header
button, always visible. The theme toggle, language switch and page actions
("Edit this page") move to a footer row at the bottom of the panel. The
panel drops in with a transform-only animation (`public-menu-drop`), so
reduced motion leaves it fully visible; nothing starts at opacity 0.

**D2 — Featured card.** A page may set `siteNav.featured`:
`{ eyebrow?: ≤30, title: ≤60 (required), meta?: ≤20, href?: ≤200 }`. `href` is
a `#fragment` (resolved against the owning page: `/` for home, else
`/p/<slug>`) or a safe internal path. An external URL, `//host`, a bad
fragment or a non-string field is a 400, never coerced. The public nav read returns
`featured` once, at the top level, with the owning page's `slug`. It is taken
from the first published, indexable, non-post page that sets one, home first,
then by title. It is stripped from that page's row `nav`, so a site that never
sets it reads byte-identically. Home is not a nav row, but it can own the
card. The shell renders it in grouped mode only. Every word comes from content,
including the film length, so nothing is hard-coded (the design's "4:18" was
wrong by the next cut).

**D3 — Pricing placement.** When the CMS `pricing` page is published, its
`siteNav` places the single `/pricing` entry: label, description, group,
order, primary, cta and utility. The slug stays reserved, so there is never a
second `/p/pricing` link.

**D4 — CTA split and note.** The `cta` section's `align` gains `split`: copy
at the start, button at the end on wide screens, stacking under 900px. `start`
already puts the button under left-aligned copy, so the design's "button
below" pages use `start`. A new `note` (≤ 240, content lane) renders under
the button as `.fp-cta__note`, through inline markdown, and also reaches the
prerendered HTML and the markdown export.

**D5 — Copyright line.** The brand's existing `chromePolicy.customCopyright`
is hydrated onto the brand singleton and, when set, replaces the generated
copyright line in the grouped footer.

## Alternatives considered

- **A per-site header CTA field in the brand config.** Rejected: ADR 1056
  already made `siteNav.cta` the site's one call to action, and a second
  field could disagree with it.
- **Including the home page as a nav row so it can carry `featured`.**
  Rejected: every consumer would have to filter it again; a top-level
  `featured` travels once and leaves the rows unchanged.
- **Accepting an external URL as the card's `href`.** Rejected: the card sits
  in the site's own navigation, and an off-site link there is a phishing
  surface on a multi-tenant host. A fragment or internal path covers the case
  that was asked for (the film section on home).
- **Naming the new CTA alignment `below`, as the brief asked.** Rejected after
  reading the design CSS: its default band is side by side, and "below" is
  what `start` already renders. The new value is the side-by-side one.

## Implementation record

| Phase | What | Where |
|---|---|---|
| P1 | D1–D5 | this PR: `cmsService.ts` (`cleanSiteNav` featured, cta `split` + `note`), `publishingService.ts` `listPublicNav`, `publishing/routes.ts`, `sectionHtml.ts` / `sectionMarkdown.ts` (cta note), `PublicShell.tsx`, `SectionRenderer.tsx`, `brand/applyBrand.ts` + `defaults.ts`, `global.css` |

## Tests

- `backend/typescript/test/adr1062-site-chrome.test.ts`: the featured
  validator accepts, caps and refuses; the route returns the card once, with
  its slug, never from a draft and never inside the row `nav`; cta `split` and
  `note`, and the note in both prerenders.
- `frontend/react/src/chrome/__tests__/PublicShell.siteChrome.test.tsx`:
  aria-current, the header CTA, the featured card's fragment resolution (home
  and non-home, off-site href dropped), the panel footer row, the pricing
  placement, the brand copyright, and nothing new on an ungrouped site.
  Sabotage-witnessed: `Link` for `NavLink`, `/p/home` for `/`, and dropping the
  pricing description each turn one case red.
- `frontend/react/src/features/cms/__tests__/ctaSplitNote.test.tsx`: the
  split class, the copy/actions columns, and the note.

## Open questions and follow-ups

- **Menu button label.** The brief asks for "All pages" instead of the
  localized "Menu". It needs a brand string with its own localization, so it
  is deferred (myndhyve-1e: low priority).
- **Editor controls.** `siteNav.featured`, the cta `split` alignment and the
  cta `note` are set through the API, like the rest of `siteNav` and the
  existing cta `align` (the section editor has no control for either yet).
- **P2 and P3 of the brief** (film card, two-column FAQ, kanban, gallery and
  bento variants; per-page visuals and motion) are separate decisions.
- **Dark-mode band rhythm** (owner decision 1 in the brief) applies to every
  band and belongs with P2.
