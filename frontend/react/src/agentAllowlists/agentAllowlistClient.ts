/**
 * Agent tool-allowlist admin client (ADR 0104) — the super-admin surface under
 * /v1/host/openwop-app/agent-allowlists/admin/*. Reads an agent's manifest vs
 * override vs effective tool list + the tool catalog, and sets/clears a per-agent
 * override the dispatcher applies. Backend is authority (super-admin gated there).
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';

export interface AllowlistOverride {
  overrideId: string;
  tenantId: string;
  agentId: string;
  toolAllowlist: string[];
  note?: string;
  updatedBy: string;
  updatedAt: string;
}
export interface AgentAllowlistRow {
  agentId: string;
  label: string;
  persona: string;
  manifestAllowlist: string[];
  override: AllowlistOverride | null;
}
export interface AgentAllowlistDetail extends AgentAllowlistRow {
  effective: string[];
  toolCatalog: string[];
}

const base = `${config.baseUrl}/v1/host/openwop-app/agent-allowlists/admin`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listAgentAllowlists(): Promise<AgentAllowlistRow[]> {
  const res = await fetch(`${base}/agents`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ agents: AgentAllowlistRow[] }>(res, 'listAgentAllowlists')).agents;
}

export async function getAgentAllowlist(agentId: string): Promise<AgentAllowlistDetail> {
  const res = await fetch(`${base}/agents/${encodeURIComponent(agentId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<AgentAllowlistDetail>(res, 'getAgentAllowlist');
}

export async function setAgentAllowlist(agentId: string, toolAllowlist: string[], note?: string): Promise<AllowlistOverride> {
  const res = await fetch(`${base}/agents/${encodeURIComponent(agentId)}`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ toolAllowlist, ...(note ? { note } : {}) }) }));
  return asJson<AllowlistOverride>(res, 'setAgentAllowlist');
}

export async function clearAgentAllowlist(agentId: string): Promise<void> {
  const res = await fetch(`${base}/agents/${encodeURIComponent(agentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 404) throw new Error(`clearAgentAllowlist returned ${res.status}`);
}
