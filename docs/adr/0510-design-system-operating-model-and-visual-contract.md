# ADR 0510 — Design-system operating model and visual contract

Status: Accepted (Phases 0–9 implemented; three tracked remainders — Media asset pipeline, evidence-gated IA, human AT verification — plus the ratchet programs)
Date: 2026-08-01

## Context

OpenWOP has a distinctive and capable visual system: an OKLCH-based light/dark
palette, generative white-label themes, strong state primitives, an editorial-
technical voice, accessibility preferences, and build-time token checks. The
2026-08-01 design-system assessment nevertheless found that the implementation
operates below the level of its visual language. Its main stylesheet is an
11,000-line mixed-ownership cascade; two token vocabularies coexist; typography,
spacing, motion, breakpoints, and static inline styles are weakly governed; and
there is no blocking visual-contract matrix.

The evidence and stable finding identifiers are recorded in
`docs/steward/DESIGN-SYSTEM-ASSESSMENT.md`; the implementation sequence is
`docs/steward/DESIGN-SYSTEM-GAP-CLOSURE-PLAN.md`.

## Boundary audit

| Concern | Existing owner | Decision |
|---|---|---|
| Runtime identity and theme generation | `brand`, ADR 0170/0171 | Extend it; no second provider or theme namespace. |
| Brand asset bytes and lifecycle | Media, ADR 0007 | Reuse upload/storage/serve/lifecycle seams. |
| Theme, motion, density, and a11y preferences | Settings + `ui/a11yPrefs`, ADR 0363/0396 | One preference state; all CSS and JS motion consume it. |
| Route, navigation, and hub projection | `FEATURES`, `NavConfigProvider`, hub projection, ADR 0139/0145 | Reorganize metadata; no second navigation registry. |
| Canvas behavior | Canvas chassis, ADR 0310 family | Add shared touch capabilities before editor-specific adaptations. |
| Browser merge gate | Playwright lane, ADR 0509 | Extend the existing promoted lane. |
| Protocol surface | OpenWOP wire | Unchanged. Host UI and host-extension data only. |

This change fits existing extension seams. It adds no feature toggle, feature
package, pack, capability advertisement, run/event field, or new persistent
store. The optional brand-asset schema remains additive on the existing Brand
record and references Media-owned assets.

## Decision

### 1. The design system is always-on core infrastructure

Tokens, shared primitives, accessibility semantics, responsive contracts, and
visual regression are not product features and cannot be disabled. Product
features consume this layer through `frontend/react/src/ui/`, semantic CSS
tokens, and declared page archetypes.

### 2. One portable token graph describes identity and intent

Adopt a Design Tokens Community Group (DTCG)-format source describing token name,
type, role, stock value, light/dark values, and whether a token is themeable.
Generate CSS declarations and TypeScript metadata from it.

The layers are primitive scales, semantic decisions, component tokens, and
feature-local composition. Existing CSS custom-property names remain stable
during migration. ADR 0171's OKLCH generator remains the runtime value owner for
custom themes; the DTCG graph defines identities and contracts, not a parallel
runtime. Legacy `--color-*` and `--font-*` aliases are migration-only and
ratcheted to zero.

### 3. CSS has explicit ownership and deterministic layer order

The bundled order is foundations → primitives → chrome/layout → feature owners →
canvas owners → white-label overrides. Source files may be modular, but production
receives one deterministic Vite bundle. A feature rule cannot live in foundations,
and moved rules cannot remain duplicated in the old owner.

Migration occurs only behind a visual baseline and in coherent ownership tranches.
`!important` and specificity escalation are not migration mechanisms.

### 4. Component intent is explicit

Shared actions use an explicit `Button` variant/size API. The native `button`
selector provides reset and baseline behavior only. Compact embedded states use
shared `InlineState` and `EmptyRow` primitives composed from the established
Notice/StateCard/announcer semantics.

Static layout and typography belong in classes or typed component props. Inline
styles are restricted to measured/data-derived geometry, transforms, progress,
virtualization, and CSS custom-property forwarding. Exception categories are
machine-enforced.

### 5. Theme conformance fails closed

Contrast is evaluated against complete effective light and dark maps: stock fixed
tokens + generated tokens + permitted overrides. A missing required token, an
unparsable value, or an insufficient ratio is a validation failure rather than a
skipped pair. WCAG 2.2 AA is the save gate; APCA remains advisory.

Contrast-critical tokens are generator-owned and cannot be undercut by an advanced
override. Frontend and backend enforce the closed set. Appearance cannot confirm
through a failing save.

### 6. Brand assets are mode-aware and Media-backed

