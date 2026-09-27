/**
 * ADR 0592 §1 — optimistic concurrency on the CMS page PATCH (CMSL-1 / CMSLU-3).
 *
 * The full-sections read-modify-write was last-write-wins: a stale editor (or
 * the submit-time auto-translate machine writer) silently destroyed any sibling
 * -locale overlay written between its read and its save. The fix is an OPTIONAL
 * `expectedVersion` precondition enforced inside `updatePage` itself (the
 * approval-pin house pattern, `contentApproval.ts:89-99`): mismatch → 409
 * `conflict` with `{ currentVersion, expectedVersion }`.
 *
 * WITNESS DISCIPLINE (feature-22 F1): memory:// never interleaves handlers
 * mid-request, so none of these witnesses races HTTP handlers. The two-writer
 * case is deterministic version arithmetic; the machine-writer cases force the
 * read→write window through injected seams (the mocked headless resolver / a
 * pass-through contentLocales hook) that perform the interleaved write
 * DETERMINISTICALLY inside the window.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the headless resolver (auto-translate seam) BEFORE the app import.
vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

// Pass-through contentLocales mock with an injectable hook: the ONE await
// between `updateSectionDraft`'s page read and its write is the settings read,
// so a hook there lands a concurrent write deterministically in the window.
const seams = vi.hoisted(() => ({
  onGetSettings: null as null | (() => Promise<void>),
}));
vi.mock('../src/host/contentLocales.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/contentLocales.js')>();
  return {
    ...actual,
    getContentLanguageSettings: async (tenantId: string, orgId: string) => {
      if (seams.onGetSettings) {
        const hook = seams.onGetSettings;
        seams.onGetSettings = null; // one-shot — the retry's re-read must not re-fire it
        await hook();
      }
      return actual.getContentLanguageSettings(tenantId, orgId);
    },
  };
});

import { resolveHeadlessAi } from '../src/host/headlessAi.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { updatePage, getPage } from '../src/features/cms/cmsService.js';
import { buildCmsSurface } from '../src/features/cms/surface.js';

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
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockResolvedValue(vi.fn(async () => '{"heading":"XLATED"}'));
});
afterEach(() => { seams.onGetSettings = null; });

async function setToggle(id: 'cms-localization', status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  expect(d, `${id} toggle must be declared`).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
}

interface Res<T = any> { status: number; headers: Headers; body: T }
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
    return { status: res.status, headers: res.headers, body: out };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
  };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:occ-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `occ-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const u = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${suffix}`;

describe('page PATCH expectedVersion precondition (CMSL-1)', () => {
  it('two writers on the same baseline: the first wins, the second gets 409 conflict and the survivor keeps the overlay', async () => {
    const { owner, orgId } = await ownerOrg();
    await setToggle('cms-localization', 'on');
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['fr', 'es'] });
    const created = await owner.post(u(orgId, '/pages'), {
      title: 'Home',
      sections: [{ type: 'hero', data: { heading: 'Welcome' } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pageId: string = created.body.pageId;
    const baseline = created.body; // version 1, one section
    const sectionId: string = baseline.sections[0].sectionId;

    // Writer A (based on v1): adds a fr overlay, pinned to what it loaded.
    const a = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ sectionId, type: 'hero', data: { heading: 'Welcome' }, localizations: { fr: { heading: 'Bienvenue' } } }],
      expectedVersion: baseline.version,
    });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.version).toBe(baseline.version + 1);

    // Writer B (ALSO based on v1 — a stale tab): would clobber A's fr overlay.
    const b = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ sectionId, type: 'hero', data: { heading: 'Welcome' }, localizations: { es: { heading: 'Bienvenido' } } }],
      expectedVersion: baseline.version,
    });
    expect(b.status, JSON.stringify(b.body)).toBe(409);
    expect(b.body.error).toBe('conflict');
    expect(b.body.details?.currentVersion).toBe(baseline.version + 1);
    expect(b.body.details?.expectedVersion).toBe(baseline.version);

    // The overlay written by A SURVIVED the stale writer.
    const after = await owner.get(u(orgId, `/pages/${pageId}`));
    expect(after.body.sections[0].localizations?.fr?.heading).toBe('Bienvenue');
    expect(after.body.sections[0].localizations?.es).toBeUndefined();

    // B retries with the FRESH pin (reload-and-reapply) → both overlays persist.
    const b2 = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ sectionId, type: 'hero', data: { heading: 'Welcome' }, localizations: { fr: { heading: 'Bienvenue' }, es: { heading: 'Bienvenido' } } }],
      expectedVersion: after.body.version,
    });
    expect(b2.status, JSON.stringify(b2.body)).toBe(200);
    const final = await owner.get(u(orgId, `/pages/${pageId}`));
    expect(final.body.sections[0].localizations?.fr?.heading).toBe('Bienvenue');
    expect(final.body.sections[0].localizations?.es?.heading).toBe('Bienvenido');
  });

  it('a PATCH without expectedVersion stays accepted (optional precondition — API compat)', async () => {
    const { owner, orgId } = await ownerOrg();
    const created = await owner.post(u(orgId, '/pages'), { title: 'Legacy', sections: [] });
    const r = await owner.patch(u(orgId, `/pages/${created.body.pageId}`), { title: 'Renamed' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.title).toBe('Renamed');
  });

  it('rejects a non-numeric expectedVersion with 400', async () => {
    const { owner, orgId } = await ownerOrg();
    const created = await owner.post(u(orgId, '/pages'), { title: 'Bad pin', sections: [] });
    const r = await owner.patch(u(orgId, `/pages/${created.body.pageId}`), { title: 'X', expectedVersion: 'one' });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });
});

describe('submit auto-translate merge is version-checked (the machine writer)', () => {
  it('preserves a human overlay written BETWEEN the sweep read and the merge save (one bounded re-merge)', async () => {
    const { owner, orgId } = await ownerOrg();
    await setToggle('cms-localization', 'on');
    const ok = await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'], autoTranslateOnPublish: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const created = await owner.post(u(orgId, '/pages'), {
      title: 'Race',
      sections: [{ type: 'hero', data: { heading: 'Welcome' } }],
    });
    expect(created.status).toBe(201);
    const pageId: string = created.body.pageId;
    const sectionId: string = created.body.sections[0].sectionId;

    // The interleaved HUMAN writer: while the provider "translates", a second
    // editor adds a fr overlay through the normal pinned PATCH. Deterministic —
    // the dispatch AWAITS the write before returning the translation.
    const humanEditor = client();
    // Same tenant/org membership: reuse the owner's cookie jar via a direct call.
    mockResolve.mockResolvedValue(vi.fn(async () => {
      const fresh = await owner.get(u(orgId, `/pages/${pageId}`));
      const human = await owner.patch(u(orgId, `/pages/${pageId}`), {
        sections: [{ sectionId, type: 'hero', data: { heading: 'Welcome' }, localizations: { fr: { heading: 'Humain' } } }],
        expectedVersion: fresh.body.version,
      });
      expect(human.status, JSON.stringify(human.body)).toBe(200);
      return '{"heading":"XLATED"}';
    }));
    void humanEditor; // (jar reuse: the owner client carries the session)

    // fr is deliberately NOT in supportedLocales' sweep target (pt-BR only), so
    // the sweep never drafts fr — the ONLY fr writer is the interleaved human.
    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.autoTranslated).toEqual({ 'pt-BR': 1 });

    const after = await owner.get(u(orgId, `/pages/${pageId}`));
    // Both writers' work survives: the human fr overlay AND the AI pt-BR draft.
    expect(after.body.sections[0].localizations?.fr?.heading).toBe('Humain');
    expect(after.body.sections[0].localizations?.['pt-BR']?.heading).toBe('XLATED');
  });
});

describe('surface.updateSectionDraft is version-checked (the workflow writer)', () => {
  it('preserves a concurrent editor write landing inside its read→write window (pinned + one retry)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await setToggle('cms-localization', 'on');
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['fr', 'es'] });
    const created = await owner.post(u(orgId, '/pages'), {
      title: 'Draft',
      sections: [
        { type: 'hero', data: { heading: 'One' } },
        { type: 'hero', data: { heading: 'Two' } },
      ],
    });
    expect(created.status).toBe(201);
    const pageId: string = created.body.pageId;
    const [secA, secB] = created.body.sections.map((s: { sectionId: string }) => s.sectionId);

    // The concurrent editor writes an es overlay on section B DURING the
    // surface verb's settings read (the one await inside its window).
    seams.onGetSettings = async () => {
      const fresh = await owner.get(u(orgId, `/pages/${pageId}`));
      const r = await owner.patch(u(orgId, `/pages/${pageId}`), {
        sections: fresh.body.sections.map((s: { sectionId: string; type: string; data: Record<string, unknown> }) =>
          s.sectionId === secB ? { ...s, localizations: { es: { heading: 'Dos' } } } : s),
        expectedVersion: fresh.body.version,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };

    const surface = buildCmsSurface({ tenantId });
    const out = await surface.updateSectionDraft!({ orgId, pageId, sectionId: secA, locale: 'fr', data: { heading: 'Un' } }) as { updated: boolean };
    expect(out.updated, JSON.stringify(out)).toBe(true);

    const after = await getPage(tenantId, orgId, pageId);
    const a = after?.sections.find((s) => s.sectionId === secA);
    const b = after?.sections.find((s) => s.sectionId === secB);
    // BOTH writes survive: the node's fr overlay on A, the editor's es on B.
    expect(a?.localizations?.fr?.heading).toBe('Un');
    expect(b?.localizations?.es?.heading).toBe('Dos');
  });
});

describe('updatePage service-level pin (all callers that send it are covered)', () => {
  it('throws 409 conflict with currentVersion/expectedVersion details on a stale pin', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const created = await owner.post(u(orgId, '/pages'), { title: 'Svc', sections: [] });
    const pageId: string = created.body.pageId;
    const v1 = created.body.version as number;
    await updatePage(tenantId, orgId, pageId, { title: 'Bumped' }, 'user:a', { expectedVersion: v1 });
    await expect(
      updatePage(tenantId, orgId, pageId, { title: 'Stale' }, 'user:b', { expectedVersion: v1 }),
    ).rejects.toMatchObject({ code: 'conflict', httpStatus: 409, details: { currentVersion: v1 + 1, expectedVersion: v1 } });
  });
});
