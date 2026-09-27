# ADR 0384 — Public-site SEO prerender + JSON-LD for crawlers

**Status:** implemented (2026-07-17)
**Date:** 2026-07-17
**Depends on:** ADR 0001 (feature-package architecture), ADR 0009 (CMS — the typed
sections rendered), ADR 0012 (Publishing & SEO — the public surface + SEO projection
this extends), ADR 0027 (CMS-driven public front page + the `/p/:slug` public tier),
ADR 0064 (content localization — the locale negotiation hreflang derives from),
ADR 0295 (custom domains — the second entry path for crawler traffic)
**Closes:** ADR 0012's two explicit deferrals — "Server-side HTML render + inline
`<head>` (OG/JSON-LD/canonical) for social/AI crawlers" and "JSON-LD structured
data" (ADR 0012 § Open questions). Gap-analysis **P0.2** (`docs/steward/MYNDHYVE-GAP-ANALYSIS.md`).
**Toggle:** **none — an always-on property of the public surface** (§ "Why no
toggle"). Operator kill-switch `OPENWOP_SEO_PRERENDER_DISABLED` only.
**Surfaces:** the **existing public (unauthed)** `/v1/host/openwop-app/public/:orgId/*`
family (ADR 0012) gains a bot-served HTML representation; a new backend
prerender middleware; a Firebase Hosting document-rewrite for the platform origin.
**Wire impact:** none — non-normative host extension (§ "RFC verdict").

---

## Context (the gap + why now)

`app.openwop.dev` can author (ADR 0009), publish (ADR 0012), and serve
CMS-driven pages to anonymous visitors on the platform origin and on custom
domains with TLS (ADR 0027, ADR 0295) — but every one of those pages is a
**client-rendered SPA shell**. A visitor's browser runs `FrontPage` /
`RenderSections` and only *then* fills the `<head>` (`FrontPage.applySeo`,
`features/site/FrontPage.tsx:35`). A crawler that does not execute JavaScript —
every social unfurler (Slack, Discord, LinkedIn, Facebook, iMessage/WhatsApp)
and every AI crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) — sees
an empty document with no title, description, Open Graph, or content.

This is the one gap that blocks using the core as a public **marketing** site
(`docs/steward/MYNDHYVE-GAP-ANALYSIS.md` §P0 row 0.2, and the public-content domain table
rows "SEO prerender for social + AI crawlers" / "JSON-LD structured data"). It
is also load-bearing for the docs decision (`docs/steward/MYNDHYVE-DECISIONS.md` §2 — public
CMS-served docs "ride the SEO prerender work"). MyndHyve ships this as
first-class (`functions/src/seoPrerender.ts` — UA-detecting Cloud Function that
returns prerendered `<head>` + a body stub). The port baseline expects it.

ADR 0012 deliberately deferred it: the public API returns **structured page+SEO
JSON** and "an SPA/renderer emits the `<head>` tags" (ADR 0012 Alt 2), noting the
follow-on "needs a section→HTML renderer, the same surface CMS deliberately kept
client-only." This ADR builds that renderer and the bot path in front of it.

## Boundaries audit (who owns what today)

The audit confirms the data and the SEO projection already exist server-side —
the missing pieces are an **HTML representation** and a **bot entry path**.

- **The SEO projection is already server-side and already the SSoT.**
  `publishingService.projectPublic` (`features/publishing/publishingService.ts:249`)
  computes, per published page, the merged `{ title, description, canonicalUrl,
  ogTitle, ogDescription, ogImageUrl, noindex }` with the exact fallback chain
  (SEO row → page title → first hero/richText text via `descriptionFrom`,
  `:280`). `publicPageBySlug` (`:137`) already resolves org→tenant
  (`resolvePublicOrg`, `:109`), reads published-only (`getPublishedBySlug`),
  follows the redirect hop, negotiates the locale from `Accept-Language`
  (`localizePage`, ADR 0064), and applies the ADR 0236 experiment assignment.
  **The prerenderer composes this projection unchanged** — it must not
  re-derive title/description/canonical or it will drift from the SPA and from
  `sitemap.xml` / `feed.rss` (`:212`/`:230`, which read the same `PageSeo`).

