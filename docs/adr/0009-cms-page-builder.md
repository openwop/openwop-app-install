# ADR 0009 — CMS + Page Builder

**Status:** Accepted (Phases 1–4 sequenced)
**Date:** 2026-06-09
**Depends on:** ADR 0004 (Organizations), ADR 0006 (RBAC scopes), ADR 0007
(Media Library — section assets)
**Owner of CMS data:** a NEW feature-package `src/features/cms/`.
**Surface:** `/v1/host/sample/cms/*` (host-extension, NON-NORMATIVE — no RFC).

---

## Context (boundaries audit first)

The content surface — the last roadmap feature. MyndHyve treats CMS and Page
Builder as an intended co-dependent pair, so they're one ADR. It needs **Media**
for section assets (ADR 0007) and **RBAC** for editorial access (ADR 0006), and
sits on **Orgs** (ADR 0004) — a page belongs to an org's site.

What already exists (so CMS does NOT duplicate it):

- **Org-scoped RBAC** is `featureRoute.authorizeOrgScope` (the gate media + crm
  share). CMS reuses it verbatim — read on `workspace:read`, content edits on
  `workspace:write`, and **editorial approval on `host:members:manage`** (the
  admin/owner tier) — a clean three-tier gate from existing scopes, no bespoke
  authority.
- **Media bytes + serving** is ADR 0007. Image/hero sections store a media-asset
  **token** (the page builder picks it from the Media Library); CMS stores the
  reference, never bytes.
- **Bounded-string cleaning + slugify**: `host/boundedStrings.ts` + a shared
  `host/slug.ts`. No 4th copy.

So CMS is a genuinely new surface (pages, sections, versions, redirects) layered
on orgs/RBAC/media — a self-contained content store, not a re-implementation.

## Decision

A `cms` feature-package (toggle `cms`, default OFF, `bucketUnit: tenant`) owns
org-scoped **Pages** (with section content), **page versions**, and **slug
redirects**, RBAC-gated and tenant+org IDOR-guarded.

### The editorial gate — RBAC, not a bespoke approval engine

