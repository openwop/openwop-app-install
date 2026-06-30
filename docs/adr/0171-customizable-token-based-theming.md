# ADR 0171 — Customizable token-based theming (extends ADR 0170)

| Field | Value |
|---|---|
| **Status** | implemented (Phases A–E, 2026-06-30) — extends ADR 0170. See the implementation log. |
| **Date** | 2026-06-30 |
| **Feature id** | `brand` (extends ADR 0170 — same single owner; no new feature/toggle) |
| **Extends** | **ADR 0170** (runtime app brand) — replaces its "single accent + 3 hardcoded presets" identity with a generative, token-based theming model. Generalizes ADR 0170 Phase 2a (the `--clay`→ramp derivation). |
| **Depends on / composes** | ADR 0001 (feature packages), ADR 0170 (`brand` identity + runtime `:root` injection), ADR 0007 (Media — logo upload, ADR 0170 Phase 8), `DESIGN.md` (the token system + §3 functional-color rule) |
| **RFC gate** | **None.** Pure host-extension — the richer `Brand.identity` rides ADR 0170's existing `/app-brand` + `/public-brand` routes; no run-event field, capability flag, endpoint contract, or normative `MUST`. No new RFC. |
| **Decision type** | App design-system architecture (token tiers + a runtime theme generator). Host + frontend only. |

## Why this exists

ADR 0170 shipped runtime branding, but the **Appearance editor is theming-by-preset**: of the app's **~105 design tokens** (`DESIGN.md §2` + the `--color-*` semantic set), an operator can change **~14** — `--clay` (+ its derived ramp, Phase 2a) and the three font stacks — and only by picking **1 of 3 hardcoded seed presets**. Surfaces, text/ink, functional/status, category, radii, spacing, and type scale are fixed. That is not customizable theming.

A deep dive into MyndHyve's theming engine and current industry practice (Material Design 3 dynamic color, Radix Colors, the W3C DTCG token spec, OKLCH generation, shadcn/Primer/Atlassian/Salesforce/SaaS-white-label) **converges on one answer**: "customizable" means **store a small input set (a seed color + a few knobs) and *generate* the full, accessible, light+dark token set deterministically** — not ship presets, and not hand-edit 105 pickers. The same dive showed openwop-app is on a **better foundation than MyndHyve** for this (OKLCH + CSS relative-color + runtime `:root` injection already in production; MyndHyve is HSL-on-MUI with two parallel runtimes). This ADR records the decision to **generalize what we have into a real generator**, not rebuild.

## Boundaries & duplication audit

| Claim | Finding | Verdict |
|---|---|---|
| "We need a theming feature" | The `brand` feature (ADR 0170) already owns the runtime identity + `Brand.identity` + the `/app-brand`/`/public-brand` routes + the `applyBrandIdentity` `:root` injector. | **Extend it.** No new feature, no new routes, no new toggle. |
| "We need a token system" | `styles/global.css` already defines ~105 tokens, incl. a partial **semantic/alias layer** (`--color-accent/-surface/-text/-border/-bg/…`) over the editorial primitives (`--paper*`/`--ink*`/`--clay*`). | **Generalize it** into explicit tiers; do NOT fork a second token namespace (the MyndHyve `--ds-*`-vs-`--color-*` split is the anti-pattern). |
| "We need a palette generator" | None exists in this repo. Phase 2a's relative-color ramp (`oklch(from var(--clay) …)`) is the seed→ramp pattern in miniature. | Net-new FE module (`src/brand/theme/`), generalizing Phase 2a. No in-app duplicate. |
| "It collides with the design system" | The generator produces values for the EXISTING token names; stock seeds reproduce the current literals exactly (the Phase-2a invariant). | No collision — a generalization, not a parallel palette. |

No `src/core`→feature dependency; the chrome reads tokens (CSS vars) + the `brand` singleton/`useBrand()` as today. **Boundaries: PASS.**

## Decision

Adopt a **2-tier, OKLCH-generative** theming model on the existing token system, driven by a small input set stored in `Brand.identity`, applied through ADR 0170's runtime path.

### 1. Token tiers (formalize what exists)
- **Primitive ramp (generated):** per-role OKLCH ladders (accent, neutral/surface, optional secondary) — the generator's output, not hand-authored.
- **Semantic / alias layer (the swappable unit):** the existing `--clay*`/`--paper*`/`--ink*`/`--color-*` tokens, now *assigned from* the primitive ramp at fixed lightness/step targets. This is the tier a theme swaps (DTCG 2025.10 + the EightShapes options→decisions→components convention; the component-token tier stays optional).
- **Component tokens:** existing `--xy*`/`--chat*`/`--sidebar*` etc. — keep pointing at semantic tokens; never themed directly.