- **Section rendering lives ONLY in the frontend today.** `RenderSections`
  (`frontend/react/src/features/cms/SectionRenderer.tsx`) is a React component:
  it maps the seven `SectionType`s (`hero | richText | image | cta | columns |
  productGrid | form`, `cmsService.ts:52`) to designed markup, runs prose through
  a safe-markdown subset (`inlineMarkdown`, ~`:70`) with an http(s)/mailto/
  internal-path link guard (`isSafeHref` / `isInternal`, ~`:62`), and forbids
  `dangerouslySetInnerHTML`. There is **no server-side section renderer** — this
  is the one genuinely new module. It must produce *semantic* HTML (headings,
  paragraphs, links, list items, `img` with `alt`), not the designed `.fp-*`
  layout: crawlers index content and meta, not CSS. The drift risk is over
  **section semantics** (which field is a heading, which is a link), and is
  addressed with parity + golden tests (§ Decision).

- **Bot detection has no home yet, and the two public origins reach the backend
  differently.** This is the crux:
  - **Platform origin (`app.openwop.dev`).** The SPA's `index.html` is served by
    **Firebase Hosting**, and `/api/**` rewrites to Cloud Run (`DEPLOY.md`; SSE
    bypasses the CDN via a direct `*.run.app` URL). A crawler requesting
    `https://app.openwop.dev/p/pricing` gets Firebase Hosting's static shell and
    **never touches Cloud Run** — so a backend middleware alone cannot see it.
    A **Firebase Hosting rewrite of document requests** (`/`, `/p/**`) to the
    backend prerender endpoint is required to route those requests to the code.
  - **Custom domains (ADR 0295).** These already flow GCLB → Cloud Run →
    `middleware/customDomain.ts`, which pins the org from the hostname row and
    constrains the request to the public-surface allowlist. Crawler traffic on a
    custom domain **already reaches the backend** — the prerender middleware sits
    immediately after custom-domain resolution and needs no hosting rewrite.

- **The public-route allowlist is the existing seam.** `PUBLIC_PATH_PREFIXES`
  (`middleware/auth.ts:86`, matched at `:424`) already carries
  `/v1/host/openwop-app/public` (added by ADR 0012). A new prerender route lives
  under that same prefix, so it inherits the unauthenticated carve-out with no
  new auth decision. The ADR 0295 custom-domain public-surface allowlist
  (`middleware/customDomain.ts`) must additionally admit the document path it
  serves on a customer hostname.

- **The public slug matcher already exists, pure.** `matchPublicPageSlug`
  (`features/site/publicPageRoute.ts:13`) decodes + validates the `/p/:slug`
  shape. The prerender path reuses the same slug grammar so bot and human
  resolve the identical page (no cloaking, § below).

**Net:** everything except the HTML representation and the UA-branching entry
composes from existing primitives. No CMS or Publishing data-model change; no
migration.

## Decision

Add a **backend crawler-prerender path** to the `publishing` feature that, for
bot user-agents only, returns a fully-formed HTML document — inline SEO/OG/
Twitter/`<head>`, semantic section HTML in the `<body>`, and JSON-LD — built by
**composing `publishingService`'s existing projection** with a new
server-side typed-section→HTML renderer. Humans are untouched: they get today's
SPA and its client-side head management. Structured as an extension of
`publishing` (which already owns the public surface), with one justified core
touch (middleware wiring), mirroring how ADR 0012 added exactly one core edit
(the `PUBLIC_PATH_PREFIXES` entry).

### Why no toggle (an always-on property, not a feature flag)

Publishing/CMS/site are **always-on** (ADR 0027). A public page that is
`published` is, by definition, meant to be seen — including by the crawlers that
decide whether it can be *found*. Gating prerender behind a per-tenant toggle
would manufacture the exact footgun ADR 0027 removed for the front page: a
"published but crawler-invisible" state that silently tanks SEO and drifts from
the always-on surface it decorates. Prerender is therefore an **always-on
property of the already-public surface**, not a feature in the toggle catalog.
Its honest-off behavior is graceful, not a switch: if the renderer cannot
produce HTML for a page (an unknown/future section type), it **falls back to
serving the SPA shell** — never a broken or blank document. An operator escape
hatch (`OPENWOP_SEO_PRERENDER_DISABLED=true`, env, default off) exists for the
one-in-a-thousand incident, matching the env-kill-switch pattern (not a tenant
toggle).

### Bot detection — a backend middleware, UA-list-driven, env-extensible

