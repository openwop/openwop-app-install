# ADR 0020 — Consent & Compliance (region-aware consent + enforcement)

**Status:** implemented (Phases 1–3 + the core-app extension surface)
**Date:** 2026-06-10 (backend implemented 2026-06-11)
**Depends on:** ADR 0001 (feature-package), ADR 0006 (RBAC), ADR 0014 (feature workflow surfaces)
**Gates:** ADR 0018 (Analytics ingest), ADR 0019 (Email marketing sends),
ADR 0017 (Forms, if it captures marketing opt-in)
**Toggle:** `consent` · **Surfaces:** authed `/v1/host/sample/consent/orgs/:orgId/*`
+ **public (unauthed)** `/v1/host/sample/public-consent/:orgId`
(host-extension, NON-NORMATIVE — no RFC)
**MyndHyve §:** Consent & Compliance · **Baseline:**
`src/features/consent/{ConsentManager,ConsentEnforcer}.ts` (region-aware, 3
categories: necessary / analytics / marketing)

---

## Context (boundaries audit first)

The **govern** leg — and the leg with **no value alone**: it exists to gate the
public tracking (Analytics 0018) and marketing sends (Email 0019) that Forms/the
public surface make possible. That is exactly why it is #3 in the batch (authored
alongside, enforced into the other two) rather than a standalone surface.

**Pre-existing-surface audit:**
- **`consent` namespace is free.** No existing consent route.
- **Enforcement must be centralized, not scattered.** The lesson from Sharing
  (0013) — one resolver registry, not per-feature link logic — applies: a single
  `consentService.isAllowed(...)` that Analytics and Email **call**, rather than
  each re-implementing region/category checks. Two copies of a consent rule that
  disagree is a compliance defect.
- **Compliance primitives already exist host-side** — HMAC webhook signing +
  signed-token patterns (used by Sharing/Publishing) are the basis for signed
  unsubscribe / data-subject links when those land.

What is **new**: the consent record store, the public record/read endpoint, and the
in-process enforcement helper the other two features consume.

## Decision

A `consent` feature-package (toggle `consent`, default OFF, `bucketUnit: tenant`)
that stores a visitor's per-category choices and exposes an **enforcement helper**
consumed in-process by Analytics + Email. **Fail-closed**: absent a record in a
regulated region, `analytics` and `marketing` are **denied** (`necessary` always
allowed).

### The model

```
ConsentRecord { tenantId, subjectKey, region?,                  // latest-wins per (tenant, subjectKey)
                categories: { necessary: true, analytics: boolean, marketing: boolean },
                source, ts, expiresAt? }
ConsentPolicy { tenantId, regulatedRegions: string[], defaultMode('opt-in'|'opt-out') }  // optional per-tenant
```

`subjectKey` is an **opaque, non-PII** id (an anon cookie id or `User.userId`);
`DurableCollection<ConsentRecord>('consent:record')` keyed by `(tenantId,
subjectKey)`, latest-wins.

### Phase 1 — consent store + public record/read

- **Public** `POST /v1/host/sample/public-consent/:orgId` `{ subjectKey,
  categories, region? }` — unauthed; tenant from the org; gated on the org-tenant's
  `consent` toggle; upsert latest-wins. `GET .../:orgId/:subjectKey` → current
  choices (or policy default). (Add `/v1/host/sample/public-consent` to
  `PUBLIC_PATH_PREFIXES`.)

### Phase 2 — enforcement helper + wire into 0018/0019

`consentService.isAllowed(tenantId, subjectKey, category): Promise<boolean>` —
latest record → policy default → fail-closed in a regulated region. **Analytics
ingest** calls it for `analytics`; **Email send** calls it for `marketing`
(non-consenting recipients are `skipped` in the send log). When the `consent` toggle
is **off** for a tenant, the helper is permissive (no consent regime configured) —
honest: the feature is opt-in per tenant.

### Phase 3 — frontend + data-subject export

`ConsentPage` (nav-gated on `consent`, RBAC): per-tenant policy (regulated regions,
default mode), a records view, and a **data-subject export/delete** (GDPR) over a
`subjectKey`. `consentClient.ts`. `npm run build` gate.

## Core-app extension surface (node packs, agent packs, API)

Per **ADR 0014** (feature workflow surfaces), a feature is not only its REST + UI
faces — it must also **extend the core app's automation surface**. The surface below
is a committed phase (after the REST + UI phases), gated by the **same `consent`
toggle** (all faces flip together), with signed `feature.consent.*` packs published
to `packs.openwop.dev` (decoupled from toggle state for replay).

- **Node pack `feature.consent.nodes`** — `feature.consent.nodes.check` (gate a
  workflow branch on a subject's consent category — fail-closed in regulated
  regions), `…record` (record consent from a run).
