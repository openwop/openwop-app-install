/**
 * ADR 0861 D2–D5 — the localization lanes decide their gate on the row they write.
 *
 * ADR 0836 D2 moved every page-PATCH check into `authorize(current)`, which runs on
 * the row the CAS compares. Three localization lanes were left on read → check →
 * re-read → write, and `transitionPage` never bumps `version`, so a decision landing
 * between the reads left the write valid:
 *   D2 — releasing a withheld locale on a page that an approve publishes mid-request;
 *   D3 — the submit-time auto-translate merge landing AI overlays on a page approved
 *        during the sweep (and the queue after it opening a row for a live page);
 *   D4 — two language-settings writes, last-write-wins under a gate decided on `cur`.
 * Each race is made DETERMINISTIC by doing the competing write inside the module the
 * route calls at the instant of the check (a partial mock), not by timing.
 * D5 — the prerender's hreflang names only locales the page serves.
 *
 * Sabotage-witnessed (/grade-tests w16): a blind put in place of `setLocalePublishState`'s
 * `casPage`, dropping the sweep merge's `authorize` (left-review) check, the
 * after-sweep queue guard, or the translated-from-base check, `updateContentLanguageSettings`
 * skipping its CAS, or `localizePage` reporting every configured locale as `served`
 * each reds the named case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getPage, transitionPage, updatePage, getContentLanguageSettings } from '../src/features/cms/cmsService.js';
import { getStoredContentLanguageSettings, updateContentLanguageSettings } from '../src/host/contentLocales.js';
import { prerenderPage } from '../src/features/publishing/prerenderService.js';

const hooks: { onGateCheck?: () => Promise<void>; onSweep?: () => Promise<void> } = {};

vi.mock('../src/features/cms/contentApproval.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/features/cms/contentApproval.js')>();
  return {
    ...real,
    refuseLiveEdit: async (...args: Parameters<typeof real.refuseLiveEdit>) => {
      const hook = hooks.onGateCheck;
      hooks.onGateCheck = undefined;
      const verdict = await real.refuseLiveEdit(...args);
      if (hook) await hook(); // the competing decision lands right after the check
      return verdict;
    },
  };
});
vi.mock('../src/features/cms/translate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/features/cms/translate.js')>();
  return {
    ...real,
    autoTranslateMissingOverlays: async (_tenantId: string, sections: ReadonlyArray<{ sectionId: string }>, locales: readonly string[]) => {
      if (hooks.onSweep) { const h = hooks.onSweep; hooks.onSweep = undefined; await h(); }
      const overlays = new Map<string, Record<string, Record<string, unknown>>>();
      for (const s of sections) overlays.set(s.sectionId, Object.fromEntries(locales.map((l) => [l, { heading: `AI ${l}` }])));
      return { overlays, translated: Object.fromEntries(locales.map((l) => [l, sections.length])), capped: false, errored: false, invalid: 0 };
    },
  };
});

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

interface SectionBody { data: { heading?: string } }
interface ApprovalRow { kind?: string; pageId?: string }
/** The success-body fields this file reads. */
interface Body {
  orgId: string; pageId: string; slug: string;
  sections: SectionBody[]; items: ApprovalRow[];
  autoTranslated?: Record<string, number>;
  autoTranslateDegraded?: { conflict?: boolean };
}
interface Res { status: number; headers: Headers; body: Body }
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
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, headers: res.headers, body: out as Body };
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
  const tenantId = `org:l2cas-${Date.now()}-${n++}`;
  const c = client();
  const login = await c.post('/host/openwop-app/test/login', { email: `l2cas-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId, tenantId };
}
const u = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

/** The ANONYMOUS delivery boundary — no cookie, `Accept-Language` only. */
async function publicRead(orgId: string, slug: string, acceptLanguage: string): Promise<Res> {
  const res = await fetch(`${BASE}/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`, {
    headers: { 'accept-language': acceptLanguage },
  });
  const body: unknown = await res.json().catch(() => undefined);
  return { status: res.status, headers: res.headers, body: body as Body };
}


async function pendingFor(c: Client, pageId: string): Promise<ApprovalRow[]> {
  const list = await c.get('/host/openwop-app/approvals?status=pending');
  expect(list.status).toBe(200);
  return list.body.items.filter((a) => a.kind === 'content-publish' && a.pageId === pageId);
}

beforeAll(async () => { await setToggle('cms-localization', 'on'); });
// The race hooks are module-level: a case that fails (or a code path that stops calling
// the mocked function) before consuming its hook must not leak it into the next case.
beforeEach(() => { hooks.onGateCheck = undefined; hooks.onSweep = undefined; });

describe('ADR 0861 D2 — releasing a locale checks the gate on the written row', () => {
  it('an approve landing right after the check cannot carry the release onto the live page', async () => {
    const { c, orgId, tenantId } = await owner();
    await setGate('on');
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['es'] })).status).toBe(200);
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Release race',
      sections: [{ type: 'hero', data: { heading: 'Welcome' }, localizations: { es: { heading: 'RETENIDO' } } }],
    });
    const { pageId, slug } = created.body;
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/es/unpublish`))).status).toBe(200);
    // The page is a DRAFT at the check (not refused); the publish lands right after it.
    hooks.onGateCheck = async () => { await transitionPage(tenantId, orgId, pageId, 'publish', 'user:other-admin'); };
    const release = await c.post(u(orgId, `/pages/${pageId}/locales/es/publish`));
    expect(release.status, JSON.stringify(release.body)).toBe(409);
    expect(hooks.onGateCheck, 'the competing publish must have fired').toBeUndefined();
    const live = await getPage(tenantId, orgId, pageId);
    expect(live?.status).toBe('published');
    expect(live?.localePublishState?.es, 'the hold survives').toBe('draft');
    expect((await publicRead(orgId, slug, 'es')).body.sections[0].data.heading).toBe('Welcome');
  });
});

