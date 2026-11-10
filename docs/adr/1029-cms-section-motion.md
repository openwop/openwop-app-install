# ADR 1029 — CMS section motion, pattern layouts and designed tenant pages

Status: Accepted (David, 2026-11-02, relayed by yc-a1: "yes, have d3 start phase 1";
then in openwop-app-d3's session: "work through all phases"). P1 and P2 built.

## Context

David is redesigning the MyndHyve public site and wants richer public pages:
scroll-reveal timelines, tool marquees, an animated approval card, polished buttons
and cards. The candidate sources are community libraries: 21st.dev, Magic UI and
Aceternity (React + Tailwind + framer-motion), Uiverse (HTML/CSS, MIT), Animista
(CSS, FreeBSD), Open Props (CSS tokens, MIT), Codrops (inspiration), HyperUI and
Flowbite (Tailwind HTML).

What exists today (measured on `origin/main` `1726387e2`):

- **A closed section vocabulary.** `features/cms/cmsService.ts` `SECTION_TYPES`
  (15 types); `buildSectionData` validates every field per type and drops unknown
  values (ADR 0748: section bodies are closed per type; the protocol's open body is
  `fields`, RFC 0206).
- **Presentation enums are the precedent.** ADR 0920 added `tone`, `head`, column
  layouts and hero visuals as optional closed enums. A page that sets none renders
  byte-identically.
- **The human renderer** is `frontend/react/src/features/cms/SectionRenderer.tsx`
  (no `dangerouslySetInnerHTML`, ADR 0009). Section CSS is `.fp-*` in
  `styles/global.css`.
- **Motion already exists, at page level only.** Every public section rises in on
  page load (`@keyframes fp-rise`, `.cms-public-page > .cms-public-section`, staggered
  70 ms, 380 ms `--dur-enter`, `--ease-enter`), with a reduced-motion opt-out. Motion
  tokens live in `styles/foundations/tokens.css` and are mirrored in `tokens.json`
  (`check-dtcg-parity` fails on drift).
- **Brands override tokens, not selectors.** A distribution's `brand.css` (MyndHyve
  already animates its hero plan card with `mh-*` keyframes) and per-tenant runtime
  tokens (`THEMEABLE_TOKENS`, ADR 0170/0171/0510).
- **Crawlers get semantic HTML** (`features/publishing/sectionHtml.ts`). A new
  section TYPE costs a server branch; a new LAYOUT or field on an existing type
  does not.
- **Custom-domain pages are unstyled.** On a bound custom domain, humans and bots
  both get the semantic prerender (`publishing/routes.ts:211`), which links no
  stylesheet. None of the `.fp-*` design reaches a customer site.

MyndHyve's design review (yc-a1, 2026-11-02) asks for: reveal and stagger only,
ease-out, fully visible with motion off; no tilt, counter or sheen variants for
MyndHyve; P2 priority: the activity/approval hero card, then timeline, then bento.

## Decision

Port patterns **by hand** into tokenized CSS that this app owns, and let the CMS
choose them through **closed enums** on existing section types. Do not import the
libraries, do not store markup, do not render page sections through plugins.

### D1 — Motion tokens (Open Props style)

Add to `tokens.css` and `tokens.json` together:

| Token | Value | Use |
|---|---|---|
| `--ease-reveal` | `cubic-bezier(0, 0, 0.3, 1)` (Open Props `--ease-out-3`) | scroll reveals |
| `--reveal-distance` | `16px` | `reveal` travel |
| `--rise-distance` | `40px` | `rise` travel |
| `--stagger-step` | `6%` | how far into the view range each next item starts |

Brands override the tokens. A brand that wants no travel sets the distances to 0.

### D2 — A per-section `motion` enum

`motion?: 'none' | 'reveal' | 'stagger' | 'rise'` on every host section type except
`fields` (the protocol's open body is untouched; a field an author names "motion"
there stays their text and the renderer ignores it). Validated with `pickEnum` in
`buildSectionData`, **base layer only**: a locale overlay never carries it (motion is
not content), so an overlay's `motion` is dropped and the base value stands. It sits
in `buildSectionData`, not `validateSection`, because the shared-section lane builds
base data without `validateSection` (architect review, P1). A base `motion` never
moves a translation's source digest, which hashes only the overlay's keys.

