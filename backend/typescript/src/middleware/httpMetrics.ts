/**
 * ADR 0556 P1 — HTTP server latency + status class, by ROUTE TEMPLATE.
 *
 * The availability and latency SLOs both read this one histogram, which is why
 * it is a middleware rather than a decoration on the handful of routes someone
 * remembered: an SLO computed over a subset of traffic is not an SLO, and the
 * routes most worth measuring are the ones nobody thought to instrument.
 *
 * ── WHY THE TEMPLATE, AND WHY IT IS ONLY KNOWN AT `finish` ─────────────────
 *
 * `req.path` is `/v1/runs/019a…` — one time series PER RUN, which is the exact
 * outage `FORBIDDEN_LABELS` exists to prevent (`path` is on that list, so the
 * guard would drop it and leave the measurement with no useful dimension at
 * all). `req.route.path` is `/v1/runs/:runId` — one series for every run there
 * will ever be. Express only populates `req.route` once a handler has matched,
 * which is after `next()`, so the label has to be read in the `finish`
 * listener and not when the middleware runs.
 *
 * A request that matched nothing has no template. It is `unmatched`: a single
 * series covering every 404 a scanner can generate, which is the one case where
 * losing detail is the point.
 *
 * ── ORDERING ───────────────────────────────────────────────────────────────
 *
 * Mounted EARLY, before auth and the rate limiter, so a 401 and a 429 are
 * measured too. An availability metric that only counts requests which got past
 * the gates reports a host as perfectly healthy while it refuses everyone.
 *
 * `finish` fires when the response has been flushed. `close` (client hung up
 * mid-response) deliberately does NOT emit: no status was ever sent, so the
 * status class would be a fabrication.
 */

import type { RequestHandler, Request } from 'express';
import { recordHttpRequest } from '../observability/metricSeams.js';
import { isLongLivedSseStream } from './rateLimit.js';

/** The express route template, or `undefined` when nothing matched. */
function routeTemplateOf(req: Request): string | undefined {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath !== 'string') return undefined;
  // `baseUrl` is empty for this app (every route is registered on the app
  // directly, no mounted Routers), but concatenating is what keeps this correct
  // if that ever changes — a bare `/:id` from a mounted router would otherwise
  // collapse unrelated routes into one series.
  return `${req.baseUrl ?? ''}${routePath}` || routePath;
}

export function httpMetricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const startedMs = Date.now();
    res.once('finish', () => {
      recordHttpRequest({
        route: routeTemplateOf(req),
        method: req.method,
        status: res.statusCode,
        durationMs: Date.now() - startedMs,
        // Read from the SAME predicate the rate limiter exempts on, so there is
        // exactly one definition of "this is a stream" in the host. Evaluated
        // on the REQUEST, not the route template: `/v1/runs/:runId/events`
        // serves SSE and JSON polling on one path, and only the `Accept` header
        // separates them.
        stream: isLongLivedSseStream(req),
      });
    });
    next();
  };
}
