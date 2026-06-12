# ADR 0027 — CMS-driven public front page + always-on content trio

**Status:** Accepted
**Date:** 2026-06-11
**Depends on:** ADR 0001 (feature-package architecture), ADR 0007 (Media),
ADR 0009 (CMS), ADR 0012 (Publishing & SEO — the public surface this rides on),
ADR 0015 (workspace = tenant)
**Amends:** ADR 0007, ADR 0009, ADR 0012 (their toggle becomes always-on — see
each file's correction note), ADR 0012 Alternative 4 (overturned — see below)
**Toggle:** none — `cms` / `media` / `publishing` are retired from the toggle
catalog (always-on, like Notifications per ADR 0010 § Correction)
**Surfaces:** existing authed `/v1/host/sample/{cms,media,publishing}/*` + the
existing **public (unauthed)** `/v1/host/sample/public/:orgId/*` (ADR 0012) +
a new **public SPA route tier** rendering `/` for anonymous visitors

---

## Context

`app.openwop.dev` has no marketing front page: `/` renders the Chat app for
everyone, and an anonymous visitor sees the product shell rather than a landing
page. MyndHyve (the porting baseline) renders its homepage **from its own CMS** —
a page authored as `slug: 'home'`, published, and served at `/` to anonymous
visitors via a lightweight public shell, with a hardcoded fallback when no
published home page exists (`src/pages/public/FrontPage.tsx`,
`src/pages/cms/hooks/useCmsPageContent.ts`).

This app already has every backend primitive to do the same — and ADR 0012
deliberately built the public-distribution half:

- **CMS (ADR 0009)** authors pages with typed sections + a draft→review→published
  workflow; `cmsService.getPublishedBySlug` reads a published page by slug.
- **Media (ADR 0007)** stores assets behind public serve tokens
  (`/v1/host/sample/assets/:token`, already on `PUBLIC_PATH_PREFIXES`).
- **Publishing (ADR 0012)** already serves published CMS pages to anonymous
  visitors at `GET /v1/host/sample/public/:orgId/pages/:slug` (sections + merged
  SEO + redirect-follow + content-safety), plus `sitemap.xml`, `robots.txt`,
  `feed.rss`.

The gaps are: (1) these three are toggle-gated **OFF** and surfaced in the main
workspace Sidebar — wrong altitude for back-office content tooling that should be
permanently available and live under Admin; (2) the SPA has **no public route**
that renders without the app shell; (3) there is no shared **section renderer**
(the CMS editor's `SectionPreview` is inlined and unexported); (4) there is no
**site-org designation** telling the front page whose published `home` page to
render.

## Decision

Four coupled moves:

1. **Make `cms` / `media` / `publishing` always-on.** Drop each feature's
   `toggleDefault`; they remain `BackendFeature`s for code organization but stop
   appearing in the toggle catalog (exactly the Notifications/Widgets shape, ADR
   0010 § Correction). Their routes drop the **toggle** gate while keeping the
   **org-scoped RBAC** gate (see § "Splitting toggle from RBAC"). Rationale: a
   reference app's content tooling is core, not an experiment; and the front page
   below must not silently 404 because someone flipped a toggle.

2. **Relocate their nav into a new admin `Content` group.** Flip each frontend
   route from `tier: 'workspace'` to `tier: 'admin'`, set `nav.group: 'Content'`,
   and **remove `featureId`** (always visible). Add `'Content'` to `GROUP_ORDER`'s
   admin tier. Sharing's nav also moves to `Content` for cohesion but **stays
   toggle-gated** (it composes KB; out of scope to make always-on) — proving
   `nav.group` is independent of toggle state.

3. **Add a public SPA route tier + a CMS-driven front page.** A new
   `tier: 'public'` renders **above `AppGate`** in a bare `PublicShell` (no
   Sidebar, no admin chrome, no auth requirement). At `/`, the SPA branches on
   auth: an anonymous visitor (when a site-org is configured) gets the
   `FrontPage`; a signed-in visitor gets today's Chat, unchanged. `FrontPage`
   fetches the configured site-org's published `home` page through the **existing**
   public Publishing API and renders its sections via the extracted shared
   `SectionRenderer`, falling back to hardcoded marketing content when the
   site-org is unset, the page is unpublished, or the API errors.

4. **Designate the site-org by config.** `VITE_PUBLIC_SITE_ORG_ID` (+
   `VITE_PUBLIC_SITE_HOME_SLUG`, default `home`) names the org whose published
   home page is the front page. Unset ⇒ no front page (so dev / white-label
   deploys keep `/` = app, unchanged).

### Splitting toggle from RBAC

`authorizeOrgScope` (`features/featureRoute.ts`) bundles the toggle gate
(`requireFeatureEnabled`) **and** the cross-tenant/scope guard. To keep the guard
a single source of truth (its own docstring warns it "can't drift between
features"), extract the RBAC core into **`requireOrgScope(req, scope)`**;
`authorizeOrgScope` becomes `requireFeatureEnabled + requireOrgScope`. The three
always-on features call `requireOrgScope` directly — **no inlined copy** of the
IDOR/scope guard. Toggle-gated features keep calling `authorizeOrgScope`
unchanged.

### Public exposure is now `published`-gated — overturning ADR 0012 Alt 4

ADR 0012 Alternative 4 **rejected** an always-on (ungated) public surface, reasoning
that the per-tenant `publishing` toggle is what makes "unpublish the site"
possible. With Publishing always-on we drop the toggle assert in
`resolvePublicOrg`. **This is deliberate and safe in this app's model:** the CMS
editorial **`published` status is the real public gate** — unpublishing a *page*
(or archiving it) removes it from the public surface (`getPublishedBySlug` is
published-only), and **Sharing (ADR 0013)** is the mechanism for private /
unguessable / draft access. The per-tenant master switch was redundant with the
per-page status. Trade-off accepted: a tenant's **published** CMS pages are
world-readable at `/v1/host/sample/public/:orgId/...` without a separate opt-in.
White-label guidance (also added to FEATURES.md): *published CMS pages are public;
use Sharing for private or draft access.*

### Front page renders above AppGate (reachability)

`PublicShell` mounts **outside** `AppGate` so a deployment running `appGate` mode
`sign-in` / `password` cannot make its own marketing page unreachable (the gate
would otherwise redirect anonymous `/` to a sign-in screen). The in-shell route
table changes from `tier !== 'admin'` to `tier === 'workspace'` so public-tier
entries never double-render inside the gated shell; public-tier routes carry no
`nav`, so they're absent from the Sidebar, admin rail, and ⌘K automatically.

### Retiring orphaned toggle overrides

`getEffectiveConfig` reads a durable store override **before** the registered
default, so a previously-saved per-tenant `cms`/`media`/`publishing` override
would survive `toggleDefault` removal — leaving `resolveOne` returning stale state
and a **ghost toggle** in the admin panel (`listEffectiveConfigs` unions store
over defaults). `registerBackendFeatures` runs a one-time, idempotent reconcile
deleting stored overrides for an explicit `RETIRED_TOGGLE_IDS =
['cms','media','publishing']` set (logged; never touches a live toggle).

## Architectural constraints honored

- **Compose, don't modify (ADR 0001):** the front page consumes the **existing**
  public Publishing API — no new public read path, no duplication of the
  published-only / content-safety / redirect projection ADR 0012 already owns.
- **Single source of truth for RBAC:** `requireOrgScope` is the one cross-tenant
  guard; no copy-paste into the three route files.
- **Fail-closed authz unchanged:** dropping the *toggle* gate does not relax the
  *RBAC* gate — every authed route still resolves the caller, verifies org∈tenant
  (404/IDOR), and requires its scope (403). Admin-menu placement is cosmetic IA,
  not an auth change (workspace members may still author content).
- **No `ctx` surface affected:** `cms`/`media`/`publishing` declare **no** ADR 0014
  workflow surface and advertise no `host.sample.<id>` capability, so
  `/.well-known/openwop` and `featureSurfaces` gating are untouched. (Corrects a
  stale FEATURES.md note that called CMS/Media FeatureModules.)
- **Replay/fork safe:** these toggles carry no variants and stamp nothing on a
  run; `:fork` against historical checkpoints is unaffected.
- **No wire surface → no RFC:** everything is under `/v1/host/sample/*` (+ the SPA)
  — non-normative host-extension surface.

## Phases

| Phase | Goal | Key files |
|---|---|---|
| 1 — Backend always-on | drop 3 `toggleDefault`s; `requireOrgScope` split; drop the publishing public toggle assert; boot reconcile of retired overrides | `features/{cms,media,publishing}/feature.ts`, `features/{cms,media,publishing}/routes.ts`, `features/featureRoute.ts`, `features/publishing/publishingService.ts`, `features/index.ts` |
| 2 — Admin Content nav | flip tier→admin, group→Content, drop featureId; `GROUP_ORDER`; Sharing nav→Content | `features/{cms,media,publishing,sharing}/routes.tsx`, `chrome/features.tsx`, `chrome/featureTypes.ts` |
| 3 — Shared renderer | extract `SectionRenderer` from `CmsPage`; safe-markdown richText | `features/cms/SectionRenderer.tsx`, `features/cms/CmsPage.tsx` |
| 4 — Public front page | `public` tier, `PublicShell`, `FrontPage`, site client, `App.tsx` auth-branch, env | `features/site/*`, `chrome/PublicShell.tsx`, `App.tsx`, `.env.production` |
| 5 — Seed + docs | seed a `home` page for the site-org; FEATURES.md; correction notes | `FEATURES.md`, `docs/adr/{0007,0009,0012}-*.md` |

## Alternatives considered

1. **A new always-on public read on CMS** (instead of reusing Publishing).
   Rejected — duplicates ADR 0012's published-only filter, XML/RSS escaping, and
   SEO projection; two public surfaces that would drift.
2. **Keep Publishing toggle-gated, turn it ON for the site-org only.** Rejected —
   inconsistent (its dependencies CMS/Media become always-on) and the front page
   would silently 404 if the toggle were flipped.
3. **Front page always at `/`, move Chat to `/chat`.** Rejected by the maintainer
   in favor of the auth-branch (signed-in `/` stays Chat; no deep link moves).
4. **Add marketing-oriented section types** (pricing/testimonials/FAQ) now.
   Deferred — additive; the front page ships with the existing 5 typed sections
   (hero/richText/image/cta/columns) and a safe-markdown richText.

## Open questions

- [ ] Server-side render / prerender of the front page `<head>` for crawlers
  (today: client-side meta + the server-side sitemap/robots/RSS from Publishing).
- [ ] Marketing section types (alt. 4) once the front page proves out.
- [ ] Multi-page public site (about/pricing at `/p/:slug`) via the same
  `PublicShell` + `tier: 'public'` seam.

## Amendment (2026-06-12): runtime, UI-managed front-page config

The original decision #4 designated the site-org via the **build-time** env vars
`VITE_OPENWOP_FRONTPAGE_ORG_ID` / `_SLUG` (inlined into the bundle — changing the
front page meant a rebuild + redeploy). Per maintainer request, this is replaced
by **runtime configuration through the UI**; the env vars are demoted to an
**optional build-time fallback** (used only when no runtime config is set — handy
for headless / IaC deploys).

**New surface:**
- A durable singleton `siteConfig` — `{ enabled, orgId, slug, updatedBy, updatedAt }`
  (`host/siteConfig/service.ts`), mirroring the feature-toggle store.
- `GET /v1/host/sample/public-site-config` — **unauthed** (on `PUBLIC_PATH_PREFIXES`),
  returns only `{ enabled, orgId, slug }` (all already public — they appear in the
  public page URL; no tenant data or secrets).
- `GET` / `PUT /v1/host/sample/site-config` — **superadmin-gated**, reusing the
  feature-toggle gate (`isSuperadmin`, exported from `routes/featureToggles.ts`).
  `PUT` validates that an *enabled* config points at a real org (404 otherwise).
- Admin screen **Admin → Content → "Front page"** (`/front-page`,
  `site/FrontPageSettingsPanel.tsx`): enable toggle + org picker + slug + an inline
  preview of the chosen published page (a signed-in admin can't see the live `/`
  front page, which shows the app for them).

**Resolution order (frontend):** runtime `public-site-config` (if `enabled`) →
build-time env fallback (if set) → off. The App-root gate resolves this pointer at
runtime for an anonymous visitor on `/` (cached per load; folded into the existing
auth-resolution splash).

**Safety:** the public read leaks nothing new (org id + slug are already public);
the write is superadmin-only and fail-closed; pointing the front page at an org
only chooses which *already-world-readable* published page is the root face — no
new data exposure, validated to an existing org, and degrading to fallback content
if the page is later unpublished.

### Default-ON with a built-in pre-baked home page (2026-06-12)

The front page now ships **ON by default** with a built-in, brand-aware marketing
page — `/` works out of the box for anonymous visitors with no seeding or config.

- `getSiteConfig()` defaults `enabled: true` (overridable by
  `OPENWOP_FRONTPAGE_DEFAULT_ENABLED=false` for a white-label fork that wants `/`
  to be the app by default). A superadmin's saved config always wins.
- An enabled config with **no `orgId`** ⇒ the SPA renders `DEFAULT_SECTIONS`
  (`features/site/FrontPage.tsx`) — a real hero/value-props/CTA page authored in
  the same typed-section model as a CMS page (uses `brand.*`, so a fork shows its
  own name/tagline). Pointing the front page at a CMS `home` page (admin UI or env)
  replaces it; no fake org is seeded (a boot-seeded org would live in a system
  tenant the real superadmin can't edit cross-tenant, so built-in content is the
  honest default).
- Frontend precedence: admin-configured org → env org (`VITE_OPENWOP_FRONTPAGE_ORG_ID`)
  → built-in page. A superadmin **disable** wins over the env.

### Super-admin-editable homepage via a reserved system site (2026-06-12, Option A)

PROBLEM: a homepage pointed at an arbitrary org's CMS page (the prior amendment)
wasn't editable by the super admin unless that org was in the super admin's
tenant — CMS editing is org-scoped (`requireOrgScope` enforces
`org.tenantId === caller.tenantId`). The homepage is host-level content, so it
needs host-level authority, not tenant membership.

DECISION (mirrors MyndHyve's global `cms_pages/home` gated by `isSuperAdmin()`):
the homepage is a normal `cmsService` page in a RESERVED system org `host-site`
under a reserved tenant `host:site` — a `host:` prefix no auth path mints (users
get `user:` / `anon:` / `ws:`), so the org is invisible to and uneditable by every
real tenant. A super admin edits it via a dedicated, `requireSuperadmin`-gated
route `GET/PUT /v1/host/sample/site-page` that drives `cmsService` on the reserved
site — **bypassing `requireOrgScope` only for that one reserved org**, never as a
broad cross-tenant override (`requireOrgScope` is untouched; every real tenant's
isolation is intact). The reserved org + a published `home` page are seeded
idempotently (`host/systemSite.ts`, deterministic ids). The public front page is
served by the existing public Publishing API (`/public/host-site/pages/home`,
published-only) — unchanged. `siteConfig` reduces to a single on/off switch; the
content is always the system page.

This is NOT a parallel page system: it instantiates the REAL primitives
(`accessControl.createOrg` + `cmsService`) rather than shadowing them with a fake
id (per the `no-parallel-architecture` rule). The only new thing is the AUTHORITY
(host-level super admin vs org-scoped RBAC).

- Reject — relax `requireOrgScope` for super admins (cross-tenant CMS everywhere):
  too broad; expands a role's authority across every org-scoped feature for a
  homepage requirement. Narrow per-reserved-org authority is least-privilege.
- Reject — a separate host-level page store: duplicates the CMS (two page systems).

Net: out of the box `/` serves a seeded, **super-admin-editable** homepage
(Admin → Content → "Front page", reusing the shared `SectionsEditor`), regardless
of any tenant. No env, no per-tenant pointer.