| Value | Effect |
|---|---|
| absent | today's behaviour: the page-load rise and stagger |
| `none` | no motion for this section at all (opt out of the page-load rise too) |
| `reveal` | fades in and travels `--reveal-distance` as it scrolls into view |
| `rise` | the same with `--rise-distance` |
| `stagger` | the section's items reveal one after another as the section enters |

Rendered as `fp-motion fp-motion--<value>` on the section element, through a
separate `sectionMotionClass` so it never changes which other classes a section gets
(the faq and quotes sections add `fp-section` only when a tone is set).

Item lists that `stagger` addresses carry `fp-stagger` only when the section's motion
is `stagger`, so a section that never chose motion keeps its exact markup (the ADR
0920 additive rule): columns in every layout, faq and quotes. Comparison rows are
excluded: a table row must not move.

### D3 — Scroll-driven, never JS, always readable

- The animations use `animation-timeline: view()` inside
  `@supports (animation-timeline: view())`, inside
  `@media screen and (prefers-reduced-motion: no-preference)`, and under
  `:root:not([data-reduce-motion="reduce"])` (the in-app "Reduce motion" setting, ADR
  0363 P4, which a media query cannot see). Nothing else animates.
- The range is `entry 0%` to `entry 100%`. A box reaches `entry 100%` once it is fully
  in view, or once it fills the view if it is taller, so a page too short to scroll, a
  tall hero, and the last section at the bottom of a page are never left faded.
  `stagger` starts each next item `--stagger-step` later and ends every item at
  `entry 100%`.
- The selectors name both page shapes (the live page and the CMS preview's
  `.cms-pv-section` wrapper) and follow the page-load rise rules, so a section's motion
  replaces the page-load rise. `none` removes the page-load rise too.
- Where either does not hold (Firefox stable as of mid-2026, reduced motion,
  print), a `reveal`/`rise`/`stagger` section is simply in its final state. There is
  no hidden-until-observed state and no JavaScript.
- Print never animates (the rules are `screen` only), so an unscrolled section never
  prints at opacity 0.
- Text is never animated character by character, nothing loops, nothing flashes.
- Screen readers are unaffected (opacity and transform only).

### D4 — Provenance

`frontend/react/src/styles/vendor-patterns/PROVENANCE.json` records every value or
pattern taken from a third-party source (source URL, author, license, what was
adapted). `NOTICE` gets a "Ported design patterns" section with the notice text each
license requires. P1 ports one value: Open Props' `--ease-out-3` curve (MIT).

### D5 — Pattern layouts on existing types (P2)

In MyndHyve's priority order, each a closed enum value with real text, a11y and a
reduced-motion final state, and no new section type:

1. hero `visual: 'activity'` — an approval/activity card: a `figure` of data-driven
   rows. Inert text, like ADR 0920's `plan` card. Each row is an `actor`, an
   `action`, an optional `meta` and `status` (the author's own words, ≤ 80), and a
   closed styling `state` (`done | waiting | approved | flagged`). **Correction
   (P2 build):** the status was first a closed enum; it became authored text plus a
   separate `state`, because the crawler renderer has no translations, so a fixed
   status word would have reached crawlers in English while visitors read it in
   their language. Rows rise in once on load, never loop.
2. columns `layout: 'timeline'` — an ordered list with a rail; the rail fills with
   the view timeline.
3. columns `layout: 'bento'` — a CSS grid where an item may set `span: 2`.
4. columns `layout: 'marquee'` — a logo or tool strip; the duplicate track is
   `aria-hidden` and `inert`; a visible pause button (WCAG 2.2.2) plus pause on
   hover and focus; reduced motion shows a static wrapped list.

Every layout ships with its editor controls (the activity rows, a "date or stage"
label for timeline items, a "wide" checkbox for bento tiles), so nothing can be
chosen that cannot be filled in. That is the gap ADR 0920's own P2 left open, and
the architect review of this phase asked not to repeat it. Crawlers get the same
words: the activity card as escaped text, a timeline as an ordered list, bento and
marquee as the default list of titled items.

Not built for MyndHyve: tilt, counter and sheen. Whether the platform ships them is
recorded under Open questions.

### D6 — Brand and tenant motion presets (P3)

- A distribution's `brand.css` overrides the D1 tokens (MyndHyve's `mh-*` hero curve
  moves onto them).
