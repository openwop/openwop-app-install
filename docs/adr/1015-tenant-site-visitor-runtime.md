# ADR 1015 — tenant site visitor runtime on custom domains

Status: Accepted

Date: 2026-10-31. Decided by David (option A, "custom-domain runtime"), after an
independent `/architect` options review.

## Context

The visitor-side runtime runs only inside the SPA's `FrontPage`
(`frontend/react/src/features/site/FrontPage.tsx`). That runtime is the consent
banner (ADR 0860), the pageview and web-vitals beacons, heat capture (ADR 0951
P1) and session-replay capture (ADR 0951 P2). On the platform origin the SPA renders `FrontPage` only for the
system site (`host-site`, tenant `host:site`, which has no members by design)
and for the root front-page pointer.

A tenant's published pages are public only on a bound custom domain. There,
`middleware/customDomain.ts` rewrites document paths to the prerender door
(`features/publishing/routes.ts` `${PUB}/prerender/:slug`), which serves static
semantic HTML with no script.

So no customer site ever shows the consent banner or measures anything. And
session replay can never record for any organization that has an owner who could
watch it. That last point surfaced while piloting ADR 0951 P2: the pilot tenant
was fully enabled and attested, but it had nowhere to record.

## Decision

**D1: progressive enhancement on the customer's own origin.** On a bound custom
domain, the prerendered page loads one first-party script, the *site runtime*,
from that same hostname. It runs the existing visitor modules (consent banner,
beacons, heat, replay) against the public routes on that same hostname. There is
no SPA on customer hosts, and no cross-origin call or CORS change.

**D2: one set of modules, two hosts.** The runtime is a second Vite entry
(`src/site-runtime/main.ts`) built from the SAME modules the SPA uses, never a
copy:
- The modules stop importing `client/config`. They read their API base from
  `features/site/visitorApi.ts`.
- The SPA keeps today's base (`VITE_OPENWOP_BASE_URL`). The runtime sets `''`,
  which makes its calls same-origin.
- `visitorConsent.ts` keeps its React hook, but the hook moves to
  `useVisitorConsent.ts` so the core is React-free.

**D3: the consent banner is the shared `VisitorConsentBanner`, not a second
banner.** It mounts lazily inside a shadow root, only when a choice is
needed. The cost is React riding the lazy chunk; a hand-written banner would
drift from the SPA's.

What the shared banner needs off the SPA, verified by reading its imports:
- React, react-dom and react-i18next.
- `ui/Button`, `ui/Notice` and `ui/announce`, none of which reach
  `client/config`.
- The `site` i18n namespace (`features/site/i18n/*`).
- Its CSS, which lives in `global.css`.

The runtime therefore initialises i18next with that namespace only, for the
page's `<html lang>`. The banner's rules move out of `global.css` into
`styles/features/visitor-consent.css`, which the SPA's `index.css` and the
runtime stylesheet both import, so there is one source. The runtime stylesheet
is that file plus `foundations/tokens.css` plus a small button rule set scoped to
the shadow root. The button rules are the one deliberate copy; a test pins their
token names to the SPA's.

**D4: per-workspace opt-in, off by default.** A new sub-toggle,
`custom-domains.visitor-runtime` (tenant bucket, status `off`), decides whether
a bound host's pages carry the script. When it's off, a page's body is
byte-identical to what it is today. Its headers are not: D7's CSP is on every
prerender response. Every capture still has its own gates on top: the
`analytics` / `analytics.heatmaps` / `analytics.session-replay` toggles, consent,
and org attestation. The runtime adds no new data collection on its own.

**D5: the custom-domain guard admits exactly two more org-pinned prefixes,
`public-consent/` and `public-analytics/`, plus the runtime asset path.**
- The org is the next path segment, so the existing org-equality invariant
  covers both prefixes.
- Owner reads (`/analytics/orgs/:orgId/…`) stay unreachable on customer
  hosts.
- Beacon and capture writes get their own per-domain bucket, so a busy recorder
  can't use up the page-load budget.

**D6: the runtime asset is served from the image, by manifest.**
- Route: `${PUB}/:orgId/_rt/:file`.
- Only files the runtime manifest lists are served, as `text/javascript`,
  `nosniff`, immutable. Anything else gets a uniform 404.
