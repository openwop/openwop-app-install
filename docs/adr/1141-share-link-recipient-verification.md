# ADR 1141 — A share link can verify its recipient with a one-time code

Status: Accepted (2026-11-16, release-coordinator review; P1 approved to build)

Issue: #6034, from CasaVoga ADR CV-0222 D4: one portal link per client contact, and a
forwarded link must not open for whoever receives it.

## Context

A share link is a bearer capability. `features/sharing/sharingService.ts` `createLink`
mints a token, stores only its sha256 (`host/capabilityToken.ts`), and
`resolveActiveLink` (`sharingService.ts:~1435`) authorises every read by the token
alone: revocation, expiry, the org↔tenant pin, the owning feature's toggle, the view
cap and the publisher re-check. Anyone holding the URL can open it. OWASP's guidance on
capability URLs, and the W3C TAG finding on them, both call a bearer URL alone a weak
bind for a person-specific resource.

The adopter cannot add a check itself, because the page is served by the host's
`/shared/:token`.

### Boundaries audit — what exists, and what this rides

| Need | Existing seam | Used as |
|---|---|---|
| The link, its gate, revocation | `sharingService.ts` `createLink`, `resolveActiveLink`, `revokeLink`, `purgeLinksForResource` | The ONE gate. Verification is a new check inside `resolveActiveLink`, so the page, `/frame-view`, `/card` and the action lanes (`assertLiveLinkFor`, `resolveActiveResource`) are all covered by the same line. |
| A recipient's email | `features/crm/contactsService.ts` `resolveContactSurvivor(tenantId, contactId)` (tenant-checked, follows merges); `subjectErasureState` | Resolved at SEND time, never stored for a contact recipient. `getContact` is not used: it has no tenant guard. |
| Sending system mail to an external address | `host/transactionalEmail.ts` (`registerTransactionalTemplate`, four locales, escaped fills) plus the no-acting-user lane in `host/emailApprovalDelivery.ts` (`resolveEmailProvider` → `makeEmailAdapter(...).send({ purpose: 'transactional', idempotencyKey })`) | The code email (`features/sharing/shareCodeMail.ts`). Neither the brokered transport (`features/email`, which needs an acting user) nor `activeProvider()` (the console stub) can send it. |
| Rate limits per link and per IP | `host/sharedRateLimit.ts` `takeShared({ scope, key, limit, windowS, failure })`, the pattern in `features/campaign-ops/portal.ts:388-400` | Send and verify limits, `failure: 'closed'`. |
| A browser-bound visitor session | `middleware/cookieSession.ts` (`mintAnonSession`, `verifySession`, `__session`) | The verified claim is keyed on the session's `sid`. A new cookie is not added: Firebase Hosting forwards only `__session` on the `/api` rewrite, so a second cookie would never reach the backend. |
| Audit | `host/auditChainService.ts` `appendAudit` (as MFA uses it) | Code sent, verified, failed, locked. |
| Erasure | `sharingService.ts` `eraseSubjectSharing` (matches `createdBy` only), `host/subjectEraserManifest.ts` | A new recipient eraser beside it. Today a contact erasure does not revoke the contact's links at all (`features/crm/erasure.ts` never purges), so this closes that too, for recipient-bound links. |

**What is new:** a recipient field on the link, one code store, one verified-session
store, two public routes, one transactional email kind, one eraser entry, and the
neutral page state in the SPA. No one-time-code facility exists to reuse: the pairing
and CLI-login codes (`features/claude-code/pairingService.ts`,
`features/developer-keys/cliLogin.ts`) are shown on screen, not mailed, and none counts
failed attempts. Their CSPRNG and TTL shape is copied, not their storage (the user code
there is plaintext).

## Decision

**D1. Opt-in at mint, off by default.** `createLink` accepts
`recipient: { contactId } | { email }` and `verify: { sessionHours? }`. `verify`
requires a `recipient`. Without them nothing changes for any existing caller or link.
The row gains:

- `recipient`: `{ kind: 'contact', contactId }` or `{ kind: 'email', email }` (the
  address must be kept to send to it; it is PII, declared to the eraser);
- `recipientEmailHash`: sha256 of the normalised address at mint, for erasure matching;
- `verify`: `{ sessionHours, lockedAt? }`, with `sessionHours` 1–720, default 24;
- `verification` counters: `sentCount`, `lastSentAt`, `verifiedCount`,
  `lastVerifiedAt`, `failedAttempts`. No code, ever.

The recipient is never in the URL. Mint refuses (`422 share_verification_unavailable`)
when no transactional email provider resolves for the workspace, so the owner learns
it then, not the visitor later.

