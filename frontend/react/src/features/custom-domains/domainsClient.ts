/**
 * Custom-domains feature client (ADR 0295 / FNL-UX-3). Wraps
 * /host/openwop-app/custom-domains/*. 404s when the toggle is off.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const base = `${config.baseUrl}/host/openwop-app/custom-domains`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface CustomDomain {
  hostname: string; orgId: string;
  status: 'pending' | 'live' | 'failed';
  verificationToken: string;
  createdAt: string; verifiedAt?: string; lastCheckedAt?: string; lastError?: string;
}
export interface Org { orgId: string; name: string }

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, { headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ orgs?: Org[] }>(res)).orgs ?? [];
}

const orgBase = (orgId: string): string => `${base}/orgs/${encodeURIComponent(orgId)}/domains`;

export async function listDomains(orgId: string): Promise<CustomDomain[]> {
  const res = await fetch(orgBase(orgId), { headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ domains: CustomDomain[] }>(res)).domains;
}

export async function addDomain(orgId: string, hostname: string): Promise<CustomDomain> {
  const res = await fetch(orgBase(orgId), { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ hostname }), ...fetchOpts });
  return (await parse<{ domain: CustomDomain }>(res)).domain;
}

export async function verifyDomain(orgId: string, hostname: string): Promise<CustomDomain> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(hostname)}/verify`, { method: 'POST', headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ domain: CustomDomain }>(res)).domain;
}

export async function removeDomain(orgId: string, hostname: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(hostname)}`, { method: 'DELETE', headers: authedHeaders(), ...fetchOpts });
  await parse<{ ok: boolean }>(res);
}
