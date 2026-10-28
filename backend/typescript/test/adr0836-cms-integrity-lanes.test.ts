/**
 * ADR 0836 — the lanes the pre-code `/architect` pass found the first draft
 * missed (AR-H1..H7, AR-M*), and the remaining D-decisions whose witnesses need
 * the new seams (`authorize`, `keepSchedule`, the surface floor). The headline
 * RED-on-`origin/main` witnesses are in `adr0836-cms-integrity.test.ts`.
 *
 * Sabotage (w16 probes, each red here): any of the three surface writers asking only
 * `workspace:read`; `updateSectionDraft` writing into a shared ref or a locale with
 * localization OFF; `updatePage` skipping `authorize` on its own read; the PATCH route
 * keeping/cancelling a schedule for the wrong tier; `isLiveTierPage` ignoring a
 * schedule; a blind legacy-marker delete; restore ignoring its pin; promote announcing
 * `unpublished` or checking blockers after the restore; a case-sensitive or submit-time
 * `[TODO]` check; an in-place edit skipping blockers; overlays counted as blockers.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import {
  createPage, getPage, listPages, listVersions, publishBlockers, restoreVersion,
  setScheduledPublish, clearScheduledPublish, transitionPage, updatePage, createSharedSection, type Page,
} from '../src/features/cms/cmsService.js';
import { processScheduledPublishes } from '../src/features/cms/publishSweep.js';
import { createExperiment, promoteExperiment, toEngineExperiment } from '../src/features/cms/pageExperimentsService.js';
import { putExperimentRow } from '../src/host/experiments/store.js';
import { onCmsPageLifecycle, type CmsPageLifecycleChange } from '../src/host/cmsPageLifecycle.js';
import { ensureSystemSite, SYSTEM_SITE_ORG, SYSTEM_SITE_TENANT } from '../src/host/systemSite.js';
import { ensureFeaturesPage } from '../src/host/featuresPage.js';
import { ensureComparisonPage } from '../src/host/comparisonPage.js';
import { ensureMarketingContentPages } from '../src/host/marketingContentPages.js';
import { ensureMarketingLegalPages } from '../src/host/marketingLegalPages.js';
import { ensureSystemSiteDocs } from '../src/host/systemSiteDocs.js';
import { ensureSystemSiteBlog, LAUNCH_POST_PAGE_ID } from '../src/host/systemSiteBlog.js';

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
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Body {
  user?: { userId: string };
  orgId?: string;
  pageId?: string;
  version?: number;
  scheduledPublishAt?: string;
  scheduledPublishVersion?: number;
  details?: { requiredScope?: string; reason?: string };
}
interface Res { status: number; body: Body | undefined }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : (await res.json().catch(() => undefined)) as Body | undefined; // wire JSON
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
  };
}
type Client = ReturnType<typeof client>;

let n = 0;
async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/host/openwop-app/test/login', { email: `a0836l-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body!.user!.userId;
}
const cms = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
const seo = (orgId: string, pageId: string): string =>
  `/host/openwop-app/publishing/orgs/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(pageId)}/seo`;

/** One tenant: an owner (admin tier), an `editor` and a `viewer` of one org. */
async function team(): Promise<{ owner: Client; editor: Client; tenantId: string; orgId: string; ownerId: string; editorId: string; viewerId: string }> {
  const tenantId = `org:a0836l-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = await signup(owner, tenantId);
  const editor = client();
  const editorId = await signup(editor, tenantId);
  const viewer = client();
  const viewerId = await signup(viewer, tenantId);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body!.orgId!;
  for (const [subject, role] of [[editorId, 'editor'], [viewerId, 'viewer']] as const) {
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: role, subject, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  return { owner, editor, tenantId, orgId, ownerId, editorId, viewerId };
}

const hero = (heading: string) => [{ type: 'hero', data: { heading } }];
const later = (): string => new Date(Date.now() + 60_000).toISOString();

// ── D5 — the workflow surface asks what the route asks ──────────────────────

describe('ADR 0836 D5 — surface writers need workspace:write (CMS2WF-2)', () => {
  it('a viewer-run cannot create, edit or submit through ctx.features.cms; an editor-run can', async () => {
    const t = await team();
    const asViewer = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-v', actingUserId: t.viewerId });
    const asEditor = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-e', actingUserId: t.editorId });
    await expect(asViewer.cms!.createDraftPage!({ orgId: t.orgId, title: 'planted' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    const made = await asEditor.cms!.createDraftPage!({ orgId: t.orgId, title: 'ok' }) as { pageId: string };
    const page = await getPage(t.tenantId, t.orgId, made.pageId);
    const sectionId = page!.sections[0]?.sectionId ?? 'none';
    await expect(asViewer.cms!.updateSectionDraft!({ orgId: t.orgId, pageId: made.pageId, sectionId, data: { heading: 'x' } })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(asViewer.cms!.submitPage!({ orgId: t.orgId, pageId: made.pageId })).rejects.toMatchObject({ code: 'forbidden_scope' });
    // Reads stay at read tier.
    await expect(asViewer.cms!.getDraftPage!({ orgId: t.orgId, pageId: made.pageId })).resolves.toMatchObject({ page: { pageId: made.pageId } });
  });
});

// ── D10 — surface honesty ───────────────────────────────────────────────────

describe('ADR 0836 D10 — updateSectionDraft refuses what it cannot keep', () => {
  it('a shared-section reference is a typed 409, not `updated:true` (CMS2WF-4)', async () => {
    const t = await team();
    const sh = await createSharedSection(t.tenantId, t.orgId, { name: 'F', type: 'richText', data: { heading: 'H', text: 'Shared' } }, t.ownerId);
    const p = await createPage({ tenantId: t.tenantId, orgId: t.orgId, title: 'Refs', sections: [{ type: 'richText', ref: { sharedSectionId: sh.sharedSectionId }, data: {} }], createdBy: t.ownerId });
    const s = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r', actingUserId: t.ownerId });
    await expect(s.cms!.updateSectionDraft!({ orgId: t.orgId, pageId: p.pageId, sectionId: p.sections[0]!.sectionId, data: { text: 'lost' } }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('a locale overlay is refused while `cms-localization` is OFF (CMS2WF-5)', async () => {
    const t = await team();
    const loc = getToggleDefault('cms-localization');
    await saveConfig({ ...loc!, status: 'off' }, 'test');
    try {
      const p = await createPage({ tenantId: t.tenantId, orgId: t.orgId, title: 'Loc', sections: hero('Hello'), createdBy: t.ownerId });
      const s = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r', actingUserId: t.ownerId });
      await expect(s.cms!.updateSectionDraft!({ orgId: t.orgId, pageId: p.pageId, sectionId: p.sections[0]!.sectionId, locale: 'es', data: { heading: 'Hola' } }))
        .rejects.toMatchObject({ code: 'host_capability_disabled' });
      // A base-data patch is not a translation: unaffected.
      await expect(s.cms!.updateSectionDraft!({ orgId: t.orgId, pageId: p.pageId, sectionId: p.sections[0]!.sectionId, data: { heading: 'Hi' } }))
        .resolves.toMatchObject({ updated: true });
    } finally {
      await saveConfig(loc!, 'test'); // the registered default (OFF today)
    }
  });
});

// ── D2 — authority is decided on the row that is written ────────────────────

describe('ADR 0836 D2 — authority is decided on the read updatePage swaps', () => {
  // The lane's shape: a caller checked "draft" on an EARLIER read, then a publish
  // landed (no `version` bump, so the pin cannot see it), then the write ran.
  // `authorize` must run on updatePage's own read, not be trusted from the past.
  it('a draft-only writer is refused once the page it checked was published', async () => {
    const p = await createPage({ tenantId: 't-auth836', orgId: 'o', title: 'P', sections: hero('Reviewed'), createdBy: 'admin' });
    const checkedVersion = p.version; // the caller's earlier read: a draft
    await transitionPage(p.tenantId, p.orgId, p.pageId, 'publish', 'admin'); // lands in the window
    const draftOnly = async (cur: Page): Promise<void> => {
      if (cur.status !== 'draft') throw Object.assign(new Error('not a draft'), { code: 'not_draft' });
    };
    await expect(updatePage(p.tenantId, p.orgId, p.pageId, { sections: hero('Editor text') }, 'editor', { expectedVersion: checkedVersion, authorize: draftOnly }))
      .rejects.toMatchObject({ code: 'not_draft' });
    const after = await getPage(p.tenantId, p.orgId, p.pageId);
    expect((after!.sections[0]!.data as { heading: string }).heading).toBe('Reviewed');
  });
});

// ── D3 — schedule pin, both tiers, over HTTP ────────────────────────────────

describe('ADR 0836 D3 — who keeps a scheduled publish', () => {
  it("an admin's edit re-pins and the sweep publishes the admin's new content", async () => {
    const t = await team();
    const r = await t.owner.post(cms(t.orgId, '/pages'), { title: 'Launch', sections: hero('v1') });
    const id = r.body!.pageId!;
    expect((await t.owner.post(cms(t.orgId, `/pages/${encodeURIComponent(id)}/schedule`), { at: later() })).status).toBe(200);
    const edit = await t.owner.patch(cms(t.orgId, `/pages/${encodeURIComponent(id)}`), { sections: hero('v2 typo fixed') });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body?.scheduledPublishAt).toBeTruthy();
    expect(edit.body?.scheduledPublishVersion).toBe(edit.body?.version);
    await processScheduledPublishes(Date.now() + 120_000);
    const live = await getPage(t.tenantId, t.orgId, id);
    expect(live?.status).toBe('published');
    expect((live!.sections[0]!.data as { heading: string }).heading).toBe('v2 typo fixed');
  });

  it("an editor's edit cancels it, in the response the editor sees", async () => {
    const t = await team();
    const r = await t.owner.post(cms(t.orgId, '/pages'), { title: 'Launch', sections: hero('v1') });
    const id = r.body!.pageId!;
    expect((await t.owner.post(cms(t.orgId, `/pages/${encodeURIComponent(id)}/schedule`), { at: later() })).status).toBe(200);
    const edit = await t.editor.patch(cms(t.orgId, `/pages/${encodeURIComponent(id)}`), { sections: hero('editor copy') });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body?.scheduledPublishAt).toBeUndefined();
    await processScheduledPublishes(Date.now() + 120_000);
    expect((await getPage(t.tenantId, t.orgId, id))?.status).toBe('draft');
  });

  it("a SCHEDULED draft's SEO is admin tier (its SEO row does not move the pinned version) [AR-H4]", async () => {
    const t = await team();
    const r = await t.owner.post(cms(t.orgId, '/pages'), { title: 'Launch', sections: hero('v1') });
    const id = r.body!.pageId!;
    expect((await t.editor.put(seo(t.orgId, id), { metaTitle: 'Editor may (unscheduled draft)' })).status).toBe(200);
    expect((await t.owner.post(cms(t.orgId, `/pages/${encodeURIComponent(id)}/schedule`), { at: later() })).status).toBe(200);
    const refused = await t.editor.put(seo(t.orgId, id), { canonicalUrl: 'https://elsewhere.example/' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body?.details?.reason).toBe('live_tier');
  });
});

// ── D4 — legacy markers drain without crossing tenants ──────────────────────

describe('ADR 0836 D4 — a pre-0836 marker (bare pageId key) [AR-H7]', () => {
  const legacy = new DurableCollection<{ pageId: string; tenantId: string; orgId: string; at: string }>('cms:scheduled', (m) => m.pageId);
  const modern = new DurableCollection<{ pageId: string; tenantId: string; orgId: string; at: string }>('cms:scheduled', (m) => `${encodeURIComponent(m.tenantId)}/${encodeURIComponent(m.pageId)}`);

  it("still fires for its tenant, and another tenant's clear of the same id cannot delete it", async () => {
    const id = `legacy-${n++}`;
    await createPage({ tenantId: 't-lgA', orgId: 'oA', title: 'A', pageId: id, sections: hero('A'), createdBy: 'ua' });
    await createPage({ tenantId: 't-lgB', orgId: 'oB', title: 'B', pageId: id, sections: hero('B'), createdBy: 'ub' });
    const a = await setScheduledPublish('t-lgA', 'oA', id, later(), 'ua');
    // Re-shape A's marker into the pre-ADR-0836 row a deployed instance holds.
    await modern.delete(`${encodeURIComponent('t-lgA')}/${encodeURIComponent(id)}`);
    await legacy.put({ pageId: id, tenantId: 't-lgA', orgId: 'oA', at: a!.scheduledPublishAt! });
    // Tenant B schedules and cancels a page with the same id.
    await setScheduledPublish('t-lgB', 'oB', id, later(), 'ub');
    await clearScheduledPublish('t-lgB', 'oB', id, 'ub');
    expect(await legacy.get(id)).toMatchObject({ tenantId: 't-lgA' });
    await processScheduledPublishes(Date.now() + 120_000);
    expect((await getPage('t-lgA', 'oA', id))?.status).toBe('published');
    expect((await getPage('t-lgB', 'oB', id))?.status).toBe('draft');
  });
});

// ── D8 — restore ────────────────────────────────────────────────────────────

describe('ADR 0836 D8 — restore', () => {
  it('a stale expectedVersion is a 409 and changes nothing', async () => {
    const p = await createPage({ tenantId: 't-rpin836', orgId: 'o', title: 'Doc', sections: hero('v1'), createdBy: 'u' });
    await transitionPage(p.tenantId, p.orgId, p.pageId, 'submit', 'u');
    const [v] = await listVersions(p.tenantId, p.orgId, p.pageId);
    await updatePage(p.tenantId, p.orgId, p.pageId, { sections: hero('newer edit') }, 'u');
    await expect(restoreVersion(p.tenantId, p.orgId, p.pageId, v!.versionId, 'u', undefined, { expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(((await getPage(p.tenantId, p.orgId, p.pageId))!.sections[0]!.data as { heading: string }).heading).toBe('newer edit');
  });

  it('an ungated experiment promote restores AND republishes without announcing `unpublished` [AR-H5]', async () => {
    const seen: CmsPageLifecycleChange[] = [];
    onCmsPageLifecycle('adr0836-promote', async (e) => { seen.push(e); });
    const p = await createPage({ tenantId: 't-prm836', orgId: 'o', title: 'Exp', sections: hero('control'), createdBy: 'u' });
    await transitionPage(p.tenantId, p.orgId, p.pageId, 'publish', 'u');
    const [v1] = await listVersions(p.tenantId, p.orgId, p.pageId);
    const exp = await createExperiment({ tenantId: p.tenantId, orgId: p.orgId, pageId: p.pageId, name: 'E', createdBy: 'u', variants: [{ key: 'a', weight: 50, versionId: null }, { key: 'b', weight: 50, versionId: v1!.versionId }] });
    await putExperimentRow(toEngineExperiment({ ...exp, status: 'running', startedAt: new Date().toISOString() }));
    await promoteExperiment(p.tenantId, p.orgId, p.pageId, exp.experimentId, 'b', 'u');
    expect((await getPage(p.tenantId, p.orgId, p.pageId))?.status).toBe('published');
    // Wait for the REPUBLISH to be announced (the initial publish + this one) before
    // asserting an absence; a fixed sleep let "nothing arrived yet" pass as "no unpublish".
    const events = (): string[] => seen.filter((e) => e.pageId === p.pageId).map((e) => e.event);
    await vi.waitFor(() => expect(events().filter((e) => e === 'published')).toHaveLength(2));
    expect(events()).not.toContain('unpublished');
  });

  it('a promote whose winner carries a [TODO] is refused BEFORE the live page is touched [AR-H5]', async () => {
    const p = await createPage({ tenantId: 't-prmb836', orgId: 'o', title: 'Exp', sections: hero('control'), createdBy: 'u' });
    await transitionPage(p.tenantId, p.orgId, p.pageId, 'publish', 'u');
    // A capture made before ADR 0836, when nothing stopped a `[TODO]` reaching a
    // submit/publish snapshot: re-shape the real publish row into one.
    const [v1] = await listVersions(p.tenantId, p.orgId, p.pageId);
    const versions = new DurableCollection<typeof v1>('cms:pageversion', (v) => v!.versionId);
    const old = { ...v1!, versionId: `pver:legacy-${n++}`, snapshot: { ...v1!.snapshot, sections: [{ ...v1!.snapshot.sections[0]!, data: { heading: '[TODO: write this]' } }] } };
    await versions.put(old);
    const exp = await createExperiment({ tenantId: p.tenantId, orgId: p.orgId, pageId: p.pageId, name: 'E', createdBy: 'u', variants: [{ key: 'a', weight: 50, versionId: null }, { key: 'b', weight: 50, versionId: old.versionId }] });
    await putExperimentRow(toEngineExperiment({ ...exp, status: 'running', startedAt: new Date().toISOString() }));
    await expect(promoteExperiment(p.tenantId, p.orgId, p.pageId, exp.experimentId, 'b', 'u'))
      .rejects.toMatchObject({ details: { reason: 'publish_blocked' } });
    expect((await getPage(p.tenantId, p.orgId, p.pageId))?.status).toBe('published');
  });
});

// ── D9 — blockers: every lane, and the seeds still publish ──────────────────

describe('ADR 0836 D9 — publish blockers', () => {
  it('submit stays open (ADR 0828: a reviewer can help finish the page); the approve is what refuses', async () => {
    const p = await createPage({ tenantId: 't-sub836', orgId: 'o', title: 'P', sections: [{ type: 'richText', data: { heading: 'H', text: '[todo: finish]' } }], createdBy: 'u' });
    await expect(transitionPage(p.tenantId, p.orgId, p.pageId, 'submit', 'u')).resolves.toMatchObject({ status: 'in_review' });
    await expect(transitionPage(p.tenantId, p.orgId, p.pageId, 'approve', 'admin')).rejects.toMatchObject({ details: { reason: 'publish_blocked' } });
    expect((await getPage(p.tenantId, p.orgId, p.pageId))?.status).toBe('in_review');
  });

  it('an in-place edit of a PUBLISHED page meets them [AR-H6]', async () => {
    const p = await createPage({ tenantId: 't-inpl836', orgId: 'o', title: 'P', sections: hero('Live'), createdBy: 'u' });
    await transitionPage(p.tenantId, p.orgId, p.pageId, 'publish', 'u');
    await expect(updatePage(p.tenantId, p.orgId, p.pageId, { sections: hero('[TODO: later]') }, 'admin'))
      .rejects.toMatchObject({ details: { reason: 'publish_blocked' } });
  });

  it('a shared-section ref and a translation overlay are not checked (browser parity)', () => {
    expect(publishBlockers({ sections: [
      { sectionId: 's1', type: 'richText', data: {}, ref: { sharedSectionId: 'shsec:x' } },
      { sectionId: 's2', type: 'hero', data: { heading: 'ok' }, localizations: { es: { heading: '[TODO es]' } } },
    ] })).toEqual([]);
  });

  it('every boot-published system seed is blocker-free (a seed 422 would take `/` down)', async () => {
    await ensureSystemSite();
    await Promise.all([ensureFeaturesPage(), ensureComparisonPage(), ensureMarketingContentPages(), ensureMarketingLegalPages(), ensureSystemSiteDocs(), ensureSystemSiteBlog()]);
    const pages = await listPages(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG);
    const published = pages.filter((x) => x.status === 'published');
    expect(published.length).toBeGreaterThan(3);
    for (const pg of published) expect(publishBlockers(pg), pg.slug).toEqual([]);
    // The one seed that holds markers is never auto-published — and the check
    // sees its markers (a predicate that found nothing would pass the loop above).
    const blog = pages.find((x) => x.pageId === LAUNCH_POST_PAGE_ID);
    expect(blog?.status).not.toBe('published');
    expect(publishBlockers(blog!).length).toBeGreaterThan(0);
  });
});
