/**
 * ADR 0987 D6 / P4 — the superadmin run-admission summary on the Operations surface.
 *
 * What it must show, and what each case proves:
 *  - every refusal family is COUNTED where it happens: a concurrency refusal at the
 *    run-insert seam (every lane, D3), a window refusal in the quota middleware, a
 *    plan refusal in the plan reserver, each by reason;
 *  - the holding count is the D2 index's view (a `pending`/`running` run with an
 *    admission key holds; a suspended run and an unkeyed run do not) and is bounded;
 *  - the route is superadmin-only and carries the caps and the D5 posture in effect,
 *    with no key, digest, session or tenant in the body.
 *
 * The refusals are driven through the real middleware, seam and reserver, then read
 * back out of the real route, so a counter nobody increments cannot pass.
 *
 * Sabotage notes (each run red, 2026-10-31):
 *  - drop the `recordAdmissionRefusal('concurrency', …)` line in runInsert → red
 *    ("a concurrency refusal is counted at the seam");
 *  - drop the window `recordAdmissionRefusal` in rateLimit → red ("window refusal");
 *  - drop the plan `recordAdmissionRefusal` for `plan_run_limit_reached` → red
 *    ("plan refusal");
 *  - remove `admission_key IS NOT NULL` from the holding count → red (an unkeyed run
 *    counts);
 *  - drop the LIMIT from the holding count → red ("bounded");
 *  - remove `requireSuperadmin` from the route → red ("refuses a non-superadmin").
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { openStorage } from '../src/storage/index.js';
import { AdmissionRefusedError, type Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { chargedAdmission, insertRunWithStartContext } from '../src/host/runInsert.js';
import { registerPlanLimitsResolver } from '../src/host/planLimitsSeam.js';
import { billingPlanLimitsResolver } from '../src/features/billing/feature.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { admissionRefusalCounts, _resetAdmissionRefusals } from '../src/host/admissionRefusals.js';
import { ADMISSION_HOLDING_COUNT_LIMIT, type AdmissionFamilySummary } from '../src/host/admissionSummary.js';
import { _resetRateLimitState, runQuotaMiddleware } from '../src/middleware/rateLimit.js';

const run = (runId: string, status: RunRecord['status'] = 'running', tenantId = 't-p4'): RunRecord => {
  const now = new Date().toISOString();
  return { runId, workflowId: 'wf', tenantId, status, inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
};

describe('ADR 0987 D6 — refusals are counted where they happen', () => {
  let storage: Storage;
  beforeEach(async () => {
    storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    _resetAdmissionRefusals();
  });
  afterEach(() => {
    registerPlanLimitsResolver(null);
    delete process.env.OPENWOP_BILLING_PLAN_LIMITS;
    __resetHostExtPersistence();
  });

  it('a concurrency refusal is counted at the seam, and the holding count is the D2 view', async () => {
    const scope = { key: 'p4-scope-digest', cap: 1 };
    await insertRunWithStartContext(storage, run('h1'), { admission: chargedAdmission(scope) });
    await expect(insertRunWithStartContext(storage, run('h2'), { admission: chargedAdmission(scope) }))
      .rejects.toBeInstanceOf(AdmissionRefusedError);
    expect(admissionRefusalCounts().concurrency).toEqual({ at_cap: 1 });

    // A run with no admission key never holds; a suspended run holds no slot (D4).
    await insertRunWithStartContext(storage, run('u1'), { admission: chargedAdmission() });
    await insertRunWithStartContext(storage, run('w1', 'waiting-approval'), { admission: chargedAdmission({ key: 'p4-other', cap: 5 }) });
    expect(await storage.countAdmissionHolding(ADMISSION_HOLDING_COUNT_LIMIT)).toBe(1);
  });

  it('the holding count is bounded: it stops at its limit', async () => {
    for (const id of ['b1', 'b2', 'b3']) {
      await insertRunWithStartContext(storage, run(id), { admission: chargedAdmission({ key: `p4-b-${id}`, cap: 5 }) });
    }
    expect(await storage.countAdmissionHolding(1000)).toBe(3);
    expect(await storage.countAdmissionHolding(2)).toBe(2);
  });

  it('a plan refusal is counted by its reason', async () => {
    registerToggleDefault({ id: 'billing', label: 'Billing', description: 'b', status: 'on', bucketUnit: 'tenant', salt: 'billing' });
    registerPlanLimitsResolver(billingPlanLimitsResolver);
    process.env.OPENWOP_BILLING_PLAN_LIMITS = JSON.stringify({ free: { workflowRuns: 1 } });
    await insertRunWithStartContext(storage, run('p1', 'running', 't-plan'), { admission: chargedAdmission() });
    await expect(insertRunWithStartContext(storage, run('p2', 'running', 't-plan'), { admission: chargedAdmission() }))
      .rejects.toMatchObject({ httpStatus: 429 });
    expect(admissionRefusalCounts().plan).toEqual({ plan_run_limit_reached: 1 });
  });
});

describe('ADR 0987 D6 — the Operations route', () => {
  const SUPER_TENANT = 'org:test-p4-super';
  const OPS = '/host/openwop-app/operations';
  let BASE: string;
  let server: http.Server;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    process.env.OPENWOP_SUPERADMIN_TENANTS = SUPER_TENANT;
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = '1';
    process.env.OPENWOP_RATELIMIT_SESSION_CONCURRENT = '3';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const { createApp } = await import('../src/index.js');
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  }, 60_000);

  afterAll(async () => {
    for (const k of ['OPENWOP_SUPERADMIN_TENANTS', 'OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN', 'OPENWOP_RATELIMIT_SESSION_CONCURRENT']) delete process.env[k];
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function login(tenantId: string): Promise<(path: string) => Promise<{ status: number; body: any }>> {
    const r = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `p4-${Date.now()}-${Math.random()}@acme.test`, tenantId }),
    });
    expect(r.status).toBe(201);
    const cookie = (getSetCookies(r.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean) ?? '';
    return async (path) => {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      return { status: res.status, body: await res.json().catch(() => undefined) };
    };
  }

  /** A run-creating route behind the REAL quota middleware, so the window refusal
   *  below is the one the middleware records, not one the test writes. */
  async function windowRefusal(): Promise<void> {
    _resetRateLimitState();
    const a = express();
    a.use((req, _res, next) => { req.tenantId = 'tenant-p4-window'; next(); });
    a.post('/runs', runQuotaMiddleware(), (_req, res) => { res.status(201).json({ ok: true }); });
    const s = http.createServer(a);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    try {
      const { port } = s.address() as AddressInfo;
      const statuses: number[] = [];
      for (let i = 0; i < 2; i += 1) statuses.push((await fetch(`http://127.0.0.1:${port}/runs`, { method: 'POST' })).status);
      expect(statuses).toEqual([201, 429]);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  it('refuses a non-superadmin', async () => {
    const get = await login('org:test-p4-member');
    const r = await get(`${OPS}/admission/summary`);
    expect(r.status).toBe(403);
  });

  it('shows the caps, the posture, and the refusals the real middleware recorded', async () => {
    await windowRefusal();
    const get = await login(SUPER_TENANT);
    const r = await get(`${OPS}/admission/summary`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const fam: Record<string, AdmissionFamilySummary> = Object.fromEntries((r.body.families as AdmissionFamilySummary[]).map((f) => [f.family, f]));
    expect(Object.keys(fam)).toEqual([
      'concurrency.session', 'concurrency.key', 'runs.session.minute', 'runs.session.day', 'runs.key.day', 'runs.ip.day', 'plan.monthly',
    ]);
    expect(fam['concurrency.session']).toMatchObject({ cap: 3, posture: 'transactional', refusals: null });
    expect(fam['runs.session.minute']).toMatchObject({ cap: 1, windowS: 60, refusals: { session_runs_per_min: 1 } });
    expect(fam['plan.monthly']).toMatchObject({ cap: null });
    // The posture follows the deploy profile (D5): this test host is not `auth`.
    expect(r.body.profile).toBe('evaluation');
    expect(fam['runs.session.minute'].posture).toBe('open');
    expect(r.body).toMatchObject({ perInstance: true, holding: { atLeast: false, limit: ADMISSION_HOLDING_COUNT_LIMIT } });
    // Counts and configuration only: nothing that identifies a caller.
    expect(JSON.stringify(r.body)).not.toMatch(/tenant-p4-window|s:|[0-9a-f]{32}/);
  });
});
