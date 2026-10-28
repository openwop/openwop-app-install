/**
 * ADR 0771 — an operator-CONFIGURED key's writes draw from a per-key bucket
 * instead of the per-IP one. Everyone else is unchanged.
 *
 * Two layers, because they prove different things:
 *  - a synthetic app with a stamped principal pins the BUCKETING rules
 *    (configured vs the public dev-token, a prefix collision, IP isolation);
 *  - the real `createApp` pins D4: the limiter reads a principal the REAL auth
 *    middleware verified, so a fake bearer buys nothing.
 * Every request carries X-Forwarded-For, since a bare loopback connection is
 * exempt from the limiter entirely.
 *
 * Red when (wave 60 probes, tracker TST-BRB-4): the keyed write bucket is never
 * chosen; it admits an unconfigured dev-token or an `owk_` key; two keys sharing an
 * 8-character prefix share a bucket; FORCE stops shrinking the key budget; or a keyed
 * write is also charged to the caller's IP bucket.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ipRateLimitMiddleware, _resetRateLimitState } from '../src/middleware/rateLimit.js';
import { createApp } from '../src/index.js';

const ENV_KEYS = ['OPENWOP_API_KEYS', 'OPENWOP_API_KEY', 'OPENWOP_RATELIMIT_IP_REQS_PER_MIN', 'OPENWOP_RATELIMIT_KEY_WRITE_REQS_PER_MIN', 'OPENWOP_FORCE_RATE_LIMIT', 'OPENWOP_RATELIMIT_DISABLED'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) };
}

/** A principal as authMiddleware would stamp it, driven by test headers. */
function synthetic(): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    const kind = req.header('x-kind'); const token = req.header('x-token');
    if (kind) (req as { principal?: unknown }).principal = { principalId: `bearer:${(token ?? '').slice(0, 8)}`, tenants: ['*'], token, auth: { kind } };
    next();
  });
  app.use(ipRateLimitMiddleware());
  app.post('/w', (_req, res) => res.json({ ok: true }));
  return app;
}

async function burst(base: string, n: number, headers: Record<string, string>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fetch(`${base}/w`, { method: 'POST', headers })).status);
  return out;
}

describe('ADR 0771 — bucketing rules (synthetic principal)', () => {
  let srv: { base: string; close: () => Promise<void> };
  beforeEach(async () => {
    _resetRateLimitState();
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '2';
    process.env.OPENWOP_RATELIMIT_KEY_WRITE_REQS_PER_MIN = '5';
    process.env.OPENWOP_API_KEYS = 'configured-key-aaaa:*';
    srv = await listen(synthetic());
  });
  afterEach(async () => { await srv.close(); });

  it('a configured env-key writes past the IP budget, up to its own', async () => {
    const s = await burst(srv.base, 6, { 'x-forwarded-for': '203.0.113.1', 'x-kind': 'env-key', 'x-token': 'configured-key-aaaa' });
    expect(s).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('a session caller from the SAME IP still hits the IP budget; the keyed bucket takes nothing from it', async () => {
    await burst(srv.base, 4, { 'x-forwarded-for': '203.0.113.2', 'x-kind': 'env-key', 'x-token': 'configured-key-aaaa' });
    const s = await burst(srv.base, 3, { 'x-forwarded-for': '203.0.113.2', 'x-kind': 'subject' });
    expect(s).toEqual([200, 200, 429]);
  });

  it('a user-minted developer key (api-key) gets no keyed budget', async () => {
    const s = await burst(srv.base, 3, { 'x-forwarded-for': '203.0.113.3', 'x-kind': 'api-key', 'x-token': 'owk_whatever' });
    expect(s).toEqual([200, 200, 429]);
  });

  it('HIGH-1: the built-in dev-token of an UNCONFIGURED deployment gets no keyed budget', async () => {
    delete process.env.OPENWOP_API_KEYS; delete process.env.OPENWOP_API_KEY;
    const s = await burst(srv.base, 3, { 'x-forwarded-for': '203.0.113.4', 'x-kind': 'env-key', 'x-token': 'dev-token' });
    expect(s).toEqual([200, 200, 429]);
  });

  it('HIGH-2: two keys sharing an 8-character prefix get SEPARATE buckets', async () => {
    const a = await burst(srv.base, 5, { 'x-forwarded-for': '203.0.113.5', 'x-kind': 'env-key', 'x-token': 'samepfx-key-one' });
    const b = await burst(srv.base, 5, { 'x-forwarded-for': '203.0.113.5', 'x-kind': 'env-key', 'x-token': 'samepfx-key-two' });
    expect(a.every((x) => x === 200)).toBe(true);
    expect(b.every((x) => x === 200)).toBe(true);
  });

  it('FORCE still induces the canonical 429 for an env-key caller — rate-limit-envelope must stay passable', async () => {
    process.env.OPENWOP_FORCE_RATE_LIMIT = 'true';
    const s = await burst(srv.base, 4, { 'x-forwarded-for': '203.0.113.6', 'x-kind': 'env-key', 'x-token': 'configured-key-aaaa' });
    expect(s).toEqual([200, 200, 200, 429]);
  });
});

describe('ADR 0771 D4 — through the real auth middleware', () => {
  let srv: { base: string; close: () => Promise<void> };
  beforeEach(async () => {
    _resetRateLimitState();
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    process.env.OPENWOP_API_KEYS = 'real-operator-key-1234:*';
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '2';
    process.env.OPENWOP_RATELIMIT_KEY_WRITE_REQS_PER_MIN = '6';
  });
  afterEach(async () => { await srv?.close(); });
  afterAll(() => { _resetRateLimitState(); });

  it('the configured key gets its budget past the IP limit; a FAKE bearer is refused by auth before any bucket', async () => {
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0', enableConsoleTracer: false });
    srv = await listen(app);
    const post = (token: string) => fetch(`${srv.base}/runs`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status);
    const real: number[] = []; for (let i = 0; i < 4; i++) real.push(await post('real-operator-key-1234'));
    // Positive control: the configured key AUTHENTICATED (an empty run body is a 400
    // past auth). A key refused 401 would also show "no 429".
    expect(real, `configured key statuses ${real.join(',')}`).toEqual([400, 400, 400, 400]);
    const fake: number[] = []; for (let i = 0; i < 3; i++) fake.push(await post(`not-a-key-${i}`));
    // A bearer that is not a configured key never becomes `env-key`: auth refuses
    // it outright, so rotating fake tokens cannot buy fresh budget of ANY kind.
    expect(fake, 'a fake bearer must be refused, never admitted to a bucket').toEqual([401, 401, 401]);
  }, 120_000);
});
