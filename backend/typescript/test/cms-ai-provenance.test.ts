/**
 * ADR 0592 §3 (CMSL-10 / CMSLU-4 / CMSLWF-8) — durable AI-authorship
 * provenance on locale overlays. Every MACHINE writer stamps
 * `Section.aiDrafted[locale]` at write time; the stamp survives the copy
 * paths (PATCH round-trip, version snapshot → restore); a stamp never
 * outlives its overlay; absence = pre-fix row or human-authored (no
 * backfill, no claim).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

import { resolveHeadlessAi } from '../src/host/headlessAi.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildCmsSurface } from '../src/features/cms/surface.js';
import { getPage } from '../src/features/cms/cmsService.js';

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

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockResolvedValue(vi.fn(async () => '{"heading":"XLATED"}'));
});

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  put: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
}
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:prov-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `prov-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const u = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

describe('the machine writers stamp at write time', () => {
  it('submit auto-translate stamps ONLY the overlays it drafted — the human overlay stays unstamped', async () => {
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR', 'es'], autoTranslateOnPublish: true });
    const created = await owner.post(u(orgId, '/pages'), {
      title: 'Prov',
      sections: [{ type: 'hero', data: { heading: 'Welcome' }, localizations: { 'pt-BR': { heading: 'Bem-vindo (humano)' } } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pageId = created.body.pageId;

    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.autoTranslated).toEqual({ es: 1 });

    const page = await owner.get(u(orgId, `/pages/${pageId}`));
    const s0 = page.body.sections[0];
    expect(s0.localizations.es.heading).toBe('XLATED');
    // The AI-drafted es overlay is stamped; the pre-existing HUMAN pt-BR is not.
    expect(typeof s0.aiDrafted?.es).toBe('string');
    expect(s0.aiDrafted?.['pt-BR']).toBeUndefined();
  });

  it('surface.updateSectionDraft (the run/agent writer) stamps its locale overlay', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['fr'] });
    const created = await owner.post(u(orgId, '/pages'), { title: 'Node', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const pageId = created.body.pageId;
    const sectionId = created.body.sections[0].sectionId;

    const surface = buildCmsSurface({ tenantId });
    const out = await surface.updateSectionDraft!({ orgId, pageId, sectionId, locale: 'fr', data: { heading: 'Salut' } }) as { updated: boolean };
    expect(out.updated).toBe(true);
    const after = await getPage(tenantId, orgId, pageId);
    expect(after?.sections[0]?.localizations?.fr?.heading).toBe('Salut');
    expect(typeof after?.sections[0]?.aiDrafted?.fr).toBe('string');

    // A BASE-data patch through the same verb carries no per-locale stamp.
    const out2 = await surface.updateSectionDraft!({ orgId, pageId, sectionId, data: { heading: 'Hello again' } }) as { updated: boolean };
    expect(out2.updated).toBe(true);
    const after2 = await getPage(tenantId, orgId, pageId);
    expect(after2?.sections[0]?.aiDrafted).toEqual({ fr: after?.sections[0]?.aiDrafted?.fr });
  });
});

describe('the stamp survives the copy paths and never outlives its overlay', () => {
  it('PATCH round-trip preserves a valid stamp, drops an orphaned or invalid-locale stamp, and a human clear clears it', async () => {
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['es', 'fr'] });
    const created = await owner.post(u(orgId, '/pages'), { title: 'RT', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const pageId = created.body.pageId;
    const sectionId = created.body.sections[0].sectionId;

    // Save an overlay WITH a stamp (the editor's translate-apply shape) plus
    // an orphaned stamp (fr has no overlay) and an invalid locale key.
    const saved = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{
        sectionId, type: 'hero', data: { heading: 'Hi' },
        localizations: { es: { heading: 'Hola' } },
        aiDrafted: { es: '2026-08-20T00:00:00.000Z', fr: '2026-08-20T00:00:00.000Z', 'not a locale': 'x' },
      }],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.sections[0].aiDrafted).toEqual({ es: '2026-08-20T00:00:00.000Z' });

    // Round-trip: PATCH the same sections back — the stamp persists.
    const again = await owner.patch(u(orgId, `/pages/${pageId}`), { sections: saved.body.sections, expectedVersion: saved.body.version });
    expect(again.status).toBe(200);
    expect(again.body.sections[0].aiDrafted).toEqual({ es: '2026-08-20T00:00:00.000Z' });

    // Human edit (the FE clears the key): stamp gone; clearing the overlay
    // would drop it too (orphan rule above).
    const humanEdit = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ sectionId, type: 'hero', data: { heading: 'Hi' }, localizations: { es: { heading: 'Hola revisada' } } }],
      expectedVersion: again.body.version,
    });
    expect(humanEdit.status).toBe(200);
    expect(humanEdit.body.sections[0].aiDrafted).toBeUndefined();
  });

  it('version snapshot carries the stamp and restore brings it back', async () => {
    const { owner, orgId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['es'] });
    const created = await owner.post(u(orgId, '/pages'), { title: 'Snap', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const pageId = created.body.pageId;
    const sectionId = created.body.sections[0].sectionId;

    const stamped = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ sectionId, type: 'hero', data: { heading: 'Hi' }, localizations: { es: { heading: 'Hola' } }, aiDrafted: { es: '2026-08-20T00:00:00.000Z' } }],
    });
    expect(stamped.status).toBe(200);

    // Publish captures the snapshot (with the stamp)…
    const pub = await owner.post(u(orgId, `/pages/${pageId}/publish`));
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    // …then a later save REMOVES the overlay+stamp…
    const unpub = await owner.post(u(orgId, `/pages/${pageId}/unpublish`));
    expect(unpub.status).toBe(200);
    const wiped = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ sectionId, type: 'hero', data: { heading: 'Hi' } }],
    });
    expect(wiped.body.sections[0].aiDrafted).toBeUndefined();

    // …and restoring the published version brings back overlay AND stamp
    // (restore replaces the snapshot verbatim — provenance is content-coupled).
    const versions = await owner.get(u(orgId, `/pages/${pageId}/versions`));
    const v = versions.body.versions[0];
    expect(v, JSON.stringify(versions.body)).toBeTruthy();
    const restored = await owner.post(u(orgId, `/pages/${pageId}/restore/${v.versionId}`));
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.sections[0].localizations?.es?.heading).toBe('Hola');
    expect(restored.body.sections[0].aiDrafted).toEqual({ es: '2026-08-20T00:00:00.000Z' });
  });
});
