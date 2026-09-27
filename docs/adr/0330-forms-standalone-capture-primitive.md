# ADR 0330 — Forms as a standalone capture primitive (CRM decouple + re-home)

**Status:** implemented (2026-07-10 — Phases 1–4; same-day acceptance)

## Implementation record

| Phase | Evidence |
|---|---|
| 1 backend seam | `features/forms/submissionSinks.ts` (registry, fail-soft, first-marker-wins) + `formsService.recordSubmission` sink loop; `crm/formsSubmissionSink.ts` registered in `crm/feature.ts`; `dependsOn` removed + category `Author`. Tests: `forms-submission-sinks.test.ts` (5), `forms-route.test.ts` crm-off case, `feature-toggle-dependencies.test.ts` edge removal + unlock, `crm-studio-grouping.test.ts` taxonomy graduation |
| 2 frontend | `routes.tsx` group `Author`; `FormsPage` crm-gated `createToContact` + `<Notice>` fallback; lede/hint/notice copy ×4 locales |
| 3 packs | `feature.forms.agents` 1.1.0 (CRM-optional persona), `feature.forms.nodes` 1.1.1 (ADR 0247 citation), `requiredPacks` bumped. **Public-registry publish resolved-by-decision (2026-07-10): NOT published** — the packs.openwop.dev trust policy is publisher-scoped and authorizes no key for the generic `feature.*` namespace (the signature gate correctly rejected a trial staging); feature packs distribute via the app image / white-label bundle, the deliberate status quo for every feature pack. Publishing would require a namespace-governance change to the registry's `.well-known` trust document — an operator decision, left open |
| 4 docs | Correction notes in ADR 0017 + ADR 0194; FEATURES row/prose; ROADMAP status |
**Date:** 2026-07-10
**Depends on:** ADR 0017 (Forms — this corrects its CRM coupling), ADR 0194
(feature-toggle dependencies — this removes the `forms → crm` hard edge),
ADR 0247 (forms intake portal — the events-not-imports precedent this extends),
ADR 0079 (import-direction discipline), ADR 0008 (CRM — becomes an *optional
destination*), ADR 0014 (feature workflow surfaces)
**Toggle:** `forms` (STABLE — no new toggle; the feature is re-homed, not re-made)
**Sibling ADRs:** 0331 (shared form renderer + CMS form section + hosted fill),
0332 (funnel opt-in capture) — together the "Forms as the app's common form
builder + data object" program. This ADR is the independence half; 0331/0332
are the composition half.

---

## Context

ADR 0017 shipped Forms as a near-standalone feature-package: form definitions
(`forms:def`) and append-only submissions (`forms:submission`) live in Forms'
own `DurableCollection` namespaces; the public submit persists the submission
FIRST and only then best-effort creates a CRM contact. The product decision
now is that **Forms is an independent, app-wide capture primitive** — CMS
pages, funnels, and future surfaces compose it — and CRM is one *optional
destination* among several, not the feature's parent.

### Boundaries audit — the complete coupling inventory (2026-07-10)

The forms→CRM coupling is exactly five things:

1. **One code import.** `formsService.ts:12` imports `createContact` from
   `../crm/contactsService.js`, invoked at `formsService.ts:272` inside
   `recordSubmission` when `form.createToContact` is true. This is the ONLY
   forms→crm code edge; CRM never imports forms back.
2. **The hard toggle dependency.** `features/forms/feature.ts:35`
   `dependsOn: ['crm']` — registered at boot (`featureToggles/registry.ts:58`),
   enforced as a disable-lock (`featureToggles/service.ts:238-266`, 409 with
   `details.dependents`), declared normatively in ADR 0194 (§ live deps:
   "`forms` → `crm` (capture → CRM contact)") and FEATURES.md (~line 115).
3. **Cosmetics.** Toggle `category: 'CRM'` + description "… → CRM contacts"
   (`feature.ts:22-23`); nav `group: 'CRM'` + hint "Public forms → CRM
   contacts" (`features/forms/routes.tsx:14-19`); page lede "submissions
   become CRM contacts" and the `createToContact` checkbox copy in **all four
   locales** (`features/forms/i18n/{en,es,fr,pt-BR}.ts:10,51,82-85`); the
   `feature.forms.agents` prompt reports "became CRM contacts"
   (`prompts/forms-lead-insights.md:18`).
