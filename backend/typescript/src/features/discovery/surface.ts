/**
 * Discovery workflow surface (ADR 0275 / MERCH-C) — `ctx.features.discovery`.
 * Search adapter (READ) + curation (WRITE) over the discovery service. Tenant from the
 * run scope (CTI-1); `orgId` node-supplied + service-enforced. Collections/merch-rules
 * carry no money and are trivially reversible ⇒ direct agent authoring (ADR 0058 review);
 * the SAME service fns the REST routes call (single source of truth).
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { searchProducts, createCollection, createMerchRule } from './discoveryService.js';

export function buildDiscoverySurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    search: async (args) => {
      const result = await searchProducts({
        tenantId, orgId: str(args.orgId),
        ...(optStr(args.q) ? { q: optStr(args.q)! } : {}),
        ...(optStr(args.collectionId) ? { collectionId: optStr(args.collectionId)! } : {}),
      });
      return { productIds: result.products.map((p) => p.productId), facets: result.facets };
    },
    // WRITE (role:'action') — author a collection (manual or dynamic-by-rule).
    createCollection: async (args) => {
      const c = await createCollection({
        tenantId, orgId: str(args.orgId), createdBy: 'agent',
        name: str(args.name), type: args.type, productIds: args.productIds, rule: args.rule,
      });
      return { collectionId: c.collectionId, type: c.type, slug: c.slug };
    },
    // WRITE (role:'action') — author a pin/boost/bury/hide merchandising rule.
    createMerchRule: async (args) => {
      const r = await createMerchRule({
        tenantId, orgId: str(args.orgId), createdBy: 'agent',
        name: str(args.name), scope: str(args.scope) || 'all', actions: args.actions, holdoutPct: args.holdoutPct,
      });
      return { ruleId: r.ruleId, scope: r.scope };
    },
  };
}
