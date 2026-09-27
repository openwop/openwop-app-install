# ADR 0331 — One form renderer: CMS `form` section + hosted fill page

**Status:** implemented (2026-07-10 — Phases 1–3 + i18n; §D4-B renderer convergence landed same day: engine re-homed to `lib/formEngine.ts` with a `runs/inputSchemaForm` re-export shim; the builder palette shares `inferScalarKind` and deliberately keeps its richer string-list/hint vocabulary — adapter, not rewrite)

## Implementation record

| Phase | Evidence |
|---|---|
| 1 renderer | `features/forms/render/PublicFormRenderer.tsx` + `render/deriveFields.ts` (FormField→DerivedField bridge; validation via the ADR 0197 `validateInputs` engine — `textarea` validates as `text`, the recorded adaptation). Tests: `PublicFormRenderer.test.tsx` (labeled controls, hidden honeypot inside `values`, client-validation block, 404 slot), `deriveFields.test.ts` |
| 2 CMS section | `cmsClient` SectionType `'form'`; `SectionsEditor` FormSectionEditor (org→published-form picker, fallback-selectable existing id); `SectionRenderer` public case (lazy renderer, honest-empty) + editor preview |
| 3 hosted page | `fillRoute.ts` `matchFormFillId` (encoding-tolerant, guarded decode) + `PublicFormPage` in the bare PublicShell via App.tsx; `formsClient.hostedFormUrl`; FormsPage dual-URL affordance. Tests: `fillRoute.test.ts` |
| 4 i18n/docs | forms + cms namespaces ×4 locales; FEATURES/ROADMAP lockstep |
**Date:** 2026-07-10
**Depends on:** ADR 0330 (Forms standalone — the primitive this composes),
ADR 0017 (Forms), ADR 0009 (CMS + page builder — the section model),
ADR 0027 (public front page / `/p/:slug`), ADR 0197 (schema-driven run-input
forms — the renderer engine to converge on), ADR 0012/0013 (public-surface
patterns)
**Toggles:** `forms` + `cms` (both STABLE; the section renders only where both
features' data allows — no new toggle)
**Sibling ADRs:** 0330 (independence), 0332 (funnel opt-in capture)

---

## Context

The app has exactly one custom-field capture feature (Forms) but **no way for
a visitor to fill a form on any surface we host**:

- The public form is a JSON API only (`GET /v1/host/openwop-app/public-forms/:formId`
  + `POST …/submit`); `FormsPage` copies that URL, and ADR 0017 explicitly
  deferred a hosted fill page ("public consumption is API-first in v1").
- CMS section types are `hero | richText | image | cta | columns | productGrid`
  (`cmsClient.ts:20-21`) — **no capture section exists**; `/p/:slug` and the
  front page collect nothing.
- Meanwhile the SPA contains **three independent field-schema→form engines**:
  Forms' bespoke `FormField` model (builder-authored), `runs/inputSchemaForm.ts`
  (ADR 0197's JSON-Schema derive/validate engine rendering `SchemaInputForm`),
  and `builder/palette/configFieldsFromSchema.ts` (node-config panels) — all
  bottoming out at `ui/Field`.

ADR 0017 (alternatives §2) already ruled the composition direction: a CMS
"form section" that *references* a `formId` — compose, don't fold. This ADR
builds that, plus the hosted fill page, on ONE shared renderer.

### Boundaries audit

- **No route collision**: `/f/` is unclaimed in `App.tsx` public matching
  (`/p/:slug`, `/shared/:token`, `/store/:orgId` today) and in
  `PUBLIC_PATH_PREFIXES` (backend untouched — the fill page consumes the
  existing public JSON API).
- **Single owner**: form definitions/submissions stay owned by `formsService`
  (ADR 0017/0330). CMS stores only `{ formId }` in section data — a reference,
  never a copy of fields.
- **Renderer reuse**: `ui/Field` is the a11y control primitive all three
  engines already use; ADR 0197's `inputSchemaForm.ts` is the strongest
  derive/validate engine. Forms' `FieldType` union
  (`text|email|textarea|select|checkbox`) maps injectively onto ADR 0197's
  `FieldKind` — convergence is mechanical, not a redesign.
- **Abuse surface**: the fill page/section POSTs to the *existing* public
  submit with its honeypot + per-IP rate-limit + payload caps — no new
  ingestion path is created.

## Decision

### D1 — `PublicFormRenderer`, exported by the forms feature

`features/forms/render/PublicFormRenderer.tsx`: fetches the public render
schema, renders fields via `ui/Field`, applies client-side validation mirroring
`formsService.validateValues` (required, email shape, select options,
honeypot as a visually-hidden field), POSTs the submit, and renders the
`submitMessage` success state + designed error/empty states. Props:
`{ formId, onSubmitted?, compact? }`. It is a **public-surface component**:
no authed clients, no feature-access hooks (published-only + toggle-on is
enforced server-side; a 404 renders the section/page's honest empty state,
never a leak of draft existence).

Import rule: features may import the forms package's exported renderer
(feature→feature composition via an exported API — the Sharing→CMS
precedent). CMS **lazy-imports** it so the public page chunk stays lean.

### D2 — CMS section type `form`

- `SectionType` union + `SECTION_TYPES` gains `'form'`; section data is
  `{ formId: string }`.
- **Editor**: the CMS section editor gets a form picker (org's published
  forms via the existing authed `formsClient.listForms`, fail-soft to a
  "Forms is disabled" notice when the toggle is off — the
  `listIntakeLists` fail-soft precedent).
- **Renderer**: `SectionRenderer` case `'form'` renders
  `<PublicFormRenderer formId=…/>` (lazy). On any 404 (deleted, unpublished,
  forms toggled off) the section renders **nothing** — a public page never
  breaks because a form went away.
- Applies everywhere sections render: `/p/:slug`, the front page, org CMS
  pages — and therefore funnel-bound pages (ADR 0332) with zero funnel work.

### D3 — Hosted fill page `/f/:formId`

A public SPA route in the bare `PublicShell` (the `/store/:orgId` posture):
matches via an extracted, encoding-tolerant matcher (the
`matchStoreOrgId`/`matchPublicPageSlug` precedent — charset accepts `%`,
guarded decode), renders `PublicFormRenderer` full-page with the form title.
`FormsPage`'s "public URL" affordance now offers **both**: the hosted page
URL (share this) and the JSON API URL (embed this). The JSON API remains the
contract; the page is a consumer.

### D4 — Renderer convergence (the three-engines collapse, phased)

- **Phase A (with D1):** `PublicFormRenderer` uses a small pure module
  `features/forms/render/deriveFields.ts` that maps `FormField[]` →
  the ADR 0197 `DerivedField` shape and reuses its validation helpers where
  they exist (`runs/inputSchemaForm.ts` exports the pure engine). Forms does
  NOT adopt JSON Schema as its authoring model in v1 — the builder's
  five-type union is a product choice; the *renderer* layer converges first.
- **Phase B (follow-on, explicitly deferred):** extract the shared engine to
  a neutral home (`ui/forms/` or `lib/`) consumed by `SchemaInputForm` and
  `PublicFormRenderer`; `builder/palette/configFieldsFromSchema.ts` migrates
  last (its `ConfigField` has builder-specific concerns). Deferral recorded —
  not a scope cut: D1 ships the convergent seam; B is mechanical unification.

## What does NOT change

- Backend: **zero backend changes.** The fill page + section consume the
  existing public API; abuse controls unchanged and shared.
- CMS storage: sections remain opaque data blobs; `{ formId }` is additive.
- Forms authoring model (`FormField`), the builder UI, and the submissions
  inbox — unchanged (0330 owns copy/placement changes).

## Phases

| Phase | Scope | Gate |
|---|---|---|
| 1 | `PublicFormRenderer` + `deriveFields` (D1, D4-A) + unit tests (validation parity with server, honeypot hidden, a11y labels) | frontend vitest + build gate |
| 2 | CMS `form` section: type, editor picker, renderer case, honest-empty on 404 | frontend vitest (SectionRenderer tests exist — extend) + build gate |
| 3 | `/f/:formId` route + matcher + tests (encoded/literal/malformed, the storeRoute test shape); FormsPage dual-URL affordance | frontend vitest + build gate |
| 4 | i18n ×4 for all new strings; FEATURES.md forms + cms rows; ADR statuses | docs lockstep + i18n parity gate |

Deploy note: frontend-only feature; no deploy-order coupling. Watch the
public-page read fan-out (a page with N form sections = N public GETs) —
sections should dedupe fetches per formId; the 300/min per-IP budget is ample
for real pages.

## Alternatives considered

1. **A CMS-native form builder (fields authored inside the section).**
   Rejected — duplicates the form-definition store and forfeits the shared
   submission inbox/analytics/sinks; ADR 0017 already rejected fold-in.
2. **Server-rendered public form HTML** (the ADR 0012-deferred renderer).
   Still deferred — the SPA public shell (`/store` precedent) gives a hosted
   page today without building the section→HTML renderer.
3. **Adopting JSON Schema as the Forms authoring model now.** Rejected for
   v1 — it widens the builder UI surface (arbitrary keywords) for no user
   ask; the renderer-layer convergence (D4) captures the reuse without the
   authoring-model migration. Revisit when multi-step/conditional logic
   (ADR 0017 deferral) lands.
4. **A web-component embed script** (third-party sites drop a `<script>`).
   Attractive follow-on; out of scope — the JSON API already serves external
   embedding, and the ui-plugins loader (ADR 0300) is the likely vehicle.

## RFC verdict

**Host-extension only — no RFC.** Frontend composition over an existing
non-normative public API; no wire, capability, or event changes.

## Open questions

- [ ] Should `/f/:formId` support a `?theme=` / brand param for embedding in
      iframes? (ui-plugins/embed follow-on.)
- [ ] Per-form CAPTCHA/anti-spam hook (ADR 0017 alt. 4) becomes more pressing
      once forms render on high-traffic pages — pluggable hook remains the
      plan; monitor submission abuse after launch.
- [ ] Section-level success behavior: inline message (v1) vs redirect step —
      redirect matters for funnels; ADR 0332 owns it.

---

## Correction note — fill-experience upgrade (2026-07-24, `docs/steward/UX_UPGRADE-forms.md`)

A competitive UX benchmark of the fill experience against Typeform, Tally,
Fillout and current form-UX practice graded the public renderer **Interaction C+
/ Capability C+**, while a11y, designed states and dark mode were already at or
above the market (idempotency key, honeypot, focus-to-first-invalid,
focus-on-success, heading root, in-flight dedupe). Catalog, matrix and ranked
gaps F-G1–F-G5 are in **`docs/steward/UX_UPGRADE-forms.md`**. The §D1 "ONE renderer" decision
is what made this cheap — every host surface (hosted `/f/:formId`, the CMS `form`
section, funnel-bound pages) inherited the upgrade from a single change:

1. **`FormField` gained an optional `description`** (bounded to 300 chars,
   trimmed, whitespace-only clears) which the public render schema carries and
   the renderer feeds to `ui/Field`'s existing `help` prop — so it is wired
   through `aria-describedby` with no new design primitive. The builder authors
   it per field.
2. **Inline validation, "validate late / revalidate early."** A field is judged
   on blur, then re-judged on every keystroke so a fix clears immediately;
   submit marks every field touched. Crucially the inline pass runs the **same
   ADR 0197 engine** as submit (`validatePublicField` slices one field through
   `validateInputs`) — a second, looser client rule is how "it looked fine until
   I pressed submit" happens.
3. **An accessible error summary** listing every problem in field order. It
   **complements** the §D1 focus-to-first-invalid behaviour rather than replacing
   it: announced via `role="alert"` with a named region, so it is heard without
   stealing focus.

Implementation note worth keeping: the summary's jump-to-field was first written
as `querySelector('[name="…"]')` with `CSS.escape`. **`CSS.escape` is undefined
in jsdom and in older embedded webviews** — precisely the environments a public
form renders in — so it threw on click. It now holds per-control refs and uses a
`<button>`, since moving focus within the page is an action, not a navigation,
and `ui/Field`'s generated ids offer no honest fragment to point an `href` at.

Deferred, recorded rather than implied-absent: multi-page layouts, conditional
logic, file upload and payments (F-G4 — each an authoring-model + wire + storage
program, and all four are FREE-tier in Tally), and partial/abandoned submissions
(F-G5 — needs a draft-submission model plus a privacy decision about storing what
someone typed and chose not to send).
