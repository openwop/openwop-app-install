# ADR 0170 — Brand owns app identity AND marketing brands (consolidate + graduate to core)

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–7, 2026-06-29) — Phase 8 (asset upload) deferred fast-follow; per-workspace branding remains future. See the implementation log. |
| **Date** | 2026-06-29 |
| **Feature id / toggle** | `brand` — **graduates to core / always-on** (was OFF, bucket `tenant`, category `Marketing` per ADR 0155) |
| **Packs** | `feature.brand.nodes`, `feature.brand.agents` (extended, not forked) |
| **Depends on / composes** | ADR 0001 (feature packages), ADR 0155 (the `brand` feature this extends), ADR 0027 (CMS front page + always-on trio — the **pattern mirrored**), ADR 0007 (Media — asset upload), ADR 0006 / RFC 0049 (`accessControl` + super-admin), ADR 0015 (workspace = tenant), ADR 0052 + `WHITE-LABEL.md` (the build-time `VITE_BRAND_*` layer this supersedes at runtime), ADR 0058 (chat-drivability), ADR 0014 (`ctx.<feature>` surface) |
| **Amends** | **ADR 0155** — its `Brand` model gains a visual-**identity** facet, and its toggle posture graduates to always-on (see ADR 0155 correction note). The graduation recipe is ADR 0010 §Correction / ADR 0024 §Correction / ADR 0134 ("drop `toggleDefault`, open the gates"). |
| **RFC gate** | **None.** Pure host-extension under `/v1/host/openwop-app/*`, exactly like CMS's `/site-page` + `/public-site-config` (ADR 0027). No run-event field, capability flag, event type, endpoint contract, or normative `MUST` touched. No new RFC. |
| **Review** | `/architect` (Track A) + `/frontend-design`, 2026-06-29 — six findings folded in (see § "Architecture + design review (incorporated)"). Two were blocking: the **clay-ramp derivation** defect and the **reserved-org reuse** correction. |

---

## Why this exists

The white-label app (`app.openwop.dev`, and every adopter install per ADR 0052) gets
its visual identity — logo, wordmark, colors, fonts, favicon, document title, instance
name, theme, soft gate — from **build-time environment variables**: 21 `VITE_BRAND_*`
keys resolved by `frontend/react/src/brand/defaults.ts` (`resolveBrandFromEnv`, `:154`)
into a static module singleton (`src/brand/brand.ts`, **no provider/context**) and
stamped into `index.html` + `manifest.webmanifest` by the `openwop-brand-html` Vite
plugin (`vite.config.ts:82-143`). **Changing the brand requires editing `.env.production`
and rebuilding** — an adopter cannot rebrand a running install, and a super-admin has no
UI for it. Colors/fonts aren't even env-driven: they're hand-overridden CSS custom
properties in `src/brand/brand.css` (`--clay`/`--paper`/`--ink`/`--serif`/…).

Separately, the `brand` **feature** (ADR 0155, implemented) already models a `Brand` —
but only its **voice** facet (tone, formality, approved/banned phrases, compliance
scorer) for Campaign Studio, tenant-scoped and toggle-OFF.

