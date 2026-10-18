/**
 * ADR 0861 D6 addendum (owner decision 2026-10-11, row-35 follow-up) — "Copy from
 * base" is NOT a translation. Copying the base text into a locale overlay used to
 * be stamped like any other new overlay, so the editor and the approval card said
 * the page was translated while it still read in the base language. A copy now
 * records NO source digest (status `unknown`); it becomes `current` only when the
 * text is changed, when an editor confirms it ("Mark up to date"), or when a
 * translation writes different text.
 *
 * Every lane stamps through the ONE helper (`stampSourceDigests`), so the refuse
 * side is pinned on each writer that reaches it: the editor PATCH, page create,
 * the node/agent lane (`updatePage`), and the shared-section writers.
 *
 * Sabotage: deleting the `copiesBase` arm in `stampSourceDigests` reds every
 * `unknown` assertion below.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { type Section, getPage, updatePage, stampSourceDigests, translationStatus } from '../src/features/cms/cmsService.js';

let BASE: string;
let server: http.Server;

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  expect(d, `${id} toggle must be declared`).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const t = getToggleDefault('users');
  if (t) await saveConfig({ ...t, status: 'on' }, 'test');
  await setToggle('cms-localization', 'on');
  await setToggle('cms-approval-gate', 'off');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Body {
  pageId: string;
  orgId: string;
  version: number;
  sharedSectionId: string;
  sections: Array<{ sectionId: string; data: Record<string, unknown>; localizations?: Record<string, Record<string, unknown>> }>;
}
interface Res<T = Body> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T = Body>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return {
    get: <T = Body>(p: string) => call<T>('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
  };
}
type Client = ReturnType<typeof client>;

let n = 0;
async function owner(): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:l2cp-${Date.now()}-${n++}`;
  const c = client();
  expect((await c.post('/host/openwop-app/test/login', { email: `l2cp-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  expect((await c.put(`/host/openwop-app/cms/orgs/${encodeURIComponent(org.body.orgId)}/language-settings`, { supportedLocales: ['es'] })).status).toBe(200);
  return { c, orgId: org.body.orgId, tenantId };
}
const u = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
const esStatus = async (c: Client, orgId: string, pageId: string, sid: string): Promise<string | undefined> => {
  const r = await c.get<{ sections: Record<string, Record<string, string>> }>(u(orgId, `/pages/${pageId}/translation-status`));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.sections[sid]?.es;
};
const HERO = { heading: 'Welcome', subheading: 'Hi' };

describe('ADR 0861 D6 addendum — a copy of the base is not a translation', () => {
  it('editor PATCH: Copy from base records unknown; changing the text makes it current', async () => {
    const { c, orgId, tenantId } = await owner();
    const created = await c.post(u(orgId, '/pages'), { title: 'Copy', sections: [{ type: 'hero', data: HERO }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { pageId } = created.body;
    const sid = created.body.sections[0]!.sectionId;

    // What the editor's "Copy from base" button writes: the overlay IS the base data.
    const p = (await getPage(tenantId, orgId, pageId))!;
    const copied = await c.patch(u(orgId, `/pages/${pageId}`), { sections: p.sections.map((s) => ({ ...s, localizations: { es: { ...s.data } } })) });
    expect(copied.status, JSON.stringify(copied.body)).toBe(200);
    expect(await esStatus(c, orgId, pageId, sid), 'a copy must never read as translated').toBe('unknown');

    // An unrelated later save carries the absence over — still unknown.
    const p2 = (await getPage(tenantId, orgId, pageId))!;
    await c.patch(u(orgId, `/pages/${pageId}`), { title: 'Copy 2', sections: p2.sections });
    expect(await esStatus(c, orgId, pageId, sid)).toBe('unknown');

    // The editor translates one field — the overlay now differs from the base.
    const p3 = (await getPage(tenantId, orgId, pageId))!;
    await c.patch(u(orgId, `/pages/${pageId}`), { sections: p3.sections.map((s) => ({ ...s, localizations: { es: { ...s.localizations!.es, heading: 'Bienvenido' } } })) });
    expect(await esStatus(c, orgId, pageId, sid)).toBe('current');
  });

  it('Mark up to date (confirm-source) makes an unchanged copy current — the explicit editor claim', async () => {
    const { c, orgId, tenantId } = await owner();
    const created = await c.post(u(orgId, '/pages'), { title: 'Brand', sections: [{ type: 'hero', data: { heading: 'OpenWOP' }, localizations: { es: { heading: 'OpenWOP' } } }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { pageId } = created.body;
    const sid = created.body.sections[0]!.sectionId;
    expect(await esStatus(c, orgId, pageId, sid), 'page create: a copied overlay is unknown').toBe('unknown');
    const ok = await c.post(u(orgId, `/pages/${pageId}/sections/${encodeURIComponent(sid)}/locales/es/confirm-source`));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await esStatus(c, orgId, pageId, sid)).toBe('current');
    expect((await getPage(tenantId, orgId, pageId))!.sections[0]!.localizations).toEqual({ es: { heading: 'OpenWOP' } });
  });

  it('node/agent lane (updatePage): an overlay echoing the base is unknown, a real translation is current', async () => {
    const { c, orgId, tenantId } = await owner();
    const created = await c.post(u(orgId, '/pages'), { title: 'Agent', sections: [{ type: 'hero', data: HERO }] });
    const { pageId } = created.body;
    const sid = created.body.sections[0]!.sectionId;
    const p = (await getPage(tenantId, orgId, pageId))!;
    await updatePage(tenantId, orgId, pageId, { sections: p.sections.map((s) => ({ ...s, localizations: { es: { heading: 'Welcome' } }, aiDrafted: { es: new Date().toISOString() } })) }, 'workflow');
    expect(await esStatus(c, orgId, pageId, sid)).toBe('unknown');
    const p2 = (await getPage(tenantId, orgId, pageId))!;
    await updatePage(tenantId, orgId, pageId, { sections: p2.sections.map((s) => ({ ...s, localizations: { es: { heading: 'Bienvenido' } }, aiDrafted: { es: new Date().toISOString() } })) }, 'workflow');
    expect(await esStatus(c, orgId, pageId, sid)).toBe('current');
  });

  it('shared sections: a copied overlay on create and on update is unknown', async () => {
    const { c, orgId } = await owner();
    const shared = await c.post(u(orgId, '/shared-sections'), { name: 'Footer', type: 'hero', data: { heading: 'Footer' }, localizations: { es: { heading: 'Footer' } } });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    const page = await c.post(u(orgId, '/pages'), { title: 'Ref', sections: [{ type: 'hero', data: {}, ref: { sharedSectionId: shared.body.sharedSectionId } }] });
    const sid = page.body.sections[0]!.sectionId;
    expect(await esStatus(c, orgId, page.body.pageId, sid)).toBe('unknown');
    expect((await c.patch(u(orgId, `/shared-sections/${shared.body.sharedSectionId}`), { localizations: { es: { heading: 'Pie' } } })).status).toBe(200);
    expect(await esStatus(c, orgId, page.body.pageId, sid)).toBe('current');
    expect((await c.patch(u(orgId, `/shared-sections/${shared.body.sharedSectionId}`), { localizations: { es: { heading: 'Footer' } } })).status).toBe(200);
    expect(await esStatus(c, orgId, page.body.pageId, sid), 'update back to a copy').toBe('unknown');
  });
});

describe('ADR 0861 D6 addendum — stampSourceDigests copy rule', () => {
  const base: Section = { sectionId: 'sec:1', type: 'hero', data: { heading: 'A', subheading: 'B' } };
  it('a new overlay equal to the base at every key it overrides gets no stamp', () => {
    const [s] = stampSourceDigests(undefined, [{ ...base, localizations: { es: { heading: 'A' } } }]);
    expect(s!.sourceDigest).toBeUndefined();
    expect(translationStatus(s!, 'es')).toBe('unknown');
  });
  it('a previously current overlay overwritten by a copy LOSES its stamp', () => {
    const prev = [{ sectionId: 'sec:1', localizations: { es: { heading: 'a' } }, sourceDigest: { es: '0123456789abcdef' } }];
    const [s] = stampSourceDigests(prev, [{ ...base, localizations: { es: { heading: 'A' } } }]);
    expect(translationStatus(s!, 'es')).toBe('unknown');
  });
  it('one differing key is a translation; confirm stamps even an exact copy', () => {
    const [s] = stampSourceDigests(undefined, [{ ...base, localizations: { es: { heading: 'A', subheading: 'b' } } }]);
    expect(translationStatus(s!, 'es')).toBe('current');
    const [c] = stampSourceDigests(undefined, [{ ...base, localizations: { es: { heading: 'A' } } }], { sectionId: 'sec:1', locale: 'es' });
    expect(translationStatus(c!, 'es')).toBe('current');
  });
});
