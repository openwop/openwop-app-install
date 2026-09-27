/**
 * Rate limiting + run-quota enforcement (P0.4 of the app.openwop.dev
 * deploy hardening). In-memory, per-process; Cloud Run with min=0
 * means every cold start gets a fresh counter, which is fine for the
 * demo (rate-limit dodging via cold-start coercion is theoretically
 * possible but the user-facing rate is bounded by Cloud Run's own
 * scale-up policy).
 *
 * SEC-3 (docs/steward/CODEBASE-ASSESSMENT.md): under multi-instance scale-out these
 * per-process counters are evadable (each instance has its own budget). A
 * correct fix needs SHARED state checked per request — but that is deliberately
 * NOT done here as a kv/SQL-CAS counter, because it would add a storage
 * round-trip to EVERY request, degrading the very hot path the limiter exists
 * to protect. The production-grade path is a dedicated distributed limiter
 * (Redis/Memcached token bucket, an API-gateway rate limiter, or a managed
 * service) — infrastructure, not a code edit on this middleware. The in-memory
 * limiter remains the correct demo/single-instance default; operators needing
 * hard multi-instance limits front the service with one of the above.
 *
 * Three buckets, ordered from outermost to innermost:
 *
 *   1. Per-IP sliding windows on EVERY request — TWO of them (ADR 0640):
 *      - READS  (GET / HEAD / OPTIONS): default 600/min, never below the
 *        write budget. A feature-rich SPA page load fans out 20+ authenticated
 *        reads; at the old single 60/min budget two navigations exhausted the
 *        minute and the failure presented as a dozen unrelated features
 *        breaking at once. MEASURED 2026-09-06 on a white-label deploy with
 *        nine feature toggles on.
 *      - WRITES (everything else): default 60/min. The expensive and
 *        write-ish bursts this bucket exists to blunt.
 *      Both keyed on the client IP, both evaluated before any handler work, so
 *      an unauthenticated read flood still costs nothing past this middleware.
 *
 *   2. Per-session run quota on POST /v1/runs:
 *      - 10 runs/minute  (sliding window)
 *      - 50 runs/day     (UTC midnight reset)
 *      - 5 concurrent runs (in-flight count, released when the run
 *        terminates — currently approximated by a 60s TTL on the
 *        in-flight set; real production would hook into run.completed
 *        events for exact tracking).
 *
 *   3. Per-IP run quota fallback when a request has no session cookie
 *      (Bearer-authed conformance harness bypasses cookies):
 *      - 60 runs/day per IP
 *
 * Tunables via env (defaults shown):
 *   OPENWOP_RATELIMIT_DISABLED=true               disables all checks
 *   OPENWOP_RATELIMIT_IP_REQS_PER_MIN=60         non-read (write-ish) requests
 *   OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN=600   GET/HEAD/OPTIONS; floored at the
 *                                                write budget so an operator who
 *                                                raised the old single knob is
 *                                                never LOWERED by the split
 *   OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN=10
 *   OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY=50
 *   OPENWOP_RATELIMIT_SESSION_CONCURRENT=5
 *   OPENWOP_RATELIMIT_IP_RUNS_PER_DAY=60
 *   OPENWOP_FORCE_RATE_LIMIT=true   conformance affordance — forces a tiny
 *                                   per-IP budget (3/min, BOTH buckets) so the
 *                                   harness can deterministically induce a
 *                                   canonical 429. Under FORCE the discovery
 *                                   exemption below is SUSPENDED: the suite's
 *                                   `rate-limit-envelope` scenario bursts
 *                                   GET /.well-known/openwop to observe the 429,
 *                                   and #3679's exemption made that scenario
 *                                   skip its own assertions on this host.
 *
 * Returns 429 + canonical `rate_limited` envelope per
 * spec/v1/capabilities.md §3 + a `Retry-After` header.
 */