- The D1 tokens join `THEMEABLE_TOKENS` behind a closed grammar (cubic-bezier, a
  duration in ms, a length in px or 0). They carry no contrast, so they are not
  generator-owned (ADR 0510 §5).
- The Appearance panel gets a motion preset: `calm` (default values), `lively`
  (longer travel), `none` (distances 0).

> **CORRECTED 2026-11-02 (P3 architect review and build).** Two things above were
> wrong. (1) "Tenants … get motion presets": the brand identity this rides on is
> per DEPLOYMENT. `/public-brand` and the Appearance panel are superadmin and
> host-wide (ADR 0170), and no workspace has a site theme to hang a preset on;
> that only means something with P4's designed custom-domain pages. So P3 is a
> host/distribution preset; a per-workspace preset is a P4 follow-on. (2) The
> tokens did not join `THEMEABLE_TOKENS`: the preset is a closed enum on the
> generative theme inputs (`BrandTheme.motion: 'calm' | 'lively' | 'subtle'`,
> beside `radius`), expanded by the generator into the D1 tokens, identical in
> light and dark. No arbitrary values are accepted. `none` became `subtle` (fade,
> no travel), because a token preset cannot stop an animation; a section stops
> its own with `motion: 'none'`. The generator's stock fast path carries the
> preset too, so a motion-only theme is not dropped. `lively` uses Open Props
> `--ease-out-4` (MIT, PROVENANCE.json).

### D7 — Designed custom-domain pages (P4)

Custom-domain pages get the designed look: the prerender serves a hashed public-site
stylesheet (the `.fp-*` and motion CSS) through the ADR 1015 `_rt` manifest, and
`sectionHtml` emits the same class names as the SPA. Specified in its own ADR before
it is built, because it changes what every bound domain serves.

## Alternatives weighed

- **A sanitized custom HTML/CSS block for owners.** Rejected: ADR 0009 and ADR 0920
  already rejected stored markup; it reopens stored XSS and overlay spoofing on
  multi-tenant public pages, escapes localization and the crawler renderer, and
  breaks dark mode.
- **A component plugin section.** Rejected: RFC 0117 plugins run in opaque-origin
  iframes (ADR 0300, 1021): no SEO, no tokens, an iframe per section.
- **Importing Tailwind libraries.** Rejected: preflight clashes with `global.css`,
  utility colours bypass the token gates, a second theming system, uneven licenses
  (Aceternity Pro is proprietary; 21st.dev is per component).
- **IntersectionObserver reveals.** Rejected for P1: needs JS on every public page,
  and the usual implementation hides content until the observer fires, which fails
  closed (invisible) when the script does not run.

## Wire

Not wire-affecting. `motion` is a field on host section types (ADR 0027), the same
class as ADR 0920's `tone`. The protocol's open section body (`fields`) is untouched.
No RFC.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P1 | D1 tokens, D2 `motion` enum (validator, renderer, editor, i18n), D3 CSS, D4 provenance | PR #5481 |
| P2 | D5 layouts: activity card, timeline, bento, marquee, with editor controls and crawler text | built (PR after #5481) |
| P3 | D6 host/distribution motion preset (Appearance panel), MyndHyve's brand.css on the tokens | built |
| P4 | D7 designed custom-domain pages: ADR 1030 (a site stylesheet for the semantic prerender, behind `custom-domains.designed-pages`) | built |

## Open questions

1. Tilt, counter and sheen: MyndHyve does not want them. Not built unless another
   distribution asks.
2. Whether tenants (not only distributions) get motion presets: P3 says yes, behind
   the Appearance panel's existing admin gate.

> **CORRECTED 2026-11-03 (ADR 1046).** The rejected "sanitized custom HTML/CSS
> block" alternative above is superseded for custom domains by ADR 1046: pack
> components (typed props, Shadow DOM, JS only on bound domains) and admin code
> injection (custom domains only, per-site CSP, consent-gated).