### 2. Inputs over presets
Store a **small input set** in `Brand.identity.theme` (replacing the preset id):
`{ accentSeed, neutralSeed, secondarySeed?, contrastLevel, radius, density, typography{pairing|serif,sans,mono,fontsHref} }`.
The full light+dark token set is **generated deterministically at save** from these inputs (persist the *inputs*, not the expanded set — tiny payload, replay-safe). **Presets become named seed-sets** (a starting `accentSeed`+`neutralSeed`+pairing), not hardcoded ramps — so "3 presets" becomes "infinite, with N starting points." An **advanced escape hatch** allows a full per-token override map + **JSON import/export** of a complete theme (Stripe `rules` / Tokens-Studio model).

### 3. The generator (hybrid — fidelity + guaranteed contrast)
A pure FE module (`src/brand/theme/generate.ts`), generalizing Phase 2a:
- **Brand fidelity:** build each role ramp as a **perceptual OKLCH ladder at fixed lightness targets** (Radix-style closest-scale / Evil-Martians fixed-L), keeping the **brand seed exact at its mid step** — the operator's color is never silently shifted.
- **Guaranteed accessibility:** **solve** on-colors / text tokens for **WCAG 2.x AA** against their actual background (Leonardo-style contrast solve / APCA-informed), porting MyndHyve's `deriveDarkMode` **AA-bump loop** (raise L until ≥4.5:1) with an explicit **`bumpExhausted`** signal for the rare unsolvable seed.
- **Light AND dark from the same seeds** (we already derive dark `--clay-text` from `--clay`; generalize to all surfaces/text).
- **Functional/status (`--color-success/-warning/-danger/-ai/-info`) + category (`--cat-*`) colors stay semantic / meaning-bearing** (`DESIGN.md §3`) — generated to harmonize but **not freely brandable** except in the advanced tier; they encode run-state/node meaning.

### 4. Apply (reuse ADR 0170)
The generated token set is injected to `:root` + `.theme-dark` via the existing `applyBrandIdentity` `setProperty` path (already CSSOM-safe / anti-injection) + the pre-paint cache. Relative-color generation is gated behind `@supports`, with the **stock OKLCH literals as the precomputed fallback** (relative color is only 2024-Baseline; we already ship the literals).

### 5. Editor — two tiers
- **No-code tier:** accent + neutral/surface pickers, typography pairing, logo, **live light+dark preview**, **inline WCAG warnings + one-click auto-fix** (auto-adjust lightness on a failing pair). The everyday path.
- **Advanced tier:** full per-token override grid + **JSON import/export**. The power path.

### 6. Guardrails
- **WCAG 2.x AA is the shippable gate** (4.5:1 text / 3:1 UI) — block/warn + auto-adjust at save.
- **APCA `Lc` shown as a labeled advisory only** (WCAG 3 has no finalized contrast method; APCA and WCAG 2 disagree in both directions).
- **Phase-1 server-side sanitization stays** (the CSS-grammar color/font validators) — the generator runs client-side for preview; the stored *inputs* are validated server-side and the generated output is re-derived, so a tampered cache can only affect the tamperer's own view.

## Phased plan

| Phase | Goal | Surfaces |
|---|---|---|
| **A — Generator** | Pure `src/brand/theme/generate.ts`: seed-set → OKLCH ramps → semantic-token map, light+dark, with the contrast-solve on on-colors (+ `bumpExhausted`). Unit-tested incl. "stock seeds reproduce current literals." | `frontend/react/src/brand/theme/` |
| **B — Token tiers** | Refactor `global.css` so the semantic tokens are *assigned from* the generated ramp (names unchanged); document the tier map (generated vs fixed). | `frontend/react/src/styles/global.css` |
| **C — Input model** | Extend `Brand.identity.theme` (input set) + advanced override + JSON import/export; update `sanitizeIdentity` + the ADR 0170 MIRROR CONTRACT; presets → seed-sets. | `features/brand/types.ts` + `brandService.ts`, `src/brand/defaults.ts` |
| **D — Editor rebuild** | Appearance no-code + advanced tiers, live light/dark preview, inline contrast warnings/auto-fix. Replaces the 3-preset UI. | `src/brand/AppearancePanel.tsx` |
| **E — Contrast validation** | Save-time AA gate (auto-adjust) + APCA advisory readout; ContrastChecker UI. | `src/brand/theme/contrast.ts`, editor |

