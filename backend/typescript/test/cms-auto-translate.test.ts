/**
 * ADR 0064 amendment — `autoTranslateOnPublish` honored at SUBMIT time (CMS
 * gap-analysis fix A2). ROUTE-level harness with the headless provider mocked
 * deterministic. Covers the ruled semantics:
 *   - toggle ON + flag ON  → missing-only overlays drafted on submit, persisted
 *     through the validated write path, `autoTranslated` counts in the response,
 *     the approval proposal names the AI-drafted overlays (gate ON);
 *   - toggle OFF (flag ON) → byte-identical submit (no provider call);
 *   - flag OFF             → byte-identical submit (no provider call);
 *   - provider unavailable → best-effort: submit still succeeds, no overlays;
 *   - existing overlays are never overwritten (missing-only);
 *   - the sweep is capped (AUTO_TRANSLATE_MAX_CALLS).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the headless-provider resolver BEFORE the app import. The default
// implementation is a deterministic "translator" that echoes a translated
// heading; individual tests override via mockImplementation.
vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

import { resolveHeadlessAi } from '../src/host/headlessAi.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { AUTO_TRANSLATE_MAX_CALLS } from '../src/features/cms/translate.js';

const mockResolve = vi.mocked(resolveHeadlessAi);

/** A dispatch that "translates" by returning a fixed sanitizable overlay. */
const translatingDispatch = () => vi.fn(async () => '{"heading":"XLATED"}');

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockResolvedValue(translatingDispatch());
});

async function setToggle(id: 'cms-localization' | 'cms-approval-gate', status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  expect(d, `${id} toggle must be declared`).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
}

interface Res<T = any> { status: number; headers: Headers; body: T }
interface Client {
  get: (p: string, headers?: Record<string, string>) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
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
    put: (p, b) => call('PUT', p, b),
  };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:autoxl-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `axl-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const u = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${suffix}`;

async function draftPage(owner: Client, orgId: string, sections: unknown[]): Promise<{ pageId: string }> {
  const created = await owner.post(u(orgId, '/pages'), { title: 'Home', sections });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { pageId: created.body.pageId };
}

async function enableAutoTranslate(owner: Client, orgId: string, locales: string[]): Promise<void> {
  await setToggle('cms-localization', 'on');
  const ok = await owner.put(u(orgId, '/language-settings'), { supportedLocales: locales, autoTranslateOnPublish: true });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
}

