/**
 * ADR 1122 P1b — the commerce storefront's public-asset provider.
 *
 * A grantor is one product (`commerce-product:<productId>`). It makes its images
 * public while it is publicly listed (`isPubliclyListed`, ADR 1098), which is what
 * the storefront, discovery, recommendations, UCP and the ad catalog feed all read.
 * Download tokens are never granted: they are delivered after purchase.
 *
 * The backfill walks tenants that hold the `commerce.product` system type, one at a
 * time, and pages each tenant's products through the ADR 1110 name index on its own
 * cursor, so it never reads a whole catalog (up to 500,000 products per org) at once.
 * The cursor is JSON: where the tenant walk stands, and where inside the tenant.
 */
import { registerPublicAssetRefProvider } from '../../host/assetGrants.js';
import { storefrontOwnerServes } from './routes.js';
import { systemTypeTenantsPage } from '../entities/entitiesService.js';
import { listIndexPage } from '../entities/systemIndex.js';
import { publicAssetTokensForProduct } from './commerceService.js';

const PRODUCT_TYPE = 'commerce.product';
const PRODUCTS_PER_STEP = 200;

interface WalkState { after?: string; tenant?: { tenantId: string; key: string; inner?: string } }

export function registerCommerceAssetGrantProvider(): void {
  registerPublicAssetRefProvider({
    surface: 'commerce-product',
    // The storefront lane's own owner decision (toggle off, or a lapsed owner past the
    // grace window): a store the public lane would 404 grants nothing.
    tokensFor: async (tenantId, productId) => ((await storefrontOwnerServes(tenantId)) ? publicAssetTokensForProduct(tenantId, productId) : []),
    async backfillStep(cursor) {
      let state: WalkState = {};
      if (cursor) { try { state = JSON.parse(cursor) as WalkState; } catch { state = {}; } }
      if (state.tenant) {
        const { tenantId, key, inner } = state.tenant;
        const page = await listIndexPage(tenantId, PRODUCT_TYPE, 'n', undefined, { ...(inner ? { cursor: inner } : {}), limit: PRODUCTS_PER_STEP, allOrgs: true });
        const items = page.rows
          .map((r) => r.p.productId)
          .filter((id): id is string => typeof id === 'string')
          .map((id) => ({ tenantId, id }));
        const next: WalkState = page.cursor ? { ...state, tenant: { tenantId, key, inner: page.cursor } } : { after: key };
        return { items, next: JSON.stringify(next) };
      }
      const tp = await systemTypeTenantsPage(PRODUCT_TYPE, state.after);
      const first = tp.tenants[0];
      if (first) return { items: [], next: JSON.stringify({ after: state.after, tenant: { tenantId: first.tenantId, key: first.key } }) };
      return { items: [], ...(tp.next ? { next: JSON.stringify({ after: tp.next }) } : {}) };
    },
  });
}
