# ADR 0012 — Publishing & SEO

**Status:** Accepted (Phases 1–3 sequenced)
**Date:** 2026-06-09
**Depends on:** ADR 0001 (feature-package architecture), ADR 0004 (Orgs),
ADR 0006 (RBAC), ADR 0007 (Media — OG images), ADR 0009 (CMS — the pages it publishes)
**Toggle:** `publishing` · **Surfaces:** authed `/v1/host/sample/publishing/*`
+ **public (unauthed)** `/v1/host/sample/public/:orgId/*` (host-extension, non-normative)

---

## Context (boundaries audit first)

This is the **next recommended candidate** from the MyndHyve catalog: it was
*not* in the roadmap's explicit cuts, and MyndHyve's own dependency graph lists
**Publishing & SEO as a requirement of the CMS** — a feature openwop already
shipped (ADR 0009). The shipped CMS can mark a page `published` and read it back
by slug, but **only org members (`workspace:read`) can see it** — there is no
public web surface, sitemap, or SEO metadata. The CMS is value-incomplete
without this; Publishing turns "edit pages" into "publish pages to the web."

The audit confirms almost everything composes from existing primitives:

- **`cmsService.getPublishedBySlug(tenantId, orgId, slug)`** → `{ page,
  redirectedFrom? }`, published-only, follows one redirect hop. **`listPages`**
  for the sitemap/feed. The CMS data model is reused **unchanged** — no migration.
- **`getOrg(orgId)`** (accessControlService) yields the org's `tenantId` — how a
  public, unauthenticated visitor resolves which tenant's content to serve.
- **The public-route pattern already exists:** `PUBLIC_PATH_PREFIXES` in
  `middleware/auth.ts` (the media-asset serve route `GET …/assets/:token` is the
  blueprint). In strict/production mode the auth middleware **401s** an
  unauthenticated non-public path, so a reliably-public surface MUST be on that
  allowlist.
- **Media tokens** (ADR 0007) for OG images; **`boundedStrings.safeUrl`** for
  canonical URLs (the XSS-safe URL guard CMS/profiles already use).

What's **missing** (all new): per-page **SEO metadata**, the **public read
surface**, and **sitemap.xml / robots.txt / feed.rss** generation. No SEO
infrastructure exists anywhere today.

## Decision

A **new `publishing` feature-package** (toggle `publishing`, default OFF,
`bucketUnit: tenant`) that **composes** CMS rather than modifying it. CMS stays
focused on authoring; Publishing owns SEO metadata + the public distribution
surface — a cleanly separable concern (you can run CMS without a public site).

### Why a separate feature (not a CMS change)

SEO metadata is stored in a **publishing-owned store keyed by pageId**, NOT by
extending the CMS `Page` model — so ADR 0009 needs no migration and the two
features stay independently toggleable. The public surface **reads** the CMS
service; it never writes CMS data. The only core touch is the security
allowlist (below) — public-route authorization is a central auth decision, not
feature logic, so that is its correct home.

### The model

```
PageSeo { tenantId, orgId, pageId, metaTitle?, metaDescription?, ogTitle?,
          ogDescription?, ogImageToken?, canonicalUrl?, noindex, updatedBy, updatedAt }
```

Per-page SEO **overrides** — every field optional; the public read falls back to
the page's own `title` (and first richText/hero text) when a field is unset, so a
page is publishable with zero SEO config. `ogImageToken` is an opaque Media
token (ADR 0007); `canonicalUrl` is `safeUrl`-guarded; every string bounded +
secret-scrubbed.

### Phase 1 — SEO metadata store + authed CRUD (backend)

`publishingService` + `DurableCollection<PageSeo>('publishing:seo')` keyed
`(tenantId, orgId, pageId)`. Routes under
`/v1/host/sample/publishing/orgs/:orgId/pages/:pageId/seo`, `authorizeOrgScope`-gated
(GET `workspace:read`, PUT `workspace:write`). The pageId is validated to belong
to the org (compose `cmsService.getPage`) — a cross-page/org id fails closed.

### Phase 2 — Public surface (backend, unauthed)

