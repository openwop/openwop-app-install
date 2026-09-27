/**
 * Docs → KB sync (ADR 0392 Phase 2) — keeps a managed `docs` KB collection in
 * lockstep with published docs pages so the ONE chat answers "how does X work"
 * over RAG. Registered on the CMS page-lifecycle seam; CMS never imports docs.
 *
 * Idempotency: the stable document id IS the CMS page id (ADR 0100) + the KB
 * content-hash guard, so republish is a deterministic no-op re-index (never a
 * duplicate). Delete-on-unpublish/archive so the chat never cites a doc that is
 * no longer public. Best-effort + fail-open (a sync failure must not fail the
 * CMS publish) — the lifecycle seam already swallows + logs.
 */
import { createLogger } from '../../observability/logger.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createCollection, getCollection, upsertDocument, deleteDocument, listDocuments } from '../kb/kbService.js';
import { kbMutated } from '../kb/emit.js'; // ADR 0643 D3 — silent per-row sweep + ONE batch event
import { getPage, listPages, type Page, type Section } from '../cms/cmsService.js';
import type { CmsPageLifecycleChange } from '../../host/cmsPageLifecycle.js';

const log = createLogger('docs.kbSync');
const MANAGED = 'docs' as const;
const COLLECTION_NAME = 'Documentation';
const SYNC_ACTOR = 'system:docs-sync';

/** Deterministic managed-collection id, per authoring org (the tenant's chat
 *  retrieves tenant-wide, so this reaches the chat regardless of org). */
export function docsCollectionIdFor(orgId: string): string {
  return `mgd-docs-${orgId}`;
}

async function gateOpen(tenantId: string): Promise<boolean> {
  return (await resolveOne('docs', { tenantId }))?.enabled ?? false;
}

async function getOrCreateCollection(tenantId: string, orgId: string): Promise<string> {
  const id = docsCollectionIdFor(orgId);
  const existing = await getCollection(tenantId, orgId, id);
  if (existing) return id;
  await createCollection(tenantId, orgId, SYNC_ACTOR, { name: COLLECTION_NAME }, { collectionId: id, managed: MANAGED });
  return id;
}

/**
 * Flatten a CMS page's sections into deterministic plain text for embedding.
 * Order-stable (sections in author order) and uses ONLY base `data` string
 * values (no locale overlays, no timestamps) so the same page content always
 * produces the same text → the KB content-hash guard makes republish free.
 */
export function flattenSections(page: Page): string {
  const parts: string[] = [page.title];
  for (const section of page.sections) parts.push(...flattenSectionData(section));
  return parts.filter((s) => s.trim().length > 0).join('\n\n');
}

/** Depth-first, key-sorted extraction of string leaves from a section's `data`
 *  (deterministic regardless of object key insertion order). */
function flattenSectionData(section: Section): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (v.trim()) out.push(v.trim()); return; }
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    if (v && typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>).sort()) walk((v as Record<string, unknown>)[key]);
    }
  };
  walk(section.data);
  return out;
}

/** The lifecycle handler registered on `onCmsPageLifecycle`. No-op for
 *  non-docs pages (CMS stays ignorant of docs); toggle-gated per tenant. */
export async function syncDocsPage(e: CmsPageLifecycleChange): Promise<void> {
  if (e.collection !== 'docs') return;
  if (!(await gateOpen(e.tenantId))) return;
  const collectionId = await getOrCreateCollection(e.tenantId, e.orgId);

  if (e.event === 'unpublished' || e.event === 'archived' || e.event === 'deleted') {
    await deleteDocument(e.tenantId, e.orgId, collectionId, e.pageId);
    log.info('docs page removed from KB', { tenantId: e.tenantId, pageId: e.pageId, event: e.event });
    return;
  }
  // published — re-read the page for its current sections (the event carries
  // only metadata) and upsert the flattened text under the stable page id.
  const page = await getPage(e.tenantId, e.orgId, e.pageId);
  if (!page) return;
  await upsertDocument(e.tenantId, e.orgId, collectionId, e.pageId, SYNC_ACTOR, {
    title: page.title,
    text: flattenSections(page),
    contentTrust: 'trusted', // passed the editorial human gate
  });
  log.info('docs page synced to KB', { tenantId: e.tenantId, pageId: e.pageId });
}

/**
 * Grade-pass D4/D8 — the idempotent BACKFILL + drift report (admin-triggered).
 * Closes the fail-open residue: a doc published while the toggle was off (or
 * whose sync threw) is invisible to search until re-published; a pre-D1 deleted
 * page may have stranded a KB doc. This sweep reconciles BOTH directions:
 *   - every PUBLISHED docs page is (re-)upserted (content-hash ⇒ unchanged is free);
 *   - every KB doc whose page is gone or no longer a published docs page is removed.
 * The returned counts double as the on-demand drift signal (D8).
 */
export async function backfillDocsKb(tenantId: string, orgId: string): Promise<{ pages: number; removedOrphans: number }> {
  const published = await listPages(tenantId, orgId, { collection: 'docs', status: 'published' });
  const collectionId = await getOrCreateCollection(tenantId, orgId);
  // ADR 0643 D3 — a BULK lane: silent per row (upserts AND orphan deletes), ONE
  // `document.ingested { count }` for the batch.
  for (const page of published) {
    await upsertDocument(tenantId, orgId, collectionId, page.pageId, SYNC_ACTOR, {
      title: page.title, text: flattenSections(page), contentTrust: 'trusted', silent: true,
    });
  }
  const liveIds = new Set(published.map((p) => p.pageId));
  let removedOrphans = 0;
  for (const doc of await listDocuments(tenantId, orgId, collectionId)) {
    if (liveIds.has(doc.documentId)) continue;
    await deleteDocument(tenantId, orgId, collectionId, doc.documentId, undefined, { silent: true });
    removedOrphans++;
  }
  if (published.length > 0) await kbMutated({ entity: 'document', verb: 'ingested', tenantId, orgId, collectionId, count: published.length });
  log.info('docs KB backfill complete', { tenantId, orgId, pages: published.length, removedOrphans });
  return { pages: published.length, removedOrphans };
}
