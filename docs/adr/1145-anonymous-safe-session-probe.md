# ADR 1145 — An anonymous-safe session probe

Status: implemented, in a different shape (2026-11-17): #6035 closed issue #5991 on the existing `/users/me` route, and #6065 (the D1 route below) was closed unmerged as superseded. See the correction note under Decision. Accepted 2026-11-16 on the user's go to write and build.

Amends ADR 0750 (v2 no-credential 401) and ADR 0003 (canonical user identity). Host extension only.

## Context

Every signed-out page load logs a console error. The 401 comes from
`GET /api/host/openwop-app/users/me` with code `sign_in_required` (issue #5991). That hurts the
Lighthouse "Browser errors" score and any console-clean check.

- `auth/SignInButton.tsx:229` calls `refreshBackendSession()` on every mount, including in `PublicShell`.
  That calls `getMe()`, and a 401 settles to `{user:null}`.
- `/users/me` is **also the anonymous-session bootstrap** (`client/anonBootstrap.ts`, ADR 0750). The
  auth middleware mints the anon `__session` cookie, then the route throws 401 `sign_in_required`
  because the caller is anonymous (`features/users/usersGuards.ts:44-48`). So a first visit gets a
  fresh cookie **and** a 401 in the same response. That 401 means "you are anonymous", not "missing
  credential".
- The cookie is HttpOnly, and anonymous visitors have one too, so the SPA can't tell the two states
  apart on its own.
- Real refusals must stay refusals. `session_expired`, `session_revoked` and `account_disabled` are
  hard sign-out events (`client/sessionRefusal.ts:61-73`). `sign_in_required` is the ordinary "no
  session" case.

## Decision

> **CORRECTED 2026-11-17: the shape that shipped is not D1.** A parallel fix, #6035
> (400b0ed8e0, merged 2026-11-17 05:01Z), solved #5991 on the existing route instead of a new
> one: `GET /users/me?optional=1` answers **204** with `Cache-Control: private, no-store` when
> the only error is `sign_in_required`. Every other refusal (`account_disabled` 403, the
> middleware's session refusals) still answers as an error, and the plain route still 401s. The
> SPA probes with `getMeIfSignedIn`. The anon cookie is minted on the same route, so the ADR
> 0750 bootstrap is unchanged. Pinned by `backend/typescript/test/users-me-optional-probe.test.ts`
> and `frontend/react/src/auth/__tests__/sessionProbe.test.ts`.
>
> What still holds from this ADR: the probe never caches (D2's `no-store`; with no-store, D2's
> `Vary` adds nothing), real refusals stay refusals, and the SPA reads "nobody signed in" as an
> answer (D3). What did not ship: the `/host/openwop-app/session` route and its
> `{signedIn}` body. #6065 implemented that route, conflicted with #6035 and was closed as
> superseded. D1–D3 below are kept as written, for the reasoning.


### D1 — `GET /host/openwop-app/session`

The probe lives in the always-on `users` feature:
- **Anonymous** (the same `isAnonymous(req)` predicate `requireSignedIn` uses, so the two can't drift):
  `200 {signedIn:false}`.
- **Bound:** `200 {signedIn:true, user}`, with the same user object as `/users/me`.
- A disabled account keeps the 403 `account_disabled`.
- The middleware's own refusals (`session_expired`, `session_revoked`, `bearer_rejected_no_session`,
  the MFA gate) are untouched and still answer as errors.

It mints the anon cookie exactly as `/users/me` does today, so the ADR 0750 bootstrap keeps working.
`/users/me` itself is unchanged; the Users page, `finalizeSession` and API clients keep its contract.

### D2 — Never cacheable

Both branches send `Cache-Control: private, no-store` and `Vary: Cookie, Authorization`, with no ETag.
That is set in the route, not left to `firebase.json` header rules, so a future global header change
can't cache `{signedIn:true,user}` and serve it to the next visitor.

### D3 — The SPA switches its session read

`refreshBackendSession` reads the probe:
- `{signedIn:false}` publishes `{user:null, resolved:true}`;
- `{signedIn:true}` publishes the user;
- transport errors and 5xx keep the FRD-1 rule, "unreadable is not an answer".

The `anonBootstrap.ts` comment names the probe.

## Security

The probe takes no identifier and reports only the caller's own session. There's nothing to
enumerate and nothing an attacker can learn by probing. It is GET-only and mutates nothing beyond the
existing anon mint. Its rate limit is the READ budget (ADR 0640).

## Alternatives weighed

- **A client-side session hint** (localStorage or a JS-readable cookie): rejected.
  - It breaks the anon bootstrap, or just moves the 401 to the first v2 call.
  - A stale hint lies in both directions.
  - Hosting forwards only `__session` to Cloud Run, so the server can't keep the hint honest.
  - It leaves a "this browser signs in here" marker on shared devices.
- **Make `/users/me` answer 200 `{signedIn:false}`:** changes a contract that `finalizeSession`, the Users page, route tests and API clients rely on. Wrong layer.
- **Inject session state into the server-rendered shell:** the shell is cached (TTL shell cache, hour-long bot prerender), so this would cache a signed-in body. Rejected.
- **Skip the probe on public routes:** pricing, trial and bundle pages personalise from the session, so a signed-in visitor would see "Sign in". Rejected.

## RFC verdict

Host extension, no RFC. `/host/openwop-app/*` routes are non-normative, nothing is advertised, and the
v2 wire's no-credential 401 (RFC 0200 §B.1) is untouched.

## Phases

| Phase | Scope |
|---|---|
| P1 | Route + headers; route test with a cookie jar (first visit 200 `{signedIn:false}` + `Set-Cookie: __session`; bound 200 + user; ended 401 `session_expired`; headers on both branches) |
| P2 | SPA store switch + store test (anon → null; 5xx keeps snapshot); `anonBootstrap.ts` comment |
| P3 | Console-clean e2e on `/`, `/p/features`, `/pricing`; protected-route redirect still intact |

## Open questions

None blocking.

## Implementation record

| Phase | Where |
|---|---|
| All phases (D1 route) | #6065: closed unmerged 2026-11-17, superseded |
| The shipped fix (`?optional=1` 204, `getMeIfSignedIn`) | #6035, 400b0ed8e0 |
