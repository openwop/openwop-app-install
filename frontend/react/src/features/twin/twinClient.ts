/**
 * Digital-twin client (ADR 0044, Phase 3) — drives the two host-extension twin
 * surfaces (gated by the `twin-recall` toggle; backend is the authority):
 *   - admin LINK  /v1/host/openwop-app/agents/:id/twin            (GET/PUT/DELETE)
 *   - user GRANT  /v1/host/openwop-app/profiles/me/twin-grants    (GET/POST/DELETE)
 *
 * A LINK (admin) says "this agent is a twin of person X"; a GRANT (only person X)
 * is the consent that lets the agent recall X's memory/knowledge. Fail-closed:
 * recall needs an active grant — a link alone confers nothing.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type TwinScope = 'memory' | 'knowledge';
export interface TwinLink { userId: string; linkedBy: string; linkedAt: string }
export interface TwinGrantView { scopes: TwinScope[]; version: number; grantedAt: string }
export interface AgentTwinView { link: TwinLink | null; grant: TwinGrantView | null }
/** A grant as the issuing user sees it (one per agent). */
export interface MyTwinGrant { agentId: string; scopes: TwinScope[]; version: number; grantedAt: string; status?: string }

const base = `${config.baseUrl}/v1/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw new Error(`${ctx} failed (${res.status})`);
  return res.json() as Promise<T>;
}

// ── admin LINK (agent side) ──
export async function getAgentTwin(agentId: string): Promise<AgentTwinView> {
  return asJson<AgentTwinView>(await fetch(`${base}/agents/${encodeURIComponent(agentId)}/twin`, fetchOpts({ headers: authedHeaders() })), 'getAgentTwin');
}

export async function linkTwinToUser(agentId: string, userId: string): Promise<AgentTwinView> {
  await asJson(await fetch(`${base}/agents/${encodeURIComponent(agentId)}/twin`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ userId }) })), 'linkTwinToUser');
  return getAgentTwin(agentId);
}

export async function unlinkTwin(agentId: string): Promise<void> {
  const res = await fetch(`${base}/agents/${encodeURIComponent(agentId)}/twin`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`unlinkTwin failed (${res.status})`);
}

// ── user GRANT (self) ──
export async function listMyGrants(): Promise<MyTwinGrant[]> {
  return (await asJson<{ grants: MyTwinGrant[] }>(await fetch(`${base}/profiles/me/twin-grants`, fetchOpts({ headers: authedHeaders() })), 'listMyGrants')).grants;
}

export async function grantRecall(agentId: string, scopes: TwinScope[]): Promise<void> {
  await asJson(await fetch(`${base}/profiles/me/twin-grants`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ agentId, scopes }) })), 'grantRecall');
}

export async function revokeRecall(agentId: string): Promise<void> {
  const res = await fetch(`${base}/profiles/me/twin-grants/${encodeURIComponent(agentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`revokeRecall failed (${res.status})`);
}
