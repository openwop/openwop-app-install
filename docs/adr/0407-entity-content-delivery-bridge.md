# ADR 0407 — Entity→content delivery bridge: entity-backed CMS sections + per-type public read

**Status:** implemented — Phases 1–3 + **D3 (server-side prerender)** (2026-07-17/18,
#1998 / #1999 / #2001; D3 `feat/adr0407-d3-prerender`). `entityDetail` slug-binding
remains the ONE recorded deferral (no pattern routes to bind against — returns
with public page patterns if they ever land).
**Date:** 2026-07-17

**D3 implementation notes (2026-07-18) — server-side entity prerender:** the
recorded D3 follow-on landed via the core `host/contentDataSources` registry
(`registerContentSectionResolver` / `resolveContentSection`) — the entities
feature registers `entityList`/`entityDetail` resolvers; publishing's
`prerenderPage` consumes core and emits semantic `<ul>`/`<article>` HTML + a
JSON-LD `ItemList` for crawlers. Features never import each other (core-purity +
publishing-never-imports-entities guard tests). **No-cloaking is guaranteed by
construction, not by comparison:** the D5 route-inline public-read gate was
EXTRACTED to `features/entities/publicRead.ts` (`readPublicEntities` /
`readPublicEntity` / `resolveEntityPublicLocale`) and BOTH the public route AND
the crawler resolver call it — a crawler literally cannot see a draft or
non-public row (pinned: a draft entity never appears in prerendered HTML; a
non-public type resolves to null). The correct cloaking anchor for REFERENCED
content is the referenced store's public read, not the page projection — so
ADR 0384's existing `⊆ page-projection` no-cloaking test is unchanged and still
green (its fixtures carry no entity sections); a new parity/negative suite
(`entities-prerender-d3.test.ts`) anchors entity-section honesty to
`readPublicEntities`. **Trade-off accepted:** the prerender HTML cache
(`OPENWOP_SEO_PRERENDER_TTL_S`, default 3600s) can serve entity titles up to one
TTL stale — acceptable for crawler content (they re-fetch), matching the
productGrid-precedent cache posture. Option A (resolving entities into the
public page projection JSON too) was rejected: it changes the `PublicPage` wire
shape + adds bounded async fan-out to the hot, cached, rate-limited public
page-read for a consumer (the SPA) that already resolves client-side — B′ (this)
forecloses nothing if a real projection-side consumer ever emerges.

**Phase-3 implementation notes (2026-07-17):** term narrowing shipped
(`entityList.termId`, an opaque term reference resolved by the entities term
index at render; editor picker is taxonomy → term over the authed reads). The
`demo-entities` seeder ships the proving consumer (team-member type,
departments taxonomy, six-person roster with one deliberate draft, publish +
publicRead; the content-marketing About page gains a "Meet the team"
entityList). **`entityDetail` slug-binding (`bindSlugField`) is DEFERRED with
cause:** the public page surface has no pattern routes to bind against — a
page is one slug, so a bound detail section would be dead config today. It
returns when pattern routes exist (candidate: the ADR 0408 Phase C/D page
work), not before.

**Phase-2 implementation notes (2026-07-17):** section config is FLAT
(`titleField`/`bodyField` top-level, not a nested `display` object — the
section-vocabulary house style); the editor's type picker stamps BOTH
`typeName` and `tenantId` from the authed type row (one selection, no
free-typed tenant ids) and field pickers offer the chosen type's own field
keys (SSoT, never free text). The review pass found and fixed a latent
SectionsEditor defect this phase inherited: consecutive per-key `set()` calls
in one event clobber each other (each spreads the stale pre-event `data`) —
the entity forms, `productGrid`'s store reset, and `form`'s org reset now
emit ONE patch per event.

**Phase-1 implementation corrections (2026-07-17):**
- **The public route lives at the SIBLING prefix `/v1/host/openwop-app/public-entities/:tenantId/…`**,
  not the sketched `/entities/public/:tenant/…` — the `public-forms ≠ forms`
  rule in `middleware/auth.ts`: a public prefix never nests inside an authed
  namespace.
- **Entry status wire vocabulary is `'draft' | 'live'`** (`'live'` stored as
  ABSENT — the additive-KV rule); a public **single-entity GET** ships alongside
  the list (the Phase-2 `entityDetail` section needs it).
- **The public wire is a projection** (`toPublicEntity`): entityId + values +
  termIds + timestamps ONLY — `createdBy`/`updatedBy` are member subjects and
  never reach the anonymous wire; draft filtering happens BEFORE pagination so
  cursors stay stable.
- The seam's field-kind vocabulary is `string`/`number`/`enum`/… (ADR 0257's
  actual names), not the `text`/`select` shorthand in D1's sketch.
