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
import { createCollection, getCollection, upsertDocument, deleteDocument, listDocuments, getDocument, KB_MAINTENANCE_CALLER } from '../kb/kbService.js';
import { kbMutated } from '../kb/emit.js'; // ADR 0643 D3 — silent per-row sweep + ONE batch event
import { getPage, listPages, resolveSharedRefs, type Page, type Section } from '../cms/cmsService.js';
import { configuredPublicBaseUrl } from '../featureRoute.js';
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

/** Is docs on for the DATA tenant? The sync gates on it, and the backfill route
 *  uses it for the system site, whose data tenant is never the caller's. */
export async function gateOpen(tenantId: string): Promise<boolean> {
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
 *
 * ADR 1057 D4 (`DOCSWF-7`) — a section's `heading` leads its text as a `## `
 * line, so the heading-aware chunker gives each chunk a heading path. It is
 * left out of the key-sorted walk, or it would be indexed twice.
 */
export function flattenSections(page: Page): string {
  const parts: string[] = [page.title];
  for (const section of page.sections) {
    const heading = typeof section.data?.heading === 'string' ? section.data.heading.trim() : '';
    if (heading) parts.push(`## ${heading}`);
    parts.push(...flattenSectionData(section));
  }
  return parts.filter((s) => s.trim().length > 0).join('\n\n');
}

/** Depth-first, key-sorted extraction of string leaves from a section's `data`
 *  (deterministic regardless of object key insertion order). The top-level
 *  `heading` is emitted by `flattenSections` as a markdown heading instead. */
function flattenSectionData(section: Section): string[] {
  const out: string[] = [];
  const walk = (v: unknown, top: boolean): void => {
    if (typeof v === 'string') { if (v.trim()) out.push(v.trim()); return; }
    if (Array.isArray(v)) { for (const item of v) walk(item, false); return; }
    if (v && typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        if (top && key === 'heading') continue;
        walk((v as Record<string, unknown>)[key], false);
      }
    }
  };
  walk(section.data, true);
  return out;
}

/**
 * ADR 1057 D4 (`DOCSWF-5`) — where a reader can open a docs page. Only the
 * configured public site org has a `/docs` door; any other org's docs have no
 * openable page on this origin (the vendor path is a JSON read), so they get
 * none. Absolute with a configured public base URL, relative otherwise — a
 * request-derived origin is never stored.
 */
export function docsPageUrl(orgId: string, slug: string): string | undefined {
  const siteOrg = process.env.OPENWOP_PUBLIC_SITE_ORG_ID?.trim();
  if (!siteOrg || siteOrg !== orgId) return undefined;
  return `${configuredPublicBaseUrl() ?? ''}/docs/${encodeURIComponent(slug)}`;
}

/** The page as readers see it IF it is a published docs page now, else null.
 *  Shared sections are resolved (ADR 0204), the same as the public read. */
async function currentDocsPage(tenantId: string, orgId: string, pageId: string): Promise<Page | null> {
  const page = await getPage(tenantId, orgId, pageId);
  if (!page || page.status !== 'published' || page.collection !== 'docs') return null;
  return resolveSharedRefs(page);
}

/** The ONE KB write for a docs page (lifecycle sync and backfill alike). */
async function indexDocsPage(tenantId: string, orgId: string, collectionId: string, page: Page, silent = false): Promise<void> {
  const sourceUrl = docsPageUrl(orgId, page.slug);
  await upsertDocument(tenantId, orgId, collectionId, page.pageId, SYNC_ACTOR, {
    title: page.title,
    text: flattenSections(page),
    contentTrust: 'trusted', // passed the editorial human gate
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(silent ? { silent: true } : {}),
  });
}

/** Remove a page's KB doc if there is one. Never toggle-gated, and never creates
 *  the collection just to delete from it. The MAINTENANCE caller is what lets a
 *  removal through while the docs collection is invisible (toggle off or plan
 *  lapsed, `managedPlanAllows`) — the removal case `KB_MAINTENANCE_CALLER` exists
 *  for. Indexing never uses it: it runs only behind `gateOpen`. */
