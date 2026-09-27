# ADR 0268 — CDP-F: Purpose-based consent graph, field masking, label-based record ACL & policy decision log

**Status:** implemented (purpose graph + legal basis + field-masking primitive + resolve-seam enforcement + label-based record ACL + unified decision log)
**Date:** 2026-07-05
**Depends on:** ADR 0262 (CDP program + rulings), ADR 0020/0227 (consent), ADR 0077 (data classification / PII / retention), ADR 0028 (governance), ADR 0006 (RBAC / accessControl), ADR 0135 (capability firewall), the audit store (`storage.appendAudit`)
**Part of:** CDP program (ADR 0262). CDP-F, Phase 2 (+ Phase 4 for the wire contract).

## Why this exists

The market PRD's clearest enterprise differentiator is **privacy-native activation**: purpose as an
executable property of every audience/profile/API/sync, plus field masking and label-based access,
not consent bolted onto egress. openwop-app has a genuinely strong governance backbone —
consent enforced at every marketing egress (A-grade), PII classification + retention sweep + DSR
erasure, RBAC, capability-firewall, immutable audit — but four gaps:

1. **No purpose object** — "purpose" today is only the 4-value `ConsentCategory` enum; **no
   audience/segment/sync/API artifact carries a purpose tag** (verified: zero `purpose` hits in
   `campaign-connectors`, `crm/segmentsService.ts`, `crm/suppressionService.ts`).
2. **Field masking is log-only** — `dataClassification.maskPiiDeep` is wired solely to
   `observability/logger.ts`, never to API responses.
3. **No label→record access gate** — the firewall labels *tools*, classification labels *entities*
   for mask/retention, but nothing gates a *record read* by label.
4. **Policy decisions are heterogeneous** — a `log.info` here, an audit row there, a firewall verdict
   elsewhere; no unified queryable decision log.

## Decision

