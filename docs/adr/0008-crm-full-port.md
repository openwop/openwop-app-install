# ADR 0008 — CRM (full port)

**Status:** Accepted (Phases 1–4 sequenced)
**Date:** 2026-06-09
**Depends on:** ADR 0004 (Organizations), ADR 0006 (RBAC scopes)
**Extends:** the existing `crm` feature (contacts + triage + A/B variants) — does
NOT replace it.
**Surface:** `/v1/host/sample/crm/*` (host-extension, NON-NORMATIVE — no RFC).

---

## Context (boundaries audit first)

The `crm` feature already ships (ADR 0001 §4): tenant-scoped **contacts**, a
contact **triage** run, and a 50/50 `basic`/`enriched` node-variant A/B with a
replay-safe `run.metadata.featureVariant` stamp. `test/crm-feature.test.ts` pins
all of it — the Contact model, the `crm:contact` store key, the route paths, the
variant keys/bindings, the `feature.crm.nodes@1.0.0` pack, and the stamp shape.
**That contract is immutable here.** The full port GROWS the surface around it.

The roadmap wants CRM "now sitting on formal Orgs + RBAC instead of bare tenant
scoping," entities beyond contacts (Companies, Deals, Tasks, Activities),
pipelines, custom fields, and CSV/JSON import — explicitly DEFERRING lead
scoring, sequences, e-commerce-coupled entities, and the email event-bridge, and
explicitly NOT inheriting MyndHyve's "CRM hard-depends on E-Commerce types."

The load-bearing tension: **existing contacts are tenant-scoped with no org/RBAC,
and retrofitting org-RBAC onto them would break the pinned contract.** Resolving
it cleanly is the whole design.

## Decision

**Two coherent layers, not one migrated blob:**

1. **Contacts stay the tenant-wide rolodex (preserved, untouched).** Their model,
   routes, triage, and variant stamp are unchanged — the existing contract holds.
   Contacts are a tenant-wide address book, exactly as today.

2. **Companies / Deals / Tasks / Activities are NEW org-scoped, RBAC-native
   business objects** under `/v1/host/sample/crm/orgs/:orgId/*`, gated by the
   **media-style `authorize()`** (`getOrg` + `resolveEffectiveAccess(tenant,
   { subject, orgId })`): **read → `workspace:read`, write → `workspace:write`**;
   a non-member fails closed (403); an org outside the caller's tenant 404s.

