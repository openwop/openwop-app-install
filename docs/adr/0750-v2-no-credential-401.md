# ADR 0750 — A major-2 request with no credential is refused 401, never admitted as a minted anonymous session

Status: implemented

## Context

MEASURED 2026-09-24, in the signed certification evidence cut against the live
deploy of `ea9cd39ee` (both the served 2.36.1 bundle and a 2.37.1 cut):
`openwop.requirement.0200.challenge-401` **executed-fail** —
*"a request with no credential MUST be refused 401 before the resource is looked
up (got 403)"*. Reproduced by hand: `GET /api/runs/<id>` with
`OpenWOP-Version: 2` and nothing attached answered `404` **and set a fresh
`__session` cookie** carrying `tier: "anon"`.

`authMiddleware`'s last fallback (`middleware/auth.ts`, after the ADR 0434
`bearerRejected` guard) mints a cookie-per-visitor `anon:<sid>` session (ADR
0015) for any request with no credential and lets it proceed. The in-memory
conformance boot never saw this: it runs with `OPENWOP_AUTH_DISABLE_COOKIES=true`,
which takes the strict-401 branch earlier. ADR 0743 therefore shipped the RFC 0200
challenge honoured in the one posture production does not run.

## The anonymous lane does not make this conformant

An `/architect` options pass (read-only) established, with citations:

- The 401 is not RFC 0200's invention. Every v2 operation declares
  ApiKey/OAuth2/OIDC security (`openwop/api/v2/openapi.yaml`, e.g. `GET
  /runs/{runId}` requires `runs:read`), and `auth.md`'s missing-credential rule is
  401. RFC 0200's own worked example is exactly this request answering 401, and
  §B.3 says a challenge "MUST NOT change any response's status".
- The advertised `anonymous` lane (RFC 0132) is a public agent surface bound
  through an operator-configured capability token, not an admission rule for
  any route. Minting `anon:<sid>` for every caller on every route is ADR 0015's
  cookie-per-visitor, not that lane. §B.1 is triggered by the `oidc` lane.

## Decision (option A of five)

On the **major-2** wire, a request that presents **no credential** (no bearer, no
api key, no session cookie) is refused `401` with `WWW-Authenticate: Bearer
resource_metadata=…` and **no** `error` parameter, before any resource is looked
up. `authMiddleware` checks `negotiatedMajor(req) === 2` immediately before
`mintAnonSession()`. `protocolVersionMiddleware` runs before auth, so the major is
known there, and `auth.ts` already imports that module (no new cycle).

**Protocol clients only.** The refusal applies when ADR 0646's `isProtocolClient`
holds: the request named an `OpenWOP-Version`, or its `Accept` does not PREFER
`text/html`. A browser DOCUMENT navigation to a shared name (`/runs`) is the page's
and still gets the SPA shell. This matters on the day v1 retires, when a header-less
request defaults to major 2. The first cut of this ADR missed it; the ADR 0669
retirement rehearsal (`test/adr0669-v1-retirement-rehearsal.test.ts`) caught it
before merge.

**Major 1 is unchanged**, including the host-extension routes the SPA uses to
bootstrap its session (`/v1/host/openwop-app/users/me`), which still mint.

**The anonymous demo visitor keeps working.** The SPA's one shared v2 fetch path
(`client/runsClient.ts` `sdkFetch`, which the runs, workflows and interrupts
clients all ride) wraps each request in `client/anonBootstrap.ts`
`withSessionBootstrap`. On the no-credential challenge **and only that shape**, it
establishes a session through the deduped `refreshBackendSession()` (`/me`, major
1) and retries once. A challenge that carries `error=` (`invalid_token`, a
credential that was presented and refused) is never retried into a fresh anonymous
identity, which is ADR 0434's "no silent identity switch" rule on the client side.

