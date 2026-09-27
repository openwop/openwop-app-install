# ADR 0197 — Schema-driven run-input forms

Status: implemented (Phases 1–4, 2026-07-02)

> **Renumbered 0195 → 0197** (2026-07-02): same collision as ADR 0196 — see its renumber note.

## Phase → commit table

| Phase | What shipped | Commit |
|---|---|---|
| 1 — renderer | `runs/inputSchemaForm.ts` (pure v1-subset derive/validate/seed/compact, 10 tests) + `runs/SchemaInputForm.tsx` (ui/Field composition, `.segmented` aria-pressed mode switch, per-field JSON degrade) + route-less `run-input-forms` toggle + 12 i18n keys × 4 locales | `feat(runs): SchemaInputForm renderer…` |
| 2 — launch wiring | `RunsIndexPage` renders the form when the toggle is on and `GET /v1/workflows/:id` returns a renderable `inputSchema`; textarea stays the fallback | `feat(runs): wire SchemaInputForm…` |
| 3 — server validation | `host/runInputValidation.ts` (Ajv, WeakMap-cached) at `POST /v1/runs`, toggle-gated 400 `validation_error` + `details.errors`; 6 route-level tests pin all four postures | `feat(runs): best-effort server-side…` |
| 4 — GA flip | `toggleDefault.status: 'on'` (stored overrides win); docs lockstep | this commit |

## Corrections (implementation vs the proposal)

- **"Client-side Ajv" → client-side subset validator.** The frontend ships no ajv; the deliberately-small v1 keyword subset didn't justify the dependency. A ~100-line pure validator is the client check; **authoritative** validation is the backend's real Ajv (Phase 3), which is where it belongs.
- **Phase 2's anticipated backend read-extension proved unnecessary** — `GET /v1/workflows/:id` returns the stored definition verbatim, `inputSchema` included; the FE just fetches the selected workflow's definition.
- **OQ-1 resolved:** `runs/` placement (single consumer). **OQ-2 stands as a follow-on** (builder-side `inputSchema` authoring). **OQ-3 resolved:** server validation rides the same toggle; with the Phase 4 GA flip it is effectively always-on for schema-bearing workflows unless an operator opts out.
- **Live-verification caveat:** the flip rests on static + test evidence; the rendered form's interactive behavior is on the UX tracker's click-through list (CT-6).

**Date:** 2026-07-02
**Toggle:** `run-input-forms` · default **OFF** (migrates a live surface progressively; flip ON per the Phase plan once parity is proven) · `bucketUnit: tenant` · plain on/off
**Surface:** host-extension only — a frontend render + an optional best-effort server-side validation at the existing run-creation route. No new HTTP route; no new wire field.
**Composes (all implemented):** the workflow definition's existing optional `inputSchema` (`executor/types.ts:819-820`); the run-creation route + `runs/RunsIndexPage.tsx` launch form; the `ui/` field primitives (`Field`, `Notice`, `MarkdownEditor`); Ajv (already a backend dep for schema validation).
**RFC verdict:** **No RFC.** `inputSchema` already lives in the workflow definition type and is documented "informational only in this sample; real hosts validate via Ajv" (`executor/types.ts:820`). Rendering a form from it and validating inputs against it is **host behavior**, not a new normative wire contract. (Making input-validation a *normative MUST across hosts* would need an RFC — explicitly **out of scope**; we validate as a host courtesy with a raw-JSON escape hatch.)

---

## Context

The `/grade-ux` pass (2026-07-02, `docs/steward/UX-ASSESSMENT.md`, **Builder/Workflows/Runs**, grade **C**,
gap **BLD-2**) identified the single biggest "dev playground, not an enterprise product" tell in
the run surface: **the run-launch experience is a raw-JSON textarea**. `runs/RunsIndexPage.tsx:66`
initialises inputs to `{ text: 'hello world' }` in demo mode and a bare `'{}'` otherwise, and
`runs/RunsIndexPage.tsx:333-340` renders a `<textarea>` labelled `Inputs (JSON)`
(`runs/i18n/en.ts:340`). To launch a workflow on a clean install, an operator must hand-author a
JSON object with no guidance about what fields the workflow expects, their types, or which are
required. An enterprise user expects a **form**.

The raw material already exists: a workflow definition may carry an `inputSchema`
(`executor/types.ts:819-820`), and the backend already depends on Ajv. What is missing is the
**render + validate** layer on the launch path. This ADR adds it.

## Boundaries audit (Step 3)

- **Single owner of the launch path:** `runs/RunsIndexPage.tsx` (create-run form) → the
  run-creation route. We extend this one owner; we do not add a parallel launch surface.
- **`inputSchema` is not new** — `executor/types.ts:820` already types it as optional on the
  workflow definition; today it is unused on the launch path ("informational only"). This ADR
  makes it *consumed*, not *invented*.
- **Not the builder preflight.** `builder/PreflightBanner.tsx` / `BuilderShell.tsx:398`
  ("preflight") validates **capabilities / limits / unbound connections** before a run — it is
  **not** an input-params form (the UX scout's "the capability exists" referred to this; on
  inspection it is a different concern). So there is no existing input-form to reuse; this is
  genuinely additive, and the two must not be conflated.
