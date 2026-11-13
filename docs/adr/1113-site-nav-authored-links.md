# ADR 1113 — Site nav: authored links to app routes

Status: implemented (2026-11-13, this PR).

Extends [ADR 1049](1049-grouped-public-site-navigation.md) (grouped public navigation),
[ADR 1062](1062-public-site-chrome-featured-card-cta-split.md) (the featured card) and
[ADR 1105](1105-site-sections-parties-charts-worksheets.md) D11 (authored group headings).
Requested by a white-label adopter (KickTodo), whose site design is a four-column mega menu.
Host-extension only: the field lives on CMS pages under `/v1/host/openwop-app/*`, so no wire
RFC is involved.

## Context

The public menu and the grouped footer list one entry per published CMS page, plus the
built-in `/pricing`, `/blog` and `/docs`. Nothing else can appear. An adopter whose product
lives in app routes cannot link them:

- KickTodo publishes two CMS pages (`features`, `pricing`). Its menu design has four columns of
  three or four entries each, and most entries are app routes (`/discover`, `/circles`,
  `/guide`, `/leaderboard`) or sections of the features page (`/p/features#today`).
- The only way to reach those today is a CMS page per destination, which is a public page that
  exists only to be a menu entry, or an edit to `PublicShell.tsx` in the adopter's tree, which is
  a merge conflict on every sync (CasaVoga carries one for headings, now retired by ADR 1105 D11).
- `siteNav.groupLabel` (ADR 1105 D11) names a group only through a page in that group. A site
  with two pages cannot head four columns.

`siteNav.featured` (ADR 1062 D2) already lets a page store a menu element that points at an
internal path or a fragment. This ADR applies the same pattern to ordinary entries.

## Decision

### D1 — `siteNav.links`, a list of authored entries on a page

`PageSiteNav` gains `links?: SiteNavLink[]`:

```ts
interface SiteNavLink {
  label: string;        // required, ≤ 40
  href: string;         // required: an internal path or a #fragment on the owning page, ≤ 200
  group: SiteNavGroup;  // required: the entry's own group, not the page's
  description?: string; // ≤ 90
  order?: number;       // integer 0–999
  groupLabel?: string;  // ≤ 40, names `group` (ADR 1105 D11 rule)
}
```

`cleanSiteNav` validates it in `cleanSiteNavLinks`. The strings take the content lane like
`label`. `href` takes the `featured.href` grammar (`isFragmentHref` or `isInternalHref`), so an
external URL, a protocol-relative URL or `javascript:` is refused. Anything else is a
`validation_error` 400 whose `field` names the entry (`siteNav.links[2].href`). It is never
coerced. At most 12 entries per page. An empty list is absent.

Each entry carries its own `group`, so one page can fill several columns. The page's own
`group` is not required.

### D2 — the public nav read carries them unchanged

`listPublicNav` already returns a page's `siteNav` (less `featured`) as the row's `nav`, so the
links travel with no server change. Draft and `noindex` pages are excluded as before, so a draft
page's links never surface.

### D3 — the shell turns each link into an ordinary entry

`usePublicNav` (the ONE source for the menu and the footer) appends one `NavEntry` per link after
the page and built-in entries:

- `to` is the `href`, except that a fragment resolves on the owning page (`/p/<slug>#x`, or
  `/pricing#x` for the reserved `pricing` page).
- Group, order (default 500, like an unordered page), description and `groupLabel` behave
  exactly as on a page, so the ADR 1105 D11 heading rule picks up a link's heading.
- A destination that is already listed keeps its first entry. Pages and built-ins come first, so
  a link can never duplicate a page.
- Links are never `primary`, `cta` or `utility`. Those stay page-level decisions.
- An authored link switches the site into grouped mode, like a page that names a group.
- The client re-checks each entry (`readLinks`) and drops one without a label, a known group or
  a safe href. A stale or foreign server cannot put an off-site link in the chrome.

### D4 — locale

Like every nav label, links serve in the base language. The public nav list is not localized
(the gap ADR 1105 D11 records). This ADR does not widen it.

## Consequences

- An adopter can build a full mega menu from content alone, without an edit to `PublicShell.tsx`.
- An app route linked from the menu may require sign-in. That is the adopter's choice, as with any
  link it publishes. The menu does not hide a link by auth state.
- A link to a route that does not exist is the adopter's 404, as with a hand-written link in a
  page body. Validation proves an href is safe, not that it resolves.

## Tests

- `backend/typescript/test/adr1113-site-nav-links.test.ts`: the validator (accepts, caps,
  refusals by field, the 12-entry cap, empty as absent) and a PATCH → publish → public nav read
  round trip.
- `frontend/react/src/chrome/__tests__/PublicShell.groupedNav.test.tsx`: two pages fill four
  authored columns in the menu and the footer, a fragment resolves on its page, a duplicate and an
  unsafe link are dropped, and links alone switch grouped mode.
