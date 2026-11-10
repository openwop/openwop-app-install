# ADR 1056 — Grouped footer: brand column, call to action, bottom bar

Status: implemented (2026-11-04, D1–D4; see § Implementation record).

Extends [ADR 1049](1049-grouped-public-site-navigation.md) (grouped public site
navigation from per-page `siteNav`). Host-extension only: the list endpoint
lives under `/v1/host/openwop-app/public/*`, so no wire RFC is involved.

## Context

ADR 1049's grouped footer is a centred `brand.footerText` line above one
column of underlined links per nav group. A full marketing site wants the
usual footer layout:

- a **brand column** first: the logo and site name, a short line about the
  company, and a button for the site's main call to action (for example
  "Book a call");
- the group columns, with accent mono-caps headings and plain links;
- a **bottom bar** under a rule: a copyright line on one side and a few
  utility links (security reports, a contact page) on the other.

Most of this can come from data that already exists. `useBrand()` has the
mark, lockup, product name and `footerText`, and the nav list has every
published page. Two things have no source today:

1. **The call to action.** `siteNav.primary` (ADR 1049) promotes pages into the
   header's always-visible links ("How it works", "Pricing"). Those are
   navigation, not a call to action, and none carries button text. The brand
   config has no CTA field either (`homeUrl` is the "Learn more" link of the
   privacy footer).
2. **The utility links.** Nothing marks a page as a bottom-bar link.

## Decision

### D1 — two more optional `siteNav` fields

```ts
siteNav?: {
  // … ADR 1049 fields …
  cta?: string;      // ≤ 40: the footer button label; marks this page as the CTA
  utility?: boolean; // also list this page in the footer's bottom bar
}
```

They are validated like `label` and `primary`: `cta` must be a string (trimmed
and capped through the content lane, so a credential-shaped token is refused;
blank means absent); `utility` must be a boolean (`false` is not stored).
Anything else is a 400 `validation_error`, never coerced. The existing nav
projection copies `siteNav` into the public list's `nav`, so no endpoint
change is needed.

The fields belong on the page, not in the brand config: the CTA is a link to a
published page, so it is right only while that page is published, and the
published-only nav list already guarantees that. A brand field would be a
free-form URL that can point at an unpublished or deleted page.

### D2 — the brand column

In grouped mode the footer leads with:

- a home link (`/`) holding `BrandLockup` (the configured lockup, or the mark
  plus `productName`), named by `productName` because the artwork is
  decorative;
- `brand.footerText`, when set;
- the CTA: the first entry, by group order and then `order`, whose page sets
  `siteNav.cta`, rendered as a primary `a.btn` with the `cta` text, linking to
  that page. Only one renders. The page still appears in its group column
  under its nav label.

The brand column sits outside the footer nav landmark.

### D3 — the group columns

The columns keep ADR 1049's markup: one `<nav aria-label="Footer">` holding an
`h2` and a `ul` per group. Headings are mono caps in the accent text colour
(`--clay-text`). Links are plain (`--ink-2`) and underline on hover and focus.
The Legal group carries `app-footer__group--legal` and lays its list out in two
sub-columns.

### D4 — the bottom bar

Under a rule: `© {year} {productName}` (i18n `footerCopyright`) on the start
side and, on the end side, a second nav landmark (i18n
`footerUtilityNavLabel`, "Footer extras") listing the `siteNav.utility` pages
in group and order. When the site has no Legal column, the privacy link
(which ADR 1049 put in a trailing list) closes this bar instead. With nothing
to list, the bar holds only the copyright line.

### Layout and accessibility

Logical properties only (RTL), tokens only (dark mode and forced colours
inherit; a distribution re-tints through its brand overlay). Desktop: the
brand column, then auto-fit group columns with Legal spanning two. Below
1024px Legal takes a full row; below 900px the brand column stacks above two
group columns. Nothing scrolls sideways at 390px.

### Ungrouped sites

`cta` and `utility` take effect only in grouped mode. A site whose pages name
no group renders exactly the ADR 0486 footer: the same markup, classes and
links, with no brand column and no bottom bar.

## Implementation record

| Phase | What | Commit |
| --- | --- | --- |
| D1 | `siteNav.cta` + `siteNav.utility` in `cleanSiteNav`, route round-trip, public `nav` | `9f1aff7df` |
| D2–D4 | brand column, CTA, accent headings, Legal split, bottom bar, i18n ×4, CSS | `056f273e4` |
| D2 | stock mark sizing in the brand column | `86c8600ec` |

## Non-goals and follow-ups

- **Editor UI.** Like the rest of `siteNav` (ADR 1049), the fields are set
  through the API until the CMS editor gets a `siteNav` control.
- **Localized CTA text.** `cta` is base-locale text, like `label`.
- **A separate bottom-bar label.** A utility link uses the page's nav label.

> **UPDATED 2026-11-05 (ADR 1062).** The `siteNav.cta` page is now also an
> always-visible header button in grouped mode (still one source), and the
> bottom bar's copyright line uses the brand's `chromePolicy.customCopyright`
> when it is set. See [ADR 1062](1062-public-site-chrome-featured-card-cta-split.md) D1 and D5.

## Tests

- `backend/typescript/test/adr1056-footer-cta.test.ts`: the validator accepts,
  trims, caps and refuses both fields; PATCH round-trips them and the public
  list carries them in `nav`.
- `frontend/react/src/chrome/__tests__/PublicShell.footerBrand.test.tsx`: the
  brand column and its home link, one CTA chosen by group then order, the
  Footer landmark and lists kept, the Legal split class, the copyright line,
  utility links in their own nav, the privacy fallback into the bottom bar,
  and an ungrouped site unchanged.