The roadmap flags the workflow gate as the key decision (port MyndHyve's
always-on gate, or a toggle variant; the OpenWOP `approval` interrupt is "a
natural fit"). **Decision:** model the gate as an **RBAC-scoped state machine**,
not a bespoke gate and not (yet) a live interrupt run:

```
draft ──submit[workspace:write]──▶ in_review ──approve[host:members:manage]──▶ published
  ▲                                    │                                          │
  └──────────reject[host:members:manage]┘            archive[host:members:manage]─┘
draft ─────────────publish[host:members:manage] (admin direct-publish, bypasses review)
```

Editors (`workspace:write`) draft, edit, and **submit**; admins/owners
(`host:members:manage`) **approve / reject / publish / archive**. The gate is
always-on for editors (they cannot self-publish) and bypassable by admins (direct
publish from draft) — MyndHyve's always-on gate without forcing review on the
people who own the gate. **Why not the interrupt run now:** emitting an
`approval`-kind interrupt + suspending a run is a wire-adjacent integration; the
editorial *authority* is fully honored by RBAC here, and the interrupt-run
integration is recorded as a follow-on (Open questions) rather than blocking the
content surface.

### The model

```
Page    { pageId, tenantId, orgId, title, slug, status, sections: Section[],
          version, publishedVersion?, createdBy, updatedBy, createdAt, updatedAt }
Section { sectionId, type, data }            // schema-validated per type
PageVersion { versionId, pageId, version, snapshot, publishedBy, publishedAt }
Redirect { redirectId, tenantId, orgId, fromSlug, toSlug, createdAt }
```

**Core section set** (start small, not all 28): `hero { heading, subheading?,
imageToken? }`, `richText { html }`, `image { token, alt? }`, `cta { label, url }`,
`columns { columns: { text }[] }`. Each is validated against its type schema on
write — unknown type rejected, required fields enforced, strings bounded +
secret-scrubbed, `url` scheme-validated (the same XSS guard profiles links use),
`html` sanitized (script/dangerous-scheme stripped). `imageToken`/`token` are
opaque media-asset references (ADR 0007).

### Phase 1 — Pages + sections + slugs + RBAC

`cmsService` + `DurableCollection<Page>('cms:page')`. Routes under
`/cms/orgs/:orgId`: page CRUD (create draft / list / get / patch title+sections /
delete), schema-validated sections, a unique **slug** per org (slugified from the
title, collision-suffixed, editable). Read on `workspace:read`, write on
`workspace:write`. Per-org page cap. Route-harness tests.

### Phase 2 — Editorial workflow + public-by-slug read

The status state machine above (`POST …/pages/:id/{submit,approve,reject,publish,
archive}`), each gated by its scope and a legal-transition check (fail-closed).
`GET /cms/orgs/:orgId/pages/by-slug/:slug` returns ONLY a `published` page (drafts
are invisible by slug) — the read surface a renderer uses. Tests.

### Phase 3 — Versioning + redirects

On **publish**, snapshot the page into `cms:pageversion` (capped history);
`GET …/pages/:id/versions` lists them and `POST …/pages/:id/restore/:versionId`
(admin) restores a snapshot into the draft. Changing a published page's slug
records a `cms:redirect` (`fromSlug → toSlug`); the by-slug read **follows one
redirect hop** (308-style) so old links survive. Tests.

### Phase 4 — Page Builder frontend

`/cms` (lazy, nav-gated on `cms`): an org picker, a page list with status, a
**section editor** (schema-driven forms for the core set, with a Media-Library
token picker for image/hero), the workflow buttons (submit/approve/publish/…
shown by the caller's authority), and a live **preview** rendering the sections.
Registered in `FRONTEND_FEATURES`; the `npm run build` gate must pass.

## Architectural constraints honored

- **Boundaries / single source of truth:** orgs/roles in `accessControl`, bytes
  in Media, the RBAC gate + string/slug utils shared — CMS owns only pages/
  versions/redirects. Reuses `authorizeOrgScope` + `boundedStrings` + `slug`.
- **Editorial authority from RBAC (ADR 0006):** a three-tier gate
  (read/edit/approve) from existing scopes; editors cannot self-publish.
- **Tenant + org isolation (CTI-1):** every page/version/redirect read+write
  verifies tenantId AND orgId; cross-tenant/org access fails closed.
- **Content safety:** section `html` is sanitized and `url` scheme-checked before
  persistence (no stored XSS via page content — the lesson from the media review).
- **No wire surface → no RFC:** entirely under `/v1/host/sample/*`; section
  assets ride the already-accepted Media surface.

## Alternatives considered

1. **Wire the OpenWOP `approval` interrupt as the editorial gate.** Deferred —
   the editorial *authority* is fully delivered by RBAC; running an approval
   workflow + suspending/resolving an interrupt is a larger, wire-adjacent
   integration with no added authority for the content surface. Recorded as a
   follow-on.
2. **A generic `content-block` store shared with CRM custom fields.** Rejected —
   sections are a typed, ordered, render-targeted structure with their own
   schemas + sanitization; conflating them with CRM key/value custom fields would
   muddy both.
3. **All 28 MyndHyve section types now.** Rejected per the roadmap — start with a
   core five; the schema-driven validator + editor generalize to more types
   without a structural change.
4. **Port localization / personalization / SEO / comments.** Rejected per the
   roadmap's explicit cuts; each is a follow-on ADR.

## Open questions

- [ ] **Interrupt-backed approval.** Promote the RBAC gate to emit an
  `approval`-kind interrupt run (audited, resumable) when a deployment wants the
  full workflow-engine trail. The state machine is the seam.
- [ ] **Slug uniqueness scope.** Unique per (org) today; a multi-site-per-org
  model would scope slugs per site — revisit if a `site` entity lands.
- [ ] **Section-asset GC.** A media asset referenced only by an archived page
  version isn't reference-counted; Media's retention is independent. Revisit with
  a real storage backend.
- [ ] **Richer sections / schema registry.** Promote the inline per-type schemas
  to a registry when the set grows past the core five.
