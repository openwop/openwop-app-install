# ADR 0449 — KickTodo participant ⇄ CRM Contact bridge (consented, identifier-keyed)

| | |
|---|---|
| **Status** | implemented (P1–P2) — 2026-07-20; P3 product-gated, P4 delivered via ADR 0456 (see Implementation record) |
| **Feature** | EXTENDS `crm` (a shared `ensureContact` seam) + `kicktodo-*` (consented touchpoints). **No new feature package; no new toggle** — rides the existing `crm` toggle and the existing KickTodo consent/commerce stores. |
| **Source** | The KickTodo→CMS/CRM/Commerce/Marketing mapping deep-dive (this session). KickTodo has **exemplary Commerce reuse and ZERO CRM reuse**: every person is an opaque subject (ADR 0426), so a participant who buys a challenge or opts into reminders is a dead-end with no customer continuity — and this is the **dependency root** that blocks the entire Marketing column (email consent, journeys, segments, funnel attribution). |
| **RFC verdict** | **Host work, no RFC.** No wire surface — a host-internal CRM link + a shared helper. Nothing on the OpenWOP wire, no capability advert. |
| **Composes** | CRM 0008 (Contact + `identifiers[]` SoT, ADR 0383), ADR 0426 (KickTodo community — the "opaque subjects, never PII, no second identity system" privacy law this MUST respect), ADR 0446 (extract the shared seam, don't stand up a second copy), ADR 0420 (the Commerce fulfilment observers KickTodo already rides), the KickTodo consent store (`kicktodo-consents`) |

## 1. Why this exists

Verified against code: `grep -rn 'contactsService|createContact|findContactByEmail|features/crm' backend/typescript/src/features/kicktodo-*` returns **nothing**. Participants, coaches, buyers, and inviters are opaque `ownerSubject`/`buyerSubject`/etc. (`kicktodo-core/enrollmentService.ts:120`), never `Contact` rows.

The subtle part: a **paid**-challenge buyer *does* get a Contact today — but only as a side effect of the Commerce checkout path (`commerce/routes.ts:493`), and that Contact is **never linked back** to the KickTodo participant subject. So even the one place a Contact exists, KickTodo can't find it. Free-challenge participants and reminder/leaderboard opt-ins get no Contact at all.

Without a Contact link, none of the platform's Marketing lanes can see a KickTodo participant: email consent, CDP segments (`crm/segmentsService.ts`), journeys (`campaign-journeys/journeyService.ts`), and funnel attribution all key on a Contact. This ADR is the precondition; the referral→affiliate bridge and marketing automation sequence **after** it.

## 2. Boundaries audit (verified 2026-07-20)

- **`contactsService` is the single owner of contacts** (`crm/contactsService.ts:58`); `identifiers[]` is the identity SoT (`crm/contactIdentityService.ts:40`, closed types incl. `email`), `phone` derived-read-only. This ADR **composes** it — it never forks a second contact store.
- **The hand-rolled `ensureContact` pattern already exists TWICE and DIVERGES** — the ADR 0446 smell:
  - `commerce/routes.ts:493` — `(await listContacts(tenantId)).find(c => c.email?.toLowerCase() === email)` **(a full-collection scan)** else `createContact({...})`, no `leadSource`.
  - `webinars/webinarProcessor.ts:105` — `findContactByEmail(tenantId, email)` **(the right primitive)** else `createContact({..., leadSource: 'webinar'})`.
  Two copies, two behaviors (one scans, one point-gets; one stamps a lead source, one doesn't). This ADR extracts the ONE seam and makes commerce, webinars, and KickTodo its consumers.
- **No namespace/route collision** — KickTodo adds no CRM routes; it calls the shared helper from its own consented touchpoints. The subject↔contact link is a new KV collection under KickTodo's own namespace.
- **ADR 0426 is the privacy law, not an obstacle:** "a creator profile is keyed by the caller's stable subject — display fields only — it never models auth" / "reviews carry NO reviewer PII in projections." The bridge honors this: the link stores an opaque `contactId` (an internal id, not PII) keyed by subject, is created **only on a consent event that already carries an email**, and never auto-mints a Contact for an anonymous participant.

## 3. Decision

Two pieces — a shared seam (CRM) + a consented link (KickTodo):

- **D1 — Extract `ensureContact` into `crm/contactsService`.** One idempotent
  `ensureContact({ tenantId, email, name?, leadSource? }): Promise<Contact>` = normalize
  email (`normalizeIdentifierValue`) → `findContactByEmail` → else `createContact`. Best-
  effort semantics documented (a CRM failure never blocks the caller's primary action, as
  both current copies already assume). **Migrate `commerce/routes.ts` and
  `webinars/webinarProcessor.ts` onto it** — this also fixes commerce's full-scan
  (`listContacts().find`) to the indexed `findContactByEmail`. Net: −2 copies, +1 owner.

- **D2 — The consented subject↔contact link (the genuinely new data).** A KickTodo-owned
  collection `kicktodo-subject-contact` keyed `${tenantId}::${ownerSubject}` →
  `{ tenantId, ownerSubject, contactId, source, linkedAt }`. It stores an opaque
  `contactId` (never email/PII on the row), so it is purge-safe and ADR-0426-clean.
  `resolveContactForSubject(tenant, subject)` reads it; `linkSubjectToContact(tenant,
  subject, contactId, source)` is idempotent (first-write-wins; a re-link to the same
  contact is a no-op, a different contact is a logged conflict, never a silent overwrite).

- **D3 — Fire on CONSENT events only (the ADR 0426 gate).** The bridge fires exactly where
  the participant has already supplied/consented an email — never on anonymous enrollment:
  - **Paid-challenge checkout** — the Contact already exists via `commerce/routes.ts`; the
    KickTodo entitlement observer (`kicktodo-commerce`, which already rides the paid
    observer) additionally **links** the order's `contactId` to the buyer subject. Zero new
    Contact creation on this path — just the missing link.
  - **Reminder consent** (`kicktodo-consents` `messaging-reminders`) — if the consent flow
    carries an email, `ensureContact` + `linkSubjectToContact(source: 'reminder-consent')`.
  - **Leaderboard opt-in** — only if the opt-in carries a real contactable email (the
    `displayName` alone is not an identifier; no email ⇒ no Contact — honest).
  - Free-challenge enrollment with no email ⇒ **no Contact, no link** (the privacy floor).

- **D4 — What the link unlocks (sequencing, not this ADR's scope).** Once a participant is
  a Contact: `leadSource: 'kicktodo'` for segment targeting; challenge lifecycle events via
  `collectEvent` → segments/journeys; and the referral→affiliate bridge (ADR-next) can
  stamp `affiliateCode` for a referred purchase against the referrer's Contact. Explicitly
  deferred here.

## 4. Feature-evaluation matrix (deltas only)

| Dim | Decision |
|---|---|
| Package/toggle | Extends `crm` (the helper) + `kicktodo-*` (the link + touchpoints). **No new toggle** — the link only ever populates when the CRM toggle is live AND a consent event carries an email; if CRM is off, `ensureContact` best-effort no-ops (the existing posture). |
| Workflow surface / node / agent packs | None new. (A future node "resolve participant contact" could ride the existing crm surface — deferred.) |
| Public surface | None — the link is internal; no route serves it anonymously. |
| RBAC | Reads of the link are operator/self-scoped through existing CRM RBAC; the link write is a system side-effect of a consented action (no new user-facing mutating route). |
| Replay/fork | N/A (no run-event); the link is a deterministic per-(tenant,subject) key. |
| Frontend | None required for the bridge itself. A later "this participant in CRM" affordance is deferred. |
| Data/purge | `kicktodo-subject-contact` carries `tenantId` in content + a tenantOf index (KTD-1 purge-safe); no PII on the row (opaque contactId only). |

## 5. Phased plan

| Phase | Ships | Gate |
|---|---|---|
| P1 | `ensureContact` extracted into `crm/contactsService`; commerce + webinars migrated onto it (behavior-preserving; commerce's scan → point-get); tests pin both consumers unchanged + the dedup/normalize contract | /architect on the shared-seam signature (best-effort contract; who owns normalization) |
| P2 | `kicktodo-subject-contact` link store + `linkSubjectToContact`/`resolveContactForSubject`; wire the **paid-checkout link** (the entitlement observer links the existing order contactId) | P1; test: buy a paid challenge → the buyer subject resolves to the order's Contact |
| P3 | Wire the **reminder-consent** and **leaderboard-opt-in** touchpoints (ensureContact + link, email-gated); the free-enrollment no-email path asserts NO Contact | P2; test the consent gate (no email ⇒ no contact) — the ADR 0426 privacy pin |
| P4 | `leadSource: 'kicktodo'` + a `kicktodo.participant.linked` `collectEvent` emission so segments/journeys can target participants (the marketing on-ramp) | P3 |

## 6. Alternatives, corrections, open questions

- **Alternative (rejected): make `ownerSubject` a Contact wholesale.** Violates ADR 0426
  (opaque subjects, PII-gated) and would mint contacts for anonymous participants. The
  consented, identifier-keyed link is the honest shape.
- **Alternative (rejected): a second KickTodo-local "people" store.** That's the exact
  duplication ADR 0446 forbids; the link composes CRM instead.
- **PRD→architecture correction:** the mapping framed this as "create a Contact for a
  participant." The audit showed the paid path *already* creates one (via Commerce) — so
  the actually-missing primitive is the **subject↔contact LINK**, not contact creation. The
  ADR is reshaped around the link + the shared-helper extraction.
- **OQ1:** where does normalization live — inside `ensureContact` (safer, one place) or at
  each caller? Recommend inside the helper; callers pass raw email.
- **OQ2:** the leaderboard opt-in currently stores only `displayName` (no email). Do we add
  an optional email at opt-in, or leave leaderboard un-linked until another touchpoint
  supplies an email? Start with the latter (no schema change; no PII added speculatively).
- **OQ3 (sequencing):** the referral→affiliate bridge and marketing automation are separate
  ADRs that DEPEND on this link; this ADR is their prerequisite and ships first.

## 7. Implementation record (2026-07-20)

| Phase | Status | PR |
|---|---|---|
| P1 | **Implemented** — `ensureContact` extracted into `crm/contactsService`; commerce (scan→merge-aware) + webinars migrated onto it; new `crm-ensure-contact` test | #2274 |
| P2 | **Implemented** — `kicktodo-core/contactBridgeService` (opaque-contactId link, KTD-1 purge-safe, idempotent first-write-wins) + `kicktodo-commerce/contactLinkObserver` (paid KickTodo order + contactId ⇒ link buyer subject↔Contact, scoped, best-effort); `kicktodo-contact-bridge` test | #2275 |
| P3 | **Blocked on OQ2 (a product decision)** — the reminder-consent (`IntegrationConsent`) and leaderboard-opt-in (`LeaderboardOptIn`) rows carry **no email** (`integrationService.ts:30`, `engagementService.ts:26`), so there is nothing to `ensureContact` with. The ADR's OQ2 default is "leave un-linked; add no speculative PII" — so P3 is correctly deferred until a product decision to collect a consented email at those touchpoints (a schema + opt-in-UX change). Verified, not skipped. |
| P4 | **Delivered via ADR 0456 P1** (correction) — the intended marketing on-ramp ("segments/journeys can target participants") is now provided by `kicktodo-core/lifecycleEvents.ts` (ADR 0456), which emits consent-gated participant lifecycle events (`kicktodo.participant.enrolled/completed/stalled`, `kicktodo.challenge.purchased`) keyed to the CRM `contactId` — **gated on THIS ADR's `resolveContactForSubject` link** (Gate 0). Those richer lifecycle events subsume P4's standalone `kicktodo.participant.linked` signal, so a separate `participant.linked` emission is intentionally NOT added (it would be redundant marketing noise). P4's goal is met; the specific event is retired. |

> **Status correction (this pass).** The header `Status` was stale at `Proposed` while
> P1 (#2274) and P2 (#2275) had shipped. Corrected to `implemented (P1–P2)`. P3 remains a
> genuine product/privacy deferral (OQ2 — the reminder-consent + leaderboard-opt-in rows
> carry no email, so there is nothing to `ensureContact` with; the ADR's chosen default is
> to add no speculative PII). P4's marketing on-ramp is delivered by ADR 0456 P1 consuming
> this ADR's link, so P4's standalone event is retired rather than built. The **dependency
> root** this ADR exists to provide — a consented subject⇄Contact link — is live for the
> paid-checkout path, which is exactly the path that has a consented email today.

**Net delivered:** the bridge works end-to-end for the path that already has a
consented email — a paid challenge/cohort buyer is now linked to their CRM
Contact, and `ensureContact` carries a `leadSource: 'kicktodo'` slot. This is the
dependency root; the referral→affiliate bridge and marketing automation can now
build on `resolveContactForSubject`. P3/P4 await the OQ2 email-source decision.
