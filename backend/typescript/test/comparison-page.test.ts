/**
 * ADR 0485 — the public, host-global "Comparison" CMS page seeded by
 * host/comparisonPage.ts. Drives over HTTP: seeding via the example-data run,
 * then the PUBLIC unauthenticated delivery at
 * /host/openwop-app/public/host-site/pages/compare (the surface the SPA's
 * /p/compare route reads). Mirrors features-page.test.ts. Tracker: TST-CGC-1.
 *
 * Red when: the seeder is not registered under `comparison-page`; the seeded page
 * is not published (the public read 404s); the matrix section loses OpenWOP as its
 * first column.
 *
 * HONEST CEILING (idempotency): a second in-process seed cannot create a duplicate
 * by construction — `ensureComparisonPage` is memoised on a module promise, and
 * `doEnsure` looks the page up by slug before creating it under a fixed pageId.
 * Breaking either guard alone leaves the other standing, so the idempotency case
 * asserts the observable result (exactly one `compare` page in the system site,
 * and a re-run that reports `skipped`) rather than claiming to witness one guard.
 * The seeder's own `count()` is 0/1 by definition and cannot show a duplicate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { ensureComparisonPage } from '../src/host/comparisonPage.js';
import { SYSTEM_SITE_ORG, SYSTEM_SITE_TENANT } from '../src/host/systemSite.js';
import { listPages } from '../src/features/cms/cmsService.js';
import type { RunResult } from '../src/host/exampleDataSeeders.js';

let BASE: string;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // Boot fires `void ensureComparisonPage()` without awaiting it. Await the same
  // (memoised) promise so no case — in any order — reads before the seed settles.
  await ensureComparisonPage();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const pub = (path: string) => fetch(`${BASE}${path}`); // NO auth

interface PublicPage { slug: string; title: string; sections: { type: string; data: Record<string, unknown> }[] }

describe('comparison page — seeded host-global + publicly delivered', () => {
  it('seeds via the example-data run and is registered on the dashboard', async () => {
    const status = await admin('GET', '/host/openwop-app/example-data/status');
    const steps = (await status.json() as { steps: { id: string }[] }).steps;
    expect(steps.some((s) => s.id === 'comparison-page')).toBe(true);

    const run = await admin('POST', '/host/openwop-app/example-data/run', { steps: ['comparison-page'], expectedTenantId: 'default' });
    expect(run.status).toBe(200);
    const body = await run.json() as RunResult;
    // The step ran and succeeded; boot already seeded the page, so it reports `skipped`.
    expect(body.results.find((r) => r.step === 'comparison-page')).toMatchObject({ step: 'comparison-page', action: 'skipped' });
    expect(body.summary.errors).toBe(0);
  });

  it('serves the published comparison page on the PUBLIC (unauthenticated) surface', async () => {
    const res = await pub('/host/openwop-app/public/host-site/pages/compare');
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
    for (let i = 0; i < 2; i++) {
      const run = await admin('POST', '/host/openwop-app/example-data/run', { steps: ['comparison-page'], expectedTenantId: 'default' });
      expect(run.status).toBe(200);
      expect((await run.json() as RunResult).results.find((r) => r.step === 'comparison-page')?.action).toBe('skipped');
    }
    // Counted in the STORE, not through the seeder's 0/1 `count()`.
    const pages = await listPages(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG);
    expect(pages.filter((p) => p.slug === 'compare')).toHaveLength(1);
  });
});
