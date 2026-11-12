/**
 * ADR 1049 — grouped public site navigation: a CMS page's optional `siteNav`
 * placement (group / label / description / order / primary).
 *
 *   - `cleanSiteNav` accepts the closed shape, drops unknown keys, trims + caps
 *     strings, collapses an empty object to absent, and REFUSES (400) a bad
 *     group, a non-integer / out-of-range order, a non-boolean primary;
 *   - POST + PATCH round-trip it; explicit `null` clears it;
 *   - a translator grant cannot set it (page chrome, ADR 0205 D1);
 *   - the public nav list carries it as `nav` on the published page and OMITS
 *     the key for a page without one (ADR 0486 shape unchanged).
 *
 * Sabotage-witnessed (w88 probes): dropping the group allowlist, the order
 * range or integer check, or the primary/label type checks reds the "refuses"
 * case (the allowlist also reds the route case); raising the label cap or
 * keeping unknown keys reds "accepts"; storing `primary:false` reds
 * "collapses"; clearing on a siteNav-less PATCH, not deleting on `null`, or
 * dropping the POST plumbing reds the round-trip case; dropping `siteNav` from
 * the translator chrome check reds the translator case; spreading `nav`
 * unconditionally reds the omission assertion.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { cleanSiteNav } from '../src/features/cms/cmsService.js';
import { OpenwopError } from '../src/types.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getSetCookies } from './headerCookies.js';
import { errorCodeOf } from './helpers/errorEnvelope.js';

let BASE: string;
let server: http.Server;
let savedTtl: string | undefined;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  savedTtl = process.env.OPENWOP_PUBLIC_LIST_TTL_S;
  process.env.OPENWOP_PUBLIC_LIST_TTL_S = '0'; // the public list memo would hide the publish
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const loc = getToggleDefault('cms-localization');
  if (loc) await saveConfig({ ...loc, status: 'on' }, 'test');
});
afterAll(async () => {
  if (savedTtl === undefined) Reflect.deleteProperty(process.env, 'OPENWOP_PUBLIC_LIST_TTL_S'); else process.env.OPENWOP_PUBLIC_LIST_TTL_S = savedTtl;
  await new Promise<void>((res) => server.close(() => res()));
});

interface NavRow { slug: string; title: string; nav?: Record<string, unknown> }
interface PageBody { pageId: string; slug: string; version: number; siteNav?: Record<string, unknown>; title: string; error?: unknown }

const admin = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: PageBody }> => {
  const r = await fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as PageBody };
};
const SITE = '/host/openwop-app/cms/orgs/host-site';
const navList = async (): Promise<NavRow[]> =>
  ((await (await fetch(`${BASE}/host/openwop-app/public/host-site/pages`)).json()) as { pages: NavRow[] }).pages;

function refusal(fn: () => unknown): OpenwopError {
  try { fn(); } catch (err) { if (err instanceof OpenwopError) return err; throw err; }
  throw new Error('expected a refusal');
}

describe('cleanSiteNav (ADR 1049)', () => {
  it('accepts the closed shape, drops unknown keys, trims and caps strings', () => {
    expect(cleanSiteNav({ group: 'trust', label: '  Security  ', description: 'How we protect data', order: 20, primary: true, rogue: 'x' }))
      .toEqual({ group: 'trust', label: 'Security', description: 'How we protect data', order: 20, primary: true });
    const long = cleanSiteNav({ label: 'L'.repeat(80), description: 'D'.repeat(200) });
    expect(long?.label).toHaveLength(40);
    expect(long?.description).toHaveLength(90);
    // `resources` (added 2026-11-10, DeckTalk) is an authorable group.
    expect(cleanSiteNav({ group: 'resources', label: 'Guides' })).toEqual({ group: 'resources', label: 'Guides' });
    expect(cleanSiteNav({ order: 0 })).toEqual({ order: 0 });
    expect(cleanSiteNav({ order: 999 })).toEqual({ order: 999 });
  });

  it('collapses empty / null / all-blank values to absent (primary:false is not stored)', () => {
    expect(cleanSiteNav(undefined)).toBeUndefined();
    expect(cleanSiteNav(null)).toBeUndefined();
    expect(cleanSiteNav({})).toBeUndefined();
    expect(cleanSiteNav({ label: '   ', primary: false, unknown: 1 })).toBeUndefined();
  });

  it('refuses a bad group, order or primary with a 400 validation_error (never coerced)', () => {
    for (const bad of [
      { group: 'footer' },
      { group: 7 },
      { order: 1.5 },
      { order: -1 },
      { order: 1000 },
      { order: '10' },
      { primary: 'yes' },
      { label: 12 },
    ]) {
      const err = refusal(() => cleanSiteNav(bad));
      expect(err.code, JSON.stringify(bad)).toBe('validation_error');
      expect(err.httpStatus, JSON.stringify(bad)).toBe(400);
    }
    expect(refusal(() => cleanSiteNav('trust')).code).toBe('validation_error');
    expect(refusal(() => cleanSiteNav([{ group: 'trust' }])).code).toBe('validation_error');
  });
});

describe('siteNav over the CMS routes + the public nav list (ADR 1049)', () => {
  it('round-trips on POST + PATCH, clears on null, and refuses a bad group', async () => {
    const created = await admin('POST', `${SITE}/pages`, { title: 'Security', slug: 'adr1049-security', siteNav: { group: 'trust', order: 10, extra: true } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.siteNav).toEqual({ group: 'trust', order: 10 });
    const { pageId } = created.body;

    const patched = await admin('PATCH', `${SITE}/pages/${pageId}`, { siteNav: { group: 'trust', label: 'Trust center', description: 'Security & compliance', order: 5, primary: true } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.siteNav).toEqual({ group: 'trust', label: 'Trust center', description: 'Security & compliance', order: 5, primary: true });
    // A PATCH without siteNav leaves it untouched.
    const titled = await admin('PATCH', `${SITE}/pages/${pageId}`, { title: 'Security overview' });
    expect(titled.body.siteNav).toEqual(patched.body.siteNav);

    const bad = await admin('PATCH', `${SITE}/pages/${pageId}`, { siteNav: { group: 'sidebar' } });
    expect(bad.status).toBe(400);
    expect(errorCodeOf(bad.body)).toBe('validation_error');
    expect((await admin('GET', `${SITE}/pages/${pageId}`)).body.siteNav).toEqual(patched.body.siteNav);

    const cleared = await admin('PATCH', `${SITE}/pages/${pageId}`, { siteNav: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).not.toHaveProperty('siteNav');
    // Read back: the clear reached the store, not only the PATCH response.
    const reread = await admin('GET', `${SITE}/pages/${pageId}`);
    expect(reread.status).toBe(200);
    expect(reread.body.title).toBe('Security overview');
    expect(reread.body).not.toHaveProperty('siteNav');
  });

  it('the public nav list carries `nav` for a placed page and omits it otherwise', async () => {
    const placed = await admin('POST', `${SITE}/pages`, { title: 'Privacy policy', slug: 'adr1049-privacy', siteNav: { group: 'legal', label: 'Privacy', order: 10 } });
    expect(placed.status).toBe(201);
    const plain = await admin('POST', `${SITE}/pages`, { title: 'Plain page', slug: 'adr1049-plain' });
    expect(plain.status).toBe(201);
    // Draft: neither is listed (published-only, ADR 0486).
    expect((await navList()).map((p) => p.slug)).not.toContain('adr1049-privacy');
    for (const id of [placed.body.pageId, plain.body.pageId]) {
      expect((await admin('POST', `${SITE}/pages/${id}/publish`)).status).toBe(200);
    }
    const rows = await navList();
    expect(rows.find((p) => p.slug === 'adr1049-privacy')).toEqual({ slug: 'adr1049-privacy', title: 'Privacy policy', nav: { group: 'legal', label: 'Privacy', order: 10 } });
    const plainRow = rows.find((p) => p.slug === 'adr1049-plain');
    expect(plainRow).toEqual({ slug: 'adr1049-plain', title: 'Plain page' });
    expect(plainRow).not.toHaveProperty('nav');
  });
});

describe('a translator grant cannot place a page in the site nav (ADR 0205 D1 chrome)', () => {
  it('refuses siteNav from a grant-holder and leaves the page unchanged', async () => {
    let n = 0;
    const tenantId = `org:sn-${Date.now()}`;
    const mk = () => {
      let cookie = '';
      return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: PageBody & { user: { userId: string }; orgId: string; message?: string } }> => {
        const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
        return { status: res.status, body: (await res.json().catch(() => ({}))) as PageBody & { user: { userId: string }; orgId: string } };
      };
    };
    const owner = mk();
    const editor = mk();
    expect((await owner('POST', '/host/openwop-app/test/login', { email: `sn-o-${n++}-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    const ed = await editor('POST', '/host/openwop-app/test/login', { email: `sn-e-${n++}-${Date.now()}@acme.test`, tenantId });
    expect(ed.status).toBe(201);
    const org = await owner('POST', '/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const base = `/host/openwop-app/cms/orgs/${encodeURIComponent(org.body.orgId)}`;
    expect((await owner('POST', `/host/openwop-app/orgs/${encodeURIComponent(org.body.orgId)}/members`, { displayName: 'T', subject: ed.body.user.userId, roles: ['editor'] })).status).toBe(201);
    expect((await owner('PUT', `${base}/language-settings`, { supportedLocales: ['pt-BR'] })).status).toBe(200);
    const page = await owner('POST', `${base}/pages`, { title: 'About' });
    expect(page.status).toBe(201);

    // Positive control: without a grant the editor CAN set it.
    const allowed = await editor('PATCH', `${base}/pages/${page.body.pageId}`, { siteNav: { group: 'company' } });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    expect((await owner('PUT', `${base}/locale-grants`, { subject: ed.body.user.userId, locales: ['pt-BR'] })).status).toBe(200);
    const denied = await editor('PATCH', `${base}/pages/${page.body.pageId}`, { siteNav: { group: 'legal' } });
    expect(denied.status).toBe(403);
    expect(errorCodeOf(denied.body)).toBe('forbidden_scope');
    const cleared = await editor('PATCH', `${base}/pages/${page.body.pageId}`, { siteNav: null });
    expect(cleared.status).toBe(403);
    expect((await owner('GET', `${base}/pages/${page.body.pageId}`)).body.siteNav).toEqual({ group: 'company' });
  });
});