- The bundle ships in the same image as the prerender that references it, so the
  page and its script can't skew within one revision.

> **CORRECTION 2026-10-31 (independent review): "can't skew" was false across
> deploys.** The prerender is publicly cached for an hour, and the image holds
> only the current build. So a cached page could ask for a hashed file a later
> deploy had removed, and the toggle and the host switch could take an hour to
> apply. A page that carries the tag is now `no-cache`, revalidated on every
> load (`sendPrerenderHtml`), and a test pins that. A page without the tag keeps
> the hour.

**D7: CSP on every prerender response.**
`default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' https: data:; media-src 'self' https:; frame-src https:; style-src 'self' 'unsafe-inline'; font-src 'self' https: data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
- The JSON-LD blocks are data, not script, so `script-src 'self'` leaves them
  alone.
- Section embeds (video and similar) are covered by `frame-src` and `media-src`.
- `style-src 'unsafe-inline'` covers the banner's shadow-root stylesheet, which
  is inline by construction.

## Alternatives rejected

- **B: hydrate the full SPA on customer hosts.** It reverses the deliberate "no
  SPA on customer hostnames" boundary (`customDomain.ts`, ADR 0384), ships the
  whole authenticated-app bundle to customer origins, and turns semantic-first
  pages into JS-heavy ones.
- **C: a platform-origin `/site/:orgId/:slug` route.** It would put
  tenant-authored pages on the same origin as the session cookie, so a CMS
  escaping bug becomes account takeover, and it would let tenants phish on our
  domain. It would also instrument pages nobody visits, while real customer
  sites stayed dark.
- **D: C behind an allowlist or approval.** It has the same origin risk; the
  allowlist only narrows who can exploit it.

## Security fences

1. The org comes only from the server-injected `data-owp-org` on a bound host,
   and the guard's org pin still applies to every call.
2. The runtime sets no cookies and never asks for `credentials: 'include'`. Its
   `fetch` calls use the default `same-origin` mode, so they carry whatever
   cookies the customer's own origin holds. Ours are never among them, because
   the session cookie is never scoped to customer hosts.
3. The only script is ours, served from the image and named by the manifest. CMS
   content can't add script: section HTML is escaped, and D7's CSP refuses
   anything else.
4. The recorder's never-record selectors still apply (`replayCapture.ts`):
   password, payment and one-time-code fields, plus the opt-out marker.
5. The white-label header strip still applies (ADR 0940 F2).
6. The kill switch is the D4 toggle, per workspace. `OPENWOP_SITE_RUNTIME=off`
   turns it off for the whole host. Both take effect on the next page load,
   because tagged pages are `no-cache`. Each has a test.

## Phases

| Phase | What | Witness (red on the old code) |
|---|---|---|
| P1 | Backend: the D4 toggle; D5 prefixes plus a beacon bucket; D6 asset route; script injection on bound hosts; D7 CSP | Bound host: the page carries the script iff the toggle is on; `/_rt/<manifest file>` returns 200 `text/javascript`; an unknown file or another org returns 404; `public-consent` and `public-analytics` reach their handlers for the bound org only; the CSP header is present |
| P2 | Frontend: `visitorApi.ts` base, React-free consent core, `src/site-runtime/` entry (the eager part has no React; the banner chunk is lazy), the shared banner in a shadow root, Vite runtime build, Dockerfile stage | An import walk from the runtime entry never reaches `client/config`, and its eager graph never reaches `react`; in a jsdom page the runtime starts the beacons, shows the banner when a choice is needed, and records nothing after a refusal |
| P3 | Pilot: bind a test subdomain to the pilot workspace, then run the ADR 0951 checks c–i | Live |
| P4 | Heat markup parity (`data-owx-section` from both renderers); runtime styles for page content; the runtime on podcast prerenders (they carry the CSP but not the tag, because their HEAD path sends a precomputed length); `adoptedStyleSheets` so `style-src` can drop `'unsafe-inline'` | — |

## Implementation record

**P1 (backend).**
- `features/publishing/siteRuntime.ts`: the tag, manifest, asset route and CSP.
- `host/boundSite.ts`: records the bound site, so the guard never imports a
  feature.
- `middleware/customDomain.ts`: the two prefixes and the beacon bucket.
- The `custom-domains.visitor-runtime` sub-toggle.
- Prerender sends now go through `sendPrerenderHtml`: the page and blog index,
  plus the CSP on the bot door and podcast prerenders.
- The tag carries `data-owp-privacy="/p/privacy"` only when the org has
  published a `privacy` page. The banner shows no privacy link otherwise. The
  SPA's link would point at the platform's own policy and 404 on a customer host.

Witness: `test/adr1015-site-runtime.test.ts`, 5 cases. Removing the prefixes or
the CSP turns 3 of them red.

**P2 (frontend).**
- `features/site/visitorApi.ts`: the five visitor modules read their base here,
  not from `client/config`.
- The hook moved to `useVisitorConsent.ts`.
- `VisitorConsentBanner` takes `privacyHref`.
- `visitorBeacon.sendPageview` handles the plain pageview. On the SPA, only
  experiment pageviews were ever sent, and that is unchanged.
- The banner CSS moved verbatim to `styles/features/visitor-consent.css`.
- `src/site-runtime/{main.ts, mountBanner.tsx, runtime.css}`.
- `vite.site-runtime.config.ts` (manifest-writing). `npm run build` now also runs
  `build:site-runtime`.
- The Dockerfile `site-runtime` stage copies into `/app/site-runtime`.

Sizes: the eager entry is 3.2 kB gzipped. The banner chunk (React, i18next and
the banner) is 67 kB gzipped and loads only when the posture answers or a choice
is stored.

Witness: `src/site-runtime/__tests__/siteRuntime.test.tsx`, 9 cases.
Re-adding a `client/config` import to the beacon module turns the import-graph
case red. The full frontend suite passes (1159 files).

**Review fixes (independent `/code-review` + `/architect`, 2026-10-31).** No
critical or high findings; the architecture verdict was "pass with fixes".
- **Cache skew and a slow kill switch:** fixed as described in the correction
  above.
- **Silent screen-reader announcements:** the banner speaks only through the
  app's one live region, which a customer page doesn't have, so `mountBanner`
  now mounts `GlobalLiveRegion` beside it (and `runtime.css` has `.sr-only`).
- **Focus return:** inside a shadow root the banner's document `focusin`
  listener saw the host, so it never remembered where focus came from. It now
  reads the composed path and never stores the host.
- **Dark mode:** `shadowCss` turned `:root:not(.theme-light)` into a selector
  that matches nothing. It now moves a compound into `:host(…)`.
- **Secondary buttons** rendered as primary; `runtime.css` now has
  `button.secondary`.
- **Catalog lookup** uses `Object.hasOwn`.
- **The toggle id** is one constant in `host/boundSite.ts`.
- **Eager-entry budget:** 12,000 B, enforced in the runtime build.
- **Tests added:** the beacon bucket, the kill switch, `no-cache`, and
  focus/announce. Each fix was sabotage-checked red.

**Train 174 (2026-10-31): the manifest latch.** The gate's
`detached-latch-tripwire` (the #3056 class) went red: `manifestPromise` cached
ANY failed read as "no runtime" for the life of the process. A missing or
malformed manifest is a fact about the image and stays cached. Any other read
failure now clears the latch, so the next request retries. Every caller awaits
the read, so it always settles and needs no time bound. Witnessed: the tripwire
and a new behaviour test (EISDIR, then a valid manifest, loads) both go red if
the latch is not cleared.

The same push adds a test that the platform origin's browser SPA shell never
carries the prerender CSP (Safari UA: none; Googlebot: the CSP).

## Open questions

1. The prerender ships no stylesheet, so customer pages are unstyled. If the
   prerender is the long-term customer renderer, styles and interactive islands
   (forms, booking) should ride this runtime later.
2. Replay on a tenant site makes the tenant the data controller. Is terms or
   data-processing copy needed before the toggle is offered outside the pilot?
3. Should the funnel viewer get heat and replay too (ADR 0951 leaves this open)?

No wire change: every route is a host extension under `/host/openwop-app/*`.
