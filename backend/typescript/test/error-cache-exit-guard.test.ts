/**
 * ADR 1147 — every error leaves with `no-store`, whatever wrote it.
 *
 * The guard hooks `writeHead`, so it sees the direct writes the envelope never
 * touches (126 `res.status(4xx|5xx).json(` in routes and features on 2026-11-17, plus
 * `status(<variable>)`, `.send`, `.end` and `index.ts`'s catch-all 404).
 *
 * Red when: the guard is not mounted or skips a write shape; a weaker header set on
 * an error survives; a stricter one (`private, no-store`) is loosened; `Retry-After`
 * is dropped; a 2xx/304 is touched; or mounting the guard makes routing
 * case-insensitive (it did, in its first cut).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { __resetErrorCacheGuardLogForTest, errorCacheGuard } from '../src/middleware/errorCacheControl.js';
import { sendError } from '../src/middleware/errorEnvelope.js';
import { _resetMetricsForTest, emissionsOf } from '../src/observability/metrics.js';

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const srv = await new Promise<http.Server>((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: () => new Promise<void>((res) => srv.close(() => res())),
  };
}

/** The write shapes the regex ratchet cannot see, behind the guard. */
function shapes(withGuard: boolean): express.Express {
  const app = express();
  if (withGuard) app.use(errorCacheGuard());
  app.get('/json', (_req, res) => { res.status(404).json({ error: 'not_found', message: 'x' }); });
  app.get('/weaker', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.status(404).json({ error: 'not_found', message: 'x' }); });
  app.get('/stricter', (_req, res) => { res.setHeader('Cache-Control', 'private, no-store'); res.status(404).json({ error: 'not_found', message: 'x' }); });
  app.get('/var', (_req, res) => { const status = 409; res.status(status).json({ error: 'conflict', message: 'x' }); });
  app.get('/send', (_req, res) => { res.status(404).type('text/plain').send('Not found.'); });
  app.get('/end', (_req, res) => { res.statusCode = 503; res.end(); });
  app.get('/writehead', (_req, res) => { res.writeHead(400, { 'Cache-Control': 'max-age=60', 'Content-Type': 'text/plain' }); res.end('bad'); });
  app.get('/writehead-pairs', (_req, res) => { res.writeHead(400, [['Cache-Control', 'max-age=60'], ['Content-Type', 'text/plain']]); res.end('bad'); });
  app.get('/weaker/:secretToken', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.status(404).json({ error: 'not_found', message: 'x' }); });
  app.get('/writehead-reason', (_req, res) => { res.writeHead(404, 'Not Found', { 'Cache-Control': 'public, max-age=60', 'Content-Type': 'text/plain' }); res.end('nf'); });
  app.get('/writehead-stricter', (_req, res) => { res.writeHead(404, { 'Cache-Control': 'private, no-store' }); res.end('nf'); });
  app.get('/envelope', (_req, res) => { sendError(res, 404, 'not_found', 'x'); });
  app.get('/retry', (_req, res) => { res.set('Retry-After', '30'); res.status(429).json({ error: 'rate_limited', message: 'x' }); });
  app.get('/ok', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.json({ ok: true }); });
  app.get('/not-modified', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.status(304).end(); });
  return app;
}

