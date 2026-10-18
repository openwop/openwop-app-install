# ADR 0883 — The display face is Bricolage Grotesque, not Instrument Serif

Status: **Accepted — implemented** (this PR). Mirrored by the same change in
kicktodo and openwop-site; Book AI takes Source Serif 4 instead (§4).

Research behind the choice (font auditions in the real UI, then a sourced
review of the two shortlisted faces):
<https://claude.ai/artifact/SX9fgzrKxn6hqZpzx7bXjM>.

## Context

Since the first DESIGN.md the brand type triple has been Instrument Serif
(display) + Geist (body) + Geist Mono (labels). On 2026-10-13 the user rejected
Instrument Serif across all five products (openwop, openwop-app, openwop-site,
kicktodo, Book AI): on screen it "looks delicate and out of place". The
cause is measurable. The face ships ONE weight (400) with fine hairlines, so a
heading set in it is lighter than the 14px Geist body beside it. It also has
no tabular figures, so every `font-variant-numeric: tabular-nums` on a
`--serif` numeral (gauges, outcome counts, the seat timer) did nothing.

## Decision

1. **`--serif` resolves to Bricolage Grotesque** (Mathieu Triay, OFL, Google
   Fonts since 2023-06-14). It is a variable grotesk with weight (200–800),
   width (75–100) and optical-size (12–96) axes. The browser applies optical
   size automatically, so 22px card titles get the plainer small-size design
   and 80px heroes get the sharper display design.
2. **The token keeps its name.** `--serif` is the DISPLAY role; operators
   override it by that name in `brand.css`, the Appearance editor
   (`FONT_PAIRINGS`) and stored brand typography. Renaming it would silently
   drop every existing override.
3. **New token `--weight-display: 600`.** Display rules used to say
   `--weight-body` (400) because the old face had no other weight. All 42 rules
   that set `font-family: var(--serif)` now use `--weight-display`. Six short
   running-text uses (KickTodo journal note, outcome and proposal note, CMS
   quote, ledger persona name, verify-email address) keep 400. Reviewers agree
   Bricolage is for headings, not paragraphs.
4. **No italics in the display face.** Bricolage has no italic, and a browser-
   synthesized slant looks poor at display sizes. The five italic accents
   (wordmark "WOP", sign-in title `em`, CMS headline `*emphasis*`, ledger
   persona names, verify-email address) are now upright and keep their clay
   colour, which already carried the emphasis.
5. **Fallback face is measured, as before (DSYS-3).** `Bricolage Grotesque
   Fallback` uses local Arial Bold (its average advance at 600 is within 1% of
   Bricolage's). The ascent/descent overrides come from the vendored woff2's
   typo metrics (930/270, USE_TYPO_METRICS set). `fontMetrics.test.ts` pins
   them.

Book AI is a book-writing product, so it keeps a serif, but a sturdy one:
**Source Serif 4 at 600 with optical size pinned** (`font-optical-sizing:
none`). Left automatic, large headings switch to its high-contrast Display
design, the thin-stroke look this ADR removes. That change lives in the bookai
repo.

## Alternatives weighed

- **Geist 600 for headings** (one family, zero extra bytes). The most neutral
  "app" option, and the recommendation before the user shortlisted. Rejected
  by the user in favour of Bricolage's character.
- **Instrument Sans** (the serif's sibling). It keeps the lineage but is close
  to Geist, so headings and body would barely differ.
- **Source Serif 4 everywhere.** That would mean three families on a page
  (Bricolage, Source Serif, Geist) with no rule for which heading gets which.
  It is kept to Book AI only.

## Trade-offs

- **Bytes.** Latin Bricolage (variable, opsz + wght 400–700) is 77 KB against
  15 KB for Instrument Serif's upright plus 15 KB for its italic. It loads with
  `display=swap` behind a metric-matched fallback, so the cost is bandwidth
  only, not layout shift.
- **Familiarity.** Bricolage is common on SaaS landing pages, often as huge 800-
  weight text over gradients. We use 600, the warm paper/clay palette and no
  gradient heroes, which avoids that template look.
- **Stored overrides.** A tenant that explicitly saved the old "Editorial"
  pairing in its brand typography keeps Instrument Serif until it re-picks a
  pairing; the stored value wins by design.

## Implementation record

| Change | Where |
| --- | --- |
| Stack, fallback face, `--weight-display` | `styles/foundations/tokens.css`, `styles/tokens.json` |
| 42 display rules → `--weight-display`; 5 italics upright | `styles/global.css`, `styles/primitives/adr0510.css` |
| Default `fontsHref`, favicon glyph, Editorial pairing | `brand/defaults.ts` |
| Published film tokens regenerated | `public/design-tokens.{css,json}` |
| Vendored e2e fonts swapped; metric pin re-pointed | `e2e/assets/fonts/`, `scripts/__tests__/fontMetrics.test.ts`, `e2e/design-system.spec.ts` |
| Visual baselines regenerated and inspected | `e2e/*-snapshots/` |
| Contract note | `DESIGN.md` §2 correction |

## Correction (2026-10-14): a stored override kept Instrument Serif live

The implementation record said app.openwop.dev was verified live after the
deploy. That check read the shell's font link, not the page as a visitor sees it.
The live page still rendered Instrument Serif: the reserved app brand
(`brand:host-app`, ADR 0170) held `identity.typography` equal to the OLD
"Editorial (default)" pairing, and `applyBrandIdentity` set `--serif` inline and
injected `link[data-brand-fonts]`, overriding the new `tokens.css` default. Found
when re-capturing a film screenshot from the live page.

Cause: the Appearance editor COPIED the default pairing's fonts into the override
whenever a super admin picked "Editorial (default)" or the "Clay (default)"
preset, so changing the default could never reach that host.

Fixed in three places:

- **Production data** (2026-10-14, by the release coordinator, user-approved):
  `typography` removed from the app brand; `colors.accent` kept.
- **Editor:** choosing the default pairing (directly or via its preset) now
  CLEARS the font override instead of storing it, and the pairing select shows
  "Editorial (default)" when there is no override.
- **`applyBrandIdentity`:** a whole identity with no font value now removes the
  inline `--serif`/`--sans`/`--mono` and the brand font link, so a cleared
  override takes effect without a reload and the pre-paint cache cannot pin it.
- **Other installs:** the background app job
  `clear-frozen-legacy-default-typography` drops the exact legacy set
  (`LEGACY_DEFAULT_TYPOGRAPHY` in `host/systemBrand.ts`) once, by CAS. Any other
  font choice, including a different Instrument Serif combination, is the
  operator's and stays.

Lesson: verify a font change by the computed style of a rendered heading on the
live page with a fresh profile, not by the markup.
