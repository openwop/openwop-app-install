/**
 * ADR 0593 §C9 (adversarial review of PR #3428, F1) — THE ROOT CAUSE under
 * CMSA-1 and CMSA-10 alike: every page-set scan in this feature reads
 * `page.sections`, and delivery does not always serve `page.sections`.
 *
 * `publicPageBySlug` (ADR 0236 D1) substitutes a bound variant's snapshot for a
 * visitor assigned to a non-holdout arm:
 *
 *     servedPage = await resolveSharedRefs({ ...hit.page,
 *       title: version.snapshot.title, sections: version.snapshot.sections })
 *
 * and BOTH `resolveSharedRefs` and `localizePage` then run over the SNAPSHOT.
 * So a section that was removed from the live page but survives inside a bound
 * snapshot is invisible to `listPagesUsingSharedSection`, to the §C2 widening
 * scan, and to the ADR 0592 §9 baseLocale scan — and is still delivered.
 *
 * Both exploits below run with the gate ON, anonymously, and prove the content
 * reaches a real visitor. `page.version` never moves in either.
 *
 * The lesson is the THIRD level of the same instruction. §C7: the delivery
 * function's inputs include the inputs of everything it CALLS. §C8: and its
 * MATCHING rule. Here: and its SUBSTITUTION rule — what it serves need not be
 * what the page currently holds.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { assignWeightedVariant } from '../src/host/variantAssignment.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'analytics', 'cms-localization']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setGate = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('cms-approval-gate');
  expect(d).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
};

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Res<T = any> { status: number; headers: Headers; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  put: (p: string, b?: unknown) => Promise<Res>;
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ c: Client; orgId: string }> {
  const tenantId = `org:snap-${Date.now()}-${n++}`;
  const c = client();
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `snap-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId as string };
}
const cms = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
const exps = (orgId: string, pageId: string, s = ''): string => cms(orgId, `/pages/${encodeURIComponent(pageId)}/experiments${s}`);

/** The anonymous variant read — a visitor key bucketed onto `candidate`. */
async function publicVariantRead(orgId: string, slug: string, exp: any, acceptLanguage = 'en'): Promise<Res> {
  let vk = '';
  for (let i = 0; i < 800 && !vk; i++) {
    const k = `vis-${i}`;
    if (assignWeightedVariant(k, exp.experimentId, exp.salt, exp.variants) === 'candidate') vk = k;
  }
  expect(vk, 'a visitor key must bucket onto the candidate variant').toBeTruthy();
  const res = await fetch(
    `${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}?vk=${vk}`,
    { headers: { 'accept-language': acceptLanguage } },
  );
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => undefined) };
}

/**
 * A published page whose LIVE sections no longer carry the payload, while a
 * RUNNING experiment serves a snapshot that still does. Everything is built
 * with the gate OFF — the realistic history: the org turned the editorial gate
 * on with an experiment already running.
 */
async function pageWithSnapshotOnlyContent(
  c: Client,
  orgId: string,
  seed: { sections: unknown[]; strippedSections: unknown[] },
): Promise<{ pageId: string; slug: string; exp: any }> {
  await setGate('off');
  const created = await c.post(cms(orgId, '/pages'), { title: 'Landing', sections: seed.sections });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const pageId = created.body.pageId as string;
  const slug = created.body.slug as string;
  expect((await c.post(cms(orgId, `/pages/${pageId}/publish`))).status).toBe(200); // snapshot A holds the payload

  // The live page moves on and DROPS the payload entirely.
  expect((await c.post(cms(orgId, `/pages/${pageId}/unpublish`))).status).toBe(200);
  const patched = await c.patch(cms(orgId, `/pages/${pageId}`), { sections: seed.strippedSections });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  expect((await c.post(cms(orgId, `/pages/${pageId}/publish`))).status).toBe(200);

  const versions = await c.get(cms(orgId, `/pages/${pageId}/versions`));
  const rows = versions.body.versions as Array<{ versionId: string; version: number }>;
  const oldest = [...rows].sort((a, b) => a.version - b.version)[0]!;

  const exp = await c.post(exps(orgId, pageId), {
    name: 'Snapshot arm',
    variants: [
      { key: 'control', versionId: null, weight: 50 },
      { key: 'candidate', versionId: oldest.versionId, weight: 50 },
    ],
  });
  expect(exp.status, JSON.stringify(exp.body)).toBe(201);
  const started = await c.post(exps(orgId, pageId, `/${exp.body.experimentId}/start`));
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  return { pageId, slug, exp: started.body };
}

