/**
 * #5841 — every error envelope is `Cache-Control: no-store`.
 *
 * MEASURED on casavoga.com (a white-label of this app), 2026-11-12: an error
 * with no Cache-Control got `max-age=600` and no `Vary: cookie` from Firebase
 * Hosting, so a 403 or 404 outlived a grant, a membership change or a workspace
 * switch for ten minutes. Covers the three envelope writers: a thrown error (the
 * middleware), an inline `sendError`, and an unexpected throw (500), plus a
 * route that set a public cache header before it failed.
 *
 * Red when: the `no-store` line in `emitEnvelope` is removed.
 */
import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorEnvelopeMiddleware, sendError } from '../src/middleware/errorEnvelope.js';
import { OpenwopError } from '../src/types.js';

let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.get('/thrown', () => { throw new OpenwopError('forbidden_scope', 'Not allowed.', 403); });
  app.get('/inline', (_req, res) => { sendError(res, 404, 'run_not_found', 'run not found'); });
  app.get('/boom', () => { throw new Error('unexpected'); });
  app.get('/cached-then-thrown', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=600');
    throw new OpenwopError('not_found', 'Not found.', 404);
  });
  app.get('/private-then-thrown', (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    throw new OpenwopError('not_found', 'Not found.', 404);
  });
  app.get('/ok', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=60'); res.json({ ok: true }); });
  app.use(errorEnvelopeMiddleware());
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('#5841 — error envelopes are never cached', () => {
  it.each([
    ['/thrown', 403],
    ['/inline', 404],
    ['/boom', 500],
    ['/cached-then-thrown', 404],
  ])('%s answers %i with Cache-Control: no-store', async (path, status) => {
    const r = await fetch(`${base}${path}`);
    expect(r.status).toBe(status);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(typeof ((await r.json()) as { error?: unknown }).error).toBe('string');
  });

  it('a route that already forbids storing keeps its stricter header on an error (ADR 0887 D4)', async () => {
    const r = await fetch(`${base}/private-then-thrown`);
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
  });

  it('a success keeps the cache header its route chose', async () => {
    const r = await fetch(`${base}/ok`);
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
  });
});
