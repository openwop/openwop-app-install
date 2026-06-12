# ADR 0017 — Forms (public form builder + submission → CRM contact)

**Status:** implemented (Phases 1–3 + the core-app extension surface)
**Date:** 2026-06-10 (backend + frontend implemented 2026-06-11)
**Depends on:** ADR 0001 (feature-package architecture), ADR 0004 (Orgs),
ADR 0006 (RBAC scopes), ADR 0008 (CRM — the contact rolodex this feeds),
ADR 0012/0013 (the public-surface pattern this reuses)
**Toggle:** `forms` · **Surfaces:** authed `/v1/host/sample/forms/orgs/:orgId/*`
+ **public (unauthed)** `/v1/host/sample/public-forms/:formId[/submit]`
(host-extension, NON-NORMATIVE — no RFC)
**MyndHyve §:** Forms · **Baseline:** `functions/src/formApi.ts` (live submission
API) + the orphaned builder under `src/canvas-types/campaign-studio/forms`
(`FormStepManager` / `EnhancedFormBuilder`, `ConditionalLogicEngine`,
`ValidationEngine`) + `src/core/entities/components/forms`

---

## Context (boundaries audit first)

The next feature in the **Growth & Engagement** batch (FEATURES.md § "Future
features", ROADMAP.md). With the public surface now live (Publishing 0012,
Sharing 0013) on top of CRM (0008), Forms closes the **capture** half of the loop:
a public form a visitor fills in, whose submission becomes a CRM contact.

**Pre-existing-surface audit (the mandatory boundaries check):**

- **Namespace `forms` is free.** `grep -rn` for `forms`/`/form` across
  `backend/typescript/src` hits only unrelated code (`envelopeAcceptor.ts`,
  `cronSchedule.ts`, `textRedaction.ts`) — no module registers a
  `/v1/host/sample/forms` route. No collision; this is genuinely new.
- **The contact rolodex already exists and MUST own contact creation.**
  `src/features/crm/contactsService.ts` exports `createContact({ tenantId, name,
  email?, company? })` (the tenant-scoped rolodex, ADR 0008). The CRM **import**
  path already routes through it (`crm/orgRoutes.ts:522`). Forms creates contacts
  **through that same service function**, never a direct `crm:contact` store
  write. This is the deliberate correction of MyndHyve's flagged wart — its
  `formApi` Cloud Function "writes directly into the CRM contacts collection,"
  coupling the public form surface to CRM's storage shape (MyndHyve § "Feature
  Dependencies" → *Surprising / risky*). We take the **capability** as baseline
  and fix the **shape**.
- **The public-surface plumbing already exists.** `PUBLIC_PATH_PREFIXES`
  (`middleware/auth.ts:81`) + `publicBaseUrl` / `authorizeOrgScope`
  (`features/featureRoute.ts`) are exactly what 0012/0013 used; Forms reuses them
  rather than inventing a second public-route mechanism.
- **Feature→feature composition is an accepted pattern.** Sharing (0013) composes
  `cmsService` / `kbService` through their exported service APIs. Forms→CRM
  mirrors that: it imports `createContact`, it does not reach into CRM's store.

What is **new** (the whole build): the form-definition store, the form-submission
store (append-only), the authed org-scoped builder/CRUD surface, and the public
unauthed render + submit endpoint with its abuse controls.

## Decision

A `forms` feature-package (toggle `forms`, default **OFF**, `bucketUnit:
tenant` — a shared B2B surface, consistent with CRM/CMS) with **two faces**:

1. **An authed, org-scoped, RBAC-native management surface** under
   `/v1/host/sample/forms/orgs/:orgId/*` — build/publish forms, read submissions.
   Gated by the media-style `authorizeOrgScope` (`getOrg` + effective access):
   **read → `workspace:read`, write → `workspace:write`**; a non-member fails
   closed (403); an org outside the caller's tenant 404s.

