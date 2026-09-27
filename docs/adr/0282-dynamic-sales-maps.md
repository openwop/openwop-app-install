# ADR 0282 — Dynamic Sales Maps (geographic territory & dealer visualization)

**Status:** implemented
**Date:** 2026-07-06
**Depends on:** ADR 0001 (feature-package), ADR 0006 (RBAC), ADR 0272 (Territories —
attainment to colour by), ADR 0281 (Dealers/Outlets — points to plot), ADR 0024
(Connections/BYOK — geocoding), ADR 0015 (tenant).
**Toggle:** `sales-maps` (new, default OFF, `bucketUnit: tenant`)
**Surfaces:** authed `/v1/host/openwop-app/sales-maps/orgs/:orgId/geocode` (host-ext) +
a frontend map component. **RFC gate: NO new wire RFC.**

## 1. Context
Concept 9 of the deep-dive (Salesforce Maps / eSpatial / Maptive): visualize territories
(choropleth by coverage/attainment) and dealer/outlet locations (pins) on a map. The
frontend ships **no map library** and the reference app has no geo layer.

## 2. THE decision that gates this ADR — the map library (CSP-safe)
The Artifact/app CSP **forbids external tile CDNs** (no mapbox/maplibre raster tiles from a
3rd-party host), and the entry bundle is budget-gated. Options weighed:

| Option | CSP | Bundle | Fit | Verdict |
|---|---|---|---|---|
| **A. Bundled-GeoJSON SVG/Canvas choropleth** (d3-geo projection over vendored country/state boundaries; pins = projected lat/lng) | ✅ no external host | ✅ light (geometry only) | region colouring + point overlay — exactly the territory/dealer need | **RECOMMENDED** |
| B. maplibre-gl + **self-hosted** vector tiles | ✅ if tiles self-hosted | ❌ heavy lib + a tile-serving deploy | raster/zoomable basemaps we don't need for region viz | deferred (only if rooftop basemaps are later required) |
| C. Leaflet + a 3rd-party tile CDN | ❌ CSP block | — | — | rejected (violates CSP) |

**Chosen: A.** A vendored GeoJSON of admin boundaries (country → state/province, the
granularity territories are defined at) rendered as an SVG/Canvas choropleth, coloured by a
territory's rolled attainment (ADR 0272), with dealer/outlet **pins** projected onto the
same `d3-geo` projection. No external network, CSP-clean, bundle-friendly, and it matches
the *region*-level nature of sales territories (not street-level routing). If street-level
basemaps are ever needed, Option B (self-hosted tiles) is the documented upgrade path.

## 3. Boundaries audit
- No map lib in `frontend/react/package.json`; `/sales-maps` prefix free.
- **Data is composed, not owned:** territory shapes/attainment from ADR 0272; dealer/outlet
  points from ADR 0281. This feature owns only (a) the vendored boundary GeoJSON, (b) a
  server-side **geocoding cache** (address → lat/lng), (c) the frontend map component.
- **Geocoding rides a BYOK Connection (ADR 0024)** server-side (SSRF-guarded egress, RFC
  0079) — never client → 3rd-party; results cached in a `sales-maps:geocode` collection.

## 4. Evaluation matrix
| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `src/features/sales-maps/` (backend: geocode seam + cache) + `frontend/react/src/features/sales-maps/` (MapView). |
| 2 | Toggle + admin | `sales-maps`, OFF, `tenant`, category Business Tools. |
| 3 | Workflow surface | None required (visualization); an optional `ctx.features.sales-maps.geocode` read. |
| 4 | Node pack | Optional `geocode` node (read); no writes. |
| 5 | Agent pack | None (not an AI surface). |
| 6 | Public surface | None. |
| 7 | RBAC | Geocode endpoint `workspace:write` (it spends a BYOK provider call) + rate-limited; the map reads compose the callers' already-scoped territory/dealer data. |
| 8 | Replay | N/A (frontend viz); geocode cache is a non-run side-effect. |
| 9 | Frontend | `MapView` (SVG/Canvas choropleth + pins) — a shared component the Territories page (colour by attainment) and the Dealers page (outlet pins) both embed. Designed empty/loading/error; light+dark via tokens; a11y (a table fallback of the same data — maps are not keyboard/SR-navigable, so the data MUST also be available as a list/table per WCAG). |
| 10 | Bundle | `d3-geo` + a *minified* boundary GeoJSON; measure against the entry budget — the MapView is a **lazy chunk**, so only its route manifest is entry-resident. |

