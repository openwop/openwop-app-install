/**
 * ADR 0820 §7 — Commerce's READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * A digital product's `downloadAssetTokens` are download CAPABILITIES (the
 * `/assets/:id/use` cap), so the export carries their count, never the tokens.
 */
import { listCoupons, listOrdersPage, listProductsPage, type Product } from './commerceService.js';
import { listQuotes } from './quotes.js';
import { collectPerOrg, type FeatureDataPage } from '../../host/featureDataExport.js';
import { listOrgs } from '../../host/accessControlService.js';

/** One exported product: its download tokens become a count (capabilities, not data). */
const exportProduct = ({ downloadAssetTokens, ...p }: Product): Omit<Product, 'downloadAssetTokens'> & { downloadAssetCount: number } =>
  ({ ...p, downloadAssetCount: downloadAssetTokens?.length ?? 0 });

/** Where a paged export stands: `o` = the id of the org being read (orgs are walked in id
 *  order, so an org added or removed mid-export never shifts the position), `c` = its
 *  cursor, in phase `p` (`products`, then `orders`); then `r` = the offset into the
 *  coupons/quotes sections. */
interface ExportCursor { p?: 'products' | 'orders'; o?: string; c?: string; r?: number }
const wholeFrom0 = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
/** The cursor is the client's to send back, so it is read as data: anything that is not a
 *  well-formed position starts the export over (tenant scope never comes from it). */
const readCursor = (raw: string | undefined): ExportCursor => {
  if (!raw) return {};
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    const r = wholeFrom0(v.r);
    if (r !== undefined) return { r };
    return { p: v.p === 'orders' ? 'orders' : 'products', ...(typeof v.o === 'string' ? { o: v.o } : {}), ...(typeof v.c === 'string' && v.c ? { c: v.c } : {}) };
  } catch { return {}; }
};
const writeCursor = (c: ExportCursor): string => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

/**
 * ADR 1110 P3/P5 — the PAGED exporter. Products are read a page at a time, org by org, in
 * name order (a catalog can hold 500,000 per org, so it is never read whole), then orders
 * the same way, newest first; then the coupons and quotes sections, offset-paged as the
 * door did before.
 */
export async function exportCommerceDataPage(tenantId: string, page: { cursor?: string; limit: number }): Promise<FeatureDataPage> {
  const at = readCursor(page.cursor);
  if (at.r === undefined) {
    const orgs = (await listOrgs(tenantId)).map((o) => o.orgId).sort();
    const phases = ['products', 'orders'] as const;
    for (let ph = phases.indexOf(at.p ?? 'products'); ph < phases.length; ph += 1) {
      const phase = phases[ph] as 'products' | 'orders';
      const resume = ph === phases.indexOf(at.p ?? 'products');
      // The cursor's org, or the first org after it if it was removed meanwhile.
      let o = resume && at.o !== undefined ? orgs.findIndex((id) => id >= (at.o as string)) : 0;
      if (o < 0) o = orgs.length;
      let cursor = resume && at.o !== undefined && orgs[o] === at.o ? at.c : undefined;
      while (o < orgs.length) {
        const orgId = orgs[o] as string;
        const got = phase === 'products'
          ? await listProductsPage(tenantId, orgId, { limit: page.limit, ...(cursor ? { cursor } : {}) }).then((r) => ({ rows: r.products.map(exportProduct), next: r.nextCursor }))
          : await listOrdersPage(tenantId, orgId, { limit: page.limit, ...(cursor ? { cursor } : {}) }).then((r) => ({ rows: r.orders, next: r.nextCursor }));
        if (got.rows.length > 0 || got.next) {
          const next: ExportCursor = got.next ? { p: phase, o: orgId, c: got.next }
            : o + 1 < orgs.length ? { p: phase, o: orgs[o + 1] as string }
            : ph + 1 < phases.length ? { p: phases[ph + 1] as 'products' | 'orders' } : { r: 0 };
          return { sections: { [phase]: got.rows }, nextCursor: writeCursor(next) };
        }
        o += 1;
        cursor = undefined;
      }
    }
  }
  const offset = at.r ?? 0;
  const rest = {
    coupons: await collectPerOrg(tenantId, (orgId) => listCoupons(tenantId, orgId)),
    quotes: await collectPerOrg(tenantId, (orgId) => listQuotes(tenantId, orgId)),
  };
  const sections: Record<string, readonly unknown[]> = Object.fromEntries(Object.entries(rest).map(([k, rows]) => [k, rows.slice(offset, offset + page.limit)]));
  // Every export names every section, even an empty one (a merged download keeps its shape).
  if (offset === 0) { sections.products = []; sections.orders = []; }
  const more = Object.values(rest).some((rows) => rows.length > offset + page.limit);
  return { sections, ...(more ? { nextCursor: writeCursor({ r: offset + page.limit }) } : {}) };
}
