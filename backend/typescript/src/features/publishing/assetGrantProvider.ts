/**
 * ADR 1122 P1 — the SEO surface's public-asset provider. A published page's SEO
 * image (`ogImageToken`) is public twice over: as its og:image and as its blog
 * cover. The SEO row is this feature's, and the page status is the CMS's, so the
 * grantor (`seo-page:<orgId>|<pageId>`) answers from both: the image while the page
 * is published, nothing otherwise.
 *
 * Kept in step by a resync after `putSeo` and on every CMS page lifecycle event
 * (publish, unpublish, archive, delete, live edit), plus the reconcile. The
 * backfill reuses the CMS walk over published pages.
 */
import { registerPublicAssetRefProvider, schedulePublicAssetResync } from '../../host/assetGrants.js';
import { onCmsPageLifecycle } from '../../host/cmsPageLifecycle.js';
import { getPage } from '../cms/cmsService.js';
import { publishedPagesBackfillStep } from '../cms/assetGrantProvider.js';
import { getSeo } from './publishingService.js';

export const SEO_GRANT_SURFACE = 'seo-page';
export const seoGrantorId = (orgId: string, pageId: string): string => `${orgId}|${pageId}`;

export function registerSeoAssetGrantProvider(): void {
  registerPublicAssetRefProvider({
    surface: SEO_GRANT_SURFACE,
    async tokensFor(tenantId, id) {
      const cut = id.indexOf('|');
      if (cut <= 0) return [];
      const orgId = id.slice(0, cut);
      const pageId = id.slice(cut + 1);
      const page = await getPage(tenantId, orgId, pageId);
      if (!page || page.status !== 'published') return [];
      const token = (await getSeo(tenantId, orgId, pageId))?.ogImageToken;
      return token ? [token] : [];
    },
    async backfillStep(cursor) {
      const step = await publishedPagesBackfillStep(cursor);
      return { items: step.pages.map((p) => ({ tenantId: p.tenantId, id: seoGrantorId(p.orgId, p.pageId) })), ...(step.next ? { next: step.next } : {}) };
    },
  });
  onCmsPageLifecycle('publishing.assetGrants', async (e) => {
    schedulePublicAssetResync(SEO_GRANT_SURFACE, e.tenantId, seoGrantorId(e.orgId, e.pageId));
  });
}
