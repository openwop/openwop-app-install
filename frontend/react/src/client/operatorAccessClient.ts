/**
 * ADR 0910 D3/D11 — just-in-time operator access on a system-owned default
 * workspace (`host-kicktodo`). Host-local routes under `/host/openwop-app/*`.
 *
 * The activation POST carries a FRESH ID token the caller just obtained by
 * re-authenticating (`reauthenticateForStepUp`): the server requires `auth_time`
 * at most 15 minutes old, which neither the cached token nor the session cookie
 * can prove. `authedHeaders()` overwrites any `authorization` passed through
 * `extra`, so the fresh bearer is set AFTER it.
 */
import { authedHeaders, config, fetchOpts } from './config.js';
import { ApiError } from './requestJson.js';
import { readErrorMessage } from './errorEnvelope.js';

export interface OperatorActivation {
  activationId: string;
  workspaceId: string;
  subject: string;
  justification: string;
  activatedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

const path = (workspaceId: string): string =>
  `${config.baseUrl}/host/openwop-app/workspaces/${encodeURIComponent(workspaceId)}/operator-access`;

async function failure(res: Response, ctx: string): Promise<never> {
  let body: unknown;
  try { body = await res.json(); } catch { body = undefined; }
  const detail = readErrorMessage(body) ?? '';
  throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, body, message: detail || `${ctx} returned ${res.status}` });
}

export async function listOperatorActivations(workspaceId: string): Promise<OperatorActivation[]> {
  const res = await fetch(path(workspaceId), fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) return failure(res, 'listOperatorActivations');
  return ((await res.json()) as { activations: OperatorActivation[] }).activations;
}

export async function activateOperatorAccess(
  workspaceId: string,
  body: { justification: string; durationMinutes: number },
  freshIdToken: string,
): Promise<OperatorActivation> {
  const headers = { ...authedHeaders({ 'content-type': 'application/json' }), authorization: `Bearer ${freshIdToken}` };
  const res = await fetch(path(workspaceId), fetchOpts({ method: 'POST', headers, body: JSON.stringify(body) }));
  if (!res.ok) return failure(res, 'activateOperatorAccess');
  return ((await res.json()) as { activation: OperatorActivation }).activation;
}

/** End your own activation now. */
export async function endOperatorAccess(workspaceId: string): Promise<void> {
  const res = await fetch(path(workspaceId), fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await failure(res, 'endOperatorAccess');
}
