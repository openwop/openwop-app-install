/**
 * Dealer Network — the Dealer + Outlet model (ADR 0281 Phase 1).
 *
 * A Dealer REFERENCES a CRM `companyId` (the reference-not-fork precedent of ADR
 * 0177/0172 — no fork of `Company`) and optionally a territory (`territoryId`,
 * ADR 0272) so the territory map + attainment cover the dealer network for free.
 * An Outlet is a physical store wholly OWNED by a dealer (composition) — deleting
 * a dealer cascades its outlets (children-first, so a mid-cascade failure leaves
 * the dealer re-deletable rather than stranding orphan outlets).
 *
 * Host-extension only — no OpenWOP wire. Every accessor verifies `tenantId` +
 * `orgId` (the CRM IDOR guard); the linked `companyId` is validated visible on
 * create (no dangling reference).
 *
 * @see docs/adr/0281-dealer-network-prm.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { cleanString, cleanOpaqueToken } from '../../../host/boundedStrings.js';
import { getCompany } from '../../crm/crmEntitiesService.js';
import { validateDealer, validateOutlet } from './rowGuards.js';

export type DealerStatus = 'active' | 'suspended';
export type OutletStatus = 'active' | 'closed';

export interface Dealer {
  dealerId: string;
  tenantId: string;
  orgId: string;
  companyId: string; // CRM ref (reference-not-fork)
  name: string;
  tier: string; // free-form channel tier (e.g. "Gold"); bounded
  status: DealerStatus;
  territoryId?: string; // ADR 0272 ref (optional)
  createdAt: string;
  updatedAt: string;
}

export interface Outlet {
  outletId: string;
  tenantId: string;
  orgId: string;
  dealerId: string;
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  status: OutletStatus;
  createdAt: string;
  updatedAt: string;
}

const MAX = { name: 160, tier: 60, address: 240, perOrgDealers: 2000, perDealerOutlets: 500 } as const;

const dealers = new DurableCollection<Dealer>('dealers:dealer', (d) => d.dealerId, validateDealer, (d) => d.tenantId);
const outlets = new DurableCollection<Outlet>('dealers:outlet', (o) => o.outletId, validateOutlet, (o) => o.tenantId);

const nowIso = (): string => new Date().toISOString();
const scoped = <T extends { tenantId: string; orgId: string }>(rows: T[], tenantId: string, orgId: string): T[] =>
  rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId);

function requireName(raw: unknown): string {
  const name = cleanString(raw, MAX.name, '');
  if (!name) throw new OpenwopError('validation_error', 'Field `name` is required and MUST be a non-empty string.', 400, { field: 'name' });
  return name;
}
function optToken(raw: unknown, max = MAX.name): string | undefined {
  return cleanOpaqueToken(raw, max) || undefined;
}
function optGeo(raw: unknown, field: string, bound: number): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > bound) throw new OpenwopError('validation_error', `\`${field}\` must be a number within ±${bound}.`, 400, { field });
  return raw;
}
function assertStatus<T extends string>(raw: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) throw new OpenwopError('validation_error', `\`${field}\` must be one of ${allowed.join('|')}.`, 400, { field, allowed });
  return raw as T;
}

// ── Dealers ──────────────────────────────────────────────────────────────────
export async function createDealer(tenantId: string, orgId: string, input: Record<string, unknown>, actor: string): Promise<Dealer> {
  void actor;
  if (scoped(await dealers.listForTenantIndexed(tenantId), tenantId, orgId).length >= MAX.perOrgDealers) throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgDealers} dealers.`, 409, { max: MAX.perOrgDealers });
  const companyId = optToken(input.companyId);
  if (!companyId) throw new OpenwopError('validation_error', '`companyId` is required (a dealer references a CRM company).', 400, { field: 'companyId' });
  const company = await getCompany(tenantId, orgId, companyId);
  if (!company) throw new OpenwopError('not_found', 'The referenced CRM company does not exist in this org.', 404, { companyId });
  const now = nowIso();
  const dealer: Dealer = {
    dealerId: `dealer:${randomUUID()}`,
    tenantId,
    orgId,
    companyId,
    name: requireName(input.name),
    tier: cleanString(input.tier, MAX.tier, ''),
    status: assertStatus(input.status, ['active', 'suspended'] as const, 'status', 'active'),
    createdAt: now,
    updatedAt: now,
    ...(optToken(input.territoryId) ? { territoryId: optToken(input.territoryId) } : {}),
  };
  await dealers.put(dealer);
  return dealer;
}

export async function listDealers(tenantId: string, orgId: string, filter: { territoryId?: string; status?: string } = {}): Promise<Dealer[]> {
  let rows = scoped(await dealers.listForTenantIndexed(tenantId), tenantId, orgId);
  if (filter.territoryId) rows = rows.filter((d) => d.territoryId === filter.territoryId);
  if (filter.status) rows = rows.filter((d) => d.status === filter.status);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getDealer(tenantId: string, orgId: string, dealerId: string): Promise<Dealer> {
  const d = await dealers.get(dealerId);
  if (!d || d.tenantId !== tenantId || d.orgId !== orgId) throw new OpenwopError('not_found', 'Dealer not found.', 404, { dealerId });
  return d;
}

export async function updateDealer(tenantId: string, orgId: string, dealerId: string, patch: Record<string, unknown>, actor: string): Promise<Dealer> {
  void actor;
  const existing = await getDealer(tenantId, orgId, dealerId);
  const next: Dealer = { ...existing };
  if (patch.name !== undefined) next.name = requireName(patch.name);
  if (patch.tier !== undefined) next.tier = cleanString(patch.tier, MAX.tier, '');
  if (patch.status !== undefined) next.status = assertStatus(patch.status, ['active', 'suspended'] as const, 'status', existing.status);
  // REVIEW B4 — REACTIVATION needs the check CREATION already does. `lifecycle.ts`
  // suspends a dealer when its CRM company is deleted, and says the point is to stop a
  // dangling-company dealer "reading as active". Shipping the reversal (R2 M4) without
  // this guard hands the operator a one-click route back into exactly that state — and
  // nothing would ever re-suspend it, because the company delete cannot recur.
  if (existing.status === 'suspended' && next.status === 'active') {
    const company = await getCompany(tenantId, orgId, existing.companyId);
    if (!company) {
      throw new OpenwopError('conflict', 'This dealer\u2019s CRM company no longer exists, so it cannot be reactivated. Relink it to a live company first.', 409, { companyId: existing.companyId });
    }
  }
  if (patch.territoryId !== undefined) {
    const t = optToken(patch.territoryId);
    if (t) next.territoryId = t; else delete next.territoryId;
  }
  next.updatedAt = nowIso();
  await dealers.put(next);
  return next;
}

/** Delete a dealer + CASCADE its outlets (children-first — retryable on failure). */
export async function deleteDealer(tenantId: string, orgId: string, dealerId: string): Promise<number> {
  await getDealer(tenantId, orgId, dealerId); // 404 + IDOR
  let removed = 0;
  for (const o of scoped(await outlets.listForTenantIndexed(tenantId), tenantId, orgId).filter((o) => o.dealerId === dealerId)) {
    await outlets.delete(o.outletId);
    removed += 1;
  }
  await dealers.delete(dealerId);
  return removed + 1;
}

