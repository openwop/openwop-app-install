# ADR 0263 — CDP-A: Customer identity resolution (CRM-owned identifier graph + profile lookup)

**Status:** implemented (Phases 1–3 + P2 anon→known)
**Date:** 2026-07-05
**Depends on:** ADR 0262 (CDP program + boundary rulings), ADR 0008 (CRM), ADR 0209 (deterministic merge + tombstone), ADR 0213 (contact custom fields), ADR 0020 (consent), ADR 0077 (PII classification), ADR 0226 (analytics identity-link — **re-opened** here)
**Part of:** the CDP program (ADR 0262). This is CDP-A, Phase 0.

## Why this exists

A CDP's front door is a **unified customer profile resolvable by any identifier** — email, phone,
loyalty id, device/cookie id, external-system id — with the anonymous→known timeline stitched in.
Today the substrate exists but is thin:

- The customer record is the CRM `Contact` (`crm/contactsService.ts:44`), and the rest of the app
  already treats `contactId` as *the* customer key (commerce Customer = `contactId`, form-submit →
  contact, gmail sender resolution). This is the correct owner — CDP-A extends it, per ADR 0262
  ruling #1 (no second "identity" owner).
- But a `Contact` carries **one optional `email`** and a uuid (`contactsService.ts:48`); there is
  **no identifier set**. Resolution by email is `findContactByEmail` (`contactsService.ts:103-108`)
  — a **linear scan** of the tenant slice (`listContacts(tenantId)` + `.find`). There is no
  by-phone / by-external-id / by-device lookup at all.
- Anonymous→known stitching exists only as `analytics/identityLinkService.ts` (one deterministic
  `session → contactId` row, no device graph, no history), whose header declares a full identity
  graph an explicit **non-goal (ADR 0226)** — a decision this ADR re-opens with cause.

## Decision

