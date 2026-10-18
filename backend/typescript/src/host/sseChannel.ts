/**
 * Shared server-side SSE channel — the single owner of the boilerplate every
 * `text/event-stream` route used to hand-roll (headers, keep-alive heartbeat,
 * teardown) PLUS a per-tenant concurrent-connection cap.
 *
 * Why this exists (architecture review #2 + #3):
 *   - The three SSE routes (run events, notifications, kanban boards) each set
 *     headers + ran their own `setInterval` heartbeat + wired `req.on('close')`
 *     independently, and had ALREADY drifted: heartbeat 15s vs 25s, and the
 *     kanban feed was MISSING `X-Accel-Buffering: no` — a latent buffering bug
 *     on Cloud Run / Firebase (which buffer SSE; it's why the SPA hits the
 *     direct *.run.app URL). Centralizing the headers fixes that by construction.
 *   - There was NO server-side bound on concurrent streams. After the per-IP
 *     burst limiter was made to EXEMPT long-lived SSE (#537 — a session-long
 *     EventStream is one connection, not a burst), the absence of a real cap
 *     became the operative limit: a reconnect storm or many tabs could pin
 *     unbounded heartbeats + subscription closures and starve an instance. The
 *     cap here is that bound, released on disconnect — the "concurrency is a
 *     SEPARATE cap" point from the #537 review, made concrete.
 *
 * The split of responsibility is deliberate: this owns the connection
 * LIFECYCLE (cap, headers, heartbeat, end); the route keeps writing its own
 * payload frames via `res.write` and registers route-specific teardown
 * (unsubscribe, aggregation ticks) through `onClose`. That keeps the refactor
 * low-risk — no route's frame wire-shape moves into here.
 */

import type { Request, Response } from 'express';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { clientIp } from './clientIp.js';
import { streamBaseUrl } from './streamBase.js';
import { wireStreamFloorMs, wireStreamMaxAgeMs } from './streamAgeCapability.js';

const log = createLogger('host.sseChannel');

/** Per-tenant (or per-IP, for tenant-less callers) live-stream counts. In
 *  memory / per process — same single-instance posture as middleware/rateLimit
 *  (a multi-instance deploy fronts the service with a shared limiter). */
const streamCounts = new Map<string, number>();

/** Default concurrent-stream cap per key. Generous — a real user holds a few
 *  (notifications + a board + a couple of run streams), so 20 only trips on a
 *  reconnect storm or abuse. Override with OPENWOP_SSE_MAX_STREAMS_PER_TENANT;
 *  0 disables the cap. */
const DEFAULT_MAX_STREAMS = 20;

/** ADR 0395 — the operator system-health panel's snapshot: total live SSE
 *  streams + the top holders, THIS process only (the counts map is per
 *  process — a multi-instance deploy sees one revision-instance's view; the
 *  panel renders that caveat). Read-only, superadmin-gated at the route. */
export function snapshotSseStreams(): { totalStreams: number; keys: number; max: number; top: Array<{ key: string; streams: number }> } {
  let total = 0;
  const rows: Array<{ key: string; streams: number }> = [];
  for (const [key, count] of streamCounts) {
    total += count;
    rows.push({ key, streams: count });
  }
  rows.sort((a, b) => b.streams - a.streams);
  return { totalStreams: total, keys: streamCounts.size, max: maxStreams(), top: rows.slice(0, 10) };
}

/** ADR 0897 — default server-side lifetime of a stream. Cloud Run over
 *  HTTP/1.1 never tells the container a client left (MEASURED 2026-10-15: a
 *  20 s client's stream ran 3601 s, direct and via `/api` alike), so the only
 *  bound on how long an abandoned stream holds its cap slot is one the server
 *  imposes. Five minutes means a caller needs more than 20 abandoned streams
 *  inside five minutes to reach the cap, at the cost of one reconnect per open
 *  stream every five minutes. `OPENWOP_SSE_MAX_AGE_MS` overrides; 0 disables
 *  the default (an explicit `maxAgeMs` still applies). */
