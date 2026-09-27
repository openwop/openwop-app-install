/**
 * Digital-twin client (ADR 0044, Phase 3) — drives the two host-extension twin
 * surfaces (gated by the `twin-recall` toggle; backend is the authority):
 *   - admin LINK  /host/openwop-app/agents/:id/twin            (GET/PUT/DELETE)
 *   - user GRANT  /host/openwop-app/profiles/me/twin-grants    (GET/POST/DELETE)
 *
 * A LINK (admin) says "this agent is a twin of person X"; a GRANT (only person X)
 * is the consent that lets the agent recall X's memory/knowledge. Fail-closed:
 * recall needs an active grant — a link alone confers nothing.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { apiErrorFrom } from '../../client/errorEnvelope.js';
import i18n from '../../i18n/index.js';

export type TwinScope = 'memory' | 'knowledge';
export interface TwinLink { userId: string; linkedBy: string; linkedAt: string }
export interface TwinGrantView { scopes: TwinScope[]; version: number; grantedAt: string }
export interface AgentTwinView { link: TwinLink | null; grant: TwinGrantView | null }
/** A grant as the issuing user sees it (one per agent). */
export interface MyTwinGrant { agentId: string; scopes: TwinScope[]; version: number; grantedAt: string; status?: string }

const base = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** TWIN-UX-6 — localize at the THROW site and prefer the server's own prose.
 *  `fallbackKey` is a full `twin:` key whose copy says what the USER was doing;
 *  the previous `` `${ctx} failed (${status})` `` was developer English in all
 *  four locales AND discarded the backend's actionable message. */
async function ok(res: Response, fallbackKey: string): Promise<Response> {
  if (!res.ok) throw await apiErrorFrom(res, i18n.t(`twin:${fallbackKey}`, { status: res.status }));
  return res;
}
async function asJson<T>(res: Response, fallbackKey: string): Promise<T> {
  return (await ok(res, fallbackKey)).json() as Promise<T>;
}

// ── admin LINK (agent side) ──
export async function getAgentTwin(agentId: string): Promise<AgentTwinView> {
  return asJson<AgentTwinView>(await fetch(`${base}/agents/${encodeURIComponent(agentId)}/twin`, fetchOpts({ headers: authedHeaders() })), 'failedToLoadTwinLink');
}

export async function linkTwinToUser(agentId: string, userId: string): Promise<AgentTwinView> {
  await asJson(await fetch(`${base}/agents/${encodeURIComponent(agentId)}/twin`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ userId }) })), 'actionFailed');
  return getAgentTwin(agentId);
}

/** TWIN-UX-3 (unlink lane) — the route reports whether a link actually existed,
 *  mirroring `revokeRecall` below. A stale second tab that unlinks an already
 *  unlinked agent gets `removed:false`, so the panel can say "there was no twin
 *  link to remove" instead of claiming an act that did not happen. */
export async function unlinkTwin(agentId: string): Promise<{ removed: boolean }> {
  const body = await asJson<{ removed?: boolean }>(
    await fetch(`${base}/agents/${encodeURIComponent(agentId)}/twin`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })),
    'actionFailed',
  );
  return { removed: body.removed === true };
}

// ── user GRANT (self) ──
export async function listMyGrants(): Promise<MyTwinGrant[]> {
  return (await asJson<{ grants: MyTwinGrant[] }>(await fetch(`${base}/profiles/me/twin-grants`, fetchOpts({ headers: authedHeaders() })), 'failedToLoadGrants')).grants;
}

export async function grantRecall(agentId: string, scopes: TwinScope[]): Promise<void> {
  await asJson(await fetch(`${base}/profiles/me/twin-grants`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ agentId, scopes }) })), 'actionFailed');
}

/** TWIN-UX-4 — one row per recall event against MY corpus: `ok` reads (with a
 *  chunks count) and `denied` probes by someone else. Newest-first from the
 *  backend; tenant- and subject-scoped there, fail-closed. */
/** `attempts` (denied rows only, PR 3409 review F3): the row's own deny plus denies
 *  by the same prober rate-suppressed since their last durable row. Absent or
 *  1 ⇒ one attempt. Consumers MUST count `attempts ?? 1`, not rows. */
export interface MyTwinRecall { timestamp: string; outcome: 'ok' | 'denied'; agentId?: string; chunks?: number; scopes?: string[]; runId?: string; reason?: string; attempts?: number }
export async function listMyRecalls(): Promise<MyTwinRecall[]> {
  return (await asJson<{ recalls: MyTwinRecall[] }>(await fetch(`${base}/profiles/me/twin-recalls`, fetchOpts({ headers: authedHeaders() })), 'failedToLoadRecalls')).recalls;
}

/** TWIN-UX-3 / TWIN-UX-25 — the route REPORTS whether anything was removed
 *  instead of 404-ing a benign idempotent re-revoke. Returning it lets the caller
 *  suppress a success notice for a no-op rather than claiming an act that did not
 *  happen. */
export async function revokeRecall(agentId: string): Promise<{ removed: boolean }> {
  const body = await asJson<{ removed?: boolean }>(
    await fetch(`${base}/profiles/me/twin-grants/${encodeURIComponent(agentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })),
    'revokeFailed',
  );
  return { removed: body.removed === true };
}
