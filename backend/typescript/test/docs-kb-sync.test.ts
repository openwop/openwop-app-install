/**
 * Docs → KB sync (ADR 0392 Phase 2) — the publish→upsert / unpublish→delete
 * lockstep + republish idempotency (content-hash no-op) + toggle gating +
 * deterministic flattenSections. Exercises the lifecycle handler directly
 * (the CMS fire is async fire-and-forget).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createPage, transitionPage, type Page } from '../src/features/cms/cmsService.js';
import { listDocuments, getDocument } from '../src/features/kb/kbService.js';
import { syncDocsPage, flattenSections, docsCollectionIdFor } from '../src/features/docs/docsKnowledgeService.js';

let server: http.Server;
const TENANT = 'org:docs-kb';
const ORG = 'org-docs-kb';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const d = getToggleDefault('docs');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function publishedDocsPage(slug: string, heading: string): Promise<Page> {
  const page = await createPage({ tenantId: TENANT, orgId: ORG, title: heading, slug, collection: 'docs', sections: [{ type: 'hero', data: { heading, body: `About ${heading}.` } }] as unknown, createdBy: 'u1' });
  const published = await transitionPage(TENANT, ORG, page.pageId, 'publish', 'u1');
  return published!;
}

const coll = docsCollectionIdFor(ORG);

describe('flattenSections — deterministic extraction', () => {
  it('produces stable text from the same sections (key-sorted, order-stable)', () => {
    const page = { title: 'T', sections: [{ sectionId: 's1', type: 'hero', data: { body: 'B', heading: 'H' } }] } as unknown as Page;
    const a = flattenSections(page);
    const b = flattenSections(page);
    expect(a).toBe(b);
    expect(a).toContain('T');
    expect(a).toContain('H');
    expect(a).toContain('B');
  });
});

describe('publish→upsert / republish no-op / unpublish→delete', () => {
  it('publishing a docs page upserts it under the stable page id', async () => {
    const page = await publishedDocsPage('kb-a', 'Getting Started');
    await syncDocsPage({ tenantId: TENANT, orgId: ORG, pageId: page.pageId, slug: page.slug, title: page.title, collection: 'docs', event: 'published' });
    const doc = await getDocument(TENANT, ORG, coll, page.pageId);
    expect(doc?.title).toBe('Getting Started');
    expect((await listDocuments(TENANT, ORG, coll)).length).toBe(1);
  });

  it('republishing an unchanged page does not create a second revision (content-hash guard)', async () => {
    const page = await publishedDocsPage('kb-b', 'Stable Doc');
    const e = { tenantId: TENANT, orgId: ORG, pageId: page.pageId, slug: page.slug, title: page.title, collection: 'docs' as const, event: 'published' as const };
    await syncDocsPage(e);
    const first = await getDocument(TENANT, ORG, coll, page.pageId);
    await syncDocsPage(e);
    const second = await getDocument(TENANT, ORG, coll, page.pageId);
    expect(second?.revision).toBe(first?.revision); // no-op re-index
  });

  it('unpublishing deletes the doc so the chat never cites a non-public page', async () => {
    const page = await publishedDocsPage('kb-c', 'To Remove');
    await syncDocsPage({ tenantId: TENANT, orgId: ORG, pageId: page.pageId, slug: page.slug, title: page.title, collection: 'docs', event: 'published' });
    expect(await getDocument(TENANT, ORG, coll, page.pageId)).toBeTruthy();
    await syncDocsPage({ tenantId: TENANT, orgId: ORG, pageId: page.pageId, slug: page.slug, title: page.title, collection: 'docs', event: 'unpublished' });
    expect(await getDocument(TENANT, ORG, coll, page.pageId)).toBeNull();
  });

  it('a non-docs page is ignored (CMS stays ignorant of docs)', async () => {
    await syncDocsPage({ tenantId: TENANT, orgId: ORG, pageId: 'page:marketing', slug: 'mk', title: 'Marketing', event: 'published' });
    expect((await listDocuments(TENANT, ORG, coll)).every((d) => d.documentId !== 'page:marketing')).toBe(true);
  });

  it('the sync is a no-op when the docs toggle is OFF for the tenant', async () => {
    const d = getToggleDefault('docs');
    if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      const page = await publishedDocsPage('kb-off', 'Gated');
      await syncDocsPage({ tenantId: TENANT, orgId: ORG, pageId: page.pageId, slug: page.slug, title: page.title, collection: 'docs', event: 'published' });
      expect(await getDocument(TENANT, ORG, coll, page.pageId)).toBeNull();
    } finally {
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});

describe('grade-pass D1/D2/D7 — the REAL lifecycle wiring (not direct handler calls)', () => {
  const waitFor = async (check: () => Promise<boolean>, ms = 2000): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return check();
  };

  it('publish → (fire-and-forget lifecycle) → KB doc appears; DELETE removes it (D1)', async () => {
    const page = await createPage({ tenantId: TENANT, orgId: ORG, title: 'Wired Doc', slug: 'wired', collection: 'docs', sections: [{ type: 'richText', data: { heading: 'Wired', text: 'Body' } }] as unknown, createdBy: 'u1' });
    await transitionPage(TENANT, ORG, page.pageId, 'publish', 'u1');
    expect(await waitFor(async () => (await getDocument(TENANT, ORG, coll, page.pageId)) !== null), 'publish wiring must sync the KB').toBe(true);

    const { deletePage } = await import('../src/features/cms/cmsService.js');
    await deletePage(TENANT, ORG, page.pageId);
    expect(await waitFor(async () => (await getDocument(TENANT, ORG, coll, page.pageId)) === null), 'delete must drop the KB doc (no orphan)').toBe(true);
  });

  it('an in-place edit of a PUBLISHED docs page re-syncs the KB text (D2)', async () => {
    const page = await createPage({ tenantId: TENANT, orgId: ORG, title: 'Editable', slug: 'editable', collection: 'docs', sections: [{ type: 'richText', data: { heading: 'Editable', text: 'Original text' } }] as unknown, createdBy: 'u1' });
    await transitionPage(TENANT, ORG, page.pageId, 'publish', 'u1');
    await waitFor(async () => (await getDocument(TENANT, ORG, coll, page.pageId)) !== null);

    const { updatePage } = await import('../src/features/cms/cmsService.js');
    await updatePage(TENANT, ORG, page.pageId, { sections: [{ type: 'richText', data: { heading: 'Editable', text: 'Rewritten text' } }] }, 'admin');
    expect(await waitFor(async () => {
      const doc = await getDocument(TENANT, ORG, coll, page.pageId);
      return doc?.text?.includes('Rewritten text') ?? false;
    }), 'published in-place edit must re-sync the KB').toBe(true);
  });
});

describe('grade-pass D4 — backfillDocsKb reconciles both directions', () => {
  it('indexes missed published pages and removes stranded KB docs; idempotent', async () => {
    const { backfillDocsKb } = await import('../src/features/docs/docsKnowledgeService.js');
    const { upsertDocument } = await import('../src/features/kb/kbService.js');
    // a published docs page whose sync was MISSED (created without firing the handler path)
    const missed = await createPage({ tenantId: TENANT, orgId: ORG, title: 'Missed', slug: 'missed', collection: 'docs', sections: [{ type: 'richText', data: { heading: 'Missed', text: 'M' } }] as unknown, createdBy: 'u1' });
    await transitionPage(TENANT, ORG, missed.pageId, 'publish', 'u1');
    // a stranded KB doc whose page never existed (pre-D1 orphan shape)
    await upsertDocument(TENANT, ORG, coll, 'page:ghost', 'test', { title: 'Ghost', text: 'stale', contentTrust: 'trusted' });

    const first = await backfillDocsKb(TENANT, ORG);
    expect(first.pages).toBeGreaterThan(0);
    expect(first.removedOrphans).toBeGreaterThanOrEqual(1);
    expect(await getDocument(TENANT, ORG, coll, missed.pageId)).toBeTruthy(); // missed page indexed
    expect(await getDocument(TENANT, ORG, coll, 'page:ghost')).toBeNull(); // orphan healed

    const second = await backfillDocsKb(TENANT, ORG);
    expect(second.removedOrphans).toBe(0); // idempotent — nothing left to heal
  });
});
