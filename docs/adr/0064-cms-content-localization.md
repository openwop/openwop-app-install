# ADR 0064 — CMS content localization (RFC 0103)

**Status:** implemented — **Phases 1–3** (2026-06-17) + the **Phase-3 workflow surface**
(2026-06-18): the `ctx.features.cms` read surface, the `feature.cms.nodes` pack
(`get-page` + `translate-section`), and the `feature.cms.agents` localizer agent. The
`content.translate` "envelope" is **not a separate seam** — in this host the chat-drivable path
IS the agent tool-calling the node pack over the surface (the priority-matrix/ADR 0058 precedent:
"there is no separate envelope-acceptor seam; chat-drivability = agent + nodes"). The surface
exposes the already-implemented capability to workflows; it adds no new content capability.
**Date:** 2026-06-18 (Phase-3 surface); 2026-06-17 (Phases 1–3)
**Toggle:** NEW `cms-localization`, **default OFF** (opt-in). When OFF, the CMS is
byte-identical to today — no negotiation, no capability advertisement, no locale UI.
**Capability:** rides **Accepted RFC 0103** (`../openwop/spec/v1/localized-content.md`)
+ its `i18n.md` annex. Advertises `capabilities.i18n` when the toggle is ON and an org
has authored content locales. `capabilities.content` (the normative `/v1/content/*`
delivery surface) is **deferred** — see Open Question 1.
**Depends on / composes:** ADR 0009 (CMS — owns pages/sections/versions), ADR 0027 (CMS
always-on + the public `PublicShell` front page), ADR 0004 (Orgs — content is org-scoped),
ADR 0006 (RBAC scopes), ADR 0001 (feature-package boundary), ADR 0007 (Media tokens —
locale image variants).
**Surface:** extends the existing host-extension `/v1/host/openwop-app/cms/*`; adds a
**core-shared** i18n helper under `backend/typescript/src/host/i18n/` (negotiation +
`resolveSection`) that features import (core must not import features — i18n is core infra).
**RFC gate:** **NO new RFC.** Rides Accepted RFC 0103; the advertised capability shapes
are already normative. CMS routes stay host-extension (non-normative). The one wire-visible
addition — the `capabilities.i18n` discovery block — is an already-Accepted shape, advertised
only when wired + honored (`OPENWOP_REQUIRE_BEHAVIOR` honesty).

---

## Why this exists

openwop-app already has a **mature CMS** (ADR 0009): org-scoped pages with embedded typed
sections (`hero`/`richText`/`image`/`cta`/`columns`), a draft→in_review→published→archived
review workflow, versions, slug redirects, RBAC, and XSS-sanitized content. It has **zero
localization** — ADR 0009 explicitly listed localization as a *rejected, follow-on* item.
The repo has **no i18n infrastructure at all**: no `Accept-Language` parsing, no
`capabilities.i18n`, no `Content-Language`, no frontend `react-i18next`.

Meanwhile the OpenWOP protocol now has **RFC 0103 (Accepted)** — the Localized Content
Surface — which pins the normative model for serving structured content in multiple locales,
and **MyndHyve** (the port baseline) ships a localized CMS in production
(`/Users/davidtufts/dev/myndhyve/services/workflow-runtime/src/content/resolveSection.ts`).

