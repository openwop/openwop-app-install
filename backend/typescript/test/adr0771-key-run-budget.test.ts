/**
 * ADR 0771 addendum — an operator-CONFIGURED key's day of runs is counted on
 * its own budget (OPENWOP_RATELIMIT_KEY_RUNS_PER_DAY), not its tenant's session
 * quota. MEASURED 2026-09-29: the conformance key hit `session_runs_per_day`
 * (500) mid-cut, and 108 of 110 non-pass rows in the c3d06c29 certification
 * bundle were that 429.
 *
 * What must NOT widen is pinned here too: a session caller, a user-minted
 * developer key and the public dev-token of an unconfigured deployment all keep
 * the session cap, and the key's runs take nothing from its tenant's budget.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runQuotaMiddleware, reserveConcurrentSlot, _resetRateLimitState } from '../src/middleware/rateLimit.js';

const ENV_KEYS = ['OPENWOP_API_KEYS', 'OPENWOP_API_KEY', 'OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY', 'OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN', 'OPENWOP_RATELIMIT_SESSION_CONCURRENT', 'OPENWOP_RATELIMIT_KEY_RUNS_PER_DAY', 'OPENWOP_RATELIMIT_KEY_CONCURRENT', 'OPENWOP_FORCE_RATE_LIMIT', 'OPENWOP_RATELIMIT_DISABLED'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

/** A principal + tenant as authMiddleware would stamp them, driven by test headers.
 *  `x-fail` makes the route refuse, to prove a refused run is never charged. */
function synthetic(): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    const kind = req.header('x-kind'); const token = req.header('x-token');
    if (kind) (req as { principal?: unknown }).principal = { principalId: `bearer:${(token ?? '').slice(0, 8)}`, tenants: ['*'], token, auth: { kind } };
    (req as { tenantId?: string }).tenantId = req.header('x-tenant') ?? 'tenant-a';
    next();
  });
  app.post('/runs', runQuotaMiddleware(), (req, res) => {
    if (req.header('x-fail')) { res.status(404).json({ error: 'not_found' }); return; }
    // `x-hold`: the run takes a concurrency slot and never reaches terminal,
    // like a waiting or interrupted run left behind by an earlier scenario.
    if (req.header('x-hold')) reserveConcurrentSlot(req, `run-${Math.random()}`);
    res.status(201).json({ ok: true });
  });
  return app;
}

let srv: { base: string; close: () => Promise<void> };
async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) };
}
async function burst(n: number, headers: Record<string, string>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fetch(`${srv.base}/runs`, { method: 'POST', headers })).status);
  return out;
}
const KEY = { 'x-kind': 'env-key', 'x-token': 'configured-key-aaaa' };

describe('ADR 0771 addendum — the keyed run budget', () => {
  beforeEach(async () => {
    _resetRateLimitState();
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY = '2';
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = '100';
    process.env.OPENWOP_RATELIMIT_SESSION_CONCURRENT = '0';
    process.env.OPENWOP_RATELIMIT_KEY_RUNS_PER_DAY = '4';
    process.env.OPENWOP_API_KEYS = 'configured-key-aaaa:*';
    srv = await listen(synthetic());
  });
  afterEach(async () => { await srv.close(); });

  it('a configured env-key starts runs past the session day cap, up to its own, then 429 key_runs_per_day', async () => {
    expect(await burst(4, KEY)).toEqual([201, 201, 201, 201]);
    const res = await fetch(`${srv.base}/runs`, { method: 'POST', headers: KEY });
    expect(res.status).toBe(429);
    const body = await res.json() as { details?: { reason?: string; scope?: string } };
    expect(body.details).toMatchObject({ reason: 'key_runs_per_day', scope: 'key' });
  });

  it('a SESSION caller in the same tenant still gets the session cap, and the key took none of it', async () => {
    await burst(4, KEY);
    expect(await burst(3, { 'x-kind': 'subject' })).toEqual([201, 201, 429]);
  });

  it('an anonymous caller keeps the session cap', async () => {
    expect(await burst(3, { 'x-kind': 'anon' })).toEqual([201, 201, 429]);
  });

  it('a user-minted developer key (api-key) gets no keyed run budget', async () => {
    expect(await burst(3, { 'x-kind': 'api-key', 'x-token': 'owk_whatever' })).toEqual([201, 201, 429]);
  });

  it('HIGH-1: the built-in dev-token of an UNCONFIGURED deployment gets no keyed run budget', async () => {
    delete process.env.OPENWOP_API_KEYS; delete process.env.OPENWOP_API_KEY;
    expect(await burst(3, { 'x-kind': 'env-key', 'x-token': 'dev-token' })).toEqual([201, 201, 429]);
  });

  it('a refused run is never charged to the key (a quota probe is free)', async () => {
    await burst(10, { ...KEY, 'x-fail': '1' });
    expect(await burst(4, KEY)).toEqual([201, 201, 201, 201]);
  });

  it('KEY_RUNS_PER_DAY=0 means unlimited for the key, never a fallback to the session cap', async () => {
    process.env.OPENWOP_RATELIMIT_KEY_RUNS_PER_DAY = '0';
    expect((await burst(6, KEY)).every((s) => s === 201)).toBe(true);
  });
});

describe('ADR 0771 addendum 2: the keyed concurrency budget', () => {
  beforeEach(async () => {
    _resetRateLimitState();
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY = '0';
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = '0';
    process.env.OPENWOP_RATELIMIT_SESSION_CONCURRENT = '5';
    process.env.OPENWOP_RATELIMIT_KEY_RUNS_PER_DAY = '0';
    process.env.OPENWOP_RATELIMIT_KEY_CONCURRENT = '8';
    process.env.OPENWOP_API_KEYS = 'configured-key-aaaa:*';
    srv = await listen(synthetic());
  });
  afterEach(async () => { await srv.close(); });

  it('a SESSION caller is refused session_concurrent at the 6th in-flight run', async () => {
    expect(await burst(5, { 'x-kind': 'subject', 'x-hold': '1' })).toEqual([201, 201, 201, 201, 201]);
    const res = await fetch(`${srv.base}/runs`, { method: 'POST', headers: { 'x-kind': 'subject', 'x-hold': '1' } });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe('session_concurrent');
  });

  it('a configured env-key holds past the session 5, up to its own cap, then 429 key_concurrent', async () => {
    expect(await burst(8, { ...KEY, 'x-hold': '1' })).toEqual(Array(8).fill(201));
    const res = await fetch(`${srv.base}/runs`, { method: 'POST', headers: { ...KEY, 'x-hold': '1' } });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { details?: { reason?: string; scope?: string } }).details).toMatchObject({ reason: 'key_concurrent', scope: 'key' });
  });

  it("the key's in-flight runs take none of its tenant's session slots", async () => {
    await burst(8, { ...KEY, 'x-hold': '1' });
    expect(await burst(6, { 'x-kind': 'subject', 'x-hold': '1' })).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it('a developer key (api-key) keeps the session cap', async () => {
    expect(await burst(6, { 'x-kind': 'api-key', 'x-token': 'owk_whatever', 'x-hold': '1' })).toEqual([201, 201, 201, 201, 201, 429]);
  });
});
