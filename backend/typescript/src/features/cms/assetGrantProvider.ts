/**
 * ADR 1122 P1 — the CMS page surface's public-asset provider.
 *
 * A grantor is one page (`cms-page:<pageId>`). What it makes public is every
 * picture a reader of the published page can reach (`publicAssetTokensForPage`);
 * an unpublished or deleted page makes nothing public.
 *
 * The backfill (`publishedPagesBackfillStep`, shared with the publishing feature's
 * SEO provider) pages the kernel's entity-type rows by key on a cursor, one bounded
 * page per step, picks the tenants that hold the `cms.page` system type, and lists
 * up to `TENANTS_PER_STEP` of those tenants' published pages. It never lists every
 * tenant or every page at once, which `listSystemTypeTenants` would (EVID-4).
 */
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { registerPublicAssetRefProvider } from '../../host/assetGrants.js';
import { CMS_PAGE_TYPE, publicAssetTokensForPage, publishedPageRefs } from './cmsService.js';

const TYPE_ROWS_PREFIX = 'hostext:entity:type:';
const TYPE_ROWS_PER_STEP = 200;
const TENANTS_PER_STEP = 3;

/** One bounded step over the tenants that hold CMS pages. `next` absent = the cycle is done. */
export async function publishedPagesBackfillStep(cursor: string | undefined): Promise<{ pages: Array<{ tenantId: string; orgId: string; pageId: string }>; next?: string }> {
  const storage = hostExtStorage();
  const rows = storage.kvListPage
    ? await storage.kvListPage(TYPE_ROWS_PREFIX, { ...(cursor ? { after: cursor } : {}), limit: TYPE_ROWS_PER_STEP })
    : (await storage.kvList(TYPE_ROWS_PREFIX)).filter((r) => !cursor || r.key > cursor).slice(0, TYPE_ROWS_PER_STEP);
  const pages: Array<{ tenantId: string; orgId: string; pageId: string }> = [];
  let tenants = 0;
  let last: string | undefined;
  let stoppedEarly = false;
  for (const { key, value } of rows) {
    last = key;
    let row: { system?: unknown; name?: unknown; tenantId?: unknown };
    try { row = JSON.parse(value) as typeof row; } catch { continue; }
    if (row.system !== true || row.name !== CMS_PAGE_TYPE || typeof row.tenantId !== 'string') continue;
    const tenantId = row.tenantId;
    for (const p of await publishedPageRefs(tenantId)) pages.push({ tenantId, ...p });
    tenants += 1;
    if (tenants >= TENANTS_PER_STEP) { stoppedEarly = true; break; } // resume after this row next step
  }
  const more = stoppedEarly || rows.length >= TYPE_ROWS_PER_STEP;
  return { pages, ...(more && last ? { next: last } : {}) };
}

export function registerCmsAssetGrantProvider(): void {
  registerPublicAssetRefProvider({
    surface: 'cms-page',
    tokensFor: (tenantId, pageId) => publicAssetTokensForPage(tenantId, pageId),
    async backfillStep(cursor) {
      const step = await publishedPagesBackfillStep(cursor);
      return { items: step.pages.map((p) => ({ tenantId: p.tenantId, id: p.pageId })), ...(step.next ? { next: step.next } : {}) };
    },
  });
}