Extend the **CRM package** (the customer owner) with a multi-identifier graph and a unified
real-time profile-lookup surface. Add a **thin `cdp` umbrella feature-package** that owns *only*
the cross-source identifier **index** and the admin console — never a second contact store (ADR 0262
ruling #1).

### 1. Identifiers on the customer record (additive)

Add to `Contact` (additive, mirroring how `customFields` landed in ADR 0213 — pre-existing rows
project a default):

```ts
/** External identifiers this contact resolves by. Additive (ADR 0263).
 *  `type` from a closed host vocabulary (email|phone|loyalty|device|cookie|external:<system>);
 *  `value` normalized per type; `source` records the writer; verifiedAt optional. */
identifiers?: { type: string; value: string; source: string; verifiedAt?: string }[];
```

`email` stays as the convenience field (back-compat); on write it is *also* mirrored into
`identifiers` as `{type:'email'}`. PII identifier types (`email`, `phone`) are registered via
`declarePiiFields` so they mask in logs and cascade in `subjectErasure` (ADR 0077).

### 2. By-identifier index

> **§Correction (2026-07-05, at implementation).** The index landed in the **crm**
> package (`crm/contactIdentityService.ts`), not the `cdp` package as first written.
> Rationale: the write path (create/update/merge/tombstone) lives in crm, so a
> cdp-owned index would force a `crm → cdp` write import — an ADR 0001 cross-feature
> smell. Homing the index next to `findContactByEmail` (crm owns the contact AND its
> lookup indexes) is *more* faithful to ADR 0262 ruling #1 ("CRM owns the customer
> identity graph — no second identity authority"). The `cdp` package owns only the
> **resolve endpoint + surface + console** and READS the crm index — the documented
> cross-feature READS pattern (like `campaign-connectors`). Identifier CRUD routes
> also live in crm (`POST/DELETE /crm/contacts/:id/identifiers`). Additionally,
> `findContactByEmail`/`resolveIdentity(email)` carry a **self-healing scan fallback**
> for pre-index (legacy) rows — no separate backfill migration needed.

A `DurableCollection('cdp:contact-ident')` keyed **tenant-scoped**
`${tenantId}::${type}::${normalizedValue}` → `{ contactId }`. This is the CDP package's one owned
store — an index, not a record store. It arms the same tenant secondary-index pattern
`crm:contact` already uses (`contactsService.ts:80` `listForTenantIndexed`). Resolution becomes an
O(1) point lookup, killing the `findContactByEmail` scan (which is refactored to read through the
index, keeping its signature for callers).

**TOCTOU / consistency (ADR 0262 ruling #2 sibling; review finding #5):** every contact
write/merge that changes identifiers updates the index in the same operation, guarded by the
existing `crmMergeService` CAS + post-write re-check. Merge unions both contacts' `identifiers`,
re-points every index key to the survivor, and a mid-merge failure fails **closed** (a stale key
must never resolve to a tombstone — verified by re-check). Covered by a route-level test
(merge + concurrent identifier write through the HTTP boundary).

### 3. Unified profile-lookup surface

`GET /v1/host/openwop-app/cdp/identity/resolve?type=&value=` (non-normative host-ext route,
CRM-authz gated, tenant-isolated) → the golden record: the resolved `Contact` + its `identifiers`
+ linked account (CSM `crmRef`, one hop) + the anonymous→known timeline (composed from
`analytics/identityLinkService`, consent-gated via `isAllowed(...,'analytics')`). Read-through,
composes existing services — **no new store beyond the index**.

### 4. Anonymous→known generalization (re-opens ADR 0226)

> **§Correction (2026-07-05, at implementation).** Rather than *writing* a
> device/cookie edge from analytics into the crm index (an `analytics → crm`
> cross-feature write), the cdp resolver **reads** the existing analytics
> identity-link: `resolveIdentity(type:'cookie')` falls back to
> `identityLinkService.contactForSession` when the index misses. Pure read-compose,
> no new coupling, and it still delivers anon→known resolution (a linked session
> resolves to its known contact). Writing edges into the index is deferred unless a
> non-session device/cookie source appears. This still supersedes ADR 0226's "no
> identity graph" stance — the cdp package is now a consumer of the link for
> unified resolution — but via reads, not a second write path.


Generalize `identityLinkService` from `(tenant, sessionKey) → contactId` to write a
`{type:'device'|'cookie'}` identifier edge into the index (retained, timestamped), so a later login
stitches prior anonymous events under policy. **This supersedes ADR 0226's "no identity graph"
non-goal** — recorded there as an inline correction note (correct-don't-rewrite), citing this ADR.
The consent gate and the erasure seam are preserved unchanged.

## Scope / non-goals

- **No probabilistic/fuzzy match** here — CDP-A is deterministic identifier resolution only.
  Candidate generation + steward merge is CDP-B.
- **No calculated traits / propensity** — CDP-C.
- The `identifiers` type vocabulary is a **closed host list**; adding a type is a host change, not a
  wire change (host-ext). Advertising a portable `customerIdentity` capability would need an RFC and
  is out of scope.

## Phased plan

1. **Backend:** `identifiers[]` on `Contact` + `projectContact` default; `cdp` package with the
   `cdp:contact-ident` index + `resolveByIdentifier`; refactor `findContactByEmail` to read the
   index; merge unions + reindexes (CAS + re-check); `declarePiiFields` for PII types.
2. **Surface:** `GET .../cdp/identity/resolve` + `ctx.features.cdp` read verb; `analytics`
   identity-link writes device/cookie edges; ADR 0226 correction note.
3. **Frontend:** a superadmin-gated `cdp` console tab — resolve-by-identifier lookup + a contact's
   identifier list; append to `FRONTEND_FEATURES`.
4. **Verify:** `npm run build` (FE gates) + backend vitest incl. the merge/reindex concurrency
   route test.

## Open questions

- [ ] `identifiers[]` on `Contact` vs a dedicated CRM-adjacent identifier store — default: on
  `Contact` (additive, simplest). Flip only if the index scan cost at target volumes forces it
  (ADR 0262 falsifiability watch). The index collection is unaffected by this choice.
- [ ] Device/cookie edge retention window — inherit the analytics retention config (ADR 0077) vs a
  CDP-specific one. Default: inherit.
- [ ] Toggle: ships OFF/`tenant`; console superadmin-gated. `cdp` toggle id confirmed collision-free
  (no existing `cdp`/`identity` route or feature id).

## Consequences

The customer becomes resolvable by any identifier in O(1), the anonymous→known timeline stitches
correctly, and every downstream CDP sub-program (segments, sync, journeys, propensity) reads one
golden record — all as a CRM extension plus one index, with no second identity authority. The cost
is re-opening ADR 0226 (with cause) and the merge path now maintaining a second structure (bounded
by the existing CAS discipline). Replay/fork is unaffected — identity resolution is a live read, not
a run-stamped decision.
