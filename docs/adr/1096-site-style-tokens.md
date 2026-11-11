# ADR 1096 — Public-site style tokens

Status: Accepted (2026-11-10). Implemented in the PR that records it.

Follows [ADR 0920](0920-cms-section-styles.md) (section styles and front-page tokens) and
[ADR 1080](1080-design-led-site-sections.md). Host CMS styling only, so no wire RFC is involved.

## Context

The public CMS site has one surface style: filled cards with a 14 px corner and a
deep shadow, a raised plan card, section dividers, a 1140 px column, and a photo
hero whose picture fades in from the left at 82% opacity. Adopters with an
editorial design (flat, hairline-ruled, small corners) can only reach it by
overriding stock selectors in `brand.css`. Those overrides break on upgrades,
and they lose specificity battles with stock rules (`a.btn…`, `.public-shell …`).

A white-label deployment measured this directly: after closing every section-level
gap with its design, the live site still read as "chunky" against the design, and
every remaining difference came from these surface defaults.

## Decision

The surfaces read `--site-*` custom properties, each with a fallback equal to
today's value. `global.css` declares every token `initial` (the guaranteed-invalid
value) at `:root`, so `var()` takes the fallback and **a site that sets nothing
renders exactly as before**. An adopter sets them in `brand.css`, which loads after
`global.css`.

| Token | Surfaces |
|---|---|
| `--site-shell-max` | `.fp-shell` content width |
| `--site-section-pad` | `.fp-section` padding, top and bottom |
| `--site-section-rule` | The border between sections |
| `--site-card-bg`, `--site-card-border`, `--site-card-radius` | Plan, panel, progress and tile columns; FAQ items; the form card; muted-band cards; the ADR 1080 cards (status table, date calculator result, conversation panel, hero queue, richText card) |
| `--site-card-shadow` | The form card's shadow |
| `--site-card-raise-shadow`, `--site-card-raise-lift` | The highlighted plan card's glow and lift |
| `--site-media-radius` | Pictures in galleries, prose, FAQ and timeline sections |
| `--site-hero-image-opacity`, `--site-hero-image-mask` | The photo hero's picture opacity and fade |

The tokens are documented in `WHITE-LABEL.md` §2, with the stock value and a flat
example for each. The shipped `brand.css` is unchanged, so adopters' brand-seam
hashes do not move.

## Alternatives considered

- **A second, complete "editorial" theme.** Rejected for now: a parallel rule set
  doubles the surface every later site ADR must style. Tokens reach the same
  look, and a preset can later be a set of token values.
- **Per-section presentation fields** (like `tone`). Rejected: the look is a
  site-wide brand decision, not a per-section authoring choice.

## Verification

- `frontend/react/src/features/cms/__tests__/siteStyleTokens.test.ts`: every token
  is declared `initial`, every use has a fallback, and the named surfaces read them.
- `check-css-tokens` resolves every reference.
