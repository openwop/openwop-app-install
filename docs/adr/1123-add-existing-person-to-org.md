# ADR 1123 — Add a person who already has an account to an org

Status: Accepted

Issue: #5942, from the CasaVoga adopter at the owner's request. Reviewed by the
release manager (openwop-app-14) before build.

## Context

An org admin has two ways to put someone in an org today, and neither binds an
existing account without a round trip:

- **Invite by email** (`orgs/InvitesSection.tsx`) sends a link that the person
  must open and accept. Accept binds `subject: user.userId`, the canonical id,
  behind `assertEmailOwnership` (ADR 0622, 0833).
- **Add member** (`orgs/MembersPanel.tsx`) makes a roster row with a name and
  an email and **no subject**, so it is tied to nobody's sign-in.

The API under "Add member" (`POST` and `PATCH /orgs/:orgId/members`) does
accept a free-text `subject` from any `host:members:manage` holder, and nothing
checks that it names a real person. No screen offers it.

Two facts constrain the design:

- `/users/users` lists users whose HOME tenant is this tenant. In a shared
  `ws:` workspace that is empty, because a person's User row lives in their
  personal tenant. So "people this workspace knows" cannot come from `/users`.
- Since #5930 (#5929 item 2), `GET /orgs` lists only the orgs the caller can
  act in (`listCallerOrgs`). In an agency workspace, the admin of client A
  does not see client B's org. Anything this ADR shows must respect that.

## Decision

### D1 — Who appears in the picker

For an org admin (`host:members:manage` in the target org), the pool is the
distinct **bound** subjects holding a member row in an org from
`listCallerOrgs(req)`, minus those already in the target org.
`listCallerOrgs` already gives a workspace admin, a superadmin and an operator
every org, and everyone else only the orgs they can act in. A client-A admin
therefore never sees a member who belongs only to client B. A single-principal
or no-presence tenant has no other orgs, so its pool is this tenant's
`/users` rows.

The pool is served at `GET /orgs/:orgId/member-candidates`; `?for=link` keeps
the target org's own members in, so a link can merge (D4). The response
carries an opaque `candidateId`, the display name and the email
from the member row, and never the raw subject. There is no search over
accounts outside the pool, and the filter box only narrows the list the admin
was handed. The picker therefore discloses nobody the admin could not already
see on a member panel.

### D2 — A host superadmin's exact-email lookup

A superadmin (`isSuperadmin(req)`) may also look one address up
(`POST /orgs/:orgId/member-lookup`), exactly and
lowercased. It matches only a user whose email is **vouched**
(`isEmailVouched`, ADR 0833 D9), so a self-asserted address never matches. The
answer is either one candidate or the same "no account to add — send an
invitation instead" text. "No account" and "not visible" read alike, and there
is no prefix search and no list.

Ordinary admins never get this lane. Anyone can create a workspace and become
its admin, so an email lookup for them would let anyone probe every account
on the host.

The candidate is a **lookup token**: HMAC-signed, valid for 5 minutes, bound
to the issuing superadmin's subject and the target `orgId`, and single-use (a
used-token ledger keyed by its id, kept until it expires). A token presented
by another caller, for another org, after expiry, or a second time is refused,
with the same 404 as an unknown candidate.

### D3 — Add (`POST /orgs/:orgId/members/add-existing`)

The body is `{ candidateId | lookupToken, roles }`. The server re-resolves the
subject at bind time, re-checks that it is still in the pool, or verifies and
burns the token. The client never sends a subject. The rules are those of the
existing `POST` members: `parseRoleIds`, `requireOwner` to grant owner, and
409 `identity_taken` if the person is already a member there (a root row
converges on its derived id, as `createMember` does). The membership is
effective at once, with no email and no accept step.

### D4 — Link an unbound row (`POST /orgs/:orgId/members/:memberId/link`)

The body is `{ candidateId | lookupToken }`, from the same sources as D3.

- A **sub-org** placeholder (no subject) is bound in place, under the existing
  rule that only a subject-less placeholder may be bound (ADR 0815 D3).
- A **root** placeholder cannot be re-keyed, because its id derives from its
  subject. Link creates the bound row with the placeholder's roles, then
  deletes the placeholder.
