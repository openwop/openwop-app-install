/**
 * CRM e-signature API client (ADR 0402 §b).
 *   Authed (operator):  /host/openwop-app/crm/orgs/:orgId/sign-requests/*
 *   Public (signer):    /host/openwop-app/public-sign/:token/*   (no auth)
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { CrmRequestError } from './crmRequestError.js';

export type SignerStatus = 'pending' | 'signed' | 'declined';
export type SignRequestStatus = 'draft' | 'sent' | 'partially_signed' | 'completed' | 'declined' | 'voided';

export interface SignerView {
  signerId: string;
  email: string;
  name?: string;
  order?: number;
  status: SignerStatus;
  signedAt?: string;
  audit?: { ipHash: string; userAgentHash: string };
}

export interface SignRequestView {
  signRequestId: string;
  title: string;
  status: SignRequestStatus;
  target: { kind: string; id: string };
  createdAt: string;
  completedAt?: string;
  certificateUrl?: string;
  signers: SignerView[];
}

const root = `${config.baseUrl}/host/openwop-app`;
const orgBase = (orgId: string): string => `${root}/crm/orgs/${encodeURIComponent(orgId)}/sign-requests`;
const pubBase = `${root}/public-sign`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });
const publicHeaders = (): Record<string, string> => ({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    let reason = '';
    try {
      const body = (await res.json()) as { message?: string; details?: { reason?: string } };
      detail = body?.message ?? '';
      reason = body?.details?.reason ?? '';
    } catch { /* non-JSON */ }
    // CRM-UX-14 — a `CrmRequestError` (status-carrying) so `crmActionError`
    // can name the status in the user's language; `reason` rides on top for
    // the typed sign-flow refusals the public page maps itself.
    const err = new CrmRequestError(detail || `${ctx} returned ${res.status}`, res.status) as CrmRequestError & { reason?: string };
    if (reason) err.reason = reason;
    throw err;
  }
  return (await res.json()) as T;
}

// ── authed operator ──────────────────────────────────────────────────────────

export async function listSignRequests(orgId: string): Promise<SignRequestView[]> {
  const res = await fetch(orgBase(orgId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ signRequests: SignRequestView[] }>(res, 'listSignRequests')).signRequests;
}

export async function requestSignature(
  orgId: string,
  input: { target: { kind: string; id: string }; signers: { email: string; name?: string; order?: number }[] },
): Promise<SignRequestView> {
  const res = await fetch(orgBase(orgId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<SignRequestView>(res, 'requestSignature');
}

export async function voidSignRequest(orgId: string, signRequestId: string): Promise<{ status: SignRequestStatus }> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(signRequestId)}/void`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson<{ status: SignRequestStatus }>(res, 'voidSignRequest');
}

// ── public signer ────────────────────────────────────────────────────────────

export interface SignPublicView {
  signRequestId: string;
  title: string;
  status: SignRequestStatus;
  signerId: string;
  signerEmail: string;
  signerStatus: SignerStatus;
  yourTurn: boolean;
  contentMarkdown: string;
  legalNotice: string;
  /** R2 S1R2-5 — who is asking, when, and (returning signer) when you signed. */
  requestedAt?: string;
  requestedBy?: { name?: string; email?: string };
  signedAt?: string;
}

export async function getSignView(token: string): Promise<SignPublicView> {
  const res = await fetch(`${pubBase}/${encodeURIComponent(token)}`, fetchOpts({ headers: publicHeaders() }));
  return asJson<SignPublicView>(res, 'getSignView');
}

export async function submitSignature(token: string, typedName: string): Promise<{ status: SignRequestStatus; signedAt: string; certificateEmailPlanned?: boolean }> {
  // R2 S-G2 — the server refuses a signature without the explicit acknowledgment.
  const res = await fetch(`${pubBase}/${encodeURIComponent(token)}/sign`, fetchOpts({ method: 'POST', headers: publicHeaders(), body: JSON.stringify({ typedName, acknowledged: true }) }));
  // `signedAt` is the SERVER's signature instant, matching the durable record —
  // the signer's downloadable copy must never be dated by their own clock.
  return asJson<{ status: SignRequestStatus; signedAt: string; certificateEmailPlanned?: boolean }>(res, 'submitSignature');
}

export async function declineSignature(token: string): Promise<{ status: SignRequestStatus }> {
  const res = await fetch(`${pubBase}/${encodeURIComponent(token)}/decline`, fetchOpts({ method: 'POST', headers: publicHeaders() }));
  return asJson<{ status: SignRequestStatus }>(res, 'declineSignature');
}
