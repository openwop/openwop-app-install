/**
 * ADR 0861 D6 (CMSL2WF-6) — translation status. An overlay records the base text it
 * translated (`sourceDigest`, server-owned), so a base edit makes it OUTDATED — the
 * Contentful/Sanity/Webflow capability this CMS lacked: an editor who rewrote the
 * English hero had no way to learn the Spanish one now said something else.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  type Section, getPage, updatePage, localizePage, getContentLanguageSettings, stampSourceDigests, translationStatus, sourceDigestOf,
} from '../src/features/cms/cmsService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const t = getToggleDefault('users');
  if (t) await saveConfig({ ...t, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  expect(d, `${id} toggle must be declared`).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
};
const setGate = (status: 'on' | 'off'): Promise<void> => setToggle('cms-approval-gate', status);

/* eslint-disable @typescript-eslint/no-explicit-any */
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
async function owner(): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:l2ts-${Date.now()}-${n++}`;
  const c = client();
  const login = await c.post('/host/openwop-app/test/login', { email: `l2ts-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId as string, tenantId };
}
const u = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;


beforeAll(async () => { await setToggle('cms-localization', 'on'); });

async function pageWithEs(c: Client, orgId: string) {
  expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['es', 'fr'] })).status).toBe(200);
  const created = await c.post(u(orgId, '/pages'), {
    title: 'Status',
    sections: [{ type: 'hero', data: { heading: 'Welcome', subheading: 'Hi', ctaUrl: 'https://a.test' }, localizations: { es: { heading: 'Bienvenido' } } }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as { pageId: string; sections: Array<{ sectionId: string }> };
}
const statusOf = async (c: Client, orgId: string, pageId: string) => {
  const r = await c.get(u(orgId, `/pages/${pageId}/translation-status`));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { locales: string[]; sections: Record<string, Record<string, string>>; counts: Record<string, Record<string, number>> };
};

describe('ADR 0861 D6 — translation status', () => {
  it('a written overlay is current; a base edit to the text it translates makes it outdated', async () => {
    const { c, orgId, tenantId } = await owner();
    await setGate('off');
    const { pageId, sections } = await pageWithEs(c, orgId);
    const sid = sections[0]!.sectionId;
    let st = await statusOf(c, orgId, pageId);
    expect(st.sections[sid]).toEqual({ es: 'current', fr: 'missing' });
    expect(st.counts.es).toEqual({ missing: 0, current: 1, outdated: 0, unknown: 0 });

    // A base field the overlay does NOT override (review M2) — still current.
    const p1 = (await getPage(tenantId, orgId, pageId))!;
    const r1 = await c.patch(u(orgId, `/pages/${pageId}`), { sections: p1.sections.map((s) => ({ ...s, data: { ...s.data, ctaUrl: 'https://b.test' } })) });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect((await statusOf(c, orgId, pageId)).sections[sid]!.es).toBe('current');

    // The overridden text moves — outdated.
    const p2 = (await getPage(tenantId, orgId, pageId))!;
    const r2 = await c.patch(u(orgId, `/pages/${pageId}`), { sections: p2.sections.map((s) => ({ ...s, data: { ...s.data, heading: 'Welcome back' } })) });
    expect(r2.status).toBe(200);
    st = await statusOf(c, orgId, pageId);
    expect(st.sections[sid]!.es).toBe('outdated');

    // Re-translating clears it.
    const p3 = (await getPage(tenantId, orgId, pageId))!;
    await c.patch(u(orgId, `/pages/${pageId}`), { sections: p3.sections.map((s) => ({ ...s, localizations: { es: { heading: 'Bienvenido de nuevo' } } })) });
    expect((await statusOf(c, orgId, pageId)).sections[sid]!.es).toBe('current');
  });

  it('confirm-source clears outdated without changing the overlay, and is refused on a gated live page', async () => {
    const { c, orgId, tenantId } = await owner();
    await setGate('off');
    const { pageId, sections } = await pageWithEs(c, orgId);
    const sid = sections[0]!.sectionId;
    const p = (await getPage(tenantId, orgId, pageId))!;
    await c.patch(u(orgId, `/pages/${pageId}`), { sections: p.sections.map((s) => ({ ...s, data: { ...s.data, heading: 'Welcome!' } })) });
    expect((await statusOf(c, orgId, pageId)).sections[sid]!.es).toBe('outdated');
    const before = (await getPage(tenantId, orgId, pageId))!;
    const ok = await c.post(u(orgId, `/pages/${pageId}/sections/${encodeURIComponent(sid)}/locales/es/confirm-source`));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.version).toBe(before.version + 1);
    expect(ok.body.sections[0].localizations).toEqual(before.sections[0]!.localizations);
    expect((await statusOf(c, orgId, pageId)).sections[sid]!.es).toBe('current');

    expect((await c.post(u(orgId, `/pages/${pageId}/sections/${encodeURIComponent(sid)}/locales/fr/confirm-source`))).status, 'no fr overlay').toBe(404);

    // grade-ux CMSL2UX-1 — a confirm pinned to the version the editor HOLDS refuses
    // to land over a save it never saw (it used to pin to the route's fresh read).
    const held = (await getPage(tenantId, orgId, pageId))!.version;
    const cur = (await getPage(tenantId, orgId, pageId))!;
    await c.patch(u(orgId, `/pages/${pageId}`), { sections: cur.sections.map((s) => ({ ...s, data: { ...s.data, subheading: 'Another editor' } })) });
    const stale = await c.post(u(orgId, `/pages/${pageId}/sections/${encodeURIComponent(sid)}/locales/es/confirm-source`), { expectedVersion: held });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);

    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    await setGate('on');
    const gated = await c.post(u(orgId, `/pages/${pageId}/sections/${encodeURIComponent(sid)}/locales/es/confirm-source`));
    expect(gated.status, JSON.stringify(gated.body)).toBe(409);
    await setGate('off');
  });

  it('the digest is SERVER-owned: a client-sent value is discarded', async () => {
    const { c, orgId, tenantId } = await owner();
    await setGate('off');
    const { pageId, sections } = await pageWithEs(c, orgId);
    const sid = sections[0]!.sectionId;
    const p = (await getPage(tenantId, orgId, pageId))!;
    // Base moves AND the client claims the overlay is current for the new base.
    const forged = sourceDigestOf({ heading: 'Moved' }, { heading: 'Bienvenido' });
    const r = await c.patch(u(orgId, `/pages/${pageId}`), {
      sections: p.sections.map((s) => ({ ...s, data: { ...s.data, heading: 'Moved' }, sourceDigest: { es: forged } })),
    });
    expect(r.status).toBe(200);
    expect((await statusOf(c, orgId, pageId)).sections[sid]!.es).toBe('outdated');
  });

  it('the stamp survives the kernel round-trip and never reaches a delivery shape', async () => {
    const { c, orgId, tenantId } = await owner();
    await setGate('off');
    const { pageId } = await pageWithEs(c, orgId);
    const stored = (await getPage(tenantId, orgId, pageId))!;
    expect(stored.sections[0]!.sourceDigest?.es).toMatch(/^[0-9a-f]{16}$/);
    const { page } = localizePage(stored, 'es', await getContentLanguageSettings(tenantId, orgId));
    expect(JSON.stringify(page.sections)).not.toContain('sourceDigest');
    await updatePage(tenantId, orgId, pageId, { title: 'Renamed' }, 'user:x');
    expect((await getPage(tenantId, orgId, pageId))!.sections[0]!.sourceDigest?.es).toBe(stored.sections[0]!.sourceDigest?.es);
  });

  it('a shared section reports its own status, through the page that references it', async () => {
    const { c, orgId } = await owner();
    await setGate('off');
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['es'] })).status).toBe(200);
    const shared = await c.post(u(orgId, '/shared-sections'), { name: 'Footer', type: 'hero', data: { heading: 'Footer' }, localizations: { es: { heading: 'Pie' } } });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    const created = await c.post(u(orgId, '/pages'), { title: 'Ref', sections: [{ type: 'hero', data: {}, ref: { sharedSectionId: shared.body.sharedSectionId } }] });
    const sid = created.body.sections[0].sectionId as string;
    expect((await statusOf(c, orgId, created.body.pageId)).sections[sid]).toEqual({ es: 'current' });
    expect((await c.patch(u(orgId, `/shared-sections/${shared.body.sharedSectionId}`), { data: { heading: 'New footer' } })).status).toBe(200);
    expect((await statusOf(c, orgId, created.body.pageId)).sections[sid]).toEqual({ es: 'outdated' });
  });
});

