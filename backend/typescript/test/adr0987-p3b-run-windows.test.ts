/**
 * ADR 0987 D1 / D5 / P3 — the per-minute and per-day run windows live in the
 * shared counter (`takeShared`, ADR 0934), not in per-process maps.
 *
 * What matters:
 *  - the count survives losing the process's memory (a second instance, or a
 *    deploy), because it is in the shared store;
 *  - a request the handler refuses (>= 400) gets its unit back, and a batch
 *    creator pays one unit per minted run (ADR 0475 H3);
 *  - a day refusal hands back the minute unit it already took;
 *  - D5: when the counter cannot answer, the strict profile (`auth`) answers
 *    503 and the evaluation profiles fall back to a per-process window.
 *
 * Determinism: the windows are FIXED windows (`floor(now / windowMs)`), so a
 * case that crossed a minute (or UTC-midnight) boundary on the real clock saw
 * its count reset mid-case. Each case freezes `Date` at 12:00:30 UTC of the
 * current day (w80), and the settlement is awaited through the KV calls it
 * makes (no fixed sleep).
 *
 * Sabotage witnesses (each reds only its named case; probes w80g3-rw-*, 2026-11-03):
 *  - takeShared never reaches the store, so every take is per-process
 *    ("survives a lost process");
 *  - the >= 400 refund removed from the finish settlement ("refused request");
 *  - `units` charged instead of `units - 1` ("batch creator");
 *  - the refund of earlier windows on a refusal removed ("day refusal");
 *  - the failure posture always `open` ("strict profile 503");
 *  - the per-process fallback that never refuses ("evaluation profile").
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { _resetSharedRateLimitLocal } from '../src/host/sharedRateLimit.js';
import { _resetRateLimitState, runQuotaMiddleware, runWindowRefusalCounts } from '../src/middleware/rateLimit.js';
import { OpenwopError } from '../src/types.js';

const ENV_KEYS = [
  'OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN',
  'OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY',
  'OPENWOP_RATELIMIT_DISABLED',
  'OPENWOP_DEPLOY_POSTURE',
  'OPENWOP_AUTH_ENFORCE_BEARER',
] as const;
const saved: Record<string, string | undefined> = {};

let storage: Storage;
/** KV calls in flight on the storage the rate limiter uses (the settlement
 *  after the response is fire-and-forget, so this is what a test can await). */
let inflight = 0;
function tracked(s: Storage): Storage {
  return new Proxy(s, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      if (prop !== 'kvGet' && prop !== 'kvCompareAndSwap') return v.bind(target);
      return (...args: unknown[]) => {
        inflight += 1;
        return Promise.resolve(Reflect.apply(v, target, args)).finally(() => { inflight -= 1; });
      };
    },
  });
}

/** A run-creation route behind the quota middleware. `?status=` picks the
 *  handler's answer; `?units=` sets a batch creator's minted-run count. */
function app(): express.Express {
  const a = express();
  a.use((req, _res, next) => { req.tenantId = 'tenant-p3b'; next(); });
  a.post('/runs', runQuotaMiddleware(), (req, res) => {
    const units = Number(req.query.units ?? 1);
    if (units > 1) (res.locals as { runQuotaUnits?: number }).runQuotaUnits = units;
    res.status(Number(req.query.status ?? 201)).json({ ok: true });
  });
  a.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof OpenwopError ? err.httpStatus : 500;
    res.status(status).json({ error: err instanceof OpenwopError ? err.code : 'internal', details: err instanceof OpenwopError ? err.details : undefined });
  });
  return a;
}

/** POST to an app on an ephemeral port; returns status and parsed body. */
async function post(a: express.Express, path: string): Promise<{ status: number; body: { error?: string; details?: { reason?: string } } }> {
  const server = http.createServer(a);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });
    return { status: res.status, body: await res.json() as { error?: string; details?: { reason?: string } } };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** The settlement runs after the response: drain the turn, then wait until no
 *  KV call it started is still in flight. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  await vi.waitFor(() => expect(inflight).toBe(0), { timeout: 2_000, interval: 5 });
}

beforeAll(async () => {
  storage = await openSqliteStorage(join(mkdtempSync(join(tmpdir(), 'openwop-adr0987-p3b-')), 'kv.db'));
});
afterAll(async () => {
  await storage.close().catch(() => undefined);
  __resetHostExtPersistence();
});
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = '3';
  process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY = '1000';
  // 12:00:30 UTC of the current (possibly clock-shifted) day: no case can cross
  // a minute or a day window. Only Date is faked; timers stay real.
  const anchor = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 43_230_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(anchor);
  inflight = 0;
  __resetHostExtPersistence();
  initHostExtPersistence(tracked(storage));
  _resetRateLimitState();
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('ADR 0987 P3 — shared run windows', () => {
  it('the minute count survives a lost process: it is in the shared store, not in memory', async () => {
    const a = app();
    for (let i = 0; i < 3; i += 1) expect((await post(a, '/runs')).status).toBe(201);
    // A second instance (or a deploy) has none of this process's memory.
    _resetSharedRateLimitLocal();
    const r = await post(app(), '/runs');
    expect(r.status).toBe(429);
    expect(r.body.details?.reason).toBe('session_runs_per_min');
  });

  it('a request the handler refuses gets its unit back', async () => {
    const a = app();
    for (let i = 0; i < 5; i += 1) expect((await post(a, '/runs?status=422')).status).toBe(422);
    await settle();
    for (let i = 0; i < 3; i += 1) expect((await post(a, '/runs')).status).toBe(201);
    const r = await post(a, '/runs');
    expect(r.status).toBe(429);
    expect(r.body.details?.reason).toBe('session_runs_per_min');
  });

  it('a batch creator pays one unit per minted run', async () => {
    const a = app();
    expect((await post(a, '/runs?units=2')).status).toBe(201);
    await settle();
    // Two of three units spent: exactly one more run fits.
    expect((await post(a, '/runs')).status).toBe(201);
    const r = await post(a, '/runs');
    expect(r.status).toBe(429);
    expect(r.body.details?.reason).toBe('session_runs_per_min');
  });

  it('a day refusal hands back the minute unit it already took', async () => {
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = '2';
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY = '1';
    const a = app();
    expect((await post(a, '/runs')).status).toBe(201);
    const refused = await post(a, '/runs');
    expect(refused.status).toBe(429);
    expect(refused.body.details?.reason).toBe('session_runs_per_day');
    await settle();
    // Raise the day cap: the minute window must still hold exactly one unit.
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY = '1000';
    expect((await post(a, '/runs')).status).toBe(201);
    expect((await post(a, '/runs')).status).toBe(429);
    expect(runWindowRefusalCounts()).toMatchObject({ session_runs_per_day: 1, session_runs_per_min: 1 });
  });

  it('D5: the strict profile answers 503 when the counter cannot answer', async () => {
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    __resetHostExtPersistence(); // the shared store is gone
    const r = await post(app(), '/runs');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('service_unavailable');
    expect(r.body.details?.reason).toBe('rate_limit_unavailable');
  });

  it('D5: the evaluation profile falls back to a per-process window', async () => {
    __resetHostExtPersistence();
    const a = app();
    for (let i = 0; i < 3; i += 1) expect((await post(a, '/runs')).status).toBe(201);
    const r = await post(a, '/runs');
    expect(r.status).toBe(429);
    expect(r.body.details?.reason).toBe('session_runs_per_min');
  });
});