import type { Request, RequestHandler } from 'express';
import { createLogger } from '../observability/logger.js';
import { onRunTerminal } from '../executor/runLifecycle.js';

const log = createLogger('middleware.rateLimit');

interface Limits {
  ipReqsPerMin: number;
  /** ADR 0640 — GET/HEAD/OPTIONS budget, floored at `ipReqsPerMin`. */
  ipReadReqsPerMin: number;
  sessionRunsPerMin: number;
  sessionRunsPerDay: number;
  sessionConcurrent: number;
  ipRunsPerDay: number;
  /** MCP-1 (ADR 0087 OQ-2) — per-principal budget for inbound MCP `tools/call`,
   *  layered on the per-IP floor. Defaults to the per-IP request budget. */
  mcpPrincipalReqsPerMin: number;
}

/** Which specific limiter fired — carried in `details.reason` and mapped to the
 *  canonical `details.scope` closed enum via `RATE_LIMIT_SCOPE`. */
type RateLimitReason =
  | 'ip_request_rate'
  | 'ip_read_rate'
  | 'session_runs_per_min'
  | 'session_runs_per_day'
  | 'session_concurrent'
  | 'ip_runs_per_day'
  | 'mcp_principal_rate';

/** ADR 0395 — the operator system-health panel reads the EFFECTIVE limits
 *  (config, not counters); read-only, superadmin-gated at the route. */
export function snapshotRateLimits(): Limits {
  return loadLimits();
}

