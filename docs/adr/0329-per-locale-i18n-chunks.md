# ADR 0329 — Per-locale i18n chunks: only `en` ships eagerly

**Status:** implemented
**Date:** 2026-07-10
**Depends on / composes:** ADR 0065 (per-feature i18n catalogs + the
`import.meta.glob` aggregation seam in `src/i18n/resources.ts`), the
`check-bundle-budget` gate, the existing lazy-locale mechanism
(`ensureLocaleLoaded`, shipped for fr/es).

## Context

Every locale catalog (en, pt-BR, fr, es) is real multi-locale copy that grows
with every feature. fr/es were already lazy, but the eager `i18n` chunk
bundled **en + pt-BR together**, so the chunk grew at 2× the rate any single
user benefits from — and every user paid for both. The localization waves of
2026-07-09/10 (routing-correction i18n, the rule-13 chip vocabularies, the
territories namespace) forced **four bundle-budget bumps in two days**
(299 → 300 → 303 → 304 kB gzip). The budget gate had stopped guarding
anything real: it was just tracking total translation volume.

## Decision

1. **Only `en` is eagerly bundled.** It is the fallback locale and the
   source-of-truth catalog (`check-i18n` parity is measured against it), so it
   must paint with no network round-trip.
2. **Every other locale — supported or preview — is one lazy chunk per
   locale** (`i18n-pt-BR`, `i18n-fr`, `i18n-es`), produced by the
   `manualChunks` rule in `vite.config.ts` grouping that locale's catalog
   modules into a single named async chunk (one request per locale switch, not
   ~100 per-catalog fetches). Loading rides the existing `lazyLocaleGlobs` +
   `ensureLocaleLoaded` path unchanged: an auto-negotiated or user-selected
   lazy locale paints `en` first, then swaps when its chunk arrives — the
   posture fr/es have had in production since ADR 0065's lazy tier shipped.
3. **The bundling decision stays independent of the advertise decision**
   (`SUPPORTED_LOCALES`): pt-BR remains fully supported and auto-negotiated;
   it just loads on demand now.
4. **The chunk budget drops 304 → 210 kB gzip** and goes back to guarding the
   real largest chunk (`markdown`, ~201 kB). Locale copy growth no longer
   moves the ceiling; only genuine non-locale chunk growth does.

## Alternatives weighed

- **Keep pt-BR eager, keep bumping.** Rejected: the gate degrades into a
  changelog; every user downloads every locale forever.
- **Per-file async catalogs for pt-BR (the old fr/es shape).** Rejected in
  favor of one named chunk per locale: a locale always loads whole, so ~100
  small requests is pure overhead.
- **HTTP-served JSON catalogs (i18next-http-backend).** Rejected: the glob
  aggregation (ADR 0065) keeps catalogs typed, tree-shaken with their feature
  boundaries, and parity-checked at build time; moving to served JSON would
  trade that for infra with no additional win over async chunks.

## Trade-offs accepted

- A pt-BR/fr/es user's **first paint is English** for the instant before
  their locale chunk arrives (same-origin asset, typically <100 ms on the
  CDN). This was already the accepted posture for fr/es; pt-BR joins it.
- Numbers/dates never flash: `src/i18n/format.ts` formats from the negotiated
  locale, not the loaded catalog.

## Measured result (at landing)

| Chunk | Before | After |
|---|---|---|
| eager `i18n` (every user) | 303.3 kB gzip (en+pt-BR + libs) | 162.4 kB gzip (en + libs) |
| `i18n-pt-BR` (lazy) | — | 140.8 kB gzip |
| `i18n-fr` / `i18n-es` (lazy) | per-file async modules | 145.5 / 143.0 kB gzip (one chunk each) |
| chunk budget | 304 kB | 210 kB (guards `markdown`) |

## Implementation

`src/i18n/resources.ts` (pt-BR moved from the eager build to
`lazyLocaleGlobs`), `vite.config.ts` (lazy-locale regex → named
`i18n-<locale>` chunks), `scripts/check-bundle-budget.mjs` (ceiling + log),
`src/i18n/__tests__/i18n.test.ts` (pt-BR parity/translation tests now
exercise the lazy loader). No wire surface; no RFC needed.
