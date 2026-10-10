# ADR 0833 — Users & Authentication: session-lifecycle and federated-login hardening

Status: implemented (pending merge; see § Implementation record)

Feature loop round 2, row 19 (`users`). The round-1 grade (A / A− / A−) was treated
as a claim. A security-first re-measure on `origin/main` @ `97baad74b`, done as three
parallel read-only audits plus my own reading of each cited line, found the defects
below. Each one is proved RED on the unmodified code by a committed test before it
is fixed (see § Witnesses).

This **extends** the always-on `users` feature (no toggle; ADR 0002 graduation note)
and the core auth seams it registers into (ADR 0621 session authority). It is host
work only: every route is under `/v1/host/openwop-app/*` or is a host auth seam. No
run-event, capability or endpoint contract changes, so **no RFC is needed**. The
SAML hardening tightens the RFC 0050 `openwop-auth-saml` behaviour this host already
claims; it does not change the wire.

## Context — what was measured

The host holds no credential store. Firebase Auth owns passwords, password reset and
email change (ADR 0026), so those flows are Firebase's, and the host's account-takeover
surface is **session lifecycle**: the signed stateless `__session` cookie
(`middleware/cookieSession.ts`), the per-user session epoch (ADR 0621), API keys
(ADR 0270/0795), and the federated login lanes (OIDC bind, SAML ACS).

What held up, verified with the guard lines cited in the row-19 grade:

- **Session fixation:** a bound `userId` is taken from a cookie only when its
  personal tenant equals the bearer's (`auth.ts:1166-1171`), and every bind mints a
  fresh random `sid`.
- **Cookie mechanics:** HMAC-SHA256 with `timingSafeEqual`, `exp` enforced, and a
  ≥32-character secret required in production.
- **Mass assignment:** both PATCH routes take explicit allowlists.
- **Cross-tenant `:id` access:** a uniform 404.
- **Linking by email:** nothing does it. Invitation accept needs the token plus
  non-`self` email provenance.
- **OIDC:** `iss`, `aud` and `exp` are checked, and the email is used only when
  `email_verified`.
- **Disable / erase / epoch** are checked on all three HTTP lanes.

What did not hold:

| # | Severity | Defect | Evidence |
|---|---|---|---|
| S1 | **High** | The collaboration WebSocket's cookie lane uses bare `verifySession` and never asks the session authority. A disabled, erased, or "signed out everywhere" account, or a member REMOVED from the shared workspace, can still open that workspace's canvas rooms (Yjs read and write) until the cookie's `exp`. The cookie lane also never re-pins membership. | `host/collab/collabServer.ts:383`; compare the HTTP cookie branch `auth.ts:1484` + `:1515` |
| S2 | **High** | A break-glass session (10 min, `noRefresh`) becomes a 24-hour sliding cookie. `POST /workspaces/<own tenant>/switch` re-mints through `issueSubjectSession`, which drops `noRefresh` and sets `exp = now + 24h`. Break-glass can also mint `owk_` API keys and approve CLI logins, and both outlive the window. | `routes/workspaces.ts:203`, `auth.ts:726-748`, `authBreakGlass.ts:205-219`, `developer-keys/routes.ts:96`, `cliLoginRoutes.ts:84` |
| S3 | Medium | Logout only clears the browser cookie: a copied cookie keeps working. The sliding refresh resets `iat` and `exp` with no absolute ceiling, so a used cookie (including its `mfa` mark) never expires. | `authRoutes.ts:34-39`, `auth.ts:1493-1496`, `cookieSession.ts:29` |
| S4 | Medium | With production cookies (`SameSite=None; Secure`) and `OPENWOP_CORS_ORIGINS` unset, the CSRF Origin guard admits every origin. The guard's own comment assumes "no allowlist ⇒ dev ⇒ Lax", but the two values are read from different env vars. Any body-less cookie POST then forges cross-site: `/users/users/:id/disable`, `/enable`, `/sessions/revoke`. | `middleware/csrf.ts:29,60`, `cors.ts:29-31`, `cookieSession.ts:253-277` |
| S5 | Medium | The SAML `returnTo` / `RelayState` predicate accepts `/\evil.com`, which Express emits unchanged and browsers resolve off-site, so it is an open redirect after SSO. | `routes/authSamlSso.ts:30-32` |
| S6 | Medium | `validateInResponseTo` defaults to `ifPresent`, and node-saml reads `InResponseTo` from the UNSIGNED outer `<Response>`. A consumed SP-initiated response with that attribute stripped therefore replays until `NotOnOrAfter`. Unsolicited (IdP-initiated) assertions are accepted by default, and no assertion-ID one-time cache exists. | `host/auth/samlSso.ts:116,132-135`; node-saml 5.1.0 `lib/saml.js:513-516,798,1031` |
| S7 | Medium | An ADMIN can disable, delete or session-revoke an OWNER (and so the last owner) wherever the owner's durable row lives in the shared tenant (SAML/SCIM tenants). The `feature.users.nodes.deactivate` node has the same gap. The membership code guards the last owner; the user lifecycle never reaches that code. | `features/users/routes.ts:281-429`, `surface.ts:106-116`, compare `accessControlService.ts:978` |
| S8 | Medium | After an admin DELETEs a user, the user's `owk_` keys in OTHER shared workspaces keep authenticating. `delegationIssuerIsLive` reads a missing row as "a seed actor, allow", and the DSAR key eraser runs in the deleting tenant only. | `accessControlService.ts:1825-1828`, `routes.ts:365`, `apiKeyService.ts:367-375` |
| S9 | Low (latent) | The test-login seam mints a session for ANY subject. Its only guard is `OPENWOP_TEST_AUTH_ENABLED`, with no deployment refusal. | `routes/authTestSeam.ts:34` |
| S10 | Low | Self-lockout and email provenance key on `req.userId`. An admin's own `owk_` key therefore resolves to "not self": it can disable or delete its own issuer and stamp `'admin'` (trusted) provenance on the admin's own email. The profile `emailVerified` flag is derived from `source`, not provenance. | `routes.ts:69-86,259`, `features/profiles/routes.ts:136-139` |
| S11 | Low | The Claude Code device heartbeat re-verifies the key but not its issuer, so a device paired by a since-disabled user stays connected. | `features/claude-code/terminalSockets.ts:122` vs `:154` |