The SSE stream needs no change. It authenticates with a `streamToken` minted on the
major-1 `/host/openwop-app/runs/{id}/events/token` route, which still mints the
session. Its no-token fallback now reads 401 instead of 404; the caller already
treats both as "no stream", and CORS does not expose `WWW-Authenticate`
cross-origin, so the stream path never attempts the bootstrap.

## Alternatives weighed

| Option | Verdict |
|---|---|
| **A — v2 + no credential → 401; the SPA bootstraps on major 1 and retries once** | **Chosen.** Correct against the RFC text; one backend branch; demo visitors unaffected. |
| B — mint only on browser signals (`Sec-Fetch-*`, `Origin`) | Rejected: a browser with no credential is still admitted, so it passes the suite without honouring the rule. |
| B′ — mint only on a dedicated bootstrap endpoint | Correct, but touches ~543 host-extension calls. |
| C — spec change: an advertised anonymous lane admits no-credential requests | Contradicts RFC 0200's example and RFC 0132 §C; needs an RFC. |
| D — withhold the challenge claim / drop the `oidc` lane in production | Hides a lane the SPA really uses, and the base missing-credential rule stays broken. |
| E — `OPENWOP_AUTH_ENFORCE_BEARER=true` in production | Ends the anonymous demo. |

## Consequences

- A no-credential v2 client (a `curl`, a third-party integration) now gets an
  honest, discoverable 401 instead of an invented anonymous identity whose writes
  landed in a tenant nothing could find again.
- A first-visit SPA request on major 2 costs one extra round trip (`/me` + retry)
  only when it races the shell's own `/me`. The bootstrap is deduped across
  concurrent callers.
- Separately (not changed here): the `anonymous` lane advertises
  `revocation: 'next-request'`, which identity.md §2.2's anonymous row ("—") does
  not list. The schema currently REQUIRES `revocation`, a corpus inconsistency the
  spec steward ruled on (openwop#1540 makes it optional for `anonymous`, riding
  2.38.0). This host drops the value once 2.38.0 is published.

## Implementation

| Change | Where | Pinned by |
|---|---|---|
| v2 + no credential → 401 + challenge, no mint | `backend/typescript/src/middleware/auth.ts` | `test/adr0750-v2-no-credential-401.test.ts` (cookies-ENABLED boot; reverting `auth.ts` reds exactly the headline leg, 1 of 4) |
| Controls: `/me` still mints; a minted session is honoured on v2; a refused bearer is still `invalid_token` with no mint; major 1 unchanged | same file | same test, 3 legs |
| SPA bootstrap + single retry on the no-credential challenge only | `frontend/react/src/client/anonBootstrap.ts`, `client/runsClient.ts` | `client/__tests__/anonBootstrap.test.ts` (5) |

## Extension — major-1 protocol operations (2026-09-30)

ADR 0745 recorded the major-1 mint as a residual "outside RFC 0200's MUST", adding
that if v1's own `auth.md` §3 missing-credential rule were ever measured against the
cookie posture, it belonged in this predicate. It was measured. The v1 floor
`openwop.floor.auth` (`POST /v1/runs` with no credential MUST answer `401` plus the
error envelope) failed on production's b29427fef and 2273db9c6 certification cuts with
`201`, because the mint admitted the call. It was one of major 1's two remaining floor
reds.

**Decision.** The refusal now also covers a credential-less **protocol client** on a
**major-1 protocol operation**: `isV1ProtocolOperationPath` (`protocolVersion.ts`),
meaning a `/v1/…` path whose unversioned twin is in the v2 path manifest.

- **Excluded, still minting.** The vendor host-extension space (`/host/openwop-app`,
  where the SPA bootstraps its anonymous session through `/users/me`) and the
  `/host/sample` test seams. Neither is a protocol operation.
- **Included.** `/host/effect-seams` is a manifest operation, so it is covered.
- **Unchanged.** A browser document navigation that prefers `text/html` is not a
  protocol client, as before.

**Why it is safe for the demo visitor (measured).** The SPA makes no major-1 protocol
calls. All its protocol traffic is major 2 through `sdkFetch`, which already
re-bootstraps on this 401, and its session bootstrap is the vendor `/users/me` route,
which still mints. The white-label and scripts clients send a bearer.

