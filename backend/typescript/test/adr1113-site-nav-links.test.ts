/**
 * ADR 1113 — `siteNav.links`: menu entries a page authors for destinations that
 * are not CMS pages (an app route such as `/discover`, or a `#fragment` on the
 * owning page). Each entry is a full nav entry in its own group.
 *
 *   - each entry needs a label, a safe href (internal path or fragment, never
 *     an external URL) and a group; description, order and groupLabel follow
 *     the page-level rules; anything else is a 400 naming the entry's field;
 *   - at most 12 per page; an empty list is absent;
 *   - the public nav read carries the links in the page's row `nav`.
 *
 * Refusals are asserted by the FIELD they name (as in adr1062-site-chrome), so
 * two guards that share a code and status cannot stand in for each other.
 *
 * Sabotage witnesses: dropping `links` from `cleanSiteNav` reds the accepts
 * and route cases; accepting an external href, a missing group or a missing
 * label reds the refuses case; removing the cap reds the cap case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { cleanSiteNav } from '../src/features/cms/cmsService.js';
import type { PublicNavPage } from '../src/features/publishing/publishingService.js';
import { OpenwopError } from '../src/types.js';

let BASE: string;
let server: http.Server;
let savedTtl: string | undefined;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const SITE = '/host/openwop-app/cms/orgs/host-site';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  savedTtl = process.env.OPENWOP_PUBLIC_LIST_TTL_S;
  process.env.OPENWOP_PUBLIC_LIST_TTL_S = '0'; // the public list memo would hide the publish
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => {
  if (savedTtl === undefined) Reflect.deleteProperty(process.env, 'OPENWOP_PUBLIC_LIST_TTL_S'); else process.env.OPENWOP_PUBLIC_LIST_TTL_S = savedTtl;
  await new Promise<void>((res) => server.close(() => res()));
});

const admin = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

function refusal(fn: () => unknown): OpenwopError {
  try { fn(); } catch (err) { if (err instanceof OpenwopError) return err; throw err; }
  throw new Error('expected a refusal');
}
const fieldOf = (fn: () => unknown): unknown => refusal(fn).details?.field;

describe('cleanSiteNav links (ADR 1113)', () => {
  it('keeps trimmed entries with an internal path or a fragment, in their own groups', () => {
    expect(cleanSiteNav({
      links: [
        { label: '  Discover ', href: ' /discover ', group: 'audience', description: ' Compare challenges ', order: 10, groupLabel: ' Challenges ' },
        { label: 'Today', href: '#today', group: 'product' },
      ],
    })).toEqual({
      links: [
        { label: 'Discover', href: '/discover', group: 'audience', description: 'Compare challenges', order: 10, groupLabel: 'Challenges' },
        { label: 'Today', href: '#today', group: 'product' },
      ],
    });
    // Caps follow the page-level fields.
    const [l] = cleanSiteNav({ links: [{ label: 'x'.repeat(60), href: '/a', group: 'trust', description: 'y'.repeat(120) }] })?.links ?? [];
    expect(l?.label).toHaveLength(40);
    expect(l?.description).toHaveLength(90);
  });

  it('treats an empty list as absent', () => {
    expect(cleanSiteNav({ links: [] })).toBeUndefined();
    expect(cleanSiteNav({ group: 'product', links: [] })).toEqual({ group: 'product' });
  });

  it('refuses a bad entry by the field it names', () => {
    const ok = { label: 'Discover', href: '/discover', group: 'audience' };
    const cases: [unknown, string][] = [
      ['/discover', 'siteNav.links'],
      [['nope'], 'siteNav.links[0]'],
      [[{ ...ok, label: undefined }], 'siteNav.links[0].label'],
      [[{ ...ok, label: '   ' }], 'siteNav.links[0].label'],
      [[ok, { ...ok, label: 7 }], 'siteNav.links[1].label'],
      [[{ ...ok, href: undefined }], 'siteNav.links[0].href'],
      [[{ ...ok, href: 'https://evil.example/x' }], 'siteNav.links[0].href'],
      [[{ ...ok, href: '//evil.example/x' }], 'siteNav.links[0].href'],
      [[{ ...ok, href: 'javascript:alert(1)' }], 'siteNav.links[0].href'],
      [[{ ...ok, href: '#a b' }], 'siteNav.links[0].href'],
      [[{ ...ok, group: undefined }], 'siteNav.links[0].group'],
      [[{ ...ok, group: 'pages' }], 'siteNav.links[0].group'],
      [[{ ...ok, order: 1.5 }], 'siteNav.links[0].order'],
      [[{ ...ok, order: 1000 }], 'siteNav.links[0].order'],
      [[{ ...ok, description: 3 }], 'siteNav.links[0].description'],
      [[{ ...ok, groupLabel: false }], 'siteNav.links[0].groupLabel'],
    ];
    for (const [links, field] of cases) {
      const err = refusal(() => cleanSiteNav({ links }));
      expect([err.code, err.httpStatus], field).toEqual(['validation_error', 400]);
      expect(fieldOf(() => cleanSiteNav({ links })), JSON.stringify(links)).toBe(field);
    }
  });

  it('holds at most 12 entries per page', () => {
    const many = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ label: `L${i}`, href: `/r${i}`, group: 'product' }));
    expect(cleanSiteNav({ links: many(12) })?.links).toHaveLength(12);
    expect(fieldOf(() => cleanSiteNav({ links: many(13) }))).toBe('siteNav.links');
  });
});

describe('links over the CMS routes + public nav read (ADR 1113)', () => {
  it('stores the links on PATCH and serves them in the page row nav', async () => {
    const created = await admin('POST', `${SITE}/pages`, { title: 'Links owner', slug: 'adr1113-owner' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pageId = String(created.body.pageId);
    const siteNav = { group: 'product', links: [{ label: 'Discover', href: '/discover', group: 'audience', groupLabel: 'Challenges', order: 10 }] };
    const patched = await admin('PATCH', `${SITE}/pages/${pageId}`, { siteNav });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const refused = await admin('PATCH', `${SITE}/pages/${pageId}`, { siteNav: { links: [{ label: 'Off site', href: 'https://evil.example', group: 'trust' }] } });
    expect(refused.status).toBe(400);
    expect((await admin('POST', `${SITE}/pages/${pageId}/publish`)).status).toBe(200);

    const body = (await (await fetch(`${BASE}/host/openwop-app/public/host-site/pages`)).json()) as { pages: PublicNavPage[] };
    expect(body.pages.find((p) => p.slug === 'adr1113-owner')?.nav).toEqual(siteNav);
  });
});
