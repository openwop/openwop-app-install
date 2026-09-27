# ADR 0332 — Funnel opt-in capture: forms as the funnel's lead surface

**Status:** implemented (2026-07-10 — Phases 1–3 + docs; see the §D4 correction)

> **Correction (2026-07-10, implementation):** §D4's "the funnel page wires
> `onSubmitted` → next-step navigation" assumed an SPA funnel viewer — none
> exists (funnels are API-first, like Forms pre-0331: `publicFunnelUrl` is a
> copyable JSON API entry). The implemented shape: the public step payload now
> serves a ready-made **`formContext: { funnelId, stepId }`** (the renderer
> adds its consented `?vk=` as `visitor` and passes it to the form section),
> so ANY consumer — external renderer or a future SPA viewer — wires capture
> without new endpoints; the step editor gained the D5 advisory + Manage-forms
> link. The `onSubmitted` advance lands with whichever renderer first serves
> funnel pages. Also note: a renderer that both submits AND calls `/next`
> double-counts day-stat completions (variant stats dedupe by visitor) — the
> recorded dedupe open question covers it; `source: 'form-submit'` on the
> event makes the two emitters distinguishable in the rollup if needed.

## Implementation record

| Phase | Evidence |
|---|---|
| 1 context | `formsService.Submission.meta.context` (opaque) + bounded parse in `forms/routes.ts` (≤8 entries, 64/256 caps, silent drop) |
| 2 sink | `funnels/formsAttributionSink.ts` registered in `funnels/feature.ts` — toggle-gated, tenant/org from the submission (context inert cross-tenant), sticky-variant parity via `publicFunnelStep`, `source: 'form-submit'` |
| 3 surface | `PublicFunnelStep.formContext`; FunnelsPage opt-in advisory + Manage-forms link ×4 locales |
| tests | `forms-funnel-attribution.test.ts` (event emit + payload, inert unknown context + bounds, formContext exposure) |
**Date:** 2026-07-10
**Depends on:** ADR 0330 (Forms standalone), ADR 0331 (CMS `form` section —
the render vehicle), ADR 0294 (funnels + the CDP `funnel.step_viewed`/
`funnel.step_completed` event spine), ADR 0296 (checkout conversion via
`funnelRef` provenance — the pattern this mirrors), ADR 0236 (visitor key
`?vk=`), ADR 0226 (submission `sessionKey`)
**Toggles:** `funnels` + `forms` (both STABLE — no new toggle; capture lights
up where both are on)
**Sibling ADRs:** 0330, 0331

---

## Context

A funnel step of kind `optin` is today a label over a bound CMS page
(`funnelsService.ts` — steps hold a `pageId`, kinds
`landing|optin|sales|checkout|upsell|downsell|thankyou`), and CMS pages
cannot capture input, so **a funnel opt-in captures nothing**. There is no
funnel lead object and no lead store; funnel analytics are a derived rollup
(`funnelStats.ts`, ADR 0211 doctrine) over two sources of truth: the CDP
event spine (`funnel.step_viewed` / `funnel.step_completed`) and commerce
Orders stamped with `funnelRef` (ADR 0296).

With ADR 0331, any funnel-bound page can embed a `form` section — so the
render problem is already solved. What remains is **attribution**: a form
submitted on a funnel step should (a) be traceable to the funnel/step/visitor
and (b) count as that step's completion in the existing stats, the same way
checkout counts via `funnelRef`.

### Boundaries audit

- **No new capture store.** The lead IS the forms `Submission` (ADR 0330's
  one data object). Funnels stores no copy; the rollup remains derived.
- **No new event types.** `funnel.step_completed` already exists (ADR 0294
  Phase 2); this ADR adds a new *emitter* of an existing event, exactly as
  ADR 0296 added checkout.
- **Import direction** (ADR 0079/0330): funnels → forms only (registering a
  sink on the 0330 seam). Forms gains a *generic* embed-context slot, not a
  funnels-specific field — forms stays funnel-ignorant.
- **Visitor identity**: the funnel page already carries the bounded visitor
  key (`?vk=`, ADR 0236) and forms submissions already capture a `sessionKey`
  (ADR 0226 — `routes.ts:151-162`). No new identity mechanism.

## Decision

### D1 — Generic embed context on submissions (forms side, funnel-ignorant)

`PublicFormRenderer` (ADR 0331) accepts an optional
`context?: Record<string, string>` prop (bounded: ≤8 keys, ≤64-char keys,
≤256-char values — the meta caps pattern). It rides the submit body and is
persisted under `Submission.meta.context`. Forms validates size only; it
assigns no meaning. This is the same posture as `meta.utm` — opaque
provenance supplied by the embedding surface.

### D2 — Funnel pages pass their context

When a funnel-served page renders a `form` section, the funnel public surface
supplies `context = { funnelId, stepId, variant?, visitor }` (the values it
already knows from routing + `?vk=`). A plain CMS page passes nothing —
same section, no funnel machinery.