4. **Soft data pointer.** `Submission.contactId?` (`formsService.ts:66`) — a
   plain string carrying a `crm:` id; no FK, no cascade. The submissions table
   renders a "contact" chip when set (`FormsPage.tsx:389`).
5. **Seed + tests.** `demoContentMarketingSeed.ts:110` seeds one
   `createToContact: true` form (Wholesale Inquiry) whose submissions create
   CRM contacts; `test/forms-route.test.ts:117-129` pins submit→`contactId`;
   `test/feature-toggle-dependencies.test.ts` pins the `forms → crm` edge.

**What already stands alone (no change needed):** definition + submission
persistence and ordering (submission row first, CRM effect second, failure
degrades to a recorded marker — ADR 0017's capture-ordering invariant);
authed CRUD + public render/submit routes; `ctx.features.forms` (read-only,
CRM-free); the node pack (list-forms / list-submissions / get-submission);
the `host.forms.submission.created` event + priority-matrix intake bridge
(ADR 0247); validation/honeypot/rate-limit/tenant-isolation; storage (no
relational tables, no migrations).

**No parallel architecture is created**: this ADR moves one call across an
inversion seam and edits declarations/copy. No second forms store, no second
contact path, no new chat surface.

## Decision

Make Forms self-sufficient at every layer where CRM is currently presumed,
while keeping "submission → CRM contact" available as a first-class *optional
integration* whenever CRM is enabled for the tenant.

### D1 — Invert the contact write through a submission-sink seam

Forms stops importing CRM. The forms feature exports a tiny registration
surface from its own package:

```ts
// features/forms/submissionSinks.ts (new, owned by forms)
export interface SubmissionSinkResult { contactId?: string; error?: string }
export interface SubmissionSink {
  id: string;                       // 'crm-contact', 'funnel-attribution' (ADR 0332), …
  /** Called AFTER the submission row is persisted. Fail-soft by contract.
   *  A sink is a post-persist, in-process consumer; it MAY return markers
   *  to annotate the submission (contactId) or return undefined (pure
   *  side-effect consumers, e.g. attribution). */
  onSubmission(form: FormDef, submission: Submission):
    Promise<SubmissionSinkResult | undefined>;
}
export function registerSubmissionSink(sink: SubmissionSink): void
```

**Why not the existing host-event seam?** `hostEventDispatcher` (ADR 0208 §1)
fans out to outbound webhooks and workflow-trigger bindings ONLY — there is
deliberately no in-process subscriber lane, and the trigger lane costs a
workflow run per event (autonomous-run budgets apply). The contact write
needs a synchronous, at-capture `contactId` write-back and must not spend a
run per submission — so a forms-owned sink registry is the honest new
micro-seam, recorded here per the ARCHITECTURE.md contract. The host event
(ADR 0247) continues to serve the async lanes unchanged.

- **CRM registers the sink** in its own `feature.ts` boot path: the sink body
  resolves the tenant's `crm` toggle (`resolveOne('crm', { tenantId })`) and,
  when ON and the form opted in (`createToContact`), calls its own
  `createContact` and returns `{ contactId }`. The import direction flips to
  **crm → forms** — the integrator depends on the primitive (the ADR 0079
  discipline; same direction as Sharing→CMS composition).
- `recordSubmission` keeps its exact ordering contract: persist the row, run
  registered sinks fail-soft, re-persist with `contactId`/`error`, emit the
  host event. With CRM's toggle off (or no sink registered) the submission
  records `error: 'sink_skipped:crm_disabled'`? — **no**: a skip is not an
  error. New marker semantics: `contactId` unset and no `error` when the sink
  was skipped; `error: 'contact_create_failed'` only on a real sink failure
  (unchanged). ADR 0017's open question "gate `createToContact` on the CRM
  toggle?" is hereby answered: **yes — via the sink's own toggle check.**
- Synchronous sink (not event-only) is deliberate: the existing UI/tests/agent
  prompt rely on `contactId` landing on the submission row at capture time.
  The event path (ADR 0247) remains the pattern for *async* consumers.

### D2 — Remove the hard toggle dependency

Delete `dependsOn: ['crm']` from `features/forms/feature.ts:35`. Forms no
longer blocks disabling CRM. **Behavior change (documented):** an admin can
now turn `crm` off while forms with `createToContact: true` exist — their
submissions still persist; only the contact side-effect is skipped. ADR 0194
gets a **correction note** (its live-dependency list shrinks to `email → crm`);
`test/feature-toggle-dependencies.test.ts` re-pins the remaining edge. No
`recommends` softening either — the builder UI (D4) communicates the
relationship contextually instead.

### D3 — Re-home: category + nav group `Author`

`toggleDefault.category: 'CRM' → 'Author'` and nav `group: 'CRM' → 'Author'`
(`routes.tsx:14`) — Forms sits with Workflows, Projects, and Documents as a
thing you *author*. The `Author` nav group already exists in `GROUP_ORDER`
(no new group machinery); the toggle console groups by raw category string,
so `'Author'` simply starts that console section (precedent: `Documents`,
`Canvases`). Toggle description and nav hint rewritten (D5).

### D4 — CRM-aware builder UI, not CRM-presuming

`FormsPage` shows the `createToContact` control **only when the tenant's
`crm` toggle is enabled** (`useFeatureAccess('crm')`); when CRM is off the
control is hidden and existing `createToContact: true` forms show a passive
notice ("CRM is disabled — submissions are kept, contacts are not created").
The submissions "contact" chip renders only when `contactId` is present
(already true). No CRM client code is imported — this is a feature-access
check, not a CRM composition.

### D5 — Copy: Forms described as itself, in all four locales

Rewrite in `features/forms/i18n/{en,es,fr,pt-BR}.ts`, nav catalogs, and the
toggle description: lede → "Build forms and collect submissions — publish
anywhere, route anywhere." (CRM appears only on the opt-in control copy);
nav hint → "Form builder + submissions"; toggle description → "Form builder +
submission inbox — compose CRM, pages, and funnels optionally." The i18n
parity gate makes all four locales move in one commit.

### D6 — Packs

- `feature.forms.agents` **1.0.0 → 1.1.0**: prompt no longer presumes CRM —
  reports "submissions with a linked contact (`contactId`)" as one signal
  among the aggregate insights; persona description drops "or contacts".
- `feature.forms.nodes` **1.1.0 → 1.1.1**: fix the stale "ADR 0246" citations
  (`pack.json:4,32`, `index.mjs:43`) → ADR 0247. No behavior change.
- Bump `requiredPacks` in `feature.ts` accordingly; re-sign + publish both via
  the registry pipeline.

### D7 — Seeder honesty

`demoContentMarketingSeed.ts` keeps the Wholesale `createToContact: true`
form (it now *demonstrates the optional integration*), and its comment states
the sink semantics: contacts appear only when the demo tenant has `crm`
enabled (which `demoProvision.ts` does enable — unchanged demo outcome).

## What does NOT change (compatibility contract)

- **Public API**: `GET /public-forms/:formId` + `POST …/submit` request/
  response shapes untouched (embedded consumers unaffected).
- **Data**: existing `forms:def` / `forms:submission` rows untouched;
  `contactId` pointers stay valid; no migration (KV-backed, no schema bump).
- **Toggle id** `forms`, bucket `tenant`, default OFF — stable. Stored
  per-tenant overrides keep working (category is display-only).
- **Deep links** `/forms?org=&form=` unchanged.
- **The intake bridge** (ADR 0247 event + chain pack) unchanged.
- `ctx.features.forms` surface + node semantics unchanged (D6 is doc-only).

## Phases

| Phase | Scope | Gate |
|---|---|---|
| 1 | Backend: `submissionSinks.ts` seam; `formsService` drops the `../crm` import; CRM registers the sink (toggle-checked, fail-soft); `dependsOn` removed; toggle category/description; seeder comment | backend vitest — `forms-route.test.ts` re-pins BOTH paths (crm-on → `contactId`; crm-off → row persists, no error), `feature-toggle-dependencies.test.ts` drops the edge; `npm run ci` |
| 2 | Frontend: nav group → `Author`; D4 CRM-aware builder; D5 copy ×4 locales | `( cd frontend/react && npm run build )` (i18n parity FATAL) + frontend vitest |
| 3 | Packs: agents 1.1.0 (prompt), nodes 1.1.1 (citation), `requiredPacks` bump, sign + publish | pack-manifest validation; registry publish flow |
| 4 | Docs: correction notes in ADR 0017 (submit→contact is now sink-inverted; open question resolved) + ADR 0194 (dep list); FEATURES.md row + dependsOn prose; ROADMAP row | docs lockstep review |

## Alternatives considered

1. **Keep the import, guard it on the `crm` toggle.** Smallest diff; rejected
   — it preserves the forms→crm dependency direction, so Forms still cannot
   claim independence at the module graph, and the disable-lock question
   returns with every new destination (email? webhooks?). The sink seam pays
   for itself the second destination.
2. **Events-only (drop the synchronous contact write).** Purest decoupling;
   rejected for v1 — `contactId` lands asynchronously (or never) and the
   submissions UI, agent prompt, and existing tests lose their at-capture
   linkage semantics. Kept as the pattern for future *async* destinations.
3. **Soften `dependsOn` to `recommends`.** The `recommends` lane is declared
   "reserved for a later phase" (`features/types.ts:70`) and advisory-only;
   activating a half-built lane for one edge is more machinery than removing
   the edge. Revisit if a real advisory-dep consumer appears.
4. **A generic host-level integration bus** (all features publish/subscribe
   typed sinks). Overreach for one seam; the forms-owned registry is the
   ADR 0308 `registerFeatureAgentTool` shape, proven and local. Generalize
   only when a third feature needs the same seam.
5. **New nav group "Forms".** A one-item group plus GROUP_ORDER/label/i18n
   machinery; `Author` conveys the same independence without the ceremony.

## RFC verdict

**Host-extension only — no RFC.** No wire surface changes: routes stay under
`/v1/host/openwop-app/*`, no capability advertisement changes, no run-event
shape changes (the `host.forms.submission.created` event is host-internal,
pre-existing, and unchanged).

## Open questions

- [ ] Should the sink result support multiple sinks contributing markers
      (array) vs. the current single `contactId` slot? v1: single slot, first
      marker-returning sink wins (ADR 0332's attribution sink returns
      undefined, so the two known sinks don't contend); revisit with a second
      marker-writing sink.
- [ ] Does the email feature (ADR 0019) want a sink (subscribe-on-submit)?
      Out of scope here; the seam makes it a follow-on.
- [ ] `Submission.contactId` naming becomes destination-specific residue once
      multiple sinks exist — consider `links: Record<string,string>` in a
      future shape (additive; do not migrate v1 rows).

## Addendum (2026-07-10) — retention, cap, and pagination (grade-pass GC-FRM-7 / FORMS-1 / FORMS-3)

Submissions were append-only with no ceiling on a PUBLIC anonymous write
surface. Decisions (architect-adjudicated):

- **Hard cap, refuse-at-cap:** `MAX_SUBMISSIONS_PER_FORM = 50,000`; a submit
  past the cap returns **429**. Rationale: the cap is a **DoS/abuse ceiling,
  not a business quota** — a capture primitive must never *silently drop* a
  lead (drop-oldest lies to the operator; silent-accept-and-discard lies to
  the submitter). Legitimate volume near this scale needs export/retention
  tooling, which remains a product follow-on.
- **Counter row, not a scan:** the cap reads a per-form `forms:subcount`
  point-lookup row, CAS-bumped best-effort alongside `recordSubmission` —
  counting rows per submit would reintroduce the O(rows) hot-path scan class
  FORMS-2 removed. Bounded drift under concurrent writers is accepted (the
  ceiling is approximate by design).
- **Pagination:** the admin submissions list gains `?limit=&before=` (the
  chat-messages `createdAt~id` cursor pattern); the unpaged read remains for
  back-compat. The server-side tenant-slice read stays O(tenant rows) —
  acceptable under the cap; a created-at index is the recorded next step if
  a real inbox outgrows it.
- **No time-based retention yet:** a TTL/retention sweep is a product policy
  (legal-hold, CRM sync timing) — deliberately NOT decided here. The cap
  bounds worst-case storage until that policy exists.
