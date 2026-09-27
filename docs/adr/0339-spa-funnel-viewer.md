# ADR 0339 — SPA funnel viewer: funnels become a visitor-facing surface

**Status:** Accepted (2026-07-10; implementation same day)
**Depends on:** ADR 0294 (funnels + public JSON API), ADR 0331 (form section +
`PublicFormRenderer`), ADR 0332 (`formContext` + attribution sink; this closes
its §D4 correction), ADR 0295 (custom domains — the hostname serving this
renderer becomes the target of), ADR 0236 (visitor key), ADR 0027 (public page
rendering)
**Toggles:** `funnels` + `cms` (STABLE — server-side gating; the viewer is a
consumer). No wire, no backend change, no RFC.

## Context

Funnels are API-first: `publicFunnelUrl` hands a visitor a JSON document. The
entry/step/`/next` API, the bound CMS page read (`fetchPublicPage`), the public
section renderer (`RenderSections mode='public'`, including the ADR 0331 `form`
section), and the served `formContext` all exist — nothing composes them for a
visitor. ADR 0332's correction recorded this as the missing renderer.

## Decision

A public viewer at **`/fn/:orgId/:slug`** in the bare PublicShell (the
`/store` / `/f/` posture), owned by the funnels feature:

- **D1 — step render:** fetch the funnel entry (or `?step=ix` deep-link) with
  the visitor's `?vk=` (ADR 0236 `getVisitorKey`), then the bound page via
  `fetchPublicPage(orgId, step.pageSlug, vk)`, rendered with
  `RenderSections('public')` — experiments/localization/SEO apply verbatim;
  funnels still never render page content themselves.
- **D2 — form embed seam (forms-owned):** `features/forms/render/embedContext`
  exports a React provider carrying `{ context?, onSubmitted? }`;
  `PublicFormRenderer` merges provider context under its prop and invokes both
  callbacks. Import direction stays integrator→primitive (funnels imports the
  provider; forms stays funnel-ignorant — the ADR 0330 discipline). The viewer
  provides `{ ...step.formContext, visitor: vk }`, so submissions attribute via
  the ADR 0332 sink with zero form-section configuration.
- **D3 — advance:** a form submission auto-advances (`onSubmitted` →
  `GET …/next?from=stepId&vk=`); every step also renders a **Continue** CTA
  (same call, no outcome) so non-capture steps have a path. `/next` keeps
  emitting `step_completed` exactly as before; the known double-signal with the
  attribution sink is already distinguishable (`source: 'form-submit'`) and
  visitor-deduped in variant stats (ADR 0332 record).
- **D4 — states:** designed complete state (`StateCard`), uniform-404
  unavailable state (no draft/toggle leak), skeleton loading. FunnelsPage shows
  the copyable **viewer URL** beside the API URL (the FormsPage dual-URL
  precedent).
- **D5 — custom domains:** ADR 0295's verified-hostname serving points at this
  route as its funnel renderer (follow-on wiring there, not here); the path
  matcher is encoding-tolerant (`orgId` contains `:` — the storeRoute charset +
  guarded decode).

## Alternatives

Server-rendered funnel HTML (rejected — the deferred ADR 0012 renderer;
the SPA public shell already serves this class), a funnels-owned copy of the
section renderer (rejected — parallel architecture), advancing ONLY via form
submit (rejected — strands non-capture steps).

## Open questions

- [ ] Step-kind-aware CTA copy (checkout steps → storefront link) — v1 ships a
      neutral Continue; revisit with commerce-funnel usage.
- [ ] SEO surface for `/fn/` (public pages carry `seo`; the SPA shell applies
      the front-page treatment) — follow the ADR 0027 pattern when demanded.

## Implementation record

| Piece | Evidence |
|---|---|
| Matcher + route | `features/funnels/viewer/viewRoute.ts` (`matchFunnelView`) + App.tsx PublicShell wiring; tests `viewRoute.test.ts` |
| Viewer | `features/funnels/viewer/FunnelViewerPage.tsx` (entry/advance/complete/unavailable states, vk propagation, Continue CTA) |
| Embed seam | `features/forms/render/embedContext.tsx` + `PublicFormRenderer` merge; test extension |
| Admin affordance | FunnelsPage viewer URL + i18n ×4 |

---

## Correction note — visitor-experience upgrade (2026-07-24, `docs/steward/UX_UPGRADE-funnels.md`)

A competitive UX benchmark of the viewer against ClickFunnels, Unbounce,
Instapage and the multi-step-form research literature graded it **Interaction C /
States B−**. Catalog, matrix and ranked gaps FN-G1–FN-G6 are in
`docs/steward/UX_UPGRADE-funnels.md`. Everything shipped is frontend-only: `step.name`,
`step.ix` and `stepCount` were **already in the public payload** and the viewer
simply wasn't reading them.

**The defect (FN-G4).** A failed `/next` passed `null` straight into `show()`,
whose `!payload` branch is the uniform *unavailable* state — so one flaky
request threw a visitor out of a part-completed funnel and lost it. A failed
advance now keeps the current step on screen, says so ("your answers are still
here"), and turns the primary button into a retry. This is a correction to the
0339 state machine, not a polish item: `unavailable` must mean "this funnel
isn't there", never "one request failed".

**The additions.** A progress bar with **labelled stages** (`aria-valuetext`
carries `"Step 2 of 3 · Your details"`) — the research is specific that labelled
stages beat bare percentages for managing time-commitment expectations, and that
the stage *name* is the right thing to drop on a narrow screen, not the position.
And an **in-page Back**, which is safe by construction: FRMX-1 already put the
step in the URL, so Back is a view-pointer move that re-serves an earlier step
and never calls `/next` — no step is completed and nothing is undone. (The
literature names the browser back button erasing progress as a top abandonment
cause; ours never did, but visitors don't know that, so the in-page control is
the affordance that makes the existing safety legible.)

Deliberately NOT changed: the complete state still has no CTA (FN-G5). The honest
next destination for a finished public funnel is operator-specific — a thank-you
page, a product, a download — and inventing one would be worse than none. It
belongs in the funnel's own authoring model.

Deferred: per-step dropout reporting in the builder (FN-G6). ClickFunnels reports
completion rate and dropout point per step; we already **emit** the events
(`funnel.step_viewed` / `funnel.step_completed`) but project nothing per step.
The data exists, which makes this the highest-value follow-on.
