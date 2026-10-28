/**
 * ADR 0821 P5 follow-up — the plan's monthly `workflowRuns` limit is WIRED at the
 * start sites outside `startWorkflowRun` (`host/runLimitSeam.ts`), through the
 * real app boot.
 *
 * `test/adr0821-run-limit-sites.test.ts` pins that every site CALLS the seam;
 * `test/adr0821-p5-run-limit.test.ts` pins the counter at `startWorkflowRun`.
 * Neither could see the seam left at its no-op default: every site called a
 * reserver nobody had registered. This file boots `createApp` (so billing's
 * `registerRoutes` runs exactly as in production) and drives two of the wrapped
 * sites over HTTP — `POST /runs` and `:fork` (v2).
 *
 * Pins:
 *   1. a limited tenant is served under the limit (positive control) and refused
 *      at it with the typed 429 — at `POST /runs` AND at `:fork`;
 *   2. a REFUSED launch (unknown workflow) never consumes a run;
 *   3. `OPENWOP_BILLING_EXEMPT_TENANTS` still exempts;
 *   4. no `workflowRuns` key in `OPENWOP_BILLING_PLAN_LIMITS` (prod today) ⇒
 *      nothing counted, nothing refused.
 *
 * Tracker TST-BUL-7. Sabotage-witnessed (w62): red when billing stops
 * registering the reserver, `POST /runs` reserves for the wrong tenant, `:fork`
 * skips the seam, the exemption is ignored, or an absent limit counts as zero.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { planRunsThisMonth } from '../src/host/planRunLimit.js';
import type { Storage } from '../src/storage/storage.js';

let server: http.Server;
let app: Express;
let BASE: string;
// v2 surface (ADR 0642/0812: v1 is retired on app.openwop.dev; the v1-reliance ratchet forbids new
// v1 path refs in tests). Same funnel either way: the run-limit seam wraps the route, not the major.
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const WF = 'openwop-app.run-limit-wired-test';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // Billing ON for every tenant: limits only resolve under an enabled billing toggle.
  await saveConfig({ id: 'billing', status: 'on', bucketUnit: 'tenant', salt: 'billing' }, 'test');
  const created = await api('/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId: WF, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'hold' } }], edges: [] }),
  });
  expect(created.status).toBe(201);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => {
  process.env.OPENWOP_BILLING_PLAN_LIMITS = JSON.stringify({ free: { workflowRuns: 2 } });
});
afterEach(() => {
  for (const k of ['OPENWOP_BILLING_PLAN_LIMITS', 'OPENWOP_BILLING_EXEMPT_TENANTS']) delete process.env[k];
});

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** Each test spends its own month's budget: the counter is per tenant per UTC
 *  month, and every request here lands on the dev-token's tenant. So a test
 *  reads the count before it starts and asserts the delta. */
async function tenantOf(runId: string): Promise<string> {
  // v2 run ids are tenant-qualified (`<tenant>/<uuid>`); storage keys the bare id.
  const bare = runId.includes('/') ? runId.slice(runId.indexOf('/') + 1) : runId;
  const run = await (app.locals.storage as Storage).getRun(bare);
  return run?.tenantId ?? '';
}

const createRun = (workflowId = WF) => api<{ runId: string; error?: { details?: { reason?: string } } }>('/runs', {
  method: 'POST', body: JSON.stringify({ workflowId, inputs: {} }),
});

describe('ADR 0821 P5 — the run limit is wired at the non-runStarter start sites', () => {
  // ONE test owns the counter end to end: the dev-token tenant's monthly count is
  // shared across the file, so the sequence below is ordered on purpose.
  it('POST /runs and :fork are served under the limit and refused at it; a refused launch is free', async () => {
    const first = await createRun();
    expect(first.status).toBe(201); // positive control: under the limit
    const tenant = await tenantOf(first.body.runId);
    expect(tenant).not.toBe('');
    expect(await planRunsThisMonth(tenant)).toBe(1);

    // A refused launch (no such workflow) never consumes a run.
    const missing = await createRun('openwop-app.no-such-workflow');
    expect(missing.status, JSON.stringify(missing.body)).toBe(404);
    expect(JSON.stringify(missing.body)).not.toContain('plan_run_limit_reached');
    expect(await planRunsThisMonth(tenant)).toBe(1);

    // :fork is a new run and counts — the second (last) run of the month.
    const forked = await api(`/runs/${encodeURIComponent(first.body.runId)}:fork`, {
      method: 'POST', body: JSON.stringify({ mode: 'branch', fromSeq: 0 }),
    });
    expect(forked.status, JSON.stringify(forked.body)).toBe(201);
    expect(await planRunsThisMonth(tenant)).toBe(2);

    // At the limit: both sites refuse with the typed 429, and nothing is counted.
    const refused = await createRun();
    expect(refused.status).toBe(429);
    expect(JSON.stringify(refused.body)).toContain('plan_run_limit_reached');
    const refusedFork = await api(`/runs/${encodeURIComponent(first.body.runId)}:fork`, {
      method: 'POST', body: JSON.stringify({ mode: 'branch', fromSeq: 0 }),
    });
    expect(refusedFork.status).toBe(429);
    expect(JSON.stringify(refusedFork.body)).toContain('plan_run_limit_reached');
    expect(await planRunsThisMonth(tenant)).toBe(2);

    // OPENWOP_BILLING_EXEMPT_TENANTS still exempts the same tenant, at the limit.
    process.env.OPENWOP_BILLING_EXEMPT_TENANTS = JSON.stringify([tenant]);
    expect((await createRun()).status).toBe(201);
    expect(await planRunsThisMonth(tenant)).toBe(2);
    delete process.env.OPENWOP_BILLING_EXEMPT_TENANTS;

    // No `workflowRuns` key (prod today: only other limits, or none) ⇒ unchanged
    // behaviour — served at a count that would otherwise be over the limit, and
    // nothing counted.
    process.env.OPENWOP_BILLING_PLAN_LIMITS = JSON.stringify({ free: { aiCreditsMonthly: 1000 } });
    for (let i = 0; i < 3; i += 1) expect((await createRun()).status).toBe(201);
    delete process.env.OPENWOP_BILLING_PLAN_LIMITS;
    for (let i = 0; i < 2; i += 1) expect((await createRun()).status).toBe(201);
    expect(await planRunsThisMonth(tenant)).toBe(2);
  });
});