function loadLimits(): Limits {
  const n = (k: string, dflt: number) => {
    const raw = process.env[k];
    if (!raw) return dflt;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  // Conformance affordance: OPENWOP_FORCE_RATE_LIMIT=true forces a tiny per-IP
  // request budget so the conformance harness can DETERMINISTICALLY induce a 429
  // (rate-limit-envelope.test.ts) without depending on real load timing. The
  // canonical `rate_limited` envelope is identical to a production 429.
  const forced = process.env.OPENWOP_FORCE_RATE_LIMIT === 'true';
  const ipReqsPerMin = forced ? 3 : n('OPENWOP_RATELIMIT_IP_REQS_PER_MIN', 60);
  return {
    ipReqsPerMin,
    // ADR 0640 — the read tier. Floored at the write budget: before the split
    // the single knob covered reads too, so an operator who raised it (KickTodo
    // ran =600 as a workaround) must not find reads LOWER after upgrading.
    ipReadReqsPerMin: forced ? 3 : Math.max(n('OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN', 600), ipReqsPerMin),
    sessionRunsPerMin: n('OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN', 10),
    sessionRunsPerDay: n('OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY', 50),
    sessionConcurrent: n('OPENWOP_RATELIMIT_SESSION_CONCURRENT', 5),
    ipRunsPerDay: n('OPENWOP_RATELIMIT_IP_RUNS_PER_DAY', 60),
    // NOT tied to `forced` — that flag is the REST conformance harness's per-IP
    // affordance; the MCP per-principal budget has its own env and must not shift
    // under it (MCP-1).
    mcpPrincipalReqsPerMin: n('OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN', 60),
  };
}

/**
 * Map each internal limiter reason to the canonical `details.scope` closed enum
 * required by `rest-endpoints.md §"429 Too Many Requests envelope"`
 * (`"tenant" | "route" | "global" | "key"`). Per-IP buckets are keyed on the
 * source IP → `"key"`; per-session/tenant buckets → `"tenant"`. The specific
 * limiter that fired is preserved in `details.reason` for observability.
 */
const RATE_LIMIT_SCOPE: Record<RateLimitReason, 'tenant' | 'route' | 'global' | 'key'> = {
  ip_request_rate: 'key',
  ip_read_rate: 'key',
  ip_runs_per_day: 'key',
  session_runs_per_min: 'tenant',
  session_runs_per_day: 'tenant',
  session_concurrent: 'tenant',
  // Per authenticated MCP principal (subject-scoped, like the per-session buckets).
  mcp_principal_rate: 'tenant',
};

// ── State (all maps reset per process / cold start) ──

/** Sliding-window per-key request timestamps (ms). */
const ipReqTimes = new Map<string, number[]>();
/** ADR 0640 — the READ tier's window, keyed the same way. */
const ipReadTimes = new Map<string, number[]>();
/** MCP-1 — sliding-window per-principal `tools/call` timestamps (ms). */
const mcpPrincipalReqTimes = new Map<string, number[]>();
const sessionRunTimesMin = new Map<string, number[]>();
const sessionRunCountsDay = new Map<string, { day: number; count: number }>();
const ipRunCountsDay = new Map<string, { day: number; count: number }>();
/** In-flight run set per session, keyed for the per-session concurrency cap.
 *  Slots are bound to the real runId and auto-released on the run's terminal
 *  event by `reserveConcurrentSlot` (via `onRunTerminal`); the 60s entry TTL
 *  is only a backstop for a route that forgets to reserve. */
const sessionInflightRuns = new Map<string, { startedAtMs: number; runId: string }[]>();

function dayBucket(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function pruneWindow(times: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < times.length && times[i]! < cutoff) i++;
  return i === 0 ? times : times.slice(i);
}

/**
 * True only for a genuine direct loopback connection (no proxy hop). Requires
 * the absence of X-Forwarded-For — behind a trusted L7 proxy real traffic
 * always carries XFF, so this can't be reached by spoofing the header. Used to
 * exempt the messaging bridge's self-fetches from the per-IP limiter.
 */
function isLoopbackSelf(req: Request): boolean {
  if (req.header('x-forwarded-for')) return false;
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * The host's long-lived SSE GET endpoints — a single persistent connection,
 * not a burst of reads. Matched on the exact route shape (NOT the
 * client-controlled `Accept` header alone) so this can't be used to slip
 * arbitrary cheap-poll requests past the per-IP bucket: a caller would have to
 * hit one of these exact paths AND request `text/event-stream`, at which point
 * they just get the long-lived stream the route already serves.
 *   - notifications feed:  /v1/host/openwop-app/notifications/stream
 *   - kanban board feed:   /v1/host/openwop-app/kanban/boards/<id>/events
 *   - run-event stream:    /v1/runs/<id>/events  (SSE mode only; its JSON
 *                          polling mode stays inside the budget via the
 *                          Accept gate below)
 *   - channel message feed:/v1/host/openwop-app/channels/<id>/stream   (CS-CH-1)
 *   - channel presence:    /v1/host/openwop-app/channels/<id>/presence (CS-CH-1)
 *   - voice transcripts:   /v1/host/openwop-app/voice/realtime/messages/stream
 * CS-CH-1 (conversation-stack audit): the channel + voice streams previously
 * counted against the per-IP request bucket, so a tab holding a channel open
 * burned budget and a reconnect storm self-perpetuated its own 429s — the
 * exact feedback loop this exemption exists to prevent.
 */
const SSE_STREAM_PATHS: readonly RegExp[] = [
  /^\/v1\/host\/openwop-app\/notifications\/stream$/,
  /^\/v1\/host\/openwop-app\/kanban\/boards\/[^/]+\/events$/,
  /^\/v1\/runs\/[^/]+\/events$/,
  /^\/v1\/host\/openwop-app\/channels\/[^/]+\/stream$/,
  /^\/v1\/host\/openwop-app\/channels\/[^/]+\/presence$/,
  /^\/v1\/host\/openwop-app\/voice\/realtime\/messages\/stream$/,
  /^\/v1\/host\/openwop-app\/present\/[^/]+\/events$/,
];

/**
 * True for an established long-lived SSE stream connection. These are exempt
 * from the per-IP *request-rate* bucket because a session-long EventStream is
 * ONE connection, not a 60/min burst — and counting each reconnect against the
 * burst budget creates a feedback loop where a rate-limited tab's capped-backoff
 * reconnects keep it rate-limited, so the live feed never recovers. Gated on
 * (method=GET) ∧ (known stream path) ∧ (Accept: text/event-stream) so it neither
 * exempts the run-events JSON path nor lets the header bypass other routes.
 */
/** Test-only (GC-FRM-5) — is a path on the SSE exemption list? Pins that the
 *  PUBLIC write surfaces (e.g. /public-forms/:id/submit) stay under the IP
 *  budget while the stream paths stay exempt. */
export function __isSseExemptPathForTests(path: string): boolean {
  return SSE_STREAM_PATHS.some((re) => re.test(path));
}

/**
 * True for an established long-lived SSE stream connection.
 *
 * EXPORTED for ADR 0556 P2: the latency objectives (A2/A3 in `docs/SLO.md`)
 * must exclude streams, because an EventStream's "duration" is how long a
 * browser tab stayed open — routinely minutes — and leaving those in makes a
 * p95 request-latency objective report a number with no relationship to request
 * latency, breaching permanently on a perfectly healthy host.
 *
 * The projection calls THIS PREDICATE rather than matching route templates
 * against `SSE_STREAM_PATHS`, and the difference is not cosmetic:
 * `/v1/runs/:runId/events` serves BOTH an SSE stream and a JSON polling mode
 * (`routes/streams.ts` branches on `Accept`). A path/template test cannot tell
 * them apart, so it would silently drop the JSON polling requests — real,
 * short, latency-bearing traffic — out of the availability picture too. Only
 * the request-level predicate, which is already `(GET) ∧ (known stream path) ∧
 * (Accept: text/event-stream)`, gets that right.
 *
 * Sharing the predicate also means a NEW stream route is excluded from the SLO
 * the moment it joins `SSE_STREAM_PATHS` — one list, one answer, nothing to
 * keep in sync.
 */
export function isLongLivedSseStream(req: Request): boolean {
  if (req.method !== 'GET') return false;
  if (!(req.header('accept') ?? '').includes('text/event-stream')) return false;
  return SSE_STREAM_PATHS.some((re) => re.test(req.path));
}

function clientIp(req: Request): string {
  // Honor X-Forwarded-For when running behind Cloud Run's HTTP load
  // balancer; first hop in the chain is the client. Fall back to
  // socket.remoteAddress for direct/test runs. NEVER trust this
  // header on a network where clients can spoof it; behind a single
  // trusted L7 proxy it's the canonical source.
  const xff = req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0] ?? xff;
    return first.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function sessionKey(req: Request): string {
  // Falls back to IP if no session cookie (e.g., bearer-authed). This
  // lets us still enforce per-IP run quotas on the bearer path.
  if (req.tenantId) return `s:${req.tenantId}`;
  return `ip:${clientIp(req)}`;
}

function rejectRateLimited(
  res: import('express').Response,
  reason: RateLimitReason,
  retryAfterSeconds: number,
): void {
  res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  res.status(429).json({
    error: 'rate_limited',
    message: 'Request denied by rate limit. Try again later.',
    details: {
      // Canonical closed enum per rest-endpoints.md §429.
      scope: RATE_LIMIT_SCOPE[reason],
      // Host detail: which specific limiter fired (non-normative).
      reason,
      retryAfterMs: Math.max(1000, Math.ceil(retryAfterSeconds * 1000)),
    },
  });
}

/**
 * MCP-1 (ADR 0087 OQ-2) — per-PRINCIPAL inbound budget for MCP `tools/call`,
 * layered ON TOP of the global per-IP floor (the IP is the MCP client's — Claude
 * Desktop / a shared gateway — not the user's). Sliding 60s window keyed on the
 * authenticated `principalId`. Returns `true` (and sends the canonical 429
 * envelope) when the caller is over budget; `false` (and records the call)
 * otherwise. `tools/list` and other reads stay on the per-IP floor — only
 * `tools/call`, which executes a workflow run, gets this tighter budget.
 *
 * Residuals (stated, accepted reference-host posture — same as the per-IP
 * limiter): per-instance under Cloud Run scale-out (a distributed limiter is the
 * production path); `mcp-anonymous` callers share one bucket (they are already
 * denied every gated tool, and the per-IP floor still applies).
 */
export function enforceMcpPrincipalRateLimit(res: import('express').Response, principalId: string): boolean {
  if (process.env.OPENWOP_RATELIMIT_DISABLED === 'true') return false;
  const limit = loadLimits().mcpPrincipalReqsPerMin;
  if (limit === 0) return false;
  const now = Date.now();
  const times = pruneWindow(mcpPrincipalReqTimes.get(principalId) ?? [], 60_000, now);
  if (times.length >= limit) {
    const oldest = times[0]!;
    const retryIn = (oldest + 60_000 - now) / 1000;
    log.warn('mcp principal rate limit hit', { principalId, recentCalls: times.length, limit });
    rejectRateLimited(res, 'mcp_principal_rate', retryIn);
    return true;
  }
  times.push(now);
  mcpPrincipalReqTimes.set(principalId, times);
  return false;
}


/** `/.well-known/openwop` read — see the exemption in `ipRateLimitMiddleware`.
 *  GET/HEAD only, exact path only: the method gate is what stops a caller
 *  spending an unbounded budget by POSTing to the same URL. */
function isDiscoveryRead(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return req.path === '/.well-known/openwop';
}

// ── Public middleware ──

/** Global per-IP request bucket. Mount before route handlers. */
export function ipRateLimitMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (process.env.OPENWOP_RATELIMIT_DISABLED === 'true') { next(); return; }
    // Exempt genuine loopback self-traffic (the messaging bridge self-fetches
    // /v1/runs over 127.0.0.1) so all messaging-driven runs don't share one IP
    // bucket. Keyed on the SOCKET address with NO X-Forwarded-For: behind a L7
    // proxy (Cloud Run) real traffic always carries XFF, so a spoofed
    // `X-Forwarded-For: 127.0.0.1` can't bypass — only a direct loopback
    // connection qualifies. Opt out with OPENWOP_RATELIMIT_TRUST_LOOPBACK=false.
    if (process.env.OPENWOP_RATELIMIT_TRUST_LOOPBACK !== 'false' && isLoopbackSelf(req)) {
      next();
      return;
    }
    // A long-lived SSE stream is one persistent connection, not a burst — and
    // charging each capped-backoff reconnect against the 60/min budget keeps a
    // throttled tab's live feed permanently throttled. Exempt it from the burst
    // bucket (run-creation + per-day quotas are enforced elsewhere). See
    // isLongLivedSseStream for the path+Accept gate that prevents header bypass.
    if (isLongLivedSseStream(req)) { next(); return; }
    // Discovery is exempt from the BURST bucket, for the same reason the SSE
    // stream above is: charging it protects nothing and breaks the one read every
    // consumer must make first.
    //
    // MEASURED, not assumed. Certifying this host from a single IP produced a v3
    // bundle with 38 `blocked` rows; grouped by their own `detail`, **30 were
    // "discovery unreachable"** — the conformance suite fetches
    // `/.well-known/openwop` once per scenario and this 60/min bucket throttled
    // it. Those rows are indistinguishable from conformance gaps to anyone
    // reading the bundle, and `blocked` denies certification, so a throttled
    // reader looked exactly like a non-conformant host.
    //
    // The document is public, side-effect-free, cacheable and identical for every
    // caller. The bucket exists to blunt expensive and write-ish bursts; a
    // capability handshake is neither.
    //
    // SCOPED TO GET/HEAD ON THE EXACT PATH. A path-only exemption would let a
    // caller spend an unbounded budget by POSTing to the discovery URL, so the
    // method gate is the security half, not tidiness — same shape as
    // `isLongLivedSseStream`'s path+Accept gate directly above.
    //
    // ...except under OPENWOP_FORCE_RATE_LIMIT. That affordance exists so the
    // conformance suite can INDUCE a 429 deterministically, and the scenario that
    // does so (`rate-limit-envelope`) bursts this very path. With the exemption
    // honoured under FORCE the scenario observes no 429 and skips its envelope
    // assertions — a gate that cannot fail. MEASURED after #3679. (ADR 0640)
    const forced = process.env.OPENWOP_FORCE_RATE_LIMIT === 'true';
    if (!forced && isDiscoveryRead(req)) { next(); return; }
    const limits = loadLimits();
    // ADR 0640 — two tiers, one key. Reads are cheap, already authenticated
    // (this middleware sits after auth) and fan out 20+ per SPA page load; the
    // write bucket keeps the tight budget the limiter was built for.
    const isRead = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    const limit = isRead ? limits.ipReadReqsPerMin : limits.ipReqsPerMin;
    if (limit === 0) { next(); return; }
    const store = isRead ? ipReadTimes : ipReqTimes;
    const reason: RateLimitReason = isRead ? 'ip_read_rate' : 'ip_request_rate';
    const ip = clientIp(req);
    const now = Date.now();
    const times = pruneWindow(store.get(ip) ?? [], 60_000, now);
    if (times.length >= limit) {
      const oldest = times[0]!;
      const retryIn = (oldest + 60_000 - now) / 1000;
      log.warn('ip rate limit hit', { ip, tier: isRead ? 'read' : 'write', recentReqs: times.length, limit });
      rejectRateLimited(res, reason, retryIn);
      return;
    }
    times.push(now);
    store.set(ip, times);
    next();
  };
}