2. **A public, unauthenticated render + submit surface** under
   `/v1/host/sample/public-forms/:formId` — gated on **(a)** the form existing
   and being `published`, and **(b)** the form-tenant's `forms` toggle being on.
   Tenant is derived **from the stored form**, never the request. A submission is
   persisted first, then **best-effort** creates a CRM contact via `createContact`.

### Public-by-intent ≠ capability link (the security model, stated explicitly)

Unlike Sharing (0013), where the token IS the credential guarding a **private**
draft, a form is **public by intent** — its URL is meant to be embedded widely.
So the security property is **"published-only + toggle-on"**, not
"unguessable." `formId` is the public key (a `randomUUID()` — 122 bits, so not
trivially enumerable, but enumeration-resistance is *not* the guarantee). The
guarantee is: an unpublished form, or one whose tenant has `forms` off, **404s
uniformly** on the public surface (no draft-existence leak).

### The model

```
FormDef    { formId, tenantId, orgId, title, status('draft'|'published'),
             fields: FormField[], createToContact: boolean,
             submitMessage?, honeypotField?, createdBy, createdAt, updatedAt }
FormField  { key, label, type('text'|'email'|'textarea'|'select'|'checkbox'),
             required: boolean, options?: string[] }   // select only
Submission { submissionId, tenantId, orgId, formId, values: Record<string,
             string|number|boolean>, contactId?, error?,
             meta: { ip?, referrer?, utm?: Record<string,string> },
             createdAt }   // APPEND-ONLY (a durable record of what the visitor sent)
```

`createToContact` (per-form) decides whether a submission also creates a rolodex
contact; the form must expose a field typed `email` (and conventionally `name`)
for the mapping. **A form belongs to an org; the contact it creates lands in the
org's tenant** — `createContact({ tenantId, … })` is tenant-scoped, and an org
belongs to one tenant (`getOrg` resolves it), so the composition is clean.

### Phase 1 — form store + authed org-scoped builder/CRUD (backend, RBAC)

`formsService` + `DurableCollection<FormDef>('forms:def')`, org-scoped + tenant/org
IDOR-guarded. Routes under `/v1/host/sample/forms/orgs/:orgId/forms`:
- `POST` (`workspace:write`) — create a `draft` form (title + fields).
- `GET` / `GET …/:formId` (`workspace:read`) — list / read the org's forms.
- `PATCH …/:formId` (`workspace:write`) — edit fields / `submitMessage` /
  `createToContact`; `PATCH …/:formId/status` to publish/unpublish.
- `DELETE …/:formId` (`workspace:write`) — tenant+org-guarded.

Route harness test (createApp + listen + cookie jar): RBAC gating, cross-org IDOR,
toggle-off 404.

### Phase 2 — public render + submit + best-effort contact (backend, unauthed)

Add `'/v1/host/sample/public-forms'` to `PUBLIC_PATH_PREFIXES` (distinct from the
authed `…/forms/*` — `public-forms` ≠ `forms`, verified non-shadowing). Routes
(no auth; tenant from the stored form; gated on the form-tenant's `forms` toggle;
uniform 404 on missing / unpublished / feature-off):
- `GET /v1/host/sample/public-forms/:formId` → the published render schema
  (title, fields, `submitMessage`) — **never** the honeypot field name or owner
  metadata.
- `POST /v1/host/sample/public-forms/:formId/submit` `{ values }`:
  1. **Abuse controls** — reuse the host per-IP rate-limit middleware; reject if
     the **honeypot** field is non-empty (silent 200, no row); enforce per-field
     max length + max field count + a total-payload cap; validate required fields
     + `email` shape.
  2. **Persist the submission FIRST** (`forms:submission`, append-only) — the
     lead is captured even if the next step fails.
  3. **Best-effort contact** — if `createToContact`, call `createContact({
     tenantId, name, email, company })`; on success record `contactId`, on failure
     record `error` and keep the submission (the **primary capture never fails on a
     secondary CRM hiccup**).
- `GET /v1/host/sample/forms/orgs/:orgId/forms/:formId/submissions`
  (`workspace:read`) — the authed owner reads its submissions.