> **Review changes (2026-11-16, release coordinator + architect pass), folded into D2–D4 below:**
> (1) code REQUESTS are capped apart from the 5-miss lock, per link and per IP, so a link
> holder cannot email-bomb the recipient; (2) each new code invalidates the previous one,
> and the compare is constant-time; (3) the MAC key is derived with HKDF under a purpose
> label, never the raw session secret; (4) a lock notifies the creator only; (5) the
> verification routes answer identically for an unknown, revoked, unbound or bound link,
> with similar timing; (6) the recipient eraser revokes links before it drops the stored
> address. Also checked: no other module registers under `/shared/:token/*`
> (`features/sharing/routes.ts:64-104` is the only owner), so the new routes cannot be
> shadowed.

**D2. One gate.** `resolveActiveLink` takes the request's session `sid`. For a link
with `verify`, it passes only when `sharing:verified:<tokenHash>:<sid>` exists and has
not expired. Otherwise it answers `401 share_verification_required`. The body carries
only `{ orgDisplayName, maskedEmail }` (for example `a•••@example.com`) and nothing from
the resource: no title, no label, no type. A locked link answers
`423 share_verification_locked` with the same two fields. The lanes that already skip
the view cap still go through this check.

**D3. The code.**
- **Send:** `POST /host/openwop-app/shared/:token/verification`.
  - Requests are capped on their own, apart from the 5-miss lock: per link 3 per
    10 minutes AND 10 per day, per IP 10 per 10 minutes, all `failure: 'closed'`
    (`takeShared`). Without this, anyone holding the link could email-bomb the recipient.
  - It mints a 6-digit code (`crypto.randomInt`) and stores
    `sharing:verify-code:<tokenHash>` = `{ codeMac, expiresAt (10 minutes), attempts: 0 }`.
  - `codeMac` is an HMAC-SHA256 over `tokenHash ‖ code` under a key DERIVED with HKDF from
    the session secret and the purpose label `share-link-otp-v1`, so the two keys never
    cross. Rotating the session secret voids codes in flight, which is acceptable at
    10 minutes.
  - A new send REPLACES the pending code: the previous code stops working at once.
  - The email goes only to the address on record: a contact's email resolved at send
    time, skipped if that subject is under erasure. Never to an address the visitor types.
  - It always answers `202 { maskedEmail }` for a bound, live link. For an unknown,
    revoked, expired or unbound token it answers the same `202` with a placeholder
    mask and sends nothing, after the same work shape (one store read, one limiter
    take), so neither the body nor the timing tells a probe which tokens are bound.
- **Verify:** `POST …/verification/verify { code }`.
  - It is rate-limited per link (10 per 10 minutes) and per IP (30 per 10 minutes).
  - It compares the MAC in constant time (`timingSafeEqual`) and consumes the code with
    a compare-and-swap, so a code is single-use.
  - Each miss increments `attempts`. The fifth miss deletes the code, sets
    `verify.lockedAt`, and notifies the link's CREATOR only, through the notification
    emitter. The recipient is not emailed: telling a recipient about someone else's
    failed guesses would be a harassment lane.
  - A miss, an unknown token, a revoked link and an unbound link all answer the same
    `400 share_verification_failed`, so verify cannot probe either.
  - A success writes the verified row for the caller's `sid` with
    `expiresAt = now + sessionHours`. An existing `__session` is reused as it is (a
    signed-in visitor keeps their session); only a request with none gets a fresh
    anonymous one.
- **Unlock:** an authed owner action, `POST …/links/:id/verification/unlock`, clears
  the lock. Re-minting also works.

**D4. Revocation and erasure end everything.** `revokeLink` and
`purgeLinksForResource` delete the link's pending code and every verified row. A new
eraser, `eraseSharingRecipient`, matches a subject by `recipientEmailHash`, or by
`contactId` among the subject's contacts. In this order, so a failure part-way fails
closed: it REVOKES the matching links first, then deletes their codes and verified
rows, and only then scrubs `recipient`. A link left with its address but already
revoked opens for nobody. It is registered in
`subjectEraserManifest.ts` beside `eraseSharingSubject`, with the PII field declared.

**D5. Audit.** `appendAudit` records `share.verification.sent` (masked address),
`.verified`, `.failed` (attempt number) and `.locked`, each with the link id. The code
is never recorded. The link's counters (D1) give the owner's view.

**D6. The neutral page.** `SharedSharePage` handles the 401 and 423 states. It shows
the firm's name, "We've sent a code to the email on file (a•••@example.com)", a code
field, and resend (honouring the 202). After a success it reloads the resource. It
uses the shared `ui/` primitives and the four locales. It never shows anything from
the resource before verification.

**D7. No wire change.** These are host-extension routes under `/host/openwop-app/*`.
No RFC is needed, and no capability is advertised.

## Corrections from implementation (P1, 2026-11-16)

