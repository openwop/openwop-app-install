# ADR 0381 — Subject-key resolver: GDPR erasure across linked identities

Status: Accepted — implemented (one PR)

Date: 2026-07-16

Lane: cross-cutting host seam (privacy/compliance) — no new feature package, no toggle

RFC verdict: **host work only.** `eraseSubject` is a non-normative host seam (ADR 0020
consent owns `deleteSubject`); expanding which of a subject's *own* linked identities it
reaches touches nothing on the OpenWOP wire.

## Context

`eraseSubject(tenantId, subjectKey)` (`host/subjectErasure.ts`) fans a GDPR
right-to-erasure out to every feature that registered a `SubjectEraser`, best-effort. The
`subjectKey` is **polymorphic** — a `userId`, a CRM `contactId`, or a CDP `sessionKey`
depending on who initiated the delete.

The gap (surfaced implementing PRIV-1, DATA-ASSESSMENT): a subject's data is spread across
**linked identity spaces**. A CDP `sessionKey` and a CRM `contactId` for the *same person*
are joined by the `analytics:identity-link` store, and e.g. commerce **orders are keyed by
`contactId`**. So an erasure keyed by a `sessionKey` never reached that person's orders.

Worse, the naive cure — have the commerce eraser resolve `sessionKey → contactId` via the
link at erase time — **races**: erasers run in registration order and the analytics
`identityLinkEraser` DELETES the link during the *same* fan-out, so a downstream eraser that
reads the link may find it already gone (this is exactly why PRIV-1 shipped as
direct-`contactId`-only, deferring the session path here).

## Decision

Resolve the subject's identity graph **once, upfront, before any eraser runs**, and fan the
erasure out over the **full set of linked keys** — via a new registered-resolver seam so the
host never imports a feature.

1. **New seam** `registerSubjectKeyResolver((tenantId, subjectKey) => Promise<readonly string[]>)`
   in `host/subjectErasure.ts` — the same dependency-inversion family as
   `registerSubjectEraser` / `registerRetentionPurger`. The host calls registered resolvers;
   features register them. `__resetSubjectKeyResolvers` mirrors `__resetSubjectErasers`.

2. **Analytics registers the one resolver** (it owns `analytics:identity-link`). It expands
   the **bounded 2-hop closure**, which is COMPLETE because the graph is bipartite
   (session ↔ contact):
   `{subjectKey} ∪ contactForSession(subjectKey) ∪ sessionsForContact(subjectKey) ∪
   sessionsForContact(contactForSession(subjectKey))`.

3. **`eraseSubject` resolves-then-fans-out.** It builds the key-set from all resolvers
   (best-effort — a throwing/slow resolver is caught and logged; the bare `subjectKey` is
   ALWAYS in the set, so PRIV-1's direct path survives an analytics outage), then invokes
   **each eraser once per resolved key**. Because resolution completes before any eraser runs,
   the link-deletion race is eliminated.

4. **No eraser changes.** The single-key `SubjectEraser` signature is unchanged; all 9
   erasers stay simple and are just invoked K times (K = key-set size, typically 1–3). This
   is safe under two contract rules, now documented on the seam:
   - **Erasers are idempotent / side-effect-free beyond deletion** — invoked once per linked
     key, they MUST NOT do per-call work (counters, notifications) that would fire K times.
   - **Resolvers return ONLY authoritative, store-backed same-subject keys** (real
     `identity-link` rows), never a heuristic/fuzzy match — this is what guarantees no
     *over-erasure* (reaching a different subject's data).

5. **Return shape** stays feature-centric so consent's `failed > 0` contract is unchanged:
   `{ total: erasers.length, failed: <distinct erasers that threw for ≥1 key>, keysResolved }`.
   `keysResolved` is added for observability on the compliance path (a 1→3 expansion is worth
   logging).

## Alternatives weighed

- **Change `SubjectEraser` to take a `ReadonlySet<string>`** (Options A/C): cleaner semantics
  and 1 scan/eraser, but rewrites all **9** compliance-critical erasers for a ≤~27-vs-9
  tenant-scoped-scan delta on a **rare** (operator/consent-driven) path. Rejected — the blast
  radius on a compliance path is not worth the efficiency. (Architect ruling.)
- **`userId ↔ contact/session` bridge**: there is no such link store today (userId is the
  auth-identity space; the userId-keyed erasers simply no-op on a session/contact key). The
  resolver seam is future-proof — if such a bridge ever exists, its owner registers another
  resolver, no seam change. Not built now.
- **Unbounded transitive closure**: unnecessary — the bipartite graph is fully covered in 2
  hops.

## Consequences

- A `sessionKey`-keyed erasure now reaches the same person's `contactId`-keyed data (orders,
  etc.) and vice-versa — closing the PRIV-2 completeness gap.
- The seam is extensible for any future same-subject identity bridge.
- Per-key fan-out multiplies the (rare) erasure's scans by K; acceptable and bounded.

## As-built

| Piece | Where |
|---|---|
| Resolver seam + reset helper + resolve-then-fan-out | `host/subjectErasure.ts` |
| Analytics 2-hop resolver | `features/analytics/identityLinkService.ts` |
| Decisive test (sessionKey erasure reaches a contactId-keyed order — the PRIV-1 test-2 that failed) + seam unit tests | `test/priv2-subject-key-resolver.test.ts`, `test/priv1-order-erasure.test.ts` |

Cross-references ADR 0020 (consent owns `deleteSubject`), DATA-ASSESSMENT PRIV-1/PRIV-2.
