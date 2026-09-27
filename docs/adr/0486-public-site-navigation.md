# ADR 0486 — Public-site navigation: a grouped hamburger menu + a published-pages list endpoint

Status: implemented

## Context

The public-facing CMS site (the anonymous `PublicShell` above the auth gate — the
home page, `/p/:slug` CMS pages, `/pricing`, `/blog`, `/docs`) had a **thin,
hard-coded header nav**: `usePublicNavLinks()` returned a fixed list (Blog,
Pricing, Compare, + Docs when probed available), shown as a desktop `<nav>` with a
separate `<620px` mobile disclosure. Two problems:

1. **Not all pages were reachable from the home page.** The reserved system-site org
   holds many CMS pages beyond the hard-coded four — the seeded Features page, and
   (once an operator publishes them) the marketing set (about, careers, press,
   contact, …) and the legal suite. None were linked. A hard-coded list also drifts
   and risks linking a page that isn't published (a 404).
2. **The header layout was cramped** and split across two nav mechanisms
   (desktop inline + mobile menu) that had to be kept in sync.

## Decision

1. **A published-pages list endpoint** (host-extension, no wire RFC):
   `GET /v1/host/openwop-app/public/:orgId/pages` → `{ pages: [{ slug, title }] }`.
   It rides the publishing feature's existing public surface and the SAME
   published-only + toggle-gated choke as `sitemap.xml`
   (`listPublishedWithSeo` — already excludes docs-collection pages). It further
   excludes the `home` page (it is the brand link), blog posts (`kind:'post'` —
   they live under `/blog`), and `noindex` pages (a page an author kept out of the
   sitemap MUST NOT be promoted into the primary visible menu — the same
   `!seo?.noindex` exclusion the sitemap applies), sorts by title, and is
   `capPublic`-bounded. **Draft pages never appear**, so a nav link can never point
   at an unpublished page.

2. **A single grouped hamburger menu** (`PublicMenu`) at ALL viewports, replacing
   the split desktop-nav + mobile-menu. It opens a panel with two groups:
   - **Product** (curated main functionality): Features, Compare, Pricing, Blog,
     and Docs (only when this deployment has published docs — the existing
     `useDocsAvailable` probe).
   - **Pages** (dynamic child pages): every OTHER published CMS page, from the new
     endpoint (the curated slugs are excluded so nothing lists twice). This is the
     "all published pages reachable from home" guarantee — no stale hard-coded list.

   The header is re-laid-out: brand left, a right-aligned control cluster
   (theme · locale · sign-in · the Menu button). WAI disclosure a11y is preserved
   (`aria-expanded`/`aria-controls`/`aria-haspopup`; Esc + outside-click close and
   return focus). One `usePublicNav()` source feeds both the menu and the footer,
   so they can never drift.

## Boundaries audit

- **No new route namespace.** The list endpoint is one more GET on the existing
  publishing public base `/v1/host/openwop-app/public/:orgId` (`routes.ts`),
  registered before `/pages/:slug` (distinct exact path). No collision.
- **Single owner.** Publishing already owns the public-site read surface (sitemap,
  rss, page-by-slug); the nav list is the same shape, reusing `listPublishedWithSeo`.
  The CMS remains the sole page store; this only projects a slug+title view.
- **No parallel nav system.** `usePublicNav()` is the one nav source (menu + footer);
  the docs-availability probe is reused, not reinvented.

## RFC verdict

**Host-extension — no RFC.** The endpoint is under the non-normative
`/v1/host/openwop-app/public/*` prefix; it touches no wire surface. The normative
`/v1/content/pages/:slug` delivery is unchanged.

## Alternatives weighed

- **Hard-code a fuller link list** — drifts, and links unpublished pages (404s).
  Rejected: the dynamic endpoint is honest-by-construction (published-only).
- **Keep the desktop inline nav + add a "More" menu** — two mechanisms to keep in
  sync (the exact drift this removes). Rejected in favor of one menu at all widths,
  per the request for a hamburger reaching main functionality + child pages.
- **A CMS nav-group taxonomy** (per-page nav metadata) — richer grouping, but a
  larger CMS change. Deferred: Product (curated) + Pages (everything else) is a
  clear, low-risk grouping today; a taxonomy is additive later.

## Open questions

- **Grouping of the dynamic pages.** Currently one flat "Pages" group. If the
  published set grows large (full marketing + legal suites), a per-page nav-group
  field (company / legal / resources) would sub-group it — additive, deferred.
- **Ordering.** Dynamic pages sort by title; a future `navOrder` could let operators
  order them. Deferred.

## Implementation record

| Piece | Location |
|---|---|
| List endpoint + service | `features/publishing/routes.ts` (`GET …/public/:orgId/pages`), `publishingService.ts` (`listPublicNavPages`) |
| Grouped nav model + hamburger | `chrome/PublicShell.tsx` (`usePublicNav`, `usePublishedPages`, `PublicMenu`) |
| Header layout + menu styles | `styles/global.css` (`.public-shell-actions`, `.public-menu*`) |
| i18n (navFeatures/navMenu/navGroupProduct/navGroupPages) | `i18n/locales/*/chrome.ts` ×4 |
| Tests | `test/public-nav-pages.test.ts`, `chrome/__tests__/PublicShell.menu.test.tsx` |