describe('ADR 0861 D3 — the auto-translate merge lands only on the review it belongs to', () => {
  const setup = async () => {
    const o = await owner();
    await setGate('on');
    expect((await o.c.put(u(o.orgId, '/language-settings'), { supportedLocales: ['es'], autoTranslateOnPublish: true })).status).toBe(200);
    const created = await o.c.post(u(o.orgId, '/pages'), { title: 'Sweep race', sections: [{ type: 'hero', data: { heading: 'Welcome' } }] });
    return { ...o, pageId: created.body.pageId, slug: created.body.slug };
  };

  it('an approve during the sweep: the drafts are discarded (disclosed) and no review row opens for the live page', async () => {
    const { c, orgId, tenantId, pageId, slug } = await setup();
    hooks.onSweep = async () => { await transitionPage(tenantId, orgId, pageId, 'approve', 'user:reviewer'); };
    const submit = await c.post(u(orgId, `/pages/${pageId}/submit`));
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    expect(hooks.onSweep, 'the competing approve must have fired').toBeUndefined();
    expect(submit.body.autoTranslateDegraded?.conflict).toBe(true);
    const live = await getPage(tenantId, orgId, pageId);
    expect(live?.status).toBe('published');
    expect(live?.sections[0]?.localizations?.es, 'no unreviewed AI overlay on the live page').toBeUndefined();
    expect((await publicRead(orgId, slug, 'es')).body.sections[0].data.heading).toBe('Welcome');
    expect(await pendingFor(c, pageId), 'no pending row for a page that is already live').toHaveLength(0);
  });

  it('a base edit during the sweep: the stale-source draft is dropped, the review still queues', async () => {
    const { c, orgId, tenantId, pageId } = await setup();
    hooks.onSweep = async () => {
      const p = (await getPage(tenantId, orgId, pageId))!;
      await updatePage(tenantId, orgId, pageId, { sections: p.sections.map((s) => ({ ...s, data: { heading: 'Welcome back' } })) }, 'user:editor');
    };
    const submit = await c.post(u(orgId, `/pages/${pageId}/submit`));
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    expect(hooks.onSweep, 'the competing base edit must have fired').toBeUndefined();
    const page = await getPage(tenantId, orgId, pageId);
    expect(page?.sections[0]?.localizations?.es, 'translated from a base that no longer exists').toBeUndefined();
    expect(page?.status).toBe('in_review');
    expect(await pendingFor(c, pageId)).toHaveLength(1);
  });

  it('control: an undisturbed sweep still lands its drafts and queues one review', async () => {
    const { c, orgId, tenantId, pageId } = await setup();
    const submit = await c.post(u(orgId, `/pages/${pageId}/submit`));
    expect(submit.status).toBe(200);
    expect(submit.body.autoTranslated).toEqual({ es: 1 });
    expect((await getPage(tenantId, orgId, pageId))?.sections[0]?.localizations?.es).toEqual({ heading: 'AI es' });
    expect(await pendingFor(c, pageId)).toHaveLength(1);
  });
});

describe('ADR 0861 D4 — language settings are a CAS against the row the gate read', () => {
  it('a write built on a stale read is refused instead of restoring a removed locale', async () => {
    const T = `t-d4-${Date.now()}`;
    await updateContentLanguageSettings(T, 'org-1', { baseLocale: 'en', supportedLocales: ['es', 'fr'] }, 'admin-a');
    const staleRead = await getStoredContentLanguageSettings(T, 'org-1');
    await updateContentLanguageSettings(T, 'org-1', { supportedLocales: ['es'] }, 'admin-a', { expected: staleRead });
    await expect(updateContentLanguageSettings(T, 'org-1', { autoTranslateOnPublish: true }, 'admin-b', { expected: staleRead }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await getContentLanguageSettings(T, 'org-1')).supportedLocales, '`fr` stays removed').toEqual(['es']);
  });

  it('first configuration inserts against `null`, and a racing second insert is refused', async () => {
    const T = `t-d4n-${Date.now()}`;
    expect(await getStoredContentLanguageSettings(T, 'org-1')).toBeNull();
    await updateContentLanguageSettings(T, 'org-1', { supportedLocales: ['es'] }, 'admin-a', { expected: null });
    await expect(updateContentLanguageSettings(T, 'org-1', { supportedLocales: ['fr'] }, 'admin-b', { expected: null }))
      .rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('ADR 0861 D5 — hreflang names only the locales this page serves', () => {
  it('a withheld, CONFIGURED locale is not advertised to crawlers', async () => {
    const { c, orgId } = await owner();
    await setGate('off');
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['es', 'fr'] })).status).toBe(200);
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Hreflang',
      sections: [{ type: 'hero', data: { heading: 'Welcome' }, localizations: { es: { heading: 'Hola' }, fr: { heading: 'Bonjour' } } }],
    });
    const { pageId, slug } = created.body;
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    const before = (await prerenderPage(orgId, slug, 'https://site.test', 'en'))!.html;
    expect(before, 'control: both configured locales advertised').toContain('hreflang="es"');
    expect(before).toContain('hreflang="fr"');
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/es/unpublish`))).status).toBe(200);
    const after = (await prerenderPage(orgId, slug, 'https://site.test', 'en'))!.html;
    expect(after).not.toContain('hreflang="es"');
    expect(after).toContain('hreflang="fr"');
  });
});
