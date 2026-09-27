/**
 * ADR 0205 — CMS locale governance (gap-analysis Phase D1/D2), ROUTE-level:
 *   D1 translator locale grants — a NARROWING filter over a member's CMS
 *      write: granted-locale overlays only; base data, page chrome, structure,
 *      foreign locales, and workflow transitions are 403 (fail-closed,
 *      server-side diff);
 *   D2 per-locale publish state — a 'draft' locale is withheld from delivery
 *      (negotiation + overlays fall through the RFC 0103 chain); absent state
 *      is published (backward compatible). Toggle-gated on `cms-localization`.
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const loc = getToggleDefault('cms-localization');
  if (loc) await saveConfig({ ...loc, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
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
    return { status: res.status, body: out };
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
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `lg-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const u = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

/** Owner + an editor-role member (needs workspace:write to PATCH). */
async function ownerWithEditor(): Promise<{ owner: Client; editor: Client; editorSubject: string; orgId: string }> {
  const tenantId = `org:lg-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, tenantId);
  const editor = client();
  const editorUser = await signup(editor, tenantId);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'T', subject: editorUser.userId, roles: ['editor'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, editor, editorSubject: editorUser.userId, orgId };
}

async function localizedDraft(owner: Client, orgId: string): Promise<{ pageId: string; slug: string; sectionId: string }> {
  const ok = await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR', 'es'] });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  const created = await owner.post(u(orgId, '/pages'), {
    title: 'Home',
    sections: [{ type: 'hero', data: { heading: 'Welcome' }, localizations: { 'pt-BR': { heading: 'Bem-vindo' }, es: { heading: 'Bienvenido' } } }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { pageId: created.body.pageId, slug: created.body.slug, sectionId: created.body.sections[0].sectionId };
}

describe('D1 — translator locale grants', () => {
  it('narrows a granted member to their locales; admins manage grants', async () => {
    const { owner, editor, editorSubject, orgId } = await ownerWithEditor();
    const { pageId, sectionId } = await localizedDraft(owner, orgId);

    // Grant management is admin-tier: the editor cannot set grants.
    expect((await editor.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['pt-BR'] })).status).toBe(403);
    const put = await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['pt-BR'] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.grant.locales).toEqual(['pt-BR']);
    expect((await owner.get(u(orgId, '/locale-grants'))).body.grants).toHaveLength(1);

    const page = (await editor.get(u(orgId, `/pages/${pageId}`))).body;

    // Granted-locale overlay edit: ALLOWED.
    const okPatch = await editor.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ sectionId, type: 'hero', data: page.sections[0].data, localizations: { ...page.sections[0].localizations, 'pt-BR': { heading: 'Bem-vindo!' } } }],
    });
    expect(okPatch.status, JSON.stringify(okPatch.body)).toBe(200);
    expect(okPatch.body.sections[0].localizations['pt-BR'].heading).toBe('Bem-vindo!');

    // Base-data change: 403.
    expect((await editor.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ sectionId, type: 'hero', data: { heading: 'HACKED' }, localizations: page.sections[0].localizations }],
    })).status).toBe(403);

    // Foreign-locale overlay change: 403.
    expect((await editor.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ sectionId, type: 'hero', data: page.sections[0].data, localizations: { ...page.sections[0].localizations, es: { heading: 'Hola' } } }],
    })).status).toBe(403);

    // Page chrome + structure: 403.
    expect((await editor.patch(u(orgId, `/pages/${pageId}`), { title: 'New title' })).status).toBe(403);
    expect((await editor.patch(u(orgId, `/pages/${pageId}`), { sections: [] })).status).toBe(403);

    // Workflow transitions: 403 (overlay-only grant).
    expect((await editor.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(403);

    // Base-content side doors are CLOSED too (review finding): page create
    // and every shared-section write are 403 for a grant-holder.
    expect((await editor.post(u(orgId, '/pages'), { title: 'Rogue' })).status).toBe(403);
    expect((await editor.post(u(orgId, '/shared-sections'), { name: 'Rogue', type: 'cta', data: { label: 'x' } })).status).toBe(403);

    // AI translate: granted locale OK-or-503 (provider absent), foreign 403.
    const xl = await editor.post(u(orgId, '/translate-section'), { sectionType: 'hero', data: { heading: 'Welcome' }, targetLocale: 'pt-BR' });
    expect([200, 503]).toContain(xl.status);
    expect((await editor.post(u(orgId, '/translate-section'), { sectionType: 'hero', data: { heading: 'Welcome' }, targetLocale: 'es' })).status).toBe(403);

    // Empty locale list removes the grant → full editor behavior returns.
    const cleared = await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: [] });
    expect(cleared.body.grant).toBeNull();
    expect((await editor.patch(u(orgId, `/pages/${pageId}`), { title: 'New title' })).status).toBe(200);
  });
});

describe('D2 — per-locale publish state', () => {
  it('withholds a draft locale from delivery (RFC 0103 fallback) and restores on publish', async () => {
    const { owner, orgId } = await ownerWithEditor();
    const { pageId, slug } = await localizedDraft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/publish`));

    // Baseline: pt-BR served.
    const before = await owner.get(u(orgId, `/pages/by-slug/${slug}`), { 'accept-language': 'pt-BR' });
    expect(before.body.page.sections[0].data.heading).toBe('Bem-vindo');

    // Unpublish pt-BR → falls back to base; es unaffected.
    const un = await owner.post(u(orgId, `/pages/${pageId}/locales/pt-BR/unpublish`));
    expect(un.status, JSON.stringify(un.body)).toBe(200);
    expect(un.body.localePublishState['pt-BR']).toBe('draft');

    const after = await owner.get(u(orgId, `/pages/by-slug/${slug}`), { 'accept-language': 'pt-BR' });
    expect(after.body.page.sections[0].data.heading).toBe('Welcome'); // withheld → base
    const es = await owner.get(u(orgId, `/pages/by-slug/${slug}`), { 'accept-language': 'es' });
    expect(es.body.page.sections[0].data.heading).toBe('Bienvenido');

    // Republish → served again; absent-state compat (map drops the key).
    const re = await owner.post(u(orgId, `/pages/${pageId}/locales/pt-BR/publish`));
    expect(re.body.localePublishState).toBeUndefined();
    const restored = await owner.get(u(orgId, `/pages/by-slug/${slug}`), { 'accept-language': 'pt-BR' });
    expect(restored.body.page.sections[0].data.heading).toBe('Bem-vindo');

    // ADR 0593 §C8 (CMSA-10 exit) — DELIBERATE BEHAVIOUR CHANGE, recorded here
    // rather than silently re-pinned. This used to assert `fr` → 400 under the
    // heading "Unknown locale", but `fr` is a perfectly valid BCP-47 tag; it is
    // merely UNCONFIGURED. Requiring configuration in the WITHHOLD direction
    // made the §C2 widening refusal a gate with no practical exit: the safe way
    // to add a locale is to withhold it per page first, which was impossible
    // because it was not yet configured, while adding it was refused because it
    // was not withheld. Withholding removes content from delivery, so it is the
    // fail-safe direction and is now open for any valid non-base tag.
    expect((await owner.post(u(orgId, `/pages/${pageId}/locales/fr/unpublish`))).status).toBe(200);
    // The RELEASE direction is still configured-locales-only…
    expect((await owner.post(u(orgId, `/pages/${pageId}/locales/fr/publish`))).status).toBe(400);
    // …and the withhold direction still refuses a malformed tag and the base.
    expect((await owner.post(u(orgId, `/pages/${pageId}/locales/not-a-locale/unpublish`))).status).toBe(400);
    expect((await owner.post(u(orgId, `/pages/${pageId}/locales/en/unpublish`))).status).toBe(400);
  });
});