describe('ADR 1147 — the exit guard', () => {
  let s: Awaited<ReturnType<typeof listen>>;
  beforeAll(async () => { s = await listen(shapes(true)); });
  afterAll(async () => { await s.close(); });
  beforeEach(() => { __resetErrorCacheGuardLogForTest(); });
  const cc = async (path: string): Promise<{ status: number; cc: string | null; retry: string | null }> => {
    const r = await fetch(`${s.base}${path}`);
    await r.arrayBuffer();
    return { status: r.status, cc: r.headers.get('cache-control'), retry: r.headers.get('retry-after') };
  };

  it('a route 4xx with no header: no-store', async () => {
    expect(await cc('/json')).toMatchObject({ status: 404, cc: 'no-store' });
  });
  it('a weaker header on an error is overridden', async () => {
    expect(await cc('/weaker')).toMatchObject({ status: 404, cc: 'no-store' });
  });
  it('a stricter one is kept as the route set it', async () => {
    expect(await cc('/stricter')).toMatchObject({ status: 404, cc: 'private, no-store' });
  });
  it('status(<variable>).json, .send, .end and a writeHead header object', async () => {
    expect(await cc('/var')).toMatchObject({ status: 409, cc: 'no-store' });
    expect(await cc('/send')).toMatchObject({ status: 404, cc: 'no-store' });
    expect(await cc('/end')).toMatchObject({ status: 503, cc: 'no-store' });
    expect(await cc('/writehead')).toMatchObject({ status: 400, cc: 'no-store' });
    expect(await cc('/writehead-pairs')).toMatchObject({ status: 400, cc: 'no-store' });
  });
  it("GUARD-1: writeHead(status, reasonPhrase, headers) with a weaker header is overridden", async () => {
    expect(await cc('/writehead-reason')).toMatchObject({ status: 404, cc: 'no-store' });
    expect(await cc('/writehead-stricter')).toMatchObject({ status: 404, cc: 'private, no-store' });
  });

  it('GUARD-2: the stamped-error counter counts only what the guard stamped', async () => {
    _resetMetricsForTest();
    await cc('/json'); // direct write, no header -> none
    await cc('/weaker'); // weaker header -> weaker
    await cc('/end'); // 503, no header -> none, 5xx
    await cc('/envelope'); // already no-store from the envelope -> not counted
    await cc('/stricter'); // the route's private, no-store kept -> not counted
    await cc('/writehead-stricter'); // stricter in the header argument -> not counted
    await cc('/ok'); // 2xx -> never counted
    const got = emissionsOf('openwop.http.error_cache_stamped').map((e) => ({ ...e.attributes }));
    expect(got).toEqual([
      { route: '/json', status_class: '4xx', prior: 'none' },
      { route: '/weaker', status_class: '4xx', prior: 'weaker' },
      { route: '/end', status_class: '5xx', prior: 'none' },
    ]);
  });

  it('a 429 keeps Retry-After', async () => {
    expect(await cc('/retry')).toMatchObject({ status: 429, cc: 'no-store', retry: '30' });
  });
  it('logs a weaker header once per route, by its pattern, never the raw path', async () => {
    const lines: string[] = [];
    const capture = (chunk: unknown): boolean => { lines.push(String(chunk)); return true; };
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    try {
      await cc('/weaker/tok-aaaaaaaaaaaaaaaa');
      await cc('/weaker/tok-bbbbbbbbbbbbbbbb');
    } finally { out.mockRestore(); err.mockRestore(); }
    const logged = lines.filter((l) => l.includes('error_cache_control_overridden'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('GET /weaker/:secretToken');
    expect(logged.join('')).not.toContain('tok-');
  });
  it('a 2xx and a 304 are untouched', async () => {
    expect(await cc('/ok')).toMatchObject({ status: 200, cc: 'public, max-age=300' });
    expect(await cc('/not-modified')).toMatchObject({ status: 304, cc: 'public, max-age=300' });
  });
});

describe('ADR 1147 — sabotage: the same shapes WITHOUT the guard leave errors cacheable', () => {
  it('shows what the guard is doing', async () => {
    const bare = await listen(shapes(false));
    try {
      for (const path of ['/json', '/var', '/send', '/end']) {
        const r = await fetch(`${bare.base}${path}`);
        await r.arrayBuffer();
        expect(r.headers.get('cache-control'), path).toBeNull();
      }
      const weaker = await fetch(`${bare.base}/weaker`);
      expect(weaker.headers.get('cache-control')).toBe('public, max-age=300');
    } finally { await bare.close(); }
  });
});

describe('ADR 1147 — mounted in the real app', () => {
  let s: Awaited<ReturnType<typeof listen>>;
  let app: express.Express;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    s = await listen(app);
  });

  // The setting alone reads true however early the router was built; Express 4 copies
  // it onto the router at the FIRST app.use. Assert the router the app actually built,
  // so middleware mounted above the app.set lines reds here, not in a train.
  it('the router the app built is case-sensitive', () => {
    expect(app.get('case sensitive routing')).toBe(true);
    const router = (app as unknown as { _router?: { caseSensitive?: boolean } })._router;
    expect(router?.caseSensitive).toBe(true);
  });
  afterAll(async () => { await s.close(); });

  it("index.ts's catch-all 404 (no route, outside every ratchet) is no-store", async () => {
    const r = await fetch(`${s.base}/health/no-such-path-adr1147`, { headers: { accept: 'application/json' } });
    await r.arrayBuffer();
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  // Train 288 (#6085's first cut): mounted before `app.set('case sensitive routing')`,
  // the guard's app.use built Express's router case-INsensitive, so /RUNS reached the
  // /runs handler (path-case-routing). The mount must come after every app.set.
  it('mounting the guard keeps routing case-sensitive: /RUNS with a credential is 404, not 201', async () => {
    const post = (path: string): Promise<Response> => fetch(`${s.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', connection: 'close' },
      body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: {} }),
    });
    expect((await post('/runs')).status, 'CONTROL: the canonical spelling reaches the handler').toBe(201);
    const wrong = await post('/RUNS');
    await wrong.arrayBuffer();
    expect(wrong.status).toBe(404);
    expect(wrong.headers.get('cache-control')).toBe('no-store');
  });
  it('a 200 keeps its own caching', async () => {
    const r = await fetch(`${s.base}/.well-known/openwop`);
    await r.arrayBuffer();
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control') ?? '').not.toBe('no-store');
  });
});