**Toggle:** rides `entities` (section authoring requires it ON for the org's tenant;
a page containing an entity section renders the fallback when it is OFF). Per-type
public exposure is an explicit type-level opt-in flag, not a toggle.
**Depends on / composes:** ADR 0386 (entities — the store + query owner; this ADR
RESOLVES its deferred "public read-through per-type flag" open question), ADR 0009
(CMS — the section/render owner), ADR 0391 (public-site completion — the `pricing`
section precedent and the blog verdict below), the C7 ecommerce-gap `productGrid`
section (the reference-not-copy composition pattern this ADR copies), ADR 0384 (SEO
prerender — `sectionHtml` degradation class), ADR 0406 (entity localization —
resolved values compose into the section render), ADR 0064/RFC 0103 (locale
negotiation on the public page path).
**Surface:** extends `/v1/host/openwop-app/entities/*` (one new PUBLIC read) and the
CMS section vocabulary. Host-extension, **no new RFC**.
**Origin:** the 2026-07-17 architect thread — "I'm really struggling with the
existence of entities if it isn't used to populate CMS blocks, headless CMS, blogs."
**Program:** **Phase A of ADR 0408** (one content kernel). The bridge is no longer
the end-state — it is the kernel's public shakedown before ADR 0408 Phase C
re-platforms pages onto the same engine; `entityList { typeName: 'cms.page' }`
becomes valid the day Phase C lands.

---

## Context — the missing half

ADR 0386 shipped the **store half** of a headless CMS: user-defined types, records,
query, an authed entityApi, workflow + chat integration. It shipped **no delivery
half**: nothing renders an entity. The boundary line "entities never renders; cms
never queries by field" is correct as a *store* boundary, but as shipped it leaves
entity content unreachable from every public surface — the CMS page builder cannot
place "the latest 10 `Event` entries" on a page, and the entityApi refuses anonymous
readers. A records engine nothing can present reads as a database admin UI, not as
content modeling. That perception gap is legitimate and this ADR closes it.

**The composition pattern already exists in this codebase — three times.** CMS
sections that carry *config/references* and resolve *live data from another feature
at render time*:

- `productGrid` (C7): validated product REFERENCES (bounded id list + `storeOrgId`),
  structural validation in `cmsService` (`buildSectionData`), live name/price/image
  resolved through the **public storefront read** at view time, missing/archived →
  fallback, never stale copied data (`cmsService.ts:203`, `SectionRenderer.tsx:292`).
- `pricing` (ADR 0391 b): the section carries WHICH tiers; the live catalog is
  fetched from the public billing read; never a baked price.
- `form` (ADR 0330–0332): the section references a form; `PublicFormRenderer` is the
  render path.

So entity-backed sections are **not a novel seam** — they are the fourth instance of
an established pattern. No cms→entities import exists in it anywhere: the cms backend
validates structure only; the cms frontend fetches the other feature's public HTTP
read; the owning feature serves it.

**Blog verdict (so it is not re-litigated):** the blog shipped **on CMS pages** this
same day (ADR 0391 — `kind:'post'` discriminator, archives, `/blog/feed.xml`). Posts
are render-first documents; that is CMS-native content and stays there. Entity-backed
sections target **structured collections** — team members, events, job postings,
testimonials, recipes, properties — where the record is the truth and pages present
projections of it. Re-platforming the blog onto entities is rejected churn.

## Decision

### D1 — Two new section types: `entityList` and `entityDetail`

Added to the closed `SECTION_TYPES` vocabulary with per-type sanitizing builders
(the `buildSectionData` switch), exactly like `productGrid`:

```
entityList data:   { typeName, filter? (bounded equality/term pairs), sortField?,
                     sortDir?, limit (≤24), display: { titleField, bodyField?,
                     mediaField?, linkPattern? }, eyebrow?, heading? }
entityDetail data: { typeName, entityId | bindSlugField, display: {…} }
```

- **Structural validation only** in `cmsService`: bounded strings, `limit` capped,
  field keys shape-checked. **Existence is a render-time concern by design**
  (records churn under pages — the productGrid comment verbatim). No cms→entities
  import; the section stores references, never copied entity data.
- **Localization composes twice:** section chrome (`eyebrow`/`heading`) localizes via
  the existing `Section.localizations` (ADR 0064); entity *values* localize via
  ADR 0406 — the public read resolves overlays with the page's negotiated locale.

### D2 — Per-type public read (resolves ADR 0386's deferred open question)

`EntityType` gains `publicRead?: boolean` (default absent/false — read stays closed,
the ADR 0386 posture). One new anonymous route:

```
GET /v1/host/openwop-app/entities/public/:tenant/types/:typeName/entities
    ?filter…&sort…&limit…&locale?
```

- Served **only** when the type is `published` AND `publicRead` — otherwise uniform
  404 (no existence leak). Flipping the flag is a type-admin op
  (`host:members:manage`), the same tier as other type mutations.
- Returns **resolved values only** (ADR 0406 locale resolution applied; overlays
  never leak), bounded by the same query ceiling as the authed path, rate-limited by
  the existing public-path budget.