The operator's ask: make **`brand`** own the white-label app's identity at **runtime**,
super-admin-managed, **core (no toggle)** — *and* keep using the same feature to manage
**marketing brands**. The governing analogy (operator's words): **just as CMS owns the
app homepage *and* marketing landing pages with one `Page` model, `brand` should own the
app's own identity *and* campaign brands with one `Brand` model — same entity, different
brand IDs.** This ADR consolidates the two "brand" concerns into the one feature and
graduates it to core.

## Boundaries & pre-existing-surface audit (MANDATORY)

| Claim | Finding | Verdict |
|---|---|---|
| "We need a new `appearance`/`white-label` feature" | The `brand` feature already exists (ADR 0155) with a `Brand` entity, `brandService`, `DurableCollection`, RBAC, packs, `ctx.features.brand`, and a `/brand` page. A second feature would **fork** the single owner. | **Extend `features/brand/`, do not fork.** No new feature id. |
| Visual identity lives in a feature today | No. It lives in `src/brand/` (not `src/features/`): the env resolver + static singleton + `BrandMark.tsx`/`OpenwopLogo.tsx`/`brand.css`. Always-on core, build-time only, **no ADR** (only `WHITE-LABEL.md` + ADR 0015/0052). | `src/brand/` becomes the **seed-defaults source + first-paint fallback**; the feature becomes the runtime owner. |
| Two unrelated things named "brand" | Correct today: `src/brand/` (visual, core, build-time) vs `features/brand/` (voice, toggle, tenant). This ADR **unifies** them under one `Brand` model so the split disappears. | Single source of truth = the `brand` feature's `Brand`. |
| "Managing one global app resource needs new infra" | CMS already solved this exact shape: a reserved, auth-unreachable host org (`host:site`/`host-site`, `systemSite.ts:29-34`), a `requireSuperadmin` host route (`sitePage.ts`), idempotent boot seeding with a frozen-once-edited guard (`ensureSystemSite`), a public read on `PUBLIC_PATH_PREFIXES` (`auth.ts:85,98-101`), and a runtime pointer (`/public-site-config`). | **Mirror the CMS host-global mechanism** AND **reuse its reserved org** (see next row). No new infra. |
| "The app brand needs its own reserved org" | **No — that would be a second reserved-org system.** `accessControl.createOrg({ orgId })` already accepts a *fixed reserved org id* expressly "for reserved host-level orgs" (`accessControlService.ts:264-272`, cites ADR 0027). And `featuresPage.ts` already stores a **second** host-global resource (`page:host-site-features`) inside the **same** `SYSTEM_SITE_ORG` rather than minting a new org (`featuresPage.ts:24,31,127`). | **Reuse `SYSTEM_SITE_TENANT`/`SYSTEM_SITE_ORG`** for the app brand (a reserved `brand:host-app` resource), via the existing `createOrg({orgId})` seam. Do **not** mint `host:brand`/`host-brand`. |
| Runtime CSS theming is unprecedented | MyndHyve has a working injector — `injectCSSVariables(document.documentElement, vars)` (`cssVariables.ts:947-966`) via `DesignSystemProvider`. (It deliberately does **not** point at `:root` for its own chrome — a gap we must invert.) | Port the injection technique; aim it at `:root` for the host app. |

**Single owner:** the `brand` feature owns every `Brand` (app + marketing). The app's
own brand is *one reserved-id instance*, not a parallel system — the same relationship
the homepage has to CMS pages.

## Decision

Consolidate visual identity and marketing brand into **one `brand` feature**, graduate
it to **core/always-on**, and add a **runtime application path** so a super-admin can
rebrand a running install with no rebuild. Concretely:

1. **One extended `Brand` model.** Add a visual-**identity** facet to ADR 0155's
   `Brand` (today voice-only). A `Brand` becomes `{ id, scope, identity?, voice?, … }`.
   This matches MyndHyve's own `Brand`, which already unifies `colors + typography +
   logoKit` **and** `voiceProfile` (`brands/types/index.ts:158-209`). The app brand
   leans on `identity`; a marketing brand leans on `voice`; **both are the same shape**
   — the operator's "1:1 mapping, different brand IDs."

2. **The app brand is a reserved host-global `Brand`** — `brandId = 'brand:host-app'`
   **inside the existing reserved `SYSTEM_SITE_TENANT`/`SYSTEM_SITE_ORG`** (`host:site`/
   `host-site`), *not* a new `host:brand` org. This reuses CMS's reserved, auth-unreachable
   org via the documented `accessControl.createOrg({ orgId })` seam, exactly as
   `featuresPage.ts` reuses `SYSTEM_SITE_ORG` for `page:host-site-features` —
   **[review correction #1: do not stand up a second reserved-org system].**
   `ensureSystemBrand()` seeds it idempotently at boot from `resolveBrandFromEnv(process.env)`
   so a fresh install's app-brand *equals the build-time `VITE_BRAND_*` values* (zero
   visual change until edited), with a `SEED_VERSION` **frozen-once-edited** guard
   (`updatedBy` set by a real super-admin freezes it from re-seeding, and from env changes
   on later redeploys) — sharing `ensureSystemSite()`'s org + idempotency + concurrent-boot
   convergence (deterministic reserved key, not `randomUUID`) verbatim (`systemSite.ts:160-195`).

3. **Graduate `brand` to core/always-on.** Drop `toggleDefault: 'off'`; the feature
   gate opens (ADR 0010/0024/0134 recipe). The app *cannot* have its identity behind a
   toggle. **Graduation removes only the toggle gate, never the RBAC gate**
   ([review #4]): the marketing-brand routes keep their `workspace:read`/`workspace:write`
   checks (`features/brand/routes.ts` gates on `TOGGLE_ID='brand'` *and* scope today — only
   the toggle half is removed). Blast-radius-safe: the Campaign Studio cluster (ADR
   0156–0162) does not gate on `brand` being OFF — it only declares `requiredPacks:
   feature.brand.nodes` (`campaign-channels/feature.ts:8,25`), which always-on satisfies.
   Optional, genuinely-opt-in sub-capabilities (e.g. the Campaign compliance scorer /
   per-channel voice) MAY remain behind sub-toggles, the way CMS kept `cms-approval-gate`
   / `cms-localization` while `cms` itself went core (ADR 0027).

4. **Runtime application path (replaces build-time inlining).**
   - **Public, pre-auth read** `GET /v1/host/openwop-app/public-brand` (added to
     `PUBLIC_PATH_PREFIXES`) returns *the reserved app brand's identity subset ONLY*
     (logos, colors, typography, favicon, title, theme, productName/wordmark, footer,
     instance name). **It takes no id/slug param** — it resolves `brand:host-app`
     server-side, so a tenant marketing brand's `identity` can never be enumerated or
     served publicly ([review #2 — IDOR/isolation]). **Never** returns voice rules or the
     `appGate` secret. Pre-auth because `PublicShell` + `AppGate` render before login.
   - **No FOUC — inline at serve time ([review #5, dominant fix]).** The resolved app
     brand is injected into `index.html` at serve time (a small transform on the
     Firebase-fronted SPA): the `<title>`, `<link rel=icon>`, and a `<style>` block of
     `:root` (and `.theme-dark`) brand vars. First paint is already correct; the
     `BrandProvider` fetch only *reconciles*. This **also** removes the per-cold-load
     `/public-brand` round-trip from the critical path (cache + ETag it regardless; mind
     the per-IP read budget). Fallback where no serve-time transform runs: set brand vars
     synchronously from a cached value in the existing pre-paint head script
     (`index.html:11-18`) before first paint.
   - **SPA applies/reconciles at load:** a `BrandProvider` injects colors/fonts as CSS
     custom properties on `document.documentElement` for **both** `:root` and
     `.theme-dark` (port of MyndHyve's `injectCSSVariables`, per the token contract
     below), and swaps favicon / `document.title` / fonts `<link>` / logo. The logo's box
     is size-reserved (width/height from the record) so the swap causes no layout shift.
     The static `brand` singleton (`src/brand/brand.ts`) is refactored to hydrate from
     the `BrandProvider`, keeping its current env values as defaults.

5. **Super-admin editing surface.** Host-level `GET/PUT /v1/host/openwop-app/app-brand`
   gated by `requireSuperadmin` (mirror `sitePage.ts`), driving `brandService` against
   the reserved `brand:host-app`; an **Admin → "Appearance"** panel (mirror
   `FrontPageSettingsPanel`) for logo/colors/fonts/theme/instance-name. **Marketing
   brands keep their tenant-scoped `/brand` page** (workspace admin, `workspace:write`)
   unchanged. Two authorities, one service — exactly CMS's org page-builder vs
   super-admin front-page split.

6. **Assets.** Logo/favicon as **URL reference first** (MyndHyve's Phase-1 baseline),
   with **upload via the `media` feature (ADR 0007)** as a fast-follow phase — we do
   *not* inherit MyndHyve's permanently-deferred "Phase 2" upload gap.

### Extended `Brand` data model (additive to ADR 0155)

```
Brand {
  id, scope: { tenantId, orgId },     // app brand: reserved SYSTEM_SITE_TENANT/SYSTEM_SITE_ORG (host:site/host-site), id 'brand:host-app'
  name, status,
  identity?: {                         // NEW — the white-label visual facet
    productName, wordmark:{pre,emphasis,sub}, tagline, footerText, instanceName,
    logo:{ markSrc, lockupSrc, faviconSrc },          // URL refs (media-backed later)
    colors:{ primary, surface, ink, border, accent, success, warning, error, … },  // → :root tokens
    typography:{ serif, sans, mono, fontsHref, googleFonts[] },
    theme:{ defaultMode:'system'|'light'|'dark', themeColor },
    domains:{ primaryDomain, homeUrl, repoUrl },
    chromePolicy?:{ showPoweredBy, customFooter, customCopyright }   // ported BrandingPolicy
    // NOTE: appGate stays server-enforced — NOT returned by /public-brand (see Open Qs)
  },
  voice?: { /* ADR 0155 — tone, formality, approved/banned phrases, per-channel rules */ },
  version, createdBy, updatedBy, createdAt, updatedAt
}
```

Stored on the existing generic `DurableCollection` (no SQL migration), as ADR 0155 does.

**Facets are optional and scope-bound ([review #3 — cohesion]).** One shape, two
near-disjoint consumers. The reserved app brand carries `identity` and drives the chrome;
tenant marketing brands carry `voice` and drive campaigns. Neither editor surfaces the
other's fields — the **Appearance** panel edits `identity` on `brand:host-app`; the
`/brand` page edits `voice` on tenant brands. A tenant brand's `identity` is inert: it is
never read by the chrome and never served by `/public-brand` (only `brand:host-app` is).

> **Generalized by [ADR 0171](0171-customizable-token-based-theming.md).** This
> section's single-accent + 3-preset model is superseded by a 2-tier OKLCH-generative
> theming system (seed inputs → generated light/dark token set, contrast-solved). The
> clay-ramp derivation below is the seed→ramp pattern ADR 0171 generalizes.

### Token contract — what is brandable, and the clay-ramp fix (blocking, [review #6 / design])

| Bucket | Tokens | Why |
|---|---|---|
| **Brandable** | `--clay` (the *one* accent), `--serif`/`--sans`/`--mono` + matching font href, logo/wordmark/favicon | The brand's identity surface |
| **Brandable, guarded (curated presets, not raw pickers)** | `--paper`/`--paper-2`/`--ink`/`--ink-2` | Contrast-critical; offer AA-validated surface presets |
| **FIXED — never brandable** | `--color-success/-warning/-danger/-ai/-info`, `--cat-*`, and the contrast-derived text tokens (`--ink-3` is axe-verified AA; `--clay-text`/`--clay-strong`) | They encode *meaning* (run-state, node categories) and are per-theme contrast-tuned — `DESIGN.md §3` |

**The clay-ramp defect (must fix before implementation).** The derived clay variants in
`global.css:22-35` — `--clay-text`, `--clay-strong`, `--clay-rule`, `--clay-wash`,
`--clay-glow`, `--clay-bg-hi` — are **literal `oklch(… 40)` at hue 40, NOT computed from
`--clay`** (despite `brand.css`'s comment claiming they "re-tint via color-mix"). So
setting only `--clay` to, say, a blue yields a **half-recolored app**: buttons turn blue
but accent-text/rules/washes stay clay-orange. **Resolution:** make the ramp
accent-derived — either relative-color (`--clay-text: oklch(from var(--clay) calc(l - 0.12) c h)`,
etc.) so one accent recolors the whole ramp coherently, **or** server-generate the full
ramp from the chosen accent and inject every variant. This is a prerequisite for
brandability that doesn't look broken.

**Contrast + dark mode.** Validate any chosen accent/surface for AA against **both**
`--paper` (light) and the dark surface *at save time* (reject/warn on fail); derive
accent-text by darkening L in oklch until ≥4.5:1 — the operator never hand-picks it. Apply
tokens to **both** `:root` and `.theme-dark`. Cleanest model: the operator picks one
hue+chroma; the system derives the light/dark lightness automatically. Keep
`check-tsx-color-literals` / `check-css-tokens` green (no literals introduced).

## Port, not clone — corrections to the MyndHyve baseline

MyndHyve's `BrandKit`/`BrandingPolicy` (`canvas/types/brandKit.ts:187-281`) and combined
`Brand` (`brands/types/index.ts:158-209`) are the data-shape baseline. Its gaps we
**must not inherit**:

1. **White-label runtime apply was never wired** (`generateCSSVariables` has no
   consumer). → We build the apply path (BrandProvider + `:root` injection + favicon/
   title/font/logo swap).
2. **BrandKit was never persisted** (in-memory Zustand + id refs only). → We persist on
   `DurableCollection`, like every openwop-app feature.
3. **Theming deliberately avoided the host chrome** (`designSystemStore.ts:960-977`
   warns against `:root`). → We *invert* this: the whole point is to repaint the host
   app, so we point injection at `:root` (scoped to the app brand only).
4. **Logo/favicon URL-only, upload "deferred to Phase 2" forever.** → URL-ref MVP, then
   real upload via `media` (ADR 0007).
5. **Gating was subscription-tier, no role gate.** → App brand is **super-admin only**;
   marketing brands use `accessControl` `workspace:write`.
6. **Three overlapping brand models.** → One `Brand`; identity + voice facets on it.

## Phased implementation plan

| Phase | Goal | Key surfaces |
|---|---|---|
| **1 — Model** | Extend `Brand` with the `identity` facet + validation/sanitization (reuse ADR 0155 `brandService` write path; `safeLink`-style guards on URLs). | `features/brand/types.ts`, `brandService.ts` |
| **2 — Reserved app brand + boot seed** | `systemBrand.ts` (mirror `systemSite.ts`): `brand:host-app` **inside the existing `SYSTEM_SITE_TENANT`/`SYSTEM_SITE_ORG`** via `accessControl.createOrg({orgId})` (no new org), `ensureSystemBrand()` seeding from `resolveBrandFromEnv`, frozen-once-edited `SEED_VERSION`, concurrent-boot-safe (deterministic key). Wire into `registerAllRoutes` + seeders. | `host/systemBrand.ts` |
| **2a — Token ramp** | Make the clay ramp accent-derived (relative-color from `--clay`) OR server-generate it; pin the brandable-vs-fixed token set. **Prerequisite for Phase 5.** | `frontend/react/src/styles/global.css`, `brand/brand.css` |
| **3 — Graduate to core** | Drop `brand` `toggleDefault` **only** (keep `workspace:*` RBAC on tenant routes); open the gates (ADR 0134 recipe). Keep optional voice/compliance as sub-toggles if desired. Record the ADR 0155 correction note. | `features/brand/feature.ts`, `features/index.ts`, `features/brand/routes.ts` |
| **4 — Super-admin route + public read** | `GET/PUT /v1/host/openwop-app/app-brand` (`requireSuperadmin`); `GET /v1/host/openwop-app/public-brand` (pre-auth, **reserved-id-only, no id param**, identity subset, no gate secret, ETag+cache) added to `PUBLIC_PATH_PREFIXES`. **Route-level tests** (createApp + cookie-jar): public read returns only the app brand; a tenant brand's identity never leaks; `PUT /app-brand` is super-admin-only; tenant routes still require `workspace:write`. | `routes/appBrand.ts`, `routes/publicBrand.ts`, `middleware/auth.ts` |
| **5 — Runtime apply (SPA) + serve-time inline** | Serve-time `index.html` transform inlines title/favicon/`:root`+`.theme-dark` brand vars (no FOUC, no per-load round-trip). `BrandProvider` reconciles, injecting tokens for both themes, swapping favicon/title/fonts/logo (size-reserved box); refactor `src/brand/brand.ts` to hydrate from it; build-time values stay as fallback. | `frontend/react/src/brand/`, the SPA serve path |
| **6 — Editing UIs** | Admin "Appearance" panel (mirror `FrontPageSettingsPanel`): **single accent picker with read-only derived ramp**, curated AA-validated surface presets, curated font pairings (+ advanced custom-href with a load check), light/dark logo slots, **live light+dark chrome preview**, per-field reset. Ship **2–3 curated brand presets** as starting points. Reuse the editor for marketing brands' voice. | `frontend/react/src/site/AppearancePanel.tsx`, `features/brand/` |
| **7 — Core-app extension surface** | Extend `feature.brand.nodes` (`brand.identity.get/set`?), `ctx.features.brand` identity read, optional Brand Steward agent affordances, AI-chat envelopes if any; `/.well-known/openwop` advertises nothing new (host-ext). | `packs/feature.brand.*`, `features/brand/surface.ts` |
| **8 — Assets (fast-follow)** | Logo/favicon upload via `media` (ADR 0007); per-workspace brand override (future, see Open Qs). | `features/brand/`, `media` |

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | Extend existing `features/brand/` (backend + frontend). `src/brand/` becomes seed/first-paint adapter. Core may not import features → the chrome reads brand via the `BrandProvider` (a `src/brand/` shim), not a feature import. |
| 2 | **Toggle + admin UI** | **Graduates to always-on/core** (drop `toggleDefault`). App-brand edited by super-admin (Appearance panel); marketing brands in `FeatureTogglePanel`-independent `/brand` page. Optional voice/compliance may stay sub-toggled (CMS precedent). |
| 3 | **Workflow surface (ADR 0014)** | `ctx.features.brand` gains an identity read (resolve the effective app/tenant brand); writes stay service-side. Advertised host-ext, no `/.well-known` wire change. |
| 4 | **Node pack** | Extend `feature.brand.nodes` (keep `brand.voice.resolve`/`brand.compliance.check`; add identity read node if a workflow needs brand identity). Signed via the registry pipeline. |
| 5 | **AI-chat + envelopes** | No new envelope required; the Brand Steward (ADR 0058) can drive identity edits through the one chat. State "no new envelope" unless an authoring affordance needs one. |
| 6 | **Agent pack** | Reuse `feature.brand.agents` (Brand Steward); optionally teach it identity fields. No new agent. |
| 7 | **Public surface** | `GET /public-brand` (pre-auth) in `PUBLIC_PATH_PREFIXES`; **reserved `brand:host-app` only — no id param**, so tenant brands can't be enumerated; identity subset only; tenant from the reserved org, never the request; uniform 404; ETag + cache (read on every cold load — but serve-time inlining removes it from the critical path; mind the rate-limit fan-out). |
| 8 | **RBAC + isolation (ADR 0006)** | App brand: **super-admin only** (host-level, fail-closed), never org RBAC. Marketing brands: `workspace:read`/`workspace:write`, tenant+org IDOR-guarded — **graduation drops the toggle gate, not these scope gates**. Gate secret never crosses `/public-brand`; a tenant brand's `identity` never reaches the chrome. |
| 9 | **Replay / fork safety** | Identity is not run-influencing; no `run.metadata` stamp needed. Voice resolution (ADR 0155) unchanged. Packs decoupled from toggle state (now moot — always-on). |
| 10 | **Frontend** | `BrandProvider` + Appearance panel + existing `/brand` page; nav via the menu registry (Appearance under Admin, like "Front page"); `ui/` tokens + a11y + dark-mode (the very thing being themed — verify both modes). |

## Alternatives considered

- **A new `appearance`/`white-label` feature (my initial instinct).** Rejected per the
  operator: it forks the single `Brand` owner and breaks the 1:1 app-brand↔campaign-brand
  mapping. The CMS analogy (homepage = a CMS page, not a separate feature) is decisive.
- **Keep build-time `VITE_BRAND_*`, add only an env-editor.** Rejected: still requires a
  rebuild/redeploy to change identity; no runtime super-admin control — the core ask.
- **Per-workspace brand from day one.** Deferred (Open Qs): the ask is "the white-label
  app once installed" = one installation identity. Per-workspace is an additive later
  phase (the resolver already keys by scope).
- **Rename ADR 0155 `brand`→`brand-voice` to free the id.** Rejected: 0155 is shipped
  with tenant data + `feature.brand.*` packs; churns a live stable id for no gain once
  we consolidate.

## Architecture + design review (incorporated)

`/architect` (Track A) + `/frontend-design`, 2026-06-29. Six findings, all folded into the
sections above:

1. **[BOUNDARIES, blocking]** Reuse the existing `host-site` reserved org + the
   `accessControl.createOrg({orgId})` seam for `brand:host-app`; do not mint a new
   `host:brand` org (cites `accessControlService.ts:264-272`, `featuresPage.ts` precedent).
   → Decision #2, boundaries audit, data model, Phase 2.
2. **[AUTHZ/ISOLATION]** `/public-brand` is reserved-id-only (no id param); a tenant
   brand's `identity` can never be enumerated or reach the chrome; no gate secret.
   → Decision #4, matrix rows 7–8, Phase 4 tests.
3. **[COHESION]** The `identity`/`voice` facets are optional and scope-bound; editors don't
   cross-surface fields. → "Facets are optional and scope-bound."
4. **[AUTHZ]** Graduating to always-on removes only the toggle gate, never `workspace:*`
   RBAC; verified the Campaign cluster doesn't depend on `brand` being OFF. → Decision #3.
5. **[PERF + FOUC]** Inline the resolved brand into `index.html` at serve time — fixes both
   first-paint flash and the per-cold-load `/public-brand` round-trip. → Decision #4, Phase 5.
6. **[VISUAL CORRECTNESS, blocking]** The clay ramp is literal hue-40 oklch, not derived
   from `--clay` — setting the accent half-recolors the app. Make the ramp accent-derived
   or server-generate it; pin the brandable-vs-fixed token set. → "Token contract," Phase 2a.

## Open questions / decisions checklist

**Resolved by the review** (now in the plan): FOUC → serve-time `index.html` inlining
(Decision #4); `appGate` secret → never returned by `/public-brand`, enforced server-side
(Decision #4); color→token contract → pinned in "Token contract" + the clay-ramp fix (Phase 2a).

Still open:
- [ ] **Per-workspace branding** (future phase): does a workspace override the app brand
  in its authed surfaces? Resolver keys by scope already; needs a tenant-admin editor +
  a precedence rule (workspace > app default).
- [ ] **Asset storage** via `media`: **fast-follow (Phase 8 deferred — see log).** The
  existing `POST /media/upload` is TTL-bounded (ephemeral chat attachments), unsuitable
  for a permanent logo. Needs a **non-expiring, host-global brand-asset store** served
  pre-auth through the already-public RFC 0055 `/assets/:token` surface. Until then, logos
  use an https/relative URL or a `data:image` favicon (shipped + working). Light/dark logo
  slots + save-time AA-contrast validation + the `appearance` i18n catalog ride here too.
- [ ] **White-label bundle interaction (ADR 0052).** The bundle still ships `VITE_BRAND_*`
  as the *install-time seed*; document that runtime edits live in the DB (and survive
  redeploys via the frozen-once-edited guard, which also ignores later env changes once
  edited). Update `WHITE-LABEL.md`.
- [ ] **Curated brand presets**: how many, and who authors them (ship 2–3 coherent
  starting identities so operators don't begin from a blank set of pickers).

## ROADMAP / FEATURES sync (proposed, land in lockstep)

- **FEATURES.md** — move `brand` from "Future/Marketing, OFF" to **Current features,
  always-on/core**, note dual ownership (app identity + marketing brands) and the new
  Appearance admin surface; add the `public-brand`/`app-brand` host routes.
- **ROADMAP.md** — add the ADR 0170 row (extends 0155; status 🔵 Planned; packs
  `feature.brand.*`; deps 0155/0027/0007/0006/0015/0052).
- **ADR 0155** — append a correction note: model gains an `identity` facet and the
  toggle graduates to always-on per ADR 0170.

## Post-implementation architecture review (2026-06-29)

A full-solution `/architect` (Track A) pass found **0 blocking** issues (Boundaries /
Security / Data-integrity all Pass — single owner, reserved-org reuse, RBAC kept,
`/public-brand` reserved-id-only, mutate-singleton probed safe with no module-eval
capture). Findings + resolutions:

- **[MEDIUM-1 drift] FIXED** — the identity shape + color→token map are mirrored across
  FE/BE + HTML/CSS boundaries (no shared type possible). Added an explicit **MIRROR
  CONTRACT** note (`applyBrand.ts`) cross-linking all 5 sites + pointers at each.
- **[MEDIUM-2 cohesion] FIXED** — subscribed the **App root** to `useBrand()` so a
  super-admin override re-renders the tree (every `brand.*` consumer refreshes), and
  migrated the always-visible chrome (footer, `PublicShell`, `WorkspaceSwitcher`) to
  `useBrand()`. Direct-singleton reads (page-remount / build-time fields) documented in `brand.ts`.
- **[bonus bug] FIXED** — the editor's "Default theme" (`theme.defaultMode`) was stored
  but never applied (a dead control); now hydrated into `brand.defaultTheme` and honored
  by the pre-paint theme script.
- **[LOW-2] FIXED** — extracted `ensureSystemSiteOrg` (single owner of the reserved-org
  create; `systemBrand` reuses it — no duplication, no homepage-seed coupling).
- **[LOW-3] FIXED** — favicon swap drops the build-time `type="image/svg+xml"` (lets the
  browser sniff a PNG/ICO override).
- **[MEDIUM-3 i18n] DEFERRED (documented)** — the Appearance panel ships English (2
  non-fatal `check-i18n` warnings). Full 4-locale i18n is risky to force here: the
  namespace is path-derived, so a `src/brand/i18n` catalog would **collide with the
  existing `brand` feature catalog**, and cross-locale parity is **fatal** — forcing it
  would risk a fatal build break to clear a non-fatal warning. Tracked for a dedicated
  `grade-i18n`/translation pass (alongside per-field reset, light/dark logo slots, save-time AA).
- **[LOW-1] kept consistent** — Appearance is `tier:'admin'` like the `Front page` panel
  (both `requireSuperadmin` server-side); a super-admin nav tier would be an app-wide
  change, deliberately not diverged for one surface.

## Implementation log

_(updated as phases land — phase → commit/test)_

| Phase | Status | Evidence |
|---|---|---|
| 1 — Model | ✅ Done | `features/brand/types.ts` (`BrandIdentity` + `BRAND_COLOR_KEYS` closed set + `identity?` on `Brand`) + `brandService.sanitizeIdentity` (strict CSS-grammar color/font validators + `safeBrandAsset` — double as the Phase-5 injection control) wired into create/update. `test/brand-identity.test.ts` 6/6; 31/31 brand suite; tsc clean. /architect + /code-review passed. |
| 2 — Reserved app brand | ✅ Done | `host/systemBrand.ts` (`ensureSystemBrand`/`getAppBrand`/`editAppBrand`) reusing the **existing `host-site` reserved org** (review correction #1) via `accessControl.createOrg`; `brandService.ensureBrand` (fixed-id, create-if-absent = the freeze guarantee, single-owner of the store); boot-wired in `registerAllRoutes`. `test/system-brand.test.ts` 6/6; tsc clean; esbuild bundle resolves. /architect + /code-review passed. |
| 8 — Assets (fast-follow) | ⏸ Deferred (documented) | **Investigated, intentionally not wired.** `POST /media/upload` stores with a TTL (`UPLOADED_ASSET_TTL_SECONDS`) — it's the *ephemeral chat-attachment* path, so a brand logo routed through it would **expire and 404**. Wiring it would ship a broken feature (violates "advertise only honored behavior"). The **URL / `data:` logo path already shipped (Phases 1 + 6) supports permanent logos today** (operator-hosted https, root-relative, or a small `data:image` favicon). Clean follow-up = a **non-expiring, host-global brand-asset store** served pre-auth via the RFC 0055 `/assets/:token` surface (which IS already public) — a small additive decision. **Per-workspace branding stays FUTURE** per the ADR. No code shipped this phase by design. |
| 7 — Workflow surface | ✅ Done | `ctx.features.brand.getAppIdentity()` (host-global read of the reserved app identity, reuses `getAppBrand`) + `feature.brand.nodes.get-app-identity` node (fails-closed `host_capability_missing` like siblings). Pack `feature.brand.nodes` 1.0.0→**1.1.0** (additive), `requiredPacks` pin bumped in lockstep. No `/.well-known` wire change (host-ext). Brand backend suite 45/45; tsc clean. Brand Steward allowlist left minimal (optional per ADR). /architect + /code-review passed; backend/pack only (no /ux-review surface). |
| 6 — Appearance editor | ✅ Done | `brand/AppearancePanel.tsx` (super-admin Admin → Platform → **Appearance**) + `brand/appBrandClient.ts` (`requestJson` → `/app-brand`). Single **accent** picker (recolors the derived ramp), curated **font pairings** + 3 **brand presets**, identity/logo/theme fields, **live light+dark preview** (scoped recolor via `CLAY_RAMP_DERIVATIONS`, no live `:root` edit), save (applies live via `applyBrandIdentity`+hydrate+cache) + reset-to-default. 403 → read-only notice. a11y: preview is `aria-hidden` + non-interactive. `AppearancePanel.test.tsx` 3/3; FE build green (tsc + token/CSS + CSP + budget). /architect + /code-review + /ux-review passed. **Follow-ups (noted, non-blocking):** per-field reset, light/dark logo slots, save-time AA-contrast validation, and an `appearance` i18n catalog (panel ships English — non-fatal). |
| 5 — Runtime apply (SPA) | ✅ Done | `brand/applyBrand.ts` (DOM injector: brandable colors → `:root` tokens incl. `accent`→`--clay` ramp, typography, title, favicon, fonts `<link>`; `hydrateBrandSingleton`; localStorage cache) + `brand/BrandProvider.tsx` (fetch `/public-brand` → apply + hydrate + cache + version-bump; `useBrand()`). `main.tsx` hydrates synchronously from cache pre-render; `BrandMark` reads `useBrand()`; inline `<head>` script pre-paints cached colors/title/favicon (merged into the CSP-pinned theme script → `firebase.json` hash re-pinned). **Zero-FOUC after first visit** (serve-time-transform deferred — static Firebase). `applyBrand.test.ts` 6/6 (jsdom); FE build green (tsc + token/CSS + CSP); full FE suite 750 pass (1 pre-existing `ArtifactWorkbench` failure, unrelated — confirmed by stash). `check-tsx-color-literals` now skips test files (fixtures, not shipped). /architect + /code-review + /ux-review passed. **CSP note:** logos/fonts honor `img-src`/`font-src` — `data:`/self-hosted work; arbitrary CDNs need a CSP entry; Phase 8 media-upload makes logos same-origin (CSP-clean). |
| 4 — Routes + public read | ✅ Done | `routes/appBrand.ts`: `GET/PUT /app-brand` (`requireSuperadmin`, drives `getAppBrand`/`editAppBrand`) + `GET /public-brand` (**pre-auth, reserved-id-only — no id param, `{ identity }` subset only**, ETag + `max-age=60`). `/public-brand` added to `PUBLIC_PATH_PREFIXES`. Wired into the ROUTE_MODULES table. `test/app-brand.test.ts` 6/6 (anon read; superadmin RW; 403 non-superadmin; identity-only exposure; tenant brand can't leak; ETag/304; PUT sanitizes injection). 44/44 across brand + public-prefix neighbors; tsc clean. /architect (pre-auth isolation) + /code-review passed. |
| 3 — Graduate to core | ✅ Done | Dropped `brand`'s `toggleDefault` (always-on, ADR 0010/0024/0134 recipe) + removed the 6 blanket `requireFeatureEnabled('brand')` route gates — **every `workspace:*` RBAC + governance gate kept** (`loadBrandScoped` 404 IDOR / `requireOrgScopeFor` write / `requireGovernanceAuthority`). Frontend `/brand` nav drops `featureId` (always-on, cms precedent). Verified the Campaign cluster has no dependency on the brand toggle being OFF. tsc clean; brand suite 37/37 (toggle-gate test → always-on test; isolation/governance unchanged). /architect + /code-review + /ux-review passed. |
| 2a — Token ramp | ✅ Done | The clay ramp in `styles/global.css` is now **accent-derived** — `--clay-soft/-text/-strong/-rule/-wash/-glow/-bg-hi` are `oklch(from var(--clay) …)` (light + dark `--clay-text`), so a super-admin override of the single `--clay` accent recolors the whole ramp coherently (the review's blocking defect). Derived values equal the prior literals exactly → stock identity byte-unchanged. **Canonical `npm run build` green** (tsc + token/CSS + built-css + budget); relative color confirmed preserved in the built CSS. /architect + /code-review + /ux-review (dark-mode parity + stock AA preserved) passed. |

**§Correction (implementation refinement — sparse seed).** The ADR said the app
brand is "seeded from `resolveBrandFromEnv`." In practice the backend seeds an
**empty/sparse identity** (no override values) and the SPA merges the app brand OVER
its build-time brand singleton (Phase 5). This achieves the same "no visual change on
a fresh install" outcome WITHOUT duplicating the frontend `BRAND_DEFAULTS` in the
backend (avoids a second source of truth) — and is concurrent-boot-safe + frozen-once-
edited via `ensureBrand`'s create-if-absent semantics (no `SEED_VERSION` refresh needed
since there is no seeded default to refresh).
