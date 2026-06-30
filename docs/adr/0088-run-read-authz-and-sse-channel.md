# ADR 0088 — Run-read authorization gate + unified SSE channel

- **Status:** Accepted — implemented (PRs #541, #543, #548, #550, #551)
- **Date:** 2026-06-21
- **Scope:** `openwop-app` backend (`backend/typescript/`) — the run-event SSE
  stream + the two host-extension SSE feeds (notifications, kanban boards).
- **Decision type:** Authorization tightening (auth-affecting) + a cross-cutting
  transport seam.
- **Relation to the wire:** none. The run-event stream rides the already-spec'd
  `stream-modes.md` surface; notifications/kanban are non-normative
  `/v1/host/openwop-app/*` host extensions. No RFC required — no new run/event/
  capability shape, no relaxed `MUST`.

### Implementation status

| Phase | What landed | Key tests |
|---|---|---|
| 1 — Authorize run reads | `host/runAccess.loadReadableRun` (scope seam + wildcard bypass + tenant ownership, 404-not-403); all four run-read paths routed through it (`routes/streams.ts` SSE + JSON branch; `routes/runs.ts` `GET /:id`, `/events/poll`, `/debug-bundle`) | `stream-run-authz.test.ts` (10) |
| 2 — Unify SSE transport | `host/sseChannel.openSseChannel` owns headers (incl. `X-Accel-Buffering`), heartbeat, per-key concurrent-stream cap, teardown; all three SSE routes adopt it | `sse-channel.test.ts` (7) |
| 3 — Cap-key correction | wildcard `*` operator principals exempt from the cap (PR #548 — see §3, corrected against the original per-IP fallback) | `sse-channel.test.ts` exemption case |
| 4 — Cross-origin SSE auth | the run-read gate broke the chat SSE in prod (cross-origin to `*.run.app`, where the cookie can't follow). PR #550: signed-in users send their ID token cross-origin. PR #551: a run-scoped **stream capability token** for BYOK-anon (see §6) | `run-stream-token.test.ts` (7) |

Runtime-verified end-to-end (`/verify` against a booted backend): live stream +
clean terminal close, `bufferMs` batch force-flush, cross-tenant 404 on all four
read paths, cap 429 + release-on-disconnect, and the token flow (cross-tenant
SSE 404 without token → mint same-origin → 200 with token → 404 on a bogus one).

---

## 0. Why this exists

Two defects surfaced in an architecture review of the streaming solution:

1. **The run-event SSE stream authorized only run *existence*.** Unlike every
   other run-read path it made no `requireProtocolScope` call and no tenant
   check. Enforcement-off (the demo default), any caller who knew a `runId`
   could stream another tenant's full event log; enforcement-on, a caller denied
   the JSON poll could still read byte-identical data live via SSE — a
   fail-closed RFC 0049 bypass that made the advertised `runs:read` scope a
   dishonest claim. The run *mutation* paths already gated on
   `run.tenantId !== tenantId`; the *reads* were the outlier.

2. **The three SSE routes each hand-rolled transport** (headers + heartbeat +
   `req.on('close')`) and had drifted — heartbeat 15s vs 25s, and the kanban
   feed was missing `X-Accel-Buffering: no` (a latent Cloud Run / Firebase
   buffering bug). There was also no server-side bound on concurrent streams,
   which became material once the per-IP burst limiter was changed to *exempt*
   long-lived SSE (a session-long EventStream is one connection, not a 60/min
   burst — the right call, but it removed the only friction).

## 1. Decision

- **One run-read authorization gate, `loadReadableRun(req, storage, runId)`**,
  used by all four read paths so the boundary cannot drift again. Contract:
  threads `requireProtocolScope(req, 'runs:read')`; wildcard `*` principals read
  across tenants (the trusted-operator escape hatch the runs-list + `:diff`
  routes already use); a run owned by another tenant returns `run_not_found`
  (404, never 403 — no existence leak), mirroring notifications
  `assertTenantOwnership`.

- **One SSE transport seam, `openSseChannel(req, res, { heartbeatMs })`**, owning
  the connection *lifecycle*: canonical headers (incl. `X-Accel-Buffering: no`,
  fixing the kanban feed by construction), a single heartbeat, a per-key
  concurrent-stream cap, and teardown. Routes keep writing their own payload
  frames via `res.write` and register route-specific teardown through `onClose`
  — so no frame wire-shape moves into the helper and the refactor stays low-risk.

- **Concurrency, not rate, bounds SSE.** The per-IP burst limiter exempts
  long-lived SSE; the per-key cap (default 20, `OPENWOP_SSE_MAX_STREAMS_PER_TENANT`,
  `0` disables) is the separate concurrency bound, released on disconnect. This
  is the division the burst-exemption review explicitly called for.

## 2. Alternatives weighed

- **Tenant check inline per route (no shared helper).** Rejected — that is
  exactly how the gap arose (the SSE path was the one route that forgot). A
  single helper is the anti-drift mechanism.
- **403 for cross-tenant reads.** Rejected — leaks run existence to a non-owner.
  404 matches the notifications posture and the run-mutation paths.
- **A connection cap inside `middleware/rateLimit`.** Rejected — the cap needs
  per-connection open/close lifecycle, which the request/response middleware
  doesn't see; it belongs with the stream lifecycle in `sseChannel`.
- **Advertise the cap as a capability.** Rejected — a host resource limit
  returning a canonical `rate_limited` 429 is already within the spec; it is not
  a protocol capability and needs no `/.well-known/openwop` change.

## 3. Correction — cap keying (PR #548)

The first cut keyed the cap by tenant, falling back to source IP when
`req.tenantId` was unset. **That over-bundled the one caller class the rest of
the stack trusts:** wildcard `*` operator principals (API key / conformance /
admin) carry no `req.tenantId`, so every operator integration behind one egress
IP shared a single cap of 20 — a high-fanout run monitor or a live-target
conformance run opening >20 streams would 429 on legitimate traffic.

Corrected: **`*` principals are exempt from the cap entirely** (`capKey` returns
`null`), consistent with `requireProtocolScope`'s wildcard bypass and the burst
limiter's loopback-self trust. Per-tenant and per-IP (anon) buckets are
unchanged. The reasoning trail is kept here rather than rewriting the original
per-IP rationale, per the ADR correction convention.

## 4. Trade-offs accepted

- **In-memory, per-process cap counters** — same single-instance posture as
  `middleware/rateLimit`. Under multi-instance scale-out a tenant's streams
  spread across instances each get their own budget; a hard global cap is
  infrastructure (a shared limiter), not a code edit here.
- **A leading `: open` comment frame** now precedes every stream (new for the
  run-event + notification feeds). It is an SSE comment, skipped by every parser
  (conformance + `sse-resume` stay green); the visible-but-inert wire change is
  accepted for the proxy-flush benefit.
- **Default cap of 20 is per-tenant**, so a single human with many tabs is one
  bucket. 20 is generous for normal use and tunable; revisit if multi-tab humans
  hit it in practice (a per-`sid` key for human sessions is the lever).

## 5. Open questions

| Q | Status |
|---|---|
| Should human (non-`*`) sessions key by `sid` rather than tenant, to avoid a multi-tab user sharing one bucket? | Deferred — 20/tenant is sufficient today; revisit on evidence. |
| Hard multi-instance stream cap (shared limiter)? | Out of scope — infra, not code; same call as `middleware/rateLimit`'s SEC-3 note. |
| Emit a "streams open per key" gauge so an operator can see cap occupancy? | Nice-to-have; the 429 log line carries `current`/`cap` for now. |

## 6. Correction — the gate broke cross-origin SSE (PRs #550, #551)

Phase 1 enforced `run.tenantId === req.tenantId` on the run-event stream. That
is correct on the same-origin JSON paths (the `openwop.session` cookie travels
`/api` → Cloud Run), but the SSE stream hits `config.sseBaseUrl` — on prod a
**different origin** (`*.run.app`, to dodge the Firebase proxy's SSE buffering).
The cookie does not travel cross-origin, so the SSE authenticated as an
unrelated `*.run.app` session whose tenant lagged the caller's → **the first
chat attempt 404'd** (the second worked once the cross-origin session promoted).
Two caller classes, two fixes:

- **Signed-in (PR #550):** the cookie-mode SSE clients dropped the user's
  Firebase ID token. They now send `authedHeaders()` so the bearer token rides
  the cross-origin request; the backend resolves the user's real tenant and the
  gate matches on the first attempt. CORS already permits `Authorization`
  cross-origin and the stream already preflights, so no new round-trip.

- **BYOK-anon (PR #551):** a BYOK user with no account has no token, and an anon
  session cannot tenant-match cross-origin at all. A **run-scoped stream
  capability token** (`host/runStreamToken`, HMAC over `runId:exp` keyed by the
  session secret, 1h TTL) bridges it: the client mints one SAME-ORIGIN via
  `GET /v1/runs/:id/events/token` (where the anon cookie *does* authenticate —
  the endpoint is behind the normal tenant gate, so only the owner can mint),
  then presents it on the cross-origin `…/events?streamToken=…`. `loadReadableRun`
  accepts a valid token as a capability (checked before the scope/tenant path,
  so it also works under RFC 0049 enforcement). A non-owner can neither mint
  (the endpoint 404s them) nor forge (no secret) one. Stateless — no storage,
  verifiable on any instance. The token rides only the cross-origin hop the
  owner already proved same-origin; it does not widen who can read a run.