Extend the existing governance seams — **one consent evaluator, one classification registry, one
audit store** (ADR 0262 ruling #5). No parallel policy engine.

### 1. Purpose graph on `consent` (host side, Phase 2)

Add a first-class `Purpose` vocabulary + `legalBasis` + an append `ConsentEvent` **history** to
`consentService` (additive; the current latest-wins record stays the fast-path view). Stamp
`permittedPurposes[]` on CRM segment / CDP-D destination-sync / audience artifacts. Extend the single
`isAllowed()` chokepoint into `isPermittedForPurpose(subject, purpose, destination)` that the egress
paths already call — **not a second evaluator.**

### 2. Field masking on the data plane (Phase 2)

Reuse the **same `dataClassification` registry** to build a read-serialization masker keyed on
`isPiiField(entity, field)` + the caller's resolved scopes, applied at the CRM/profile read seams
(the natural Phase-4 of ADR 0077). No new taxonomy.

### 3. Label-based record ACL (Phase 2)

Compose the firewall's `scope:` class model with `dataClassification.classificationOf(entity)` to
gate record reads by label (`confidential-pii` ⇒ requires a `pii:read` scope), enforced alongside the
masker via `accessControlService` scope resolution.

### 4. Unified policy decision log (Phase 2)

Route consent denials, firewall verdicts, governance allow/deny, and retention tombstones through one
`governance.decision.*` `appendAudit` namespace (used across the CDP program) so the ADR-0028
governance view becomes a real queryable decision log. Optionally add a per-tenant audit hash-chain
(`prevHash`) for tamper-evidence.

### 5. Purpose-propagation on the wire (Phase 4 — RFC-gated)

Advertising "permitted downstream use" **to a sync/A2A target that must honor it** is a cross-host
promise → a **new OpenWOP RFC** (purpose/permitted-use contract) at Accepted before the claim ships.
The host-side tagging + local enforcement (parts 1–4) lands first without it.

- **Update (Track-2):** the RFC is authored — **RFC 0128 (Purpose-propagation — permitted-use labels)**,
  Draft. Per an `/architect` Track-B ruling it is scoped for conformance-falsifiability: the normative
  `MUST` is the *observable* promise (a host advertising `capabilities.purposePropagation` re-emits —
  MAY narrow, MUST NOT widen — the `permittedPurposes` label on any onward hop), while the internal-use
  restriction stays `SHOULD`/declared-intent (internal use isn't wire-observable, so a `MUST` there would
  be unenforceable). Host advertisement + cross-host propagation stay gated on 0128 reaching Accepted.

## Scope / non-goals

- **Regional residency** (enforced tenancy + a residency capability RFC) is tracked at the program
  level (ADR 0262), not built here — it's partly infrastructural.
- **Native MFA** is a separate `users`-package enhancement, out of scope.
- RBAC protocol-enforcement flip (`OPENWOP_AUTHORIZATION_ENFORCEMENT`) is operational + already
  RFC-0049-covered; noted, not re-decided here.

## Phased plan

1. **Phase 2:** Purpose vocabulary + `legalBasis` + consent history; `permittedPurposes[]` on segment/sync artifacts; `isPermittedForPurpose`; read-plane masker; label→record ACL; `governance.decision.*` unified log (+ optional hash-chain).
2. **Phase 4:** purpose-propagation RFC + wire advertisement.
3. Verify: purpose-suppression egress test; masking-by-scope read test; label-ACL IDOR test; decision-log query test.

## Open questions

- [ ] Ship purpose host-only first with the wire RFC as fast-follow (recommended) vs block on RFC. **Decided: host-only first.**
- [ ] Hash-chain audit now vs later — default: later (additive, non-blocking).

## Consequences

Purpose, masking, and label-access become first-class **without a second policy engine** — they
extend consent, classification, and accessControl in place. Every CDP artifact inherits enforceable
purpose; the only wire item (cross-host propagation) is cleanly deferred behind an RFC while local
enforcement ships immediately.

## § Correction (2026-09-25) — `CLNP-3`: the CDP workflow lane bypassed the label-based access, and the mask itself was incomplete

The route and the agent tool shared `resolveIdentityWithAccess` (XCH-HOLE-6), but the
**workflow surface** (`features/cdp/surface.ts`, behind `feature.cdp.nodes.resolve-identity`)
called bare `resolveIdentity`. That node is `role:"action"`, so its CLEAR golden record was
written into `node.completed` and replay-served to anyone able to read the run — while the
agent tool over the same data pinned `hasPiiGrant:false`. `run_events` is SQL-backed, so it
also sat outside the ADR 0464 coverage denominator that would otherwise have flagged it.

The surface now goes through the shared helper with **no** pii-read grant, and passes
`masked` through (pack `1.1.0`, and `requiredPacks` pinned to it — a stale pin would
install the old, unmasked node on any host without the vendored copy).

**The mask was also incomplete, on every lane** (found by the `/grade-data` pass on the
fix itself): `maskGoldenRecord` hand-listed `name` + `email` and spread the rest of the
contact through, so the derived `phone` and the declared-PII `address` reached the route,
the agent tool and the node output in clear under `masked: true`. It now masks the
contact's DECLARED PII (`declarePiiFields('crm.contact', …)`, which gained `phone`) via
`maskRecordForRead`, keeps the structured identifier mask, and masks string
`customFields` fail-closed (they carry no PII classification). The deciding fact is **persistence, not the caller**: a
recorded result outlives the session that was allowed to see it, so the session's grant must
not apply. `contactId` stays clear, so a workflow can still branch. Witness:
`test/cdp-surface-masks-recorded-identity.test.ts`, which drives the real pack node over the
real surface. **Scope, stated precisely:** this closes the CDP lane only. CRM nodes
(`get-contact`, `update-contact-stage`/`-owner`, …) record the clear contact **by design** —
a workflow that emails a person needs the address — and whether recorded CRM outputs
should be masked is an open policy question, filed as `CLNP-13`, not a defect this fixed.
The mask is a deterministic, unsalted pseudonym (`maskPiiValue`), so a reader can confirm
a guessed value; filed as `CLNP-14`. **Not remediated:** clear records already written to historical `run_events`;
that needs a data migration and is tracked in `docs/steward/TODO.md` § 9.
`service-desk/intake.ts` still calls the bare resolver, deliberately — it reads only
`contactId` and persists nothing; its docblock says when that stops being true.
