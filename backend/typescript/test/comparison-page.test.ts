/**
 * ADR 0485 — the public, host-global "Comparison" CMS page seeded by
 * host/comparisonPage.ts. Drives over HTTP: seeding via the example-data run,
 * then the PUBLIC unauthenticated delivery at
 * /v1/host/openwop-app/public/host-site/pages/compare (the surface the SPA's
 * /p/compare route reads). Mirrors features-page.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const pub = (path: string) => fetch(`${BASE}${path}`); // NO auth

interface PublicPage { slug: string; title: string; sections: { type: string; data: Record<string, unknown> }[] }

describe('comparison page — seeded host-global + publicly delivered', () => {
  it('seeds via the example-data run and is registered on the dashboard', async () => {
    const status = await admin('GET', '/v1/host/openwop-app/example-data/status');
    const steps = (await status.json() as { steps: { id: string }[] }).steps;
    expect(steps.some((s) => s.id === 'comparison-page')).toBe(true);

    const run = await admin('POST', '/v1/host/openwop-app/example-data/run', { steps: ['comparison-page'] });
    expect(run.status).toBe(200);
  });

  it('serves the published comparison page on the PUBLIC (unauthenticated) surface', async () => {
    const res = await pub('/v1/host/openwop-app/public/host-site/pages/compare');
    expect(res.status).toBe(200);
    const page = await res.json() as PublicPage;
    expect(page.slug).toBe('compare');
    expect(page.sections[0].type).toBe('hero');
    // The matrix section is present and non-empty on both axes.
    const matrix = page.sections.find((s) => s.type === 'comparison');
    expect(matrix).toBeDefined();
    const d = matrix!.data as { columns?: string[]; rows?: { label: string; cells: string[] }[] };
    expect((d.columns ?? []).length).toBeGreaterThan(1);
    expect((d.rows ?? []).length).toBeGreaterThan(1);
    // OpenWOP is the first (highlighted) column, and every row has a cell for it.
    expect(d.columns![0]).toBe('OpenWOP');
    expect(d.rows!.every((r) => r.cells.length >= 1)).toBe(true);
  });

  it('re-seeding is idempotent (no duplicate comparison page)', async () => {
    await admin('POST', '/v1/host/openwop-app/example-data/run', { steps: ['comparison-page'] });
    const status = await admin('GET', '/v1/host/openwop-app/example-data/status');
    const cmp = (await status.json() as { steps: { id: string; count: number }[] }).steps.find((s) => s.id === 'comparison-page');
    expect(cmp?.count).toBe(1);
  });
});
