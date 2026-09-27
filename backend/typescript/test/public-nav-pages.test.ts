/**
 * ADR 0486 — the public-site NAV list endpoint
 * `GET /v1/host/openwop-app/public/host-site/pages` (published CMS pages, slug +
 * title) that feeds the public shell's hamburger menu so EVERY published page is
 * reachable from the home page. Asserts: the seeded published pages (features,
 * compare) are listed; the `home` page is excluded (it is the brand link); a
 * DRAFT page never appears (published-only — no dishonest 404 link); and the
 * shape is `{ pages: [{ slug, title }] }`.
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
const navList = () => fetch(`${BASE}/v1/host/openwop-app/public/host-site/pages`); // NO auth

interface NavPages { pages: { slug: string; title: string }[] }

describe('public-site nav list (ADR 0486)', () => {
  it('lists published pages (slug + title), includes the seeded pages, excludes home', async () => {
    const res = await navList();
    expect(res.status).toBe(200);
    const { pages } = await res.json() as NavPages;
    const slugs = pages.map((p) => p.slug);
    // Seeded + published host-global pages are reachable from the menu.
    expect(slugs).toContain('features');
    expect(slugs).toContain('compare');
    // The home page is the brand link, never a menu row.
    expect(slugs).not.toContain('home');
    // Every row carries a non-empty title (the human-facing label).
    expect(pages.every((p) => typeof p.slug === 'string' && p.slug.length > 0)).toBe(true);
    expect(pages.every((p) => typeof p.title === 'string' && p.title.length > 0)).toBe(true);
  });

  it('never lists a DRAFT page (published-only — no dishonest link into an unpublished page)', async () => {
    // A draft page (created, never published) must not surface in the public nav.
    const created = await admin('POST', '/v1/host/openwop-app/cms/orgs/host-site/pages', {
      title: 'Draft Nav Probe', slug: 'draft-nav-probe',
    });
    expect(created.status).toBeLessThan(300);
    const { pages } = await navList().then((r) => r.json()) as NavPages;
    expect(pages.map((p) => p.slug)).not.toContain('draft-nav-probe');
  });
});
