/**
 * CSM feature client (host-extension, non-normative). Wraps
 * /host/openwop-app/csm/*. 404s when the CSM toggle is off.
 *
 * ADR 0212 (CSM↔CRM linkage) also adds `listOrgs`/`listCrmCompanies` here,
 * hitting CRM's org-scoped routes directly rather than importing
 * `features/crm/crmOrgClient.js` — checked for precedent first (grep across
 * `frontend/react/src/features/*`) and found NONE: every other feature that
 * needs `listOrgs` (chatWidgetClient, promptLibraryClient, scheduledChatsClient,
 * evalsClient, advisoryBoardClient) defines its OWN copy hitting the shared
 * `/host/openwop-app/orgs` route rather than importing another feature's
 * client module. This mirrors that convention (own copy, read-only) instead of
 * inventing a new cross-feature-client-import pattern.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface CrmRef {
  orgId: string;
  companyId: string;
}

export interface HealthFactor {
  factor: string;
  weight: number;
  value: number;
}

/** ADR 0582 §5 — which arithmetic produced `healthFactors`. Two in-tree
 *  producers emit the same `{factor, weight, value}` header shape from
 *  DIFFERENT formulas, so the numbers are meaningless without this. */
export type HealthMethod = 'penalty-sum' | 'weighted-mean';

export interface Account {
  accountId: string;
  tenantId: string;
  name: string;
  /** ADR 0582 §4 — ABSENT MEANS NEVER SCORED. It is not a low score, a mid
   *  score, or a healthy one; render it as a state, never as a number. */
  healthScore?: number;
  crmRef?: CrmRef;
  healthFactors?: HealthFactor[];
  healthComputedAt?: string;
  /** ADR 0582 §5 — the arithmetic behind `healthFactors`. */
  healthMethod?: HealthMethod;
  /** ADR 0582 §4 — the last automated measurement REFUSED to score, and why.
   *  Any `healthScore` present alongside these PREDATES the failure. */
  healthMeasureFailedAt?: string;
  healthMeasureFailedReason?: string;
  /** CRM-3 — first-class commercial depth (all optional). `arr` in major units. */
  renewalDate?: string;
  arr?: number;
  /** R2 CS-SP-2 — ISO 4217 code for `arr` (absent = unitless legacy row). */
  arrCurrency?: string;
  owner?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Org {
  orgId: string;
  name: string;
}

export interface CrmCompany {
  companyId: string;
  name: string;
}

const base = `${config.baseUrl}/host/openwop-app/csm`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/**
 * ADR 0582 §6 (CSM-UX-3) — a TYPED failure the UI can map to its own copy.
 *
 * Every function here used to throw a bare `Error`, so the page's
 * `err instanceof Error ? err.message : t(…)` idiom ALWAYS took the first arm:
 * four localized failure strings × four locales — sixteen translations — were
 * unreachable by construction, and every failure rendered raw English server
 * text (announced assertively, as the whole message body) regardless of the
 * user's locale. Carrying the status lets the page choose a localized sentence
 * and demote the server's words to a detail line.
 */
export class CsmRequestError extends Error {
  readonly status: number;
  /** The server's own `message`, when it sent one. Never the primary copy. */
  readonly detail: string | undefined;
  constructor(op: string, status: number, detail?: string) {
    super(detail || `${op} returned ${status}`);
    this.name = 'CsmRequestError';
    this.status = status;
    this.detail = detail || undefined;
  }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new CsmRequestError(ctx, res.status, detail);
  }
  return (await res.json()) as T;
}

export async function listAccounts(): Promise<Account[]> {
  const res = await fetch(`${base}/accounts`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ accounts: Account[] }>(res, 'listAccounts')).accounts;
}

export async function createAccount(input: { name: string; healthScore?: number; crmRef?: CrmRef; renewalDate?: string; arr?: number; owner?: string ; arrCurrency?: string }): Promise<Account> {
  const res = await fetch(`${base}/accounts`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Account>(res, 'createAccount');
}

/** ADR 0582 §4 — `healthScore: null` CLEARS the score back to unscored; that is
 *  the affordance for an operator who no longer trusts the number. */
export async function updateAccount(accountId: string, patch: { name?: string; healthScore?: number | null; crmRef?: CrmRef | null; renewalDate?: string | null; arr?: number | null; owner?: string | null ; arrCurrency?: string | null }): Promise<Account> {
  const res = await fetch(`${base}/accounts/${encodeURIComponent(accountId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Account>(res, 'updateAccount');
}

export async function deleteAccount(accountId: string): Promise<void> {
  const res = await fetch(`${base}/accounts/${encodeURIComponent(accountId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new CsmRequestError('deleteAccount', res.status);
}

/** ADR 0212 §4 — the org picker for linking an Account to a CRM company. Hits
 *  the shared `/orgs` route directly (see file header — no cross-feature
 *  client import precedent exists). */
export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

/** ADR 0212 §4 — the company picker (once an org is chosen). Hits CRM's
 *  org-scoped route directly (csm→crm direction only; see file header). */
export async function listCrmCompanies(orgId: string): Promise<CrmCompany[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ companies: CrmCompany[] }>(res, 'listCrmCompanies')).companies;
}
