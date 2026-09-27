# ADR 0621 — Session epoch: a disabled, deactivated or erased account ends its LIVE sessions

Status: implemented (P1–P3 backend, 2026-09-01 — see § Implementation record; P1's SPA hard sign-out choke (D5 / `USERS-UX-13`) and P3's `/users` UI action are the frontend unit's, and P4 closeout is pending) (feature loop 2026-09, iteration 1 — Users & Authentication; closes `UAUWF-2` / the `/grade-code` Blocker of the same iteration)

Extends ADR 0002 (users), ADR 0003 (durable User + `user:<id>` subject), ADR 0015
(workspace-as-tenant, §Phase 0 "no per-request scan"), ADR 0389 (MFA + the
sliding-window refresh), ADR 0434 (membership re-validated per request), ADR
0613 (RFC 0159 combined leaver contract). Host work only — no wire change.

## Context

The disabled status is enforced at **every session mint** since #3304 (USERS-1):
password login and OIDC bind (`features/users/authRoutes.ts:63,79,114,148`), the
production SAML ACS (`routes/authSamlSso.ts:105`), and — since ADR 0613 — the
SAML lane is additionally fail-closed by the cross-lane deny when a SCIM
deactivation names the same IdP subject.

It is enforced **nowhere on a session that already exists.** The `__session`
cookie is a stateless HMAC payload (`middleware/cookieSession.ts:120-143`) with
`COOKIE_TTL_SECONDS = 86_400` (24h, `:28`) and a sliding refresh that re-issues
it whenever fewer than 6h remain (`middleware/auth.ts:1030-1038`,
`REFRESH_THRESHOLD_SECONDS`). Nothing in `middleware/auth.ts` reads
`User.status` per request; `isActiveUser` (`usersService.ts:256`) has exactly
one caller, the SCIM seam's own `isPrincipalResolvable` proof point. The
`/users/auth/logout` route (`authRoutes.ts:36`) clears the caller's OWN cookie
and nothing else. There is no session registry, no revocation list, no per-user
epoch.

So the three lifecycle writes that are supposed to END access —

| Write | Owner | Closes future logins | Ends the live session |
|---|---|---|---|
| Admin **Disable** (`POST /users/users/:id/disable`, `routes.ts:199-215`) | `setUserStatus(id,'disabled')` | yes | **no — up to 24h** |
| **SCIM deactivate** (conformance seam + `/scim/v2` PATCH/DELETE) | `scimProvisioningService.deactivateUser` / `setScimActive` → `setUserStatus` + `denyLinkedSubject` | yes, both lanes (ADR 0613) | **no — up to 24h** |
| **Erase** (`DELETE /users/users/:id`, `routes.ts:232-275`) | `eraseSubject` registry fan-out (ADR 0464) | yes (no User row) | **no — the cookie's `userId` no longer resolves a row, but the middleware never resolves it; the session keeps `user:<id>` as its RBAC subject and every membership row that survived erasure still matches it** |

— all leave the account signed in. The RFC 0159 leaver contract is therefore
honest about the *next* login and silent about the *current* one. Every
enterprise identity product this host is compared against treats "deprovision"
as "sessions end now" (Okta Universal Logout / OIDC back-channel logout, Entra
"revoke sessions", WorkOS session revocation) — **assumption, stated here
because no competitive matrix in `docs/steward/` covers session lifecycle**;
the operator-facing promise ("a fail-closed lockout", `routes.ts:198-199`)
already claims it.

### Why the obvious fix was rejected in ADR 0015 — and why that reason no longer holds

ADR 0015 §Phase 0 rejected "upsert a durable User in auth middleware on every
request" because it "couples middleware → user store + per-request scan"
(`0015:185-186`). Two things changed since:

1. **The middleware already performs a per-request durable read.** ADR 0434 /
   IDN-7 made `isWorkspaceMember(subject, activeTenant)` run on EVERY
   authenticated request whose active tenant is a shared workspace
   (`auth.ts:1055-1064`, `accessControlService.ts:886-892`), keyed on a
   tenant-sliced secondary index — a bounded point read, not a scan. The
   invariant ADR 0015 actually protects is "**no unbounded scan on the request
   path**", and a keyed `getUser(userId)` is the same cost class as the
   membership read.
2. The cost ADR 0015 was avoiding was an **upsert** (a write per request). A
   status check is a read.

## Decision

> **REVIEW CORRECTION (2026-09-01, `/architect` pre-implementation pass, BLOCKER-1).**
> The first draft put the check "in the cookie branch of `middleware/auth.ts`". That
> branch is the one the signed-in SPA does NOT take: in cookie mode the SPA still
> attaches `Authorization: Bearer <id-token>` whenever a cached Firebase ID token
> is fresh (`frontend/react/src/client/config.ts:187-218`, "token takes precedence
> over cookie"), so those requests go through the OIDC bearer branch, which reads
> `boundUserId` from the cookie (`auth.ts` ~`:862-870`) and sets `req.userId`
> (~`:912`) with no User read. Worse, clearing the cookie would not help: the next
> request carries the still-valid IdP token and the promotion mint (~`:924-948`)
> issues a FRESH user-tier cookie — the silent identity re-bind ADR 0434 P2 closed
> for the anon case. D1 is rewritten below to sit at BOTH points where a
> cookie-borne `userId` becomes `req.userId`, plus the promotion mint.

**D1 — Refuse a durable-user session per request at EVERY point a cookie-borne
`userId` becomes `req.userId`.** One `assertSessionSubjectLive(session)` helper
called from (a) the cookie branch (`auth.ts` ~`:1080`, before `req.userId =
session.userId`), (b) the OIDC bearer branch where `boundUserId` is read from
the cookie (~`:862-912`), and (c) the promotion mint (~`:924-948`), which MUST
consult the same authority and refuse to (re-)bind a `userId` that is not
`active` or whose epoch mismatches — so a cleared cookie cannot be re-minted
from a still-valid IdP token. The authority read is a keyed point read
(`getUser(userId)` = one `kvGet`, `hostExtPersistence.ts:382-386`, no cache).
On refusal: clear the cookie (a NEW `clearSessionCookie(res)` in
`cookieSession.ts`, which also replaces the inline clear at `authRoutes.ts:37`),
respond `401` with the canonical envelope `{ error: 'account_disabled' }`
(`'account_erased'` when no row, `'session_revoked'` on epoch mismatch), and do
NOT mint an anon session on that response (the SPA's sign-in modal owns
recovery; a silent anon downgrade would mask the lockout — the
`statecard-failure-silent-swap` lesson).

> **REVIEW CORRECTION (2026-09-02, adversarial review BLOCKER-1 — the sentence
> that used to sit here was FALSE in its premise.** It said the **unbound-OIDC
> lane** (`oidc:<sub>` principal with no `userId`) "has no durable User to be
> disabled" and stated it as the accepted residual. The row EXISTS: the bind
> creates it under the personal tenant, `resolveCallerUser` resolves it by home
> tenant on every route, and `setUserStatus(disabled)` disables that very row —
> yet a bearer-only request after the disable minted a fresh `{tier:'user',
> subject:'oidc:…', no userId}` cookie at the promotion mint, which then got
> `/users/users` 200, `/v1/runs` 200, `POST /workspaces` 201 and a sliding
> refresh forever (a probe over the real `createApp` found it). Same family for
> erase: `resolveCanonicalUserForTenant`'s `existing[0] ?? createUser(…)`
> re-created an ACTIVE row for an erased human on their next bearer request.
> **D1 rev. 2:** the seam gains a READ-ONLY home-tenant read,
> `resolveSessionSubjectByPersonalTenant(personalTenant, subject)` (the
> `users:canonical` pointer → `getUser`, else the deterministic
> `(homeTenant, oidc:<sub>)` id the bind mints under — never the creating
> fold), called from `assertPersonalSubjectLive` for every `tier:'user'`
> session with a `user:`-shaped personal tenant and NO `userId`, on the cookie
> branch AND the bearer branch BEFORE the promotion mint. A disabled row →
> `401 account_disabled`, a tombstoned row → `401 account_erased`, an epoch
> mismatch → `401 session_revoked`; cookie cleared, nothing minted. The
> canonical row's epoch is stamped on the unbound cookie (`SessionPayload.epoch`
> via the promotion mint and `issueSubjectSession`) so "sign out everywhere"
> covers this lane. The residual that REMAINS is narrower and true: a human
> this host has never bound (no row, no pointer) rides the lane untouched —
> there is nothing to refuse — until the first route resolves them.

Break-glass sessions carry
`subject: breakglass:<sid>` and no `userId` (`routes/authBreakGlass.ts:205-218`)
— untouched. Bearer-only requests from a non-cookie client (API clients) are
re-validated by the IdP and bound through `authRoutes.ts:49-90`, which already
refuses `disabled`.

*Cost honesty (review Q1):* `isWorkspaceMember` runs only when the active tenant
is a SHARED workspace (`auth.ts:1058`; the `accessControlService.ts:894` comment
saying "every request" is stale) — so this read runs on strictly MORE requests
than membership does (every user-tier request, personal tenants included). It is
cheaper per call (one keyed get; membership's negative path is a `members.list()`
scan), and it is the cost class ADR 0015 §0 actually forbade (an upsert per
request) that this does not incur. Measured before/after `p50` on `/me` is part
of the P1 witness.

**D2 — `User.sessionEpoch` (integer, default 0) stamped into the cookie.**
`SessionPayload` gains `epoch?: number`; `issueUserSession` (`cookieSession.ts:163`)
gains a REQUIRED `epoch`, so every caller passes it: the OIDC bind
(`authRoutes.ts:90`), the SAML ACS (`authSamlSso.ts:126`), the workspace switch
(`routes/workspaces.ts:184` — carries the current cookie's epoch forward), the
test seam (`routes/authTestSeam.ts:118`), and the middleware promotion mint
(carries `cookieSession.epoch`, or reads the user's current epoch on first
bind). `issueSubjectSession` (unbound subjects) carries no `userId` and is out
of scope. D1's read compares `(session.epoch ?? 0) !== (u.sessionEpoch ?? 0)` →
`401 session_revoked`. The epoch is bumped by ONE function,
`bumpSessionEpoch(userId)` in `usersService.ts` (CAS on the row), called by:

- `setUserStatus(id, 'disabled')` — covers admin Disable AND both SCIM lanes
  (`deactivateUser` / `setScimActive(false)` funnel through it; this is the
  third write of the leaver sequence `UAUWF-2` named);
- the erase route BEFORE `eraseSubject` (`routes.ts:268`), so a cookie minted
  before erasure fails on epoch even in the window where the row still exists;
- a NEW admin action `POST /users/users/:id/sessions/revoke` ("Sign out
  everywhere") gated by the SAME predicate as disable/enable (`routes.ts:205`);
- the self-service `POST /users/me/sessions/revoke`;
- an authenticator removal: `POST /users/me/security/factor-event` with
  `event:'unbound'` (`authRoutes.ts:145-152`).

Re-enable does NOT reset the epoch (a re-enabled user signs in again — old
cookies stay dead by construction).

**D3 — Bounded, not cached.** No in-process memo of the status read (there is
none today either — `DurableCollection.get` is uncached). If measurement ever
shows the read on the hot path, the sanctioned optimisation is a
**negative cache keyed on `(userId, epoch)` invalidated by the bump**, never a
TTL — a TTL is a window with a friendlier name.

**D4 — Anonymous sessions are untouched.** `tier === 'anon'` has no User row and
no epoch; the check is skipped by tier, not by prefix (the ADR 0601 rule).

**D5 — Honesty in the UI, and the client must ALSO sign out of the IdP.** The
`/users` row actions gain "Sign out everywhere"; the disable confirm copy says
what now happens ("ends their active sessions immediately"). The SPA treats
`401 account_disabled|account_erased|session_revoked` as a hard sign-out at ONE
choke (`client/classifyHttpError.ts:112` / `auth/backendSession.ts`): clear
client state, call Firebase `signOut()` and drop the cached ID token —
otherwise the very next request re-promotes (D1 (c) refuses it server-side,
but the client would loop) — then show the sign-in modal with the localized
reason. Today `classifyHttpError` keys on status alone and discards `body.error`
(`:112-118`), so this choke is a precondition of P1, not a follow-up
(`/grade-ux` `USERS-UX-13`).

**D6 — Error posture (review Q2).** A thrown authority read fails THIS request
with a typed `OpenwopError('session_authority_unavailable', …, 503, { retry: true })`
— the same propagate-don't-grant posture the membership read already has
(`errorEnvelope.ts:112-121` turns its throw into a 5xx today) — and MUST NOT
clear the cookie, mint an anon session, or be treated by the SPA as a sign-out
(`backendSession.ts:56-61` already treats 5xx as non-definitive). A storage
blip therefore costs one failed request, exactly as it does for every other
storage-touching route; it never grants and never evicts. Neither native
`EventSource` (`streamsClient.ts:49-54`) nor the fetch stream distinguishes 401
from 503 for reconnect, so the status code is not the hazard — the re-promotion
in D1 (c) was, and is closed.

**D7 — Self-lockout refusal (from `/grade-ux` `USERS-UX-14`).** Disable, erase
and admin revoke REFUSE when `req.userId === target.userId` (`409 self_lockout`),
and the `/users` row hides those actions on the caller's own row. An admin who
must leave uses a peer admin — the same rule membership removal already applies
to the last owner.

## Alternatives weighed

1. **Short-TTL cookie + silent refresh that re-checks status** (e.g. 5-minute
   `exp`, refresh re-reads the user). Rejected: still a window (5 min), a
   refresh storm on every tab, and it makes the break-glass `noRefresh` path
   (ADR 0389 SEC-C2) the only honest one.
2. **Server-side session registry** (a `DurableCollection` row per session,
   revoked by id). Rejected for now: a write per mint + a read per request,
   and it duplicates what the epoch gives for the cases we have (all
   revocations here are per-USER, not per-session). Revisit only if a
   per-device "sign out this device" surface is asked for.
3. **OIDC back-channel logout / SAML Single Logout.** Out of scope: those end
   the IdP session, not this host's cookie; the IdP-driven SCIM deactivation is
   already the trigger we act on. Compose later, do not substitute.
4. **A per-request memo of the status read** — see D3.

## Boundaries audit

- `middleware/auth.ts` is core; `features/users/usersService.ts` is a feature.
  Core must not import features (ADR 0001). The status/epoch read therefore
  goes through a host seam `host/sessionAuthority.ts`
  (`resolveSessionSubject(userId) → {status, sessionEpoch} | null`) that the
  users feature REGISTERS at feature init (the resolver-registry pattern —
  precedent `host/approverResolution.ts:127` `registerSubjectToUserIdResolver`,
  which the same feature already registers). **The seam has NO permissive
  default** (review SHOULD-5 — a fail-open default is a shape, not a
  convenience): unregistered ⇒ a user-tier session carrying a `userId` is
  refused with `503 session_authority_unregistered`, and `createApp` asserts
  registration at boot. The six bare-middleware tests
  (`auth-oidc-cookie-promotion`, `auth-bearer-cookie-fallthrough`,
  `account-delete`, `migrate-tenant`, `auth-oidc`, `insights-suite-governance`)
  mint no `userId`-bearing cookies, so they need no stub — verified by running
  them in P1. **Fail-closed on error:** see D6.
- Note: `middleware/auth.ts:58` already imports `features/developer-keys/apiKeyService`
  directly, so the boundary has one prior crossing; this ADR does NOT add a
  second — the registry seam keeps the middleware feature-free for the users read.
- No route collision: `/users/users/:id/sessions/revoke` and
  `/users/me/sessions/revoke` are new under the feature's own prefix.
- No new toggle: users is always-on (graduated 2026-06-11).
- Replay/fork: sessions are not run state; no stamp needed.
- RFC gate: **host-ext, no RFC** — cookie mechanics are non-normative; RFC
  0050/0159 conformance scenarios are unaffected (they exercise the validate /
  provision seams, not the cookie).

## Phased plan

| Phase | Work | Witness |
|---|---|---|
| P1 | `host/sessionAuthority.ts` seam (no permissive default) + users registers it + boot assertion; D1 refuse-on-status at all three points (cookie branch, bearer `boundUserId`, promotion mint); D6 typed 503; `clearSessionCookie`; D7 self-lockout refusal; SPA hard sign-out choke incl. Firebase `signOut()` | adversarial route tests: (i) mint a user session, `setUserStatus(disabled)`, next cookie-only request → 401 `account_disabled`, cookie cleared, NO anon cookie minted; (ii) same with **bearer + stale cookie** → 401; (iii) **bearer, no cookie** → no user-tier cookie minted (promotion refused); (iv) erase variant → `account_erased`; (v) anon session unaffected; (vi) authority throws → 503, cookie intact, no anon mint; (vii) self-disable → 409; the six bare-middleware tests unchanged |
| P2 | `sessionEpoch` on `User` + `SessionPayload.epoch`; `issueUserSession` REQUIRED `epoch` through all four callers + the promotion mint + the workspace switch; `bumpSessionEpoch` CAS; bumps at `setUserStatus(disabled)`, erase, factor `unbound` | test: two sessions for one user, bump, both → 401 `session_revoked`; a fresh login after re-enable works; SCIM deactivate via BOTH lanes bumps (the leaver sequence is now three writes) |
| P3 | admin + self "Sign out everywhere" routes + `/users` UI action + disable copy | route RBAC test (same predicate as disable), UX pass |
| P4 | closeout: `CODEBASE-ASSESSMENT.md` `USERS-2`/`UAUWF-2` rows, `FEATURES.md` row, this ADR → implemented | — |

## Implementation record (backend, 2026-09-01)

| Phase | Decision | Where | Witness |
|---|---|---|---|
| P1 seam | D-Boundaries: `host/sessionAuthority.ts` — `registerSessionAuthority` / `resolveSessionSubject` / `isSessionAuthorityRegistered`; **no permissive default** (unregistered ⇒ `503 session_authority_unregistered`) | `src/host/sessionAuthority.ts`; registered by `features/users/feature.ts` (`usersSessionAuthority`, a keyed `getUser` projected to `{status, sessionEpoch}`); boot assertion in `createApp` (`src/index.ts`, hard throw after `registerAllRoutes`) | `test/identity-session-binding.test.ts` "with NO session authority registered … 503"; the six bare-middleware tests run unchanged (they mint no `userId` cookie) |
| P1 D1 | `assertSessionSubjectLive(session)` at (a) the cookie branch BEFORE the sliding refresh + membership re-pin, (b) the OIDC bearer branch's `boundUserId`, (c) the promotion mint — by ORDERING: the only `userId` it can carry is the one (b) validated on the same request, and a refused request returns before the mint | `src/middleware/auth.ts` (`assertSessionSubjectLive`, `refuseSession`) | `test/auth-session-epoch.test.ts` (i) (ii) (iii) (iv) (v) |
| P1 D1 refusal | `clearSessionCookie(res)` (NEW, one definition; `authRoutes.ts` logout uses it) + `next(OpenwopError)` → `errorEnvelope` renders `401 {error: account_disabled \| account_erased \| session_revoked}`; NO anon mint (the cookie branch already holds a session; the bearer branch returns) | `src/middleware/cookieSession.ts` `clearSessionCookie`; `src/types.ts` codes | (i) asserts `Max-Age=0` + no anon cookie |
| P1 D6 | authority throws → `503 session_authority_unavailable {retry:true}`, cookie intact, no anon mint | `auth.ts` `assertSessionSubjectLive` catch | (vi) |
| P1 D7 | disable / erase / admin revoke refuse `409 self_lockout` when `req.userId === target.userId` | `features/users/routes.ts` `refuseSelfLockout` | (vii) |
| P2 D2 | `User.sessionEpoch?` (legacy ⇒ 0 via `sessionEpochOf`); `bumpSessionEpoch(userId, mutate?)` — CAS retry on `DurableCollection.compareAndSwap` (bounded 5, never a blind put); `SessionPayload.epoch?`; `issueUserSession` REQUIRED `epoch` through all four callers (bind, SAML ACS, workspace switch, test seam) + the promotion mint carries `cookieSession.epoch` | `usersService.ts`, `cookieSession.ts`, `authRoutes.ts`, `routes/authSamlSso.ts`, `routes/workspaces.ts`, `routes/authTestSeam.ts`, `middleware/auth.ts` | (viii) two sessions → both `session_revoked`; fresh login stamps epoch 1 |
| P2 bumps | `setUserStatus(id,'disabled')` bumps in the SAME atomic CAS write (covers admin Disable + `deactivateUser` + `setScimActive(false)`); erase route bumps BEFORE `removeProfileStrict`/`eraseSubject`; factor-event `unbound` bumps; re-enable does not reset | `usersService.ts`, `routes.ts`, `authRoutes.ts` | (viii) disable→enable stays dead; factor `unbound`; (ix) SCIM both lanes |
| P3 routes | `POST /users/users/:id/sessions/revoke` (gate = disable's: `requireSignedIn` + `requireTenantScope('host:members:manage')`, audit ids-only `users.lifecycle.sessions-revoke`, D7) and `POST /users/me/sessions/revoke` (self; ALSO clears the caller's cookie on the same response — the current session is minted under the old epoch and would die one request later anyway) | `features/users/routes.ts` | (viii) admin revoke + peer 403 + self revoke `signedOut:true` |

| **Rev. 2 (2026-09-02, review BLOCKER-1)** | Unbound-lane read (see the D1 correction): `host/sessionAuthority.ts` `registerPersonalTenantSessionAuthority` / `resolveSessionSubjectByPersonalTenant` (no permissive default; `isSessionAuthorityRegistered` now requires BOTH reads); users registers `usersPersonalTenantSessionAuthority` over `resolveCanonicalUserReadOnly` (READ-ONLY by contract); `middleware/auth.ts` `assertPersonalSubjectLive` on the cookie branch (via `assertSessionSubjectLive`) and the bearer branch before the promotion mint, which stamps the row's epoch; `req.sessionEpoch` exposes the validated epoch | `test/auth-session-epoch.test.ts` (iii) rewritten UNCONDITIONAL (review SHOULD-1) + § (x): disable ends a live unbound cookie and refuses bearer-only `/me`, `/users/users`, `/v1/runs`, `POST /workspaces` with NO user-tier mint; revoke → unbound cookie `session_revoked`, fresh mint carries epoch 1; erase tombstone. Sabotage (the canonical read returning `null`) → 4 red |
| Rev. 2 — erase family | `tombstoneCanonicalPointer(target)` pins the personal tenant's `users:canonical` pointer BEFORE `deleteUser` in the erase route, so the DANGLING pointer is the tombstone; `resolveCanonicalUserForTenant` REFUSES (`401 account_erased`) on a dangling pointer instead of re-picking / creating; the middleware read maps it to `status:'erased'`. Shared/org tenants: no-op (identity is principal-keyed; the bind refuses by row) | § (x) erase: bearer-only + bind → `account_erased`, the fold rejects, `listUsers(home)` stays empty |
| Rev. 2 — SHOULD-2 | `routes/workspaces.ts` switch re-mints from `req.sessionEpoch` (the validated value), refuses `401 session_revoked` + cookie clear when the row's epoch moved past it, `401 account_disabled` / `account_erased` by row (was `403 forbidden` / pass-through), and a bound user with no validated epoch is a typed 500 — never `: 0` | `test/oidc-bind.test.ts` switch lanes |
| Rev. 2 — SHOULD-3 | `refuseIfMfaRequired` exempts "active === personal" ONLY when `isPersonalTenantId(personalTenant)` — a SAML session's personal tenant is `OPENWOP_SAML_TENANT`, so tenant `requireMfa` was never enforced there | § (xii): deployment-named personal tenant + `requireMfa` → 401 `mfa_required`; `user:` tenant exempt |
| Rev. 2 — SHOULD-5 / NIT-1 / NIT-2 | `bumpSessionEpoch` CAS exhaustion → typed `409 conflict {retry:true}` (was a bare `Error` → 500); `refuseSelfLockout` keys on `resolveCallerUser(req)` when `req.userId` is absent (the unbound implicit owner could bypass the 409); the peer in the revoke-gate test is now SEATED (`editor`) and the code asserted `forbidden_scope` | § (xi) bearer-only self disable / revoke / erase → 409 |

**Deviations / notes.**
- **SAML deployment impact (review SHOULD-4), stated:** before USERS-19 every
  SAML user was the implicit owner of `OPENWOP_SAML_TENANT`; authority there is
  now membership-derived (`resolveSubjectScopesUnion` = member roles ∪ ADR 0006
  host-group roles, both keyed on a member row — the SAML ACS provisions the
  User and captures IdP groups verbatim but seats no member row, and captured
  IdP groups are NOT auto-mapped to roles). A SAML-only deployment with no
  member rows answers `403 forbidden_scope` on admin routes until the first
  admin is seated via the wildcard operator key (`OPENWOP_API_KEYS=<key>:*` →
  `POST /orgs/:orgId/members`) or a host group. README § "Who administers the
  SAML tenant" is the operator-facing statement; ADR 0617 D2 carries the
  run-lane confirmation (`features/users/surface.ts:89`).
- **Erase-family decision (rev. 2):** the smallest honest fix was a TOMBSTONE,
  and the `users:canonical` pointer already was one — `deleteUser` never
  removed it, the fold merely treated a dangling pointer as "re-pick". Making
  the fold refuse, the erase route pin the pointer first, and the middleware
  read map "pointer without row" to `erased` closes the re-creation without a
  new store. Consequence, stated: an admin-erased human whose IdP identity is
  unchanged cannot sign back in to this host until the personal tenant is torn
  down (the self-service account delete does that — `users:canonical` declares
  `tenantOf`, so teardown removes the pointer and that lane is a clean slate by
  design). A legacy randomUUID-era row with no pointer is not found by the
  read-only resolver (that needs the fold's scan); it gains its pointer on the
  first `/me`, which the SPA issues on boot — a one-request gap, stated.
- The bare-middleware harnesses (`auth-oidc-cookie-promotion`,
  `auth-bearer-cookie-fallthrough`, `auth-oidc`, `migrate-tenant`,
  `account-delete`) now register both reads: the unbound OIDC lane consults
  the seam, and the seam has no permissive default. The four with no host-ext
  persistence register a `null` personal-tenant read ("no durable row was
  ever bound" — true in those harnesses); `account-delete` registers the real
  reads.
- D1 (c) is satisfied by ordering rather than a second authority read: the promotion mint's `userId` can only come from the cookie (b) just validated on the same request, and a refused request never reaches the mint. A second read would be the same row, same request.
- The "measured `p50` on `/me`" cost witness named under D1 was NOT taken in this PR (no load harness in the backend suite); the read is one keyed `kvGet`, the cost class the ADR argues.
- The workspace switch carries the epoch from the durable row it already reads (`getUser`), not by re-parsing the cookie — the middleware asserted the two are equal on the way in.
- **USERS-19 landed in the same change** (ADR 0617 D2): `assertTenantScope(tenantId, subject, scope, {personalTenant, wildcardOperator})` in `host/accessControlService.ts`; `requireTenantScope` is a thin wrapper; the implicit-owner short-circuit — in `assertTenantScope` AND in `requestSubject.isOwnPersonalWorkspace` (the ONE owner all seven route-level short-circuits share) — fires only for a personal-SHAPED tenant (`isPersonalTenantId`: `user:` / `anon:`). `anon:` is admitted alongside `user:` (the task text named only `user:`) because the anon-demo flows on the assistant/twin/… routes ride the same short-circuit and an `anon:<sid>` tenant is one session's sandbox by construction; `default` is rejected because it is exactly the shape the SAML ACS can mint. Pinned by `test/users-members-manage-gate.test.ts` § USERS-19 and `src/features/__tests__/requireTenantScope.test.ts`.

## Open questions

- [ ] Should `enable` after `disable` require a fresh login (current design: yes,
  by construction) — or should an admin be able to "undo" a mistaken disable
  without the user noticing? Default: fresh login; a mistaken disable is rare
  and the safe direction is the strict one.
- [x] The `503` on a failed authority read — RESOLVED by D6 (review Q2): neither
  EventSource nor the fetch stream distinguishes 401 from 503 for reconnect; the
  real hazard was re-promotion from a valid IdP token, closed by D1 (c).
- [x] Should the unbound-OIDC lane (`oidc:<sub>`, no durable User) get a keyed
  `getUserByPrincipal(personalTenant, subject)` check too? **RESOLVED YES
  (rev. 2, review BLOCKER-1)** — the premise "there is no row to disable" was
  false; see the D1 correction. Implemented as the seam's read-only
  `resolveSessionSubjectByPersonalTenant` (pointer → row, else the
  deterministic principal id; never `getUserByPrincipal`, whose legacy fallback
  is a full scan on the request path).