## Decision

One shared predicate per concern, called at every exit, plus a ratchet where the
exit set can grow.

> **Revised before any code by the adversarial `/architect` pass (5 Blockers, 4 Highs).**
> The draft is in git (`da04537b1`); the review table is in § "Pre-code adversarial
> review" below. The headline corrections:
> - D3 revokes a session **family**, not one `sid`, and its rows are CAS-written.
> - The absolute lifetime is a cap on `exp`, so it needs no new refusal code and no
>   wire change.
> - D2 builds every session payload in ONE function.
> - D5 keeps IdP-initiated SAML ON. Turning it off did not stop the login CSRF it
>   was meant to stop.
> - D7 revokes the keys instead of relying on a marker that a re-provisioned
>   account would defeat.

**D1 — One live-cookie resolver for every lane that reads the cookie (S1, S11).**
Extract the HTTP cookie branch's decision into an exported
`resolveLiveCookieSession(raw)` in `middleware/auth.ts`. It runs, in order:

1. `verifySession`
2. `assertSessionSubjectLive` (throws the typed refusal)
3. the shared-workspace membership re-check (a non-member is reported re-pinned to the
   personal tenant)
4. the `requireMfa` posture of the active tenant (review M2)

The HTTP cookie branch uses it. So does the collab WebSocket cookie lane, which
**denies** on a refusal (401), a re-pin (403, since a socket cannot be re-pinned) or
an MFA gap (403).

Ratchet (review M1): a source scan fails on any file outside `middleware/` that reads
the `COOKIE_NAME` cookie. The allowlist holds:
- the CSRF guard: posture only, no identity
- `routes/migrate.ts`: an anon-sandbox read that only moves anon data into the
  caller's already-authenticated personal tenant
- `routes/credentialLaneSeams.ts`: the test seam, env-gated

Each entry carries its reason in the test. The device heartbeat adds
`apiKeyIssuerRefused` beside `verifyApiKey`.

*Out of scope, stated:* sockets already OPEN are not torn down on revocation (a
cross-instance per-subject close hook, `USERS2-CD-F1`). A collab ticket stays valid
for its 2 h TTL after its mint-time check. Both are bounded; the cookie lane was not.

**D2 — One session-payload builder; a re-mint never widens its source (S2; review B5, H2).**
`cookieSession.ts` gains `buildSessionPayload(fields, { source?, freshAuth? })`. Every
`signSession(` call site uses it:
- the anon mint
- the bearer promotion
- `issueUserSession` / `issueSubjectSession`
- break-glass
- the test seam