- **Agent pack** — **none in v1** (honest: consent is a policy/enforcement gate, not
  an AI surface; a "compliance-policy" agent is a follow-on only if a consumer pulls).
- **`ctx.consent` workflow surface** — the **same** `isAllowed` / `record` helper that
  Analytics (0018) and Email (0019) consume in-process, additionally exposed to
  workflow nodes (single enforcement path — no second consent rule), advertised at
  `/.well-known/openwop`.
- **Envelope types** — none (no AI artifact).
- **API endpoints** — the public record/read + authed config/export routes above,
  reachable over MCP/A2A via the well-known advertisement.

## Architectural constraints honored

- **Centralized enforcement (the boundary):** one `consentService.isAllowed`;
  Analytics + Email call it — no duplicated region/category logic.
- **Fail-closed in regulated regions:** no record ⇒ deny analytics/marketing.
- **Opaque subject, minimal PII:** `subjectKey` non-PII; the record holds choices +
  coarse region, not identity.
- **Honest opt-in:** toggle off ⇒ no consent regime (permissive); on ⇒ enforced. The
  capability is advertised only when wired.
- **No wire surface → no RFC.**

## Alternatives considered

1. **Bake consent checks into Analytics + Email directly.** Rejected — scatters the
   policy; centralizing in `consentService` (one rule) is the Sharing-registry
   lesson applied to compliance.
2. **Client-only cookie consent.** Rejected — the server must enforce ingest/send
   gating; a client banner can be bypassed.
3. **Full IAB TCF / a third-party CMP.** Rejected for v1 — heavy; the 3-category
   region-aware model is the honest floor, with a CMP integration as a follow-on.
4. **Ship Analytics/Email without consent.** Rejected — that is the compliance gap
   this ADR closes; the three are a batch.

## Open questions

- [ ] **Region detection** — declared vs IP-geo (IP is PII + itself consent-sensitive);
  default to declared/coarse, decide IP policy with ADR 0018.
- [ ] **Consent expiry / re-prompt cadence** (`expiresAt` semantics).
- [ ] **Signed data-subject links** (export/delete) — reuse the host HMAC-token
  primitive when the export UI lands.
- [ ] **Granularity beyond 3 categories** (purpose-level) if a consumer needs it.
- [ ] **Audit trail** of consent changes (append-only history vs latest-wins).
- [x] **Cross-feature erasure** — **Done 2026-06-11.** A data-subject delete now
  cascades beyond the consent record: `deleteSubject` fans out through a neutral
  host-level **subject-erasure seam** (`src/host/subjectErasure.ts`) to every
  feature that registered a purge handler (Analytics purges the subject's events;
  Email will register its send-log when built). Consent stays the foundation — it
  invokes registered handlers, never depends on its consumers. The DELETE route is
  now idempotent (`200 {ok,consentRecord}`, no 404 — erasing a subject with no
  consent record still purges downstream data).

## Implementation record

| Aspect | Evidence |
|---|---|
| Backend service | `src/features/consent/consentService.ts` — ConsentRecord (latest-wins per tenant+subject) + ConsentPolicy; `recordConsent` / `getConsent` / `listConsent` / `setPolicy` / `deleteSubject`, and the centralized **`isAllowed(tenantId, subjectKey, category)`** (necessary always; toggle-off ⇒ permissive; record → policy default → fail-closed) |
| Routes | `src/features/consent/routes.ts` — PUBLIC record/read (`/public-consent/:orgId[/:subjectKey]`, tenant-from-org, toggle-gated, uniform 404) + authed policy / records / data-subject delete (`authorizeOrgScope`); one core edit: `public-consent` added to `PUBLIC_PATH_PREFIXES` |
| Extension surface (ADR 0014) | `src/features/consent/surface.ts` (`ctx.features.consent` — the SAME `isAllowed`/`record` helper) + `packs/feature.consent.nodes/` (check / record). **No agent pack** (honest — a policy gate, not an AI surface) |
| Registration | appended to `BACKEND_FEATURES`; toggle `consent` (off, tenant) |
| Tests | `test/consent-route.test.ts` — 6/6 (public record/read, authed policy+records+data-subject delete, `isAllowed` semantics: necessary/fail-closed/opt-out/toggle-off-permissive, well-known advert, node smoke) |
| Verify | `tsc --noEmit` clean; full suite green apart from the known pre-existing pack/env failures (none consent-related) |
| **Consumers** | the `isAllowed` helper is ready; **Analytics (0018)** + **Email (0019)** call it when built (Phase 2 "wire into 0018/0019" completes with those features) |
| Frontend (Phase 3) | `frontend/react/src/features/consent/` — `ConsentPage` (org picker → policy config + records + data-subject GDPR lookup/erase) + `consentClient.ts` + `routes.tsx`; appended to `FRONTEND_FEATURES`. `npm run build` gate green |
