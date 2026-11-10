# ADR 1030 — Designed pages on custom domains (a site stylesheet for the prerender)

Status: Accepted (ADR 1029 P4; David, 2026-11-02: "work through all phases"). P1 and P2
implemented, behind the workspace sub-toggle `custom-domains.designed-pages` (off).

## Context

A workspace's pages are public on its bound custom domain (ADR 0295). There, humans
and bots both get the semantic prerender (`features/publishing/routes.ts` `${PUB}/prerender/:slug`,
ADR 0384): headings, paragraphs, lists and links, escaped, with **no stylesheet**. The
designed `.fp-*` look exists only in the SPA's `SectionRenderer`, which never runs on a
customer hostname. So a customer site such as `openwop.davidtufts.me` reads as an
unstyled document, and ADR 1029's motion and pattern layouts never reach it.

ADR 1015 added a same-origin, manifest-served `_rt` asset door on bound domains (the
visitor runtime), under `PRERENDER_CSP` (`style-src 'self' 'unsafe-inline'`).

## Options weighed (architect review, options mode)

| Option | Cost now | Debt / risk | Verdict |
|---|---|---|---|
| (a) `sectionHtml` emits the SPA's `.fp-*` markup | large | a second renderer of the same design; every SPA change must be mirrored | reject |
| (b) serve the SPA shell on custom domains | small | the whole app surface (auth, routes, cookies) on a customer hostname; ADR 0384 decided against it | reject |
| (c) server-render the React `SectionRenderer` | very large: a Node build of the renderer, server i18n/router/brand, fetch-backed sections | one renderer, pixel parity | the upgrade path if parity is ever required |
| (d) the visitor runtime mounts React over the page | medium | React on every view, a visible jump, nothing without JS | reject |
| (e) a site stylesheet for the semantic prerender, keyed on stable `data-owp-*` hooks | medium | the look is "designed", not the SPA's pixels | **chosen** |

Dominant force: one source of truth for markup (the semantic renderer, pinned by its
golden test) and a safe, reversible change to what every bound domain serves.
Falsifiability: a customer who needs the SPA's exact pixels on their domain moves this
to (c).

## Decision

### D1 — Stable hooks on the semantic markup

`sectionHtml` adds data attributes to each section's outermost element:
`data-owp-section="<type>"`, and when set `data-owp-layout`, `data-owp-visual`,
`data-owp-motion`. Values are closed enums from the validator, escaped anyway. The
markup is otherwise unchanged; the golden fixture records the diff.

### D2 — One hashed stylesheet in the site-runtime build

`frontend/react/src/site-runtime/site.css` is a second input of the ADR 1015 build. It
imports the foundation tokens (and the distribution's `brand/brand.css`, so a
white-label build's colours carry over) and styles ONLY `[data-owp-site]` documents:
type, the hero header, section rhythm, card lists, steps, stats, FAQ, quotes, the
comparison table, video, and the ADR 1029 activity card, timeline, bento and marquee
(static), plus the D3 motion. The manifest gains `style` (validated like every file).

### D3 — Motion on custom domains

The ADR 1029 `fp-reveal` vocabulary keyed on `[data-owp-motion]`, with the same
guards: scroll timelines only, `screen` only, `prefers-reduced-motion: no-preference`
only, range `entry 0%`–`entry 100%`. No JavaScript.

### D4 — Served only when the workspace turns it on

`siteStyleTagFor(res)` returns `<link rel="stylesheet">` to the `_rt` asset when: the
request is on a bound host, the host kill switch is not set, the image has a manifest
with a style, and the workspace's `custom-domains.designed-pages` toggle is on (an
unreadable toggle counts as off). The prerender then marks `<body data-owp-site>`.
Independent of the visitor-runtime toggle: the stylesheet needs no script.

The response is already `no-cache` when tagged (ADR 1015), so a page and its
stylesheet cannot skew across deploys.

### Verification note (build, 2026-11-02)

Rendered a real prerender of a six-section page with `site.css` in headless
Chromium (light, dark, phone). Two fixes came out of looking at it: section
eyebrows other than the hero's are now styled, and a `timeline` item's date or
stage now leads it in the crawler output (it had been replaced by the steps
number, so crawlers missed a word visitors read). A full-page screenshot shows a
below-fold `reveal` section as blank: the view timeline never ran for it in that
capture. A visitor scrolling sees it; with motion off it is always shown.

### D5 — P2: the site in the workspace's own brand (2026-11-02)

**Options (architect review).** (A) mirror the SPA's theme generator into the
backend, byte for byte, pinned by a test; (B) a shared package — no workspace seam
exists, a repo-structure change far larger than the feature; (C) apply the brand's
raw accent — breaks ADR 0510 §5 (contrast tokens are generator-owned); (D) compute
the tokens in browser JavaScript — breaks D2's no-script rule. **Chosen: A.**

- **Which brand:** explicit, never guessed. A workspace picks one of its own brands
  that has an app identity (`site:brand`, keyed `<tenantId>:<orgId>`, owned by
  `host/siteBrand.ts`, which reads brands only through `brandService` — the
  `host/systemBrand.ts` precedent). Route: `GET`/`PUT
  /host/openwop-app/custom-domains/orgs/:orgId/site-brand` (`authorizeOrgScope`,
  `workspace:read`/`workspace:write`); another org's brand, or one without an
  identity, is a 400. A choice whose brand is later deleted reads as none.
- **Tokens:** `features/brand/theme/{generate,oklch,contrast}.ts` are byte-identical
  copies of the SPA's files (`test/adr1030-p2-site-brand.test.ts` compares them). The
  prerender adds one `<style>` after the stylesheet link: the brand's light tokens on
  `[data-owp-site]`, the dark ones under `prefers-color-scheme: dark`, in the SPA
  injector's value grammar. Colours (AA-solved), radius and the ADR 1029 motion preset;
  not fonts (`PRERENDER_CSP` admits no third-party stylesheet). Cached a minute per
  workspace and dropped when the choice changes.
- **UI:** a Site brand card on the custom-domains page (4 locales).
- **Verification note:** a Chromium render showed the card's glow still in the stock
  accent: `tokens.css` derives `--clay-glow` on `:root`, before the brand's `--clay` on
  `<body>` applies. `site.css` now re-derives it on `<body>` with the same expression.

## Wire

Not wire-affecting: host-extension public routes and presentation only. No RFC.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P1 | D1–D4, toggle, tests, Chromium check | this PR |
| P2 | per-workspace colours, radius and motion preset (D5) | built |

> **CORRECTED 2026-11-03 (ADR 1046).** The design tokens the site stylesheet
> exposes become a pack-facing, versioned contract that site components read through
> CSS custom properties (ADR 1046 P3). Renaming a token is then a breaking change.
