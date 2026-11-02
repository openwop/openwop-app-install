/**
 * Features page (ADR 0027) — the public, host-global "Features" CMS page seeded
 * by host/featuresPage.ts. Drives over HTTP: seeding via the example-data run,
 * then the PUBLIC unauthenticated delivery at /host/openwop-app/public/host-site/
 * pages/features (the surface the SPA's /p/features route reads). Mirrors the
 * system-home-page seed pattern that site-config.test.ts covers.
 *
 * Tracker TST-DCB-1. Sabotage witnesses (grade-tests w70): red when the seeder's
 * step id changes, when the page is left unpublished, when a feature group stops
 * rendering as a `cards` grid, or when a card loses its app-path href.
 *
 * Idempotency is a TRIPLE GUARD, so no single sabotage reds it (honest ceiling):
 * the `ensuring` memo, the find-by-slug before create, and the fixed page id. The
 * case below counts real pages by slug, so it fails if all three ever give way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { listPages } from '../src/features/cms/cmsService.js';
import { SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from '../src/host/systemSite.js';
import featurePages from '../src/host/seed-data/featurePages.json';

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
interface StepRow { step: string; action: string; details?: Record<string, unknown> }

describe('features page — seeded host-global + publicly delivered', () => {
  it('seeds via the example-data run and is registered on the dashboard', async () => {
    const status = await admin('GET', '/host/openwop-app/example-data/status');
    const steps = (await status.json() as { steps: { id: string; count: number }[] }).steps;
    expect(steps.find((s) => s.id === 'features-page')?.count).toBe(1); // boot already seeded it

    const run = await admin('POST', '/host/openwop-app/example-data/run', { steps: ['features-page'] });
    expect(run.status).toBe(200);
    const row = (await run.json() as { results: StepRow[] }).results.find((r) => r.step === 'features-page');
    expect(row?.action).not.toBe('error');
    expect(row?.details?.hostGlobal).toBe(true);
  });

  it('serves the published features page on the PUBLIC (unauthenticated) surface', async () => {
    const res = await pub('/host/openwop-app/public/host-site/pages/features');
    expect(res.status).toBe(200);
    const page = await res.json() as PublicPage;
    expect(page.slug).toBe('features');
    // Composed from existing section types only (no bespoke type) and non-empty.
    expect(page.sections.length).toBeGreaterThan(2);
    expect(page.sections[0].type).toBe('hero');
    expect(page.sections[0].data.heading).toBe(featurePages.hero.heading); // the seed source's copy
    expect(page.sections.every((s) => ['hero', 'richText', 'image', 'cta', 'columns'].includes(s.type))).toBe(true);
    // One feature CARD grid (layout:'cards' — not the 'steps'/'stats' columns
    // sections, which carry no per-card href) per group in the seed source, and
    // each card is a whole-card link (href = appPath), not an inline link in the text.
    const grids = page.sections.filter(
      (s) => s.type === 'columns' && (s.data as { layout?: string }).layout === 'cards',
    );
    expect(grids).toHaveLength(featurePages.groups.length);
    const cols = (grids[0]!.data as { columns?: { text?: string; href?: string }[] }).columns ?? [];
    expect(cols.length).toBeGreaterThan(0);
    expect(cols[0].href).toMatch(/^\//);              // internal app path
    expect(cols[0].text).not.toMatch(/\]\(/);          // no inline markdown link in card text
  });

  it('re-seeding is idempotent (no duplicate features page)', async () => {
    await admin('POST', '/host/openwop-app/example-data/run', { steps: ['features-page'] });
    await admin('POST', '/host/openwop-app/example-data/run', { steps: ['features-page'] });
    // Counted in STORAGE by slug — the seeder's own `count()` is 0/1 by
    // construction, so it could never show a duplicate.
    const pages = (await listPages(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG)).filter((p) => p.slug === featurePages.slug);
    expect(pages).toHaveLength(1);
    const status = await admin('GET', '/host/openwop-app/example-data/status');
    const feat = (await status.json() as { steps: { id: string; count: number }[] }).steps.find((s) => s.id === 'features-page');
    expect(feat?.count).toBe(1);
  });
});