One `BrandMark` primitive renders public and authenticated chrome and chooses
light/dark variants using the app's effective mode, not an SVG's OS media query.
The default mark has one canonical source. Custom app-brand assets reuse Media
upload/storage/serve with an explicit host-owned lifecycle; arbitrary tenant
assets are never exposed through the public brand response.

SVG or raster input is byte/MIME validated, size bounded, and sanitized or
rasterized. Current URL fields remain readable through a compatibility window.

### 7. Visual and semantic behavior are merge contracts

An in-repo engineering gallery renders shared primitives and composed patterns in
meaningful states. Playwright snapshots the gallery plus critical routes across
theme, custom brand, contrast/focus preferences, density, font scale, direction,
zoom, and representative widths.

Axe failures for in-scope WCAG A/AA rules block. Exceptions are narrow, owned,
reasoned, issue-linked, and expiring. Screenshot updates are explicit review acts;
broad masking is forbidden.

### 8. Routes declare page archetype and responsive intent

Every route declares one of: standard index, data-dense index, detail, admin, hub,
public/marketing, immersive chat, or canvas/editor. Each archetype defines heading,
action, state, width, and responsive obligations.

Breakpoints express layout intent (content, shell, rail, canvas). Coarse-pointer
targets provide at least a 44 CSS pixel effective hit area. Navigation remains
manifest-derived; IA consolidation uses existing metadata, resolved navigation,
command palette, breadcrumbs, and deep links. URLs and entitlements remain stable.

### 9. Canvas touch support is declared, not implied

Each editor declares support for view, comment/present, light edit, or full
authoring on touch devices. Shared pointer capture, pan/zoom, selection handles,
soft-keyboard avoidance, gesture alternatives, and action overflow belong to the
canvas chassis. A larger-screen warning is a fallback, not parity.

### 10. Documentation explains rules; generators report facts

`DESIGN.md` contains durable direction, semantic rules, archetypes, and exception
policy. Machine-generated inventories report volatile tokens, aliases, keyframes,
breakpoints, CSS volume, and route adoption. Stale numeric facts in prose are
defects.

## Delivery phases

| Phase | Outcome | Assessment findings |
|---|---|---|
| 0 | ADR, reproducible inventory, reconciled documentation | DSA-001–005 |
| 1 | Contrast, logo, semantics, motion, and chat-overlap blockers | DSA-009, 014, 015, 019, 020, 025 |
| 2 | Gallery, visual snapshots, strict axe gate | DSA-021, 022, 031 |
| 3 | DTCG graph, generated registries, token/breakpoint/archetype gates | DSA-001–008, 012, 024, 029, 032 |
| 4 | Button/InlineState APIs, inline-style and touch-target convergence | DSA-011, 013, 023, 030 |
| 5 | Ownership-based CSS modules | DSA-010 |
| 6 | Media-backed brand assets and resilient typography | DSA-016–018 |
| 7 | Mobile admin and job/suite IA | DSA-026, 028, 029 |
| 8 | Canvas touch capability program | DSA-027 |
| 9 | Expanded a11y matrix and final re-grade | all |

Each implementation commit cites this ADR phase and exact `DSA-*` IDs.

## Verification contract

- `cd frontend/react && npm run build`
- relevant unit/component tests
- blocking Playwright visual, axe, keyboard, and viewport checks
- `npm run ci` before merge; `npm run ci:full` for backend/Media or canvas work
- browser screenshots in light and dark plus every touched dimension
- no increase to alias, literal, inline-style, keyframe, breakpoint, or exception debt

## Consequences

The system becomes portable and enforceable without losing its identity, and
structural refactors become reviewable through stable contracts. Costs include
screenshot maintenance, broad-but-incremental token/CSS migration, careful
host-brand asset isolation, evidence-led IA work, and capability-sized touch work.

## Alternatives rejected

1. Keep CSS variables as an undocumented design-tool boundary — portability and
   governance remain manual.
2. Adopt a second framework/Storybook-first system — duplicates production
   composition. Revisit only if authoring value justifies it.
3. Big-bang CSS rewrite — unsafe without contract-first incremental moves.
4. Allow failing custom themes after confirmation — accessibility is invariant.
5. Build a brand-specific uploader — Media already owns asset bytes.

## RFC verdict

No OpenWOP RFC is required. This changes host-app UI infrastructure and
host-extension brand data only. It does not alter the run/event wire, capability
advertisement, endpoint contract, auth profile, replay/fork behavior, or a
normative OpenWOP requirement.

## Implementation record

> **Admin-composition correction (2026-09-20).** Workspace and admin rails share
> semantic section/item primitives, while their shells continue to own collapse,
> authority, active-route, and special-item policy. `PageHeader` gains a generic
> breadcrumb slot; optional manifest `parentPath` metadata is resolved by the
> admin shell and exposed through context, avoiding both a second route catalog
> and a chrome-to-feature import cycle. Operations is the first migrated family.

