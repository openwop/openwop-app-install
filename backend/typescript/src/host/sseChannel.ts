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

function maxStreams(): number {
  const raw = process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT;
  if (raw === undefined) return DEFAULT_MAX_STREAMS;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX_STREAMS;
}

/** Cap key: the tenant when known (so one tenant can't starve others), else
 *  the source IP (mirrors middleware/rateLimit's X-Forwarded-For handling so
 *  tenant-less anon callers are still bounded). */
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
 *  falling back to source IP for tenant-less anon callers (mirrors
 *  middleware/rateLimit's X-Forwarded-For handling). */
function capKey(req: Request): string | null {
  if (req.principal?.tenants?.includes('*')) return null;
  if (req.tenantId) return `t:${req.tenantId}`;
  const xff = req.header('x-forwarded-for');
  const ip = xff ? (xff.split(',')[0] ?? xff).trim() : (req.socket.remoteAddress ?? 'unknown');
  return `ip:${ip}`;
}

export interface SseChannel {
  /** Register route-specific teardown (unsubscribe, clear aggregation ticks).
   *  Runs exactly once, on the FIRST of: client disconnect or `close()`. */
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
  let routeTeardown: (() => void) | null = null;

  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, heartbeatMs);

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (key !== null) {
      const n = (streamCounts.get(key) ?? 1) - 1;
      if (n <= 0) streamCounts.delete(key);
      else streamCounts.set(key, n);
    }
    if (routeTeardown) {
      try { routeTeardown(); } catch (err) { log.warn('sse onClose hook threw', { err: String(err) }); }
    }
    // res.end() is safe to call once; guard against a double end after a
    // client-initiated close.
    try { res.end(); } catch { /* already ended */ }
  };

  req.on('close', teardown);

  return {
    onClose(cb: () => void) { routeTeardown = cb; },
    close: teardown,
    get closed() { return closed; },
  };
}

/** Test affordance — reset the in-memory cap counters between cases. */
export function _resetSseStreamCounts(): void {
  streamCounts.clear();
}