describe('ADR 0861 D6 — stampSourceDigests rules', () => {
  const base: Section = { sectionId: 'sec:1', type: 'hero', data: { heading: 'A' } };
  it('an unchanged LEGACY overlay stays unknown (review H3) — no evidence, no claim', () => {
    const prev = [{ sectionId: 'sec:1', localizations: { es: { heading: 'a' } } }];
    const [s] = stampSourceDigests(prev, [{ ...base, data: { heading: 'B' }, localizations: { es: { heading: 'a' } } }]);
    expect(s!.sourceDigest).toBeUndefined();
    expect(translationStatus(s!, 'es')).toBe('unknown');
  });
  it('confirm stamps a legacy overlay current', () => {
    const prev = [{ sectionId: 'sec:1', localizations: { es: { heading: 'a' } } }];
    const [s] = stampSourceDigests(prev, [{ ...base, localizations: { es: { heading: 'a' } } }], { sectionId: 'sec:1', locale: 'es' });
    expect(translationStatus(s!, 'es')).toBe('current');
  });
  it('a removed overlay drops its stamp', () => {
    const prev = [{ sectionId: 'sec:1', localizations: { es: { heading: 'a' } }, sourceDigest: { es: '0123456789abcdef' } }];
    const [s] = stampSourceDigests(prev, [{ ...base }]);
    expect(s!.sourceDigest).toBeUndefined();
  });
});
