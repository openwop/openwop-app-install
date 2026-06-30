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

/** Does the request's `Accept-Encoding` permit gzip (and not disable it q=0)? */
export function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (!acceptEncoding) return false;
  for (const part of acceptEncoding.split(',')) {
    const [enc, ...params] = part.trim().split(';');
    if (enc.trim().toLowerCase() !== 'gzip' && enc.trim() !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) return false; // explicitly disabled
    return true;
  }
  return false;
}

/**
 * Express middleware: wrap `res.json` to gzip the serialized body when safe.
 * No-op when `contextEconomy().transport` is off — `res.json` is left untouched.
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
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      // Always advertise that the representation varies by encoding so a shared
      // cache never serves a gzipped body to a non-gzip client.
      res.setHeader('Vary', 'Accept-Encoding');
      if (raw.length < MIN_GZIP_BYTES) {
        // Below threshold: send identity JSON, but keep the Content-Type res.json sets.
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.removeHeader('Content-Length');
        res.end(raw);
        return res;
      }
      const gz = gzipSync(raw);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(gz.length));
      res.end(gz);
      return res;
    };
    next();
  };
}
