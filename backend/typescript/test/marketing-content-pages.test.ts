/**
 * ADR 0486 follow-up — the real, PUBLISHED About + Roadmap marketing pages
 * (host/marketingContentPages.ts). Unlike the placeholder marketing/legal set,
 * these ship with genuine copy and are PUBLISHED, so the public nav's "Pages"
 * group has real destinations. Asserts: they seed, are publicly delivered at
 * /p/{about,roadmap}, carry real (non-placeholder) content, and appear in the
 * public nav list.
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
const pub = (path: string) => fetch(`${BASE}${path}`);

interface PublicPage { slug: string; sections: { type: string; data: Record<string, unknown> }[] }
interface NavPages { pages: { slug: string; title: string }[] }

describe('marketing content pages — real + published (ADR 0486 follow-up)', () => {
  it('seeds via the example-data run and registers on the dashboard', async () => {
    const status = await admin('GET', '/v1/host/openwop-app/example-data/status');
    const steps = (await status.json() as { steps: { id: string }[] }).steps;
    expect(steps.some((s) => s.id === 'marketing-content-pages')).toBe(true);
    const run = await admin('POST', '/v1/host/openwop-app/example-data/run', { steps: ['marketing-content-pages'] });
    expect(run.status).toBe(200);
  });

  it('publicly delivers About/Roadmap/Changelog/Support with real (non-placeholder) content', async () => {
    for (const slug of ['about', 'roadmap', 'changelog', 'support']) {
      const res = await pub(`/v1/host/openwop-app/public/host-site/pages/${slug}`);
      expect(res.status, `${slug} should be published + delivered`).toBe(200);
      const page = await res.json() as PublicPage;
      expect(page.slug).toBe(slug);
      expect(page.sections[0].type).toBe('hero');
      const text = JSON.stringify(page.sections);
      // Real copy, NOT the operator placeholder ("Replace this starter copy…").
      expect(text).not.toMatch(/Replace this starter copy/i);
      expect(text).toMatch(/OpenWOP|coworker|open protocol|open RFCs/i);
    }
  });

  it('appears in the public nav list so the hamburger "Pages" group fills out', async () => {
    const { pages } = await pub('/v1/host/openwop-app/public/host-site/pages').then((r) => r.json()) as NavPages;
    const slugs = pages.map((p) => p.slug);
    for (const slug of ['about', 'roadmap', 'changelog', 'support']) expect(slugs).toContain(slug);
    // The remaining marketing pages stay DRAFT placeholders → absent from the nav.
    expect(slugs).not.toContain('careers');
    expect(slugs).not.toContain('contact');
  });
});