const DEFAULT_MAX_AGE_MS = 300_000;

/** ADR 0897 — lifetime on a front-door hop (Firebase Hosting buffers a
 *  response and retries an upstream that has not completed in 60 s). Under 60 s
 *  the buffered response completes, so the hop delivers it and stops retrying:
 *  an opted-in wire stream through `/api` becomes a long poll instead of a 503
 *  and a dozen held slots. RFC 0247's floor is 15 s. */
export const FRONT_DOOR_MAX_AGE_MS = 50_000;

/** Reconnect delay sent as the SSE `retry:` field before a bounded close. */
export const BOUNDED_CLOSE_RETRY_MS = 1_000;

export function defaultMaxAgeMs(): number {
  const raw = process.env.OPENWOP_SSE_MAX_AGE_MS;
  if (raw === undefined) return DEFAULT_MAX_AGE_MS;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX_AGE_MS;
}

/** RFC 0247 — the consumer's opt-in to a bounded close. Query, not a header,
 *  because a browser `EventSource` cannot set headers. */
export function streamIsResumable(req: Request): boolean {
  return req.query?.resumable === 'true';
}

function maxStreams(): number {
  const raw = process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT;
  if (raw === undefined) return DEFAULT_MAX_STREAMS;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX_STREAMS;
}

/** Cap key, or `null` for callers EXEMPT from the cap.
 *
 *  Trusted operator principals (`tenants: ['*']` — API key / conformance /
 *  admin) are exempt: the same wildcard escape hatch `requireProtocolScope`
 *  honors and the burst limiter's loopback trust. Without the exemption every
 *  operator integration behind one egress IP would fall to the `ip:` bucket
 *  below and share ONE cap, so a high-fanout monitor or a live-target
 *  conformance run opening >cap streams would 429 on legitimate traffic.
 *
 *  Everyone else is keyed by tenant (so one tenant can't starve others),
 *  falling back to the client address for tenant-less anon callers (the one
 *  `host/clientIp` reading, ADR 0851). */
function capKey(req: Request): string | null {
  if (req.principal?.tenants?.includes('*')) return null;
  if (req.tenantId) return `t:${req.tenantId}`;
  return `ip:${clientIp(req)}`;
}

export interface SseChannel {
  /** Register route-specific teardown (unsubscribe, clear aggregation ticks).
   *  Every registered hook runs exactly once, in registration order, on the
   *  FIRST of: client disconnect, `close()` or the bounded close.
   *  ADR 0897: this used to keep only the LAST hook, so the channel presence
   *  route's access watch silently replaced its presence `leave` — a viewer
   *  stayed present after disconnecting until the instance recycled. */
  onClose(cb: () => void): void;
  /** End the stream: clears the heartbeat, releases the cap slot, runs the
   *  onClose hook, and `res.end()`s. Idempotent. */
  close(): void;
  /** True once the stream has been torn down (disconnect or `close()`). */
  readonly closed: boolean;
}

export interface SseChannelOptions {
  /** Keep-alive comment cadence. Default 15s — the run/notification streams'
   *  established value; unifies the kanban feed's prior 25s onto it. */
  heartbeatMs?: number;
  /** Close the stream from the server after this long; the client
   *  reconnects while it still wants the feed. It bounds how long a stream can
   *  hold its cap slot when the client's disconnect never reaches the
   *  container. MEASURED 2026-10-10 on prod: kanban board streams ended by an
   *  in-page fetch abort all ran the full 3600 s request timeout, while
   *  notification streams ended by a tab close ended early.
   *  ADR 0897: defaults to `OPENWOP_SSE_MAX_AGE_MS` (5 min); 0 disables. */
  maxAgeMs?: number;
  /** ADR 0897 / RFC 0247 — when the bounded close applies. `'always'`
   *  (default) suits host-extension streams, whose readers all reconnect.
   *  The OpenWOP WIRE channels pass `'resumable'`: `events.md` makes the host
   *  hold a live run's stream open, so only a consumer that sent
   *  `resumable=true` may be closed early. */
  boundWhen?: 'always' | 'resumable';
  /** ADR 0876 — what to do with a stream that arrived through a front door
   *  the operator has declared cannot carry streams (see `frontDoorHop`).
   *  Default `'refuse'`: every host-extension stream is protected by
   *  construction. Only the OpenWOP WIRE channels pass `'allow'` —
   *  `runs.md` keeps `eventsUrl` on the request's origin, and certification
   *  reads those through the public base URL. */
  frontDoor?: 'refuse' | 'allow';
}

