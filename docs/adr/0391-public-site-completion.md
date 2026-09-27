# ADR 0391 — Public-site completion (blog taxonomy + public pricing + marketing/legal seed set)

**Status:** implemented (2026-07-17)
**Date:** 2026-07-17
**Depends on:** ADR 0009 (CMS — pages + typed sections + editorial gate + tags),
ADR 0012 (Publishing & SEO — the public surface + `feedRss`/`sitemapXml`),
ADR 0027 (CMS front page + public SPA route tier — `PublicShell` / `SectionRenderer`
/ `/p/:slug` / site-org config), ADR 0176 (Subscriptions & Billing — the plan-tier
config the pricing page reads), ADR 0007 (Media — OG/section assets)
**Relates to:** ADR 0384 (SEO crawler prerender + JSON-LD — *in flight*; this ADR's
public surfaces gain crawler-facing SEO when 0384 covers them — see § "ADR 0384
dependency"). ADR 0383 is the exemplar for additive first-class fields on a KV-blob
model with no SQL migration.
**Toggle:** none new — rides the **always-on** `cms` / `publishing` / `site`
surfaces (ADR 0027) and billing's existing `billing` toggle (ADR 0176).
**Surfaces:** existing authed `/v1/host/openwop-app/{cms,publishing,billing}/*` +
the existing **public (unauthed)** `/v1/host/openwop-app/public/*` tier
(host-extension, NON-NORMATIVE — no RFC) + new public SPA route trees `/blog/*`
and `/pricing`.

---

## Context

`app.openwop.dev` can already author, publish, and serve CMS pages to anonymous
visitors on the public surface (ADR 0012 + 0027). The MyndHyve gap analysis
(`docs/steward/MYNDHYVE-GAP-ANALYSIS.md`, public-content domain) isolates three *content*
gaps — not engine gaps — that together complete the "MyndHyve markets itself"
surface so the openwop-app core can serve myndhyve.ai's public site:

- **Blog discovery taxonomy (P1.6, PARTIAL → M).** CMS pages carry `tags` with a
  tag filter (`cmsService.ts:341`) and Publishing emits a generic `feed.rss` of
  *all* published pages, but there is **no blog post-type, no category/author/tag
  archive routes, no discovery UI, and the RSS is not blog-scoped or
  author-enriched** (evidence rows: gap analysis lines 127–128).
- **Public pricing page (P0.4, PARTIAL → M).** Plan tiers exist as operator
  config (`billingService.ts` `PlanTier` + `planFeatures`/`planLimits`), but the
  only pricing surface is the **authed** `BillingPage` — there is **no public
  `/pricing` marketing route** (gap analysis line 183).
- **Marketing + legal page set (P0.5, S).** The mechanism is proven (`home` +
  `/p/features` are host-global system-site pages; `demoContentMarketingSeed.ts`
  seeds a 6-page per-tenant site), but the **standard marketing set
  (about/careers/press/contact/community/support/changelog/roadmap) and the
  16-page legal suite are not seeded** (gap analysis lines 125–126).

These three are *tightly coupled*: the blog, pricing, and marketing/legal pages
are all "the deployment's own public content," all ride the same public surface,
all layer on the same always-on CMS/Publishing/site machinery, and all realize
their SEO value through the same ADR 0384 prerender. Bundling them as **one
extension ADR** (rather than three) keeps the boundary discipline in one place
and avoids three near-identical "how does content reach the public surface"
rationales. This ADR adds **no new feature-package** — it is a taxonomy layer +
two public reads + one seeder over existing owners.

---

## Boundaries audit (who owns what — with `file:line`)

The whole design is "compose, don't duplicate" (ADR 0001; the *No parallel
architecture* memory). Every new capability has a single existing owner it layers
onto:

| Concern | Owner (today) | Evidence | This ADR's layer |
|---|---|---|---|
| Pages, typed sections, `tags`, editorial gate, versions, locale overlays, slug redirects | **`cms`** | `features/cms/cmsService.ts` — `Page` model `:76`, `PageStatus` `:49`, `tags` `:86`, `listPages`+`PageListFilter` `:326–347`, `getPublishedBySlug` `:953`, fixed-`pageId` idempotency `:366` | **A blog post is a Page.** Add optional post facets (`kind`/`authorId`/`category`) to the `Page` model and a `kind` filter to `listPages`. **No parallel blog store.** |
| Public read surface + `sitemap.xml` / `robots.txt` / `feed.rss` | **`publishing`** | `features/publishing/publishingService.ts` — `feedRss` `:230`, sitemap 50k cap `:33–35`, `capPublic`/`escapeXml`/`pageUrl`/`listPublishedWithSeo` | **The blog feed is a scoped variant of `feedRss`** (filter `kind:'post'`, add `dc:creator` + `<category>`), sharing the same escaper/cap/URL builders. **Not a second generator.** Posts are pages ⇒ already in `sitemap.xml` under the same 50k cap. |
| Public SPA rendering (bare shell above the auth gate) | **`site`** (frontend) | `frontend/react/src/features/site/publicPageRoute.ts` (`matchPublicPageSlug`), `chrome/PublicShell`, `features/cms/SectionRenderer.tsx`, `App.tsx` `/p/:slug` `:143` | Add `/blog/*` and `/pricing` route trees in `PublicShell`; render posts + a new `pricing` section via the existing `SectionRenderer`. |
| Plan-tier catalog (features, limits, price→tier map) | **`billing`** | `features/billing/billingService.ts` — `PlanTier` `:27`, `planFeatures` `:143`, `planLimits` `:159`, `resolveEntitlements` `:128`, price map `:79` | **The pricing page READS tier config; it never re-declares prices.** A new public billing read exposes display-safe tier data. |
| Host-global system-site content (deployment's own pages) | **host** | `host/systemSite.ts` (`SYSTEM_SITE_TENANT='host:site'` `:30`, `ensureSystemSite`), `host/featuresPage.ts` (`ensureFeaturesPage` `:173`, deterministic pageId), `host/exampleDataSeeders.ts` (`ExampleDataSeeder` `:97`, `cmsHomepageSeeder` `:190`, `featurePagesSeeder` `:251`) | The marketing/legal set is **one seeder** in this registry, emitting host-global **DRAFT** system-site pages — same shape as `home`/`features`, but draft (operator publishes). |

**The load-bearing gap the audit surfaced:** billing config maps a Stripe
`priceId → PlanTier` (`billingService.ts:79`) but carries **no human-facing
display price** — `resolveEntitlements` returns tiers, feature allowlists, and
usage limits, never a dollar figure. So a public pricing page **cannot** read a
real price from today's config. This drives the "honest-when-unconfigured" design
below (a new marketing-only display config + demo-mode fallback that never
fabricates a price).

---

## Decision

Three coupled layers, each on its existing owner. **No new feature-package, no new
toggle, no migration.**

### (a) Blog taxonomy over CMS pages

**Post-type mechanism — a `kind` discriminator on the `Page` model.** Add three
optional, additive fields to `cms` `Page` (KV blob ⇒ no SQL migration, backward
compatible — absent means "an ordinary page," exactly the ADR 0383 pattern):

```
Page {
  …existing…
  kind?: 'page' | 'post';   // absent ⇒ 'page'
  authorId?: string;        // a principal/profile ref; meaningful only for posts
  category?: string;        // single primary section (slugified); posts only
}
```

- **`kind`** is the structural discriminator. `listPages` gains an optional
  `kind` filter (it already narrows by `tag`/`status`/`q` — one more predicate,
  same IDOR-safe "narrow-never-widen" contract, `cmsService.ts:331`). "The blog"
  is `listPages(kind:'post', status:'published')`.
- **`authorId`** resolves to a display byline + RSS `dc:creator` via the existing
  **profiles** service (the `demo-people` seeder already creates users+profiles);
  falls back to the page's `createdBy` profile when unset. No freeform author
  string (that would be a second source of truth).
- **`category`** is the single primary section (distinct from the many
  cross-cutting `tags`); it powers the `/blog/category/:cat` archive as a genuine
  view rather than a tag alias.

**Archive routes + discovery UI (public SPA, `site`).** First-class dedicated
route trees in `PublicShell` (they are *structured taxonomy views* backed by list
queries, not raw single-page renders, so they need their own components + data —
a bare-slug catch-all could not serve them):

- `/blog` — the post index (published posts, newest first, paginated).
- `/blog/tag/:tag`, `/blog/category/:cat`, `/blog/author/:id` — filtered archives.
- `/blog/:slug` — a post (rendered via `SectionRenderer`, with a byline +
  category/tag chips + published date in the post chrome).

On `app.openwop.dev` the blog is the configured **site-org's** posts (reusing
ADR 0027's `VITE_PUBLIC_SITE_ORG_ID`); any org's published posts are equally
servable at `/public/:orgId/blog` (consistent with the existing public surface).

**Public backend reads (`publishing`/`public` tier, unauthed, published-only).**
The `/v1/host/openwop-app/public` prefix is already on `PUBLIC_PATH_PREFIXES`
(ADR 0012); these compose `cmsService.listPages` + `getPublishedBySlug`:

- `GET /public/:orgId/blog?tag=&category=&author=&cursor=` — published posts
  (list projection: id/slug/title/author/category/tags/excerpt/date), org→tenant
  via `getOrg`, uniform 404 for unknown org, **never** section bodies of drafts.
- `GET /public/:orgId/blog/feed.xml` — the **blog-scoped enriched RSS**: a scoped
  variant of `feedRss` (`publishingService.ts:230`) filtering `kind:'post'`,
  declaring `xmlns:dc`, and emitting `<dc:creator>` (author display name) +
  `<category>` per tag/category. Shares `capPublic`/`escapeXml`/`pageUrl` — one
  generator, parameterized; **not** a second RSS path.

**Sitemap inclusion.** Posts are pages, so they already appear in the existing
`sitemap.xml` under the same **50k-URL cap** and `noindex` exclusion
(`publishingService.ts:33–35`) — no separate sitemap, no cap divergence.

### (b) Public pricing page

**A typed `pricing` CMS section type** (new section in the `cms` type set), so the
pricing page **is a CMS page** — the operator can wrap the tier grid with
marketing copy, an FAQ, and a CTA, and it renders through the one
`SectionRenderer` (no second rendering path). The section's `data` names *which*
tiers to show + heading + CTA target; it carries **no prices** — the live tier
data comes from a public read (billing stays the owner):

- `GET /public/pricing` (host-global, unauthed, on `PUBLIC_PATH_PREFIXES`; owned
  by `billing`) → the display-safe tier catalog: `{ tier, name, features
  (planFeatures), limits (planLimits), display? }`. It **never** leaks
  `stripePriceId`. Fail-closed: returns the static tier list (free/pro/team/
  enterprise) even when `billing` is off — the tiers are marketing facts, not
  entitlements.

**Honest-when-unconfigured (demo mode) — the load-bearing constraint.** Because
no display price exists in config today, add an **optional marketing-only**
operator config, read *only* by this surface:

```
OPENWOP_BILLING_PLAN_DISPLAY = {"pro":{"price":"$29","cadence":"/mo","blurb":"…","highlighted":true}, …}
```

- **Configured** ⇒ the tier card shows the operator's price/cadence/blurb.
- **Unconfigured** ⇒ the card shows the tier name + its feature/limit list + a
  neutral CTA ("Get started" / "Contact sales"), and **never fabricates a
  dollar figure**. This is the demo-mode default on `app.openwop.dev`.

> **Correction note (2026-08-07, UX_UPGRADE-site round 2 / R2-G7):** the per-tier
> display entry gained an **additive annual price shape** —
> `priceAnnual`/`cadenceAnnual` (40-char bound each) + `annualNote` (80-char
> bound, the operator's OWN discount claim rendered verbatim, never a computed
> percentage). When any shown tier authors `priceAnnual`, the public pricing
> section renders a monthly/annual toggle (annual default); a tier without one
> keeps its single authored price + its own cadence string in both modes, and
> with no annual price anywhere the toggle does not render — the original
> single-price contract above is unchanged. Round 1 deferred this as G9
> ("blocked on billing display config"); the blocker was this one additive
> field pair, not a billing-system change.

Prices are *never* baked into the section or the SPA — the section READS the
billing read, billing owns the config (mirroring ADR 0176's "no baked price IDs"
invariant on the marketing side).

**Route + CTA.** A first-class public SPA route `/pricing` (in `PublicShell`,
above `AppGate`) renders the system-site org's `pricing`-slug page. The tier CTA
routes to sign-in (anonymous) or the authed `/billing` checkout (signed-in) —
**no checkout on the public page** (marketing surface only).

### (c) Marketing + legal seed content

**One seeder** in `host/exampleDataSeeders.ts` (the `cmsHomepageSeeder` /
`featurePagesSeeder` shape), emitting the standard set as host-global
**system-site** (`SYSTEM_SITE_TENANT`/`SYSTEM_SITE_ORG`) CMS pages:

- **Marketing (8):** about, careers, press, contact, community, support,
  changelog, roadmap.
- **Legal (16):** privacy, terms, dpa, aup, cookies, ai-addendum, api-terms,
  marketplace-terms, dmca, subprocessors, security, sla,
  vulnerability-disclosure, accessibility, support-terms, rbac-policy.

Rules:

- **Seeded as `draft`** (not published) — the operator reviews and publishes. The
  editorial gate (ADR 0009) is respected: seeds land in `draft`, an admin
  publishes. This differs deliberately from `home`/`features` (which seed
  published) because this content is the *operator's* voice + legal exposure.
- **Legal bodies are placeholder-marked** — each legal page's body carries an
  explicit `[PLACEHOLDER — review by counsel before publishing]` banner and
  structural headings, **never fabricated binding legal text**. Marketing pages
  get honest starter copy the operator edits.
- **Idempotent** via deterministic `pageId`s (the `createPage` fixed-`pageId`
  convergence `cmsService.ts:366` + the `ensureFeaturesPage` ensure pattern) —
  re-running seeds nothing new; a `seedLock`-style guard prevents cross-instance
  double-seed.
- **`clear()` is host-global, non-destructive per-tenant** (like the home/features
  seeders) — it never removes deployment-wide public content on a per-tenant
  clear.

### Position on "widen `/p/:slug` to bare `/:slug`" (ADR 0027 open item)

**Rejected — keep `/p/:slug` for the general marketing/legal set.** The `/p/`
prefix namespaces public CMS pages away from app routes. Widening to bare
`/:slug` turns *every* top-level path into a CMS lookup, colliding with existing
app routes (`/agents`, `/chat`, `/store`, `/billing`, …) and every future feature
route, and forces a per-request "is this a page or an app route?" disambiguation
with an ordering hazard. The marketing appeal of vanity URLs is real but belongs
to **custom domains** (an ADR 0012 deferral) or explicit redirects, not to
overloading the root matcher. Blog and pricing are the exception: they get
**dedicated route trees** (`/blog/*`, `/pricing`) precisely because they are
structured surfaces (taxonomy queries / billing config), not raw page renders —
so they never touch the bare-slug question.

### ADR 0384 dependency (SEO value)

These public routes render client-side today; their **crawler-facing** value
(social unfurls, AI-crawler bodies, JSON-LD) lands when **ADR 0384** (SEO
prerender + JSON-LD, in flight) covers the new routes: `Article`/`BlogPosting`
JSON-LD for `/blog/:slug`, `Product`/`Offer` for `/pricing`, `WebPage` for the
marketing/legal set. The three layers here **function without 0384** (SPA-rendered
for human visitors); they gain crawler SEO when 0384 ships. Sequencing note: seed
(c) can precede 0384; the prerender simply picks the pages up.

---

## Full Feature Evaluation Matrix

| # | Dimension | Verdict for this ADR |
|---|---|---|
| 1 | **Feature-package architecture (ADR 0001)** | **Extension, no new package.** Blog = additive `Page` facets + a `listPages` filter in `cms` + a scoped `feedRss` variant in `publishing` + route trees in `site`. Pricing = a `cms` section type + a `billing` public read + a `site` route. Seed = one `host` seeder. Every capability has a single existing owner; no shadow store (the *No parallel architecture* invariant). |
| 2 | **Toggle + admin UI** | **No new toggle.** Rides always-on `cms`/`publishing`/`site` (ADR 0027) and billing's existing `billing` toggle. Authoring uses the always-on CMS editor (a post is a page with `kind:'post'`); the pricing display config is operator env (`OPENWOP_BILLING_PLAN_DISPLAY`), surfaced read-only. No feature-toggle catalog change. |
| 3 | **Public surface** | New reads on the existing `/v1/host/openwop-app/public/*` tier (already on `PUBLIC_PATH_PREFIXES`): `/public/:orgId/blog`, `/public/:orgId/blog/feed.xml`, `/public/pricing`. New SPA routes `/blog/*`, `/pricing` in `PublicShell` above `AppGate`. **Published-only**, org→tenant via `getOrg`, **uniform 404** for unknown/unpublished (mirrors ADR 0012). No draft/private leak; blog list is a projection (never draft section bodies). |
| 4 | **Workflow + node packs** | **No new node pack; one honest touch.** The `feature.cms.nodes` pack (`get-page`/`list-pages`/`update-section-draft`/`submit-page`) already authors pages through the editorial gate — a post is a page, so authoring rides it unchanged. `list-pages` MAY gain a `kind` filter input (additive, same surface); the create/update path accepts the new optional facets via the existing route. No new verbs; publish stays a human/route action (the pack can draft+submit, never publish). |
| 5 | **AI-chat envelopes + agent packs** | **Nothing new — honest answer.** Blog-post authoring rides the *existing* CMS authoring path (the `cms` tools/nodes above); a post is a page, not a new artifact/component/envelope KIND. No `schema.request` envelope-kind, no new agent pack, no new chat tool. (Per the CLAUDE.md three-lane rule, node/artifact schemas are tool asks, never envelope kinds — and here even the tool surface is unchanged but for an optional `kind` filter.) |
| 6 | **RBAC** | **Unchanged.** Authoring keeps the ADR 0009 three-tier gate (edit `workspace:write`, publish `host:members:manage`) via `requireOrgScope`. The public reads are *public by definition* (published-only, no member scope) — the CMS `published` status is the gate (ADR 0027). `/public/pricing` exposes only marketing-safe tier data (no `stripePriceId`, no entitlements). |
| 7 | **Replay / fork safety** | **N/A.** No run-event shape, no envelope, no capability handshake — these are HTTP reads over durable CMS/billing state + a content seeder. The one node touch (`kind` filter on `list-pages`) is a role:action read whose recorded result replays unchanged (existing `cms.nodes` contract). |
| 8 | **Frontend + i18n** | New surfaces: blog discovery UI (index + tag/category/author archives + post view), the `pricing` section renderer + `/pricing` page, and post chrome (byline/date/chips). **All visible strings localized ×4** (en/es/fr/de) — 4-locale parity is a FATAL build gate (frontend memory). Designed empty states: an empty `/blog`, and a demo-mode pricing card (no price, feature list + neutral CTA). Uses `ui/` primitives + tokens (no raw hex; the CSS-integrity gates). |
| 9 | **Data / persistence / migration** | **No SQL migration.** The `Page` facets (`kind`/`authorId`/`category`) are optional fields on a KV JSON blob — absent ⇒ backward-compatible (ADR 0383 precedent). Seeded pages are ordinary `cms:page` rows (deterministic ids). Pricing display config is env-only. No new store, no backfill. |
| 10 | **RFC gate** | **Host-extension, no wire RFC.** All routes live under `/v1/host/openwop-app/{public,billing}/*` (non-normative). No new run-event field, capability flag, event type, endpoint contract, or normative MUST touches the OpenWOP wire. The blog RSS/sitemap are hand-rolled XML on the host surface. See § "RFC verdict." |

---

## Phased implementation plan

Loosely coupled; recommended order **(a) → (b) → (c)** per the port sequencing.
(a) and (c) are independent of each other; (b) is independent of both. All three
realize crawler SEO through ADR 0384 when it lands.

- **Phase (a) — Blog taxonomy.** `cms`: add `kind`/`authorId`/`category` to `Page`
  + `cleanPageTags`-style validation + a `kind` filter on `listPages`; resolve
  bylines via profiles. `publishing`: the scoped `blog/feed.xml` variant of
  `feedRss` + the `/public/:orgId/blog` list read. `site`: the `/blog/*` route
  tree + discovery UI + post chrome; SectionRenderer post view; i18n ×4. Tests:
  the blog-scoped RSS filters `kind:'post'` and emits `dc:creator`/`category`; the
  public list never returns drafts; `promptCatalogParity`/`agent-prompt-tool-ids`
  stay green if the `list-pages` node gains a `kind` input.
- **Phase (b) — Public pricing.** `cms`: the `pricing` section type + validation.
  `billing`: the `/public/pricing` read + `OPENWOP_BILLING_PLAN_DISPLAY` parsing
  (fail-open to demo mode). `site`: the `/pricing` route + pricing section
  renderer + CTA wiring; i18n ×4. Tests: **unconfigured display ⇒ no fabricated
  price** (renders tier + feature/limit list + neutral CTA); `stripePriceId`
  never present in the public payload.
- **Phase (c) — Marketing + legal seed set.** One `ExampleDataSeeder` (8 marketing
  + 16 legal) as host-global DRAFT system-site pages; deterministic ids;
  placeholder-marked legal; register in `exampleDataSeeders.ts`. Tests:
  idempotent re-seed (0 net-new on second run); legal pages carry the counsel
  placeholder; pages land `draft`, not `published`. **Note the ADR 0384 prerender
  dependency** for their SEO value in the phase's landing note.

---

## Alternatives weighed

1. **A separate `blog` feature-package.** *Rejected.* `cms` owns content; a
   parallel post store would duplicate the page model, the editorial state
   machine, versioning, locale overlays, and the public surface — and would drift.
   A blog is a **taxonomy view over pages**, not a second content system (the *No
   parallel architecture* memory; ADR 0012's "compose, don't modify").
2. **Tag-convention post-type** (a reserved `post` tag or a `blog/` slug prefix).
   *Rejected.* `tags` are user-authored labels; overloading them as the structural
   discriminator is fragile (a page tagged "pricing" is not a pricing page) and
   can't be queried honestly. A `kind` field is the minimal explicit discriminator.
3. **A general `collection` string instead of a `kind` enum.** *Rejected as
   YAGNI.* Blog is the one collection the port needs; a two-value `kind` enum
   extends to a third value if a second collection ever appears, without inviting
   an open-ended, unvalidated collection namespace now.
4. **A hardcoded `PricingPage` component** reading a billing endpoint. *Rejected
   in favor of a `pricing` CMS section type.* The section keeps pricing a CMS page
   (operator-editable marketing copy around the tiers) on the single
   `SectionRenderer` path; a hardcoded page fragments rendering and can't be
   edited without a deploy.
5. **Fetch live display prices from Stripe Price objects** for the pricing page.
   *Rejected (deferred).* It couples the public, offline-capable marketing page to
   a Stripe API round-trip and key; a static operator display config
   (`OPENWOP_BILLING_PLAN_DISPLAY`) is simpler, cache-friendly, and honest in demo
   mode. Revisit if operators want single-source-of-truth pricing.
6. **Widen `/p/:slug` to bare `/:slug`.** *Rejected* — see § "Position on…"
   (root-matcher collision surface); vanity URLs belong to custom domains/redirects.
7. **A freeform author byline string.** *Rejected* in favor of `authorId → profile`
   (one source of truth, reuses the profiles the demo seeder already creates).

---

## Open questions & assumptions

- **Display prices (assumption).** No display-price config exists today
  (`billingService.ts` maps `priceId → tier` only). This ADR assumes a new
  marketing-only `OPENWOP_BILLING_PLAN_DISPLAY` env config, honest-when-absent.
  Open: whether pricing should eventually pull live from Stripe Price objects
  (Alt 5) — deferred.
- **Category depth.** `category` is a single optional scalar (one primary
  section). Open: whether operators need multi-level / hierarchical categories —
  deferred; tags cover cross-cutting facets meanwhile.
- **Blog scope.** `app.openwop.dev`'s blog = the ADR 0027 site-org; any org's
  published posts are also servable at `/public/:orgId/blog`. Assumed consistent
  with the existing per-org public surface.
- **Gated / membership posts.** Out of scope — the gap analysis notes gated
  content is unresolved (evidence didn't survive verification). Posts here are
  published-or-not, no paywall.
- **Legal copy.** Placeholder-marked; the operator supplies real text and obtains
  counsel review before publishing. This ADR **never** fabricates binding legal
  copy.
- **ADR 0384.** Assumed to cover the new public routes for crawler SEO + JSON-LD.
  If 0384 slips, these pages still function (SPA-rendered) but lack crawler
  unfurls; no functional coupling, only an SEO-value dependency.

---

## RFC verdict

**Host-extension — no wire RFC required.** Blog taxonomy is a query layer over
existing `cms` pages plus a scoped, hand-rolled RSS/sitemap variant on the
`publishing` host surface. The pricing page is a public READ of operator config
plus a CMS section type. The seed set is content. Every route is under
`/v1/host/openwop-app/{public,billing}/*` (non-normative host-extension, already
on `PUBLIC_PATH_PREFIXES`). Nothing adds a run-event field, capability flag, event
type, endpoint contract, auth/scale profile, or normative `MUST` to the OpenWOP
wire (CLAUDE.md § "A spec change needs an RFC"). An ADR here is sufficient.

---

## As-built (updated per PR)

| PR | Scope |
|---|---|
| _pending_ | (a) Blog taxonomy |
| _pending_ | (b) Public pricing |
| _pending_ | (c) Marketing + legal seed set |

## Implementation record (2026-07-17)

| Phase | Commit | Notes |
|---|---|---|
| (a1) post facets | 7acbebf39 | kind/authorId/category + narrowing filters; translator-grant exclusion |
| (a2)+(b)+(c) backend | acb4c9471 | blog list + enriched feed (ONE buildFeed generator), pricing section + public tier read, marketing/legal seeder |
| (a3)+(b) frontend | d497378a9 + 7c86d23af | /blog tree + /pricing + pricing renderer branch + i18n ×4 (en/es/fr/pt-BR) |
| seeder idempotency fix | d82e28512 | in-flight guard clears after completion |
| remediation (review/grades) | d03ee2eeb | publishedAt stamping (feed no-refloat regression), authorId soft-ref documentation, UX polish |

Corrections vs the proposal: locale set is en/es/fr/pt-BR (the plan's
de was wrong); CTA default is `/chat` (no `/auth` route exists — sign-in is a
modal); `publishedAt` was added at the publish transition (the proposal's
updatedAt-as-pubDate re-floated edited posts in the feed — grade-code BLOG-2).

**Erasure stance for `authorId` (P0PUB-2, accepted 2026-07-17).** A published
post's `authorId` is a **pseudonymous principal reference**, and it **persists on
the post after that subject is erased** — subject erasure (ADR 0381) does not
rewrite or null the byline ref on published content. This is deliberate and
consistent with the app's accepted content stance: the byline never carries PII
by itself (it is an opaque principal id, the same never-validated shape as
`createdBy`), and the **display name** is resolved at read time through the ONE
tenant-scoped `subjectDisplay` seam, which degrades an erased/unknown/foreign
principal to the erased-subject fallback (a humanized id) with no cross-tenant
leak — so an erased author's *name* stops resolving, while the post itself
(authored content, not personal data) remains published under its editorial gate.
Hard-unpublishing or reassigning a specific post remains an explicit editorial
action, not an automatic consequence of erasure. (Context: ADR 0381 erasure; the
`authorId` soft-ref documentation in the `Page` model, grade-data P0PUB-1.)

---

## Correction note — reader-experience upgrade (2026-07-24, `docs/steward/UX_UPGRADE-site.md`)

A competitive UX benchmark of this feature against Ghost (+ the premium Ghost
theme market) and current SaaS pricing practice graded our public blog and
pricing screens **C+ on interaction and capability** while the rest of the `.fp-*`
system already met or beat the matrix. The gaps and their evidence are recorded
in **`docs/steward/UX_UPGRADE-site.md`** at the repo root (competitor catalog, matrix, ranked
gaps G1–G10, deferrals). The shipped changes touch this ADR's surface in two
places, so they are recorded here rather than in a new ADR — the *decisions* of
0391 stand; this is their reader-experience completion:

1. **The blog list projection gained two fields** (`listPublicBlog`,
   `PublicBlogPost`): `readingMinutes` — whole minutes at 225 wpm, computed from
   the SAME published sections the public renderer draws, over an allowlist of
   prose keys so a URL or asset token can never inflate it — and
   `coverImageToken`, which **reuses the post's existing OG image** as the index
   card's cover rather than introducing a second image-authoring surface. Both
   are additive on the non-normative host-extension public read
   (`/v1/host/openwop-app/public/:orgId/blog`); no wire shape and therefore no
   RFC. `readingMinutesFor` is deterministic (no clock, no random), so it stays
   replay-safe.
2. **The `pricing` section renderer gained a comparison matrix**
   (`TierComparison`), built from the union of the tiers' already-rendered
   `features[]` — so the matrix cannot disagree with the cards above it, and no
   billing config, price display, or Stripe surface is touched.

Deferred with reasons: a monthly/annual price toggle (G9) needs the operator
billing display config to carry two price shapes per tier, which is a billing
change, not a UI one; a grouped marketing footer (G10) was declined because
`PublicShell` is shared with hosted form fill, funnels, the storefront and
e-sign, where marketing chrome would be wrong.