> **Admin governance tranche (2026-09-20).** The contiguous admin shell +
> overview rules move verbatim from the legacy monolith into
> `styles/chrome/admin.css`, with an ownership ratchet and visual parity checks.
> The gallery gains deterministic admin shell/state specimens composed from the
> shared primitives; those fixtures test the visual contract but do not replace
> live `AdminLayout` route, authority, navigation, or assistive-technology tests.
> Implemented with a seven-family CSS ownership ratchet, localized admin gallery
> matrix, 12 authenticated/visual Playwright cases, and the canonical frontend
> build. Real VoiceOver/NVDA and operator custom-brand judgment remain human
> acceptance evidence and are not inferred from Chromium fixtures.

| Phase | Status | Evidence |
|---|---|---|
| 0 | implemented | ADR + steward assessment/plan + executable inventory and documentation reconciliation |
| 1 | implemented | Fail-closed effective-theme validation (`analyze.ts` typed issues + merged fixed tokens; `AppearancePanel` hard-block; backend `GENERATOR_OWNED_TOKENS` closed set + frontend mirror with visible rejection, `applyBrand.test.ts` mirror-parity test); one `BrandLogo` mark primitive (app header + public shell, DSA-015); workflow-card stretched-button semantics + `check-aria-prohibited` pseudo-control ratchet (DSA-019/020, `WorkflowCardSemantics.test.tsx`); JS motion routed through `ui/motion.ts` (DSA-009); `--launcher-safe-inline` banner clearance + RTL-logical launcher + `viewport.spec.ts` overlap gate (DSA-025) |
| 2 | implemented | `/design-system` gallery feature package (admin tier, `developer-tools` Gate B — no new toggle per §1) rendering primitives/patterns from fixtures; blocking Playwright gallery snapshots (`design-system.spec.ts`: sections × light/dark + contrast/density/font-scale/focus/width matrix, darwin baselines, fonts-ready + animations-disabled determinism contract); critical-route snapshots in ci:full (`route-snapshots.spec.ts`, OPENWOP_E2E_ROUTES — promoted only after proving stable, the ADR 0509 rule); axe policy strict: EVERY WCAG A/AA violation fails with an owned/expiring exception ledger (`axeExceptions.ts`, launched EMPTY); first catch: KeyFigureBand's 11px trend text used fill-tier status tokens at ~3:1 (fixed to `-text` variants) |
| 3 | implemented | DTCG token graph (`src/styles/tokens.json`, 103 tokens) + `check-dtcg-parity` lockstep gate (CSS generation deliberately deferred to Phase 5 — the graph is the contract, `global.css` stays the runtime); generated inventory report (`docs/steward/DESIGN-SYSTEM-INVENTORY.md`, drift-gated `--check` in the build); legacy `--color-*`/`--font-*` aliases MIGRATED (1008 refs + ColorField/VoiceWaveform runtime lookups) and DELETED with `check-legacy-aliases` zero-gate — route/gallery snapshots byte-identical except the DELIBERATE contrast-more rebaseline (the alias-only `--color-border` bump now rides canonical `--rule`, so ALL borders strengthen — a correction recorded here, not a regression); `--clay-text-hover` promoted canonical; `--color-warn` phantom-token bug in ColorField fixed (swatch had resolved EMPTY); typography + breakpoint ledger gates (`check-typography-literals` 608/225 shrink-only, `check-breakpoints` governed vocabulary content 480/600/640 · shell 720/760/860 · rail 900 · canvas 1024 + shrink-only straggler ledger); spacing gate extended to every stylesheet; REQUIRED `archetype: PageArchetype` on `FeatureRoute` — 167 routes declared, coverage is a compile-time invariant; DESIGN.md §4 rewritten (source-of-truth, retirement, vocabulary, archetypes); anchor-ratchet regex fixed upstream (path→nav window could cross route objects) + six newly-surfaced screens instrumented |
| 4 | implemented | `ui/Button` explicit variant/size API mapping 1:1 onto the existing class vocabulary (primary=bare, secondary, quiet=btn-ghost, danger=secondary+u-text-danger, link=btn-link; type defaults "button", loading=aria-busy+disabled) with API tests + gallery reference sections; `check-unwrapped-buttons` ratchet (1845 raw sites, shrink-only — the bare-element rule becomes reset-only at zero); `ui/InlineState`+`EmptyRow` compact designed-states (failed announces or role=alert — honest-read at every size) adopted at the DSA-030 regression sites (analytics ×4, commerce coupons); static inline styles migrated to ZERO (53→0, `check-inline-styles` zero-gate; 27 files onto u-* utilities + verbatim-relocated component classes; SelectionPill/icons gained className seams); coarse-pointer hit areas: `--hit-target` 44px token, `::after` expansion for ISOLATED targets only (icon-button, launcher, banner-close, card kebab), real size/gap growth for clusters (swatches) — never invisible overlap in a cluster; device-emulated verification recorded for Phase 9 |
| 5 | implemented (tranche 1; program ongoing) | The ONE stylesheet entry `styles/index.css` with explicit deterministic layer order (foundations → legacy monolith → ADR 0510 primitives; `brand.css` stays a separate LATER `<link>` — the white-label seam); tranche 1 extracted top+tail verbatim — `foundations/tokens.css` (the :root/.theme-dark token + mode blocks, 312 lines; `check-dtcg-parity`/`check-theme-stock` re-pointed) and `primitives/adr0510.css` (gallery/InlineState/hit-area/migration classes, 83 lines) — with the monolith rules DELETED at move time; compiled CSS verified **byte-identical** (same content hash) and the 40-case snapshot+axe matrix green. Remaining tranche map (one coherent ownership section per PR, snapshot-verified each): primitives (buttons/fields/menus/modal/notice/table) → chrome (shells/sidebar/admin rail/banners) → features by owner → canvas chassis + type extensions |
| 6 | implemented (core; Media pipeline tracked below) | Additive per-mode marks end to end: backend `logo.markSrcDark`/`lockupSrcDark` (same `safeBrandAsset` sanitize, legacy-brand upgrade test), frontend mirror + `VITE_BRAND_MARK_SRC_DARK` + Appearance dark-logo field (4 locales); `BrandLogo` renders both variants with a CSS visibility swap keyed to the EFFECTIVE mode (zero JS, instant flip); `check-default-logo-parity` locks the 36-path geometry of the two deliberate default-logo sources (inline currentColor ↔ standalone media-query SVG — the theming split is by design, drift is not); DSA-018 metric-compatible fallback `@font-face` (size/ascent/descent overrides for Geist + Instrument Serif) in foundations so slow/blocked/offline font loads cause no material CLS, self-host recipe = the existing `VITE_BRAND_FONTS_HREF` seam. **Remaining (deliberately deferred — a security-sensitive cross-tenant seam deserving its own ADR): the Media-backed upload/crop/SVG-sanitize pipeline + the host-owned asset scope; until it lands, custom assets are URL/data-URI references (the §6 exit gate "no pasted URL" is NOT yet met and stays open).** |
| 7 | implemented (DSA-026; DSA-028 evidence-gated) | Mobile admin (DSA-026): ≤860px the rail is a COMPACT DISCLOSURE — one hit-target-sized labeled row (naming the current destination when the resolved nav yields it), sections expand vertically on demand and close on navigation; the wrapping link cloud is gone; e2e disclosure test at 390px (found + fixed an identity-unstable effect dep that re-closed the disclosure instantly). Archetype declarations (DSA-029) landed in Phase 3; outlier-contract migration continues under the archetype field. **DSA-028 (job/suite top-level IA) stays OPEN by design: the plan requires route/navigation analytics + moderated tests BEFORE reorganizing ("do not reorganize solely from feature names"), and no such evidence exists yet — the projection seam (manifest + resolved nav + navigation-settings) is ready when it does.** |
| 8 | implemented (declaration layer; gesture program ongoing) | `touchSupport` on `CanvasTypeDefinition` (view / present / light-edit / full, omitted = view — fail-honest): all 7 canvas families declare an HONEST level from their SHIPPED capabilities (drawings light-edit — ADR 0333 touch ink/pinch/multi-finger undo; slides present; document light-edit; challenge-outline light-edit; cad/app-builder/campaign view); the editor surfaces the level ≤600px as static text (deliberately NOT a live region — a standing capability statement, not a status change). The chassis already ships pinch-zoom, touch-ink, edge-scroll, and multi-finger undo (ADR 0333/0337); raising a family's declared level is now a per-family capability program measured against its declaration — no canvas can imply parity it lacks. |
| 9 | implemented (automated matrix; human AT checks outstanding) | Coarse-pointer hit-target MEASUREMENT under a mobile device descriptor (icon targets ≥44px effective — the Phase-4 deferred verification) + forced-colors visibility/name contract on the gallery; assessment closure ledger: 28/32 DSA findings CLOSED with evidence, DSA-016 partial (Media pipeline), DSA-022 partial (NVDA/VoiceOver human checks = DSCT-8, cannot be machine-run), DSA-028 open by design (evidence-gated IA), DSA-007/013 closed-as-ratchet; operating-model re-grade recorded in the assessment changelog |
