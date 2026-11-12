# ADR 1049 — Grouped public site navigation (per-page `siteNav`)

Status: implemented (2026-11-03, #5551: D1–D8; see § Implementation record). Live on
myndhyve.ai as a carried copy since 2026-11-03.

Extends [ADR 0486](0486-public-site-navigation.md) (the public menu + the
published-pages list endpoint). Host-extension only: the list endpoint lives
under `/v1/host/openwop-app/public/*`, so no wire RFC is involved.

> **UPDATED 2026-11-05 (ADR 1062).** `siteNav` gains `featured` (the mega
> menu's card, returned once at the top level of the nav read), the CMS
> `pricing` page's `siteNav` now places the reserved `/pricing` entry, and the
> current top link carries `aria-current="page"`. See
> [ADR 1062](1062-public-site-chrome-featured-card-cta-split.md).

## Context

ADR 0486 gave the public shell (`frontend/react/src/chrome/PublicShell.tsx`)
one "Menu" disclosure with two groups. **Product** holds the curated
`features` / `compare` / `white-label` pages (each only when published) plus
the app routes `/pricing`, `/blog` and `/docs`. **Pages** holds every other
published CMS page, sorted by title. The footer repeats the same links as one
flat list, followed by the privacy link.

That works for a small site. An adopter with a full marketing site (MyndHyve:
audience pages, a trust centre, company pages, a legal suite) wants a mega
menu with columns, a one-line description per destination, and a grouped
footer with a Legal column. Under ADR 0486 every one of those pages lands in
one long "Pages" list. The operator cannot choose a column, a label, an order,
or which links appear in the header.

## Decision

### D1 — `siteNav` is optional per-page metadata

`Page` gains an optional field:

```ts
siteNav?: {
  group?: 'product' | 'audience' | 'resources' | 'trust' | 'company' | 'legal'; // `resources`: see the 2026-11-10 addendum
  label?: string;        // ≤ 40, overrides the title in nav
  description?: string;  // ≤ 90, one line under the label in the mega menu
  order?: number;        // integer 0–999, lower first within a group
  primary?: boolean;     // promote into the header's primary nav
}
```

`cleanSiteNav` (in `features/cms/cmsService.ts`, written like
`cleanPostFacets`) validates it:

- unknown keys are dropped;
- `label` and `description` are trimmed and capped on the content lane
  (`optionalCleanContent`: published text is never rewritten, and a
  credential-shaped token is refused);
- an unknown `group`, a non-integer or out-of-range `order`, a non-boolean
  `primary` or a non-string label/description is a `validation_error` 400,
  never coerced;
- an object that cleans to nothing (including `primary: false` alone) is
  stored as absent.

`POST …/pages` and `PATCH …/pages/:pageId` accept it. On PATCH, `null` clears
it, like `category`. It is page chrome, so a translator grant (ADR 0205 D1)
cannot set or clear it (403 `forbidden_scope`).

### D2 — the public list carries it

`listPublicNavPages` (since ADR 1062: `listPublicNav`, whose `pages` are these rows) returns `{ slug, title, nav? }`, where `nav` is the
page's `siteNav`. The key is **omitted** when the page has none, so a site
that never sets it gets byte-identical rows. Every ADR 0486 exclusion stays
(published only, no `home`, no posts, no `noindex`, no docs collection,
`capPublic`), and so does the title sort. The client orders by `order`.

### D3 — entries and ordering

The shell builds one entry per destination:

- each published page (minus the reserved `home` / `pricing` / `blog` / `docs`
  slugs) becomes `{ to: '/p/'+slug, label: nav.label ?? curated label ?? title,
  description: nav.description, group, order }`;
- `group` is `nav.group`, else `product` for the curated slugs (`features`,
  `compare`, `white-label`), else `pages`;
- `order` is `nav.order`, else 10 / 20 / 30 for the curated slugs, else 500;
- the app routes are added with fixed orders: `/pricing` (product, 40), `/blog`
  (50), and `/docs` when available (product, 60).

Within a group, entries sort by order, then label.

### D4 — grouped mode

**Grouped mode** is on when at least one published page has `nav.group`. In
grouped mode the groups render in this order: Product, Who it's for
(`audience`), Trust, Company, Pages, Legal. `/blog` moves to Company. With no
grouped page, the groups are exactly ADR 0486's Product + Pages, and Blog stays
in Product. The new headings are `chrome` i18n keys (`navGroupAudience`,
`navGroupTrust`, `navGroupCompany`, `navGroupLegal`) in en, es, fr and pt-BR.

### D5 — Legal is footer-only

The `legal` group never appears in the menu panel. Policies have to be
reachable, but promoting them into the primary discovery surface takes space
from destinations visitors are looking for. That matches common practice and
the existing footer privacy link.

### D6 — the mega menu

In grouped mode the panel gets `public-menu__panel--mega`. Each link renders
its description in `<span class="public-menu__desc">` after the label. The
label comes first in the link's accessible name, and the description is plain
text inside the same link (one tab stop). At ≥ 900px the panel is
`min(1080px, 100%, 100vw − 32px)` wide and anchored to the header row's
inline-end, not to the Menu button, which sits mid-bar. It is a CSS grid,
`repeat(auto-fit, minmax(180px, 1fr))`, gap `--space-5`. Below 900px it is
the existing single-column panel. The WAI disclosure behaviour is unchanged
(`aria-expanded` / `aria-controls`, Esc and outside-click close and return
focus).

### D7 — primary nav

If any page sets `nav.primary`, the header's primary nav shows the flagged
entries plus `/pricing`, ordered by group order then order. Otherwise ADR
0486's rule applies (Features when published, plus Pricing).

### D8 — the grouped footer

In grouped mode the footer renders one column per group, Legal included,
inside the same `<nav aria-label="Footer">`. Each column has an
`<h2 class="app-footer__heading">` (small mono uppercase label) and a `<ul>`.
The grid is `repeat(auto-fit, minmax(min(160px, 100%), 1fr))`, which gives two
columns or one on a 390px phone with no horizontal scroll. The privacy link
stays: it is appended to Legal when that group exists and no page already
links `PRIVACY_HREF`. With no Legal group it trails the columns, as today.
Outside grouped mode the footer is the ADR 0486 flat list. CSS uses tokens and
logical properties only, so RTL, dark theme and forced colours inherit.

## Why per-page metadata, not a navigation document

A separate "site navigation" document (a menu tree edited on its own) was the
main alternative. It was rejected for three reasons:

- **One source.** A page's placement lives on the page. Renaming, unpublishing
  or deleting the page changes its nav entry in the same write, with no second
  object to keep in sync.
- **Published-only by construction.** The nav is still derived from the
  published-pages list, so a link can never point at a draft or a deleted
  page. A menu document can hold such links (the ADR 0486 "no dishonest 404"
  rule would need re-enforcing on every read).
- **No stale links.** A hand-kept tree drifts. The hard-coded list ADR 0486
  replaced drifted in exactly this way.

The cost is that a cross-page structure (for example, nested sub-menus) is not
expressible. That is a non-goal here.

## Backward compatibility

A site whose pages carry no `siteNav` renders exactly as before: the same
menu groups and order, the same primary links, the same flat footer and the
same list-endpoint rows. The existing tests pass unchanged:
`PublicShell.menu.test.tsx`, `PublicShell.adopterNav.test.tsx` and
`backend/typescript/test/public-nav-pages.test.ts`. `siteNav` is an additive
blob field on the kernel page row (`ext.page`), so no migration is needed.

## Implementation record

| Phase | What | Commit |
| --- | --- | --- |
| D1–D3 | `Page.siteNav` validator, create/update/PATCH plumbing, translator immutability, `nav` on the public list | `fa2ea365b` |
| D4–D8 | grouped entries, mega panel with descriptions, Legal footer-only, primary flags, grouped footer, i18n ×4, CSS | `0f3329733` |

Nothing in this decision is owed. The follow-ups below (editor UI for `siteNav`, localized
nav labels) are separate changes.

## Non-goals and follow-ups

- **Localized nav labels.** `label` and `description` are base-locale text,
  like `title` in this list. Per-locale overrides (an overlay like section
  localizations, ADR 0205) are a follow-up.
- **Editor UI.** This ADR adds the field to the API. A CMS editor control for
  `siteNav` is a follow-up; until then it is set through the API.
- **Nested menus, icons, featured cards** in the mega menu.
- **Ordering of the list endpoint.** It stays title-sorted; the client sorts.

## Tests

- `backend/typescript/test/adr1049-site-nav.test.ts`: the validator accepts,
  clears and refuses; POST/PATCH round-trip and `null` clears; a translator
  cannot set or clear it; the public list carries `nav` and omits it when
  absent.
- `frontend/react/src/chrome/__tests__/PublicShell.groupedNav.test.tsx`:
  grouped columns and order, Legal footer-only, descriptions rendered, primary
  flags, Blog in Company, ungrouped site unchanged.

## Addendum (2026-11-10): the `resources` group

Requested by DeckTalk (dev-c5, relaying David): a site needs a column for
guides, help and changelog that is neither Product nor Company. `resources` joins
the closed set in `SITE_NAV_GROUPS` (`cmsService.ts`) and in `NAV_GROUP_ORDER` /
`AUTHORED_GROUPS` (`PublicShell.tsx`). It renders after Who it's for and before
Trust, in the menu and the footer, with a `navGroupResources` heading in every
locale. The footer grid is `auto-fit`, so the extra column needs no CSS.

The automatic `/blog` entry moves from Company to Resources when any published
page names that group, because a blog is a resource. A site without a Resources
page keeps Blog in Company as before. Additive: no stored value changes, and a
`group: 'resources'` the server refused before is now accepted.

Tests: `adr1049-site-nav.test.ts` accepts the group, and
`PublicShell.groupedNav.test.tsx` pins the column order (menu and footer) and
Blog's move.