/** Per-session run-quota middleware. Mount on POST /v1/runs only.
 *  Enforces: 10 runs/min sliding window, 50 runs/day, 5 concurrent. */
export function runQuotaMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (process.env.OPENWOP_RATELIMIT_DISABLED === 'true') { next(); return; }
    const limits = loadLimits();
    const now = Date.now();
    const today = dayBucket();
    const key = sessionKey(req);
    const isSession = key.startsWith('s:');

    // Sliding-window minute check
    if (isSession && limits.sessionRunsPerMin > 0) {
      const times = pruneWindow(sessionRunTimesMin.get(key) ?? [], 60_000, now);
      if (times.length >= limits.sessionRunsPerMin) {
        const retryIn = (times[0]! + 60_000 - now) / 1000;
        rejectRateLimited(res, 'session_runs_per_min', retryIn);
        return;
      }
    }

    // Daily total check (session OR IP path)
    if (isSession && limits.sessionRunsPerDay > 0) {
      const bucket = sessionRunCountsDay.get(key);
      const count = bucket && bucket.day === today ? bucket.count : 0;
      if (count >= limits.sessionRunsPerDay) {
        const retryIn = ((today + 1) * 86_400 - Math.floor(now / 1000));
        rejectRateLimited(res, 'session_runs_per_day', retryIn);
        return;
      }
    } else if (!isSession && limits.ipRunsPerDay > 0) {
      const bucket = ipRunCountsDay.get(key);
      const count = bucket && bucket.day === today ? bucket.count : 0;
      if (count >= limits.ipRunsPerDay) {
        const retryIn = ((today + 1) * 86_400 - Math.floor(now / 1000));
        rejectRateLimited(res, 'ip_runs_per_day', retryIn);
        return;
      }
    }

    // Concurrent check (session only)
    if (isSession && limits.sessionConcurrent > 0) {
      const inflight = (sessionInflightRuns.get(key) ?? []).filter((r) => now - r.startedAtMs < 60_000);
      if (inflight.length >= limits.sessionConcurrent) {
        rejectRateLimited(res, 'session_concurrent', 10);
        return;
      }
      sessionInflightRuns.set(key, inflight);
    }

    // ─── Reserve counters (commit on response 2xx; release on error)
    // Express patches: spy on res.statusCode at response time.
    res.once('finish', () => {
      if (res.statusCode >= 400) return; // refused — don't charge
      // ADR 0475 (review H3) — batch run creators (bulk redrive) charge one
      // unit PER MINTED RUN via res.locals.runQuotaUnits; default 1. Without
      // this, a 25-run redrive request cost the same quota as one run — a
      // 25× side door around sessionRunsPerMin/Day.
      const rawUnits = (res.locals as { runQuotaUnits?: unknown }).runQuotaUnits;
      const units = typeof rawUnits === 'number' && Number.isFinite(rawUnits) && rawUnits >= 1
        ? Math.floor(rawUnits) : 1;
      // Commit minute window
      if (isSession && limits.sessionRunsPerMin > 0) {
        const times = pruneWindow(sessionRunTimesMin.get(key) ?? [], 60_000, Date.now());
        for (let i = 0; i < units; i += 1) times.push(Date.now());
        sessionRunTimesMin.set(key, times);
      }
      // Commit daily counter
      if (isSession && limits.sessionRunsPerDay > 0) {
        const bucket = sessionRunCountsDay.get(key);
        if (bucket && bucket.day === today) bucket.count += units;
        else sessionRunCountsDay.set(key, { day: today, count: units });
      } else if (!isSession && limits.ipRunsPerDay > 0) {
        const bucket = ipRunCountsDay.get(key);
        if (bucket && bucket.day === today) bucket.count += units;
        else ipRunCountsDay.set(key, { day: today, count: units });
      }
      // Inflight tracking is wired explicitly via reserveConcurrentSlot
      // in the runs route — it ties to the actual runId AND auto-
      // releases on the run's terminal event via runLifecycle. The
      // middleware no longer pushes a 'pending' placeholder here; the
      // 60s TTL safety-net stays only as a backstop in case a route
      // forgets to reserve.
    });
    // Stash the session key on the request so the route handler can
    // call reserveConcurrentSlot with the real runId once it's created.
    (req as Request & { _sessionKey?: string })._sessionKey = key;
    next();
  };
}

