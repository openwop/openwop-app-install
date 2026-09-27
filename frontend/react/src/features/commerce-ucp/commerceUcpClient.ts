/**
 * UCP admin API client (ADR 0178 Phase 4). Manages the UCP agent CLIENTS a merchant org
 * provisions (client-credentials the external AI agents use) under the authed commerce
 * admin surface `/host/openwop-app/commerce/orgs/:orgId/ucp/*`. The public UCP
 * discovery/OAuth/catalog URLs are DERIVED here (built from the API origin) so the panel
 * can show an agent operator exactly where to point — no extra endpoint needed.
 *
 * NOTE: this is a STANDALONE UCP admin panel (its own `commerce-ucp` feature package)
 * because the commerce admin has no frontend yet (ADR 0177 shipped backend-only). When a
 * commerce admin FE lands, this panel composes into it; until then it stands alone.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export const UCP_SCOPES = ['cart:write', 'checkout:write', 'orders:read'] as const;
export type UcpScope = (typeof UCP_SCOPES)[number];
export interface UcpClient { clientId: string; name: string; scopes: UcpScope[]; createdAt: string }
export interface ProvisionedClient extends UcpClient { clientSecret: string }

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) { let d = ''; try { d = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* */ } throw new Error(d || `${ctx} returned ${res.status}`); }
  return (await res.json()) as T;
}
const ucpBase = (orgId: string): string => `${root}/commerce/orgs/${encodeURIComponent(orgId)}/ucp`;

export async function listOrgs(): Promise<Org[]> {
  return (await asJson<{ orgs: Org[] }>(await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() })), 'listOrgs')).orgs;
}
export async function listUcpClients(orgId: string): Promise<UcpClient[]> {
  return (await asJson<{ clients: UcpClient[] }>(await fetch(`${ucpBase(orgId)}/clients`, fetchOpts({ headers: authedHeaders() })), 'listUcpClients')).clients;
}
export async function provisionUcpClient(orgId: string, name: string, scopes: UcpScope[]): Promise<ProvisionedClient> {
  return asJson<ProvisionedClient>(await fetch(`${ucpBase(orgId)}/clients`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, scopes }) })), 'provisionUcpClient');
}
export async function deleteUcpClient(orgId: string, clientId: string): Promise<void> {
  const res = await fetch(`${ucpBase(orgId)}/clients/${encodeURIComponent(clientId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  // The sibling reads above already surface the server's `message`; a failed
  // REVOKE was the one path still reduced to "deleteUcpClient returned 409",
  // which tells the operator nothing about why the credential is still live.
  if (!res.ok && res.status !== 204) {
    let d = '';
    try { d = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(d || `deleteUcpClient returned ${res.status}`);
  }
}

/** The public UCP endpoints an agent operator points at (derived from the API origin). */
export interface UcpEndpoints { discovery: string; oauth: string; catalog: string; checkout: string }
export function ucpPublicEndpoints(orgId: string): UcpEndpoints {
  const base = `${config.baseUrl}/host/openwop-app/commerce/ucp/orgs/${encodeURIComponent(orgId)}`;
  return {
    discovery: `${base}/.well-known/ucp`,
    oauth: `${base}/.well-known/oauth-authorization-server`,
    catalog: `${base}/catalog`,
    checkout: `${base}/checkout`,
  };
}
