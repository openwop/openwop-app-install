/**
 * Demo-seeder registry endpoints (the `/demo-data` dashboard surface):
 *   GET  /host/openwop-app/example-data/status  — per-step live counts
 *   POST /host/openwop-app/example-data/run     — seed selected steps, dryRun preview
 *   POST /host/openwop-app/example-data/clear   — remove demo entities
 *
 * Proves the registry is honest (counts reflect real stored data), extensible
 * (status enumerates every registered step), idempotent (re-run skips), and
 * reversible (clear empties the counts again).
 *
 * Covers host/exampleDataSeeders.ts + routes/agentOps.ts.
 *
 * The status → dryRun → run → re-run → clear sequence is ONE lifecycle case
 * (it is a single ordered claim); the step-selection case clears first. So the
 * file passes in any order. Every `.every(...)` is preceded by a non-empty check
 * — an empty result list would otherwise satisfy it.
 *
 * Tracker: TST-DBA-6. Red when: dryRun writes, a re-run reports `created`
 * for present data, or the step selection is ignored (probes w70g2-reg-dry,
 * -reg-skip, -reg-select).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { RunResult } from '../src/host/exampleDataSeeders.js';

let server: http.Server;
let BASE: string;

// The host-global seeder steps that are ensured at boot (NOT per-tenant), so they are
// present from the start — the system home page (cms-homepage) + the public Features page
// (features-page, #849/#850). Both are marked `hostGlobal:true` in exampleDataSeeders.ts.
// HOST-GLOBAL seeder steps are ensured at BOOT, so they are already non-empty
// before any per-tenant seeding runs. `comparison-page` (ADR 0485, #2499) is one
// and was never added here, which failed this gate on main.
const HOST_GLOBAL = new Set(['cms-homepage', 'features-page', 'comparison-page', 'marketing-content-pages']);

const TOKEN = 'dev-token';
async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}

interface Step { id: string; label: string; description: string; count: number }

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; // single fixed 'default' tenant
  const app = await createApp({
    port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

// Host-global content is deployment-wide and never cleared per-tenant (plus the
// legal pages). Derived from the ONE `HOST_GLOBAL` set above — this used to be a
// second hand-maintained literal, and both copies missed `comparison-page` when
// ADR 0485 added it.
const CLEAR_EXEMPT = new Set([...HOST_GLOBAL, 'marketing-legal-pages']);

const status = async (): Promise<Step[]> => {
  const r = await api<{ steps: Step[] }>('/host/openwop-app/example-data/status');
  expect(r.status).toBe(200);
  return r.body.steps;
};
const clearAll = async (): Promise<void> => {
  const { body } = await api<RunResult>('/host/openwop-app/example-data/clear', { method: 'POST', body: JSON.stringify({ expectedTenantId: 'default' }) });
  expect(body.success).toBe(true);
};

describe('demo-seeder registry', () => {
  it('status → dryRun → run → re-run → clear: honest counts, no-write preview, idempotent, reversible', async () => {
    // Start from a cleared tenant whatever ran before.
    await clearAll();

    // status enumerates every registered step.
    const steps0 = await status();
    const ids = steps0.map((s) => s.id);
    for (const id of ['agents', 'advisors', 'workforces', 'cms-homepage']) expect(ids).toContain(id);
    for (const s of steps0) {
      expect(typeof s.label).toBe('string');
      expect(typeof s.description).toBe('string');
    }
    // Per-tenant seeders are empty; the HOST-GLOBAL content (the system front page +
    // the public Features page, #849/#850) is ensured at boot, so it is present.
    // (The legal pages are clear-exempt, so after an earlier run they may be present.)
    const perTenant0 = steps0.filter((s) => !CLEAR_EXEMPT.has(s.id));
    expect(perTenant0.length).toBeGreaterThan(0);
    for (const s of perTenant0) expect(s.count, s.id).toBe(0);
    for (const id of HOST_GLOBAL) expect(steps0.find((s) => s.id === id)?.count, id).toBeGreaterThanOrEqual(1);

    // dryRun previews without writing.
    const dry = await api<RunResult>('/host/openwop-app/example-data/run', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
    expect(dry.body.dryRun).toBe(true);
    const dryPerTenant = dry.body.results.filter((r) => !CLEAR_EXEMPT.has(r.step));
    expect(dryPerTenant.length).toBeGreaterThan(0);
    expect(dryPerTenant.every((r) => r.action === 'created')).toBe(true);
    const afterDry = (await status()).filter((s) => !CLEAR_EXEMPT.has(s.id));
    expect(afterDry.every((s) => s.count === 0)).toBe(true);

    // run seeds all steps; counts go up.
    const first = await api<RunResult>('/host/openwop-app/example-data/run', { method: 'POST', body: JSON.stringify({ expectedTenantId: 'default' }) });
    expect(first.body.success).toBe(true);
    expect(first.body.summary.created).toBeGreaterThan(0);
    const seeded = await status();
    expect(seeded.find((s) => s.id === 'agents')?.count).toBeGreaterThan(0);
    expect(seeded.find((s) => s.id === 'workforces')?.count).toBeGreaterThan(0);

    // re-run skips (idempotent).
    const second = await api<RunResult>('/host/openwop-app/example-data/run', { method: 'POST', body: JSON.stringify({ expectedTenantId: 'default' }) });
    expect(second.body.summary.created).toBe(0); // all present → skipped
    expect(second.body.results.length).toBeGreaterThan(0);
    expect(second.body.results.every((r) => r.action === 'skipped')).toBe(true);

    // clear removes demo entities; per-tenant counts return to zero.
    await clearAll();
    const cleared = (await status()).filter((s) => !CLEAR_EXEMPT.has(s.id));
    expect(cleared.every((s) => s.count === 0)).toBe(true);
  }, 90_000); // #4176: the full run timed out at 15 s under peer load; two full runs here

  it('run honours a step selection', async () => {
    await clearAll();
    const { body } = await api<RunResult>('/host/openwop-app/example-data/run', { method: 'POST', body: JSON.stringify({ steps: ['agents'], expectedTenantId: 'default' }) });
    expect(body.results.map((r) => r.step)).toEqual(['agents']);
    // Only the selected step wrote: agents present, workforces untouched.
    const after = await status();
    expect(after.find((s) => s.id === 'agents')?.count).toBeGreaterThan(0);
    expect(after.find((s) => s.id === 'workforces')?.count).toBe(0);
  }, 30_000);
});
