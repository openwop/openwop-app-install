/**
 * API-4 — stream-safe request-timeout middleware.
 *
 * A *naive* timer would kill the SSE / event-stream routes mid-flight, leaving
 * Cloud Run's outer timeout as the only backstop. This is the non-naive version:
 * it only ever sends a response when `res.headersSent` is still false. SSE and
 * other streaming routes flush their headers immediately (before any long-lived
 * work), so by the time the timer fires their headers are already sent and the
 * timeout becomes a no-op — streams are never interrupted. Only a NON-streaming
 * request that has produced nothing after `timeoutMs` is failed, with the
 * canonical error envelope shape.
 *
 * The timer is `unref`'d (never holds the event loop open) and cleared on
 * response `finish`/`close`. Configurable via OPENWOP_REQUEST_TIMEOUT_MS;
 * set to `0` to disable (falls back to the Cloud Run outer timeout).
 */

import type { Request, RequestHandler } from 'express';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A few routes synchronously block on an LLM call for the whole request — the
 * RFC 0005 conversation `exchange` (POST `/v1/runs/:id/interrupts/:nodeId` and
 * `/v1/interrupts/:token`) generates the agent reply in-request before
 * responding. A "reasoning"-class model legitimately takes longer than the 30s
 * default, so the global backstop fails an otherwise-healthy turn with
 * `request_timeout`. These routes get a longer budget (still bounded — the
 * provider has its own timeout) while every other route keeps the tight 30s.
 */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;

export function resolveRequestTimeoutMs(): number {
  const raw = process.env.OPENWOP_REQUEST_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REQUEST_TIMEOUT_MS;
}

export function resolveLlmRequestTimeoutMs(): number {
  const raw = process.env.OPENWOP_LLM_REQUEST_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

/** True for the in-request LLM routes (interrupt resolve / conversation exchange). */
export function isLlmBlockingRoute(req: Request): boolean {
  return req.method === 'POST' && /(^|\/)interrupts(\/|$)/.test(req.path);
}

/** Per-request budget: the longer LLM budget for the blocking interrupt routes,
 *  the tight default everywhere else. A resolver (not a fixed number) so the
 *  decision is made per request from its path. */
export function resolveTimeoutForRequest(req: Request): number {
  return isLlmBlockingRoute(req) ? resolveLlmRequestTimeoutMs() : resolveRequestTimeoutMs();
}

export function requestTimeoutMiddleware(
  timeoutOrResolver: number | ((req: Request) => number) = resolveTimeoutForRequest,
): RequestHandler {
  const resolve = typeof timeoutOrResolver === 'function' ? timeoutOrResolver : () => timeoutOrResolver;
  return (req, res, next) => {
    const timeoutMs = resolve(req);
    if (timeoutMs <= 0) {
      next();
      return;
    }
    const timer = setTimeout(() => {
      // Stream-safe: once headers are sent (every SSE route flushes immediately)
      // or the response already ended, do nothing — never interrupt a stream.
      if (res.headersSent || res.writableEnded) return;
      res.status(503).json({
        error: 'request_timeout',
        message: `Request exceeded the ${timeoutMs}ms server timeout.`,
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const clear = (): void => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}