A ratchet pins `signSession(` callers to that list. The source is an **explicit
parameter**, never read off the request. The switch route passes the verified cookie
the middleware recorded (`req.cookieSession`, user-tier only; an anon cookie is never
a source).

From a source the builder inherits:
- `noRefresh`
- `fid` (D3)
- `authAt` (D3)
- `exp = min(source.exp, now + TTL)` when `noRefresh` is set

Break-glass cannot mint an `owk_` key. `issueApiKey` itself refuses a `createdBy`
that is `breakglass:*`. That covers the CLI-login and pairing lanes, which mint at
POLL time with no request (review B5). The rotate route refuses a break-glass caller,
because rotation hands the caller a fresh plaintext for another person's key. The key
mint and CLI approve routes refuse early for a readable error. "Durable credential"
means `owk_` keys here; other secrets a session can mint (UCP client secrets) are
filed as `USERS2-CD-F6`, not claimed.

**D3 — Logout ends the session family server-side; the absolute lifetime caps `exp` (S3; review B1–B3, H1, M3, M4).**

- **Family id.** Every payload carries `fid`, minted only on a fresh authentication:
  - a verified bearer with no same-identity cookie
  - a SAML assertion
  - break-glass
  - the test seam

  Every re-mint, refresh and re-pin inherits `fid`. A legacy cookie's `fid` is its
  `sid`.
- **Revocation list.** The user row gains `revokedFamilies: [{ fid, until }]` with
  `until = revokedAt + COOKIE_TTL_SECONDS`. A refresh cannot run after revocation,
  because the check precedes it, so no copy can outlive `until` (review B2).
- **No new read.** The session authority already reads that row on every user-tier
  request; it returns the list, and `assertSessionSubjectLive` refuses a listed `fid`
  as `session_revoked`. Expired entries are pruned on write.
- **Overflow.** At more than 32 live entries the logout bumps the epoch instead (sign
  out everywhere). A live entry is never evicted.
- **Logout lanes.** Logout reads the family from `req.cookieSession`, which the
  middleware sets on both the cookie and the bearer branch (review M3). It appends
  the family, then clears the cookie.
  - An unbound OIDC session with no durable row has nothing to revoke against, so
    it is cleared only, as today.
  - An anon session is cleared only.
  - Break-glass has no row and is cleared only; its 10-minute `noRefresh` window is
    the bound.
  - All three are stated and tested.
- **CAS writes.** Every user-row writer goes through `swapUserRow`:
  - `upsertFromPrincipal`
  - `updateUser`
  - `applyIdpEmail`
  - the eraser

  A ratchet allows `store.put(` only in `createUser`. This also closes a
  pre-existing race: a SAML re-login's blind `put` could overwrite a concurrent
  disable and its epoch bump (review B3).
- **Absolute lifetime.**
  - Every payload carries `authAt` = the SERVER time at which a bearer or assertion
    was verified on that request. It is never the IdP's `auth_time`; Firebase's is
    the original sign-in, so using it would mint already-expired cookies in a loop
    (review H1).
  - The builder caps `exp ≤ authAt + OPENWOP_SESSION_ABSOLUTE_MAX_HOURS` (default
    720, i.e. 30 days). Reaching the cap is therefore an ordinary `exp` expiry,
    handled exactly as today's, with **no new error code and no wire change**. That
    drops the draft's `session_expired` (review M4).
  - The bearer branch re-promotes when the cookie's `authAt` is older than 24 h, so
    an active user who keeps sending a valid Firebase bearer never hits the cap.
  - A legacy cookie with no `authAt` gets `authAt = now` at its next mint or
    refresh, so the deploy causes no mass sign-out.
- **ADR 0621 note.** This reverses ADR 0621's "no per-session revocation"
  alternative; a correction note is added there.

**D4 — One credentialed-origin predicate for CSRF and the collab socket (S4; review H3).**
`cors.ts` gains `credentialedOriginAllowed(origin, req)`:

- An explicit `OPENWOP_CORS_ORIGINS` uses the allowlist (unchanged).
- With no allowlist and a cross-site cookie (`sessionCookieIsCrossSite()`, exported
  from `cookieSession.ts`, the same SameSite decision it makes), only a
  **same-origin** request passes.
  - The full origin (scheme + host + port) must equal the request's own origin
    (`X-Forwarded-Proto` + the first `X-Forwarded-Host` value, else `Host`) or
    `PUBLIC_BASE_URL`'s origin.
  - `Origin: null` is refused.
