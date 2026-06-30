/**
 * ADR 0135 Phase 4 — client for the capability-firewall rule manager.
 * Backend is authority (toggle + authorizeOrgScope); a 404 means the feature is off.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type SafetyTier = 'pure' | 'read' | 'write' | 'exec';
export type Egress = 'none' | 'safe-fetch' | 'host-mediated' | 'host-owned';
export type CapabilityClass = { safetyTier: SafetyTier } | { egress: Egress } | { scope: string };

export interface FirewallRule {
  id: string;
  description: string;
  when: { anyOf?: CapabilityClass[]; with?: CapabilityClass[] };
  verdict: 'deny' | 'require-approval';
  reason: string;
}

export interface Org { orgId: string; name: string }

const baseFor = (orgId: string): string => `${config.baseUrl}/v1/host/openwop-app/capability-firewall/orgs/${encodeURIComponent(orgId)}/rules`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

export type UnknownToolPolicy = 'skip' | 'treat-as-risky';
export interface FirewallView { rules: FirewallRule[]; unknownToolPolicy: UnknownToolPolicy; isDefault: boolean }

export async function getFirewallRules(orgId: string): Promise<FirewallView> {
  const res = await fetch(baseFor(orgId), fetchOpts({ headers: authedHeaders() }));
  return asJson<FirewallView>(res, 'getFirewallRules');
}

export async function setFirewallRules(orgId: string, rules: FirewallRule[], unknownToolPolicy: UnknownToolPolicy): Promise<FirewallView> {
  const res = await fetch(baseFor(orgId), fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ rules, unknownToolPolicy }) }));
  return asJson<FirewallView>(res, 'setFirewallRules');
}
