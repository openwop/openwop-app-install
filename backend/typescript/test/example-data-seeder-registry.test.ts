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
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
const PORT = 18643;
const BASE = `http://127.0.0.1:${PORT}`;

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
    port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
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
    // Per-tenant seeders start empty; `cms-homepage` is host-global content (the
    // system front page is ensured at boot), so it's present from the start.
    for (const s of body.steps.filter((x) => x.id !== 'cms-homepage')) {
      expect(s.count, s.id).toBe(0);
    }
    expect(body.steps.find((s) => s.id === 'cms-homepage')!.count).toBeGreaterThanOrEqual(1);
  });

  it('dryRun previews without writing', async () => {
    const { body } = await api<RunResult>('/v1/host/openwop-app/example-data/run', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
    expect(body.dryRun).toBe(true);
    // Empty per-tenant seeders would create; the always-present cms-homepage would skip.
    expect(body.results.filter((r) => r.step !== 'cms-homepage').every((r) => r.action === 'created')).toBe(true);
    const after = await api<{ steps: Step[] }>('/v1/host/openwop-app/example-data/status');
    expect(after.body.steps.filter((s) => s.id !== 'cms-homepage').every((s) => s.count === 0)).toBe(true);
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
    // Per-tenant seeders clear to zero; cms-homepage is host-global (never cleared).
    expect(status.body.steps.filter((s) => s.id !== 'cms-homepage').every((s) => s.count === 0)).toBe(true);
  });
});