async function removeDocsPage(tenantId: string, orgId: string, pageId: string): Promise<boolean> {
  const collectionId = docsCollectionIdFor(orgId);
  if (!(await getCollection(tenantId, orgId, collectionId, KB_MAINTENANCE_CALLER))) return false;
  if (!(await getDocument(tenantId, orgId, collectionId, pageId, KB_MAINTENANCE_CALLER))) return false;
  await deleteDocument(tenantId, orgId, collectionId, pageId, KB_MAINTENANCE_CALLER);
  return true;
}

/**
 * ADR 1057 D3 — reconcile one page's KB doc to the page's CURRENT state. The
 * event only says "look at this page": a stale `published` (a draft now) and a
 * stale `unpublished` (published again) both resolve to what the page IS.
 * Removal never needs the toggle (a withdrawn page must not come back when docs
 * is re-enabled). A page that is still published while the toggle is OFF is left
 * exactly as it is: nothing indexes it and nothing evicts it, so re-enabling
 * docs does not silently drop live pages from the chat (grade-code finding 2).
 */
async function reconcileDocsPage(tenantId: string, orgId: string, pageId: string): Promise<void> {
  const page = await currentDocsPage(tenantId, orgId, pageId);
  if (page && !(await gateOpen(tenantId))) return;
  if (page) {
    await indexDocsPage(tenantId, orgId, await getOrCreateCollection(tenantId, orgId), page);
    // Another instance can withdraw the page while the upsert embeds. One re-read
    // narrows that window to a read; it does not close it (the KB has no
    // precondition to hold) — the backfill stays the reconciler of last resort.
    if (!(await currentDocsPage(tenantId, orgId, pageId))) {
      await removeDocsPage(tenantId, orgId, pageId);
      log.info('docs page withdrawn during sync; removed from KB', { tenantId, pageId });
      return;
    }
    log.info('docs page synced to KB', { tenantId, pageId });
    return;
  }
  if (await removeDocsPage(tenantId, orgId, pageId)) log.info('docs page removed from KB', { tenantId, pageId });
}

/** ADR 1057 D3 — one reconcile per page at a time on this instance, so a publish
 *  and a quick unpublish cannot finish out of order. A handler that throws or
 *  hangs never wedges its page: the chain continues after a failure, and after
 *  `CHAIN_STEP_BOUND_MS` the next step starts anyway (the post-write re-read
 *  covers the overlap). */
const CHAIN_STEP_BOUND_MS = 30_000;
const pageChains = new Map<string, Promise<void>>();

function serializedPerPage(key: string, step: () => Promise<void>): Promise<void> {
  const prev = pageChains.get(key) ?? Promise.resolve();
  const bounded = (p: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, CHAIN_STEP_BOUND_MS); timer.unref?.(); });
    return Promise.race([p.catch(() => undefined), bound]).finally(() => clearTimeout(timer));
  };
  const run = bounded(prev).then(step);
  const tail = bounded(run);
  pageChains.set(key, tail);
  void tail.then(() => { if (pageChains.get(key) === tail) pageChains.delete(key); });
  return run;
}

/** The lifecycle handler registered on `onCmsPageLifecycle`. No-op for
 *  non-docs pages (CMS stays ignorant of docs). `collection` is set at create
 *  only (`cmsService.createPage`), so a page cannot leave the docs collection
 *  while published (ADR 1057 § Corrections). */
export async function syncDocsPage(e: CmsPageLifecycleChange): Promise<void> {
  if (e.collection !== 'docs') return;
  await serializedPerPage(`${e.tenantId}\n${e.orgId}\n${e.pageId}`, () => reconcileDocsPage(e.tenantId, e.orgId, e.pageId));
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
  // `document.ingested { count }` for the batch. ADR 1057 D4 — the same builder as
  // the lifecycle sync (headings, shared sections, source URL), so a backfill can
  // never index a different text than a publish would.
  for (const page of published) {
    await indexDocsPage(tenantId, orgId, collectionId, await resolveSharedRefs(page), true);
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
