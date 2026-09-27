# ADR 0640 — The per-IP rate limit has a read tier, the UI says when it fires, and FORCE can still induce a 429

Status: Accepted — implemented 2026-09-07 (this PR)

## Context

`middleware/rateLimit.ts` has enforced one per-IP budget on every request since
the P0.4 deploy hardening: 60/min, `Retry-After` + the canonical `rate_limited`
envelope, keyed on the first `X-Forwarded-For` hop — which behind Cloud Run's
load balancer is the real client. It was written to blunt cookieless abuse and
expensive bursts.

The first white-label adopter to enable more than a couple of features measured
what it does to a legitimate user (KickTodo, 2026-09-06, nine `kicktodo-*`
toggles on): a single SPA page load fans out 20+ authenticated reads
(`/kicktodo/today`, `/byok/*`, `/orgs`, `/notifications`, `/runs`,
`/kicktodo/metrics/*`, `/roster/*`, `/dashboard/layout`, `/chat/sessions`,
`/approvals`, …). Two navigations exhaust the minute. Two things made it worse
than a tuning problem:

1. **It presented as scattered feature breakage, not as a limit.** Twenty-odd
   distinct endpoints returned 429 in one burst; the operator saw errors on
   unrelated surfaces and reasonably concluded the features were broken. Nothing
   in the UI said "rate limited"; the cause was found by grouping Cloud Run logs
   by status.
2. **60/min is per person.** For an app whose own dashboard costs 20 on load,
   any adopter who enables a handful of features hits it on day one. The live
   host was unblocked with `OPENWOP_RATELIMIT_IP_REQS_PER_MIN=600` — a workaround,
   not a fix, because the default still shipped wrong for the reference app's own
   feature set.

A second defect was found reading the limiter for this ADR. #3679 exempted
`GET /.well-known/openwop` from the bucket (30 of 38 `blocked` rows in a
certification run were throttled discovery reads). The conformance suite's
`rate-limit-envelope` scenario induces its 429 by bursting **that path** under
`OPENWOP_FORCE_RATE_LIMIT=true`. With the exemption honoured under FORCE the
scenario observes no 429 and *skips its envelope assertions* — a gate that
cannot fail, on this host, since #3679.

## Decision

1. **Two per-IP tiers, one key.** Reads (GET / HEAD / OPTIONS) get their own
   sliding window, default **600/min** (`OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN`);
   everything else keeps the original **60/min** (`OPENWOP_RATELIMIT_IP_REQS_PER_MIN`).
   Both are evaluated in the same middleware, before any handler work, so an
   unauthenticated read flood still costs nothing past it. The read tier is
   **floored at the write budget**: before the split the single knob covered
   reads, so an operator who raised it must never find reads *lower* after
   upgrading. A read-tier 429 carries `details.reason: 'ip_read_rate'`,
   `scope: 'key'` — the envelope is unchanged.
2. **Why not "exempt authenticated GETs"** (the adopter's lean): the middleware
   sits after auth, so it is knowable — but an exemption is a zero budget, and a
   zero budget for reads is the discovery mistake generalised: a compromised or
   runaway authenticated client could spend unbounded read work. A larger,
   separate budget keeps the protection and fixes the sizing.
3. **The UI says so, once.** A response observer at `window.fetch` (the only
   seam the 37 direct-fetching client modules share; it reads status +
   `Retry-After` and never alters a request or body) publishes the latest
   deadline; `RateLimitBanner` in the app shell counts it down. One banner
   replaces twelve red surfaces.
4. **FORCE suspends the discovery exemption.** Under `OPENWOP_FORCE_RATE_LIMIT`
   both tiers drop to 3/min *and* the `/.well-known/openwop` exemption does not
   apply, so the suite can induce the 429 it exists to check. Production
   behaviour (exemption on, FORCE off) is unchanged.

## Alternatives weighed

- **Raise the single default** (e.g. 600): fixes the sizing, keeps writes on the
  same generous budget, and leaves the failure illegible. Rejected — the write
  budget was right.
- **Exempt authenticated reads from the burst bucket**: see Decision 2.
- **Leave the number, make the failure legible**: necessary but not sufficient —
  a banner over a correct install that is throttled every two navigations is
  still a broken install.
- **A distributed limiter**: the header's long-standing SEC-3 note stands; this
  ADR changes sizing and legibility, not the per-instance posture.

## Consequences

- An adopter's first page load no longer trips the limiter; a genuine read
  flood still does, at 10× the old threshold, and says so in the UI.
- `snapshotRateLimits()` (ADR 0395 operator panel) gains `ipReadReqsPerMin`;
  the operations hub shows both budgets. The SPA type marks the field optional
  so a newer SPA against an older backend renders unchanged.
- Operators who set `OPENWOP_RATELIMIT_IP_REQS_PER_MIN=600` as a workaround can
  leave it (writes at 600, reads floored to 600) or move it to the read knob.
- CLAUDE.md / AGENTS.md "rate-limit gotcha" and `.env.example` updated.

## Test plan

- `rate-limit.test.ts`: the GET burst now lands in the read tier
  (`ip_read_rate`); reads and writes are separate buckets (exhausting one
  leaves the other untouched, each with its own reason); the read floor
  (default 600 rises to a 900 write budget; an explicit 10 rises to 60); FORCE
  overrides both tiers.
- `ratelimit-discovery-exempt.test.ts`: exemption still holds at 4× budget;
  ordinary reads still throttle; **FORCE induces a 429 on the discovery path**.
- Frontend: `rateLimitSignal.test.ts` (Retry-After parsing incl. HTTP-date,
  extend-not-shrink, observer idempotent/forwards/same-origin only) and
  `RateLimitBanner.test.tsx` (appears on signal, counts down, leaves).
- Sabotage recorded in the PR: the new tests against the pre-ADR middleware.

## RFC gate (wire vs host-extension)

Host-only. The 429 envelope, `Retry-After`, and `details.scope` closed enum
(`rest-endpoints.md §"429 Too Many Requests envelope"`) are unchanged; the new
`details.reason` value is the host's non-normative detail, as `ip_request_rate`
already was. No RFC.
