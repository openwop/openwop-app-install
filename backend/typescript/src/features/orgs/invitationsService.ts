/**
 * Org invitations (ADR 0004, reconciled). The Organizations / members / roles
 * model is owned by the pre-existing `accessControl` surface (RFC 0049 roles —
 * tenant is the isolation boundary, an org is a grouping inside it). This module
 * adds the ONE thing accessControl lacks: an email-token invitation flow to
 * onboard a person as a member of an org. It owns NO org/member state — it
 * DELEGATES to `accessControlService` (single source of truth, finding: the
 * orgs namespace collision). The original ADR-0004 draft's org===tenant model,
 * membership tier, active-org switch, and personal-org were removed as
 * duplicative of accessControl; see the amended ADR.
 *
 * SECRET HANDLING: tokens are returned once and stored only as sha256 hashes
 * with a 7-day expiry. ACCEPT is fail-closed and single-use; the email-ownership
 * policy is stated at `assertEmailOwnership` (ADR 0622 D7 / `ORGINV-9`).
 *
 * LIFECYCLE EVENTS (ADR 0622 D1) — `emit.ts`: `created` from the ONE
 * composition owner `createInvitationAndDeliver` (route AND workflow surface),
 * `accepted` from the ONE site after `acceptInvitation`'s claim/restore
 * try-catch, `declined` from the CAS-won transition in `declineInvitation`;
 * `revoked` is the admin ROUTE's (revokeInvitation is also the D5 rollback
 * primitive and must not fan out). Ids only — never the email, never the token.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { hashToken, mintToken } from '../../host/capabilityToken.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { createMember, getOrg, isBuiltInRoleId, listMembers, type OrgMember } from '../../host/accessControlService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { OpenwopError } from '../../types.js';
import type { Storage } from '../../storage/storage.js';
import type { HostEventOrigin } from '../../host/hostEventDispatcher.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { getEmailSettings } from '../email/emailService.js';
import { effectiveEmailProvenance, type User } from '../users/usersService.js';
import { deliverInviteEmail, type InviteDeliveryOutcome } from './inviteDelivery.js';
import { invitationAccepted, invitationCreated, invitationDeclined, type SupersededStatus } from './emit.js';

const log = createLogger('features.orgs.invitations');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Roles an invitation may grant — built-in accessControl roles, never `owner`
 *  (ownership is granted explicitly through accessControl, not by invite). */
export type InvitableRole = 'viewer' | 'editor' | 'admin';
const INVITABLE_ROLES: readonly InvitableRole[] = ['viewer', 'editor', 'admin'];

export interface OrgInvitation {
  inviteId: string;
  tenantId: string;
  orgId: string;
  email: string;
  role: InvitableRole;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  /** R2 IN-SP-11 — WHO invited (additive; absent on pre-R2 rows). The stable
   *  subject plus the display name captured at mint, so the preview and the
   *  email can name the inviter — the recipient's primary phishing check. */
  createdBy?: string;
  createdByName?: string;
  /** ADR 0564 — a recipient-side terminal state the inviter can SEE. Absent =
   *  pending (the older-wire default). A declined row keeps its token-hash index
   *  until age-out so an accept replay stays a uniform failure. */
  status?: InvitationStatus;
  declinedAt?: string;
  /** Review nit (a) — the accept CLAIM mark. `acceptInvitation` swaps the exact
   *  row it read to `{ …, claimedAt }` BEFORE deleting it, so a decline's CAS
   *  (which also expects the row as read) cannot land between the pre-claim
   *  check and the delete: exactly one of the two swaps wins. Transient — the
   *  row is deleted right after, or restored WITHOUT it on a failed tail. */
  claimedAt?: string;
}

export type InvitationStatus = 'pending' | 'declined';
export const invitationStatusOf = (inv: Pick<OrgInvitation, 'status'>): InvitationStatus => inv.status ?? 'pending';

const invites = new DurableCollection<OrgInvitation>('orgs:invite', (i) => i.inviteId);
/** grade-data (ADR 0448 §8) — hash→inviteId index so `acceptInvitation` is a
 *  point-get, honoring the capability-token "verify = hash then point-get"
 *  contract instead of a cross-tenant full scan on a PUBLIC accept path.
 *  WF-ORGINV-1 — deliberately INDEX-FREE (no `tenantOf`): nothing performs
 *  tenant-indexed reads of this collection (verify is a point-get by hash),
 *  the kvAgeOut lane prefers index-free stores, and tenant teardown still
 *  reclaims these rows via the content `tenantId` field (`purgeTenantRows`'s
 *  `jsonTenantId` probe — the same path the primary `orgs:invite` rides). */