Add `'/v1/host/sample/public'` to `PUBLIC_PATH_PREFIXES` (auth.ts) — the one
core edit, with a comment citing this ADR. Routes (no auth; org → tenant via
`getOrg`; **gated on the `publishing` toggle resolved for the ORG's tenant**, so
turning the feature off takes the site offline; **published-only**):

- `GET /v1/host/sample/public/:orgId/pages/:slug` — the published page (CMS
  content + merged SEO + computed canonical), 404 for non-published/unknown;
  follows the CMS redirect hop (returns `redirectedFrom`).
- `GET /v1/host/sample/public/:orgId/sitemap.xml` — published pages' public URLs
  + `lastmod`, XML-escaped, `noindex` pages excluded.
- `GET /v1/host/sample/public/:orgId/robots.txt` — allow + a `Sitemap:` line.
- `GET /v1/host/sample/public/:orgId/feed.rss` — RSS 2.0 of published pages,
  newest first, XML-escaped.

All generation is hand-rolled + XML/entity-escaped (no new deps); the toggle
gate + org-from-URL resolution are the security boundary (no member scope — the
content is *public by definition*, but only when its tenant has `publishing` on).

### Phase 3 — Frontend

`PublishingPage` as a `FrontendFeature` route, nav-gated on `publishing`: an org
picker → the org's **published** pages with their **public URLs** (copyable) +
quick links to the sitemap/feed, and a **per-page SEO editor** (meta/OG fields,
OG image from the Media Library, canonical, noindex) writing the Phase-1 API.
`publishingClient.ts`. The `npm run build` gate must pass.

## Architectural constraints honored

- **Compose, don't modify (ADR 0001 boundaries):** Publishing READS `cmsService`
  + `getOrg` + Media tokens; it owns only SEO metadata + the public surface. CMS
  (0009) is untouched — no `Page`-model migration, independently toggleable.
- **Public-by-org, fail-closed:** the public surface resolves tenant from the org
  in the URL and is gated on the org-tenant's `publishing` toggle; drafts are
  never served (`getPublishedBySlug` is published-only); `noindex` honored.
- **One justified core edit:** the `PUBLIC_PATH_PREFIXES` allowlist entry — public
  route authorization is a central auth-boundary decision (same pattern as the
  media serve route), not feature-distributable logic.
- **Content safety:** `canonicalUrl` is `safeUrl`-guarded; all SEO strings
  bounded + secret-scrubbed; sitemap/RSS output XML-escaped (no injection).
- **No wire surface → no RFC:** entirely under `/v1/host/sample/*`.

## Alternatives considered

1. **Extend the CMS `Page` model with SEO fields.** Rejected — couples two
   features, forces a 0009 migration, and makes SEO non-toggleable. A
   publishing-owned per-page store keeps them independent.
2. **Serve fully-rendered HTML from the backend** (server-side page render +
   inline OG/JSON-LD). Deferred — the openwop SPA renders sections client-side;
   the public API returns structured page+SEO JSON, and an SPA/renderer emits the
   `<head>` tags. Server-side HTML render + critical-CSS is a follow-on (it needs
   a section→HTML renderer, the same surface CMS deliberately kept client-only).
3. **Custom domains / SSL / static-export-and-deploy.** Deferred — real infra
   (DNS verification, cert provisioning, object hosting) beyond a demo host; the
   public URL is path-based (`/public/:orgId/...`) for now.
4. **Make the public surface always-on (ungated).** Rejected — gating on the
   org-tenant's `publishing` toggle is what makes "unpublish the site" possible
   and keeps an off-by-default feature actually off.

## Open questions

- [ ] **Server-side HTML render + inline `<head>`** (OG/JSON-LD/canonical) and
  critical-CSS for social/AI crawlers — needs a section→HTML renderer (alt. 2).
- [ ] **Custom domains + SSL + static export/deploy** (alt. 3) — real hosting infra.
- [ ] **A `site` entity** (multi-site per org) — would scope slugs/sitemap per
  site; ties to ADR 0009's open "slug uniqueness scope" question.
- [ ] **JSON-LD structured data** (FAQ/Pricing/WebPage) once typed section
  semantics are richer.
