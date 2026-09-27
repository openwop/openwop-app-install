# ADR 0226 — Identity floor: deterministic session↔contact link

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `analytics` (`identityLinkService.ts` — the link table + erasure hook; `analyticsService.recordEvent` — the `owx` beacon capture), `forms` (public-submit writer), `email` (`engagementService` — `owx` on click destinations + the token resolver), `campaign-intel` (`attribution.ts` — `knownContactConversions`) |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5D **D4** (E2/E7 multiplier — "small ADR, big caveats") |
| **Depends on** | ADR 0018 (analytics sessions + beacon), ADR 0020 (consent gate + subject-erasure seam), ADR 0218 (email click tokens), ADR 0219 (attribution floor), ADR 0017 (public form submit → CRM contact) |
| **RFC gate** | **None** — host-ext store + additive host-ext fields; nothing touches the wire. |

> **Numbering note:** authored as 0224; renumbered to **0226** — the commerce
> Phase C session claimed 0224/0225 on `main` (PR #1212) while this branch was
> in flight (the README first-created-is-canonical rule).

## Context

The two measurement halves never met at the person level: analytics conversions are
anonymous-session-scoped (ADR 0219 recorded this exact gap — "Session↔contact linkage is
D4"), while email engagement and CRM know the contact. The two moments where the
association is *deterministic* — a visitor typing their details into a public form, and a
recipient following an instrumented email link — were both discarded.

## Decision — a link table, not an identity system

**One deterministic link table** (`analytics:identity-link`, owned by `analytics` — the
feature that owns the session concept): rows
`{key: tenantId::sessionKey, tenantId, sessionKey, contactId, source: 'form-submit'|'email-click', at}`,
**one link per session, last-writer-wins** (a session is short-lived and single-visitor by
construction; the newest deterministic evidence wins — no history kept, deliberately).
Exports: `linkSession`, `contactForSession`, `eraseSubjectLinks`.

**Two writers, both deterministic, both best-effort** (a link failure never fails the
primary write):

1. **Form submit** (`forms/routes.ts` public submit): an optional `sessionKey` in the
   submission body (bounded to the beacon's 1024-char cap; additively persisted in
   `Submission.meta`). The link is written only when a CRM contact was actually
   created/matched AND `isAllowed(tenantId, sessionKey, 'analytics')` passes — the
   analytics beacon's own consent gate, mirrored, so the link table never learns more
   than the event store may.
2. **Email click** (`email/engagementService` + `analytics/analyticsService`): at
   instrumentation time each click destination gains an opaque `owx=<click-token>` query
   param (fragment-safe), so the 302 lands the recipient on `dest?owx=…` and the
   destination page's beacon can echo it. `recordEvent` captures an optional bounded
   `owx` from the raw beacon event, resolves it through
   `engagementService.resolveClickToken` (token → `{tenantId, contactId}`; the token's
   tenant MUST equal the beacon's tenant — no cross-tenant linking from a leaked or
   replayed token), and writes the link (`source:'email-click'`). Best-effort: the beacon
   write never fails or waits on it. **PII rule:** `owx` is an opaque server-side token —
   no address or contact id ever rides a URL (the ADR 0218 posture, extended).

**Erasure cascade:** `identityLinkService` registers with the ADR 0020 subject-erasure
seam (the same `registerSubjectEraser` pattern analytics events use), removing link rows
matching the erased subject **by sessionKey AND by contactId** — either side of a link
may be the data subject.

**Consumer (the point):** `campaign-intel/attribution.ts` rows gain
`knownContactConversions` — the subset of `webConversions` whose `sessionKey` resolves
through the link table. **ADDITIVE beside `webConversions`, never replacing it** (same
conversion events, filtered by link resolution at read time — a pure projection).

## STRICT boundary (gap plan §6 — recorded, not implied)

Deterministic link rows ONLY:

- **No probabilistic matching** (no fingerprinting, no fuzzy email/device joins).
- **No contact merge** and **no identity graph** (a link row never mutates CRM data).
- **A full CDP / streaming profile store is a recorded NON-goal** — the gap analysis §6
  names it a data-platform company in itself; this host demos the *pattern* via
  CRM + consent + this one deterministic table. Composable-market positioning (Segment
  et al.) argues for interoperating, not rebuilding.

## Alternatives rejected

- **Link rows in CRM** — the session is an analytics concept; putting session-keyed rows
  in CRM invites the identity-graph creep this ADR forbids.
- **Appending `owx` at redirect time (in `recordClick`)** — equivalent for the beacon,
  but instrumentation-time append keeps the token row the single source of the final
  destination (what was minted is what is served) and keeps `recordClick` a pure
  read-then-302.
- **Keeping link history per session** — history is the first step toward a profile
  store; last-writer-wins keeps the table an index, not a dossier.

## Verification

`analytics-identity-link.test.ts`: link write/read + last-writer-wins + tenant isolation;
erasure cascade via `consentService.deleteSubject` by sessionKey AND by contactId;
form-submit writer (with the consent-gate deny case); beacon `owx` writer end-to-end
(instrument → 302 carries `owx`, no PII → beacon echoes → link written; tenant-mismatch
and bogus-token inert); attribution `knownContactConversions` additive semantics.
`email-engagement.test.ts` updated for the deliberate destination change (`dest?owx=…`).
