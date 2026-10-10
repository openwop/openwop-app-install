# ADR 0824 — Public site answer-engine readiness: public canonicals, seeded page SEO, honest structured data, root crawler doors

Status: Accepted (implemented on `feat/public-site-seo`; flips to implemented on merge + deploy)

Related: ADR 0012 (publishing & SEO), ADR 0027 (system site), ADR 0384 (crawler
prerender), ADR 0392 (docs + llms.txt), ADR 0196 Gate A (demo-gated showcase
media), ADR 0762 (hero film), ADR 0614 (hosting wire rewrites). Witness:
`backend/typescript/test/public-site-aeo.test.ts`.

## Context

A read-only audit of `app.openwop.dev` against the answer-engine (AEO) bar that
openwop.dev now meets, each finding confirmed live with curl (browser UA and
`GPTBot`) on 2026-10-05:

1. The crawler document for `/` declared
   `<link rel="canonical" href=".../host/openwop-app/public/host-site/pages/home">`
   — the JSON read, served as `application/json`. Same for every `/p/<slug>`.
   `og:url` mirrored it. Title `Home`, `og:site_name` `OpenWOP Site`.
2. No seeder wrote a `PageSeo` record, so every title fell back to the page
   title and every description to the first hero subheading.
3. The home JSON-LD typed the front page as `Article` (it holds a hero and a
   richText block, the generic article heuristic).
4. `/robots.txt` and `/sitemap.xml` returned the SPA `index.html` as
   `text/html` — Hosting had no rewrite. The real generators lived under
   `/host/openwop-app/public/host-site/…`, and the sitemap listed JSON URLs.
5. `/llms.txt` was hosting-rewritten to the backend but missing from
   `PUBLIC_PATH_PREFIXES`, so every agent got `401 unauthenticated`.
6. The SPA shell had no `<meta name="description">`.

## Decision

**D1 — one URL function names the page as people open it.**
`publishingService.publicPageUrl(baseUrl, orgId, page)` returns, for the
configured platform site org (`OPENWOP_PUBLIC_SITE_ORG_ID`, the org the `/` +
`/p/:slug` doors already serve): `/` for `home`, `/blog/<slug>` for a post,
`/docs/<slug>` for a docs page, `/p/<slug>` otherwise. Every other org keeps the
vendor path (it has no platform-origin document door). Canonical, `og:url`,
sitemap `<loc>` and feed `<link>` all go through it — they were already one
helper (`pageUrl`), so the fix is one seam, not four. The origin is
`publicBaseUrl(req)` (`OPENWOP_PUBLIC_BASE_URL`, else the sanitized request
origin) — nothing hardcoded.

**D2 — seeded system pages get real `PageSeo`, written through `putSeo`.**
`host/systemSiteSeo.ts` holds title/description for home, about, roadmap,
changelog, support, claude-code, compare and features, and writes them as the
system actor at boot. Never-clobber: a record whose `updatedBy` is not the
system actor was written by a person and is frozen. Because the SPA's
`applySeo` reads the same `seo` block, this also gives human (non-crawler)
loads the real title and description (finding 6, page half).

**D3 — the reference deployment describes itself in a data module.**
`host/systemSiteProfile.ts` returns, for the system site org on a demo
deployment only, the site name (`OpenWOP`), Organization `sameAs`
(openwop.dev, github.com/openwop), and for home a `SoftwareApplication`
(DeveloperApplication, price 0, `isBasedOn`/`about` openwop.dev) and a
`VideoObject` for the hero film. Separately and generically, a `home` page is
never typed `Article`. The prerender appends the profile; any other org renders
byte-for-byte as before.

**D4 — root `/robots.txt` and `/sitemap.xml` doors.** Hosting rewrites both to
the backend; the publishing feature serves them for the site org. robots is one
group for `*` plus named AI crawlers (a named group would otherwise replace the
`*` rules), allows everything public, disallows the signed-in app (`/chat`,
`/admin`, `/settings`, `/builder`, `/runs`, `/inbox`) and the API (`/v1/`,
`/api/`, `/host/`) except its public read + media prefixes, which the SPA's
public pages fetch while rendering. Capability-token pages are deliberately not
disallowed: they carry `noindex`, which a crawler can only honour if it may
fetch them. `Sitemap:` names the root `/sitemap.xml`.

