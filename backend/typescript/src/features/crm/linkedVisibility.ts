/**
 * ADR 0837 D5 — territory visibility for the records that HANG OFF a deal or a
 * company (tasks, activities). ADR 0272 filtered companies and deals themselves,
 * and gated the WRITES that link to them (`assertLinkedVisible`), but every read
 * of a task or an activity returned rows linked to deals the caller cannot open:
 * a rep restricted to some territories read the tasks and timeline of the rest
 * (`CRM-7`). This is the ONE predicate every task/activity exit calls — the org
 * routes (list, get, patch, delete, export), the run surface (and through it the
 * chat tools), and the deals list's next-task rollup.
 *
 * A row is visible iff each of its `dealId` / `companyId` (when set) is visible.
 * A row linked only to a contact stays visible (contacts are tenant-scoped, not
 * territory-scoped). A link to a record that no longer exists hides nothing:
 * there is no territory to protect. Each linked entity type costs one org read.
 * No resolver registered (territories off) or no viewer (a system read) ⇒ the
 * rows come back unchanged, exactly as `filterVisibleCrmRecords` behaves.
 */

import { filterVisibleCrmRecords, isCrmVisibilityActive } from '../../host/crmRecordVisibility.js';
import { OpenwopError } from '../../types.js';
import { listCompanies } from './entities/companies.js';
import { listDeals } from './entities/deals.js';

interface Linked { dealId?: string | undefined; companyId?: string | undefined }

export async function filterByLinkedVisibility<T extends Linked>(tenantId: string, orgId: string, viewer: string | undefined, rows: T[]): Promise<T[]> {
  if (viewer === undefined || !isCrmVisibilityActive() || rows.length === 0) return rows;
  const hidden = new Set<string>();
  const dealIds = new Set(rows.map((r) => r.dealId).filter((x): x is string => !!x));
  const companyIds = new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x));
  // CRM2CD-3 — ONE org read per linked entity type, never a point read per id
  // (an unbounded fan-out of `getDeal`s against the small prod pool on every
  // board load). The visibility resolver then judges just the linked rows.
  if (dealIds.size > 0) {
    const linked = (await listDeals(tenantId, orgId)).filter((d) => dealIds.has(d.dealId));
    const seen = new Set((await filterVisibleCrmRecords({ tenantId, orgId, target: 'deal', callerSubject: viewer, rows: linked, idOf: (d) => d.dealId })).map((d) => d.dealId));
    for (const d of linked) if (!seen.has(d.dealId)) hidden.add(`deal:${d.dealId}`);
  }
  if (companyIds.size > 0) {
    const linked = (await listCompanies(tenantId, orgId)).filter((c) => companyIds.has(c.companyId));
    const seen = new Set((await filterVisibleCrmRecords({ tenantId, orgId, target: 'company', callerSubject: viewer, rows: linked, idOf: (c) => c.companyId })).map((c) => c.companyId));
    for (const c of linked) if (!seen.has(c.companyId)) hidden.add(`company:${c.companyId}`);
  }
  if (hidden.size === 0) return rows;
  return rows.filter((r) => !(r.dealId && hidden.has(`deal:${r.dealId}`)) && !(r.companyId && hidden.has(`company:${r.companyId}`)));
}

/** The single-row form: a uniform 404 (no existence disclosure) when hidden. */
export async function assertLinkedRowVisible<T extends Linked>(tenantId: string, orgId: string, viewer: string | undefined, row: T, notFound: { message: string; details: Record<string, unknown> }): Promise<T> {
  const [kept] = await filterByLinkedVisibility(tenantId, orgId, viewer, [row]);
  if (!kept) throw new OpenwopError('not_found', notFound.message, 404, notFound.details);
  return kept;
}