A `middleware/seoPrerender.ts` (Express) inspects `User-Agent` against a bundled
allowlist of social unfurlers **and** AI crawlers, extended by
`OPENWOP_SEO_BOT_UA_EXTRA` (comma list). Non-bots `next()` immediately (zero
added latency on the human hot path). Seed list (superset of MyndHyve's):

- **Social unfurlers:** `facebookexternalhit`, `Facebot`, `Twitterbot`,
  `LinkedInBot`, `Slackbot`, `Discordbot`, `WhatsApp`, `TelegramBot`,
  `Pinterest`, `redditbot`, `Applebot`.
- **AI crawlers:** `GPTBot`, `ChatGPT-User`, `OAI-SearchBot`, `ClaudeBot`,
  `Claude-User`, `anthropic-ai`, `PerplexityBot`, `Perplexity-User`,
  `Google-Extended`, `Applebot-Extended`, `CCBot`, `Bytespider`, `Amazonbot`,
  `Meta-ExternalAgent`, `cohere-ai`, `Diffbot`, `YouBot`.

Detection lives in the **backend** (not only at the edge) because it must serve
two entry paths from one implementation: the ADR 0295 custom-domain path already
lands in Cloud Run, and the platform-origin path is routed there by a Firebase
Hosting document-rewrite. One renderer, one UA list, two doors. Serving the same
resolved page to bot and human (only the *markup* differs, never the *content*)
keeps this transparent, not cloaking — the invariant below.

### The server-side typed-section→HTML renderer (the drift-managed module)

A new `features/publishing/sectionHtml.ts` maps each `SectionType` to **semantic**
HTML:

| Section | Semantic HTML emitted |
|---|---|
| `hero` | `<h1>` heading, `<p>` subheading, CTA as `<a>` (guarded href) |
| `richText` | `<h2>` heading + safe-markdown → `<p>`/`<strong>`/`<em>`/`<code>`/`<a>` |
| `image` | `<figure><img src alt><figcaption>` (media token → serve URL) |
| `cta` | `<h2>` + `<a>` |
| `columns` | `<h2>` + a `<ul>`/`<section>` of per-column `<h3>`+`<p>` |
| `productGrid` | `<ul>` of product name/price/`<a>` (no cart, read-only) |
| `form` | `<h2>`/`<p>` label only (interactive fill is JS-only; noscript-safe stub) |

It reuses the **same** link-safety predicates and the **same** safe-markdown
grammar as the frontend renderer (`isSafeHref` / `isInternal` / `inlineMarkdown`),
and emits nothing via raw HTML injection — every string HTML-escaped
(`escapeHtml`, mirroring `boundedStrings.escapeXml` already used for sitemap/RSS).

**Drift risk is real and explicitly mitigated — pinned by tests, not shared
code.** The frontend renderer (React, `frontend/react`) and the backend renderer
(Node, `backend/typescript`) are separate build targets that cannot import one
module. Two test gates keep them honest:

1. **Coverage/parity test** — `sectionHtml` MUST handle every entry in
   `SECTION_TYPES` (the closed vocabulary, `cmsService.ts:53`). A new section
   type added to CMS without a server branch **fails the test** (a red build,
   the same "two real drifts shipped before the test existed" discipline
   CLAUDE.md cites for the prompt-catalog parity tests). The frontend renderer's
   `SectionType` union is the shared SSoT both sides pin to.
2. **Golden test** — a fixture page exercising every section type + every
   safe-markdown token → an expected-HTML snapshot, so a semantic change to
   either renderer (e.g. richText's link guard) surfaces as a golden diff to be
   reconciled deliberately.

### Inline `<head>` (built from the existing projection)

The prerender emits `<title>`, `<meta name="description">`,
`<meta name="robots">` (honoring `noindex`), the Open Graph set (`og:title`,
`og:description`, `og:type`, `og:url`, `og:image` + `1200×630` dims,
`og:site_name` from `brand`, `og:locale` from the negotiated locale), the
Twitter card set (`summary_large_image`), `<link rel="canonical">` (the
projection's `canonicalUrl`), and **hreflang** `<link rel="alternate">` tags —
one per authored locale from `getContentLanguageSettings` (ADR 0064), plus
`x-default`. Every value comes from `projectPublic`'s output or the localized
page; **none is re-derived**, so the bot `<head>` equals the SPA's eventual
`<head>` field-for-field.

### JSON-LD (emitted from typed sections + site config, honestly scoped)

A `<script type="application/ld+json">` block carries only structured data the
typed model actually holds:

- **`Organization`** — from `brand.*` (name, logo, url). Always.
- **`WebSite`** — from the site config (name, url). Always.
- **`WebPage` / `Article`** — from the page projection (`headline`=title,
  `description`, `dateModified`=`updatedAt`, `image`=`ogImageUrl`, `inLanguage`=
  locale, `url`=canonical). `Article` when the page carries article semantics
  (a hero + richText body); `WebPage` otherwise. A future `pageType` (blog/
  podcast, gap-analysis public-content lane) refines this.
- **`BreadcrumbList`** — derivable from the slug path (home → page).
- **`FAQPage`** — **deferred**: it requires a typed `faq` section carrying
  question/answer pairs, which the current seven-section vocabulary lacks
  (consistent with ADR 0027 Alt 4 deferring marketing section types). Emitted
  the moment a `faq` (or Q&A `columns` variant) type lands. Fabricating FAQ
  markup from non-FAQ sections would be dishonest structured data (a
  rich-result penalty risk), so it waits for the data.

### No cloaking — the binding invariant

The bot and the human resolve **the same published page through the same
`publicPageBySlug` call** (same slug grammar, same published-only gate, same
locale negotiation, same experiment assignment). Only the *rendering* differs
(server semantic HTML vs client React). The prerender never serves content a
human would not see — no keyword stuffing, no hidden text, no divergent page.
This is a search-quality requirement (cloaking is penalized) and a test
assertion (the prerendered body's visible text is a subset of the projected
section text). AI-crawler UAs and social UAs get the *same* document (MyndHyve's
"enhanced structured data for AI" split is not adopted — one honest
representation).

### Interaction with custom domains, sitemap, robots

- **Custom domains (ADR 0295):** the prerender middleware runs **after**
  `customDomain.ts` has pinned the org, so a crawler on `pages.acme.com` gets the
  org's prerendered page with a canonical URL on the customer hostname. The ADR
  0295 public-surface allowlist must admit the document path; the authed/app/
  protocol surface stays fail-closed as before.
- **robots.txt (`robotsTxt`, `publishingService.ts:223`):** keep `Allow: /` +
  the `Sitemap:` line, and **do not block AI-crawler UAs by default** (the point
  is to be indexed); expose an operator env to disallow named AI bots for a
  white-label fork that wants opt-out. `llms.txt` (a published-docs discovery
  file, `docs/steward/MYNDHYVE-DECISIONS.md` §2) is an adjacent follow-on that rides the same
  pipeline — noted, not built here.
- **sitemap.xml / feed.rss:** unchanged; their per-page URLs already equal the
  prerender canonical (both from `pageUrl`), so a crawler that reads the sitemap
  and follows a URL gets a matching canonical — no split-brain.

### Response caching

Prerendered responses carry `Cache-Control: public, max-age=<TTL>` (default 3600
s, `OPENWOP_SEO_PRERENDER_TTL_S`), matching MyndHyve. Because content is
published-gated and low-churn, a short TTL is safe; the honest trade-off (a
just-published edit is crawler-visible within the TTL) is documented rather than
adding a publish→cache-purge hook in v1.

## Feature Evaluation Matrix

| # | Dimension | Answer |
|---|---|---|
| 1 | **Feature-package** | **Extends `publishing`** — new `sectionHtml.ts` + `prerenderService.ts` beside the existing public projection it composes. **One justified core touch:** wiring `middleware/seoPrerender.ts` into the chain (after `customDomain`, before the SPA/static fallthrough) — a central request-routing decision, the same class as ADR 0012's single `PUBLIC_PATH_PREFIXES` edit and ADR 0295's `customDomain.ts`. No new feature-package, no new toggle registry entry. |
| 2 | **Toggle / admin UI** | **None** — an always-on property of the public surface (§ "Why no toggle"). Operator env kill-switch `OPENWOP_SEO_PRERENDER_DISABLED` + UA/TTL env only. No admin screen; no toggle-catalog row. |
| 3 | **`ctx` workflow surface** | **None.** Prerender is a synchronous HTTP/render concern, not a workflow actor. It advertises no `host.openwop-app.<id>` capability; `/.well-known/openwop` and `featureSurfaces` gating are untouched. |
| 4 | **Node pack** | **None.** There is no agent-invokable action here — a crawler-facing render is not a tool. (The *separate* gap-analysis item "cms-builder SEO audit + content-quality scoring" IS an AI/node-pack surface; it is explicitly out of this ADR's scope and tracked on its own row.) |
| 5 | **Envelopes (RFC 0021)** | **None.** No in-run structured intent; nothing durable/replayed/round-capped. |
| 6 | **Agent pack** | **None.** No persona. (Again, SEO *audit* drafting is a distinct cms-builder feature, not this one.) |
| 7 | **Public surface** | **Yes — this is the feature.** A bot-served HTML representation of the existing unauthed `/v1/host/openwop-app/public/:orgId/*` pages (+ the platform `/`,`/p/:slug` via the hosting rewrite, + custom-domain hostnames via ADR 0295). Unauthed, published-only, org→tenant from the URL/hostname — the same security boundary ADR 0012/0027 already own. Reuses `publicPageBySlug` verbatim; adds an HTML content-type + JSON-LD. |
| 8 | **RBAC** | **None new.** The surface is public by definition (published CMS content is world-readable per ADR 0027). No role, no scope check beyond the existing published-only gate; drafts are never prerendered (`getPublishedBySlug` is published-only). `noindex` pages are still served but carry `robots: noindex`. |
| 9 | **Replay / fork** | **None.** No runs, no variant stamps, no checkpoints. The ADR 0236 experiment assignment that `publicPageBySlug` already applies is consumed read-only and unchanged; prerender adds no new replay surface. |
| 10 | **Frontend** | **Minimal.** The human path is unchanged — `FrontPage.applySeo` still manages the SPA `<head>` for real browsers (progressive enhancement). No new screen. Optional (deferred) polish: a "View as crawler" preview link in the CMS SEO editor and an SEO-field-completeness hint — additive, not required for the crawler fix. |

## Phased plan

| Phase | Goal | Key artifacts |
|---|---|---|
| 1 — Renderer + parity tests | `sectionHtml.ts` (semantic per-type HTML, escaped, shared markdown/link grammar) + the `SECTION_TYPES` coverage test + the golden-fixture snapshot. No wiring yet — pure, unit-testable. | `features/publishing/sectionHtml.ts`, `features/publishing/__tests__/sectionHtml.test.ts` |
| 2 — Bot middleware + inline head/OG | `middleware/seoPrerender.ts` (UA allowlist + env extension + kill-switch) + `prerenderService.ts` composing `publicPageBySlug` → full `<head>` (title/desc/robots/OG/Twitter/canonical). Route under `/v1/host/openwop-app/public/:orgId/*`; wire into the chain after `customDomain`. No-cloaking + published-only tests. | `middleware/seoPrerender.ts`, `features/publishing/prerenderService.ts`, `features/publishing/routes.ts`, `middleware/customDomain.ts` (allowlist) |
| 3 — JSON-LD | Organization + WebSite + WebPage/Article + BreadcrumbList emission from the projection + `brand`/site config; validated against schema.org shapes. FAQ left as a guarded no-op pending a `faq` section type. | `features/publishing/jsonLd.ts`, tests |
| 4 — hreflang + platform-origin rewrite + cache | hreflang alternates from `getContentLanguageSettings`; the Firebase Hosting document-rewrite (`/`, `/p/**` → backend prerender) that passes humans through to the SPA shell; `Cache-Control` TTL. Confirm the CDN/SSE topology is undisturbed (document requests only, never assets/SSE). | `firebase.json` (hosting rewrite), `DEPLOY.md` (operator note), prerender response headers |
| 5 — Verification | Live crawler-UA smoke (curl with `User-Agent: ClaudeBot`/`Slackbot` against `/`, `/p/:slug`, a custom domain) asserting a full `<head>` + JSON-LD + semantic body; a human `curl` still gets the SPA shell; Slack/LinkedIn unfurl inspectors; Google Rich Results test on the JSON-LD. Add to `DEPLOY-SMOKE.md`. | `DEPLOY-SMOKE.md` |

## Alternatives weighed

1. **Full server-side rendering (SSR) + hydration for every request.** Rejected.
   It rewrites the human hot path: every document request would move from the
   Firebase CDN to Cloud Run, adding latency and cost and colliding with the
   deliberate CDN/SSE topology (`DEPLOY.md` — SSE already bypasses `/api` for
   exactly this reason). It also needs a React SSR runtime inside the *backend*
   build, but the renderer lives in `frontend/react` and the backend is
   `backend/typescript` — two separate build targets with no shared React
   runtime. Bot-detection delivers ~all of the crawler-SEO value at a fraction of
   the blast radius; progressive SSR-for-all can be revisited later behind this
   same renderer.

2. **External prerender service (prerender.io / Rendertron headless Chrome).**
   Rejected. It adds an external dependency + per-render cost, and **sends the
   page through a third party** (a privacy/data-egress concern for a
   customer-content platform). It is also wasteful here: we already hold the
   structured page server-side (`projectPublic`) and can emit exact,
   deterministic HTML from the typed sections — spinning up headless Chrome to
   screen-scrape our own SPA to recover data we already have is backwards.

3. **Build-time static export (a `StaticExporter` snapshot).** Rejected — for the
   same reasons ADR 0295 rejected its Option B: it **forks rendering** (a frozen
   export vs the live publishing pipeline), breaks per-visitor locale negotiation
   (ADR 0064), experiments (ADR 0236), and analytics, goes stale between publish
   and re-export, and reintroduces the "two page pipelines" smell. Live
   prerender from the single projection stays consistent with what humans get.

## Open questions / assumptions

- **Firebase Hosting document-rewrite mechanics.** Assumption: a hosting rewrite
  of `/` + `/p/**` (document requests only, not `/assets/**` or the SSE URL) to
  the backend prerender endpoint, where the middleware serves bots and passes
  humans through to the SPA shell, does not disturb the CDN/SSE topology. To be
  confirmed in Phase 4 — if a plain rewrite can't preserve the human static-shell
  fast path, a thin Cloud Function (MyndHyve's shape) fronts the decision
  instead. Custom domains (ADR 0295) need no rewrite (already on Cloud Run).
- **Bot verification depth.** v1 is UA-string matching (MyndHyve's approach). A
  hardening follow-on is reverse-DNS verification of Googlebot/Bingbot to defeat
  UA spoofing — deferred (spoofing a crawler only yields the *published* content
  a human could already fetch, so the risk is low).
- **Prerender-for-all vs bot-only.** Serving prerendered HTML to every client on
  `/p/:slug` (then hydrating) would help first-paint but is the SSR path above —
  deferred behind the same renderer.
- **FAQ / richer JSON-LD** waits on a typed `faq` (and blog/podcast `pageType`)
  section — ties to ADR 0027 Alt 4 and the gap-analysis public-content lane.
- **Cache invalidation on publish.** v1 uses a short TTL; an explicit
  publish→purge hook is deferred unless the TTL proves too coarse.
- **`llms.txt`** (`docs/steward/MYNDHYVE-DECISIONS.md` §2) rides this pipeline as a follow-on.

## RFC verdict

**Host-extension — no OpenWOP RFC required.** Everything added is a
non-normative HTTP representation under `/v1/host/openwop-app/public/*` (plus a
Firebase Hosting rewrite and a custom-domain allowlist entry) and a bundled
static UA list — it touches no run-event field, capability flag, event type,
endpoint contract, auth/scale profile, or normative `MUST`. The OpenWOP wire is
untouched; `/.well-known/openwop` advertises nothing new. This is the same verdict
ADR 0012 and ADR 0027 reached for the public surface this extends
(CLAUDE.md § "A spec change needs an RFC" — host-extension routes never touch the
wire). No `OPENWOP_REQUIRE_BEHAVIOR` claim is made.

## Implementation record (2026-07-17)

| Phase | Commit | Notes |
|---|---|---|
| 1 — renderer + parity/golden tests | e16fa4e8e | `sectionHtml.ts` + SECTION_TYPES coverage + golden fixture |
| 2 — bot middleware + inline head | 675a996fe | two doors: custom-domain rewrite + platform-origin document routes; `Vary: User-Agent` (architect ruling) |
| 3 — JSON-LD | 675a996fe | Organization/WebSite/WebPage·Article/BreadcrumbList; FAQ deferred pending a typed `faq` section |
| 4 — hreflang + shell passthrough + rewrite docs | 675a996fe | the firebase.json document-rewrite is a **deploy-time flip** (architect ruling — DEPLOY.md §SEO crawler prerender); code-complete, not enabled by this change |
| 5 — verification | 675a996fe | DEPLOY-SMOKE.md §SEO crawler prerender |
| remediation (review/grades) | d03ee2eeb | `/` exact-match hardening, doc-serve observability |

Corrections vs the proposal: custom-domain document paths serve prerendered
HTML to ALL clients (no SPA shell exists on customer hostnames — strictly
better than the prior uniform 404); the `pricing` section type (ADR 0391)
joined the renderer vocabulary through the coverage gate as designed.
