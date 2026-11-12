/**
 * ADR 1057 D3/D4 — the docs→KB lockstep reconciles to the page's CURRENT state,
 * and a docs chunk's source carries the public `/docs` URL.
 *
 * Each case seeds its own org (so its own managed docs collection) and passes
 * alone and in any order. `transitionPage` fires the lifecycle fire-and-forget,
 * so the waits poll (vi.waitFor, 25 ms, 2 s cap), as `docs-kb-sync.test.ts` does.
 *
 * Red on `origin/main` `f2ad700ab` (witnessed before the fix, ADR 1057 § Phases):
 *   - DOCSWF-3: a stale `published` event for a page that is now a draft
 *     re-indexed it (the handler trusted the event and upserted `getPage`);
 *   - DOCSWF-4: with the toggle OFF, unpublishing left the KB doc in place, and it
 *     became citable again the moment docs was re-enabled (removal sat behind the
 *     toggle gate). The read is taken AFTER re-enabling: while the toggle is off the
 *     managed collection is invisible, so a read then passes on the broken code
 *     (the first draft of this case did exactly that);
 *   - M4: a stale `unpublished` event evicted a page that is published again;
 *   - DOCSWF-5: retrieval sources had no `url`;
 *   - DOCSWF-7: the indexed text carried no `##` heading line;
 *   - DOCSWF-8: a shared section's text never reached the KB;
 *   - H3: `sourceUrl` was not a privileged field, so a body could set it.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createPage, createSharedSection, transitionPage, updatePage, type Page } from '../src/features/cms/cmsService.js';
import { createCollection, getDocument, ingestDocument, tenantRetrieve } from '../src/features/kb/kbService.js';
import { syncDocsPage, docsCollectionIdFor } from '../src/features/docs/docsKnowledgeService.js';

let server: http.Server;
const TENANT = 'org:docs-1057';
let n = 0;
const freshOrg = (): string => `org-docs-1057-${n++}`;
const SITE_ORG = 'org-docs-1057-site';

async function setDocsToggle(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('docs');
  expect(d, 'docs toggle must be declared').toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
}

const prevSiteOrg = process.env.OPENWOP_PUBLIC_SITE_ORG_ID;
const prevBase = process.env.OPENWOP_PUBLIC_BASE_URL;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_PUBLIC_SITE_ORG_ID = SITE_ORG;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  await setDocsToggle('on');
});
afterAll(async () => {
  if (prevSiteOrg === undefined) delete process.env.OPENWOP_PUBLIC_SITE_ORG_ID; else process.env.OPENWOP_PUBLIC_SITE_ORG_ID = prevSiteOrg;
  if (prevBase === undefined) delete process.env.OPENWOP_PUBLIC_BASE_URL; else process.env.OPENWOP_PUBLIC_BASE_URL = prevBase;
  await new Promise<void>((res) => server.close(() => res()));
});

const docIn = (org: string, pageId: string) => getDocument(TENANT, org, docsCollectionIdFor(org), pageId);

async function publishedDocsPage(org: string, slug: string, heading: string, text = `About ${heading}.`): Promise<Page> {
  const page = await createPage({ tenantId: TENANT, orgId: org, title: heading, slug, collection: 'docs', sections: [{ type: 'richText', data: { heading, text } }], createdBy: 'u1' });
  const published = await transitionPage(TENANT, org, page.pageId, 'publish', 'u1');
  await vi.waitFor(async () => { expect(await docIn(org, page.pageId)).not.toBeNull(); }, { timeout: 2_000, interval: 25 });
  return published!;
}

const evt = (org: string, p: Page, event: 'published' | 'unpublished') =>
  ({ tenantId: TENANT, orgId: org, pageId: p.pageId, slug: p.slug, title: p.title, collection: 'docs' as const, event });

describe('D3 — reconcile to the page, not to the event', () => {
  it('a stale `published` event for a page that is now a draft does not re-index it (DOCSWF-3)', async () => {
    const org = freshOrg();
    const page = await publishedDocsPage(org, 'stale-pub', 'Stale Publish');
    await transitionPage(TENANT, org, page.pageId, 'unpublish', 'u1');
    await vi.waitFor(async () => { expect(await docIn(org, page.pageId)).toBeNull(); }, { timeout: 2_000, interval: 25 });
    // The publish handler that lost the race arrives last.
    await syncDocsPage(evt(org, page, 'published'));
    expect(await docIn(org, page.pageId), 'a draft must never be citable').toBeNull();
  });

  it('a stale `unpublished` event does not evict a page that is published again (M4)', async () => {
    const org = freshOrg();
    const page = await publishedDocsPage(org, 'stale-unpub', 'Still Live');
    await syncDocsPage(evt(org, page, 'unpublished'));
    expect(await docIn(org, page.pageId), 'a published docs page must stay in the KB').not.toBeNull();
  });

  it('with the docs toggle OFF, unpublishing still removes the KB doc (DOCSWF-4)', async () => {
    const org = freshOrg();
    const page = await publishedDocsPage(org, 'toggle-off', 'Withdrawn');
    await setDocsToggle('off');
    try {
      await transitionPage(TENANT, org, page.pageId, 'unpublish', 'u1');
      // Settle the fire-and-forget lifecycle deterministically: reconciles for one page
      // run one at a time, so an awaited sync completes only after the queued one.
      // While the toggle is OFF the managed collection is invisible
      // (`managedPlanAllows`), so a read here would pass on the broken code too; the
      // doc has to be checked once the toggle is back ON.
      await syncDocsPage(evt(org, page, 'unpublished'));
    } finally {
      await setDocsToggle('on');
    }
    expect(await docIn(org, page.pageId), 'removal is never toggle-gated: re-enabling docs must not resurrect a withdrawn page').toBeNull();
  });

  it('with the docs toggle OFF, editing a still-published page does not evict it (grade-code finding 2)', async () => {
    const org = freshOrg();
    const page = await publishedDocsPage(org, 'kept-live', 'Kept Live');
    await setDocsToggle('off');
    try {
      await updatePage(TENANT, org, page.pageId, { sections: [{ type: 'richText', data: { heading: 'Kept Live', text: 'Edited while docs was off.' } }] }, 'admin');
      await syncDocsPage(evt(org, page, 'published')); // queued behind the lifecycle's own reconcile
    } finally {
      await setDocsToggle('on');
    }
    const doc = await docIn(org, page.pageId);
    expect(doc, 'a live page must survive a toggle-off edit').not.toBeNull();
    // PA-2: pin the doc UNCHANGED, so a late lifecycle reconcile (one that starts
    // after the toggle is back on) cannot make the broken code pass by re-indexing.
    expect(doc?.text).toContain('About Kept Live.');
    expect(doc?.text).not.toContain('Edited while docs was off.');
  });

  it('with the docs toggle OFF, a published page is still not indexed', async () => {
    const org = freshOrg();
    await setDocsToggle('off');
    try {
      const page = await createPage({ tenantId: TENANT, orgId: org, title: 'Gated', slug: 'gated', collection: 'docs', sections: [{ type: 'richText', data: { heading: 'Gated', text: 'x' } }], createdBy: 'u1' });
      await transitionPage(TENANT, org, page.pageId, 'publish', 'u1');
      await syncDocsPage(evt(org, page, 'published'));
      expect(await docIn(org, page.pageId)).toBeNull();
    } finally {
      await setDocsToggle('on');
    }
  });
});

describe('D4 — what the chat is handed', () => {
  it('a site-org docs source carries its public /docs URL; a slug rename moves it (DOCSWF-5)', async () => {
    const page = await publishedDocsPage(SITE_ORG, 'linkable-guide', 'Linkable Guide', 'Zebrafinch configuration explained.');
    const hit = await tenantRetrieve(TENANT, { query: 'zebrafinch configuration', collectionIds: [docsCollectionIdFor(SITE_ORG)], resultLimit: 5 });
    const src = hit?.sources.find((s) => s.assetId === page.pageId) as { url?: string } | undefined;
    expect(src, 'the docs page must be retrievable').toBeTruthy();
    expect(src?.url).toBe('/docs/linkable-guide');

    await updatePage(TENANT, SITE_ORG, page.pageId, { slug: 'renamed-guide' }, 'admin');
    await vi.waitFor(async () => {
      const again = await tenantRetrieve(TENANT, { query: 'zebrafinch configuration', collectionIds: [docsCollectionIdFor(SITE_ORG)], resultLimit: 5 });
      expect((again?.sources.find((s) => s.assetId === page.pageId) as { url?: string } | undefined)?.url).toBe('/docs/renamed-guide');
    }, { timeout: 2_000, interval: 25 });
  });

  it('a docs page outside the site org gets no URL (no JSON endpoint posing as a page, H4)', async () => {
    const org = freshOrg();
    const page = await publishedDocsPage(org, 'tenant-guide', 'Tenant Guide', 'Quokka onboarding steps.');
    const hit = await tenantRetrieve(TENANT, { query: 'quokka onboarding', collectionIds: [docsCollectionIdFor(org)], resultLimit: 5 });
    const src = hit?.sources.find((s) => s.assetId === page.pageId) as { url?: string } | undefined;
    expect(src).toBeTruthy();
    expect(src?.url).toBeUndefined();
  });

  it('each section heading reaches the KB as a markdown heading, once (DOCSWF-7)', async () => {
    const org = freshOrg();
    const page = await publishedDocsPage(org, 'headed', 'Headed', 'Body under the heading.');
    const text = (await docIn(org, page.pageId))?.text ?? '';
    expect(text).toContain('## Headed\n\nBody under the heading.');
    expect(text.split('Headed').length - 1, 'the heading must not also appear as a bare string').toBe(2); // title + heading line
  });

  it('a shared section is indexed as readers see it (DOCSWF-8)', async () => {
    const org = freshOrg();
    const shared = await createSharedSection(TENANT, org, { name: 'Notice', type: 'richText', data: { heading: 'Shared notice', text: 'Platypus maintenance window.' } }, 'u1');
    const page = await createPage({ tenantId: TENANT, orgId: org, title: 'With Shared', slug: 'with-shared', collection: 'docs', sections: [{ type: 'richText', data: { heading: 'Own', text: 'Own text.' } }, { type: 'richText', ref: { sharedSectionId: shared.sharedSectionId } } as never], createdBy: 'u1' });
    await transitionPage(TENANT, org, page.pageId, 'publish', 'u1');
    await vi.waitFor(async () => { expect((await docIn(org, page.pageId))?.text).toContain('Platypus maintenance window.'); }, { timeout: 2_000, interval: 25 });
  });

  it('`sourceUrl` is a privileged field: a request-shaped ingest cannot set it (H3)', async () => {
    const org = freshOrg();
    // A plain (unmanaged) collection, so only the privileged-field guard can refuse.
    const col = await createCollection(TENANT, org, 'u1', { name: 'Plain' });
    await expect(ingestDocument(TENANT, org, 'u1', col.collectionId, { title: 'x', text: 'y', sourceUrl: 'https://evil.example/' } as never))
      .rejects.toThrow(/sourceUrl/);
  });
});
