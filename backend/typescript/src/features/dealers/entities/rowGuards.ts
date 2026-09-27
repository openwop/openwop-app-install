/**
 * Read-side row validators (ADR 0281) for the dealers collections. Type
 * predicates (`v is T`) so a passing check narrows with no cast; deliberately
 * LENIENT (a validator returning null hides a valid row) — core identity +
 * load-bearing discriminants only.
 */
import type { Dealer, Outlet } from './dealer.js';
import type { DealRegistration, PartnerToken } from './registration.js';

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNeStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const identified = (v: unknown, idKey: string): v is Rec => isObj(v) && isNeStr(v[idKey]) && isNeStr(v.tenantId) && isNeStr(v.orgId);

function isDealer(v: unknown): v is Dealer {
  return identified(v, 'dealerId') && isNeStr(v.companyId) && isNeStr(v.name) && (v.status === 'active' || v.status === 'suspended');
}
function isOutlet(v: unknown): v is Outlet {
  return identified(v, 'outletId') && isNeStr(v.dealerId) && isNeStr(v.name) && (v.status === 'active' || v.status === 'closed');
}
function isRegistration(v: unknown): v is DealRegistration {
  return identified(v, 'regId') && isNeStr(v.dealerId) && isNeStr(v.dealTitle) && (v.status === 'pending' || v.status === 'approved' || v.status === 'rejected');
}
function isPartnerToken(v: unknown): v is PartnerToken {
  return identified(v, 'token') && isNeStr(v.dealerId);
}

export const validateDealer = (v: unknown): Dealer | null => (isDealer(v) ? v : null);
export const validateOutlet = (v: unknown): Outlet | null => (isOutlet(v) ? v : null);
export const validateRegistration = (v: unknown): DealRegistration | null => (isRegistration(v) ? v : null);
export const validatePartnerToken = (v: unknown): PartnerToken | null => (isPartnerToken(v) ? v : null);
