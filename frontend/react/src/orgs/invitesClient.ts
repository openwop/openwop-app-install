/**
 * Org email-token invitations client (ADR 0004; UX-ASSESSMENT AUTH-3).
 * Wraps the `orgs` feature's host-extension routes — the flow accessControl
 * deliberately lacks: invite by EMAIL, pending lifecycle, revoke, accept.
 *
 * Delivery note: the backend returns the one-time token only when the host
 * exposes it (non-production); the UI turns it into a copyable accept link.
 * Email delivery of the link composes ADR 0193 sending as a follow-up — the
 * service stores only a token hash either way.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { ApiError } from '../client/requestJson.js';
import type { OrgMember } from '../client/accessClient.js';

export interface OrgInvite {
  inviteId: string;
  orgId: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
  /** ORGINV-4 — server-marked expiry (the row lingers up to 30d for the audit
   *  buffer; the server says whether it is still acceptable). Optional for
   *  backward compatibility with hosts that predate the marker. */
  expired?: boolean;
  /** ORGINV-UX-9 — WHO issued it (the backend projects `displayName || email`
   *  at mint, `orgs/routes.ts`). Optional: rows minted before the field was
   *  recorded, and hosts that predate it, carry none. */
  createdByName?: string;
  /** ADR 0564 D1/D4 — recipient-side terminal state. Absent = pending (the
   *  older-wire default). A declined row persists until its ordinary age-out
   *  so the INVITER can see the refusal (the whole point of the ADR). */
  status?: InvitationStatus;
  /** ADR 0564 — when the recipient declined (set with `status: 'declined'`). */
  declinedAt?: string;
}

/** ADR 0564 — the row's lifecycle state on the wire. */
export type InvitationStatus = 'pending' | 'declined';

/** The `details.reason` codes the invitation routes put on their error
 *  envelopes (`invitationsService.inviteErrorToHttp`): `expired` (400),
 *  `declined` (400 — the token holder refused it; ADR 0564), `email_unverified`
 *  (403 — the caller's address was self-set, ADR 0622 D7), `invalid_email`
 *  (400 on create), `undeliverable` / `delivery_failed` (422 on create). A 403
 *  with NO reason is the plain email-ownership mismatch. */
export type InviteErrorReason = 'expired' | 'declined' | 'email_unverified' | 'invalid_email' | 'undeliverable' | 'delivery_failed';

/** The create 422 may carry `details.priorInviteStillValid: true` (ADR 0622
 *  D5 / ORGINV-7): the re-invite's delivery failed and was rolled back, and
 *  the EARLIER invitation for this address is still valid. */
export interface InviteErrorDetails { reason?: InviteErrorReason; priorInviteStillValid?: boolean }

/** Read the typed `details` off a thrown invitation error (an `ApiError`
 *  carrying the parsed envelope) — never by matching English prose. */
export function inviteErrorDetails(err: unknown): InviteErrorDetails {
  const body = (err as { body?: { details?: InviteErrorDetails } } | null)?.body;
  return body?.details ?? {};
}

const base = `${config.baseUrl}/host/openwop-app/orgs`;
const headers = () => ({ 'content-type': 'application/json', ...authedHeaders() });

/** Resolve a JSON body, surfacing the host's error envelope message when present
 *  (the per-client convention — see accessClient's local twin). */
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    let body: unknown;
    try {
      body = await res.json();
      const b = body as { error?: { message?: string }; message?: string };
      detail = b?.error?.message ?? b?.message ?? '';
    } catch { /* non-JSON error body */ }
    // R2 IN-SP-2/8/10 — carry the parsed envelope so the page can read
    // `details.reason` / `error` codes instead of matching English prose.
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, body, message: detail || `${ctx} returned ${res.status}` });
  }
  return (await res.json()) as T;
}

export async function createInvite(orgId: string, email: string, role: string): Promise<{ invite: OrgInvite; token?: string; delivery?: 'sent' | 'skipped' }> {
  const res = await fetch(`${base}/${encodeURIComponent(orgId)}/invites`, fetchOpts({
    method: 'POST', headers: headers(), body: JSON.stringify({ email, role }),
  }));
  return asJson(res, 'createInvite');
}

export async function listInvites(orgId: string): Promise<OrgInvite[]> {
  const res = await fetch(`${base}/${encodeURIComponent(orgId)}/invites`, fetchOpts({ headers: headers() }));
  return (await asJson<{ invites: OrgInvite[] }>(res, 'listInvites')).invites;
}

export async function revokeInvite(orgId: string, inviteId: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`, fetchOpts({
    method: 'DELETE', headers: headers(),
  }));
  if (!res.ok && res.status !== 204) await asJson(res, 'revokeInvite');
}

/** What a token-holder sees BEFORE accepting (UX_UPGRADE-invitations IN-G1). */
export interface InvitePreview { orgId: string; orgName: string; role: string; email: string; expiresAt: string; invitedBy?: string }

/** Resolve an invite token WITHOUT redeeming it. Unauthenticated — the token is
 *  the credential, and a recipient must be able to see what they're joining
 *  before deciding whether to sign in. Strictly non-mutating. */
export async function previewInvite(token: string): Promise<InvitePreview> {
  const res = await fetch(`${base}/invitations/preview?token=${encodeURIComponent(token)}`, fetchOpts({}));
  return asJson(res, 'previewInvite');
}

export async function acceptInvite(token: string): Promise<OrgMember & { alreadyMember?: boolean }> {
  const res = await fetch(`${base}/invitations/accept`, fetchOpts({
    method: 'POST', headers: headers(), body: JSON.stringify({ token }),
  }));
  return asJson(res, 'acceptInvite');
}

/** ADR 0564 D2 — DECLINE the invitation the token names. Same gate chain as
 *  accept (signed-in + the invited address, ADR 0622 D7 provenance), so the
 *  same 403 shapes come back; idempotent 200 on a re-decline. A deliberate
 *  POST after a confirm step — never fired on load (the IN-G1 posture). */
export async function declineInvitation(token: string): Promise<{ inviteId: string; orgId: string; status: 'declined'; declinedAt: string }> {
  const res = await fetch(`${base}/invitations/decline`, fetchOpts({
    method: 'POST', headers: headers(), body: JSON.stringify({ token }),
  }));
  return asJson(res, 'declineInvitation');
}

/** The shareable accept URL for a freshly-issued token (when the host exposes it). */
export function acceptLinkFor(token: string): string {
  return `${window.location.origin}/invitations/accept?token=${encodeURIComponent(token)}`;
}