- **Field primitives exist** — `ui/` `Field` + `Notice` + validation display; reuse, don't
  hand-roll inputs (DESIGN.md §5.1, `check-tsx-color-literals` gate).
- **Validation owner:** Ajv, already the backend schema validator. Client-side validation is a
  UX affordance; the run route MAY re-validate best-effort (never a new hard wire rejection —
  a workflow with no schema, or a caller who bypasses the form, still runs).

## Decision

**On the run-launch surface, when the selected workflow declares an `inputSchema`, render a
schema-driven form (one `ui/Field` per property: type-appropriate control, required markers,
descriptions, defaults). When it does not, fall back to the existing raw-JSON textarea.** Provide
an "Edit as JSON" escape hatch on the form for power users, and validate client-side before
submit (Ajv), surfacing errors via `<Notice>`.

The launch payload is unchanged (the same inputs object the run route already accepts) — the form
is purely a *better way to author the same object*. This keeps replay/fork untouched: a run's
recorded inputs are identical whether typed as JSON or entered via the form.

## Data model

- **No new persisted entity.** The form is derived at render time from the workflow's existing
  `inputSchema` (a JSON Schema `object`). Supported keywords for v1: `type` (string/number/
  integer/boolean/enum/object-as-JSON), `title`, `description`, `default`, `required`,
  `enum`, `format` (best-effort: `date`, `email`, `uri` → typed inputs). Unsupported/complex
  subschemas degrade to a JSON sub-editor for that field (never a hard failure — "invitation, not
  breakage", ADR 0163 R6).
- The `run-input-forms` toggle row is a standard ADR-0001 toggle (no schema impact).

## Phased plan

- **Phase 1 — the renderer.** A `SchemaInputForm` component in `runs/` (or `ui/` if reused
  elsewhere) that takes a JSON Schema `object` + value and renders `ui/Field` controls with
  client-side Ajv validation + `<Notice>` errors + an "Edit as JSON" toggle. Pure, unit-tested
  against representative schemas. Gated behind `run-input-forms` (OFF). (M)
- **Phase 2 — wire it into launch.** `runs/RunsIndexPage.tsx`: when the selected workflow has an
  `inputSchema` and the toggle is on, render `SchemaInputForm`; else the existing textarea. Remove
  the demo "hello world" seed's reliance on the textarea (it becomes a schema default where one
  exists). (S)
- **Phase 3 — best-effort server validation.** At the run-creation route, if the workflow has an
  `inputSchema`, validate inputs with Ajv and return a **400 with field-level errors** for a
  malformed body — but only when the schema is present; schema-less workflows are unaffected. This
  is a host courtesy, not a new normative wire rule. (S)
- **Phase 4 — flip the toggle ON** once Phase 1–3 parity is proven (the raw-JSON path remains the
  fallback for schema-less workflows and via "Edit as JSON"). (S)
- **Phase 5 — Core-app extension surface.** No node pack / agent pack / envelope types — this is a
  launch-UI capability, not a workflow-authored surface. It **does** make the existing
  `ctx`-workflow `inputSchema` field first-class on the UI; authoring an `inputSchema` in the
  builder (so operators can *define* the form) is noted as a follow-on (OQ-2), not built here.

## Alternatives weighed

- **Keep raw JSON only.** Rejected — it is the confirmed enterprise-credibility gap (BLD-2).
- **Generate the form from the workflow's node graph** (infer inputs from unbound variables).
  Rejected for v1 — brittle and implicit; an explicit `inputSchema` is the honest contract, and it
  already exists in the type. Graph-inference can be a later authoring aid that *writes* an
  `inputSchema`.
- **Make input validation a normative wire MUST** (all hosts validate). Rejected — that is an RFC-
  scale change to `../openwop`; this ADR deliberately stays host-side with a JSON fallback so no
  conformance claim is made.

## PRD-vs-architecture corrections

The gap list implied "the params form already exists (TemplatePreflightModal), just wire it in."
The audit shows the builder "preflight" is a **capabilities/limits/connections** check, not an
input-params form — so this is net-new render work, not a re-wire. The gap also framed inputs as a
demo concern; in fact the *content* ("hello world") is demo-gated (ADR 0196 / DEMO-1) but the
*raw-JSON affordance itself* is the enterprise gap, independent of demo mode.

## Open questions

- **OQ-1:** Where does `SchemaInputForm` live — `runs/` (single consumer) or `ui/` (if
  agent/chat launch surfaces want it too)? Proposed `runs/` until a second consumer appears.
- **OQ-2:** Do we add an `inputSchema` **authoring** control to the builder so operators define
  the form for their own workflows? Proposed: **follow-on ADR** — v1 consumes schemas that exist
  (templates, pack workflows); authoring is a separate feature.
- **OQ-3:** Should Phase 3's server validation be gated by the same toggle, or always-on when a
  schema is present? Proposed: gate with the toggle in Phase 3, make always-on when the toggle
  reaches GA — so a schema-bearing workflow can't be launched with a malformed body once shipped.
