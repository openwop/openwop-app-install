/**
 * The middleware's refusals are `Cache-Control: no-store`, like every other error.
 *
 * MEASURED live on openwop-dev 2026-11-17 (2c83c256e): an unauthenticated v2 request
 * got a 401 with no Cache-Control. The auth middleware wrote it directly, outside the
 * error envelope (#5841 / #6019), and behind Firebase a header-less error was measured
 * cached for 10 minutes on the URL alone. Now the refusals go through `sendErrorBody`.
 *
 * Red when: a middleware refusal writes its body directly again (the 401, the 410), a
 * thrown 403 loses the header, or a 429 loses `Retry-After` or `no-store`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { _resetRateLimitState, ipRateLimitMiddleware } from '../src/middleware/rateLimit.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';

let BASE = '';
let server: http.Server;
const TENANT = 'refusals-no-store';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('middleware refusals are never cached', () => {
  it('an unauthenticated v2 request: 401, no-store', async () => {
    const r = await fetch(`${BASE}/runs/00000000-0000-4000-8000-000000000000`, { headers: { 'OpenWOP-Version': '2', accept: 'application/json' } });
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(((await r.json()) as { error?: string }).error).toBe('unauthenticated');
  });

  it('a key without the scope a route needs: 403, no-store', async () => {
    const { token } = await issueApiKey({ tenantId: TENANT, name: 'narrow', createdBy: 'user:refusals', scopes: ['artifacts:read'] });
    const r = await fetch(`${BASE}/host/openwop-app/roster`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(403);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('a retired /v1 path: 410, no-store', async () => {
    const r = await fetch(`${BASE}/v1/runs`, { headers: { accept: 'application/json' } });
    expect(r.status).toBe(410);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('a rate-limited write: 429 keeps Retry-After and is no-store', async () => {
    const saved = { rpm: process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN, force: process.env.OPENWOP_FORCE_RATE_LIMIT };
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '1';
    process.env.OPENWOP_FORCE_RATE_LIMIT = 'true';
    _resetRateLimitState();
    const app = express();
    app.use(ipRateLimitMiddleware());
    app.post('/w', (_req, res) => { res.json({ ok: true }); });
    app.use(errorEnvelopeMiddleware());
    const srv = await new Promise<http.Server>((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/w`;
      let last: Response | undefined;
      for (let i = 0; i < 4; i++) last = await fetch(url, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.77' } });
      expect(last!.status).toBe(429);
      expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(last!.headers.get('cache-control')).toBe('no-store');
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
      process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = saved.rpm;
      process.env.OPENWOP_FORCE_RATE_LIMIT = saved.force;
      if (saved.rpm === undefined) delete process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN;
      if (saved.force === undefined) delete process.env.OPENWOP_FORCE_RATE_LIMIT;
      _resetRateLimitState();
    }
  });
});