// ── Outlets ──────────────────────────────────────────────────────────────────
export async function createOutlet(tenantId: string, orgId: string, dealerId: string, input: Record<string, unknown>, actor: string): Promise<Outlet> {
  void actor;
  await getDealer(tenantId, orgId, dealerId); // outlet is owned by a real dealer
  if (scoped(await outlets.listForTenantIndexed(tenantId), tenantId, orgId).filter((o) => o.dealerId === dealerId).length >= MAX.perDealerOutlets) throw new OpenwopError('validation_error', `This dealer has the maximum ${MAX.perDealerOutlets} outlets.`, 409, { max: MAX.perDealerOutlets });
  const now = nowIso();
  const outlet: Outlet = {
    outletId: `outlet:${randomUUID()}`,
    tenantId,
    orgId,
    dealerId,
    name: requireName(input.name),
    status: assertStatus(input.status, ['active', 'closed'] as const, 'status', 'active'),
    createdAt: now,
    updatedAt: now,
    ...(cleanString(input.address, MAX.address, '') ? { address: cleanString(input.address, MAX.address, '') } : {}),
    ...(optGeo(input.lat, 'lat', 90) !== undefined ? { lat: optGeo(input.lat, 'lat', 90) } : {}),
    ...(optGeo(input.lng, 'lng', 180) !== undefined ? { lng: optGeo(input.lng, 'lng', 180) } : {}),
  };
  await outlets.put(outlet);
  return outlet;
}

export async function listOutlets(tenantId: string, orgId: string, filter: { dealerId?: string } = {}): Promise<Outlet[]> {
  let rows = scoped(await outlets.listForTenantIndexed(tenantId), tenantId, orgId);
  if (filter.dealerId) rows = rows.filter((o) => o.dealerId === filter.dealerId);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getOutlet(tenantId: string, orgId: string, outletId: string): Promise<Outlet> {
  const o = await outlets.get(outletId);
  if (!o || o.tenantId !== tenantId || o.orgId !== orgId) throw new OpenwopError('not_found', 'Outlet not found.', 404, { outletId });
  return o;
}

export async function updateOutlet(tenantId: string, orgId: string, outletId: string, patch: Record<string, unknown>, actor: string): Promise<Outlet> {
  void actor;
  const existing = await getOutlet(tenantId, orgId, outletId);
  const next: Outlet = { ...existing };
  if (patch.name !== undefined) next.name = requireName(patch.name);
  if (patch.status !== undefined) next.status = assertStatus(patch.status, ['active', 'closed'] as const, 'status', existing.status);
  if (patch.address !== undefined) { const a = cleanString(patch.address, MAX.address, ''); if (a) next.address = a; else delete next.address; }
  if (patch.lat !== undefined) { const v = optGeo(patch.lat, 'lat', 90); if (v !== undefined) next.lat = v; else delete next.lat; }
  if (patch.lng !== undefined) { const v = optGeo(patch.lng, 'lng', 180); if (v !== undefined) next.lng = v; else delete next.lng; }
  next.updatedAt = nowIso();
  await outlets.put(next);
  return next;
}

export async function deleteOutlet(tenantId: string, orgId: string, outletId: string): Promise<void> {
  await getOutlet(tenantId, orgId, outletId); // 404 + IDOR
  await outlets.delete(outletId);
}

/** Suspend every active dealer that references a now-deleted CRM company
 *  (DEAL-DATA-2 / ADR 0283). Non-destructive + reversible: the dealer keeps its
 *  outlets/registrations but is flagged `suspended` so a dangling-company dealer
 *  can't read as active. Returns the count suspended. */
export async function suspendDealersForCompany(tenantId: string, orgId: string, companyId: string): Promise<number> {
  let n = 0;
  for (const d of scoped(await dealers.listForTenantIndexed(tenantId), tenantId, orgId).filter((d) => d.companyId === companyId && d.status === 'active')) {
    await dealers.put({ ...d, status: 'suspended', updatedAt: nowIso() });
    n += 1;
  }
  return n;
}