This is the roadmap's "formal Orgs + RBAC" — delivered on the NEW surface where
it's clean, without breaking the legacy tenant surface. The two compose by id
within a tenant: a Deal may reference a tenant `contactId` (the rolodex) and an
org `companyId` (this org's book of business). The toggle stays `crm`,
`bucketUnit: 'tenant'` (a shared B2B surface, per the roadmap), so the existing
variant A/B keeps working unchanged.

### The entities (all org-scoped, tenant+org IDOR-guarded)

```
Company  { companyId, tenantId, orgId, name, domain?, industry?, tags[],
           customFields, createdBy, createdAt, updatedAt }
Deal     { dealId, tenantId, orgId, title, pipelineId, stageId, amount?,
           currency?, companyId?, contactId?, customFields, createdBy, ... }
Task     { taskId, tenantId, orgId, title, status('open'|'doing'|'done'),
           dueDate?, assignee?, dealId?, contactId?, companyId?, ... }
Activity { activityId, tenantId, orgId, kind('note'|'call'|'email'|'meeting'),
           body, dealId?, contactId?, companyId?, createdBy, createdAt }   // append-only log
Pipeline { pipelineId, tenantId, orgId, name, stages: { stageId, name,
           probability }[] }   // custom stages + probability (org-scoped)
```

`customFields` is a `Record<string, string|number|boolean>` validated against
per-(org, entity) **field definitions** (Phase 3) — the port's "custom fields per
entity" without a schema migration. A profile/RFC-0087-style invariant holds:
no CRM field confers authority.

### Phase 1 — Companies + Deals + Pipelines (org-scoped, RBAC)

`crmEntitiesService` + org-scoped `DurableCollection`s (`crm:company`,
`crm:deal`, `crm:pipeline`). Routes under `/crm/orgs/:orgId`: companies + deals
CRUD (RBAC-gated), and pipeline CRUD with custom stages + probability. A deal
sits on a `(pipelineId, stageId)`; a default pipeline is seeded lazily per org.
Deleting a pipeline is refused while deals reference it (fail-closed). Route
harness tests.

### Phase 2 — Tasks + Activities

`crm:task` + `crm:activity` stores, org-scoped + RBAC-gated, each optionally
linked to a deal/contact/company in the same org/tenant. Tasks have a status +
due date; Activities are an **append-only** timeline (no edit/delete of history,
only create + list). Tests.

### Phase 3 — Custom fields + CSV/JSON import

Per-(org, entityType) **field definitions** (`crm:fielddef`: key, label, type
`string|number|boolean`, required?). Entity writes validate `customFields`
against the active defs (unknown keys rejected; required enforced; types
coerced/validated). **Import**: `POST /crm/orgs/:orgId/import` accepts JSON
`rows` + a `mapping` (column→field) + a `dedupeBy` key for companies / deals /
contacts-into-this-org; returns `{ created, skipped, errors[] }`. (CSV is parsed
client-side into `rows`; raw-CSV server parsing is a thin future add.) Tests.

### Phase 4 — Frontend

Extend `CrmPage` into a tabbed surface (gated on `useFeatureAccess('crm')`):
**Contacts** (the existing tenant rolodex, unchanged) + an **org picker** driving
**Companies**, a **Deals pipeline** (board by stage), and **Tasks**. New client
methods for the org-scoped surface. The canonical `npm run build` gate must pass.

## Architectural constraints honored

- **Preserve the pinned contract:** contacts/triage/variant/pack are untouched;
  `crm-feature.test.ts` keeps passing. The port is purely additive.
- **RBAC-native new surface (ADR 0006):** every org-scoped route gates on the
  caller's `workspace:read`/`workspace:write` in the path org; fail-closed.
- **Single source of truth / boundaries:** orgs/roles stay in `accessControl`;
  CRM owns only its business objects. No parallel org/permission model. Reuses
  the shared `featureRoute` + `authorize` patterns from media.
- **Tenant + org isolation (CTI-1):** every entity read/write verifies tenantId
  AND orgId; cross-tenant/cross-org access reads as `not_found`/`forbidden`.
- **No e-commerce coupling:** CRM entities are self-contained (the explicit
  roadmap cut) — a Deal has an `amount`/`currency` scalar, not a commerce typeref.
- **No wire surface → no RFC:** entirely under `/v1/host/sample/*`.

## Alternatives considered

1. **Migrate contacts to org-scoped + retrofit RBAC.** Rejected — breaks the
   pinned contract (the model, routes, and tests) and needs a data migration for
   existing tenant contacts. The two-layer split delivers "formal Orgs + RBAC" on
   the new surface without the breakage; promoting contacts into orgs is a future
   migration ADR if a consumer needs it.
2. **One generic `entity` store with a `type` discriminator.** Rejected — deals
   (pipeline/stage/amount) and activities (append-only) have genuinely different
   shapes + invariants; per-entity services keep each honest. The shared part
   (the `authorize` gate, tenant/org guard) is already factored.
3. **Inherit the MyndHyve CRM⇄E-Commerce coupling.** Rejected per the roadmap —
   the surprising hard-dep is cut; CRM ships standalone.
4. **A new `crm-pro` toggle for the org surface.** Rejected — it's the same
   product feature; one `crm` toggle gates the whole surface (the new routes are
   simply RBAC-gated on top).

## Open questions

- [ ] **Promoting contacts into orgs.** If the rolodex should become org-scoped,
  that's a migration ADR (data + the pinned contract). Deferred.
- [ ] **Pipeline-stage rename/reorder semantics** vs in-flight deals — start with
  add/rename stages; reordering + stage deletion-with-reassignment if a consumer
  needs it.
- [ ] **Import scale / async.** Synchronous row import is fine at the sample
  tier; a large import would want a background run + progress (defer).
- [ ] **Custom-field type expansion** (date, enum, reference) — start with
  string/number/boolean; widen when a consumer pulls.
