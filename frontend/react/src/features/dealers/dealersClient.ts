/**
 * Dealer Network API client (ADR 0281) — the SPA half of the
 * `/host/openwop-app/dealers/orgs/:orgId/*` host-extension surface.
 * Reuses the org + company list from the CRM client.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
export { listOrgs, type Org, listCompanies, type Company } from '../crm/crmOrgClient.js';

const root = `${config.baseUrl}/host/openwop-app`;
const base = (orgId: string): string => `${root}/dealers/orgs/${encodeURIComponent(orgId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** Error carrying the HTTP status so detail pages can 404 gracefully (ADR 0336 pattern). */
export class DealersApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new DealersApiError(detail || `${ctx} returned ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export type DealerStatus = 'active' | 'suspended';
export type OutletStatus = 'active' | 'closed';
export type RegistrationStatus = 'pending' | 'approved' | 'rejected';

export interface Dealer { dealerId: string; companyId: string; name: string; tier: string; status: DealerStatus; territoryId?: string; updatedAt: string }
export interface Outlet { outletId: string; dealerId: string; name: string; address?: string; lat?: number; lng?: number; status: OutletStatus }
export interface DealRegistration { regId: string; dealerId: string; dealTitle: string; companyName: string; status: RegistrationStatus; at: string; decidedBy?: string   /** R2 DLR2-B2 — the review card for this registration did NOT reach the inbox, so
   *  nobody has been asked to decide it. `status` is `pending` either way, which is
   *  why the console used to say "awaiting review" for both. Cleared when the admin
   *  list route successfully re-queues it. */
  queueFailed?: boolean;
}

export async function listDealers(orgId: string): Promise<Dealer[]> {
  return (await asJson<{ dealers: Dealer[] }>(await fetch(`${base(orgId)}/dealers`, fetchOpts({ headers: authedHeaders() })), 'listDealers')).dealers;
}
export async function createDealer(orgId: string, input: { name: string; companyId: string; tier?: string }): Promise<Dealer> {
  return asJson(await fetch(`${base(orgId)}/dealers`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })), 'createDealer');
}
export async function deleteDealer(orgId: string, dealerId: string): Promise<{ removed: number }> {
  return asJson(await fetch(`${base(orgId)}/dealers/${encodeURIComponent(dealerId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'deleteDealer');
}
export async function getDealer(orgId: string, dealerId: string): Promise<Dealer> {
  return asJson(await fetch(`${base(orgId)}/dealers/${encodeURIComponent(dealerId)}`, fetchOpts({ headers: authedHeaders() })), 'getDealer');
}
/** One outlet by id — the `/dealers/outlets/:outletId` detail page (sales-map pin deep-link). */
export async function getOutlet(orgId: string, outletId: string): Promise<Outlet> {
  return asJson(await fetch(`${base(orgId)}/outlets/${encodeURIComponent(outletId)}`, fetchOpts({ headers: authedHeaders() })), 'getOutlet');
}
export async function listOutlets(orgId: string, dealerId: string): Promise<Outlet[]> {
  return (await asJson<{ outlets: Outlet[] }>(await fetch(`${base(orgId)}/dealers/${encodeURIComponent(dealerId)}/outlets`, fetchOpts({ headers: authedHeaders() })), 'listOutlets')).outlets;
}
/** All outlets in the org (across dealers) — used by the Sales Map to plot pins. */
export async function listAllOutlets(orgId: string): Promise<Outlet[]> {
  return (await asJson<{ outlets: Outlet[] }>(await fetch(`${base(orgId)}/outlets`, fetchOpts({ headers: authedHeaders() })), 'listAllOutlets')).outlets;
}
/**
 * R2 DLR2-M4 — the PATCH route and `updateDealer` service have existed since P1, and
 * this client never exposed them, so NOTHING about a dealer was editable: not the
 * name, not the tier, not the territory, and — the one that bites — not the status.
 * `suspendDealersForCompany` documents itself "non-destructive + REVERSIBLE"; the
 * reversal had no caller. A dealer suspended by a mistaken CRM company delete was
 * stuck suspended forever, and the only escape was Delete + recreate, which cascades
 * its outlets, its registrations and its live partner token.
 */
export async function updateDealer(orgId: string, dealerId: string, patch: { name?: string; tier?: string; status?: string; territoryId?: string | null }): Promise<Dealer> {
  return asJson(await fetch(`${base(orgId)}/dealers/${encodeURIComponent(dealerId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) })), 'updateDealer');
}

/**
 * R2 review B3 — the coordinate capture (DLR2-B5) landed on the CREATE form only, and
 * the population it was written for is the outlets that ALREADY exist: an operator
 * reading "50 outlets are not on the map" had nowhere to type them, because the client
 * exposed no update (the same omission this pass had just fixed for dealers) and the
 * detail page rendered coordinates as a read-only `<dd>`. The PATCH route and the
 * `updateOutlet` service have existed since P1.
 */
export async function updateOutlet(orgId: string, outletId: string, patch: { name?: string; address?: string; lat?: number | null; lng?: number | null }): Promise<Outlet> {
  return asJson(await fetch(`${base(orgId)}/outlets/${encodeURIComponent(outletId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) })), 'updateOutlet');
}

export async function createOutlet(orgId: string, dealerId: string, input: { name: string; address?: string; lat?: number; lng?: number }): Promise<Outlet> {
  return asJson(await fetch(`${base(orgId)}/dealers/${encodeURIComponent(dealerId)}/outlets`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })), 'createOutlet');
}
export async function deleteOutlet(orgId: string, outletId: string): Promise<void> {
  await asJson(await fetch(`${base(orgId)}/outlets/${encodeURIComponent(outletId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'deleteOutlet');
}
export async function mintPortalToken(orgId: string, dealerId: string): Promise<{ token: string; url: string }> {
  return asJson(await fetch(`${base(orgId)}/dealers/${encodeURIComponent(dealerId)}/portal-token`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'mintPortalToken');
}
export async function listRegistrations(orgId: string, dealerId?: string): Promise<DealRegistration[]> {
  const qs = dealerId ? `?dealerId=${encodeURIComponent(dealerId)}` : '';
  return (await asJson<{ registrations: DealRegistration[] }>(await fetch(`${base(orgId)}/registrations${qs}`, fetchOpts({ headers: authedHeaders() })), 'listRegistrations')).registrations;
}
// CFP-1 (D9): the bespoke `decideRegistration` (POST …/registrations/:id/{approve,reject})
// is DEMOLISHED — a partner-submitted registration auto-queues a `dealer-registration`
// approval, decided through the shared Reviews inbox (host:dealers:manage), not a page
// button. The registration list here is read-only awaiting-review state.