describe('locale-grants/mine — the translator self-read (ADR 0592 §2 / CMSLU-1)', () => {
  it('returns the CALLER own grant, null when none, and never another subject grant', async () => {
    const { owner, editor, editorSubject, orgId } = await ownerWithEditor();

    // No grant yet → null (an access statement, not an error).
    const none = await editor.get(u(orgId, '/locale-grants/mine'));
    expect(none.status, JSON.stringify(none.body)).toBe(200);
    expect(none.body.grant).toBeNull();

    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['pt-BR'] });

    // The grantee sees exactly their own grant.
    const mine = await editor.get(u(orgId, '/locale-grants/mine'));
    expect(mine.status).toBe(200);
    expect(mine.body.grant.subject).toBe(editorSubject);
    expect(mine.body.grant.locales).toEqual(['pt-BR']);

    // A DIFFERENT member never sees the grantee's grant through /mine —
    // the read is self-scoped by construction (no subject parameter).
    const owner2 = await owner.get(u(orgId, '/locale-grants/mine'));
    expect(owner2.status).toBe(200);
    expect(owner2.body.grant).toBeNull();
  });

  it('is NOT toggle-gated — enforcement is unconditional, so the self-view is too (mirror of the CMSL-3 ruling)', async () => {
    const { owner, editor, editorSubject, orgId } = await ownerWithEditor();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['es'] });
    const put = await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['es'] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const loc = getToggleDefault('cms-localization');
    expect(loc).toBeTruthy();
    if (loc) await saveConfig({ ...loc, status: 'off' }, 'test');
    try {
      const mine = await editor.get(u(orgId, '/locale-grants/mine'));
      expect(mine.status, JSON.stringify(mine.body)).toBe(200);
      expect(mine.body.grant.locales).toEqual(['es']);
    } finally {
      if (loc) await saveConfig({ ...loc, status: 'on' }, 'test');
    }
  });
});