- **Entry-level draft:** `Entity` gains optional `status?: 'draft'`
  (absent ⇒ live — additive, zero migration, every existing row unaffected). Draft
  entities are filtered from the public read and from resolved section data; the
  authed/editor paths see them. Without this, flipping `publicRead` on a type would
  expose half-authored records — the footgun is real enough to close in v1.
- The SPA `entityList`/`entityDetail` renderers (living in `cms/`, like
  `ProductGridSection`) fetch this route at view time; empty/missing/disabled →
  the designed fallback, never an error wall.

### D3 — SEO prerender: honest degradation now, server projection later

`publishing/sectionHtml.ts` v1 renders `entityList`/`entityDetail` as
heading/eyebrow + a link — the **same deliberate-degradation class as
productGrid/form**, pinned by the existing coverage/golden tests. A follow-on phase
may resolve entity sections server-side for crawlers (entity content — events, job
postings — is precisely the JSON-LD-valuable part); that requires a core registry
inversion (`host/contentDataSources`: entities registers a resolver, publishing
consumes core — features still never import each other) and is deferred until the
bridge proves out (Open questions).

### D4 — Boundary restatement (correction-note discipline)

ADR 0386's line "cms never queries by field" survives with one nuance, recorded
there as a correction note: a cms section may **carry** a bounded query spec as
authored config; the query **executes** only in the entities feature behind its own
route and ceilings. CMS still implements no query engine; entities still renders
nothing.

## Feature Evaluation Matrix (delta)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | No new package. `cms` gains two section cases (its vocabulary, its owner); `entities` gains one flag + one public route + entry-status (its store, its owner). |
| 2 | Toggle | Rides `entities`; `publicRead` is per-type data, not a toggle. Sections render fallback when the feature is OFF for the page's tenant. |
| 3 | RBAC / isolation | Public read: published+publicRead types only, uniform 404 otherwise, tenant-scoped path, no draft entities, no overlays, bounded + rate-limited. Flag mutation = type-admin tier. |
| 4 | Replay | Render-time resolution is a VIEW concern (no run involvement). Workflow reads are untouched (ADR 0406 D6 already pins explicit-locale semantics). |
| 5 | Frontend | `EntityListSection`/`EntityDetailSection` in `cms/` beside `ProductGridSection`; SectionsEditor gains the two authoring forms (type picker fed by the org's type list, field pickers fed by `describe-type` — SSoT, not free text); `ui/` cohesion + 4-locale chrome i18n. |
| 6 | Packs/tools | None new. `entities.describe-type` already serves the schema the editor needs; parity pins extended only if its output shape grows `publicRead`/`status`. |

## Phased plan

- **Phase 1 — Public read + entry status.** `publicRead` flag + `Entity.status` +
  the anonymous route (uniform-404, bounded, locale-resolving) + route-level tests
  (closed-by-default, draft filtering, cross-tenant 404, ceiling).
- **Phase 2 — Sections.** `entityList`/`entityDetail` builders + SPA renderers +
  editor forms + `sectionHtml` degradation cases + coverage/golden pins.
- **Phase 3 — Polish.** Term-filter support in section config; `entityDetail`
  slug-binding for pattern routes; demo seeds (a `team-members` type + a seeded page
  using it — the proving consumer).

## Alternatives weighed

1. **Merge entities into cms** — rejected again (ADR 0009 §Alt-2, ADR 0386 Alt-2,
   the 2026-07-17 review); the bridge composes the two owners without muddying
   either store.
2. **Client-only bridge over the authed entityApi** (no public read; pages fetch
   with the viewer's session) — rejected: kills the anonymous/public case, which is
   the entire headless-delivery point.
3. **Server-side section resolution in the page read** (cms backend composes entity
   data into the page response) — rejected for v1: needs the cross-feature registry
   inversion immediately, duplicates the productGrid client-resolution precedent,
   and bakes entity data into cacheable page payloads (staleness). Kept as the D3
   follow-on for SEO only.
4. **Re-platform the blog onto entities** — rejected (ADR 0391 shipped it on CMS
   pages the same day; posts are render-first documents).

## Open questions & assumptions

- **Server-side prerender resolution** (D3 follow-on) — the `host/contentDataSources`
  registry inversion; do it when SEO demand for entity collections materializes.
- **Per-entry scheduled publish / embargo** — `status` is binary v1; scheduling is a
  future composition with the scheduler owner.
- **Cross-tenant section reference** — v1 pins the section to the page's own tenant
  (no `storeOrgId`-style cross-org read; entities are operational data, unlike a
  storefront). Revisit only with a concrete case.
- **Comments on public entity pages** — out of scope; the `comments` feature is
  app-internal collaboration, and public commenting is a forms/submission-sink
  composition if it ever comes.

## RFC verdict — host-extension, no wire RFC

One anonymous host-extension route + section-vocabulary growth + two additive KV
fields. Nothing touches the OpenWOP wire; no capability advertisement changes.