describe('F1a — a shared section referenced ONLY by a bound snapshot is an ungated lane to live content', () => {
  it('refuses the shared-section edit, and the variant visitor never sees the rewrite', async () => {
    const { c, orgId } = await ownerOrg();
    await setGate('off');
    const shared = await c.post(cms(orgId, '/shared-sections'), {
      name: 'Global CTA', type: 'cta', data: { label: 'Go', url: '/agents' },
    });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    const sharedSectionId = shared.body.sharedSectionId as string;

    const { pageId, slug, exp } = await pageWithSnapshotOnlyContent(c, orgId, {
      sections: [
        { type: 'hero', data: { heading: 'Landing' } },
        { type: 'cta', data: {}, ref: { sharedSectionId } },
      ],
      strippedSections: [{ type: 'hero', data: { heading: 'Landing' } }],
    });

    // The live page no longer references it — which is exactly why a scan that
    // only reads `page.sections` returned EMPTY here, and why the gate could
    // not see the lane. `GET …/shared-sections/:id/pages` is the "read before
    // you try" list the refusal points operators at, so it has to agree with
    // the gate or the remedy names the wrong pages: it now reports the page on
    // the strength of the BOUND SNAPSHOT's reference.
    const using = await c.get(cms(orgId, `/shared-sections/${sharedSectionId}/pages`));
    expect(using.status).toBe(200);
    expect((using.body.pages as any[]).map((p) => p.pageId)).toContain(pageId);

    // …but a variant visitor is served it, right now.
    const before = await publicVariantRead(orgId, slug, exp);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.experiment?.variant).toBe('candidate');
    expect(before.body.sections.find((s: any) => s.type === 'cta')?.data.url).toBe('/agents');

    await setGate('on');
    const rewrite = await c.patch(cms(orgId, `/shared-sections/${sharedSectionId}`), {
      data: { label: 'Claim your refund', url: 'https://evil.test' },
    });
    expect(rewrite.status, JSON.stringify(rewrite.body)).toBe(409);
    const details = rewrite.body?.error?.details ?? rewrite.body?.details;
    expect(details.gate).toBe('cms-approval-gate');
    expect((details.pages as any[]).map((p) => [p.title, p.status])).toEqual([['Landing', 'published']]);

    // THE CLAIM — the visitor still gets the reviewed CTA, and no approval row
    // was created (this lane bypassed the inbox entirely).
    const after = await publicVariantRead(orgId, slug, exp);
    expect(after.body.sections.find((s: any) => s.type === 'cta')?.data.url).toBe('/agents');
    const pending = await c.get('/v1/host/openwop-app/approvals?status=pending');
    expect((pending.body.items as any[]).filter((a) => a.kind === 'content-publish')).toHaveLength(0);
  });

  it('UNGATED positive control — with the gate OFF the rewrite lands and reaches the visitor', async () => {
    // Without this the refusal above could be a broken route, AND the defect
    // itself would be unwitnessed.
    const { c, orgId } = await ownerOrg();
    await setGate('off');
    const shared = await c.post(cms(orgId, '/shared-sections'), {
      name: 'Global CTA', type: 'cta', data: { label: 'Go', url: '/agents' },
    });
    const sharedSectionId = shared.body.sharedSectionId as string;
    const { slug, exp } = await pageWithSnapshotOnlyContent(c, orgId, {
      sections: [
        { type: 'hero', data: { heading: 'Landing' } },
        { type: 'cta', data: {}, ref: { sharedSectionId } },
      ],
      strippedSections: [{ type: 'hero', data: { heading: 'Landing' } }],
    });
    const rewrite = await c.patch(cms(orgId, `/shared-sections/${sharedSectionId}`), {
      data: { label: 'Claim your refund', url: 'https://evil.test' },
    });
    expect(rewrite.status, JSON.stringify(rewrite.body)).toBe(200);
    const after = await publicVariantRead(orgId, slug, exp);
    expect(after.body.sections.find((s: any) => s.type === 'cta')?.data.url).toBe('https://evil.test');
  });

  it('a shared section referenced by NEITHER the live page nor any snapshot is still freely editable', async () => {
    // The deliverable set must be live ∪ bound-snapshot, not "every section
    // that ever existed" — otherwise the gate refuses edits it does not govern.
    const { c, orgId } = await ownerOrg();
    await setGate('off');
    const shared = await c.post(cms(orgId, '/shared-sections'), {
      name: 'Unused', type: 'cta', data: { label: 'Go', url: '/agents' },
    });
    await setGate('on');
    const edit = await c.patch(cms(orgId, `/shared-sections/${shared.body.sharedSectionId}`), { data: { label: 'X', url: '/y' } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
  });
});

describe('F1b — the §C2 widening scan is blind to snapshot overlays', () => {
  it('refuses the locale widening, and the variant visitor never sees the snapshot overlay', async () => {
    const { c, orgId } = await ownerOrg();
    const DORMANT = 'RASCUNHO NAO REVISADO';
    const { slug, exp } = await pageWithSnapshotOnlyContent(c, orgId, {
      sections: [{ type: 'hero', data: { heading: 'Landing' }, localizations: { 'pt-BR': { heading: DORMANT } } }],
      strippedSections: [{ type: 'hero', data: { heading: 'Landing' } }],
    });

    // Dormant: pt-BR is unconfigured, so the snapshot overlay is not served.
    const before = await publicVariantRead(orgId, slug, exp, 'pt-BR');
    expect(before.headers.get('content-language')).toBe('en');
    expect(before.body.sections[0].data.heading).toBe('Landing');

    await setGate('on');
    const widen = await c.put(cms(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(409);
    const details = widen.body?.error?.details ?? widen.body?.details;
    expect(details.gate).toBe('cms-approval-gate');
    expect((details.pages as any[]).map((p) => p.title)).toEqual(['Landing']);

    const after = await publicVariantRead(orgId, slug, exp, 'pt-BR');
    expect(after.headers.get('content-language')).toBe('en');
    expect(after.body.sections[0].data.heading).toBe('Landing');
  });

  it('UNGATED positive control — with the gate OFF the widening releases the snapshot overlay to the visitor', async () => {
    const { c, orgId } = await ownerOrg();
    const DORMANT = 'RASCUNHO NAO REVISADO';
    const { slug, exp } = await pageWithSnapshotOnlyContent(c, orgId, {
      sections: [{ type: 'hero', data: { heading: 'Landing' }, localizations: { 'pt-BR': { heading: DORMANT } } }],
      strippedSections: [{ type: 'hero', data: { heading: 'Landing' } }],
    });
    const widen = await c.put(cms(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
    const after = await publicVariantRead(orgId, slug, exp, 'pt-BR');
    expect(after.headers.get('content-language')).toBe('pt-BR');
    expect(after.body.sections[0].data.heading).toBe(DORMANT); // never reviewed, now public
  });

  it('a DRAFT experiment is not a delivery lane — its snapshot must not block', async () => {
    // `deliverableSectionsForPage` is restricted to RUNNING experiments because
    // draft/stopped arms serve nobody. A scan that included them would refuse
    // edits that reach no reader — the over-refusal half of the same mistake.
    const { c, orgId } = await ownerOrg();
    const DORMANT = 'RASCUNHO NAO REVISADO';
    await setGate('off');
    const created = await c.post(cms(orgId, '/pages'), {
      title: 'Draft arm',
      sections: [{ type: 'hero', data: { heading: 'Landing' }, localizations: { 'pt-BR': { heading: DORMANT } } }],
    });
    const pageId = created.body.pageId as string;
    expect((await c.post(cms(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    expect((await c.post(cms(orgId, `/pages/${pageId}/unpublish`))).status).toBe(200);
    await c.patch(cms(orgId, `/pages/${pageId}`), { sections: [{ type: 'hero', data: { heading: 'Landing' } }] });
    expect((await c.post(cms(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    const rows = (await c.get(cms(orgId, `/pages/${pageId}/versions`))).body.versions as Array<{ versionId: string; version: number }>;
    const oldest = [...rows].sort((a, b) => a.version - b.version)[0]!;
    const exp = await c.post(exps(orgId, pageId), {
      name: 'Never started',
      variants: [
        { key: 'control', versionId: null, weight: 50 },
        { key: 'candidate', versionId: oldest.versionId, weight: 50 },
      ],
    });
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    // NOT started.
    await setGate('on');
    const widen = await c.put(cms(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
  });
});

/**
 * ADR 0668 D1 / `CMSLWF-13` — **this suite covers ONE of the four write lanes and ONE of the
 * two axes.** The three cases below all put `tenantId` in a section's base `data` on the page
 * lane. They put nothing in `localizations`, and they never touch shared sections — which is
 * exactly why the guard shipped absent on the overlay axis AND absent on both shared-section
 * lanes, and why a reader sending `Accept-Language: es` could be served another workspace.
 *
 * The other three lanes and the overlay axis are covered in
 * `test/cms-localization-tenant-axis.test.ts`. Read that file before concluding from THIS one
 * that the guard is covered: a guard whose witness tests a single axis is how this shipped.
 */
describe('CMSA-12 (cross-tenant half) — an entity section may only name its OWN workspace', () => {
  it('refuses at the WRITE, which is the only place that closes BOTH delivery lanes', async () => {
    // `data.tenantId` is editor-controlled at `workspace:write`, and both lanes
    // read it: the prerenderer resolves it server-side into crawler HTML +
    // JSON-LD, and the SPA fetches it client-side straight from the section
    // (`SectionRenderer.tsx` passes `tenantId={str(d.tenantId)}`). A read-only
    // cure would close the crawler lane and leave the human one open — crawler
    // ≠ human, the exact cloaking mismatch the resolver's own comment says it
    // exists to avoid. So the refusal is at the write.
    const { c, orgId } = await ownerOrg();
    const foreign = await c.post(cms(orgId, '/pages'), {
      title: 'Embed',
      sections: [{ type: 'entityList', data: { tenantId: 'org:someone-else', typeName: 'article', titleField: 'title' } }],
    });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(400);
    const details = foreign.body?.error?.details ?? foreign.body?.details;
    expect(details.field).toBe('tenantId');
    expect(details.section).toBe('entityList');
  });

  it('the page OWN tenant is still accepted — the guard is a tenant check, not a ban', async () => {
    const { c, orgId } = await ownerOrg();
    const me = await c.get('/v1/host/openwop-app/orgs');
    const tenantId = (me.body.orgs as any[]).find((o) => o.orgId === orgId)?.tenantId;
    expect(tenantId, 'the org row must expose its tenant').toBeTruthy();
    const ok = await c.post(cms(orgId, '/pages'), {
      title: 'Own embed',
      sections: [{ type: 'entityList', data: { tenantId, typeName: 'article', titleField: 'title' } }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.sections[0].data.tenantId).toBe(tenantId);
  });

  it('a PATCH cannot smuggle a foreign tenant in either', async () => {
    const { c, orgId } = await ownerOrg();
    const created = await c.post(cms(orgId, '/pages'), { title: 'Later', sections: [{ type: 'hero', data: { heading: 'x' } }] });
    expect(created.status).toBe(201);
    const patched = await c.patch(cms(orgId, `/pages/${created.body.pageId}`), {
      sections: [{ type: 'entityDetail', data: { tenantId: 'org:someone-else', typeName: 'article', entityId: 'e1', titleField: 'title' } }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(400);
  });
});