describe('ADR 0592 §9 — grant lifecycle hygiene (CMSL-3 / CMSL-7 / CMSL-8)', () => {
  it('CMSL-7: a grant for an unconfigured locale 400s naming the unsupported set (an undeliverable grant is a lockout, not a grant)', async () => {
    const { owner, editorSubject, orgId } = await ownerWithEditor();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    const bad = await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['pt-BR', 'de'] });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(bad.body.details?.unsupported).toEqual(['de']);
    expect(bad.body.details?.supportedLocales).toEqual(['pt-BR']);
    // The configured locale alone is accepted.
    const ok = await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['pt-BR'] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('CMSL-3: grant REMOVAL stays reachable with the toggle OFF (enforcement is unconditional, so the closable lane must be too)', async () => {
    const { owner, editor, editorSubject, orgId } = await ownerWithEditor();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['es'] });
    const put = await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['es'] });
    expect(put.status).toBe(200);
    const created = await owner.post(u(orgId, '/pages'), { title: 'Probe page', sections: [] });
    expect(created.status).toBe(201);
    const pageId = created.body.pageId as string;
    const loc = getToggleDefault('cms-localization');
    expect(loc).toBeTruthy();
    if (loc) await saveConfig({ ...loc, status: 'off' }, 'test');
    try {
      // Enforcement still bites with the toggle OFF (the fail-closed default):
      // a title PATCH is outside the grant, so the translator 403s.
      expect((await editor.patch(u(orgId, `/pages/${pageId}`), { title: 'x' })).status).toBe(403);
      // …a NON-empty grant write stays toggle-gated (404)…
      expect((await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['es'] })).status).toBe(404);
      // …but REMOVAL is exempt: the stranded member can be freed.
      const removed = await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: [] });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body.grant).toBeNull();
      // Freed: full-editor behavior returns even while the toggle is off.
      expect((await editor.patch(u(orgId, `/pages/${pageId}`), { title: 'x' })).status).toBe(200);
    } finally {
      if (loc) await saveConfig({ ...loc, status: 'on' }, 'test');
    }
  });

  it('CMSL-8: a baseLocale change is refused (409, offenders named) while overlays keyed at the NEW base exist', async () => {
    const { owner, orgId } = await ownerWithEditor();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['es'] });
    const created = await owner.post(u(orgId, '/pages'), {
      title: 'Base bomb',
      sections: [{ type: 'hero', data: { heading: 'Hi' }, localizations: { es: { heading: 'Hola' } } }],
    });
    expect(created.status).toBe(201);

    // Changing base to `es` would orphan the es overlay AS base — refused.
    const refused = await owner.put(u(orgId, '/language-settings'), { baseLocale: 'es', supportedLocales: [] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toBe('conflict');
    expect(refused.body.details?.offenders?.[0]?.kind).toBe('page');

    // Remove the offending overlay → the change is accepted.
    const page = created.body;
    const cleared = await owner.patch(u(orgId, `/pages/${page.pageId}`), {
      sections: [{ sectionId: page.sections[0].sectionId, type: 'hero', data: { heading: 'Hi' } }],
      expectedVersion: page.version,
    });
    expect(cleared.status).toBe(200);
    const ok = await owner.put(u(orgId, '/language-settings'), { baseLocale: 'es', supportedLocales: [] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.baseLocale).toBe('es');
  });
});

