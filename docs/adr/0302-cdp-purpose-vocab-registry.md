# ADR 0302 — CDP purpose-vocabulary registry (advisory, opaque-wire-unchanged)

**Status:** Accepted
**Date:** 2026-07-06
**Depends on:** RFC **0128** R3 (purpose-propagation — `permittedPurposes` as OPAQUE strings, Draft), ADR 0262 (CDP program + rulings), ADR 0268 (CDP-F purpose/consent — the sibling purpose→category gate), ADR 0269 (RFC 0128 propagation advert precedent), `features/cdp/purposeLabels.ts` (the untouched R3 label algebra), `features/consent/consentService.ts` (the capture path)
**Part of:** CDP program (ADR 0262). Privacy/consent track.

## Why this exists

RFC 0128 §R3 deliberately keeps `permittedPurposes` as **opaque strings** on the wire — it
does NOT freeze an enum, so hosts and peers can carry any local purpose taxonomy and the
never-widen label algebra (`purposeLabels.ts`) operates on them structurally, without ever
knowing what a code "means." That opacity is a feature: it is what lets the propagation seam
be conformance-tested purely.

But opacity has a local cost: nothing stops a typo or a fresh, un-reviewed purpose code from
being introduced at **consent capture** and quietly spreading. Operators want to catch that
drift — a *host-local* concern — WITHOUT reneging on the wire's opaque-string promise. This
ADR records an **advisory, host-local purpose-vocabulary registry** that catches drift at
capture while leaving the wire exactly as RFC 0128 specifies it.

## The RFC 0128 opaque-string contract is UNCHANGED (no RFC needed)

This is host-extension work, not a wire change, so it needs **no new RFC**:

- `purposeLabels.ts` (`normalizeLabel`, `intersectLabels`, `isNonWidening`, `reEmitLabel`,
  `isNoOnwardUse`) is **byte-for-byte untouched**. Purposes remain opaque `string[]`; the
  algebra never consults the registry.
- The purpose-propagation egress seam (`routes/purposePropagationSeam.ts`) is untouched and
  still fails **open** — every already-stored opaque label normalizes + re-emits verbatim,
  including codes that appear in NO tenant's vocabulary. A test pins this ("wire is
  UNCHANGED").
- No capability advert changes; `permittedPurposes` does not become an enum on any surface.
- The registry NEVER rejects a stored/retro label. The **only** fail-closed path is at
  consent capture, and only under an explicit per-tenant opt-in (`strictPurposes`).

An operator turning strict mode on is making a *local admission* choice about what it will
accept into its own store — not advertising a narrower wire contract.

## Decision

Add one host-ext service + a small management surface.

### 1. Single owner — `features/cdp/purposeVocabService.ts`

The ONE owner of the tenant purpose vocabulary and the `strictPurposes` flag. Tenant-scoped
`DurableCollection<TenantPurposeVocab>` (`cdp:purpose-vocab`, keyed + tenant-indexed by
`tenantId`). Storage is a **delta over a host-default seed** (`analytics`, `billing`,
`marketing`, `personalization`, `support`) — `{ added[], removed[], strict }` — so a change
to the host seed propagates to every tenant that did not explicitly disable a code, and a
tenant can both add custom codes and disable seed codes it does not use. Codes are opaque
(trimmed, non-empty, **case-preserving** — never case-folded). CRUD: `listPurposeVocab`,
`addPurposeCode`, `removePurposeCode`, `isStrictPurposes`, `setStrictPurposes`.

### 2. Validators (the ONLY callers — no drifting second copy)

- `validatePurposes(tenantId, purposes) → { known, unknown }` — a pure advisory splitter
  that **never throws / never mutates**. This is the fail-open primitive consent-capture and
  (advisorily) label normalization call.
- `assertPurposesAtCapture(tenantId, purposes)` — runs `validatePurposes`, then throws
  `validation_error` (400) **only** when `strictPurposes` is on AND a code is unknown.
  Otherwise returns the split so the caller can surface a non-fatal warning.

`consentService.recordConsent` gains an optional `purposes?: readonly string[]`. When
present it runs `assertPurposesAtCapture` (fail-closed only in strict) and stores the codes
verbatim (additive `ConsentRecord.purposes`; old records simply lack it — backward
compatible, same pattern as ADR 0227/0268 fields). The stored codes are never re-validated
on read/egress.

> **Feature-boundary note (ADR 0001):** `consentService` imports the cdp registry
> (`consent → cdp`). `purposeVocabService` imports only `host/` + `types` — it never imports
> back into consent — so there is no import cycle. The coupling is deliberate: the registry
> lives with the CDP privacy track (ADR 0268's sibling), and consent is one of its
> validators, mirroring how cdp already composes `consentService` for `isPermittedForPurpose`.

### 3. Management routes (`features/consent/routes.ts`, `consent` toggle-gated, org/tenant-scoped)

Mounted beside the consent authed surface (the natural home for a capture-vocabulary):

- `GET  …/consent/orgs/:orgId/purpose-vocab` → `{ purposes, strict }` (`workspace:read`)
- `POST …/consent/orgs/:orgId/purpose-vocab` `{ code }` → `{ purposes }` (`workspace:write`)
- `DELETE …/consent/orgs/:orgId/purpose-vocab/:code` → `{ purposes }` (`workspace:write`)
- `PUT  …/consent/orgs/:orgId/purpose-vocab/strict` `{ strict }` → `{ strict }` (`workspace:write`)

The public consent capture route accepts optional `purposes[]`; in non-strict mode it returns
any unknowns as an `unknownPurposes` warning; in strict mode the shared capture hook rejects
with 400.

## Alternatives weighed

- **Freeze a wire enum of purposes** — rejected: directly contradicts RFC 0128 R3's opaque
  contract and would need a wire RFC. The whole point is to stay off the wire.
- **Validate in `normalizeLabel` / the egress seam** — rejected: would make the
  conformance-tested algebra tenant-aware and could drop a valid opaque label. Egress must
  stay pure + fail-open.
- **Always fail-closed at capture** — rejected: unknown-but-legitimate purposes are common;
  fail-closed is opt-in per tenant so the default host does not reject honest new codes.

## Consequences

- Drift is catchable at capture without any wire impact; retro data is never invalidated.
- Operators get a per-tenant, self-service vocabulary + a strict switch.
- Trade-off: strict mode can reject a legitimately-new code until an admin adds it — the
  intended behavior (an explicit opt-in for change control).

## Implementation

| Item | Where |
| --- | --- |
| Registry service + validators | `features/cdp/purposeVocabService.ts` |
| Capture hook + stored `purposes` | `features/consent/consentService.ts` (`recordConsent`, `ConsentRecord`) |
| Public capture warning + mgmt routes | `features/consent/routes.ts` |
| Tests | `backend/typescript/test/cdp-purpose-vocab.test.ts` |

## Open decisions checklist

- [x] Wire unchanged — `purposeLabels.ts` untouched, egress fail-open, no advert change, no RFC.
- [x] Single owner = `purposeVocabService`; validators = consent capture (+ advisory labels).
- [x] Fail-closed at capture ONLY under per-tenant `strictPurposes`; default fail-open.
- [x] Retro/stored opaque labels never rejected.
- [x] Tenant-isolated vocabulary + strict flag.
