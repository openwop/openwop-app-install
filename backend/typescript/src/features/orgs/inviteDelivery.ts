/**
 * Invite email delivery (Deferred-Plan Phase A; extends ADR 0004 with
 * ADR 0193 real sending). Host-initiated TRANSACTIONAL send of the accept
 * link — composed from the existing owners only:
 *   - transport: `makeBrokeredCampaignProvider` (the inviter's brokered
 *     email connection; throws `credential_required` when none — we catch
 *     and fail SOFT to the copy-link UX);
 *   - sender identity: the org's `EmailSettings.senderAddress` (absent ⇒ skip);
 *   - send-once: the adapter's idempotency ledger via a deterministic
 *     `org-invite:<inviteId>` key — a route retry never double-sends.
 *
 * SECURITY: the accept link (which embeds the one-time token) is composed
 * here, handed ONLY to the provider payload, and never logged — log lines
 * carry the inviteId and outcome only. This is the delivery channel; the API
 * response's token exposure stays governed by EXPOSE_TOKENS (non-prod echo),
 * unchanged.
 */
import type { Storage } from '../../storage/storage.js';
import { OpenwopError } from '../../types.js';
import { makeBrokeredCampaignProvider } from '../email/brokeredProvider.js';
import { getEmailSettings } from '../email/emailService.js';
import { createLogger } from '../../observability/logger.js';
import { getOrg } from '../../host/accessControlService.js';
import type { OrgInvitation } from './invitationsService.js';

const log = createLogger('features.orgs.inviteDelivery');

/** R2 review F1 — 'skipped' alone conflated three causes with three different
 *  operator fixes. The reason rides along so the route/UI can tell the truth:
 *  `no_sender`/`no_connection` = configuration, `send_failed` = transient. */
export type InviteDeliveryOutcome = { outcome: 'sent' } | { outcome: 'skipped'; reason: 'no_sender' | 'no_connection' | 'send_failed' };

export interface DeliverInviteInput {
  storage: Storage;
  tenantId: string;
  /** The inviter (route caller) — the broker resolves THEIR email connection. */
  actingUserId: string | undefined;
  invite: OrgInvitation;
  /** The one-time token (plaintext exists only in this request's scope). */
  token: string;
  /** `publicBaseUrl(req)` — the deploy's public origin for the accept link. */
  baseUrl: string;
  /** ADR 0622 D2 — the executing run when the send is brokered from inside a
   *  workflow (`ctx.features.orgs.invite`), so `stampConnectionUse` records the
   *  REAL run's connection use instead of the provider's synthetic route id. */
  runId?: string;
}

/** Best-effort transactional delivery. NEVER throws — an invite must succeed
 *  even when no email transport is configured (copy-link remains the UX). */
export async function deliverInviteEmail(input: DeliverInviteInput): Promise<InviteDeliveryOutcome> {
  const { storage, tenantId, actingUserId, invite, token, baseUrl, runId } = input;
  try {
    if (!actingUserId) return { outcome: 'skipped', reason: 'no_connection' }; // no caller identity → no connection to broker
    const settings = await getEmailSettings(tenantId, invite.orgId);
    const from = settings?.senderAddress;
    if (!from) return { outcome: 'skipped', reason: 'no_sender' }; // no verified sender identity for this org

    const provider = await makeBrokeredCampaignProvider({
      storage, tenantId, orgId: invite.orgId, actingUserId,
      ...(runId ? { runId } : {}),
      purpose: 'transactional', // ADR 0655 D1 — an invite is not marketing: a bounced address's owner still gets it,
    });

    const acceptUrl = `${baseUrl.replace(/\/$/, '')}/invitations/accept?token=${encodeURIComponent(token)}`;
    // R2 IN-SP-4 — the email must name WHO invited and WHICH org (an email
    // asking you to click a token link with neither is the phishing shape the
    // competitors' invite emails exist to avoid), and the expiry must be a
    // human date, not a raw ISO instant.
    const org = await getOrg(invite.orgId);
    const clean = (v: string): string => v.replace(/[\r\n]+/g, ' ');
    const orgName = clean(org?.name ?? 'an organization');
    const inviter = invite.createdByName && !invite.createdByName.includes('@') ? clean(invite.createdByName) : undefined;
    const expiresDay = invite.expiresAt.slice(0, 10);
    await provider.send({
      from,
      to: invite.email,
      subject: inviter ? `${inviter} invited you to join ${orgName}` : `You've been invited to join ${orgName}`,
      body:
        `${inviter ? `${inviter} has invited you` : 'You have been invited'} to join ${orgName} as ${invite.role}.\n\n` +
        `Accept your invitation:\n${acceptUrl}\n\n` +
        `This link is single-use and expires on ${expiresDay}. ` +
        `If you were not expecting this invitation, you can ignore this email.`,
      // Send-once: deterministic per invite — a route retry (same inviteId)
      // dedups in the adapter's sent-ledger; a NEW invite gets a new key.
      idempotencyKey: `org-invite:${invite.inviteId}`,
    });
    log.info('org_invite_emailed', { tenantId, orgId: invite.orgId, inviteId: invite.inviteId });
    return { outcome: 'sent' };
  } catch (err) {
    // credential_required (no connection), provider rejects, transient errors —
    // all fail SOFT. Outcome only; the link/token never reaches a log line.
    // Coarse reason only — a provider error body can ECHO our payload (which
    // contains the accept link), so err.message must never reach a log line.
    const reason = err instanceof Error && err.message === 'sender_address_missing' ? 'no_sender'
      : err instanceof OpenwopError && err.code === 'credential_required' ? 'no_connection'
      : 'send_failed';
    log.info('org_invite_email_skipped', { tenantId, orgId: invite.orgId, inviteId: invite.inviteId, reason });
    return { outcome: 'skipped', reason };
  }
}
