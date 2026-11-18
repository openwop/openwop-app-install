/**
 * ADR 1147 — an error response is never stored by a cache.
 *
 * An error is an answer about THIS caller now: a 401 before sign-in, a 403 before a
 * grant, a 404 before a workspace switch or before a page is published. Behind
 * Firebase Hosting, a response with no Cache-Control is cached for 10 minutes on its
 * URL alone, with no `Vary: cookie` (#5841, measured), so it could outlive the change
 * and reach another caller.
 *
 * The rule lives here, once (`forbidsStoring` + `applyErrorCacheControl`). `errorEnvelope.emitEnvelope` applies it to every
 * envelope it writes; {@link errorCacheGuard} applies it at `writeHead` to every
 * other error, whatever wrote it: `res.status(n).json(...)` straight from a route,
 * `res.status(var)`, `.send`, `.end`, `index.ts`'s catch-all 404. The ratchet in
 * `test/error-writes-go-through-envelope-ratchet.test.ts` keeps direct writes from
 * growing; this guard is what makes the ones that remain safe.
 */
import type { RequestHandler, Response } from 'express';
import { createLogger } from '../observability/logger.js';
import { recordErrorCacheStamped } from '../observability/metricSeams.js';

const log = createLogger('error-cache-guard');

/** True when a Cache-Control value already forbids storing (`no-store`, `private, no-store`). */
export function forbidsStoring(value: unknown): boolean {
  const v = Array.isArray(value) ? value.join(', ') : value;
  return typeof v === 'string' && /\bno-store\b/i.test(v);
}

/** Apply the rule to a response about to go out as an error. Returns the overridden weaker value, if any. */
export function applyErrorCacheControl(res: Response): string | undefined {
  const prior = res.getHeader('Cache-Control');
  if (forbidsStoring(prior)) return undefined;
  res.setHeader('Cache-Control', 'no-store');
  return prior === undefined ? undefined : String(prior);
}

/** Routes whose weaker error header has been logged (bounded; a log line per route, not per request). */
const loggedOverrides = new Set<string>();
const LOGGED_OVERRIDES_MAX = 1000;

type HeaderArg = Record<string, number | string | readonly string[]> | readonly (string | readonly string[])[] | undefined;

/** A `Cache-Control` passed in `writeHead`'s own header object or flat array, replaced when weaker. */
function fixHeaderArg(headers: HeaderArg): { headers: HeaderArg; overridden?: string } {
  if (!headers) return { headers };
  if (Array.isArray(headers)) {
    // Node takes either [[name, value], …] pairs or a flat [name, value, name, value…].
    let overridden: string | undefined;
    if (headers.length > 0 && Array.isArray(headers[0])) {
      const pairs = (headers as readonly (readonly string[])[]).map((pair) => {
        if (String(pair[0]).toLowerCase() !== 'cache-control' || forbidsStoring(pair[1])) return pair;
        overridden = String(pair[1]);
        return [pair[0], 'no-store'];
      });
      return { headers: pairs, ...(overridden !== undefined ? { overridden } : {}) };
    }
    const out = [...headers];
    for (let i = 0; i + 1 < out.length; i += 2) {
      if (String(out[i]).toLowerCase() === 'cache-control' && !forbidsStoring(out[i + 1])) {
        overridden = String(out[i + 1]);
        out[i + 1] = 'no-store';
      }
    }
    return { headers: out, ...(overridden !== undefined ? { overridden } : {}) };
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cache-control');
  if (key === undefined || forbidsStoring(headers[key as keyof typeof headers])) return { headers };
  return { headers: { ...headers, [key]: 'no-store' }, overridden: String(headers[key as keyof typeof headers]) };
}

function headerArgHasCacheControl(headers: HeaderArg): boolean {
  if (!headers) return false;
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) return (headers as readonly (readonly string[])[]).some((p) => String(p[0]).toLowerCase() === 'cache-control');
    return headers.some((v, i) => i % 2 === 0 && String(v).toLowerCase() === 'cache-control');
  }
  return Object.keys(headers).some((k) => k.toLowerCase() === 'cache-control');
}

/**
 * Mount FIRST (right after `express()`), so it wraps every later layer: the protocol
 * negotiator's refusals, the body parser's 400, the auth 401, the routes, the
 * catch-all 404 and the error envelope. It hooks `writeHead` on the response itself,
 * which Node calls for an explicit `writeHead` and for the implicit header of the
 * first `write`/`end`, so no write shape gets past it. 1xx–3xx are untouched: a
 * cached 200 or a 304 stays exactly as the route made it.
 */
export function errorCacheGuard(): RequestHandler {
  return (req, res, next) => {
    const writeHead = res.writeHead;
    res.writeHead = function guardedWriteHead(this: Response, statusCode: number, ...rest: unknown[]) {
      if (statusCode >= 400 && !this.headersSent) {
        // writeHead(status, reason?, headers?): the header object wins over setHeader values.
        const at = typeof rest[0] === 'string' ? 1 : 0;
        const hadNoHeader = this.getHeader('Cache-Control') === undefined && !headerArgHasCacheControl(rest[at] as HeaderArg);
        let overridden = applyErrorCacheControl(this);
        if (rest[at] !== undefined) {
          const fixed = fixHeaderArg(rest[at] as HeaderArg);
          rest[at] = fixed.headers;
          overridden ??= fixed.overridden;
        }
        // The route PATTERN, never the raw path: a path can carry a bearer token
        // (a share link's `/shared/:token`), and both the log and the metric carry it.
        const template = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : '(no route)';
        // GUARD-2: count only what the guard itself stamped. An envelope error is already
        // no-store here, and a stricter route value is kept, so neither counts.
        if (overridden !== undefined) recordErrorCacheStamped(template, statusCode, 'weaker');
        else if (hadNoHeader && forbidsStoring(this.getHeader('Cache-Control'))) recordErrorCacheStamped(template, statusCode, 'none');
        if (overridden !== undefined) {
          const route = `${req.method} ${template}`;
          if (!loggedOverrides.has(route) && loggedOverrides.size < LOGGED_OVERRIDES_MAX) {
            loggedOverrides.add(route);
            log.warn('error_cache_control_overridden', { route, status: statusCode, was: overridden });
          }
        }
      }
      return (writeHead as (...a: unknown[]) => Response).call(this, statusCode, ...rest);
    } as Response['writeHead'];
    next();
  };
}

export function __resetErrorCacheGuardLogForTest(): void {
  loggedOverrides.clear();
}
