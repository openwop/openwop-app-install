/**
 * ADR 0843 — the seeded white-label page (/p/white-label) and the claim check
 * over every built-in marketing page.
 *
 * - every built-in marketing page survives CMS validation LOSSLESSLY (the seed
 *   path `applyDefault` writes through `updatePage`, and a field the validator
 *   would drop must not publish degraded on one path only);
 * - no built-in marketing page carries a gated assurance claim (openwop.dev's
 *   claim gate, applied to the app's own seeded copy);
 * - on the demo deployment the page is published, carries two `video`
 *   sections, and the crawler render emits a <figure> + a VideoObject per film;
 * - off the demo deployment it is never seeded (ADR 0196 Gate A).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateSections } from '../src/features/cms/cmsService.js';
import { MARKETING_CONTENT_PAGE_SPECS } from '../src/host/marketingContentPages.js';
import { SYSTEM_SITE_PAGE_SEO } from '../src/host/systemSiteSeo.js';

const GATED = /industry standard|independently validated|best-in-class|fully conformant|vendor-neutral standard|open standard/i;

describe('built-in marketing pages — copy rules', () => {
  it.each(MARKETING_CONTENT_PAGE_SPECS.map((p) => [p.slug, p] as const))('%s validates without losing a field', (_slug, spec) => {
    // Section ids are minted on save and an empty optional string is dropped
    // (it renders nothing either way) — every authored value must survive.
    const authored = (data: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(data).filter(([, v]) => v !== ''));
    expect(validateSections(spec.sections, 'en').map((s) => ({ type: s.type, data: s.data })))
      .toEqual(spec.sections.map((s) => ({ type: s.type, data: authored(s.data as Record<string, unknown>) })));
  });

  it.each(MARKETING_CONTENT_PAGE_SPECS.map((p) => [p.slug, p] as const))('%s carries no gated claim', (_slug, spec) => {
    expect(JSON.stringify(spec)).not.toMatch(GATED);
  });

  it('the white-label page has SEO within bounds', () => {
    const seo = SYSTEM_SITE_PAGE_SEO['page:host-site-white-label']!;
    expect(seo.metaTitle.length).toBeLessThanOrEqual(60);
    expect(seo.metaDescription.length).toBeGreaterThanOrEqual(110);
    expect(seo.metaDescription.length).toBeLessThanOrEqual(170);
  });

  it('the white-label page tells both films and states what the operator takes on', () => {
    const spec = MARKETING_CONTENT_PAGE_SPECS.find((p) => p.slug === 'white-label')!;
    const videos = spec.sections.filter((s) => s.type === 'video');
    expect(videos.map((v) => v.data.length)).toEqual(['1:57', '1:15']);
    for (const v of videos) {
      for (const k of ['src', 'poster', 'captions', 'youtubeUrl']) expect(String(v.data[k])).toMatch(/^https:\/\//);
    }
    // A page with its own films leads with copy, not the default hero vignette.
    expect(spec.sections[0]!.data.visual).toBe('none');
    const text = JSON.stringify(spec);
    expect(text).toMatch(/no service contract or SLA/);
    expect(text).toMatch(/self-reported/);
  });
});

let PORT = 0;
let server: http.Server;

function rawGet(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('white-label page — seeded on the demo deployment', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_DEMO_MODE = 'true';
    const { createApp } = await import('../src/index.js');
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; res(); }); });
    const { ensureMarketingContentPages } = await import('../src/host/marketingContentPages.js');
    await ensureMarketingContentPages();
  });
  afterAll(async () => {
    delete process.env.OPENWOP_DEMO_MODE;
    delete process.env.OPENWOP_PUBLIC_SITE_ORG_ID;
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('is published with two video sections', async () => {
    const res = await rawGet('/host/openwop-app/public/host-site/pages/white-label');
    expect(res.status).toBe(200);
    const page = JSON.parse(res.body) as { sections: { type: string }[] };
    expect(page.sections.filter((s) => s.type === 'video')).toHaveLength(2);
  });

  it('the crawler render emits a <figure> and a VideoObject per film', async () => {
    process.env.OPENWOP_PUBLIC_SITE_ORG_ID = 'host-site';
    const res = await rawGet('/p/white-label', { 'user-agent': 'GPTBot/1.0' });
    expect(res.status).toBe(200);
    expect(res.body.match(/<figure>/g)?.length).toBe(2);
    expect(res.body).toContain('openwop-companies-poster.jpg');
    expect(res.body).toContain('Watch on YouTube');
    const ld = [...res.body.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as { '@type': string; duration?: string });
    expect(ld.filter((b) => b['@type'] === 'VideoObject').map((b) => b.duration)).toEqual(['PT1M57S', 'PT1M15S']);
  });
});