## 5. RFC gate — host-extension, NO RFC
Geocoding is a BYOK-credentialed server-side call over a Connection (not the wire); the map
is frontend. No wire event, no capability advert.

## 6. Phased plan
P1 the library decision (this ADR) + vendored boundary GeoJSON + an SVG choropleth of
territories coloured by attainment (ADR 0272) — **+ the mandatory table fallback**. P2 the
geocoding seam (BYOK Connection + cache) + outlet/dealer pins (ADR 0281). P3 interactive
territory hover/select tying the map to the attainment table. Reviews per phase; **`/ux-review`
is a gate** (a11y of a non-SR-navigable map is the key risk — the data-table fallback is required).

## 7. Alternatives weighed
See §2. The core call is **A (bundled GeoJSON SVG)** over B (self-hosted tiles) and C
(3rd-party tiles, CSP-illegal), because sales territories are *region*-level and A needs no
tile infrastructure while staying CSP-clean and bundle-light.

## 8. Open questions
- Boundary GeoJSON granularity/source (Natural Earth admin-1 is the likely vendored source; license-check) + how far to simplify geometry for bundle size.
  **RESOLVED (P4, 2026-07-12):** vendored **Natural Earth 1:110m admin-0 countries** (public domain — no license constraint), converted by `frontend/react/scripts/vendor-boundaries.mjs` (coords rounded to 2 decimals ≈ 1.1 km, consecutive-duplicate dedupe, Antarctica dropped) into the committed `worldBoundaries.ts` (176 countries, ~53 kB gzip inside the lazy sales-maps chunk — well under the 210 kB chunk budget). Admin-0 (countries), not admin-1 (states/provinces), is the shipped granularity: territory models name countries/markets today; admin-1 remains the upgrade path via the same script.
- Which geocoding provider(s) to support as Connections (Google/Mapbox Geocoding via BYOK) — a provider manifest, not baked.

## 9. Recorded non-ships
Street-level raster basemaps + routing/drive-time (Salesforce Maps territory-optimization
tier) — the region choropleth is the v1; self-hosted vector tiles (Option B) is the upgrade path.

## 10. Implementation (P1–P3)
| Phase | What shipped | Notes |
|---|---|---|
| P1 | Equirectangular `projection` (unit-tested) + vendored boundary **seed** GeoJSON + `MapView` (accent-opacity choropleth + **mandatory data-table fallback**) + `/sales-map` page composing ADR 0272 attainment; backend toggle | `frontend/.../sales-maps/*`, `projection.test.ts` |
| P2 | Geocoding cache + `POST …/geocode` (`workspace:write`): manual lat/lng + cache hits need no provider; a genuine miss fails LOUD (`capability_not_provided`) — never fabricated. Outlet **pins** composing ADR 0281 (outlets with coords). | `entities/geocode.ts`, `routes.ts`; `sales-maps-geocode.test.ts` |
| P3 | Interactive hover/click on a region → emphasis + auto-open + highlighted table row (`aria-current`) — ties the map to its accessible table | `MapView.tsx` |
| P4 | **Real world geometry** — vendored Natural Earth 1:110m admin-0 countries (176) via `scripts/vendor-boundaries.mjs` → generated `worldBoundaries.ts`; alias-aware territory matching (`matchValuesToRegions`); a11y table sorts matched countries first | `boundaries.ts`, `worldBoundaries.ts`, `boundaries.test.ts` |
| P5 | **Map interactivity** — viewBox zoom (pinch/⌘-wheel anchored to cursor, double-click, labelled +/−/reset buttons; pure math in `mapViewport.ts`, unit-tested), drag-pan when zoomed, designed hover tooltip (regions: name+value; pins: name/kind/address — replaces the native `<title>`), clickable pins selecting their locations-table row (the P3 click→table tie; superseded on the sales-map page by the P6 outlet-detail deep-link — ADR 0281 P6 — via the `onPointClick` seam, with row-select remaining the default for other MapView consumers). Plain scroll stays with the page (no scroll hijack); pins counter-scale so they stay dot-sized | `MapView.tsx`, `mapViewport.ts`, `mapViewport.test.ts` |
| P7 | **Territory→region mapping field** (§8 follow-up resolved) — `Territory.regionId` + attainment ride-through (backend), planning-model picker on the Territories page (generated id+name `regionCatalog.ts`, geometry stays in the sales-maps chunk), `regionValues` explicit-wins matching ladder | `territories.ts`, `quota.ts`, `TerritoriesPage.tsx`, `boundaries.ts`, `vendor-boundaries.mjs` |