/**
 * Bind a session's concurrent-runs slot to the actual runId, and
 * register an auto-release on the run's terminal event. Called from
 * the runs route after the run record is created.
 *
 * Returns a manual release function for paths that need to release
 * before the executor reaches a terminal state (e.g., a creation-
 * time failure that doesn't go through the run.* lifecycle).
 */
export function reserveConcurrentSlot(req: Request, runId: string): () => void {
  const key = (req as Request & { _sessionKey?: string })._sessionKey;
  if (!key) return () => undefined; // no-op for routes outside the runQuotaMiddleware
  const list = sessionInflightRuns.get(key) ?? [];
  list.push({ startedAtMs: Date.now(), runId });
  sessionInflightRuns.set(key, list);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const cur = sessionInflightRuns.get(key);
    if (!cur) return;
    const next = cur.filter((r) => r.runId !== runId);
    if (next.length === 0) sessionInflightRuns.delete(key);
    else sessionInflightRuns.set(key, next);
  };
  // Auto-release when the executor emits a terminal event for this run.
  // The runLifecycle bus fires once per runId and clears listeners.
  onRunTerminal(runId, release);
  return release;
}

// ── Test affordances ──

export function _resetRateLimitState(): void {
  ipReqTimes.clear();
  ipReadTimes.clear();
  mcpPrincipalReqTimes.clear();
  sessionRunTimesMin.clear();
  sessionRunCountsDay.clear();
  ipRunCountsDay.clear();
  sessionInflightRuns.clear();
}