- With no allowlist and a `Lax` cookie, dev behaviour is unchanged.

A browser cannot set forwarded headers cross-site, and a non-browser client is not the
ambient-cookie threat. Both the CSRF guard and the collab upgrade call it.

**D5 — SAML: one safe-redirect predicate and single-use assertions (S5, S6; review H4, M8).**
- **One safe-redirect predicate.** Move `isSafeInAppPath`
  (`features/notifications/agentTools.ts:34-43`, which rejects `//`, `\`, whitespace
  and control characters) to `host/safeRedirect.ts`. The SAML login and ACS,
  `connections/oauthFlow.ts`, `byok/copilotOAuth.ts` and the notifications tool all
  use it.
- **Single-use assertions.** Every accepted assertion is single-use. `samlValidate`
  reads `Assertion@ID` and `Issuer` from the signature-verified assertion XML and
  refuses when the ID is absent. It claims `saml:assertion:<sha256(issuer|id)>` with
  `kvCompareAndSwap(key, null, { claimedAt })`; a lost claim is refused. This is
  load-bearing, not a backstop: the InResponseTo cache's `get` + `remove` is not
  atomic, and the outer InResponseTo is unsigned. When the ACS has no storage it
  refuses rather than skipping the check.
- **Aging.** Claimed ids are aged out by a `kvAgeOut` prefix rule on `claimedAt`
  with a 2-day TTL, far above any IdP's `NotOnOrAfter` window plus skew.
- **IdP-initiated stays ON (`ifPresent` default).** The draft's reason for turning it
  off was login CSRF, which the change does not stop: the request-id cache is
  server-wide, so an attacker can complete an SP-initiated flow and auto-POST that
  first-use response from the victim's browser. Binding the AuthnRequest to the
  browser is the real fix, filed as `USERS2-CD-F5`.

**D6 — Only an owner may act on an owner (S7, `UAUWF-8`; review M5).**
`assertMayActOnUser(tenantId, actorSubject, target)` lives in
`features/users/usersGuards.ts`. It refuses `403 owner_required` when the target holds
the `owner` role in the tenant (`holdsOwnerRoleInTenant` on the target's `userId` and
`principalId`) and the actor does not.

- **Actor.** The actor is the RAW principal subject. An `apikey:` delegation never
  holds roles (ADR 0797), so a key cannot act on an owner. D9's issuer resolution is
  for "is this me", not for authority.
- **Who calls it.** Disable, delete, admin session-revoke and the
  `ctx.features.users.deactivate` surface. Enable stays ungated.
- **Ratchet.** It fails on a `setUserStatus(` / `deleteUser(` / `bumpSessionEpoch(`
  call in `features/users/` outside a function that calls the predicate. The allowlist
  holds the `/me` self-service lanes. SCIM lanes are IdP-authoritative and out of
  scope by design.
- **Residual race (stated).** Two owners disabling each other at the same instant can
  leave both disabled. Each act is authorized; the recovery is an operator
  re-enable. Filed as `USERS2-CD-F7`.

**D7 — Deleting a user revokes their keys everywhere (S8; review B4).** A new core
seam, `host/subjectCredentialRevocation.ts`, provides
`registerSubjectErasedHandler(fn)` / `notifySubjectErased(subjects)`. The users DELETE
lane calls it with `{ userId, principalId }` after the erasure fan-out succeeds and
before `deleteUser`.

- **developer-keys** registers a handler that does two things:
  - revokes every key `createdBy` either form, in EVERY tenant (one global scan, the
    `rekeyIssuedKeys` shape; once per deletion, never on a request path);
  - cancels that subject's approved-but-uncollected CLI logins.
- **claude-code** registers the same cancellation for pending pairings.

The deterministic `userIdFor` can re-create the same id on re-provisioning, so no
marker is relied on: the keys are dead. `accessControlService.ts` is not edited.
Folding "missing row ⇒ not live" into `delegationIssuerIsLive` is left to its owner
(`USERS2-CD-F2`).

**D8 — The test-login seam cannot run in a deployment (S9; review M7).**
`registerTestAuthSeam` refuses to register, and `main()` refuses to boot, when
`OPENWOP_TEST_AUTH_ENABLED=true` and `deploymentMarker()` (ADR 0754) is non-null.
There is no escape hatch (the ADR 0745 D4 posture). Every CI, e2e and
release-conformance boot uses `memory://` with no platform marker, so all of them
still pass.

`OPENWOP_TEST_SEAM_ENABLED`'s credential-lane seams are left alone, because they mint
only for an already-authenticated caller in its own tenant (ADR 0573) rather than for
an arbitrary subject. Folding them under the same marker is `USERS2-CD-F8`.

**D9 — One acting-human resolver (S10; review M6).** `actingHumanUserId(req)` is
evaluated in this order:

1. `req.userId`
2. for an `owk_` key, the key's issuer resolved to a durable `userId` through the
   subject→userId resolver (covering `oidc:` issuers, not only `user:`)
3. the resolved caller

`refuseSelfLockout` and the PATCH provenance check use it. The profile
`emailVerified` flag becomes `effectiveEmailProvenance(user) !== 'self'`. That is
EXACTLY the invitation gate's predicate (`invitationsService.ts:453`), and it moves to
one exported function that both call.

## Pre-code adversarial review (2026-10-05, `/architect`, on `da04537b1`)

| Id | Sev | Finding | Folded into |
|---|---|---|---|
| B1 | Blocker | Revoking one `sid` misses earlier cookies that re-mints left valid (switch, promotion) | D3 family id |
| B2 | Blocker | A revocation entry's `exp` can predate a refreshed copy's; eviction re-admits | D3 `until` bound, overflow ⇒ epoch |
| B3 | Blocker | Blind `put` writers race the logout append (and today, a concurrent disable) | D3 CAS-only writers + ratchet |
| B4 | Blocker | A deterministic `userIdFor` re-creates the deleted id, which defeats a marker | D7 revoke keys everywhere |
| B5 | Blocker | CLI-login and pairing mint at POLL time with no request; rotate is a fourth lane | D2 refusal inside `issueApiKey` + rotate |
| H1 | High | An active Firebase user would be signed out every 30 days; `auth_time` loops | D3 server-time `authAt` + 24 h re-promote |
| H2 | High | Three mints bypass the issue functions; a request-scoped ceiling leaks into logins | D2 one builder, explicit source |
| H3 | High | The collab WebSocket has the same reflect-any origin hole as CSRF | D4 shared predicate |
| H4 | High | Default-off IdP-initiated SAML does not stop login CSRF | D5 keeps it on; `USERS2-CD-F5` |
| M1–M9 | Medium | Ratchet allowlist, MFA gate, logout `sid`, wire code, actor rule, provenance parity, TEST_SEAM, `kvAgeOut` shape, "durable credential" scope | D1–D9 as cited |

> **Root cause of S8, and who owns it (recorded 2026-10-05 at team-lead's
> request).** S8 comes from `delegationIssuerIsLive` in
> `host/accessControlService.ts`. It reads a MISSING user row as "a seed actor
> this host never registered ⇒ live". That file belongs to the parallel
> org-seam-fix row, whose decision record is `0832-org-scope-seam-floor.md` (on its
> branch; unmerged when this was written). This ADR was
> reserved as 0832 seven seconds after that one and was renumbered to 0833.
> D7 closes the hole at the users DELETE exit and does not touch that file:
> revoke-everywhere runs through `notifySubjectErased`. Folding "missing row ⇒
> not live" into the predicate itself is `USERS2-CD-F2`, owned by that row.
>
> **Team-lead's prod sizing (read-only, 2026-10-05).**
> - **S1 is LIVE-reachable.** `realtime-collab` is in beta with an override ON
>   for one personal tenant that has 13 members. The exposure is "a removed
>   member keeps canvas read and write for up to 24 h". It is narrow, so it ships
>   in this row rather than as a hotfix.
> - **Not reachable on app.openwop.dev:** S4 (`OPENWOP_CORS_ORIGINS` is set), and
>   S5, S6, S9 and break-glass (their env is unset). They are fixed for adopters.
> - **D4 is fail-closed for cross-site requests** when the allowlist is unset in
>   production; it never reflects any origin.
> - **D8 keys on ADR 0754's `deploymentMarker`, not `NODE_ENV`.** The
>   release-conformance lane runs in production mode on `memory://`.
> - **SAML.** Requiring `InResponseTo` on an SP-initiated response does not need
>   a separate rule. node-saml checks it whenever it is present. A response with
>   the unsigned outer attribute stripped is treated like an IdP-initiated one,
>   so the single-use assertion claim refuses its replay.

## Alternatives weighed

- **Server-side session store** (every cookie a DB row) instead of D3's per-row
  list. This is the classic fix, but it adds a read to every request that ADR 0015
  §0 / ADR 0621 D3 deliberately kept to one point read. The bounded list rides the
  read the request already pays for. Rejected.
- **A separate `sid` denylist KV** read per request. Same objection; rejected.
- **Absolute lifetime of 7 days.** Tighter, but it signs out cookie-only sessions
  every week. 30 days matches the common SaaS default and is configurable. Taken as
  the default, with the knob recorded.
- **Fix S8 inside `delegationIssuerIsLive`** (treat a missing row as dead). Correct
  in principle, but that function serves seed actors and env-key issuers, and the
  file is under a parallel agent's edit. An erasure MARKER read through the
  `!== 'active'` branch was the draft's answer. The review rejected it (B4): a
  re-provisioned account re-creates the same deterministic id. D7 revokes the keys
  instead. Folding the rule into the function stays with its owner (`USERS2-CD-F2`).
- **A new `session_expired` refusal code for the absolute lifetime.** Rejected by the
  review (M4). On v2 it renders as a vendor code, the SPA would not match it, and it
  needs a wire alias. Capping `exp` reuses the expiry path every client already
  handles.
- **Refuse to boot on `SameSite=None` without an allowlist** instead of D4. This would
  brick every white-label install that serves the SPA same-origin. D4's same-origin
  rule protects them and changes nothing for configured deployments. Rejected.
- **Turn IdP-initiated SAML off by default** (the draft's D5). Rejected by the
  review (H4). It is a breaking change for operators using IdP tiles, and it does
  not stop login CSRF, because a first-use SP-initiated response replays from the
  victim's browser just as well. The single-use assertion ID stops replay in both
  lanes. Browser binding (`USERS2-CD-F5`) is what stops login CSRF.

## Market baseline (no `docs/research/*` analysis exists for identity)

The decisions above match the common baseline. The basis is the OWASP Session
Management and SAML Security cheat sheets and NIST SP 800-63B §7, not a fresh market
scan:

- server-side invalidation on logout
- an absolute session timeout in addition to the idle one
- re-authentication-bounded privileged sessions
- unsolicited SAML responses single-use (browser-bound SP requests are the follow-up, `USERS2-CD-F5`)
- one-time assertion IDs
- an owner/super-admin who cannot be suspended by a lower role

The bound-key revocation on account delete follows the same "credentials die with
their issuer" rule as ADR 0795. A full competitive UX scan (Clerk / Auth0 / WorkOS
account-security pages) is left to `/grade-ux` and is out of scope for a security
row.

## Evaluation matrix

1. **Package:** extends `features/users` plus the core auth seams it already registers
   into. The new host modules are `host/safeRedirect.ts` and
   `host/subjectCredentialRevocation.ts`, a registration seam like
   `sessionAuthority`. Core never imports a feature; developer-keys and claude-code
   register their handlers.
2. **Toggle:** none (always-on identity).
3. **`ctx.users`:** `deactivate` gains D6.
4. **Node pack:** `feature.users.nodes` description text gains the owner rule. The
   bump is a patch, and the pack is not pinned by prod chains (checked by
   `check-pack-pin-drift`).
5. **Envelopes:** none.
6. **Agent pack:** none.
7. **Public surface:** SAML login and ACS are public paths. D5 tightens them.
8. **RBAC:** D6 and D9.
9. **Replay:** a refused `deactivate` side-effect records its failure like any other.
   No variant is involved.
10. **Frontend:** no change needed. The absolute cap is an ordinary expiry, and a
    revoked family is the existing `session_revoked`. The entry chunk stays
    untouched.

    > **CORRECTED 2026-10-05 by `/grade-ux` (`USERS2-UX-1`, `-2`).** Both halves
    > were false.
    >
    > - **The cap.** "An ordinary expiry" was not harmless. Before this ADR an
    >   ACTIVE cookie-only user (SAML; anyone whose SPA had no fresh bearer) never
    >   expired, because the cookie slid. At the cap, the expired cookie fell
    >   through to the anon-mint, so the header still showed the account while
    >   writes landed in a throwaway `anon:` tenant. Now a signature-valid
    >   user-tier cookie that has ended is answered `401 unauthenticated` with
    >   `details.reason: 'session_expired'` (`cookieSession.endedUserSession`),
    >   and the cookie is cleared. That is a reason, not a new code, so the wire
    >   verdict below stands. The SPA's ONE refusal choke maps it to a sign-out
    >   with its own localized notice (`auth:sessionRefused_session_expired`
    >   ×4), and the choke now also reads the v2-namespaced host codes
    >   (`USERS2-UX-5`).
    > - **D6's refusal.** It reached the users page as a generic toast that told
    >   an ADMIN to "ask an admin". It is now a designed notice
    >   (`users:ownerRequiredRefused` ×4).
    >
    > Entry chunk measured after both: 131.6 kB gzip, 437 B headroom (was ~520 B).

**RFC verdict:** host-extension. No new error code, event, capability or endpoint
contract. `session_revoked` and its v2 `credential_revoked` alias already exist. Rides
RFC 0050 (`openwop-auth-saml`), Accepted, and narrows only its own acceptance set
(single-use assertions).

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 (collab + device heartbeat) | collab cookie lane refused for a disabled / epoch-bumped / removed member; `COOKIE_NAME`-read ratchet |
| P2 | D2 | break-glass → switch keeps `noRefresh` + `exp`; `issueApiKey` refuses a `breakglass:` issuer (CLI poll + pairing poll covered); rotate 403; `signSession(` caller ratchet |
| P3 | D3 | logout → a copied cookie AND a pre-switch cookie of the same family 401 `session_revoked`; refreshed copy cannot outlive `until`; overflow bumps epoch; `exp` never past `authAt` + cap; legacy cookie grandfathered; `store.put(` ratchet |
| P4 | D4 | prod cookie + no allowlist + cross-site Origin → 403 on HTTP AND the collab upgrade; same-origin → passes |
| P5 | D5 | `/\evil.com` RelayState → `/`; second use of an assertion ID refused (both lanes); missing ID refused |
| P6 | D6 + D9 | admin → owner disable/delete/revoke 403; node same; key self-lockout 409 |
| P7 | D7 + D8 | deleted user's key in another workspace 401 (and after re-provisioning); an approved-uncollected CLI login yields nothing; test seam refuses under a deployment marker |

## Open questions / decisions

- [x] Revocation storage: per FAMILY on the user row, CAS-written (decided, D3 after review).
- [x] Absolute lifetime default: 30 days, configurable (decided).
- [x] IdP-initiated SAML stays on (decided, D5 after review). No operator action needed.
- [ ] Folding "missing row ⇒ not live" into `delegationIssuerIsLive` itself
  (`USERS2-CD-F2`, after org-seam-fix lands).

## Deferred, with reasons (filed, not dropped)

- `USERS2-CD-F1`: closing open sockets (collab, terminal viewer, run SSE) on a
  revocation. Needs a cross-instance per-subject close hook.
- `USERS2-CD-F3`: a trusted-hop `clientIp` for the CLI-login display and rate key.
  `rateLimit.clientIp` is app-wide, so it gets its own change.
- `USERS2-CD-F4`: step-up (fresh `auth_time`) for key mint and CLI approve.
- `USERS2-CD-F5`: binding the SAML AuthnRequest to the initiating browser (login CSRF).
- `USERS2-CD-F6`: break-glass and non-`owk_` session-minted secrets (UCP client
  secrets).
- `USERS2-CD-F7`: two owners disabling each other at the same instant.
- `USERS2-CD-F8`: `OPENWOP_TEST_SEAM_ENABLED` under the deployment marker.
- `CONS-8` / `WF-CONS-12`: DSAR export. Already filed under consent; unchanged.
- `UAUWF-7`: the deferred-instance offboarding event lane. Unchanged.
- Principal issuer-qualification (`oidc:<sub>` is bare). Safe while one OIDC issuer
  is configured. The latent merge on an issuer change stays filed under
  `CONNCD-15` / `CONNWF-5e`.

## Post-implementation grade passes (2026-10-05)

`/grade-code` graded the first cut **B** with **one Blocker in this ADR's own D7**.
`/grade-ux` graded it **B** with two Highs, both from the Frontend line above. All
three are fixed in this PR. The pattern is the same as rows 1–18: the Blocker sat
in the fix itself.

| Id | Sev | Finding | Fix |
|---|---|---|---|
| `USERS2-CD-1` | **Blocker** | D7 matched the bare `principalId` in every tenant. An attacker could `POST /users/users {principalId: <victim userId>}` in their own personal workspace, then DELETE that row, and every key the victim issued would be revoked. Separately, deleting one tenant's `scim:jsmith` revoked a different human's `scim:jsmith` keys in another tenant. | `erasedSubjectIssued`: the `userId` matches everywhere (it is a hash of the tenant and principal, so it cannot be forged); the bare principal matches only in the home tenant. The admin create also refuses `user:` / `apikey:` / `session:` / `breakglass:` / `bearer:` / `agent:` principals. |
| `USERS2-CD-2` | Medium | Anon sessions were capped at 30 days, which stranded the sandbox. | Anon payloads carry no `authAt`/`fid` and are never capped. |
| `USERS2-CD-3` | Medium | The CAS `upsertFromPrincipal` wrote on every login and could 409. | No-op when nothing differs. |
| `USERS2-CD-4` | Low | The credentialed-origin check also applied to the collab ticket lane. | Ticket lane keeps `originPolicy`. |
| `USERS2-CD-6` | Low | A live IdP bearer could mint a key between D7's revocation and `deleteUser`. | DELETE disables the row in the same atomic write as the epoch bump. |
| `USERS2-CD-7` | Low | An in-flight refresh could outlive `until` by one request. | `until` gets 300 s of slack. |
| `USERS2-UX-1` | High | `owner_required` showed as a generic toast. | Designed notice ×4. |
| `USERS2-UX-2` | High | At the cap, cookie-only users became anon silently. | `401 … reason: session_expired` and an SPA sign-out with a reason. |
| `USERS2-UX-5` | Medium | The SPA missed the v2-namespaced refusal codes. | Prefix stripped in the choke. |
| `USERS2-UX-8` | Low | `session_revoked` copy said "on every device". | Neutral copy ×4. |

Filed, not fixed (reasons in the trackers):

- `USERS2-CD-5`: full member scans in the owner predicate. These run on admin mutations only.
- `USERS2-CD-8`: a comment placement issue. Fixed in passing.
- `USERS2-UX-3`: a failed logout is silent. This predates the ADR, though it now matters more.
- `USERS2-UX-4`: hide owner-row actions from non-owners. Needs an `owner` flag on the list read.
- `USERS2-UX-6`, `-7`.

## Implementation record

| Decision | Code | Witness (RED on `97baad74b`, or sabotage-RED where noted) |
|---|---|---|
| D1 | `middleware/auth.ts resolveLiveCookieSession`; `host/collab/collabServer.ts` cookie lane; `features/claude-code/terminalSockets.ts beat()`; `routes/migrate.ts` on the shared verifier | `test/adr0833-collab-live-session.test.ts` (disabled / epoch / removed member); `claude-code-terminal.test.ts` heartbeat case (sabotage-RED); `adr0833-ratchets.test.ts` D1 |
| D2 | `middleware/cookieSession.ts buildSessionPayload` (every mint); `apiKeyService.assertMayIssueDurableKey` inside `issueApiKey` + mint, rotate and CLI-approve routes | `adr0833-session-lifecycle.test.ts` S2 block; ratchet D2 |
| D3 | `revokeSessionFamily` + `revokedFamilies` on the row; the authority returns them; logout; `authAt` cap; `endedUserSession`; every row writer through `swapUserRow` | lifecycle S3 blocks; `auth-session-epoch.test.ts` (xiv) bearer lanes + overflow; ratchet D3 |
| D4 | `middleware/cors.ts credentialedOriginAllowed`, used by `csrf.ts` and the collab cookie lane | `adr0833-csrf-origin.test.ts`; collab S4 case |
| D5 | `host/safeRedirect.ts` (SAML, OAuth, Copilot, notifications); `samlSso.claimAssertionOnce` | `adr0833-saml-hardening.test.ts` (real xml-crypto signature) |
| D6 | `usersGuards.assertMayActOnUser` at disable, delete, admin revoke and the `deactivate` surface | lifecycle S7; `users-surface-authz.test.ts` (sabotage-RED); ratchet D6 |
| D7 | `host/delegatedSubject.notifySubjectErased` + `erasedSubjectIssued`; developer-keys, CLI-login and pairing handlers | lifecycle S8 (incl. re-provisioning) + `USERS2-CD-1` cases (sabotage-RED) |
| D8 | `routes/authTestSeam.testAuthSeamStartupError` in registration + `main()` | `adr0833-test-seam-deployment.test.ts` |
| D9 | `usersGuards.actingHumanUserId`; `usersService.isEmailVouched` (invitation gate + profile badge) | lifecycle S10 |
| UX | `UsersPage` owner notice; `client/sessionRefusal.ts` | `UsersPage.test.tsx`; `sessionRefusal.test.ts` |
