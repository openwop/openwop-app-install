/**
 * Docs → KB sync (ADR 0392 Phase 2) — the publish→upsert / unpublish→delete
 * lockstep + republish idempotency (content-hash no-op) + toggle gating +
 * deterministic flattenSections + the real lifecycle wiring + the backfill.
 * TST-CWC-1.
 *
 * Every case seeds its OWN org (so its own managed docs collection) — no case
 * reads another's documents, so the file passes alone and in any order.
 * `transitionPage` fires the lifecycle fire-and-forget; the helpers wait for that
 * sync to land before a case acts, so an explicit sync never races it. There is
 * no drain seam on `host/cmsPageLifecycle.ts`, so those waits poll (vi.waitFor,
 * 25 ms, 2 s cap) — an honest ceiling, not a fixed sleep.
 *
 * Red when (sabotage-witnessed, wave 69): the `collection !== 'docs'` filter is
 * removed (a REAL published site page then lands in the docs collection); the
 * docs toggle gate is removed; unpublish/delete no longer delete the KB doc; the
 * KB content-hash guard stops no-op'ing an unchanged republish; the lifecycle
 * registration, the in-place-edit fire (D2) or the delete fire (D1) is dropped;
 * flattenSections stops key-sorting (the fixture's insertion order is NOT
 * sorted); the backfill skips its upsert loop or its orphan delete.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createPage, transitionPage, updatePage, deletePage, type Page } from '../src/features/cms/cmsService.js';
import { listDocuments, getDocument, deleteDocument, upsertDocument } from '../src/features/kb/kbService.js';
import { syncDocsPage, flattenSections, docsCollectionIdFor, backfillDocsKb } from '../src/features/docs/docsKnowledgeService.js';

let server: http.Server;
const TENANT = 'org:docs-kb';
let n = 0;
/** A fresh org per case ⇒ a fresh managed docs collection per case. */
const freshOrg = (): string => `org-docs-kb-${n++}`;

