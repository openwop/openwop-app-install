/**
 * CMS content localization (ADR 0064 / RFC 0103) — ROUTE-level harness. Boots
 * the real app and drives: the `cms-localization` toggle gate on language
 * settings, the base∉supported invariant, localization-key validation, and the
 * Accept-Language → Content-Language negotiated published read (exact / family /
 * default / malformed), published-only delivery, and per-org isolation.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function setLocalization(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('cms-localization');
  expect(d, 'cms-localization toggle must be declared').toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
}

interface Res<T = any> { status: number; headers: Headers; body: T }
interface Client {
  get: (p: string, headers?: Record<string, string>) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  put: (p: string, b?: unknown) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, headers: res.headers, body: out };
  };
  return {
    get: (p, headers) => call('GET', p, undefined, headers),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
  };
}

let n = 0;
async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `loc-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function ownerOrg(): Promise<{ owner: Client; orgId: string }> {
  const tenantId = `org:loc-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, tenantId);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const u = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${suffix}`;

/** Create + publish a one-hero page carrying a pt-BR override. */
async function publishLocalizedHome(owner: Client, orgId: string): Promise<string> {
  const created = await owner.post(u(orgId, '/pages'), {
    title: 'Home',
    sections: [{ type: 'hero', data: { heading: 'Welcome' }, localizations: { 'pt-BR': { heading: 'Bem-vindo' } } }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.sections[0].localizations['pt-BR'].heading).toBe('Bem-vindo');
  const pub = await owner.post(u(orgId, `/pages/${created.body.pageId}/publish`));
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return created.body.slug as string;
}

describe('cms-localization — toggle gate + settings invariant', () => {
  it('language-settings WRITE 404s when the toggle is OFF, succeeds when ON', async () => {
    const { owner, orgId } = await ownerOrg();
    // GET is always available (returns the default skeleton).
    const def = await owner.get(u(orgId, '/language-settings'));
    expect(def.status).toBe(200);
    expect(def.body.baseLocale).toBe('en');
    expect(def.body.supportedLocales).toEqual([]);

    await setLocalization('off');
    expect((await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] })).status).toBe(404);

    await setLocalization('on');
    const ok = await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR', 'es'], autoTranslateOnPublish: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.supportedLocales).toEqual(['pt-BR', 'es']);
    expect(ok.body.autoTranslateOnPublish).toBe(true);
  });

  it('rejects baseLocale ∈ supportedLocales (§A invariant) and invalid tags', async () => {
    await setLocalization('on');
    const { owner, orgId } = await ownerOrg();
    expect((await owner.put(u(orgId, '/language-settings'), { baseLocale: 'en', supportedLocales: ['en'] })).status).toBe(400);
    expect((await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['not a locale'] })).status).toBe(400);
  });
});