/**
 * ADR 0876 — the forwarded host when this request came through a front door
 * other than the advertised stream origin (ADR 0761), else `null`.
 *
 * MEASURED 2026-10-12 on prod: ONE client stream through the Firebase Hosting
 * `/api` rewrite became 12 upstream streams in 3 min (Hosting retries the
 * upstream, from Google front-end IPs), each holding a per-tenant cap slot for
 * its full lifetime, and the client got `503 text/html` at 188 s. The same
 * stream read direct was one request, closed cleanly at 120 s.
 *
 * Only fires when ALL hold, so no other deployment changes behaviour:
 *   - the operator configured `OPENWOP_STREAM_BASE_URL` (they have declared
 *     their front door cannot carry streams);
 *   - `X-Forwarded-Host` is present (Hosting sets it; a direct Cloud Run
 *     request carries none — MEASURED via the 401 challenge origin);
 *   - it names neither the request's own `Host` (a pass-through proxy such as
 *     nginx `proxy_set_header Host $host`) nor the stream origin itself.
 */
export function frontDoorHop(req: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = streamBaseUrl(env);
  if (base === undefined) return null;
  const forwarded = (req.header('x-forwarded-host') ?? '').split(',')[0]!.trim().toLowerCase();
  if (forwarded === '') return null;
  const host = (req.header('host') ?? '').trim().toLowerCase();
  if (forwarded === host || forwarded === new URL(base).host.toLowerCase()) return null;
  return forwarded;
}

/**
 * Open an SSE channel on `res`: enforce the per-key cap, write the canonical
 * stream headers, flush, start the heartbeat, and wire teardown. Call AFTER
 * the route's own authorization (so a rejected caller never consumes a slot
 * and the 429 carries no stream headers).
 *
 * @throws OpenwopError('rate_limited', 429) when the caller is at the cap — the
 *   route's `try/catch → next(err)` surfaces it as a normal JSON 429 (headers
 *   are not yet flushed at throw time).
 */
