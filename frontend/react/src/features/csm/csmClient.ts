/**
 * CSM feature client (host-extension, non-normative). Wraps
 * /v1/host/sample/csm/*. 404s when the CSM toggle is off.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Account {
  accountId: string;
  tenantId: string;
  name: string;
  healthScore: number;
  createdAt: string;
  updatedAt: string;
}

const base = `${config.baseUrl}/v1/host/sample/csm`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listAccounts(): Promise<Account[]> {
  const res = await fetch(`${base}/accounts`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ accounts: Account[] }>(res, 'listAccounts')).accounts;
}

export async function createAccount(input: { name: string; healthScore?: number }): Promise<Account> {
  const res = await fetch(`${base}/accounts`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Account>(res, 'createAccount');
}

export async function deleteAccount(accountId: string): Promise<void> {
  const res = await fetch(`${base}/accounts/${encodeURIComponent(accountId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new Error(`deleteAccount returned ${res.status}`);
}