This ADR adds that localization capability **into the existing CMS** — it does **not**
introduce a second content store. (A prior exploration built a standalone host-extension
`/v1/content/*` CMS as the RFC-0103 reference host; on this codebase that would duplicate
the mature `features/cms` package. This ADR supersedes that approach: same RFC-0103 *model*,
adapted onto main's CMS architecture.)

## Context (boundaries audit first)

What already exists — so localization does **NOT** duplicate it:

- **Content store** is `features/cms/cmsService.ts` — the single owner of `Page` +
  `Section[]`, versions, redirects, the review workflow. Localization **composes** it; it
  adds an optional field to `Section` and a locale-aware read, never a parallel store.
- **Org scoping + IDOR guards + RBAC** are `featureRoute.requireOrgScope` + the ADR 0006
  scope vocabulary (`workspace:read` / `workspace:write` / `host:members:manage`). Reused
  verbatim — no locale-specific authority.
- **Public delivery** is the published-only `by-slug` read + the ADR 0027 anonymous
  `PublicShell` front page. Reused — localization only adds `Accept-Language` negotiation
  on top of the existing published-only path.
- **The negotiation + merge primitive is genuinely new** but is **core-shared i18n infra**,
  not CMS-specific (any future feature MAY localize). It lives in `host/i18n/`, imported by
  the `cms` feature — respecting the ADR 0001 boundary (features import core; never the
  reverse).

Single-owner check: **content** is owned by `features/cms`; the **negotiation/merge
algorithm** is owned by the new `host/i18n` core helper. No collision with any existing
service, route prefix, or capability (none exist for i18n today).

## Decision

### D1 — Data model: `localizations` on the embedded Section (additive)

Extend `Section` (`cmsService.ts`) with one **optional** field — backward-compatible; every
existing section deserializes unchanged with no localizations:

```ts
export interface Section {
  sectionId: string;
  type: SectionType;
  data: Record<string, unknown>;              // base/default-locale fields (unchanged)
  localizations?: Record<string, Record<string, unknown>>;  // NEW — sparse per-locale overlays
}
```

`localizations` keys MUST match `^[a-z]{2}(-[A-Z]{2})?$` and MUST NOT equal the org's
`baseLocale` (RFC 0103 §B). Each value is a **partial overlay** of `data`. Sections stay
**embedded** in `Page.sections[]` (main's model) — we do **not** adopt MyndHyve's separate
per-locale section subcollection (port, not clone). A page **version** snapshot therefore
captures `localizations` for free; restore round-trips them.

### D2 — Core i18n helper (the normative algorithm, byte-identical)

New `backend/typescript/src/host/i18n/`:
- `negotiateLocale(acceptLanguage, supported, defaultLocale)` — parse `Accept-Language`
  **without ever throwing/400** (i18n.md MUST), honor q-values, try the exact tag, then the
  language family, then the default. No `?locale=` (RFC 0103 forbids it).
- `resolveSection(section, negotiatedLocale, baseLocale)` — the normative shallow field
  merge: `baseLocale`/empty → `data`; exact-locale override → `{...data, ...loc}`; language
  family → `{...data, ...fam}`; else `data`. Ported **verbatim** from RFC 0103 §C /
  MyndHyve `resolveSection.ts:40-74` so resolution is byte-identical across hosts.

### D3 — Locale-aware read (public/front-page) vs raw read (editor)

- **Public `by-slug` read + the ADR 0027 front-page render**: negotiate the locale from the
  request's `Accept-Language`, run `resolveSection` over each **published** section, return
  the resolved `data`, set `Content-Language` to the locale actually used, and add
  `Vary: Accept-Language`. Published-only is unchanged (the §F draft-leak guard already
  holds). Anonymous visitors' browsers send `Accept-Language` automatically.
- **Editor/admin reads** (`GET .../pages/:pageId`) return the **raw** section
  (`data` + `localizations`) so the editor can author every locale.

### D4 — Per-org language settings

`ContentLanguageSettings { baseLocale, supportedLocales[], autoTranslateOnPublish }`, stored
**per (tenant, org)** in a new `DurableCollection<…>('cms:langsettings')` keyed
`${tenantId}:${orgId}`. Invariant **`baseLocale ∉ supportedLocales`** enforced on write
(RFC 0103 §A). New routes:
- `GET  /v1/host/openwop-app/cms/orgs/:orgId/language-settings` — `workspace:read`
- `PUT  /v1/host/openwop-app/cms/orgs/:orgId/language-settings` — `host:members:manage`

### D5 — Locale write through the existing page PATCH

Locale content is authored by including `localizations` on the section objects in the
**existing** `PATCH .../pages/:pageId` body (which already replaces `sections[]`). This fits
main's whole-page-edit + versioned model and inherits its RBAC gate (`workspace:write` for
draft, `host:members:manage` for non-draft). No separate per-locale section endpoint in
Phase 1 (MyndHyve's transactional per-locale write is unnecessary when the page doc is the
atomic unit). A dedicated `PUT …/sections/:sectionId/locales/:locale` is **optional sugar**,
deferred.

### D6 — Capability advertisement (honest, operator-gated)

`capabilities.i18n { supported, defaultLocale, supportedLocales }` is advertised at
`/.well-known/openwop` (RFC 0103 §A; `i18n.md`) honoring the §A invariant
`defaultLocale == baseLocale`. `i18n.supported: true` claims only that the host negotiates
`Accept-Language`→`Content-Language` on its **localizable content responses** (the CMS read);
error/interrupt-copy localization stays `MAY` per `i18n.md` and is out of scope.

**The advertised locale set is OPERATOR-CONFIGURED, not derived from per-org settings — by
necessity.** The discovery endpoint is core, host-level, and anonymous (no org in scope), and
**core MUST NOT import the `cms` feature** (ADR 0001). So discovery cannot read any org's
`ContentLanguageSettings`. The host instead reads `OPENWOP_I18N_LOCALES` (a core `host/i18n`
config); when empty, **nothing is advertised** (a host that hasn't enabled localization makes
no claim). The honesty contract therefore shifts to the **operator**: set
`OPENWOP_I18N_LOCALES` only for locales the host's content actually authors, and keep it in
sync. (A future core-safe seam could derive the set from the system-site's settings; until
then env-config is the boundary-correct source.)

`capabilities.content` (the normative `/v1/content/*` delivery surface) is advertised under
the **same** operator gate once that projection ships (Phase 3 — Open Question 1 RESOLVED),
§A-conformant: `content.baseLocale == i18n.defaultLocale`, `content.supportedLocales` excludes
the base, and `({base} ∪ content.supportedLocales) ⊆ i18n.supportedLocales`.

### D7 — Toggle gates everything

`cms-localization` (default OFF) gates: the `Accept-Language` negotiation on the read path,
the capability advertisement, the language-settings routes, and the editor locale UI. OFF ⇒
the CMS read returns base `data` exactly as today; `localizations` data, if present, is
simply ignored on delivery.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | Extends the existing `cms` package; the negotiation/merge primitive is core-shared `host/i18n/` (not a feature). Only core touch: the discovery capability block + the shared helper. |
| 2 | **Toggle + admin UI** | `cms-localization`, **default OFF**, `bucketUnit: tenant` (workspace-scoped, shared B2B content), manageable in `FeatureTogglePanel`. |
| 3 | **Workflow `ctx.<feature>`** | **Implemented (2026-06-18).** `ctx.features.cms` read surface (`features/cms/surface.ts`): `listPages({orgId})` + `getPage({orgId, slug, locale?})` — published-only, sections resolved per locale (exact → family → base), no `localizations` leaked. Read-only by design (generation lives in the node). |
| 4 | **Node pack** | **Implemented (2026-06-18).** `feature.cms.nodes`: `get-page` (over the surface) + `translate-section` (run-scoped `ctx.callAI`, structure-preserving JSON-in/JSON-out, overlay sanitized on persist). Both `role:action` (recorded; replay/fork read the recorded result). |
| 5 | **AI-chat envelopes** | **Implemented as agent + nodes (2026-06-18).** No separate `content.translate` envelope-acceptor seam exists in this host — chat-drivability = the localizer agent tool-calling the node pack over the surface (priority-matrix/ADR 0058 precedent). A new wire envelope would need an RFC and stand up a parallel system; rejected. |
| 6 | **Agent pack** | **Implemented (2026-06-18).** `feature.cms.agents.localizer` (persona WRITER), tool-allowlisted to `feature.cms.nodes.{get-page,translate-section}` only; reads base content + drafts per-section overlays for review-then-save. Uses the run-scoped provider (managed free-tier or BYOK), not Gemini. |
| 7 | **Public surface** | The `by-slug` read + ADR 0027 front page are already public + published-only. Adds `Accept-Language` negotiation, `Content-Language` + `Vary`, tenant-from-resource, uniform 404. Payload caps already exist (`cmsService` MAX). |
| 8 | **RBAC + isolation (ADR 0006)** | Reads `workspace:read`; locale content writes ride the page PATCH gate (`workspace:write` draft / `host:members:manage` non-draft); language settings `host:members:manage`; tenant+org IDOR-guarded (existing); fail-closed. |
| 9 | **Replay / fork safety** | `Content-Language` is request-scoped and **NOT logged** (RFC 0103 §F / i18n.md replay determinism). No run-metadata stamping in Phase 1 (read is not run-influencing). If Phase 3 `ctx.content` influences a run, stamp the negotiated locale into `run.metadata` then. |
| 10 | **Frontend** | `SectionsEditor` gains per-section **locale tabs** (`[base, ...supported]`, dirty buffers, copy-from-base, JSON-validity gate); a `CmsLanguageSettings` panel; `cmsClient` methods. `ui/` cohesion + a11y + tokens. **Note:** the admin-chrome `react-i18next` system is a SEPARATE concern (UI-string i18n ≠ content i18n) and is explicitly **out of scope** here. |

## Phased plan

- **Phase 1 — Backend (the capability).** `Section.localizations`; `host/i18n/`
  (`negotiateLocale` + `resolveSection`); locale-aware `by-slug`/front-page read
  (`Content-Language` + `Vary`); per-org language settings + invariant; `capabilities.i18n`
  advertisement (toggle-gated); the `cms-localization` toggle; §F security (published-only,
  tenant/org isolation, `Content-Language` not logged); route-level tests (negotiation
  exact/family/default, malformed `Accept-Language` → default, published-only, cross-org
  404, settings invariant).
- **Phase 2 — Frontend (the editor).** `SectionsEditor` locale tabs + `CmsLanguageSettings`
  panel + `cmsClient` methods; raw-read for editing; gated on the toggle + `useFeatureAccess`.
- **Phase 3 — Core-app extension surface (implemented 2026-06-17/18).** AI translation
  (run-scoped provider, the MyndHyve "translate from base" UX, review-then-save); the normative
  `/v1/content/*` public projection negotiated over the **host-advertised** content set
  (`OPENWOP_I18N_LOCALES`) + seeded localized system-site content for real translated delivery;
  the `ctx.features.cms` read surface; the `feature.cms.nodes` pack (`get-page` +
  `translate-section`); the `feature.cms.agents.localizer` agent. The chat-drivable path is the
  agent + nodes (no separate envelope seam in this host).

## Alternatives considered

1. **Standalone `content` feature-package** (the prior RFC-0103 reference-host shape, tenant-
   scoped `/v1/content/*` + its own DurableCollections) — **Rejected.** Duplicates the mature
   `features/cms` store; ships two competing CMSs. The RFC-0103 *model* is what's valuable,
   not a second store.
2. **Per-locale section records** (MyndHyve's Firestore subcollection shape) — **Rejected.**
   Main embeds sections in `Page.sections[]`; localizations belong on the embedded section so
   versions/restore and the whole-page PATCH keep working unchanged.
3. **Locale in the URL** (`/es/about`, locale subdomain, or `?locale=`) — **Rejected.**
   RFC 0103 forbids `?locale=` and prescribes `Accept-Language`→`Content-Language`. One slug,
   negotiated by header.
4. **Always-on (no toggle)** — **Rejected for Phase 1.** Default-OFF keeps the live CMS
   byte-identical until an org opts in and authors locales; advertising `capabilities.i18n`
   only when honored preserves discovery honesty.
5. **Do nothing** — **Rejected.** Localized content is a real product gap; MyndHyve ships it;
   RFC 0103 is Accepted.

## Open questions

1. **`capabilities.content` + normative `/v1/content/*` projection.** ~~Expose a thin public
   projection over the CMS to claim full RFC-0103 content conformance, or stay CMS-only with
   `capabilities.i18n`?~~ **RESOLVED (Phase 3, 2026-06-17): expose it.** `GET /v1/content/pages/{slug}`
   projects the reserved **system-site** published content in the normative shape (the G11
   host-defined anonymous-tenant carve-out — no org in the public path); `capabilities.content`
   advertised §A-conformantly, operator-gated. Per-org public content projection (beyond the
   system site) stays a future enhancement.
2. **Per-locale publish.** Kept **atomic** across locales in v1 (matches main's page-status
   model + MyndHyve v1). Per-locale publish is a future additive enhancement.
3. **Concurrent locale editing.** The whole-page PATCH is last-write-wins on the page doc;
   field-level locale concurrency is out of scope v1.
4. **SEO / hreflang emission** on the public front page — deferred (Phase 3).
5. **Front-page negotiation for anonymous visitors.** Confirm the `PublicShell` front-page
   read path forwards the browser `Accept-Language` so anonymous delivery negotiates.
6. **Version round-trip.** Confirm snapshot + restore preserve `localizations` (expected, since
   they're embedded in the section).

## Acceptance criteria

Phase 1 (backend) + Phase 2 (editor) — **DONE** (`backend/typescript/src/host/i18n/`,
`features/cms/{cmsService,routes,feature}.ts`, `features/publishing/{publishingService,routes}.ts`,
`routes/discovery.ts`; `frontend/react/src/features/cms/{cmsClient,CmsPage,SectionsEditor,CmsLanguageSettings}.tsx`;
tests `test/{i18n-locale,cms-localization-route}.test.ts`):

- [x] `Section.localizations` added (optional, backward-compatible); existing pages unaffected.
- [x] `host/i18n` `negotiateLocale` + `resolveSection` with unit tests; resolution
      byte-identical to RFC 0103 §C.
- [x] Public `by-slug` AND anonymous publishing read negotiate locale, emit
      `Content-Language` + `Vary`, stay published-only.
- [x] Per-org language settings with the `baseLocale ∉ supportedLocales` invariant + RBAC.
- [x] `capabilities.i18n` advertised operator-config-gated (`OPENWOP_I18N_LOCALES`) — only
      what is honored.
- [x] `cms-localization` toggle (default OFF) gates the settings WRITE; OFF ⇒ CMS
      byte-identical (no authored locales ⇒ base delivery).
- [x] §F: published-only, tenant/org isolation, cross-org 404, `Content-Language` not
      logged (response-only) — route-level tests.
- [x] `host/i18n/` imports nothing from `features/` — core-purity guard test.
- [x] Phase 2: `SectionsEditor` locale tabs + language-settings panel + client; the whole
      `sections[]` (incl. all locales) round-trips on save (architect MEDIUM).

Phase 3 — **DONE** (`features/cms/translate.ts` + the `translate-section` route; `routes/contentDelivery.ts`
+ `capabilities.content` in discovery; FE "Translate from base" button; tests
`test/{cms-translate,cms-content-delivery}.test.ts`):

- [x] AI "translate from base" — `POST …/cms/orgs/:orgId/translate-section` runs the
      MyndHyve translation prompt through the **managed (free-tier) provider** in-route
      (a synchronous one-shot translate doesn't need a node-pack/run); the model output is
      **sanitized through the same overlay cleaner** as a stored localization (no XSS via a
      translation). Toggle- + write-gated; managed-unavailable → clean **503** (editor
      degrades to copy-from-base + manual). Editor button populates a **draft overlay**
      (review-then-save).
- [x] Normative `/v1/content/pages/{slug}` public projection (RFC 0103 shape, locale-
      negotiated, published-only, `Content-Language` + `Vary` + `Cache-Control`) +
      `capabilities.content` advertised §A-conformantly (operator-gated; `defaultLocale ==
      baseLocale`, `supportedLocales ⊆ i18n`). **Open Question 1 RESOLVED:** expose the
      projection over the reserved **system site** (the G11 host-defined anonymous-tenant
      carve-out) — `/v1/content` is on `PUBLIC_PATH_PREFIXES`.

Workflow surface (exposes the above to workflows — no new content capability):
- [x] `ctx.features.cms` read surface (`features/cms/surface.ts`) — `listPages` + locale-resolved
      `getPage`, published-only, no overlay leak.
- [x] `feature.cms.nodes` pack — `get-page` (over the surface) + `translate-section` (run-scoped
      `ctx.callAI`, overlay sanitized on persist).
- [x] `feature.cms.agents.localizer` agent — tool-allowlisted to the CMS nodes only; the
      chat-drivable path (no separate `content.translate` envelope seam in this host — agent +
      nodes IS that path, per ADR 0058).
- [ ] ROADMAP + FEATURES rows landed in lockstep; ADR marked `implemented` on ship.

## References

- RFC 0103 (Accepted): `../openwop/spec/v1/localized-content.md` + `../openwop/spec/v1/i18n.md`
- ADR 0009 (CMS), ADR 0027 (CMS always-on + front page), ADR 0006 (RBAC), ADR 0001 (feature-package), ADR 0007 (Media)
- MyndHyve baseline: `/Users/davidtufts/dev/myndhyve/services/workflow-runtime/src/content/{resolveSection.ts,types.ts,repository.ts}`; admin UI `src/components/settings/cms/{SectionAccordion,CmsLanguageSettingsPanel}.tsx`