- **The mail lane.** The first draft named the e-sign path's
  `features/email` `activeProvider()`. MEASURED: on this host it is the console
  stub (`emailService.ts:366`), and `emailTransportConfigured()` is always false.
  E-sign, its one external-mail caller, reads that flag and reports its invites as
  not emailed, so that path is honest; it just cannot carry this code. The code email rides
  the approval email's real lane instead, as the audit table says
  (`features/sharing/shareCodeMail.ts`): the registered kind, then
  `makeEmailAdapter(...).send({ purpose: 'transactional' })` on the first
  workspace-scoped Connection, with `OPENWOP_NOTIFY_EMAIL_FROM` as the sender. The
  mint check is `shareCodeMailReady`: a sender address and a resolvable provider.

  > **CORRECTED 2026-11-25 (after #6248):** the sender is now the link org's own
  > `senderAddress` (`getEmailSettings(tenantId, orgId)`, as `features/email/brokeredProvider.ts`
  > uses), with the org's name as `fromName` (control characters collapsed, capped at
  > 100). `OPENWOP_NOTIFY_EMAIL_FROM` is only the fallback for an org without one. The
  > mint check and the send both take `link.orgId`. The provider is still resolved with
  > the tenant only, on purpose: a code send has no acting human, and the broker
  > withholds an org Connection from such a send and then returns nothing
  > (`authorizedCandidates`), so resolving with `orgId` would leave an org with its own
  > Connection unable to send at all.
- **The session read.** `/host/openwop-app/shared` is a public prefix the auth
  middleware does not session, so the route reads and verifies `__session` itself,
  and the verify route mints an anonymous session when the visitor has none.
- **The session read and mint stay in the session module (ADR 0833, train 287e).**
  The route first read and verified `__session` itself and signed the anon session
  it minted, which broke ADR 0833's D1 (the cookie is read only where liveness is
  decided) and D2 (one session-payload builder). It now asks `liveSessionSidOf`
  (middleware/auth.ts, through `resolveLiveCookieSession`, so a revoked or ended
  signed-in session is no viewer). It sets the minted cookie with
  `setAnonSessionCookie` (cookieSession.ts, which signs a `mintAnonSession` payload:
  `buildSessionPayload`'s 24 h sliding anon lifetime).
- **The lock notice for a host-minted link.** A visitor-lane link's creator is a
  `system:` actor (the publisher re-check only exempts those), not a person. Its
  lock notice goes to the workspace's admins (`recipientRole: 'admin'`); a
  member-minted link's goes to its creator. The recipient is still never told.
- **The management list** (`listLinks`) is read by every workspace reader, so an
  email recipient is masked there and the address hash is never listed.
- **The eraser key.** A subject key is an email OR a candidate contactId (the CRM
  eraser's posture), so `eraseSharingRecipient` matches the mint-time hash, the
  recipient's contactId, or a contact recipient's current address.
- **Error codes.** `share_verification_required` (401), `_locked` (423), `_failed`
  (400) and `_unavailable` (422) are added to the host-extension code union.

## Alternatives rejected

- **A dedicated cookie per link.** It would not survive the Firebase `/api` rewrite,
  which forwards only `__session`.
- **A magic link instead of a code.** A forwarded email forwards the magic link too.
  The issue's threat is forwarding.
- **Storing a contact's email on the row.** The contact's email can change or be
  erased. Resolving at send time follows both, and the hash is enough for erasure.

## Consequences and limits

- **Session lifetime:** a verified view lasts the shorter of `sessionHours` and the
  visitor's `__session`. An anonymous session is 24 hours, so a longer `sessionHours`
  only helps a signed-in visitor or a renewed session. Stated in the mint option's doc.
- **Cost:** a verify-required link costs one KV read per view. Links without it make
  no extra read.
- **What a verified session can do:** a recipient who verifies can still screenshot or
  share content. This binds who opens the link, not what they do after.

## Decided questions

1. Defaults: `sessionHours` 24, lock after 5 misses (release coordinator, 2026-11-16).
   The adopter may set `sessionHours` per mint; the lock count is fixed.
2. A lock notifies the creator only, never the recipient (see D3).

## Phases

| Phase | Work |
|---|---|
| P1 | D1 fields + mint validation; D2 gate in `resolveActiveLink`; D3 send/verify/unlock; D4 revoke + eraser; D5 audit. Route-level tests over HTTP, sabotage-witnessed: a forwarded link (another browser) is refused; a code is single-use; a resend voids the previous code; expiry; the 5-miss lock notifies only the creator; the send cap (per link, per day, per IP) holds apart from the lock; unknown, revoked, unbound and bound tokens answer the verification routes identically; revoke and erasure end the session, and erasure revokes before it scrubs; an opt-out link is unchanged. Small PRs, base main |
| P2 | D6 SPA page, four locales, ux-review |

## Implementation record

| Phase | Branch | Tests |
|---|---|---|
| P1 (D1–D5) | `d3/share-link-recipient-otp` | `adr1141-share-link-recipient-verification` 13/13 over HTTP; seven sabotages each red (gate, single use, resend, lock, send cap, revoke cascade, eraser revoke); `subject-erasure-feature-stores` census 36/36 |
