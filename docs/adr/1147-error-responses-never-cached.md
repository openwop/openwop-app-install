# ADR 1147 — Error responses are never cached

Status: Accepted (2026-11-17, release-coordinator review; option (b) approved). Implemented in this PR.

Issues: #5841, #6019 (envelope), #6079 (middleware refusals), #6084 (features ratchet).

## Context

An error is an answer about one caller at one moment: a 401 before sign-in, a 403
before a grant, a 404 before a workspace switch or before a page is published.
Behind Firebase Hosting, a response with no `Cache-Control` is cached for 10 minutes
on its URL alone, with no `Vary: cookie` (#5841, measured). A cached error can
therefore outlive the change and reach a different caller.

What had been done before this ADR:

- **#6019** made the error envelope (`errorEnvelope.ts` `emitEnvelope`) set
  `no-store`, keeping a stricter value a route chose (`private, no-store`, ADR 0887 D4).
- **#6079** routed the 17 middleware refusals through the envelope. Measured live on
  `2c83c256e`: an unauthenticated v2 401 had carried no `Cache-Control`.
- **#6084** added shrink-only ratchets for the direct writes that remain.

The ratchets can only hold a number. Measured 2026-11-17 on `ba48f05c9`, they leave:

- **126 direct writes** answering with no `Cache-Control`:
  `res.status(4xx|5xx).json(`, 100 of them in `src/routes` and 26 in `src/features`.
- **Write shapes the regex cannot see:** `status(<variable>).json(` 16 times,
  `.status(4xx).send(`/`.end(` 3 times, and `index.ts`'s catch-all 404.

## Decision

**D1. One exit guard.** `middleware/errorCacheControl.ts` `errorCacheGuard()` is
the first `app.use`, right after the `app.set` lines (see the correction below). It hooks `writeHead` on each response. Node
calls that for an explicit `writeHead` and for the implicit header of the first
`write` or `end`, so every write shape goes through it. On any status ≥ 400:

- `Cache-Control` becomes `no-store`, unless it already contains `no-store`, in which
  case the route's stricter value stays.
- A `Cache-Control` passed in `writeHead`'s own header argument (an object, a flat
  array or `[name, value]` pairs) gets the same rule.
- Other headers, `Retry-After` included, are left alone.
- 1xx–3xx are never touched, so a cached 200 and a 304 stay exactly as the route
  made them.

> **CORRECTED 2026-11-17 (train 288): "mounted first" was literally true and wrong.**
> The first cut mounted the guard on the line before `app.set('case sensitive
> routing', true)`. Express 4 builds the app's router on the FIRST `app.use` and
> copies that setting onto it then, so the router came out case-insensitive. `/RUNS`
> and `/Runs` reached the run-create handler (201, not 404), and
> `path-case-routing.test.ts` went 3/6 red in the train. The guard is now the first
> `app.use` AFTER every `app.set`. The guard test asserts the built router's
> `caseSensitive` flag, plus a `/RUNS` 404, so a future mount above the settings
> fails there. Reading the setting alone is not enough, since it says `true` either
> way. Sabotage: moving the mount back fails both checks.

**D2. One owner of the rule.** `forbidsStoring` and `applyErrorCacheControl` live
in that module. `emitEnvelope` calls
`applyErrorCacheControl` instead of keeping its own copy of the regex, so the
envelope and the guard cannot disagree.

**D3. Weaker headers are logged, not silently dropped.** When a route set a weaker
value on an error (`public, max-age=300`), the guard overrides it and logs
`error_cache_control_overridden` once per method and route pattern. It logs the
pattern (`GET /p/:slug`), never the raw path, which can carry a bearer token (a share
link's `/shared/:token`), and `(no route)` when nothing matched. The set is bounded
at 1000, so the log shows which routes do it without flooding.

**D4. The ratchets stay.** `error-writes-go-through-envelope-ratchet` still holds
middleware at zero direct writes, and routes and features at their measured counts.
The guard makes the remaining writes safe. The ratchets keep the envelope, which also
scrubs and localizes errors, the normal path for new code.

## Alternatives

- **(a) Move each direct write onto `sendError`.** This would scrub and localize
  every error, but covers only what the regex sees. Each new write shape needs its
  own migration, and a missed one is silently cacheable. It is still worth doing file
  by file for the scrub; D4's baselines track that.
- **(c) Both at once.** (a) is a long tail of route edits with no caching benefit once
  D1 lands, so it is left to happen incrementally under the ratchets.
- **A CDN rule.** Firebase Hosting's `headers` config cannot match on status code.
  It would also leave the Cloud Run URL, which SSE and direct callers use, unguarded.

## Consequences

- **Fixed:** a 404 for a page that has not been published yet is no longer cached by
  the CDN for 10 minutes.
- **Accepted cost:** repeated 4xx always reach the origin. Path scanners hit
  distinct URLs anyway.
- **Unaffected:** SSE writes a 200 through `writeHead` (`host/sseChannel.ts`), so the
  guard never touches a stream.
- **No wire change:** `Cache-Control` on an error is host behaviour, so no RFC is
  needed.

## Implementation record

| Phase | What | Evidence |
|---|---|---|
| P1 | `errorCacheGuard` + the shared rule; mounted first in `index.ts`; `emitEnvelope` uses the shared rule | `test/error-cache-exit-guard.test.ts` 12/12 |

`test/error-cache-exit-guard.test.ts` covers:

- a route 4xx with no header, and one with a weaker header;
- a stricter header kept as the route set it;
- `status(<variable>).json`, `.send`, `.end`, and a `writeHead` header object and
  header pairs;
- one override log per route, by its pattern, with no raw path;
- a 429 that keeps `Retry-After`;
- a 200 and a 304 left untouched;
- the catch-all 404 in the real app.

/code-review found and fixed four things before the PR: the raw-path log, the
untested log-once rule, the unhandled pairs form, and a dead export.

Sabotage, by deleting the mount line, fails the catch-all case. An unguarded app
built from the same shapes leaves them header-less.

Run at 1 worker: the 37 files that assert `Cache-Control`, plus the new test and
#6079's refusal test, 38 files, 376/376 (one file is in both). The source-scanning
guard sweep, 54 files, 314/314. `tsc` clean.