Tests: unauthed submit creates a contact **via `contactsService`** (asserted
through the CRM read path, not a store poke), honeypot drops silently, toggle-off
404, unpublished 404, oversized payload rejected.

### Phase 3 — frontend

`FormsPage` (FrontendFeature, nav-gated on `useFeatureAccess('forms')`): an org
picker → a **form builder** (add/label/type/required fields, set
`createToContact`, publish/unpublish) → the **copyable public form URL**
(`publicBaseUrl` + `/public-forms/:formId`) → a **submissions** table.
`formsClient.ts`. The canonical `npm run build` gate must pass.

> **Public consumption is API-first in v1** (GET schema + POST submit — embed
> anywhere). A **host-rendered public HTML form page** is deferred: it needs the
> same section→HTML renderer that ADR 0012 also deferred.

## Core-app extension surface (node packs, agent packs, API)

Per **ADR 0014** (feature workflow surfaces), a feature is not only its REST + UI
faces — it must also **extend the core app's automation surface** so workflows,
agents, and the protocol layer can use it. The feature is not "done" when its page
ships; the surface below is a committed phase (after the REST + UI phases), gated by
the **same `forms` toggle** (all faces flip together), with signed `feature.forms.*`
packs published to `packs.openwop.dev` (decoupled from toggle state for replay).

- **Node pack `feature.forms.nodes`** —
  `feature.forms.nodes.submission-trigger` (a sensor node firing a workflow on a new
  submission — lead-intake automation), `…read-submissions` (pull submissions into a
  run), `…create` (seed/define a form from a run).
- **Agent pack `feature.forms.agents`** — `feature.forms.agents.builder` (drafts a
  form schema — fields + validation — from a natural-language brief).
- **`ctx.forms` workflow surface** — typed `listForms` / `getSubmissions` /
  `createSubmission`, behind the same toggle + RBAC, advertised at `/.well-known/openwop`.
- **Envelope type** — `forms.create` (an AI-drafted form schema routed to
  `formsService`, mirroring the CRM envelope pattern).
- **API endpoints** — the authed CRUD + public submit routes above, additionally
  reachable over the MCP/A2A transports via the well-known advertisement.

## Architectural constraints honored

- **Single source of truth (the headline fix):** contact creation goes through
  `crm/contactsService.createContact`, never a direct store write — Forms owns
  form-defs + submissions only; CRM owns contacts. Mirrors the existing CRM
  import path and Sharing's compose-via-service pattern. No duplicated contact
  model, no coupling to CRM storage shape.
- **Feature-package boundary (ADR 0001):** self-contained `src/features/forms/`,
  wired by appending to `BACKEND_FEATURES` / `FRONTEND_FEATURES`. The one
  justified core edit is the `PUBLIC_PATH_PREFIXES` allowlist entry — the same
  single edit 0012/0013 made.
- **RBAC-native management (ADR 0006):** every authed route gates on the caller's
  `workspace:read`/`workspace:write` in the path org; fail-closed.
- **Tenant + org isolation (CTI-1):** every by-id read/write verifies tenantId AND
  orgId; the public surface derives tenant from the stored form, never the request.
- **Capture-surface failure ordering:** submission persists before the contact
  write; a CRM failure degrades to `error` on the kept submission — no lost lead.
- **Abuse-resistant without a dep:** honeypot + per-IP rate-limit + payload caps;
  no CAPTCHA/third-party dep (zero-runtime-dep host).
- **No wire surface → no RFC:** entirely under `/v1/host/sample/*` (non-normative).

## Alternatives considered