async function setDocsToggle(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('docs');
  expect(d, 'docs toggle must be declared').toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  await setDocsToggle('on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const docIn = (org: string, pageId: string) => getDocument(TENANT, org, docsCollectionIdFor(org), pageId);

/** Create + publish a docs page, then wait for the lifecycle's own sync to land. */
async function publishedDocsPage(org: string, slug: string, heading: string): Promise<Page> {
  const page = await createPage({ tenantId: TENANT, orgId: org, title: heading, slug, collection: 'docs', sections: [{ type: 'hero', data: { heading, body: `About ${heading}.` } }], createdBy: 'u1' });
  const published = await transitionPage(TENANT, org, page.pageId, 'publish', 'u1');
  await vi.waitFor(async () => { expect(await docIn(org, page.pageId)).not.toBeNull(); }, { timeout: 2_000, interval: 25 });
  return published!;
}

describe('flattenSections — deterministic extraction', () => {
  it('produces stable text from the same sections (key-sorted, order-stable)', async () => {
    const org = freshOrg();
    const page = await createPage({ tenantId: TENANT, orgId: org, title: 'T', slug: 'flat', sections: [{ type: 'hero', data: { heading: 'H' } }], createdBy: 'u1' });
    // Insertion order heading → body is NOT sorted order: only a key sort puts B first.
    const fixture: Page = { ...page, sections: [{ ...page.sections[0]!, data: { heading: 'H', body: 'B' } }] };
    expect(flattenSections(fixture)).toBe('T\n\nB\n\nH');
  });
});

describe('publish→upsert / republish no-op / unpublish→delete', () => {
  it('publishing a docs page upserts it under the stable page id', async () => {
    const org = freshOrg();
    const page = await publishedDocsPage(org, 'kb-a', 'Getting Started');
    await syncDocsPage({ tenantId: TENANT, orgId: org, pageId: page.pageId, slug: page.slug, title: page.title, collection: 'docs', event: 'published' });
    expect((await docIn(org, page.pageId))?.title).toBe('Getting Started');
    // Exactly one document, keyed by the page id (never a duplicate per sync).
    expect((await listDocuments(TENANT, org, docsCollectionIdFor(org))).map((d) => d.documentId)).toEqual([page.pageId]);
  });

  it('republishing an unchanged page does not create a second revision (content-hash guard)', async () => {
    const org = freshOrg();
    const page = await publishedDocsPage(org, 'kb-b', 'Stable Doc');
    const e = { tenantId: TENANT, orgId: org, pageId: page.pageId, slug: page.slug, title: page.title, collection: 'docs' as const, event: 'published' as const };
    const first = await docIn(org, page.pageId);
    await syncDocsPage(e);
    await syncDocsPage(e);
    const second = await docIn(org, page.pageId);
    expect(first).not.toBeNull();
    // A first write carries no stored revision (it reads back as 1); a replace bumps it.
    expect(second?.revision ?? 1).toBe(first?.revision ?? 1); // no-op re-index
  });

  it('unpublishing deletes the doc so the chat never cites a non-public page', async () => {
    const org = freshOrg();
    const page = await publishedDocsPage(org, 'kb-c', 'To Remove');
    await syncDocsPage({ tenantId: TENANT, orgId: org, pageId: page.pageId, slug: page.slug, title: page.title, collection: 'docs', event: 'unpublished' });
    expect(await docIn(org, page.pageId)).toBeNull();
  });

  it('a non-docs page is ignored (CMS stays ignorant of docs)', async () => {
    const org = freshOrg();
    // A REAL published SITE page — so only the collection filter can keep it out
    // (a missing page would be dropped by the later getPage() read instead).
    const page = await createPage({ tenantId: TENANT, orgId: org, title: 'Marketing', slug: 'mk', sections: [{ type: 'hero', data: { heading: 'Plans' } }], createdBy: 'u1' });
    await transitionPage(TENANT, org, page.pageId, 'publish', 'u1');
    await syncDocsPage({ tenantId: TENANT, orgId: org, pageId: page.pageId, slug: page.slug, title: page.title, event: 'published' });
    expect(await docIn(org, page.pageId)).toBeNull();
    // The sync never even created this org's managed docs collection.
    await expect(listDocuments(TENANT, org, docsCollectionIdFor(org))).rejects.toThrow('Collection not found.');
  });

  it('the sync is a no-op when the docs toggle is OFF for the tenant', async () => {
    const org = freshOrg();
    await setDocsToggle('off');
    try {
      const page = await createPage({ tenantId: TENANT, orgId: org, title: 'Gated', slug: 'kb-off', collection: 'docs', sections: [{ type: 'hero', data: { heading: 'Gated' } }], createdBy: 'u1' });
      await transitionPage(TENANT, org, page.pageId, 'publish', 'u1');
      await syncDocsPage({ tenantId: TENANT, orgId: org, pageId: page.pageId, slug: page.slug, title: page.title, collection: 'docs', event: 'published' });
      expect(await docIn(org, page.pageId)).toBeNull();
    } finally {
      await setDocsToggle('on');
    }
  });
});

describe('grade-pass D1/D2/D7 — the REAL lifecycle wiring (not direct handler calls)', () => {
  it('publish → (fire-and-forget lifecycle) → KB doc appears; DELETE removes it (D1)', async () => {
    const org = freshOrg();
    const page = await createPage({ tenantId: TENANT, orgId: org, title: 'Wired Doc', slug: 'wired', collection: 'docs', sections: [{ type: 'richText', data: { heading: 'Wired', text: 'Body' } }], createdBy: 'u1' });
    await transitionPage(TENANT, org, page.pageId, 'publish', 'u1');
    await vi.waitFor(async () => { expect(await docIn(org, page.pageId), 'publish wiring must sync the KB').not.toBeNull(); }, { timeout: 2_000, interval: 25 });

    await deletePage(TENANT, org, page.pageId);
    await vi.waitFor(async () => { expect(await docIn(org, page.pageId), 'delete must drop the KB doc (no orphan)').toBeNull(); }, { timeout: 2_000, interval: 25 });
  });

  it('an in-place edit of a PUBLISHED docs page re-syncs the KB text (D2)', async () => {
    const org = freshOrg();
    const page = await createPage({ tenantId: TENANT, orgId: org, title: 'Editable', slug: 'editable', collection: 'docs', sections: [{ type: 'richText', data: { heading: 'Editable', text: 'Original text' } }], createdBy: 'u1' });
    await transitionPage(TENANT, org, page.pageId, 'publish', 'u1');
    await vi.waitFor(async () => { expect((await docIn(org, page.pageId))?.text).toContain('Original text'); }, { timeout: 2_000, interval: 25 });

    await updatePage(TENANT, org, page.pageId, { sections: [{ type: 'richText', data: { heading: 'Editable', text: 'Rewritten text' } }] }, 'admin');
    await vi.waitFor(async () => {
      expect((await docIn(org, page.pageId))?.text, 'published in-place edit must re-sync the KB').toContain('Rewritten text');
    }, { timeout: 2_000, interval: 25 });
  });
});

describe('grade-pass D4 — backfillDocsKb reconciles both directions', () => {
  it('indexes missed published pages and removes stranded KB docs; idempotent', async () => {
    const org = freshOrg();
    const coll = docsCollectionIdFor(org);
    // A published docs page whose KB doc was LOST (its sync threw, or ran while
    // the toggle was off): let the lifecycle land, then drop the doc.
    const missed = await publishedDocsPage(org, 'missed', 'Missed');
    await deleteDocument(TENANT, org, coll, missed.pageId);
    expect(await docIn(org, missed.pageId)).toBeNull();
    // A stranded KB doc whose page never existed (pre-D1 orphan shape).
    await upsertDocument(TENANT, org, coll, 'page:ghost', 'test', { title: 'Ghost', text: 'stale', contentTrust: 'trusted' });

    const first = await backfillDocsKb(TENANT, org);
    expect(first).toEqual({ pages: 1, removedOrphans: 1 });
    expect((await docIn(org, missed.pageId))?.title).toBe('Missed'); // missed page re-indexed by the backfill
    expect(await docIn(org, 'page:ghost')).toBeNull(); // orphan healed

    const second = await backfillDocsKb(TENANT, org);
    expect(second).toEqual({ pages: 1, removedOrphans: 0 }); // idempotent — nothing left to heal
  });
});
