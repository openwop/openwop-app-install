/**
 * ADR 0820 §7 — Commerce's READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * A digital product's `downloadAssetTokens` are download CAPABILITIES (the
 * `/assets/:id/use` cap), so the export carries their count, never the tokens.
 */
import { listCoupons, listOrders, listProducts } from './commerceService.js';
import { listQuotes } from './quotes.js';
import { collectPerOrg, type FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportCommerceData(tenantId: string): Promise<FeatureDataSections> {
  const products = (await collectPerOrg(tenantId, (orgId) => listProducts(tenantId, orgId)))
    .map(({ downloadAssetTokens, ...p }) => ({ ...p, downloadAssetCount: downloadAssetTokens?.length ?? 0 }));
  return {
    products,
    orders: await collectPerOrg(tenantId, (orgId) => listOrders(tenantId, orgId)),
    coupons: await collectPerOrg(tenantId, (orgId) => listCoupons(tenantId, orgId)),
    quotes: await collectPerOrg(tenantId, (orgId) => listQuotes(tenantId, orgId)),
  };
}