1. **Direct contacts-collection write (MyndHyve's `formApi` shape).** Rejected —
   it is the exact coupling MyndHyve flags as risky; routing through
   `createContact` keeps CRM the single owner of contacts.
2. **Forms as a CMS section type** (fold a form into a CMS page). Rejected as the
   *owner* — a form is its own entity with append-only submissions + a public POST
   and abuse controls; a CMS "form section" that *references* a `formId` is a clean
   **follow-on** once both exist (compose, don't fold).
3. **An unguessable capability token per form (Sharing-style).** Rejected as the
   security model — forms are public-by-intent (the URL is embedded widely), so
   the property is "published-only + toggle-on," not "the token is the credential."
   Adopting capability semantics would fight the use case.
4. **Synchronous CAPTCHA / third-party anti-spam at submit.** Rejected for v1 —
   zero-runtime-dep host; honeypot + rate-limit + payload caps are the floor, with
   a pluggable anti-spam hook as a follow-on.
5. **Dedupe contacts by email at submit.** Deferred — `contactsService` has no
   email index, so dedupe means a tenant-wide `list()` scan; v1 accepts duplicate
   contacts (CRM's merge/dedup tooling — MyndHyve "Partial" — is the eventual home).
6. **Multi-step + conditional-logic forms now** (MyndHyve's orphaned builder).
   Deferred — v1 ships single-step + required/type validation; the
   `ConditionalLogicEngine`/`ValidationEngine` port lands when the builder matures.

## Open questions

- [ ] **Gate `createToContact` on the CRM toggle?** Today the rolodex store exists
  regardless of the `crm` toggle, so a form can capture a contact into a
  CRM-toggled-off tenant (recoverable when CRM is enabled). Decide whether to
  best-effort always (current plan) or skip the contact write when `crm` is off.
- [ ] **Dedupe-by-email** (alt. 5) — needs a contacts email index/lookup on
  `contactsService`; until then duplicates accrue.
- [ ] **File-upload fields** (MyndHyve "Partial") — a field whose value is a Media
  token (composes ADR 0007); deferred.
- [ ] **Host-rendered public form page** — needs the section→HTML renderer also
  deferred in 0012.
- [x] **A `ctx.features.forms` workflow surface (ADR 0014)** — **Done 2026-06-11**
  (read-only: listForms / getSubmissions; + `feature.forms.{nodes,agents}`).
- [ ] **Multi-step + conditional logic** (alt. 6) — port the orphaned MyndHyve
  builder engines when single-step is proven.
- [ ] **Submit idempotency** — the public `POST …/submit` takes no idempotency
  key, so a client/network retry duplicates BOTH the submission and the CRM
  contact. Acceptable at the sample tier; an `Idempotency-Key` (or a
  dedupe-by-email window) is the fix when a consumer needs at-most-once capture.

## Implementation record

| Aspect | Evidence |
|---|---|
| Backend service | `src/features/forms/formsService.ts` — FormDef + Submission (append-only), CRUD, value validation, honeypot, `recordSubmission` → best-effort `createContact` (through `crmService`, not a direct write) |
| Routes | `src/features/forms/routes.ts` — authed org-scoped CRUD (`authorizeOrgScope`, read/write) + PUBLIC render/submit; one core edit: `public-forms` added to `PUBLIC_PATH_PREFIXES` (`middleware/auth.ts`) |
| Extension surface (ADR 0014) | `src/features/forms/surface.ts` (`ctx.features.forms`, read-only) + `packs/feature.forms.nodes/` (list-forms / list-submissions) + `packs/feature.forms.agents/` (lead-insights, read-only) |
| Registration | appended to `BACKEND_FEATURES` (`src/features/index.ts`); toggle `forms` (off, tenant) |
| Tests | `test/forms-route.test.ts` — 7/7 (RBAC CRUD, public published-only render, submit→contact `contactId`, honeypot drop + required validation, cross-tenant IDOR, toggle-off 404) |
| Verify | `tsc --noEmit` clean; full suite green apart from the known pre-existing pack/env failures (none forms-related) |
| Frontend (Phase 3) | `frontend/react/src/features/forms/` — `FormsPage` (org picker → field builder → publish → copyable public URL → submissions) + `formsClient.ts` + `routes.tsx`; appended to `FRONTEND_FEATURES`. `npm run build` gate green (tsc + token/CSS-integrity + vite) |