- If the person already holds a bound row in that org, link deletes the
  placeholder and keeps the bound row. Nothing is duplicated, and the bound
  row's roles are not changed.

**There is no automatic link at sign-in by matching email.** Joining by email
equality outside the invitation's `assertEmailOwnership` gate is the takeover
shape ADR 0622 and ADR 0833 closed. The issue asked for it only "if safe", and
it is not.

### D5 — Audit and notice

Each add and link appends to the tamper-evident security chain (`appendAudit`,
the #5914 precedent). Entries carry ids only and are DSAR-exempt:

- `security.org.member-added-direct`:
  `{ orgId, memberId, subject, roles, actor, lane: 'workspace' | 'host-lookup' }`
- `security.org.member-linked`:
  `{ orgId, memberId, placeholderMemberId, subject, actor }`

The added person, and only that person, gets an in-app notification that
names the org and the actor's display name, and nothing else about the org.
`memberAdded` still emits the existing lifecycle event.

### D6 — Ratchets and existing rules

The added subject comes only from the pool or a verified token, never from
`orgScopeSubject` and never from the client. The actor is `callerSubject(req)`.
ADR 0832's never-a-grant rule holds, and its READERS list is unchanged. ADR
1118 is unaffected: adding someone to a sub-org grants no private-project
membership.

## Alternatives weighed

- **Pool = every org in the tenant.** This was the first draft. Rejected in
  review: it would have re-leaked what #5930 removed from `GET /orgs`.
- **An email lookup for every admin.** Rejected as an enumeration oracle (D2).
- **Auto-link at sign-in by verified email.** Rejected (D4).
- **Close the free-text `subject` now.** It is deferred to its own PR (below),
  so adopters have the new lane before the old one closes.

## Follow-up (separate PR, after D3 and D4 ship)

The existing `POST` and `PATCH` members will refuse a host-identity spelling
in `subject` (`user:`, `apikey:`, `session:`, `breakglass:`, `bearer:`,
`agent:`), following ADR 0833's `requireIdpPrincipal`. Service and local
accounts keep working, and person binds go through D3 and D4. That PR greps
the SPA, the seeds, `openwop-cli` and the examples for `user:` subjects and
lists them.

> **CORRECTED 2026-11-14 — the follow-up is split, and an interim ships first
> (release manager's decision).** A survey on main `00f7614c7` found that the
> SPA sends no `subject` here, but `openwop-cli` documents
> `orgs members create --subject user:jo`, and **133 backend test files**
> provision membership by POSTing a `user:` subject, only 3 of them with the
> wildcard bearer. A flat refusal would redden about 130 files. The risk it
> closes is enrolment without consent, which is real but low and visible. It
> is not a data read, and it does not justify that sweep this week. So:
>
> - **Interim (this PR):** a `user:` subject bound through the old lane emits
>   the D5 audit entry with `lane: 'legacy-subject'` and the D5 notice to that
>   person (`recordLegacySubjectBind`). A new `POST` row records
>   `member-added-direct`, and a `PATCH` that binds a placeholder records
>   `member-linked`. There is no behaviour change. Service and IdP subjects are
>   not people, so they get neither.
> - **(i) openwop-cli:** `orgs members add-existing` and `link`, plus a
>   deprecation warning on `--subject user:`.
> - **(ii) + (iii), #5945:** a shared `seedMember()` test helper and the
>   fixture sweep, then the refusal. A `user:` subject on `POST`/`PATCH` must
>   resolve through D1 or D2, or it gets `409 use_add_existing`. The wildcard
>   bearer and superadmins are exempt. This is its own gated unit with its own
>   train, because a sweep of that size trips the src-walking ratchets.

## Implementation record

| Piece | Where | Test |
|---|---|---|
| Pool, lookup, token | `host/orgPeoplePicker.ts` | `test/adr1123-add-existing-person.test.ts` |
| Routes | `routes/accessControl.ts` | same |
| Interim: old-lane visibility | `routes/accessControl.ts` → `recordLegacySubjectBind` | same (the interim case) |
| Picker and link UI | `frontend/react/src/orgs/` | component test |