**Tests.**
- `adr0750-v2-no-credential-401.test.ts` pins the floor's exact probe: 401, the
  envelope, and no `set-cookie`.
- The same file pins that a browser navigation is not refused.
- `adr0745-cookie-posture-challenge.test.ts` is inverted: it pinned the mint as
  "today's major-1 behaviour so a change is a decision", and this is that decision.

Sabotage check: reverting the predicate to major-2-only fails both.

**Found alongside, not fixed here.** The SPA's v2 run-list read (`readRunList`,
`client/runsClient.ts`) uses a plain `fetch` without the `withSessionBootstrap` retry.
A cold visit whose list read beats `/me` can surface `listMyRuns failed: 401`. It is
independent of this change and left as a follow-up.

### A `?streamToken=` is a presented credential (found while extending to major 1)

Extending the refusal to major 1 failed `run-stream-token.test.ts` and exposed a live
defect in the **original** major-2 predicate. The SPA opens run-event SSE on the
cross-origin stream base (`streamBase`, `*.run.app`, where the session cookie cannot
follow) with a same-origin-minted `?streamToken=` and no other credential
(`client/streamsClient.ts`). The predicate saw no bearer, no key and no cookie, and
refused `401` before the route could validate the token.

MEASURED on production 2026-09-30: `GET {streamBase}/runs/…/events?streamToken=…`
under `OpenWOP-Version: 2` answers `401 unauthenticated`, and the v1 twin reaches the
route (`404 run_not_found`). So cookie-mode viewers' live run streams on major 2 have
been refused since this ADR shipped, masked wherever the client falls back.

**Fix.** `carriesRunStreamToken(req)` (a GET on `…/runs/{id}/events` with a string
`streamToken`) exempts the request from the no-credential refusal on both majors. The
route validates the token (`loadReadableRun`). A bogus token still falls through to
the tenant gate's `404`.

> **CORRECTED 2026-10-01 — the last sentence is no longer true, and it was the
> wrong answer.** A token-only request whose token fails verification presented
> a credential that was *rejected*; `404 run_not_found` told an expired-token
> viewer their run did not exist. `loadReadableRun` now answers
> `401 invalid_token` when a presented token fails AND the normal scope + tenant
> gate also refuses AND the principal is `anonymousPrincipal` (a fresh mint or a
> returning anon cookie — an identity this host made up, not a credential).
>
> Two things it deliberately does not do. It does not verify the token in the
> middleware: the path id there is the wire id (tenant-bound on major 2) while
> the token is minted for the bare id, so a middleware check risks refusing
> valid streams — the exact outage this section records. And it does not refuse
> on a bad token alone: a same-origin owner whose URL carries a stale token is
> still served by their cookie, and a real credential that does not own the run
> keeps its `404`. `run-stream-token.test.ts` pins all three, on both majors.
> Residual: the anon session is still minted (and its cookie set) on the
> refused response.

**Tests.**
- `run-stream-token.test.ts` pins a cookie-less, token-only stream as NOT refused, on
  both majors.
- **Sabotage:** removing the exemption fails it, along with the existing "valid token
  authorizes" leg.

**Tests that stood in "no credential" for "an anonymous user" or "another tenant".**
Seven suites did this: `stream-run-authz`, `quorum-review`, `crm-tenant-scope-rbac`,
`conversation-resolve-authz`, `i18n-error-envelope`, `adr0755-content-authority` and
`run-stream-token`. They now present a real anonymous session (a signed
`mintAnonSession()` cookie, or the SPA's `/users/me` bootstrap). Each again reaches
the gate it exists to witness (tenant isolation, eligibility, caller resolution,
localized 404, the content gate) instead of stopping at the auth layer's 401.
`adr0755` keeps both legs: the bare write is 401 at the auth layer, and an anon
session's write is refused by the content gate.