Each phase: `/architect` before, `/code-review` + `/ux-review` after, the canonical gates (`frontend/react && npm run build`).

## Feature evaluation (relevant dimensions)

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package boundary** | Extends `brand`; generator in `src/brand/theme/`; no `src/core`→feature edge; no new routes. |
| 2 | **Wire / RFC** | None — richer `Brand.identity` over ADR 0170's host-ext routes. |
| 3 | **Replay/fork** | Persist *inputs*; regenerate deterministically. Not run-influencing → no `run.metadata` stamp. |
| 4 | **Security** | `setProperty`-only injection (anti-CSS-injection) + server-side input sanitization; advanced override values validated by the same CSS-grammar guards. |
| 5 | **Performance** | Generation is client-side at edit/load; `/public-brand` still returns a small input set (ETag+cache unchanged). |
| 6 | **a11y** | AA gate at save + light/dark parity by construction; APCA advisory. |
| 7 | **Frontend** | `ui/` design system; two-tier editor; live preview; `check-css-tokens`/`check-tsx-color-literals` stay green (generator emits to tokens, no literals in components). |

## Alternatives considered

- **Keep the 3 presets.** Rejected — this ADR exists because that is the problem.
- **Port MyndHyve's engine wholesale.** Rejected — MUI-bound, HSL (not true HCT), two parallel runtimes + two CSS namespaces, and its per-token editor is itself half-built. We take its *concepts* (seed→tiers, `deriveDarkMode` AA-bump, `setProperty`+validate trust boundary) onto our better OKLCH/`:root` substrate.
- **Full per-token picker grid (105 pickers).** Rejected as the *primary* UX — it's the thing every source warns against; offered only as the advanced tier.
- **True HCT/CAM16 palettes (Material).** Deferred — OKLCH (perceptually uniform, already in our stack, pure-CSS derivable) gets us fidelity + accessibility without the HCT dependency; revisit only if OKLCH ramps prove insufficient.
- **Build-time `VITE_BRAND_*` only.** Rejected by ADR 0170 already (no runtime control).

## Open questions