export function openSseChannel(req: Request, res: Response, opts: SseChannelOptions = {}): SseChannel {
  // A client that aborted while the route ran its pre-open auth awaits has
  // ALREADY emitted 'close' — the `req.on('close', teardown)` below would
  // never fire, so the counter incremented here would leak its cap slot until
  // the instance recycles (nothing else releases it). Refuse to open instead:
  // nobody is listening to this response, and the route's `catch → next(err)`
  // writes the error into the same dead socket, harmlessly. The check is safe
  // as a one-shot: everything from here to the listener attach is synchronous,
  // so a later abort's 'close' emission always lands on the attached listener.
  if (req.destroyed || req.socket.destroyed || res.destroyed || res.writableEnded) {
    throw new OpenwopError('invalid_request', 'Client disconnected before the stream opened.', 408, { reason: 'client_gone' });
  }
  // ADR 0876 — refuse BEFORE taking a cap slot or writing headers: a fast 4xx
  // ends the front door's upstream retries, and the client is told where its
  // streams belong instead of waiting on a buffered response that never arrives.
  if ((opts.frontDoor ?? 'refuse') === 'refuse') {
    const via = frontDoorHop(req);
    if (via !== null) {
      const streamBase = streamBaseUrl();
      log.warn('sse_front_door_refused', { via, path: req.path });
      throw new OpenwopError('invalid_request', `Event streams are not served through ${via}; read them from ${streamBase}.`, 421, {
        reason: 'stream_via_front_door',
        streamBase,
      });
    }
  }
  // `null` key → exempt (trusted operator); skip the cap AND the counter so
  // teardown has nothing to release.
  const key = capKey(req);
  if (key !== null) {
    const cap = maxStreams();
    const current = streamCounts.get(key) ?? 0;
    if (cap > 0 && current >= cap) {
      res.set('Retry-After', '5');
      log.warn('sse stream cap hit', { key, current, cap });
      throw new OpenwopError('rate_limited', 'Too many concurrent streams. Try again shortly.', 429, {
        scope: 'tenant',
        reason: 'sse_concurrent_streams',
        retryAfterMs: 5000,
      });
    }
    streamCounts.set(key, current + 1);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx/Cloud Run/Firebase) so frames flush live.
    // The kanban feed was missing this — frames could be held by the proxy.
    'X-Accel-Buffering': 'no',
  });
  // An initial comment opens the stream immediately (some proxies wait for the
  // first byte before establishing the response).
  res.write(': open\n\n');

  let closed = false;
  const routeTeardowns: Array<() => void> = [];

  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, heartbeatMs);
  const maxAgeMs = boundedLifetimeMs(req, opts);
  const maxAge = maxAgeMs > 0
    ? setTimeout(() => {
      if (closed) return;
      log.info('sse_bounded_close', { path: req.path, maxAgeMs });
      teardown(true);
    }, maxAgeMs)
    : null;
  maxAge?.unref?.();

  const teardown = (bounded = false): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (maxAge) clearTimeout(maxAge);
    if (key !== null) {
      const n = (streamCounts.get(key) ?? 1) - 1;
      if (n <= 0) streamCounts.delete(key);
      else streamCounts.set(key, n);
    }
    for (const hook of routeTeardowns) {
      try { hook(); } catch (err) { log.warn('sse onClose hook threw', { err: String(err) }); }
    }
    // ADR 0897 — after the route's hook (which flushes any pending batch), so
    // `retry:` is the last thing on the stream. A frame boundary: every route
    // writes a whole frame per `res.write`, and this runs between them.
    if (bounded) {
      try { res.write(`retry: ${BOUNDED_CLOSE_RETRY_MS}\n\n`); } catch { /* socket gone */ }
    }
    // res.end() is safe to call once; guard against a double end after a
    // client-initiated close.
    try { res.end(); } catch { /* already ended */ }
  };

  req.on('close', () => teardown());

  return {
    onClose(cb: () => void) { routeTeardowns.push(cb); },
    close: () => teardown(),
    get closed() { return closed; },
  };
}

/** ADR 0897 — this stream's server-side lifetime in ms, 0 for none. Jittered
 *  down by up to 10% so streams opened together (a deploy's reconnect wave)
 *  do not all reconnect together. */
export function boundedLifetimeMs(req: Request, opts: Pick<SseChannelOptions, 'maxAgeMs' | 'boundWhen'>, random: () => number = Math.random): number {
  if ((opts.boundWhen ?? 'always') === 'resumable') {
    // RFC 0247: only an opted-in consumer, only while `limits.maxStreamAgeSec`
    // is advertised (same predicate), never before 15 s, never past the advert.
    if (!streamIsResumable(req)) return 0;
    const max = wireStreamMaxAgeMs(opts.maxAgeMs ?? defaultMaxAgeMs());
    if (max <= 0) return 0;
    const floor = wireStreamFloorMs();
    const ms = frontDoorHop(req) !== null ? Math.max(floor, Math.min(max, FRONT_DOOR_MAX_AGE_MS)) : max;
    return Math.max(floor, Math.round(ms * (1 - 0.1 * random())));
  }
  const ms = opts.maxAgeMs ?? defaultMaxAgeMs();
  if (ms <= 0) return 0;
  return Math.round(ms * (1 - 0.1 * random()));
}

/** Test affordance — reset the in-memory cap counters between cases. */
export function _resetSseStreamCounts(): void {
  streamCounts.clear();
}