**D5 — `/llms.txt` is public** (added to `PUBLIC_PATH_PREFIXES` with the two new
doors) and, for the system site on a demo deployment, opens with a title, a `>`
summary and one paragraph linking openwop.dev, its llms.txt and `/ai-tools/`.

**D6 — the shell gets a brand-derived description.** A build-time
`VITE_BRAND_DESCRIPTION` (defaults to the OpenWOP sentence, like
`VITE_BRAND_DOCUMENT_TITLE`) is stamped into `index.html`'s
`<meta name="description">`; `applySeo` already upserts and restores that
element.

### Copy rules

The **protocol** is open source; this app is not, and no string here calls it
so. None of openwop.dev's gated claims (`industry standard`, `independently
validated`, `best-in-class`, unqualified `fully conformant`, `vendor-neutral
standard`, `open standard`) — test-enforced over the D2 table.

> **Correction (ADR 0843, 2026-10-06).** "This app is not [open source]" is
> narrower than it reads: the app ships under Apache 2.0 as a downloadable
> bundle that includes its source; what is private is the repository. The
> white-label page may say "open source (Apache 2.0)". The D2 SEO table keeps
> this rule as written. See ADR 0843 § Copy rules.

## Alternatives weighed

- **Set `canonicalUrl` in each seeded `PageSeo`** instead of D1. Rejected: it
  fixes only seeded pages, hardcodes the origin, and leaves the sitemap and
  feed on JSON URLs.
- **Rename the org to `OpenWOP`** for `og:site_name`. Rejected: the org is only
  created when absent, so an existing deployment would need a migration, and a
  white-label install would inherit the name. The demo-gated profile (and the
  existing `OPENWOP_PUBLIC_SITE_NAME` override, which still wins) is narrower.
- **Put the home structured data in CMS section data.** Rejected for now: no
  section type carries it, and the film is not CMS data either (it is a demo-gated
  constant in `SectionRenderer.tsx`). The profile mirrors that constant, and a
  test pins the two `?v=` values together.
- **Static `robots.txt` in `frontend/react/public`.** Rejected: it cannot name
  the deployment's origin in `Sitemap:`, and a white-label fork would ship ours.

## Consequences

- White-label installs (`OPENWOP_DEMO_MODE` off) get correct canonicals, robots,
  sitemap and a public llms.txt, but none of the OpenWOP self-description.
- Deploy: backend (D1–D5) **and** frontend Hosting (the `firebase.json` rewrites
  for D4, the shell meta for D6, and the hero film `?v=` bump to `2026-10-04.1`).
- The CMS heading `*emphasis*` syntax (companion PR #4414) is stripped/rendered as
  `<em>` in the crawler HTML here, mirroring the SPA parser, so prerendered
  headings, anchor ids and description fallbacks never show asterisks.

## Implementation record

| Decision | Where | Witness |
|---|---|---|
| D1 | `features/publishing/publishingService.ts` `publicPageUrl` | `public-site-aeo.test.ts` canonical + sitemap cases |
| D2 | `host/systemSiteSeo.ts`, `routes/registerAllRoutes.ts` | length/claims table + never-clobber case |
| D3 | `host/systemSiteProfile.ts`, `features/publishing/prerenderService.ts` | home JSON-LD types, white-label null, film `?v=` parity |
| D4 | `features/publishing/routes.ts`, `middleware/auth.ts`, `middleware/protocolVersion.ts`, `firebase.json` | robots + sitemap cases, allowlist case |
| D5 | `features/docs/{docsService,routes}.ts` | llms.txt case |
| D6 | `frontend/react/{index.html,vite.config.ts,src/brand/*}`, `WHITE-LABEL.md` | `vite build` stamps the meta; `check-brand-resolver.mjs` |
| emphasis | `features/publishing/headingEmphasis.ts`, `sectionHtml.ts`, `publishingService.ts` `descriptionFrom` | emphasis cases |