const inviteHashIndex = new DurableCollection<{ key: string; inviteId: string; tenantId: string; expiresAt: string }>('orgs:invite-hashidx', (r) => r.key);

// Retention (IDN-3) — an EXPIRED invite is definitionally dead: `acceptInvitation`
// rejects it (`expiresAt < now` → invalid) and an accepted invite is deleted at accept
// time (single-use), so the store only ever accrues expired-never-accepted rows. Age them
// out via the ADR 0380 kvAgeOut SIZE-hygiene lane (not `registerRetentionPurger` — this is
// a non-PII operational row, not per-tenant governance/PII): the invites collection itself has no tenant secondary index
// and every row carries `expiresAt` (ISO), so we delete rows that expired > 30d ago (a
// generous audit buffer past the 7-day validity). No survive-condition — an expired invite
// can never be accepted.
registerKvAgeOut({ id: 'orgs:invite', prefix: 'hostext:orgs:invite:', ttlDays: 30, timestampField: 'expiresAt' });
// grade-data: the hash index ages out in lockstep with its invite (same field +
// TTL), so a kvAgeOut'd invite can never strand its index pointer.
registerKvAgeOut({ id: 'orgs:invite-hashidx', prefix: 'hostext:orgs:invite-hashidx:', ttlDays: 30, timestampField: 'expiresAt' });

class InviteError extends Error {
  constructor(
    public readonly code: 'not_found' | 'forbidden' | 'validation' | 'invalid_invite',
    message: string,
    /** R2 IN-SP-8 — a machine-readable discriminator the page can map to
     *  honest copy (`expired`; review F4 added `invalid_email`; ADR 0564/0622
     *  added `declined` on preview + accept — disclosure is fine, the token
     *  holder declined it — and `email_unverified` for the D7 provenance gate).
     *  Used/revoked rows are DELETED, so those states are genuinely
     *  indistinguishable — a model limit, not flattening. */
    public readonly reason?: 'expired' | 'invalid_email' | 'declined' | 'email_unverified',
  ) {
    super(message);
    this.name = 'InviteError';
  }
}

function parseRole(value: unknown): InvitableRole {
  if (typeof value === 'string' && (INVITABLE_ROLES as readonly string[]).includes(value) && isBuiltInRoleId(value)) {
    return value as InvitableRole;
  }
  throw new InviteError('validation', `Field \`role\` MUST be one of ${INVITABLE_ROLES.join(', ')}.`);
}

/** The accessControl org, scoped to the caller's tenant (IDOR guard) — the org
 *  must exist AND belong to this tenant, else 404 (no existence leak). */
async function requireOrgInTenant(tenantId: string, orgId: string): Promise<void> {
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId) throw new InviteError('not_found', 'Org not found.');
}

/** ORGINV-3 — the recipient address must LOOK like an email before we mint a
 *  row and hand it to `provider.send({to})`. Same shape the email-approval and
 *  CRM surfaces pin; `[^\s@]` also rejects CR/LF (whitespace), closing the
 *  header-injection asymmetry with the CRLF-cleaned name fields. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every live row for (org, email) other than `exceptInviteId`, deleted index-
 *  first alongside the row (the mint invariant). Returns what it removed so the
 *  caller can say `superseded: true` / `previousStatus: 'declined'` (ADR 0622 D1). */
async function supersedePriorInvitations(orgId: string, email: string, exceptInviteId?: string): Promise<OrgInvitation[]> {
  const stale = (await invites.list()).filter((i) => i.orgId === orgId && i.email === email && i.inviteId !== exceptInviteId);
  for (const row of stale) {
    await invites.delete(row.inviteId);
    await inviteHashIndex.delete(row.tokenHash);
  }
  return stale;
}

