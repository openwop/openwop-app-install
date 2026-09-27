/**
 * ADR 0592 §7 (CMSL-2) — the ROUTE/SWEEP lanes of the typed-failure + bounded
 * -repair contract: unparseable model output on `/translate-section` is a
 * typed 502 `translation_invalid` after EXACTLY one error-fed repair attempt
 * (never `200 {overlay:{}}` — the success-with-empty this retires); a repair
 * that lands returns the translation; the auto-translate sweep SKIPS an
 * invalid pair and keeps translating the rest.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

// Review F6 — a DETERMINISTIC double-conflict seam: forcing two real
// interleaved writes into the retry's re-read→save window has no injectable
// await, so the seam makes every PINNED updatePage throw the same typed
// conflict the real mechanism throws (which is itself witnessed in
// cms-optimistic-concurrency.test.ts). Pass-through when unarmed.
const f6 = vi.hoisted(() => ({ conflictPinnedSaves: false }));
vi.mock('../src/features/cms/cmsService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/cms/cmsService.js')>();
  return {
    ...actual,
    updatePage: (async (...args: Parameters<typeof actual.updatePage>) => {
      const opts = args[5];
      if (f6.conflictPinnedSaves && opts?.expectedVersion !== undefined) {
        const { OpenwopError } = await import('../src/types.js');
        throw new OpenwopError('conflict', 'forced double-conflict (F6 seam)', 409, { currentVersion: -1, expectedVersion: opts.expectedVersion });
      }
      return actual.updatePage(...args);
    }) as typeof actual.updatePage,
  };
});

import { resolveHeadlessAi } from '../src/host/headlessAi.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { autoTranslateMissingOverlays } from '../src/features/cms/translate.js';

const mockResolve = vi.mocked(resolveHeadlessAi);

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u2 = getToggleDefault('users');
  if (u2) await saveConfig({ ...u2, status: 'on' }, 'test');
  const loc = getToggleDefault('cms-localization');
  if (loc) await saveConfig({ ...loc, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(() => { mockResolve.mockReset(); f6.conflictPinnedSaves = false; });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:xlr-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `xlr-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const u = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

describe('POST /translate-section — typed failure + one bounded repair', () => {
  it('garbage twice → 502 translation_invalid after EXACTLY one repair (never 200 {overlay:{}})', async () => {
    const dispatch = vi.fn(async () => 'I am sorry, I cannot produce JSON right now.');
    mockResolve.mockResolvedValue(dispatch);
    const { owner, orgId } = await ownerOrg();
    const r = await owner.post(u(orgId, '/translate-section'), { sectionType: 'hero', data: { heading: 'Hi' }, targetLocale: 'pt-BR' });
    expect(r.status, JSON.stringify(r.body)).toBe(502);
    expect(r.body.error).toBe('translation_invalid');
    expect(r.body.details?.repairAttempted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2); // initial + ONE repair, bounded
  });

  it('garbage then valid → the repair lands and the route returns the overlay', async () => {
    const dispatch = vi.fn()
      .mockResolvedValueOnce('Sure! Here is a friendly explanation instead of JSON.')
      .mockResolvedValueOnce('{"heading":"Olá"}');
    mockResolve.mockResolvedValue(dispatch);
    const { owner, orgId } = await ownerOrg();
    const r = await owner.post(u(orgId, '/translate-section'), { sectionType: 'hero', data: { heading: 'Hi' }, targetLocale: 'pt-BR' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.overlay).toEqual({ heading: 'Olá' });
    expect(dispatch).toHaveBeenCalledTimes(2);
    // The repair message is error-fed (carries the bad completion back).
    const secondCall = dispatch.mock.calls[1]?.[0] as Array<{ role: string; content: string }>;
    expect(secondCall.some((m) => m.role === 'assistant' && /friendly explanation/.test(m.content))).toBe(true);
  });

  it('valid first output → one call, no repair', async () => {
    const dispatch = vi.fn(async () => '{"heading":"Olá"}');
    mockResolve.mockResolvedValue(dispatch);
    const { owner, orgId } = await ownerOrg();
    const r = await owner.post(u(orgId, '/translate-section'), { sectionType: 'hero', data: { heading: 'Hi' }, targetLocale: 'pt-BR' });
    expect(r.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('auto-translate sweep — an invalid pair is SKIPPED, not fatal', () => {
  it('keeps translating after a translation_invalid pair and reports the invalid count', async () => {
    const { tenantId } = await ownerOrg();
    // Section A's heading provokes permanent garbage; section B translates fine.
    const dispatch = vi.fn(async (messages: Array<{ content: string }>) => {
      const text = messages.map((m) => m.content).join('\n');
      return /Poison/.test(text) ? 'nope, no JSON here' : '{"heading":"Olá"}';
    });
    mockResolve.mockResolvedValue(dispatch as never);
    const out = await autoTranslateMissingOverlays(tenantId, [
      { sectionId: 'a', type: 'hero', data: { heading: 'Poison' } },
      { sectionId: 'b', type: 'hero', data: { heading: 'Fine' } },
    ], ['pt-BR']);
    expect(out.invalid).toBe(1);
    expect(out.errored).toBe(false);
    expect(out.translated).toEqual({ 'pt-BR': 1 });
    expect(out.overlays.get('b')?.['pt-BR']).toEqual({ heading: 'Olá' });
    expect(out.overlays.has('a')).toBe(false);
  });
});

describe('ADR 0592 §9 (CMSL-5/CMSLU-14) — a degraded sweep is SURFACED, not silent', () => {
  it('unusable translations surface on the submit response AND the approval proposal', async () => {
    const dispatch = vi.fn(async () => 'definitely not JSON, twice in a row');
    mockResolve.mockResolvedValue(dispatch);
    const { owner, orgId } = await ownerOrg();
    const ok = await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'], autoTranslateOnPublish: true });
    expect(ok.status).toBe(200);
    const created = await owner.post(u(orgId, '/pages'), { title: 'Degraded', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const sub = await owner.post(u(orgId, `/pages/${created.body.pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    // The degrade rides the RESPONSE (the editor's toast)…
    expect(sub.body.autoTranslated).toBeUndefined();
    expect(sub.body.autoTranslateDegraded).toEqual({ invalid: 1 });
    // …and the approval PROPOSAL (the reviewer's view).
    const list = await owner.get('/v1/host/openwop-app/approvals?status=pending');
    const appr = (list.body.items as Array<{ pageId?: string; proposal: string }>).find((a) => a.pageId === created.body.pageId);
    expect(appr).toBeTruthy();
    expect(appr?.proposal).toMatch(/auto-translate incomplete/);
    expect(appr?.proposal).toMatch(/unusable output/);
  });

  it('a provider failure mid-sweep surfaces as errored', async () => {
    const dispatch = vi.fn(async () => { throw new Error('provider exploded'); });
    mockResolve.mockResolvedValue(dispatch as never);
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'], autoTranslateOnPublish: true });
    const created = await owner.post(u(orgId, '/pages'), { title: 'Errored', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const sub = await owner.post(u(orgId, `/pages/${created.body.pageId}/submit`));
    expect(sub.status).toBe(200); // best-effort: the submit still lands
    expect(sub.body.autoTranslateDegraded).toEqual({ errored: true });
  });

  it('a CLEAN sweep carries no degrade field (the signal is failure-scoped)', async () => {
    const dispatch = vi.fn(async () => '{"heading":"Olá"}');
    mockResolve.mockResolvedValue(dispatch);
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'], autoTranslateOnPublish: true });
    const created = await owner.post(u(orgId, '/pages'), { title: 'Clean', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const sub = await owner.post(u(orgId, `/pages/${created.body.pageId}/submit`));
    expect(sub.status).toBe(200);
    expect(sub.body.autoTranslated).toEqual({ 'pt-BR': 1 });
    expect(sub.body.autoTranslateDegraded).toBeUndefined();
  });
});


describe('ADR 0592 §9 correction — the double-conflict discard is DISCLOSED (review F6)', () => {
  it('two merge conflicts drop the drafts but say so on the response and the proposal', async () => {
    const dispatch = vi.fn(async () => '{"heading":"Olá"}');
    mockResolve.mockResolvedValue(dispatch);
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'], autoTranslateOnPublish: true });
    const created = await owner.post(u(orgId, '/pages'), { title: 'Conflicted', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });

    f6.conflictPinnedSaves = true; // both merge attempts 409
    const sub = await owner.post(u(orgId, `/pages/${created.body.pageId}/submit`));
    f6.conflictPinnedSaves = false;
    expect(sub.status, JSON.stringify(sub.body)).toBe(200); // submit still lands (best-effort)
    // Drafts were produced then discarded — DISCLOSED, not a clean-looking submit.
    expect(sub.body.autoTranslated).toBeUndefined();
    expect(sub.body.autoTranslateDegraded).toEqual({ conflict: true });
    const list = await owner.get('/v1/host/openwop-app/approvals?status=pending');
    const appr = (list.body.items as Array<{ pageId?: string; proposal: string }>).find((a) => a.pageId === created.body.pageId);
    expect(appr?.proposal).toMatch(/auto-translate incomplete/);
    expect(appr?.proposal).toMatch(/drafts were discarded/);
  });
});