**Corrections vs plan:**
1. **§2 d3-geo → self-implemented projection.** The plan named d3-geo; I implemented the equirectangular projection directly (~15 lines, unit-tested) rather than add the dependency — lighter bundle, no new dep, same result. d3-geo remains the documented upgrade path for advanced projections.
2. **§3 live geocoding provider — behind a BYOK Connection, untestable here.** The manual + cache paths ship + are tested; the live provider egress activates when a geocoding Connection is configured (the RFC 0108 self-hosted-provider precedent — a BYOK surface can't have a public curl-witness). A miss fails loud rather than fabricating a coordinate.
3. **Boundary GeoJSON is a low-res SEED** (§8), not production Natural Earth admin-1 — the feature (projection/choropleth/pins/table) is complete; only the boundary DATA is a documented vendoring follow-up. Territories match regions by NAME (a territory→region mapping field is the production follow-up).
   **SUPERSEDED by P4 (2026-07-12):** the hand-drawn 6-region seed is replaced by vendored Natural Earth 110m admin-0 countries (§8 resolution above). Name matching now also covers each country's aliases (NAME_LONG / ISO codes — "United States", "USA" → "United States of America"); the territory→region mapping FIELD remains the follow-up for names that aren't countries.
   **RESOLVED by P7 (2026-07-12):** the mapping field shipped — `Territory.regionId` (optional Natural Earth ADM0_A3 lowercase id; JSON-blob row, no migration) settable at create and PATCHable while a model is in planning; rides the attainment payload; the map's `regionValues` ladder prefers it over name/alias matching. The Territories page picker sources the new generated `regionCatalog.ts` (id+name, ~7 kB) so the geometry stays exclusive to the sales-maps chunk.

**Compose points:** `MapView` is exported for the Territories page (colour by attainment) and Dealers page (outlet pins) to embed — the ADR 0281 §10 "map view composes ADR 0282" hook. The `/sales-map` standalone page is the first-class demo.

## Correction note (2026-08-15 — F4, UX_UPGRADE-sales-maps R2)

The geocoding capability this ADR describes is designed but **not
configurable into existence** in the shipped host: no geocoding provider is
implemented, `geocode.ts` unconditionally throws `capability_not_provided`,
the geocode route has zero callers, `updateOutlet` has no frontend client,
and the outlet form collects name+address only. Consequently no product
surface can produce an outlet coordinate, and the map's "N more outlet(s)
have no coordinates" line reads N = all outlets permanently. The design
stands as the tracked lane; making it real requires a provider integration,
a manual lat/lng field on the outlet form, or both (tracked as F4 in the
feature tracker). Per the correct-don't-rewrite rule this is recorded here
rather than edited into the decision text.