export async function createInvitation(
  input: { tenantId: string; orgId: string; email: string; role: unknown; createdBy?: string; createdByName?: string },
  /** ADR 0622 D5 — `replace: false` mints WITHOUT touching prior (org, email)
   *  rows; the composition owner `createInvitationAndDeliver` supersedes them
   *  itself only once delivery is known to have succeeded. Default `true` keeps
   *  the direct-caller replace-at-mint semantics the service tests pin. */
  opts: { replace?: boolean } = {},
): Promise<{ invite: OrgInvitation; token: string; superseded: OrgInvitation[] }> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new InviteError('validation', 'Invite `email` is required.');
  // ORGINV-3 — junk minted an unacceptable invite (dev) or a provider-rejected
  // send surfaced as a transient "try again" (prod). Refuse at the door with
  // the canonical validation envelope. Review F4 — the machine-readable reason
  // lets the UI say "fix the address" instead of retry-flavored copy.
  if (!EMAIL_RE.test(email)) throw new InviteError('validation', 'Field `email` MUST be a valid email address.', 'invalid_email');
  const role = parseRole(input.role);
  await requireOrgInTenant(input.tenantId, input.orgId);
  // At most one live invite per (org, email): replace prior pending ones so an
  // old token can't re-add a removed member. (Inline deletes, deliberately NOT
  // `revokeInvitation` — a replace is a row death, never a `revoked` event.)
  const superseded = opts.replace === false ? [] : await supersedePriorInvitations(input.orgId, email);
  // ADR 0448 OQ3 — the host mint (now prefixed for log/support triage; the raw
  // format widens but verification is by hash, so existing invites are unaffected).
  const { raw: token, hash } = mintToken('orginv');
  const now = new Date().toISOString();
  const invite: OrgInvitation = {
    inviteId: `inv:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    email,
    role,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    createdAt: now,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.createdByName ? { createdByName: input.createdByName } : {}),
  };
  // ORGINV-5 — INDEX ROW FIRST. A crash between the two puts then leaves an
  // index row whose invite is missing — which verify already treats as a
  // fail-closed miss — instead of an invite the index can't reach. That
  // retires the crash-window rationale for the public-path `invites.list()`
  // scan fallback, so preview/accept are pure point-gets (see below).
  await inviteHashIndex.put({ key: invite.tokenHash, inviteId: invite.inviteId, tenantId: invite.tenantId, expiresAt: invite.expiresAt });
  await invites.put(invite);
  return { invite, token, superseded };
}

export interface CreateAndDeliverInput {
  storage: Storage;
  tenantId: string;
  orgId: string;
  email: string;
  role: unknown;
  /** The inviter — the broker resolves THEIR email connection (ADR 0024 §4). */
  actingUserId: string | undefined;
  createdBy?: string;
  createdByName?: string;
  /** The deploy's public origin for the accept link (`publicBaseUrl(req)` on
   *  the route; `OPENWOP_PUBLIC_BASE_URL` on the surface — never relative). */
  baseUrl: string;
  /** True iff the CALLER will hand the plaintext token back (the non-prod route
   *  echo, `exposeTokens()`). Then a skipped delivery is still a reachable invite
   *  (copy-link UX). False on the workflow surface (it never returns the token)
   *  and in production: a skipped delivery there is a zombie row — rolled back. */
  tokenEchoed: boolean;
  /** ADR 0617 D1a — stamped only by the workflow surface. */
  origin?: HostEventOrigin;
  /** The executing run, when the send is brokered from inside a run, so
   *  `stampConnectionUse` records the real run rather than a synthetic id. */
  runId?: string;
}

export interface CreateAndDeliverResult {
  invite: OrgInvitation;
  token: string;
  delivery: InviteDeliveryOutcome;
  /** The prior (org, email) rows this mint replaced — empty when there were none. */
  superseded: OrgInvitation[];
}

/**
 * ADR 0622 D5 — THE composition owner for "invite someone": precheck → mint
 * WITHOUT replace → deliver → supersede-or-rollback → the ONE `created` emit.
 * Called by the HTTP route and the workflow surface alike, so one site covers
 * both lanes and `superseded` / `previousStatus` are derivable.
 *
 *   1. PRECHECK (`ORGINV-7`, moved here from the route): when the token will
 *      not be echoed, a missing org sender identity is knowable up front —
 *      refuse BEFORE any mint (`422 undeliverable / no_sender`, no row).
 *   2. MINT with `replace: false` — the prior invite (if any) stays live.
 *   3. DELIVER through the inviter's brokered connection (never throws).
 *   4. On `sent` — or a `skipped` the caller can still hand out (token echo) —
 *      SUPERSEDE the prior rows now. Stated window: between the mint and this
 *      step two tokens are live for (org, email); a crash there leaves two
 *      rows until the next mint's replace loop.
 *      Otherwise ROLL BACK the NEW row via `revokeInvitation` (row then index;
 *      the between-state is a fail-closed miss — the ORGINV-5 rationale) and
 *      leave the prior invite UNTOUCHED: the 422 names that the earlier
 *      invitation is still valid (`priorInviteStillValid`), so the operator's
 *      resend confirm copy stays true.
 *   5. EMIT `created` — only for a row that survived (a rolled-back mint never
 *      emits).
 */
export async function createInvitationAndDeliver(input: CreateAndDeliverInput): Promise<CreateAndDeliverResult> {
  await requireOrgInTenant(input.tenantId, input.orgId);
  if (!input.tokenEchoed) {
    const settings = await getEmailSettings(input.tenantId, input.orgId);
    if (!settings?.senderAddress) {
      throw new OpenwopError(
        'validation_error',
        'This invitation could not be delivered: no email sender is configured for this organization. Set one on the Email page and try again — an undeliverable invitation would be unusable.',
        422,
        { reason: 'undeliverable', cause: 'no_sender' },
      );
    }
  }
  const { invite, token } = await createInvitation(
    {
      tenantId: input.tenantId,
      orgId: input.orgId,
      email: input.email,
      role: input.role,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.createdByName ? { createdByName: input.createdByName } : {}),
    },
    { replace: false },
  );
  const delivery = await deliverInviteEmail({
    storage: input.storage,
    tenantId: input.tenantId,
    actingUserId: input.actingUserId,
    invite,
    token,
    baseUrl: input.baseUrl,
    ...(input.runId ? { runId: input.runId } : {}),
  });
  if (delivery.outcome === 'skipped' && !input.tokenEchoed) {
    // The token exists ONLY as a hash: the new invite is permanently
    // unreachable. Roll it back and tell the operator WHICH failure this was,
    // because the fixes differ (configuration vs just-try-again). The earlier
    // invite, if one is live, was never touched.
    await revokeInvitation(input.tenantId, input.orgId, invite.inviteId)
      .catch(() => log.warn('org_invite_rollback_failed', { inviteId: invite.inviteId, orgId: input.orgId }));
    const prior = (await invites.list()).find((i) =>
      i.orgId === input.orgId && i.email === invite.email && i.inviteId !== invite.inviteId
      && invitationStatusOf(i) === 'pending' && Date.parse(i.expiresAt) >= Date.now());
    const transient = delivery.reason === 'send_failed';
    // Review nit (b) — "still valid" is more than the row can prove: a live
    // pending row says its TOKEN has not expired, not that the token was ever
    // surfaced (a prior `deliver` may itself have been skipped, or the row may
    // have been minted with `tokenEchoed` by an API caller). The row does not
    // record delivery, so the copy says "may".
    const priorNote = prior ? ' An earlier invitation for this address may still be valid — nothing about it was changed.' : '';
    throw new OpenwopError(
      'validation_error',
      (transient
        ? 'Email delivery failed — nothing was kept. Try again in a moment.'
        : 'This invitation could not be delivered: your email connection is not available. Reconnect it on the Email page and try again.') + priorNote,
      422,
      {
        reason: transient ? 'delivery_failed' : 'undeliverable',
        cause: delivery.reason,
        // A boolean, not the prior inviteId: the error envelope redacts
        // high-entropy strings in `details`, and the row is listable anyway.
        ...(prior ? { priorInviteStillValid: true } : {}),
      },
    );
  }
  const superseded = await supersedePriorInvitations(input.orgId, invite.email, invite.inviteId);
  const previousStatus: SupersededStatus | undefined = superseded.length === 0
    ? undefined
    : superseded.some((i) => invitationStatusOf(i) === 'declined') ? 'declined' : 'pending';
  invitationCreated({
    inviteId: invite.inviteId,
    orgId: invite.orgId,
    tenantId: invite.tenantId,
    role: invite.role,
    delivery: delivery.outcome,
    superseded: superseded.length > 0,
    ...(previousStatus ? { previousStatus } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
  });
  return { invite, token, delivery, superseded };
}

export async function listInvitations(tenantId: string, orgId: string): Promise<OrgInvitation[]> {
  await requireOrgInTenant(tenantId, orgId);
  return (await invites.list()).filter((i) => i.tenantId === tenantId && i.orgId === orgId);
}

/** Delete one invite (row, then index — the between-state is a fail-closed
 *  miss). Also the ADR 0622 D5 ROLLBACK primitive, which is why it emits
 *  nothing: `host.orgs.invitation.revoked` is the admin ROUTE's to emit. */
export async function revokeInvitation(tenantId: string, orgId: string, inviteId: string): Promise<void> {
  const inv = await invites.get(inviteId);
  if (!inv || inv.tenantId !== tenantId || inv.orgId !== orgId) throw new InviteError('not_found', 'Invitation not found.');
  await invites.delete(inviteId);
  await inviteHashIndex.delete(inv.tokenHash);
}

/** What a token-holder is shown BEFORE they accept (UX_UPGRADE-invitations
 *  IN-G1). Deliberately small: the org they'd be joining, the role they'd get,
 *  and the address the invite was issued to — all facts the recipient already
 *  holds, since the token arrived in that mailbox. */
export interface InvitationPreview {
  orgId: string;
  orgName: string;
  role: InvitableRole;
  email: string;
  expiresAt: string;
  /** R2 IN-R2-1 — the inviter's DISPLAY NAME (never an email — the crm-public
   *  F10 rule: a displayName that IS an email is suppressed). The email the
   *  recipient received already named this person, so it passes round-1's
   *  "facts the token-holder already has" disclosure test. */
  invitedBy?: string;
}

/**
 * Resolve an invitation token WITHOUT redeeming it, so the accept page can show
 * a person what they are about to join and require an explicit click.
 *
 * This is a strictly NON-MUTATING read: it never creates a member, never
 * deletes the invite, and never consumes the single use. That separation is the
 * point — the old flow accepted on page load, so anything that merely FOLLOWED
 * the link (a mail-client link scanner, a chat unfurler, a browser prefetch)
 * silently joined the org on the recipient's behalf.
 *
 * It performs no email check: matching the signed-in user against the invited
 * address stays in `acceptInvitation`, which is the security gate. Preview
 * exists to inform, not to authorize.
 */
/**
 * ADR 0622 D7 (`ORGINV-9`) — the email-ownership policy, stated.
 *
 * THE TOKEN IS THE CREDENTIAL; the email match is defense-in-depth. It compares
 * `user.email`, a field the admin PATCH (`users/routes.ts`) can set with no
 * verification — under the implicit personal-owner short-circuit a personal-
 * tenant user can rename themselves to the invitee's address. So the gate
 * requires BOTH: the address matches AND `User.emailProvenance !== 'self'` —
 * the address was asserted by an IdP (`'idp'`: OIDC with `email_verified`, SAML,
 * SCIM, the test seam) or vouched by a shared-workspace admin (`'admin'`). A
 * self-set address is refused `403 forbidden / email_unverified`. A row with NO
 * provenance reads as `'self'` (review S2 — fail-closed; app migration 20
 * stamps the legacy rows from their lane, so this bites only a row written
 * without one). The review's premise correction: this used to pass legacy
 * rows, which made an unstamped row a free pass.
 *
 * The OIDC lane (USERS-20): the bearer's `email` claim reaches the row ONLY
 * under `email_verified: true` (`middleware/auth.ts` → `req.oidcEmail` → the
 * bind route / lazy canonical fold). Residual, stated: an IdP that does not
 * assert `email_verified` leaves the row address-less, and a personal-tenant
 * user has no admin to vouch for them — the accept page says so.
 */
function assertEmailOwnership(inv: OrgInvitation, user: User): void {
  if (!user.email) {
    // No address at all — the OIDC lane without `email_verified`, or a row an
    // IdP never stamped. The same actionable step as an unverified one.
    throw new InviteError(
      'forbidden',
      'Your account has no verified email address, so it cannot act on this invitation. Sign in through your identity provider so your verified address is used, or contact the person who invited you.',
      'email_unverified',
    );
  }
  if (user.email.trim().toLowerCase() !== inv.email) {
    throw new InviteError('forbidden', 'This invitation was issued to a different email.');
  }
  if (effectiveEmailProvenance(user) === 'self') {
    throw new InviteError(
      'forbidden',
      'This invitation was issued to an email address your account set for itself, which is not verified. Sign in through your identity provider so your verified address is used, or contact the person who invited you.',
      'email_unverified',
    );
  }
}

/** The shared verify — hash → index → invite, expiry, the INVITE tenant's toggle,
 *  then (ADR 0564) a declined row is a dead one on every public lane. */
async function resolveLiveInvite(token: string): Promise<OrgInvitation> {
  // ORGINV-5 — verify is a pure point-get: hash → index → invite. The old
  // `invites.list()` scan fallback made every INVALID-token probe on this
  // unauthenticated endpoint pay a cross-tenant full scan. Its two rationales
  // are both retired: pre-index legacy invites aged out long ago (7d validity),
  // and the mint crash window now leaves an index-without-invite (fail-closed
  // miss) instead of an invite-without-index, because `createInvitation`
  // writes the index row FIRST.
  const th = hashToken(token);
  const idx = await inviteHashIndex.get(th);
  const inv = idx ? await invites.get(idx.inviteId) : null;
  if (!inv) throw new InviteError('invalid_invite', 'The invitation is invalid or expired.');
  // R2 IN-SP-8 — expired IS distinguishable server-side; flattening it made
  // the page claim a malformed link for a merely-late one.
  if (Date.parse(inv.expiresAt) < Date.now()) {
    throw new InviteError('invalid_invite', 'This invitation has expired.', 'expired');
  }
  // R2 review F6 — gate on the INVITE's tenant, not the anonymous caller's:
  // `requireFeatureEnabled(req)` resolves the caller's tenant ('default' for a
  // signed-out recipient), so a per-tenant orgs rollout could 404 a perfectly
  // valid invite and the page would claim it was revoked.
  const assignment = await resolveOne('orgs', { tenantId: inv.tenantId });
  if (!assignment || !assignment.enabled) {
    throw new InviteError('invalid_invite', 'The invitation is invalid or expired.');
  }
  return inv;
}

/**
 * Resolve an invitation token WITHOUT redeeming it, so the accept page can show
 * a person what they are about to join and require an explicit click.
 *
 * This is a strictly NON-MUTATING read: it never creates a member, never
 * deletes the invite, and never consumes the single use. That separation is the
 * point — the old flow accepted on page load, so anything that merely FOLLOWED
 * the link (a mail-client link scanner, a chat unfurler, a browser prefetch)
 * silently joined the org on the recipient's behalf.
 *
 * It performs no email check: matching the signed-in user against the invited
 * address stays in `acceptInvitation`, which is the security gate. Preview
 * exists to inform, not to authorize.
 */
export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const inv = await resolveLiveInvite(token);
  // ADR 0564 / 0622 D4 — a declined row is dead; say so (the token holder is
  // the one who declined it, so the disclosure is theirs already).
  if (invitationStatusOf(inv) === 'declined') {
    throw new InviteError('invalid_invite', 'This invitation was declined.', 'declined');
  }
  const org = await getOrg(inv.orgId);
  if (!org) throw new InviteError('invalid_invite', 'The invitation is for an org that no longer exists.');
  const invitedBy = inv.createdByName && !inv.createdByName.includes('@') ? inv.createdByName : undefined;
  return { orgId: inv.orgId, orgName: org.name, role: inv.role, email: inv.email, expiresAt: inv.expiresAt, ...(invitedBy ? { invitedBy } : {}) };
}

/**
 * Accept an invite → become an accessControl member of the org (delegated).
 * Fail-closed: the email-ownership + provenance gate (`assertEmailOwnership`,
 * ADR 0622 D7); single-use; the org must still exist. The new member binds to
 * the user's `userId` (subject) with the invited role, so accessControl's
 * RFC 0049 scope resolution applies. Emits `host.orgs.invitation.accepted`
 * from ONE site after the claim/restore try-catch — never on the restore path.
 */
export async function acceptInvitation(token: string, user: User): Promise<{ member: OrgMember; alreadyMember: boolean }> {
  const inv = await resolveLiveInvite(token);
  if (!(await getOrg(inv.orgId))) {
    // A row death with no event — the org is gone, nothing to fan out to.
    await invites.delete(inv.inviteId);
    await inviteHashIndex.delete(inv.tokenHash);
    throw new InviteError('invalid_invite', 'The invitation is for an org that no longer exists.');
  }
  assertEmailOwnership(inv, user);
  // ADR 0622 D4 — refuse a DECLINED row BEFORE the claim so the attempt does
  // not burn it (the row stays visible to the inviter until age-out). The
  // uniform-invalid shape per ADR 0564, with the reason the page can name.
  if (invitationStatusOf(inv) === 'declined') {
    throw new InviteError('invalid_invite', 'This invitation was declined.', 'declined');
  }
  // ORGINV-2 — CLAIM-BY-DELETE (the delivery lane's DEF-3 CAS discipline,
  // applied to accept). Two concurrent accepts of one token used to both pass
  // the `existing` check and both reach `createMember` (which has no subject
  // dedupe) before either deleted the invite — duplicate OrgMember rows, the
  // IN-SP-3 defect re-entering through the race window. Now the invite row is
  // deleted FIRST and `delete`'s return value is the claim: only the caller
  // that actually removed the row proceeds; the loser is told the invite is
  // gone (indistinguishable from used — which it now is). Placed AFTER every
  // refusal above so a wrong-email or expired attempt never burns the invite.
  //
  // Review nit (a) — the claim is a CAS on the EXACT row read, marked
  // `claimedAt`, and only then the delete. A `declineInvitation` racing this
  // accept also swaps against the row as read; with a bare delete-first claim
  // its `pending → declined` swap could land between the declined check above
  // and the delete (the row was still byte-identical), yielding BOTH a member
  // and a declined row. Now exactly one swap wins: the loser here reads
  // `invalid_invite`; the loser there re-reads (gone ⇒ `invalid_invite`).
  const claimedAt = new Date().toISOString();
  const claimed = await invites.compareAndSwap(inv, { ...inv, claimedAt });
  if (!claimed) throw new InviteError('invalid_invite', 'The invitation is invalid or expired.');
  await invites.delete(inv.inviteId);
  await inviteHashIndex.delete(inv.tokenHash);
  // Review F1 — the claim must not be a one-way door into nothing: if the
  // member-creation tail throws AFTER the claim, the invite would be gone with
  // no membership, every retry would read `invalid_invite`, and the admin
  // would have no surface to resend from (Resend renders on existing rows
  // only). Restore BOTH rows (index first — the mint invariant), log a
  // dedicated event either way, and rethrow the original failure so the
  // caller sees the truth.
  let result: { member: OrgMember; alreadyMember: boolean };
  try {
    // R2 IN-SP-3 — accepting while ALREADY a member used to create a DUPLICATE
    // OrgMember row. Idempotent instead: the invite is burned (it did its job),
    // return the existing membership, and let the page say so. The stored role
    // is NOT silently changed — an invite is a door, not a role editor.
    const existing = (await listMembers(inv.tenantId, inv.orgId)).find((m) => m.subject === user.userId);
    if (existing) {
      result = { member: existing, alreadyMember: true };
    } else {
      const member = await createMember({
        tenantId: inv.tenantId,
        orgId: inv.orgId,
        subject: user.userId, // RFC 0048 stable subject (ADR 0003) — roles apply when this principal acts
        // `assertEmailOwnership` proved `user.email` matches `inv.email` (no TS
        // narrowing across the helper, hence the fallback to the row's address).
        displayName: user.displayName ?? user.email ?? inv.email,
        email: user.email ?? inv.email,
        roles: [inv.role],
      });
      result = { member, alreadyMember: false };
    }
  } catch (err) {
    let restored = false;
    try {
      await inviteHashIndex.put({ key: inv.tokenHash, inviteId: inv.inviteId, tenantId: inv.tenantId, expiresAt: inv.expiresAt });
      await invites.put(inv);
      restored = true;
    } catch { /* logged below — the event fires whether or not restore held */ }
    log.warn('org_invite_claim_member_create_failed', {
      inviteId: inv.inviteId, orgId: inv.orgId, restored,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  // ADR 0622 D1 — the ONE `accepted` site: the claim succeeded and was NOT
  // restored. `alreadyMember` rides the payload; it is not a second event kind.
  invitationAccepted({
    inviteId: inv.inviteId,
    orgId: inv.orgId,
    tenantId: inv.tenantId,
    memberId: result.member.memberId,
    userId: user.userId,
    role: inv.role,
    alreadyMember: result.alreadyMember,
  });
  return result;
}

/**
 * ADR 0564 (implemented by ADR 0622 D4) — the recipient-side DECLINE: a
 * deliberate click, never a link-scanner side effect (the route is a POST the
 * page issues after a confirm step). Same gate chain as accept — token → live
 * row → invite-tenant toggle → email ownership + provenance — then the row
 * flips `pending → declined` and KEEPS its token-hash index until age-out, so
 * an accept replay stays a uniform failure and the inviter SEES the state.
 *
 * The write is a `compareAndSwap` on the exact pending row that was read: a
 * blind `put` racing the accept's claim-by-delete would RESURRECT the row as
 * declined for someone who has just joined, and two concurrent declines would
 * emit `declined` twice. Only the CAS winner emits; the loser re-reads —
 * already declined ⇒ the same idempotent answer; gone ⇒ the accept won.
 */
export async function declineInvitation(token: string, user: User): Promise<{ inviteId: string; orgId: string; status: 'declined'; declinedAt: string }> {
  const inv = await resolveLiveInvite(token);
  if (!(await getOrg(inv.orgId))) {
    throw new InviteError('invalid_invite', 'The invitation is for an org that no longer exists.');
  }
  assertEmailOwnership(inv, user);
  if (invitationStatusOf(inv) === 'declined') {
    return { inviteId: inv.inviteId, orgId: inv.orgId, status: 'declined', declinedAt: inv.declinedAt ?? inv.createdAt };
  }
  const declinedAt = new Date().toISOString();
  const next: OrgInvitation = { ...inv, status: 'declined', declinedAt };
  const won = await invites.compareAndSwap(inv, next);
  if (!won) {
    const current = await invites.get(inv.inviteId);
    if (current && invitationStatusOf(current) === 'declined') {
      return { inviteId: current.inviteId, orgId: current.orgId, status: 'declined', declinedAt: current.declinedAt ?? declinedAt };
    }
    // The accept's claim-by-delete won (row gone) or the row changed under us —
    // the invite is no longer something this caller can decline.
    throw new InviteError('invalid_invite', 'The invitation is invalid or expired.');
  }
  invitationDeclined({ inviteId: inv.inviteId, orgId: inv.orgId, tenantId: inv.tenantId });
  log.info('org_invite_declined', { orgId: inv.orgId, inviteId: inv.inviteId });
  return { inviteId: inv.inviteId, orgId: inv.orgId, status: 'declined', declinedAt };
}

/** Map an InviteError to the canonical envelope (exhaustive) — ONE mapping for
 *  the HTTP routes and the workflow surface. Non-InviteErrors pass through. */
export function inviteErrorToHttp(err: unknown): never {
  if (err instanceof InviteError) {
    switch (err.code) {
      case 'forbidden':
        throw new OpenwopError('forbidden', err.message, 403, { code: err.code, ...(err.reason ? { reason: err.reason } : {}) });
      case 'not_found':
        throw new OpenwopError('not_found', err.message, 404, { code: err.code });
      case 'validation':
      case 'invalid_invite':
        // R2 IN-SP-8 — the reason (expired / declined) rides details so the
        // page can map honest copy without parsing English prose.
        throw new OpenwopError('validation_error', err.message, 400, { code: err.code, ...(err.reason ? { reason: err.reason } : {}) });
      default: {
        const _never: never = err.code;
        throw new OpenwopError('internal_error', err.message, 500, { code: _never });
      }
    }
  }
  throw err;
}

/**
 * ADR 0622 D6 (`ORGINV-8`) — the DSAR subject eraser for the invitation store,
 * handling BOTH keys a row carries:
 *   - the RECIPIENT: `inv.email === key` (lower-cased) — a never-accepted invite
 *     holds the address in plaintext, so the row (index-first, the mint
 *     invariant) is DELETED. Reachable by an email-shaped key: the consent DSAR
 *     route passes one directly, and the users-feature `SubjectKeyResolver`
 *     (userId → the row's email) makes the users erase route reach it too.
 *   - the INVITER: `inv.createdBy === key` — `createdByName` is a declared PII
 *     field (`users.user.displayName`), so it is scrubbed and `createdBy` is
 *     tombstoned; the invite itself stays live (it is the ORG's pending door,
 *     not the inviter's data).
 * Tenant-scoped, idempotent, fail-closed on a falsy key; reports rows touched.
 */
const ERASED_SUBJECT = 'erased:subject';
export async function eraseOrgInvitationsSubject(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const email = subjectKey.includes('@') ? subjectKey.trim().toLowerCase() : null;
  let rowsTouched = 0;
  for (const inv of (await invites.list()).filter((i) => i.tenantId === tenantId)) {
    if (email !== null && inv.email === email) {
      await inviteHashIndex.delete(inv.tokenHash);
      await invites.delete(inv.inviteId);
      rowsTouched += 1;
      continue;
    }
    if (inv.createdBy === subjectKey && (inv.createdBy !== ERASED_SUBJECT || inv.createdByName !== undefined)) {
      const { createdByName: _drop, ...rest } = inv;
      await invites.put({ ...rest, createdBy: ERASED_SUBJECT });
      rowsTouched += 1;
    }
  }
  return { rowsTouched };
}
registerSubjectEraser(eraseOrgInvitationsSubject);

/** Test-only: clear invitations. */
export async function __resetOrgInvites(): Promise<void> {
  await invites.__clear();
  await inviteHashIndex.__clear();
}
