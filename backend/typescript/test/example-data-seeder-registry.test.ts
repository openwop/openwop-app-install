/**
 * Demo-seeder registry endpoints (the `/demo-data` dashboard surface):
 *   GET  /v1/host/openwop-app/example-data/status  — per-step live counts
 *   POST /v1/host/openwop-app/example-data/run     — seed selected steps, dryRun preview
 *   POST /v1/host/openwop-app/example-data/clear   — remove demo entities
 *
 * Proves the registry is honest (counts reflect real stored data), extensible
 * (status enumerates every registered step), idempotent (re-run skips), and
 * reversible (clear empties the counts again).
 *
 * Covers host/exampleDataSeeders.ts + routes/agentOps.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;

// The host-global seeder steps that are ensured at boot (NOT per-tenant), so they are
// present from the start — the system home page (cms-homepage) + the public Features page
// (features-page, #849/#850). Both are marked `hostGlobal:true` in exampleDataSeeders.ts.
const HOST_GLOBAL = new Set(['cms-homepage', 'features-page']);

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
interface StepResult { step: string; action: string; message: string }
interface RunResult { success: boolean; dryRun: boolean; results: StepResult[]; summary: { created: number; skipped: number; cleared: number; errors: number; total: number } }

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; // single fixed 'default' tenant
  const app = await createApp({
    port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('demo-seeder registry', () => {
  it('status enumerates every registered step, starting at zero', async () => {
    const { status, body } = await api<{ steps: Step[] }>('/v1/host/openwop-app/example-data/status');
    expect(status).toBe(200);
    const ids = body.steps.map((s) => s.id);
    expect(ids).toContain('agents');
    expect(ids).toContain('advisors');
    expect(ids).toContain('workforces');
    expect(ids).toContain('cms-homepage');
    for (const s of body.steps) {
      expect(typeof s.label).toBe('string');
      expect(typeof s.description).toBe('string');
    }
    // Per-tenant seeders start empty; the HOST-GLOBAL content (the system front page +
    // the public Features page, #849/#850) is ensured at boot, so those are present from
    // the start and excluded from the empty-at-start assertion.
    for (const s of body.steps.filter((x) => !HOST_GLOBAL.has(x.id))) {
      expect(s.count, s.id).toBe(0);
    }
    for (const id of HOST_GLOBAL) {
      expect(body.steps.find((s) => s.id === id)!.count, id).toBeGreaterThanOrEqual(1);
    }
  });

  it('dryRun previews without writing', async () => {
    const { body } = await api<RunResult>('/v1/host/openwop-app/example-data/run', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
    expect(body.dryRun).toBe(true);
    // Empty per-tenant seeders would create; the always-present host-global pages would skip.
    expect(body.results.filter((r) => !HOST_GLOBAL.has(r.step)).every((r) => r.action === 'created')).toBe(true);
    const after = await api<{ steps: Step[] }>('/v1/host/openwop-app/example-data/status');
    expect(after.body.steps.filter((s) => !HOST_GLOBAL.has(s.id)).every((s) => s.count === 0)).toBe(true);
  });

  it('run seeds all steps; counts go up; re-run skips (idempotent)', async () => {
    const first = await api<RunResult>('/v1/host/openwop-app/example-data/run', { method: 'POST', body: JSON.stringify({}) });
    expect(first.body.success).toBe(true);
    expect(first.body.summary.created).toBeGreaterThan(0);

    const status = await api<{ steps: Step[] }>('/v1/host/openwop-app/example-data/status');
    const agents = status.body.steps.find((s) => s.id === 'agents');
    const workforces = status.body.steps.find((s) => s.id === 'workforces');
    expect(agents?.count).toBeGreaterThan(0);
    expect(workforces?.count).toBeGreaterThan(0);

    const second = await api<RunResult>('/v1/host/openwop-app/example-data/run', { method: 'POST', body: JSON.stringify({}) });
    expect(second.body.summary.created).toBe(0); // all present → skipped
    expect(second.body.results.every((r) => r.action === 'skipped')).toBe(true);
  });

  it('run honours a step selection', async () => {
    const { body } = await api<RunResult>('/v1/host/openwop-app/example-data/run', { method: 'POST', body: JSON.stringify({ steps: ['agents'] }) });
    expect(body.results.map((r) => r.step)).toEqual(['agents']);
  });

  it('clear removes demo entities; counts return to zero', async () => {
    const { body } = await api<RunResult>('/v1/host/openwop-app/example-data/clear', { method: 'POST', body: JSON.stringify({}) });
    expect(body.success).toBe(true);
    const status = await api<{ steps: Step[] }>('/v1/host/openwop-app/example-data/status');
    // Per-tenant seeders clear to zero; the host-global pages (cms-homepage,
    // features-page) are deployment-wide and never cleared per-tenant.
    const hostGlobal = new Set(['cms-homepage', 'features-page']);
    expect(status.body.steps.filter((s) => !hostGlobal.has(s.id)).every((s) => s.count === 0)).toBe(true);
  });
});
