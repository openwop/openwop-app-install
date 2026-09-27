/**
 * Approval-delegation client (ADR 0198) — self-service out-of-office coverage.
 *
 *   GET  /host/openwop-app/approval-delegations              — mine (from OR to me)
 *   POST /host/openwop-app/approval-delegations              — create (from me)
 *   POST /host/openwop-app/approval-delegations/{id}/revoke
 *
 * Tenant scoping is the backend's job; the client never sends a tenantId.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';

export interface ApprovalDelegation {
  delegationId: string;
  fromSubject: string;
  toSubject: string;
  startsAt: string;
  endsAt: string;
  reason?: string;
  createdAt: string;
  revokedAt?: string;
}

const base = `${config.baseUrl}/host/openwop-app/approval-delegations`;

function jsonHeaders(): Record<string, string> {
  return { ...authedHeaders(), 'content-type': 'application/json' };
}

async function orThrow<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
  return body;
}

export async function listMyDelegations(): Promise<ApprovalDelegation[]> {
  const res = await fetch(base, fetchOpts({ headers: authedHeaders() }));
  const body = await orThrow<{ delegations: ApprovalDelegation[] }>(res);
  return body.delegations;
}

export async function createDelegation(input: { toSubject: string; startsAt: string; endsAt: string; reason?: string }): Promise<ApprovalDelegation> {
  const res = await fetch(base, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  const body = await orThrow<{ delegation: ApprovalDelegation }>(res);
  return body.delegation;
}

export async function revokeDelegation(delegationId: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(delegationId)}/revoke`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  await orThrow(res);
}