### D3 — Funnels register a submission sink → `funnel.step_completed`

The funnels feature registers a **no-write-back sink** on the ADR 0330
submission-sink seam (`registerSubmissionSink({ id: 'funnel-attribution', … })`)
— the same registration direction as CRM's contact sink (funnels → forms).
The host-event dispatcher is NOT used here: it has no in-process subscriber
lane (webhooks + workflow-trigger bindings only, ADR 0208 §1), and the
trigger lane would spend a workflow run per submission. The sink — gated on
the tenant's `funnels` toggle, fail-soft by contract, returns `undefined`
(pure side effect):

1. Reads `meta.context.funnelId/stepId` + visitor; ignores submissions
   without funnel context (the common case).
2. Verifies the funnel/step exists and the step's bound page is plausible
   (tenant/org guard — never trust context across tenants; the submission's
   tenant is authoritative).
3. Emits a `funnel.step_completed` CDP event stamped with the visitor +
   variant — the **existing** shape `funnelStats` already rolls up. The next
   rebuild counts the opt-in as that step's completion/conversion; the A/B
   z-test works unchanged.

No write-back onto the submission; no funnels state. Duplicate submits
double-count exactly as duplicate checkout events would — the rollup is
self-correcting per the ADR 0211 doctrine, and submit idempotency remains
ADR 0017's recorded open question (unchanged by this ADR).

### D4 — Step UX: post-submit advance

ADR 0331's section success behavior gains one optional knob used by funnels:
`onSubmitted` advances to the funnel's next step URL (the routing the funnel
page already owns). v1 keeps it simple: the funnel page wires `onSubmitted`
→ next-step navigation; the CMS section alone (non-funnel) keeps the inline
`submitMessage`.

### D5 — Where the leads live (product answer, no new UI)

"Funnel leads" = the form's submissions inbox (`FormsPage`), reachable from
the funnel step editor via a "View submissions" link to
`/forms?org=…&form=…` (the existing deep-link). A funnel-side leads table is
explicitly NOT built — one inbox, one data object (ADR 0330). The funnel
analytics view gains opt-in completions automatically via the rollup.

## Phases

| Phase | Scope | Gate |
|---|---|---|
| 1 | Forms: `meta.context` (bounded) + renderer prop + tests (caps, opacity) | backend + frontend vitest |
| 2 | Funnels: `funnel-attribution` sink → `funnel.step_completed` (guarded, fail-soft, no write-back) + rollup test (submission with context counts; without context ignored; cross-tenant context rejected) | backend vitest |
| 3 | Funnel page: context injection + `onSubmitted` next-step advance; step editor "View submissions" link | frontend vitest + build gate |
| 4 | Docs: FEATURES funnels row note; ADR statuses; funnel tutorial copy ("point your opt-in at a form") | docs lockstep |

Deploy order: backend (sink) before frontend (context injection) — a
context-carrying submission against an old backend is harmlessly opaque.

## Alternatives considered

1. **A funnel-native lead object/store.** Rejected — parallel architecture
   ([[no-parallel-architecture]]); the submission IS the lead; funnels stays
   a derived-analytics consumer.
2. **Forms emits `funnel.step_completed` directly when context present.**
   Rejected — forms would learn funnel semantics and import CDP emit paths
   for another feature's domain; the funnels-registered sink keeps ownership clean
   (funnels owns its events, the ADR 0296 shape).
3. **An in-process listener on `host.forms.submission.created`.** Rejected —
   the host-event dispatcher deliberately has no in-process subscriber lane
   (ADR 0208 §1: webhooks + workflow-trigger bindings only); adding one is a
   new fanout lane on the ONE dispatcher for no gain over the sink seam.
4. **A workflow-chain binding** (the ADR 0247 forms-intake shape) mapping the
   event to a funnels node. Honest but heavy: one workflow run per
   submission, autonomous-run budgets applying to analytics bookkeeping.
   Kept as the tenant-configurable option for custom routing; the built-in
   attribution stays a sink.
5. **Client-side beacon from the form section to the funnels collector.**
   Rejected — duplicates the server-truth submission with a lossier client
   signal; ad-blockers would split the numbers.

## RFC verdict

**Host-extension only — no RFC.** Existing host-internal event types and
routes; no wire surface.

## Open questions

- [ ] Should an opt-in step *require* a form section on its bound page
      (editor lint) or stay advisory? v1: advisory notice in the step editor
      when the bound page has no form section.
- [ ] Dedupe window for completion counting (same visitor re-submitting) —
      v1 inherits the rollup's per-visitor `Set` semantics in the variant
      table (already dedupes by visitor) and raw counts in day stats; revisit
      with real traffic.
- [ ] CRM linkage on funnel leads (submission → contact via the 0330 sink)
      composes automatically when CRM is on — confirm the funnel step editor
      should surface that state (probably yes, read-only note).