// ── Review F1 (ADR 0592 §Corrections) — the COMPOSED translator-save witness.
// The FE witness alone was mechanism-without-wiring: it mocked savePage, so it
// never met the route's D1 guard, which 403s a grant-holder on the PRESENCE of
// title/tags — meaning the pre-correction SPA payload ({title, sections, tags,
// expectedVersion}) made EVERY translator Save fail. These replay the byte-
// exact payload shapes against the REAL route, no mocks.
describe('translator surface save — composed against the real route (review F1)', () => {
  it('the translator-surface payload (sections + pin ONLY) saves a granted overlay; the old title/tags echo is the refusal it always was', async () => {
    const { owner, editor, editorSubject, orgId } = await ownerWithEditor();
    const { pageId, sectionId } = await localizedDraft(owner, orgId);
    await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['pt-BR'] });

    const page = (await editor.get(u(orgId, `/pages/${pageId}`))).body;
    const sections = [{
      sectionId, type: 'hero', data: page.sections[0].data,
      localizations: { ...page.sections[0].localizations, 'pt-BR': { heading: 'Salvo pela superfície' } },
    }];

    // The FIXED translator payload: sections + expectedVersion, nothing else.
    const ok = await editor.patch(u(orgId, `/pages/${pageId}`), { sections, expectedVersion: page.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.sections[0].localizations['pt-BR'].heading).toBe('Salvo pela superfície');

    // The PRE-correction SPA echo (title/tags PRESENT, values unchanged):
    // refused — this is the composed defect the mocked witness missed.
    const echo = await editor.patch(u(orgId, `/pages/${pageId}`), {
      title: ok.body.title, sections: ok.body.sections, tags: ok.body.tags ?? [], expectedVersion: ok.body.version,
    });
    expect(echo.status, JSON.stringify(echo.body)).toBe(403);

    // And an ACTUAL title/tags change stays refused (the guard is intact —
    // the fix moved the SPA payload, never the guard).
    expect((await editor.patch(u(orgId, `/pages/${pageId}`), { title: 'Hacked', sections: ok.body.sections, expectedVersion: ok.body.version })).status).toBe(403);
    expect((await editor.patch(u(orgId, `/pages/${pageId}`), { tags: ['rogue'], sections: ok.body.sections, expectedVersion: ok.body.version })).status).toBe(403);
  });
});

// ── Review F4 (ADR 0592 §Corrections) — the D1 guard covers aiDrafted.
describe('translator narrowing covers the AI-provenance stamps (review F4)', () => {
  it('a translator granted es can neither STRIP nor FORGE fr\'s stamp, but may clear their own', async () => {
    const { owner, editor, editorSubject, orgId } = await ownerWithEditor();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['es', 'fr'] });
    const created = await owner.post(u(orgId, '/pages'), {
      title: 'Stamps',
      sections: [{
        sectionId: undefined, type: 'hero', data: { heading: 'Hi' },
        localizations: { es: { heading: 'Hola' }, fr: { heading: 'Salut' } },
        aiDrafted: { es: '2026-08-20T00:00:00.000Z', fr: '2026-08-20T00:00:00.000Z' },
      }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pageId = created.body.pageId as string;
    await owner.put(u(orgId, '/locale-grants'), { subject: editorSubject, locales: ['es'] });
    const page = (await editor.get(u(orgId, `/pages/${pageId}`))).body;
    const sec = page.sections[0];
    expect(sec.aiDrafted).toEqual({ es: '2026-08-20T00:00:00.000Z', fr: '2026-08-20T00:00:00.000Z' });

    // STRIP fr's stamp (overlay unchanged) → 403: laundering the review signal.
    const strip = await editor.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ ...sec, aiDrafted: { es: sec.aiDrafted.es } }],
      expectedVersion: page.version,
    });
    expect(strip.status, JSON.stringify(strip.body)).toBe(403);

    // FORGE fr's stamp (different value) → 403.
    const forge = await editor.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ ...sec, aiDrafted: { ...sec.aiDrafted, fr: '2026-08-21T09:00:00.000Z' } }],
      expectedVersion: page.version,
    });
    expect(forge.status, JSON.stringify(forge.body)).toBe(403);

    // Their OWN granted locale: a human edit clears the es stamp → 200 (the
    // legitimate clear the FE performs on typing).
    const ok = await editor.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ ...sec, localizations: { ...sec.localizations, es: { heading: 'Hola revisada' } }, aiDrafted: { fr: sec.aiDrafted.fr } }],
      expectedVersion: page.version,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.sections[0].aiDrafted).toEqual({ fr: '2026-08-20T00:00:00.000Z' });
    expect(ok.body.sections[0].localizations.fr.heading).toBe('Salut'); // untouched
  });
});
