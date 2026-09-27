# ADR 0490 — User-facing tutorials (the MyndHyve tutorial system, ported)

> **Renumbered 2026-07-25 (was ADR 0303).** `0303` was issued twice on 2026-07-06:
> `0303-rfc-0123-connection-pack-provider-vendor.md` merged at 20:58 (#1430) and this
> file at 21:02 (#1431). Per the first-created-wins duplicate-number policy the
> connection-pack ADR keeps `0303`, and this one moves to the verified next-free slot.
> Compounding it, **nine source files under `features/tutorials/` cited "ADR 0301"** —
> which is actually `0301-cdp-f-audit-hash-chain.md` — so the code↔decision link this
> repo relies on was broken in both directions. Both were fixed in ADR 0488 P0.
> Nothing about the decision below changed; only its number.

**Status:** implemented (2026-07-06)
**Relates to:** ADR 0183 (manual-tests — the content-posture precedent), ADR 0144 (access-hub — the always-on FE-surface precedent), ADR 0293–0297 (the Funnel Program the flagship tutorial teaches)

## Context

MyndHyve ships a comprehensive user-facing tutorial section (`/docs/tutorials`):
data-driven walkthroughs defined as typed JSON (`TutorialData` — hero, goal,
learning objectives, phases → steps → discriminated content blocks) rendered by
one renderer with per-step progress, seeded from TS files with a registry and a
CMS-backed lane for user-authored tutorials. Its flagship is the 12-phase
"Complete Marketing Setup" walkthrough. openwop-app had no tutorial surface at
all (verified: zero hits), and the newly-shipped Funnel Program needs exactly
this kind of guided on-ramp.

## Decision

1. **Port the MODEL, not the code**: `frontend/react/src/features/tutorials/` —
   a trimmed `TutorialData` (phases/steps + the content union: instructions,
   feature-grid, callout, prose, checklist, code; `prose` renders bounded
   `**bold**` text, never HTML — no `dangerouslySetInnerHTML`), one renderer
   (`TutorialsPage`) on the HOUSE design system (PageHeader/Notice/StateCard/
   chips), and a seed registry (`registry.ts` + `content/<id>.ts`) mirroring
   MyndHyve's add-a-tutorial workflow. Per-step progress persists in
   `localStorage` (`openwop-app.tutorials.<id>`), best-effort.
2. **Always-on, frontend-only** (the access-hub posture): tutorials teach
   features a workspace may not have enabled yet, so the reader itself is never
   toggle-gated. Routes `/tutorials` + `/tutorials/:tutorialId`, workspace tier.
3. **Content posture** (the manual-tests precedent, verbatim): reader CHROME is
   localized (4-locale catalogs, parity-gated); walkthrough CONTENT is authored
   English data. Localizing authored walkthroughs is a recorded follow-on.
4. **Flagship tutorial**: `build-your-first-funnel` — a 10-phase full
   walkthrough in the MyndHyve lp-complete format, grounded in THIS app's real
   surfaces (toggles → CMS pages → funnel assembly → publish/share → routing →
   commerce/affiliates/bumps → one-click upsells → per-step analytics →
   experiments → the Funnel Architect). Where a capability is API-only
   (routing rules) or operator-gated (one-click money movement), the tutorial
   says so explicitly — tutorials never overclaim the product.

## Alternatives considered

- **CMS-backed tutorials day-1** (MyndHyve's Firestore lane): deferred — the
  seed registry covers authored walkthroughs; a CMS entity type + loader is the
  follow-on once user-authored tutorials are actually wanted.
- **Serving tutorials as CMS pages**: rejected — tutorials need typed,
  progress-trackable steps; flattening to page sections loses the model and
  the per-step progress semantics.
- **Backend-stored progress**: deferred — localStorage matches MyndHyve's UX
  for anonymous-friendly docs; account-synced progress can layer on later
  without a model change.

## Verification

Registry sanity vitest (unique tutorial/step ids — step ids are the progress
keys — non-empty phases, known block types); `npm run build` green through all
gates (i18n parity ×4, classnames, budgets); eslint 0 warnings (the DESIGN.md
no-emoji-icons rule enforced — checklist glyphs render via `ui/icons`).

## Follow-ons (recorded)

- Localize authored walkthrough content (the manual-tests posture applies until then).
- CMS-backed user-authored tutorials (entity type + loader).
- More seeds: workflows, CMS, CRM — the MyndHyve catalog is the menu.

### Phase H note (2026-07-06)

Two more seeds shipped — **Connect Your AI** (getting-started: managed vs
BYOK, the Keys page, Models, the one chat + agents) and **Open Your
Storefront** (commerce: catalog → public store → promotions → order lifecycle
→ revenue summary), both grounded in shipped surfaces with the honesty rules
(keyless demo posture, money verification) stated in-content. The two
remaining follow-ons were re-affirmed as DELIBERATE deferrals per their
recorded triggers: CMS-backed tutorials wait for actual user-authoring demand;
content localization waits for the manual-tests-posture revisit — neither is
forgotten work.