- [ ] **Generator algorithm pin** — Radix-closest-scale vs a fixed-L OKLCH ladder for the ramp; pin one + a version (Material's spec versions live; we should not).
- [ ] **How many roles are seed-driven** — accent + neutral for sure; is `secondary` worth a seed, or derived (triadic) like MyndHyve?
- [ ] **Advanced-tier override scope** — which tokens are overridable vs structurally locked (radii/spacing/component internals locked per SLDS; functional colors advanced-only).
- [ ] **`contrastLevel` knob** — expose a standard/medium/high contrast dial (Material) and treat high-contrast as a first-class generated theme (Primer)?
- [ ] **Migration of existing app brands** — installs that set the ADR 0170 single `--clay` accent map to `accentSeed`; confirm a clean upgrade.
- [ ] **Per-workspace theming** — still future (ADR 0170); the input model should not foreclose it.

## ROADMAP / FEATURES note

- **FEATURES.md** — update the `brand` row: Appearance becomes a **generative theming editor** (seed-driven, light/dark, contrast-guarded, JSON import/export), superseding the 3-preset note.
- **ROADMAP.md** — add the ADR 0171 row (extends 0170; 🔵 Planned; phases A–E; deps 0170/0007/DESIGN.md).
- **ADR 0170** — add a forward-reference: its "Token contract"/preset model is generalized by ADR 0171.

## Implementation log

_(updated as phases land — phase → commit/test)_

| Phase | Status | Evidence |
|---|---|---|
| E — Contrast validation | ✅ Done | `theme/analyze.ts` — `analyzeThemeContrast(light, dark)` checks the EFFECTIVE token pairs (generated + override) for both modes: WCAG ratio is the pass/fail of record (4.5 text / 3.0 UI), APCA `Lc` a labeled advisory. Editor gains a **ContrastChecker** panel (per-pair ratio + AA pass/fail icon + Lc) + a save-time warning when an override falls below AA (generated colors auto-adjust via the Phase-A solve; overrides don't). `analyze.test.ts` 3/3 (generated passes, override break caught, APCA present). FE build green; 22 brand+theme tests; backend 9 + tsc 0. (1 unrelated pre-existing failure: `ArtifactWorkbench.test.tsx`.) /architect + /code-review + /ux-review passed. |
| D — Editor + apply | ✅ Done | **Apply pipeline:** `applyGeneratedTokens` injects the generated light/dark set via a `<style>` element (`:root` + `:root.theme-dark`, SAFE-filtered); `BrandProvider` **lazy-imports** the generator (entry budget held at 170.9/171), applies + caches the generated tokens; `index.html` pre-paint applies the cached tokens (no FOUC, generator-free); `clearGeneratedTokens` un-skins on Reset / non-generative brand. **Editor rebuild** (`AppearancePanel`): seed-set starters, accent + neutral **swatch+text** pickers, contrast/corners/mode/font controls, a **generator-driven live light+dark preview** with inline WCAG warnings, and an **advanced JSON import/export** tier (override). CSP hash re-pinned (`9QUENF3J…`). FE build green; 19 brand+theme tests; no banned patterns. /architect + /code-review (caught + fixed the reset-doesn't-unskin bug) + /ux-review passed. |
| C — Input model | ✅ Done | Backend `BrandTheme` (mode + generative inputs + advanced `override`) on `BrandIdentity` + `THEMEABLE_TOKENS` closed allowlist. `sanitizeTheme` validates seeds via `safeColor`, enum-clamps scalars, and **allowlist-gates + value-validates the override map** (the security control — overrides inject to `:root`). Frontend `PublicBrandIdentity.theme` + MIRROR CONTRACT updated (3-way: BE `BrandTheme` ↔ FE shape ↔ generator `ThemeInputs`). `BRAND_PRESETS` → **named seed-sets** (optional `neutralSeed`). 9 backend tests (seeds+enums, invalid dropped, **override keeps `--clay`/`--color-danger`, drops `--evil-prop`+injection**); backend tsc 0; FE build green. /architect + /code-review passed; no /ux-review surface. |
| B — Token tiers | ✅ Done | A documented **THEME TIER MAP** comment in `global.css` (generated/themeable semantic tokens vs fixed structural/meaning-bearing) — no value changes; stock unchanged. New build gate **`check-theme-stock.mjs`** (wired into `npm run build`) enforces the generator's STOCK ≡ the `global.css` literals (closes the JS↔CSS mirror; 8 tokens in lockstep). `brand/theme/` allowlisted in `check-tsx-color-literals` (the engine is the SSoT for generated colors, like `defaults.ts`). `numStr` replaces `toFixed` in the color formatter (CSS is locale-insensitive — bypassing the i18n formatter is correct). FE build green; theme 10/10. /architect + /code-review passed; no /ux-review surface. |
| A — Generator | ✅ Done | `src/brand/theme/{oklch,contrast,generate}.ts` — dependency-free OKLCH↔sRGB (Ottosson), WCAG ratio + APCA `Lc` (advisory) + `solveOnColorLightness` AA-bump (with `bumpExhausted`), and `generateTheme(inputs)` → light/dark token maps. Hybrid: `--clay` set EXACT (fidelity), on-colors (`--clay-text`/`--clay-strong`/`--ink-3`) AA-solved per surface; **default seed-set passes through the stock literals byte-identically** (no-regression). `generate.test.ts` 10/10 (round-trips, WCAG white/black=21, APCA sign, bump-to-AA, bumpExhausted, the stock invariant, custom-accent AA). tsc clean; no new dep; lazy-chunked (no entry-budget hit). /architect + /code-review passed; pure module (no /ux-review surface). |

## References
- **Deep dive (this session):** MyndHyve `src/core/design-system/` (seed→tonal-palette engine, `deriveDarkMode` AA-bump, `emitCssVariables` `setProperty` trust boundary, half-built per-token UI); industry synthesis below.
- W3C DTCG token format (stable **2025.10**); EightShapes token-tier convention.
- Material Design 3 dynamic color / HCT (`material-color-utilities`); Material Theme Builder.
- Radix Colors 12-step semantic scale + custom-palette generator (`generateRadixColors`).
- OKLCH/Oklab + `color-mix()` (Baseline ~2023) + relative color `oklch(from …)` (cross-engine 2024); Evil Martians OKLCH theming.
- Adobe Leonardo (contrast-targeted generation); WCAG 2.2 (4.5:1 / 3:1, normative) vs APCA `Lc` (WCAG 3 draft, advisory).
- shadcn/ui (OKLCH CSS-var theming), GitHub Primer (functional tokens + theme matrix), Atlassian Design Tokens, Salesforce SLDS2 styling hooks; Stripe Appearance API, Intercom/Zendesk white-label (logo + domain + SSL = separate plumbing, out of scope here).
