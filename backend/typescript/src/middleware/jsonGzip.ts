/**
 * ADR 0148 Phase 5 (lever A6) — transport economy: gzip for JSON responses.
 *
 * Compresses `res.json(...)` bodies with gzip when the client accepts it and the
 * body clears a size threshold. Deliberately overrides ONLY `res.json` — this
 * structurally excludes the surfaces that must NOT be compressed:
 *  - SSE (`text/event-stream`) uses `res.write` for live, unbuffered frames
 *    (host/sseChannel.ts sets `no-transform` + `X-Accel-Buffering: no`); gzipping
 *    it would re-introduce proxy buffering. Untouched here.
 *  - media / tarball downloads use `res.send`/`sendFile`. Untouched here.
 *  - the ETag/304 path returns `res.status(304).end()` (no `res.json`). Untouched.
 *
 * Why app-level gzip when Firebase Hosting may gzip at the edge: the white-label
 * install bundle runs on operator infra (Fly/Render/ECS/k8s) with NO CDN, so JSON
 * reads there are otherwise uncompressed. In the Firebase prod path this is a
 * harmless belt-and-suspenders. Off by default (gated on
 * `contextEconomy().transport`), so zero risk until an operator opts in.
 *
 * A7 ("compact transport" — stripping run-event envelope fields from SSE frames)
 * is NOT here: the SSE-serialized run event is the governed wire shape, so that
 * belongs to a Tier-B RFC, not host-internal Tier A. See ADR 0148 Phase 5.
 *
 * @see docs/adr/0148-context-economy-token-budgeted-host-assembly.md
 */
import { gzipSync } from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';
import { contextEconomy } from '../host/contextEconomy.js';

/** Bodies smaller than this aren't worth the CPU to compress. */
const MIN_GZIP_BYTES = 1024;

/**
 * Does the request's `Accept-Encoding` permit gzip? The most specific entry
 * wins (RFC 9110 §12.5.3): an explicit `gzip` decides on its own q-value, and
 * `*` decides only when gzip is not named. So `gzip;q=0, *` refuses and
 * `*;q=0, gzip` accepts (ADR 1003 D6 — the first version let whichever entry
 * came first decide).
 */
export function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (!acceptEncoding) return false;
  let wildcard: boolean | undefined;
  for (const part of acceptEncoding.split(',')) {
    const [rawEnc, ...params] = part.trim().split(';');
    const enc = rawEnc.trim().toLowerCase();
    if (enc !== 'gzip' && enc !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const allowed = !(q && Number(q.slice(2)) === 0);
    if (enc === 'gzip') return allowed;
    wildcard = allowed;
  }
  return wildcard ?? false;
}

/** A strong validator must differ between encodings (RFC 9110 §8.8.1), so a
 *  route's own strong ETag is weakened on the compressed representation.
 *  Express's freshness check compares weakly, so revalidation still 304s. */
function weakenEtag(res: Response): void {
  const etag = res.getHeader('ETag');
  if (typeof etag === 'string' && etag.length > 0 && !etag.startsWith('W/')) res.setHeader('ETag', `W/${etag}`);
}

/**
 * Express middleware: wrap `res.json` to gzip the serialized body when safe.
 * No-op when `contextEconomy().transport` is off — `res.json` is left untouched.
 *
 * ADR 1003 D6 — both paths hand the body to Express rather than ending the
 * response here. The first version called `res.end` directly, which skipped
 * `res.send`: every JSON GET lost its automatic ETag and the `req.fresh` → 304
 * check, so a route that set an ETag and then called `res.json` could never
 * answer a revalidation with 304.
 */
export function jsonGzipMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!contextEconomy().transport || !acceptsGzip(req.header('accept-encoding'))) {
      next();
      return;
    }
    const originalJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      // Don't touch an already-encoded response (e.g. a route that pre-compressed).
      if (res.getHeader('Content-Encoding')) return originalJson(body);
      // Always advertise that the representation varies by encoding so a shared
      // cache never serves a gzipped body to a non-gzip client.
      res.vary('Accept-Encoding');
      const text = JSON.stringify(body);
      // `res.json(undefined)` serializes to nothing; Express sends an empty body.
      if (text === undefined) return originalJson(body);
      const raw = Buffer.from(text, 'utf8');
      // Below threshold: identity JSON, through Express's own path.
      if (raw.length < MIN_GZIP_BYTES) return originalJson(body);
      // Synchronous by design: a multi-MB body costs event-loop milliseconds
      // while this lever is on (stated in ADR 1003 D6).
      const gz = gzipSync(raw);
      weakenEtag(res);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      // `res.send` sets Content-Length, generates the ETag when none is set, and
      // answers 304 when the request is fresh.
      return res.send(gz);
    };
    next();
  };
}