describe('autoTranslateOnPublish — submit-time sweep', () => {
  it('drafts missing overlays on submit, persists them, and reports counts', async () => {
    const { owner, orgId } = await ownerOrg();
    await enableAutoTranslate(owner, orgId, ['pt-BR', 'es']);
    const { pageId } = await draftPage(owner, orgId, [
      { type: 'hero', data: { heading: 'Welcome' } },
      // This section already carries a pt-BR overlay → only its `es` is missing.
      { type: 'hero', data: { heading: 'Second' }, localizations: { 'pt-BR': { heading: 'Segundo' } } },
    ]);

    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe('in_review');
    // 2 sections × 2 locales − 1 existing overlay = 3 calls, missing-only.
    expect(sub.body.autoTranslated).toEqual({ 'pt-BR': 1, es: 2 });

    const page = await owner.get(u(orgId, `/pages/${pageId}`));
    expect(page.body.sections[0].localizations['pt-BR'].heading).toBe('XLATED');
    expect(page.body.sections[0].localizations.es.heading).toBe('XLATED');
    // The pre-existing human overlay is NEVER overwritten (missing-only).
    expect(page.body.sections[1].localizations['pt-BR'].heading).toBe('Segundo');
    expect(page.body.sections[1].localizations.es.heading).toBe('XLATED');
  });

  it('names the AI-drafted overlays in the approval proposal when the gate is ON', async () => {
    await setToggle('cms-approval-gate', 'on');
    try {
      const { owner, orgId } = await ownerOrg();
      await enableAutoTranslate(owner, orgId, ['pt-BR']);
      const { pageId } = await draftPage(owner, orgId, [{ type: 'hero', data: { heading: 'Welcome' } }]);

      const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
      expect(sub.status, JSON.stringify(sub.body)).toBe(200);
      expect(sub.body.autoTranslated).toEqual({ 'pt-BR': 1 });

      const list = await owner.get('/v1/host/openwop-app/approvals?status=pending');
      const appr = (list.body.items as Array<{ pageId?: string; proposal: string }>).find((a) => a.pageId === pageId);
      expect(appr, 'submit must queue a content approval').toBeTruthy();
      expect(appr?.proposal).toMatch(/1 AI-drafted pt-BR overlay pending review/);
    } finally {
      await setToggle('cms-approval-gate', 'off');
    }
  });

  it('is byte-identical when the cms-localization toggle is OFF (flag can outlive the toggle)', async () => {
    const { owner, orgId } = await ownerOrg();
    await enableAutoTranslate(owner, orgId, ['pt-BR']); // sets the flag while ON…
    await setToggle('cms-localization', 'off');          // …then the toggle goes OFF
    const { pageId } = await draftPage(owner, orgId, [{ type: 'hero', data: { heading: 'Welcome' } }]);

    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status).toBe(200);
    expect(sub.body.autoTranslated).toBeUndefined();
    expect(mockResolve).not.toHaveBeenCalled();

    const page = await owner.get(u(orgId, `/pages/${pageId}`));
    expect(page.body.sections[0].localizations).toBeUndefined();
  });

  it('does nothing when autoTranslateOnPublish is false', async () => {
    const { owner, orgId } = await ownerOrg();
    await setToggle('cms-localization', 'on');
    const ok = await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'], autoTranslateOnPublish: false });
    expect(ok.status).toBe(200);
    const { pageId } = await draftPage(owner, orgId, [{ type: 'hero', data: { heading: 'Welcome' } }]);

    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status).toBe(200);
    expect(sub.body.autoTranslated).toBeUndefined();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('best-effort: submit succeeds untranslated when the provider is unavailable', async () => {
    mockResolve.mockResolvedValue(null); // no text-capable provider
    const { owner, orgId } = await ownerOrg();
    await enableAutoTranslate(owner, orgId, ['pt-BR']);
    const { pageId } = await draftPage(owner, orgId, [{ type: 'hero', data: { heading: 'Welcome' } }]);

    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe('in_review');
    expect(sub.body.autoTranslated).toBeUndefined();
  });

  it('degrades to an untranslated submit when the merge-save cannot validate (best-effort end to end)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await setToggle('cms-localization', 'on');
    // Author an fr overlay while fr is a supported locale…
    let ok = await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['fr'] });
    expect(ok.status).toBe(200);
    const { pageId } = await draftPage(owner, orgId, [
      { type: 'hero', data: { heading: 'Welcome' }, localizations: { fr: { heading: 'Bienvenue' } } },
    ]);
    // …then RE-BASE the org to fr. ADR 0592 §9 (CMSL-8): the ROUTE now
    // REFUSES this exact footgun (409, offenders named) — pin that first…
    ok = await owner.put(u(orgId, '/language-settings'), { baseLocale: 'fr', supportedLocales: ['pt-BR'], autoTranslateOnPublish: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(409);
    expect(ok.body.error).toBe('conflict');
    // …then create the poisoned state ANYWAY through the SERVICE (the guard is
    // deliberately feature/route-layer; a row poisoned before the guard
    // shipped looks exactly like this). The stored fr overlay now collides
    // with the base locale, so any validated sections save throws — the
    // sweep's merge-save included; the degrade contract below still holds.
    const { updateContentLanguageSettings } = await import('../src/host/contentLocales.js');
    await updateContentLanguageSettings(tenantId, orgId, { baseLocale: 'fr', supportedLocales: ['pt-BR'], autoTranslateOnPublish: true }, 'test');

    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200); // submit NEVER fails on translation
    expect(sub.body.status).toBe('in_review');
    expect(sub.body.autoTranslated).toBeUndefined(); // nothing persisted → nothing reported
  });

  it('caps the sweep at AUTO_TRANSLATE_MAX_CALLS provider calls', async () => {
    const dispatch = translatingDispatch();
    mockResolve.mockResolvedValue(dispatch);
    const { owner, orgId } = await ownerOrg();
    // 8 locales × 5 sections = 40 candidate pairs > the cap of 20.
    await enableAutoTranslate(owner, orgId, ['pt-BR', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'nl']);
    const sections = Array.from({ length: 5 }, (_, i) => ({ type: 'hero', data: { heading: `Section ${i}` } }));
    const { pageId } = await draftPage(owner, orgId, sections);

    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(dispatch.mock.calls.length).toBe(AUTO_TRANSLATE_MAX_CALLS);
    const total = Object.values(sub.body.autoTranslated as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(AUTO_TRANSLATE_MAX_CALLS);
  });
});
