/**
 * ADR 0478 — clients for the approval SLA policy (tenant-level) and the
 * recipient's email-delivery opt-in. Small and builder-independent.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';

export interface ApprovalSlaPolicyDTO {
  enabled: boolean;
  remindAfterMs?: number;
  escalateAfterMs?: number;
  expireAfterMs?: number;
}

export async function getSlaPolicy(): Promise<ApprovalSlaPolicyDTO> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/approvals/sla-policy`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`sla_policy_${res.status}`);
  return (await res.json()) as ApprovalSlaPolicyDTO;
}

export async function putSlaPolicy(body: ApprovalSlaPolicyDTO): Promise<ApprovalSlaPolicyDTO> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/approvals/sla-policy`,
    fetchOpts({ method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) }),
  );
  if (!res.ok) {
    const payload = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(payload?.message ?? `sla_policy_put_${res.status}`);
  }
  return (await res.json()) as ApprovalSlaPolicyDTO;
}

export interface EmailApprovalPrefDTO {
  email?: string;
  enabled: boolean;
}

export async function getEmailApprovalPref(): Promise<EmailApprovalPrefDTO> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/approvals/email-pref`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`email_pref_${res.status}`);
  return (await res.json()) as EmailApprovalPrefDTO;
}

export async function putEmailApprovalPref(body: { email: string; enabled: boolean }): Promise<EmailApprovalPrefDTO> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/approvals/email-pref`,
    fetchOpts({ method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) }),
  );
  if (!res.ok) {
    const payload = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(payload?.message ?? `email_pref_put_${res.status}`);
  }
  return (await res.json()) as EmailApprovalPrefDTO;
}