describe('cms-localization — localization-key validation', () => {
  it('rejects a localization keyed by the base locale or an invalid tag', async () => {
    await setLocalization('on');
    const { owner, orgId } = await ownerOrg();
    const baseKeyed = await owner.post(u(orgId, '/pages'), {
      title: 'X', sections: [{ type: 'hero', data: { heading: 'Hi' }, localizations: { en: { heading: 'Hi' } } }],
    });
    expect(baseKeyed.status).toBe(400);
    const badTag = await owner.post(u(orgId, '/pages'), {
      title: 'Y', sections: [{ type: 'hero', data: { heading: 'Hi' }, localizations: { 'xx-yy-zz': { heading: 'Hi' } } }],
    });
    expect(badTag.status).toBe(400);
  });

  it('sanitizes overlay fields identically to base (no XSS/open-redirect via a locale)', async () => {
    await setLocalization('on');
    const { owner, orgId } = await ownerOrg();
    const created = await owner.post(u(orgId, '/pages'), {
      title: 'Z',
      sections: [{ type: 'cta', data: { label: 'Go', url: '/agents' }, localizations: { 'pt-BR': { label: 'Ir', url: 'javascript:alert(1)' } } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // The dangerous scheme is dropped in the overlay just as it is in base.
    expect(created.body.sections[0].localizations['pt-BR'].url).toBe('');
  });
});

describe('cms-localization — negotiated published read', () => {
  it('serves the exact-locale override + Content-Language for Accept-Language: pt-BR', async () => {
    await setLocalization('on');
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR', 'es'] });
    const slug = await publishLocalizedHome(owner, orgId);

    const r = await owner.get(u(orgId, `/pages/by-slug/${slug}`), { 'accept-language': 'pt-BR' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers.get('content-language')).toBe('pt-BR');
    expect(r.headers.get('vary')).toMatch(/Accept-Language/i);
    expect(r.body.page.sections[0].data.heading).toBe('Bem-vindo');
    // Delivery strips the other locales — never exposes the localizations map.
    expect(r.body.page.sections[0].localizations).toBeUndefined();
  });

  it('falls back to base data for a supported locale with no override, and to base for an unsupported one', async () => {
    await setLocalization('on');
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR', 'es'] });
    const slug = await publishLocalizedHome(owner, orgId);

    // es IS supported but the section has no es override → base text, Content-Language es.
    const es = await owner.get(u(orgId, `/pages/by-slug/${slug}`), { 'accept-language': 'es' });
    expect(es.headers.get('content-language')).toBe('es');
    expect(es.body.page.sections[0].data.heading).toBe('Welcome');

    // de is unsupported → negotiate to base (en).
    const de = await owner.get(u(orgId, `/pages/by-slug/${slug}`), { 'accept-language': 'de' });
    expect(de.headers.get('content-language')).toBe('en');
    expect(de.body.page.sections[0].data.heading).toBe('Welcome');
  });

  it('NEVER 400s on a malformed Accept-Language — serves the base', async () => {
    await setLocalization('on');
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    const slug = await publishLocalizedHome(owner, orgId);
    const r = await owner.get(u(orgId, `/pages/by-slug/${slug}`), { 'accept-language': '!!!;;;q=zzz' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-language')).toBe('en');
    expect(r.body.page.sections[0].data.heading).toBe('Welcome');
  });

  it('serves localized content published-only (a draft is invisible by slug)', async () => {
    await setLocalization('on');
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    const created = await owner.post(u(orgId, '/pages'), {
      title: 'Draft', sections: [{ type: 'hero', data: { heading: 'Welcome' }, localizations: { 'pt-BR': { heading: 'Bem-vindo' } } }],
    });
    // Never published → by-slug 404, no localized leak.
    const r = await owner.get(u(orgId, `/pages/by-slug/${created.body.slug}`), { 'accept-language': 'pt-BR' });
    expect(r.status).toBe(404);
  });
});

describe('cms-localization — AI translate-from-base (Phase 3)', () => {
  it('404s when the toggle is OFF; validates input; degrades to 503 when the provider is unavailable', async () => {
    const { owner, orgId } = await ownerOrg();
    const payload = { sectionType: 'hero', data: { heading: 'Welcome' }, targetLocale: 'pt-BR' };

    await setLocalization('off');
    expect((await owner.post(u(orgId, '/translate-section'), payload)).status).toBe(404);

    await setLocalization('on');
    // Bad input → 400 (before any provider call).
    expect((await owner.post(u(orgId, '/translate-section'), { ...payload, sectionType: 'bogus' })).status).toBe(400);
    expect((await owner.post(u(orgId, '/translate-section'), { ...payload, targetLocale: 'not-a-locale' })).status).toBe(400);

    // Managed provider is not configured in the test host → a CLEAN 503 (the
    // editor degrades to manual translation), never a 500.
    const r = await owner.post(u(orgId, '/translate-section'), payload);
    expect([200, 503]).toContain(r.status);
    if (r.status === 200) {
      expect(typeof r.body.overlay).toBe('object');
    }
  });
});

describe('cms-localization — per-org isolation', () => {
  it('language settings are per-org (org B does not see org A\'s locales)', async () => {
    await setLocalization('on');
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR', 'fr'] });
    // A second org under the SAME owner/tenant has its own (default) settings.
    const orgB = await owner.post('/v1/host/openwop-app/orgs', { name: 'Beta' });
    const sB = await owner.get(u(orgB.body.orgId, '/language-settings'));
    expect(sB.body.supportedLocales).toEqual([]);
  });
});
