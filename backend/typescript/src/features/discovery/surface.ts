/**
 * Discovery workflow surface (ADR 0275 / MERCH-C) — `ctx.features.discovery`.
 * Search adapter (READ) + curation (WRITE) over the discovery service. Tenant from the
 * run scope (CTI-1); `orgId` node-supplied, checked by the ADR 0832 org floor (writes at
 * workspace:write, ADR 1025 D3). A collection lands live (on its own it hides nothing); a
 * merch rule lands INACTIVE, a proposal a human activates, because a hide rule removes
 * inventory from the public search (ADR 1025 D5). The SAME service fns the REST routes
 * call (single source of truth).
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import { searchProducts, createCollection, createMerchRule } from './discoveryService.js';

/** ADR 1025 D3 — the org floor skips a blank orgId, so a write refuses it itself. */
function requireOrg(v: unknown): string {
  const orgId = str(v);
  if (!orgId) throw new OpenwopError('validation_error', '`orgId` is required.', 400, { field: 'orgId' });
  return orgId;
}

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
    // WRITE (role:'side-effect', ADR 1025 D2) — author a collection (manual or dynamic-by-rule).
    createCollection: async (args) => {
      const c = await createCollection({
        tenantId, orgId: requireOrg(args.orgId), createdBy: 'agent',
        name: str(args.name), type: args.type, productIds: args.productIds, rule: args.rule,
      });
      return { collectionId: c.collectionId, type: c.type, slug: c.slug };
    },
    // WRITE (role:'side-effect', ADR 1025 D2) — author a pin/boost/bury/hide merchandising
    // rule. ADR 1025 D5 — it lands INACTIVE: a hide rule removes inventory from the public
    // search, so a run proposes and a human activates (the promotions precedent).
    createMerchRule: async (args) => {
      const r = await createMerchRule({
        tenantId, orgId: requireOrg(args.orgId), createdBy: 'agent',
        name: str(args.name), scope: str(args.scope) || 'all', actions: args.actions, holdoutPct: args.holdoutPct,
        active: false,
      });
      return { ruleId: r.ruleId, scope: r.scope, active: r.active, proposed: true };
    },
  };
}
