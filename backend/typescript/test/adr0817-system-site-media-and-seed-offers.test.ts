/**
 * ADR 0817 — the public site gets a Media library, and a code seed offers its
 * updates instead of going silent once a person has edited the page:
 *  - the media routes admit a super admin on the reserved system-site org (the
 *    CMS guard), list the seeded diagrams, and accept an upload; a normal user
 *    gets the same 404 the CMS routes give;
 *  - a seed bump on a human-edited post records a `'seed'` version and leaves
 *    the page alone; a re-run does not record the same offer twice;
 *  - Restore adopts the offer into the draft;
 *  - a seed offer is not a capture: submit still snapshots the page, and an
 *    experiment variant cannot point at the offer.
 *
 * Reds if: the media routes stop using the CMS guard (`requireCmsScope`) or it
 * stops checking `isSuperadmin`; the seed overwrites an edited post or drops
 * the offer; the offer skips `validateSections` or is recorded twice; the
 * `origin !== 'seed'` filter leaves `snapshotPage` (submit then dedupes against
 * the offer and captures nothing); an experiment variant may point at an offer;
 * Restore stops copying the offer's title.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '../src/features/cms/cmsService.js';
import { createApp } from '../src/index.js';
import { ensureSystemSiteBlog, __resetSystemSiteBlogEnsure, LAUNCH_POST_PAGE_ID } from '../src/host/systemSiteBlog.js';
import { getPage, listVersions, restoreVersion, transitionPage, updatePage } from '../src/features/cms/cmsService.js';
import { createExperiment } from '../src/features/cms/pageExperimentsService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from '../src/host/systemSite.js';
import { getSetCookies } from './headerCookies.js';

let BASE: string;
let server: http.Server;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
// One transparent pixel.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS; // only the wildcard bearer is superadmin
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await ensureSystemSiteBlog();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const MEDIA = `/host/openwop-app/media/orgs/${SYSTEM_SITE_ORG}`;
const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

async function normalClient(): Promise<(method: string, path: string, body?: unknown) => Promise<Response>> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return res;
  };
  expect((await call('POST', '/host/openwop-app/test/login', { email: `m0815-${Date.now()}@x.test` })).status).toBe(201);
  return call;
}


/** ADR 0836 D9 — the seed's `[TODO …]` markers are publish blockers now (the
 *  server half of the editor checklist). These tests are about what happens
 *  AFTER the author finishes the post, so finish it first. */
async function finishTodos(): Promise<void> {
  const p = (await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID))!;
  const scrub = (v: unknown): unknown => typeof v === 'string' ? v.replace(/`?\[TODO[^\]]*\]`?/gi, '') : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;
  await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID, { sections: p.sections.map((s) => ({ ...s, data: scrub(s.data) as Record<string, unknown> })) }, 'user:author');
}

describe('ADR 0817 — the public site has a Media library', () => {
  it('a super admin lists the seeded diagrams and uploads an image', async () => {
    const list = await admin('GET', `${MEDIA}/assets`);
    expect(list.status).toBe(200);
    const { assets } = (await list.json()) as { assets: Array<{ name: string }> };
    expect(assets.map((a) => a.name)).toContain('Blog: the real multi-person, multi-agent model.png');
    const up = await admin('POST', `${MEDIA}/assets`, { name: 'diagram-v2.png', contentType: 'image/png', contentBase64: PNG_1PX });
    expect(up.status, await up.clone().text()).toBe(201);
    const asset = (await up.json()) as { serveToken?: string };
    expect(asset.serveToken).toBeTruthy();
  });

  it('hides the system site\'s library from a normal user (404, as the CMS routes do)', async () => {
    const call = await normalClient();
    // The guard's own 404 envelope — a missing route would 404 too, with another body.
    for (const res of [
      await call('GET', `${MEDIA}/assets`),
      await call('POST', `${MEDIA}/assets`, { name: 'x.png', contentType: 'image/png', contentBase64: PNG_1PX }),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found', details: { orgId: SYSTEM_SITE_ORG } });
    }
  });
});

/** Re-run the seed as if SEED_VERSION had been bumped since the last boot. */
async function rerunSeedAsBumped(): Promise<void> {
  await new DurableCollection<{ id: string; version: number }>('systemsite:blog-seed', (r) => r.id).put({ id: 'seed', version: 0 });
  __resetSystemSiteBlogEnsure();
  await ensureSystemSiteBlog();
}
const seedOffers = async () => (await listVersions(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID)).filter((v) => v.origin === 'seed');

describe('ADR 0817 — a seed update after a human edit is offered, not dropped', () => {
  // Shared setup: the author finishes the post, edits it, THEN the seed is bumped.
  // Finishing the TODOs BEFORE the offer keeps the offer's `version` equal to the
  // page's at submit — which is what makes the capture filter load-bearing below.
  let before: Page;
  beforeAll(async () => {
    await finishTodos();
    before = (await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID))!;
    await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID, { title: 'My edited title' }, 'user:author');
    await rerunSeedAsBumped();
  });

  it('records a seed version and leaves the edited post alone', async () => {
    const after = (await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID))!;
    expect(after.title).toBe('My edited title');
    expect(after.updatedBy).toBe('user:author');
    const offers = await seedOffers();
    expect(offers).toHaveLength(1);
    expect(offers[0]!.snapshot.title).toBe('10x Your Company = Your Team + AI Agents');
    // Validated like any page write: minted ids, the seed's content.
    expect(offers[0]!.snapshot.sections.every((s) => s.sectionId.startsWith('sec:'))).toBe(true);
    expect(offers[0]!.snapshot.sections.map((s) => s.type)).toEqual(before.sections.map((s) => s.type));
  });

  it('does not record the same offer twice', async () => {
    await rerunSeedAsBumped();
    expect(await seedOffers()).toHaveLength(1);
  });

  it('is not a capture: submit still snapshots the page', async () => {
    const page = (await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID))!;
    const [offer] = await seedOffers();
    expect(offer!.version, 'precondition: the offer shares the page version, so only the filter separates them').toBe(page.version);
    await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID, 'submit', 'user:author');
    const captures = (await listVersions(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID)).filter((v) => v.origin !== 'seed');
    expect(captures.some((v) => v.version === page.version && v.snapshot.title === page.title)).toBe(true);
  });

  it('cannot be an experiment variant', async () => {
    const [offer] = await seedOffers();
    await expect(createExperiment({
      tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId: LAUNCH_POST_PAGE_ID, name: 'x', createdBy: 'user:author',
      variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'seeded', versionId: offer!.versionId, weight: 50 }],
    })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'seed_offer' } });
  });

  // Mutates the page (title + version) — deliberately the last case.
  it('Restore adopts the offer into the draft', async () => {
    const [offer] = await seedOffers();
    const restored = await restoreVersion(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, LAUNCH_POST_PAGE_ID, offer!.versionId, 'user:author');
    expect(restored?.title).toBe('10x Your Company = Your Team + AI Agents');
    expect(restored?.status).toBe('draft');
  });
});
