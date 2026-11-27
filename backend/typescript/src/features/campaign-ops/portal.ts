/**
 * ADR 0924 D5 (P1) — the client approver portal.
 *
 * A client approver is a person at the client who decides one change set. They
 * are not an org member and never get a session. Each (change set, approver)
 * pair gets one sharing link (ADR 0448 D3: a link-shaped capability lives in a
 * sharing resolver, never in a token store of its own); the `campaign_approval`
 * resolver serves the package and this file decides through it.
 *
 * Every use re-checks (ADR 0887 "checked per use", not once at mint): the portal
 * toggle and its parent, the approver `active`, the client `active` with the
 * `client` policy, the change set still `in_review`, and the record of who sent
 * the link. The sender is the agency authority the approved change is written
 * under; a client approver has none of their own. Because the sender holds the
 * link, they must be someone who could approve for the agency, checked at send
 * and again at the decision (`agencyStandInRefusal`): a client approval is never
 * weaker than an agency one.
 *
 * ADR 0958 P1: the approver IS an ADR 0958 `ExternalCollaborator` of kind
 * `client-stakeholder` in link-only mode, and each link is backed by a `decide`
 * grant on the change set (resource kind `change-set`, system-minted only). The
 * link's resourceId is `${changeSetId}:${grantId}`, so revoking the grant, or
 * the collaborator, darkens the link at its next use through the one per-use
 * check (`checkGrantLink`). The ADR 0924 checks above run on top, unchanged.
 * Rows written before P1 (`campaign-ops:client-approver`) are adopted on first
 * read with their ids kept, so `client-approver:<id>` on approval rows still
 * names the same person; their old links do not survive and are re-sent.
 *
 * @see docs/adr/0924-campaign-ops-version-bound-approval-and-client-portal.md
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';
import { resolveToggle } from '../../host/featureToggles/service.js';
import { takeShared } from '../../host/sharedRateLimit.js';
import { getChangeSet, diffOf } from './changeSetService.js';
import { getClient, markVerifiedApprovalLinks } from './clientService.js';
import { getRequest } from './requestService.js';
import { agencyStandInRefusal, auditOps, changeSetApprovalIdOf, clientApproverSubject } from './approval.js';
import { getApproval } from '../../host/approvalService.js';
import { castApprovalVote, type ApprovalDecisionDeps } from '../../host/approvalDecision.js';
import {
  checkGrantLink, createLinkOnlyCollaborator, getCollaborator, grantAccess, grantLinkResourceId, listCollaborators,
  purgeCollaboratorsForOrg, revokeGrant, setCollaboratorStatus, type ExternalCollaborator,
} from '../../host/externalCollaborators.js';
import { listTenantMembers } from '../../host/accessControlService.js';
import { sendTransactional } from '../../host/transactionalEmail.js';
import { shareCodeMailReady } from '../sharing/shareCodeMail.js';
import type { ShareViewer } from '../sharing/sharingService.js';
import { APPROVAL_LINK_KIND, type ApprovalLinkMailData } from './approvalLinkMail.js';
import type { ApprovalLinkRecord, ClientAccount, ClientApprover } from './types.js';

export const CLIENT_PORTAL_TOGGLE = 'campaign-ops-client-portal';
const PARENT_TOGGLE = 'campaign-ops';
export const APPROVAL_RESOURCE_TYPE = 'campaign_approval' as const;
const LINK_ACTOR = 'system:campaign-ops-portal';
/** ADR 0958 P1 — the grant resource kind a link decides through (registered by
 *  campaign-ops, system-minted only). */
export const CHANGE_SET_GRANT_KIND = 'change-set';
/** ADR 0924 D5 — a link lives 7 days (Q1: it also ends when the change set leaves review). */
const LINK_DAYS = 7;
const MAX_COMMENT = 2000;
const MAX_APPROVERS_PER_CLIENT = 20;
/** ADR 0924 P2c — how long a verified browser session may decide (ADR 1141 D2). */
const VERIFY_SESSION_HOURS = 24;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

/** Pre-0958-P1 approver rows. Read only to adopt them (`adoptLegacyApprovers`). */
const legacyApprovers = new DurableCollection<ClientApprover>(
  'campaign-ops:client-approver',
  (a) => `${a.tenantId}::${a.orgId}::${a.approverId}`,
  undefined,
  (a) => a.tenantId,
);
const approvalLinks = new DurableCollection<ApprovalLinkRecord>(
  'campaign-ops:approval-link',
  (r) => `${r.tenantId}::${r.orgId}::${r.changeSetId}::${r.approverId}`,
  undefined,
  (r) => r.tenantId,
);

const nowIso = (): string => new Date().toISOString();
// Byte-identical to the sharing lane's own 404, so no refusal tells a holder more than another.
const notFound = (): OpenwopError => new OpenwopError('not_found', 'Shared link not found.', 404, {});

/** The sharing `resourceId` of one link: the change set and the grant behind it. */
export const approvalResourceIdOf = (changeSetId: string, grantId: string): string => grantLinkResourceId(changeSetId, grantId);

/** Both toggles, on the LINK's tenant (the sub-toggle never stands alone). */
export async function portalEnabled(tenantId: string): Promise<boolean> {
  for (const id of [PARENT_TOGGLE, CLIENT_PORTAL_TOGGLE]) {
    const a = await resolveToggle(id, { tenantId }).catch(() => null);
    if (!a?.enabled) return false;
  }
  return true;
}

// ── Approvers (agency side) ──

const isApprover = (c: ExternalCollaborator): boolean => c.kind === 'client-stakeholder' && c.mode === 'link-only';

/** The agency-facing view of an approver collaborator (the ADR 0924 shape). */
function approverView(c: ExternalCollaborator): ClientApprover {
  return {
    tenantId: c.tenantId, orgId: c.orgId, approverId: c.collaboratorId, kind: 'client-stakeholder',
    email: c.email, displayName: c.displayName, status: c.status === 'invited' ? 'suspended' : c.status, mode: 'link-only',
    createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

/** Tenants whose pre-P1 rows are known adopted on this instance (an empty read). */
const adoptedTenants = new Set<string>();

/**
 * ADR 0958 P1 — adopt pre-P1 approver rows into link-only collaborators, keeping
 * each id (approval rows record `client-approver:<id>`). Idempotent and safe to
 * race: the collaborator insert is a CAS on the id, and the legacy row is deleted
 * only after it. Measured 2026-10-26: production held 0 such rows.
 */
async function adoptLegacyApprovers(tenantId: string): Promise<void> {
  if (adoptedTenants.has(tenantId)) return;
  const rows = (await legacyApprovers.listForTenantIndexed(tenantId)).filter((a) => a.tenantId === tenantId);
  for (const a of rows) {
    await createLinkOnlyCollaborator({
      tenantId, orgId: a.orgId, kind: 'client-stakeholder', email: a.email, displayName: a.displayName,
      createdBy: a.createdBy, collaboratorId: a.approverId, status: a.status === 'revoked' ? 'revoked' : 'active', createdAt: a.createdAt,
    });
    await legacyApprovers.delete(`${tenantId}::${a.orgId}::${a.approverId}`);
  }
  adoptedTenants.add(tenantId);
}

/** Test seam: forget which tenants were adopted. */
export function __resetAdoptedApproversForTests(): void {
  adoptedTenants.clear();
}

async function getApproverRow(tenantId: string, orgId: string, approverId: string): Promise<ExternalCollaborator | null> {
  await adoptLegacyApprovers(tenantId);
  const c = await getCollaborator(tenantId, orgId, approverId);
  return c && isApprover(c) ? c : null;
}

export async function getApprover(tenantId: string, orgId: string, approverId: string): Promise<ClientApprover | null> {
  const c = await getApproverRow(tenantId, orgId, approverId);
  return c ? approverView(c) : null;
}

export async function listApprovers(tenantId: string, orgId: string): Promise<ClientApprover[]> {
  await adoptLegacyApprovers(tenantId);
  return (await listCollaborators(tenantId, orgId)).filter(isApprover).map(approverView);
}

export async function countActiveApprovers(tenantId: string, orgId: string): Promise<number> {
  return (await listApprovers(tenantId, orgId)).filter((a) => a.status === 'active').length;
}

/**
 * ADR 0924 P2c (review C3.2) — is this address a member of the workspace? A
 * client approver must be someone at the CLIENT: an agency member who names
 * their own address as the approver could vote as both parties. Asked when the
 * approver is added AND when the client votes, because members can be added
 * later. Compares the normalized address against each member's email, and
 * against a subject that is itself an address. Any read failure answers `true`
 * (refuse): the vote fails closed.
 * Residual, stated in the ADR: a member who adds a private mailbox they control
 * is not caught here; the audit, the visible approver email and ADR 0958
 * signed-in stakeholders are the defence.
 */
export async function isWorkspaceMemberEmail(tenantId: string, email: string): Promise<boolean> {
  const want = email.trim().toLowerCase();
  if (!want) return false;
  try {
    return (await listTenantMembers(tenantId)).some((m) =>
      (typeof m.email === 'string' && m.email.trim().toLowerCase() === want)
      || (typeof m.subject === 'string' && m.subject.includes('@') && m.subject.trim().toLowerCase().replace(/^user:/, '') === want));
  } catch {
    return true;
  }
}

export async function addApprover(input: { tenantId: string; orgId: string; email: unknown; displayName: unknown; createdBy: string }): Promise<ClientApprover> {
  const email = cleanString(input.email, 320, '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new OpenwopError('validation_error', 'Enter the approver’s email address.', 400, { field: 'email' });
  const displayName = cleanString(input.displayName, 120, '').trim();
  if (!displayName) throw new OpenwopError('validation_error', 'Enter the approver’s name.', 400, { field: 'displayName' });
  const existing = await listApprovers(input.tenantId, input.orgId);
  if (existing.some((a) => a.status !== 'revoked' && a.email === email)) {
    throw new OpenwopError('conflict', 'This person is already an approver for this client.', 409, { reason: 'approver_exists' });
  }
  if (await isWorkspaceMemberEmail(input.tenantId, email)) {
    throw new OpenwopError('validation_error', 'This address belongs to a member of your workspace. A client approver must be someone at the client.', 409, { reason: 'approver_is_member', field: 'email' });
  }
  if (existing.filter((a) => a.status === 'active').length >= MAX_APPROVERS_PER_CLIENT) {
    throw new OpenwopError('validation_error', `A client can have at most ${MAX_APPROVERS_PER_CLIENT} approvers.`, 409, { reason: 'too_many_approvers' });
  }
  // One collaborator record per person per client (ADR 0958 D1): a vendor or a
  // signed-in stakeholder with this email is a 409 `collaborator_exists` here.
  const row = approverView(await createLinkOnlyCollaborator({
    tenantId: input.tenantId, orgId: input.orgId, kind: 'client-stakeholder', email, displayName, createdBy: input.createdBy,
  }));
  auditOps(input.tenantId, 'approver.added', { orgId: input.orgId, approverId: row.approverId, by: input.createdBy });
  return row;
}

async function linkRecordsFor(tenantId: string, orgId: string, match: (r: ApprovalLinkRecord) => boolean): Promise<ApprovalLinkRecord[]> {
  return (await approvalLinks.listForTenantIndexed(tenantId)).filter((r) => r.tenantId === tenantId && r.orgId === orgId && match(r));
}

/** Drop one link: the sharing row, the grant behind it, and the record. A
 *  pre-P1 record has no grant; its sharing row used `${changeSetId}:${approverId}`. */
async function dropLink(r: ApprovalLinkRecord, by: string = LINK_ACTOR): Promise<void> {
  const { purgeLinksForResource } = await import('../sharing/sharingService.js');
  await purgeLinksForResource(r.tenantId, APPROVAL_RESOURCE_TYPE, `${r.changeSetId}:${r.grantId ?? r.approverId}`);
  if (r.grantId) await revokeGrant(r.tenantId, r.orgId, r.grantId, by).catch(() => undefined);
  await approvalLinks.delete(`${r.tenantId}::${r.orgId}::${r.changeSetId}::${r.approverId}`);
}

/**
 * Revoke an approver: every link they hold goes dark now (the per-use check
 * would also refuse it; deleting the links makes it immediate). The last active
 * approver of a `client`-policy client cannot be revoked, because nobody could
 * then approve: switch the client to `agency` first.
 */
/**
 * The last active approver of a `client`-policy client cannot stop approving
 * (revoked or suspended), because nobody could then approve. Shared by the portal
 * route and the ADR 0958 collaborators panel, which reaches the same record.
 */
async function assertNotLastApprover(tenantId: string, client: ClientAccount, cur: ExternalCollaborator): Promise<void> {
  if (cur.status === 'active' && client.approvalPolicy === 'client' && (await countActiveApprovers(tenantId, client.orgId)) <= 1) {
    throw new OpenwopError('conflict', 'This is the client’s only approver. Switch the client to agency approval before removing them.', 409, { reason: 'last_client_approver' });
  }
}

/** ADR 0958 panel — may this collaborator be suspended? A no-op for anyone who
 *  is not a portal approver. */
export async function assertCollaboratorMaySuspend(tenantId: string, client: ClientAccount, collaboratorId: string): Promise<void> {
  const cur = await getApproverRow(tenantId, client.orgId, collaboratorId);
  if (cur) await assertNotLastApprover(tenantId, client, cur);
}

export async function revokeApprover(tenantId: string, client: ClientAccount, approverId: string, by: string): Promise<ClientApprover | null> {
  const cur = await getApproverRow(tenantId, client.orgId, approverId);
  if (!cur) return null;
  if (cur.status === 'revoked') return approverView(cur);
  await assertNotLastApprover(tenantId, client, cur);
  // Revoking the collaborator revokes every grant it holds, so each link is dark
  // at its next use even if the cleanup below does not finish.
  const next = approverView(await setCollaboratorStatus(tenantId, client.orgId, approverId, 'revoked', by));
  for (const r of await linkRecordsFor(tenantId, client.orgId, (x) => x.approverId === approverId)) await dropLink(r, by);
  auditOps(tenantId, 'approver.revoked', { orgId: client.orgId, approverId, by });
  return next;
}

/** ADR 0924 P2a (review H4) — a change set whose review expired drops every
 *  link it has (the sharing rows, the grants behind them, the records). */
export async function revokeLinksForChangeSet(tenantId: string, orgId: string, changeSetId: string): Promise<number> {
  const rows = await linkRecordsFor(tenantId, orgId, (r) => r.changeSetId === changeSetId);
  for (const r of rows) await dropLink(r);
  return rows.length;
}

/**
 * ADR 0924 P2a (review H3) — does a client vote cast earlier still stand? The
 * approver must still be an active link-only collaborator, and the CURRENT link
 * of the (change set, approver) pair must still pass the one per-use grant check
 * (live, unexpired, `decide`). Any doubt is `false`: the vote is dropped and the
 * client votes again.
 */
export async function clientVoteStillLive(tenantId: string, orgId: string, changeSetId: string, approverId: string): Promise<boolean> {
  const approver = await getApproverRow(tenantId, orgId, approverId);
  if (!approver || approver.status !== 'active') return false;
  // ADR 0924 P2c (C3.2) — an approver who has since become a member no longer counts.
  if (await isWorkspaceMemberEmail(tenantId, approver.email)) return false;
  const record = await approvalLinks.get(`${tenantId}::${orgId}::${changeSetId}::${approverId}`);
  if (!record || record.tenantId !== tenantId || record.orgId !== orgId || !record.grantId) return false;
  try {
    const use = await checkGrantLink({ tenantId, orgId, resourceId: approvalResourceIdOf(changeSetId, record.grantId), action: 'decide', target: { kind: CHANGE_SET_GRANT_KIND, id: changeSetId } });
    return isApprover(use.collaborator) && use.collaborator.collaboratorId === approverId;
  } catch {
    return false;
  }
}

/** ADR 0921 Q2 — archiving a client revokes every approver link it has. */
export async function revokeAllLinksForClient(tenantId: string, orgId: string): Promise<number> {
  const rows = await linkRecordsFor(tenantId, orgId, () => true);
  for (const r of rows) await dropLink(r);
  return rows.length;
}

/** Org teardown: approvers (with their grants) and link records of one client. */
export async function purgePortalForOrg(tenantId: string, orgId: string): Promise<number> {
  await adoptLegacyApprovers(tenantId);
  const n = await revokeAllLinksForClient(tenantId, orgId);
  return n + await purgeCollaboratorsForOrg(tenantId, orgId, isApprover);
}

/**
 * ADR 0464 — the agency member who SENT a link is re-attributed on their erasure.
 * The approver rows are collaborators now, so the member who added one is
 * tombstoned by `eraseExternalCollaboratorSubject`; pre-P1 rows are adopted first
 * so none is missed.
 */
export async function eraseApproverCreators(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  await adoptLegacyApprovers(tenantId);
  for (const r of await approvalLinks.listForTenantIndexed(tenantId)) {
    if (r.tenantId === tenantId && forms.has(r.sentBy) && await approvalLinks.compareAndSwap(r, { ...r, sentBy: tombstone })) n++;
  }
  return n;
}

// ── Sending links (agency side) ──

export interface SentLink {
  approverId: string; displayName: string; email: string; url: string; expiresAt?: string;
  /** ADR 0924 P2c — how the link reached the approver (see `ApprovalLinkRecord.delivery`). */
  delivery: NonNullable<ApprovalLinkRecord['delivery']>;
  /** ADR 0924 P2c — recipient-bound with a one-time code: the URL alone opens nothing. */
  verified: boolean;
}

/**
 * Mint a fresh link per active approver for an in-review change set, replacing
 * any earlier link of that pair (so a lost link is re-sent, never duplicated).
 *
 * ADR 0924 P2c — when the workspace can send a one-time code (the ADR 1141
 * transactional lane), each link is RECIPIENT-BOUND to the approver's address
 * with verification: opening or deciding needs a code mailed to that address at
 * click time, so the sender holding the URL (review C3.1) or a forwardee is not
 * enough. The link is then emailed through the transactional seam, keyed
 * `cops-link:<grantId>` so a retry never sends a second distinct link, and the
 * delivery is recorded honestly. With no transport, the `client` policy keeps
 * the v1 copy-link fallback (`delivery.channel:'copy'`), but only for a client
 * that has never had verified links: once it has (`verifiedLinksSince`), a missing
 * code lane is a 409 `verification_unavailable` (user decision 2026-11-26). The raw
 * URL is still returned once, for the agency's own record.
 */
export async function sendApprovalLinks(input: { tenantId: string; client: ClientAccount; changeSetId: string; sentBy: string; baseUrl: string }): Promise<SentLink[]> {
  const { tenantId, client, changeSetId, sentBy } = input;
  const orgId = client.orgId;
  if (!(await portalEnabled(tenantId))) {
    throw new OpenwopError('validation_error', 'The client approval portal is turned off for this workspace.', 409, { reason: 'portal_off' });
  }
  if (client.status !== 'active') throw new OpenwopError('validation_error', 'This client is not active.', 409, { reason: 'client_inactive' });
  if (client.approvalPolicy !== 'client') {
    throw new OpenwopError('validation_error', 'This client’s changes are approved by the agency, so there is no client link to send.', 409, { reason: 'policy_not_client' });
  }
  const cs = await getChangeSet(tenantId, orgId, changeSetId);
  if (!cs) throw new OpenwopError('not_found', 'Change set not found.', 404, { changeSetId });
  if (cs.status !== 'in_review') {
    throw new OpenwopError('validation_error', 'Send this change for review first.', 409, { reason: 'not_in_review', status: cs.status });
  }
  // Whoever sends the link holds it, so they must be someone who could approve
  // for the agency: a client approval is never weaker than an agency one.
  const approval = await getApproval(changeSetApprovalIdOf(tenantId, changeSetId));
  if (!approval || approval.tenantId !== tenantId || approval.status !== 'pending') {
    throw new OpenwopError('validation_error', 'Send this change for review first.', 409, { reason: 'not_in_review', status: cs.status });
  }
  const refusal = await agencyStandInRefusal(tenantId, orgId, sentBy, approval);
  if (refusal === 'separation-of-duties') {
    throw new OpenwopError('forbidden', 'You asked for this change, so someone else has to send it to the client.', 403, { reason: 'separation-of-duties' });
  }
  if (refusal) {
    throw new OpenwopError('forbidden_scope', 'Only someone who can approve changes for this client can send it to them.', 403, { reason: refusal, requiredScope: refusal === 'cannot_write' ? 'workspace:write' : 'approvals:respond' });
  }
  const active = (await listApprovers(tenantId, orgId)).filter((a) => a.status === 'active');
  if (active.length === 0) throw new OpenwopError('validation_error', 'Add a client approver first.', 409, { reason: 'no_client_approver' });
  const { createLink } = await import('../sharing/sharingService.js');
  const verified = await shareCodeMailReady(tenantId, orgId);
  // User decision 2026-11-26 (security read residual): binding must not depend on
  // the sending side keeping its email lane. Once a client has had verified links,
  // a missing code lane is a refusal here, before anything is minted, never a quiet
  // fallback to an unbound link.
  if (!verified && client.verifiedLinksSince) {
    throw new OpenwopError('validation_error', 'This client’s approval links need a one-time code, and this workspace can’t send email right now. Fix the email connection, then send again.', 409, { reason: 'verification_unavailable' });
  }
  if (verified) await markVerifiedApprovalLinks(tenantId, orgId);
  const out: SentLink[] = [];
  for (const a of active) {
    // A re-send replaces the earlier link of this pair: its sharing row and grant go.
    const prior = await approvalLinks.get(`${tenantId}::${orgId}::${changeSetId}::${a.approverId}`);
    if (prior) await dropLink(prior);
    const grant = await grantAccess({
      tenantId, orgId, collaboratorId: a.approverId, resource: { kind: CHANGE_SET_GRANT_KIND, id: changeSetId },
      actions: ['view', 'decide'], expiresInDays: LINK_DAYS, createdBy: LINK_ACTOR,
    });
    const resourceId = approvalResourceIdOf(changeSetId, grant.grantId);
    const sentAt = nowIso();
    await approvalLinks.put({ tenantId, orgId, changeSetId, approverId: a.approverId, grantId: grant.grantId, sentBy, sentAt, verified });
    const link = await createLink(tenantId, orgId, LINK_ACTOR, {
      resourceType: APPROVAL_RESOURCE_TYPE, resourceId, expiresInDays: LINK_DAYS,
      ...(verified ? { recipient: { email: a.email }, verify: { sessionHours: VERIFY_SESSION_HOURS } } : {}),
    }, { lane: 'visitor', why: 'the client approver link for one change set (ADR 0924 D5)' });
    const url = `${input.baseUrl.replace(/\/$/, '')}/shared/${encodeURIComponent(link.token)}`;
    const mail = await sendTransactional<ApprovalLinkMailData>(APPROVAL_LINK_KIND, {
      to: a.email,
      data: { clientName: client.displayName, url, verified },
      context: { tenantId, orgId, actingUserId: sentBy, idempotencyKey: `cops-link:${grant.grantId}` },
    });
    // Never reported as sent unless it was. No transport at all, on an unbound
    // link, is the v1 copy fallback: the operator sends the URL.
    const delivery: NonNullable<ApprovalLinkRecord['delivery']> = mail.sent
      ? { channel: 'email', status: 'sent', at: nowIso() }
      : !verified && mail.reason === 'no_transport'
        ? { channel: 'copy', status: 'sent', at: nowIso() }
        : { channel: 'email', status: 'failed', at: nowIso() };
    const key = `${tenantId}::${orgId}::${changeSetId}::${a.approverId}`;
    const cur = await approvalLinks.get(key);
    if (cur && cur.grantId === grant.grantId) await approvalLinks.compareAndSwap(cur, { ...cur, delivery });
    out.push({
      approverId: a.approverId, displayName: a.displayName, email: a.email, url,
      ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}), delivery, verified,
    });
  }
  auditOps(tenantId, 'approval.links-sent', {
    orgId, changeSetId, changeSetHash: cs.hash, approverIds: active.map((a) => a.approverId), by: sentBy,
    verified, emailed: out.filter((l) => l.delivery.channel === 'email' && l.delivery.status === 'sent').length,
    notDelivered: out.filter((l) => l.delivery.status === 'failed').length,
  });
  return out;
}

// ── The public side (the `campaign_approval` sharing resolver + the decision) ──

interface LiveContext {
  client: ClientAccount;
  approver: ClientApprover;
  record: ApprovalLinkRecord;
  changeSetId: string;
}

/**
 * The per-use checks, in one place. `null` = the link is dead (uniform 404).
 * `{stale}` = the change set went stale (D5's one exception: the approver is
 * told their link is dead because the change was updated).
 */
async function liveContext(tenantId: string, orgId: string, resourceId: string, action: 'view' | 'decide'): Promise<(LiveContext & { state: 'in_review' | 'stale' }) | null> {
  const i = resourceId.lastIndexOf(':');
  if (i <= 0) return null;
  const ids = { changeSetId: resourceId.slice(0, i) };
  if (!(await portalEnabled(tenantId))) return null;
  const client = await getClient(tenantId, orgId);
  if (!client || client.status !== 'active' || client.approvalPolicy !== 'client') return null;
  // ADR 0958 D3 — the grant behind the link, through the one per-use check
  // (grant live and unexpired, collaborator active and link-only, owner feature
  // on, client open, change set exists). Its refusal is the uniform 404.
  let use;
  try {
    use = await checkGrantLink({ tenantId, orgId, resourceId, action, target: { kind: CHANGE_SET_GRANT_KIND, id: ids.changeSetId } });
  } catch {
    return null;
  }
  if (!isApprover(use.collaborator)) return null;
  const approver = approverView(use.collaborator);
  const record = await approvalLinks.get(`${tenantId}::${orgId}::${ids.changeSetId}::${approver.approverId}`);
  // Only the CURRENT link of the pair: a re-sent link supersedes the old one.
  if (!record || record.tenantId !== tenantId || record.orgId !== orgId || record.grantId !== use.grant.grantId) return null;
  const cs = await getChangeSet(tenantId, orgId, ids.changeSetId);
  if (!cs) return null;
  if (cs.status === 'stale') return { client, approver, record, changeSetId: ids.changeSetId, state: 'stale' };
  if (cs.status !== 'in_review') return null;
  return { client, approver, record, changeSetId: ids.changeSetId, state: 'in_review' };
}

/** Sharing `validate` (mint): the pair must be live and in review. */
export async function approvalShareValidate(tenantId: string, orgId: string, resourceId: string): Promise<void> {
  const ctx = await liveContext(tenantId, orgId, resourceId, 'view');
  if (!ctx || ctx.state !== 'in_review') throw notFound();
}

/**
 * Sharing `load`: the package and nothing else (client name, the request text,
 * the per-asset diffs of ADR 0923 D7). No approver email, no other change set,
 * no asset content beyond the diffed fields. Reads are limited per link on the
 * shared counter, failing open (D2 `open`: a read decides nothing).
 */
export async function approvalShareLoad(tenantId: string, orgId: string, resourceId: string): Promise<Record<string, unknown> | null> {
  const ctx = await liveContext(tenantId, orgId, resourceId, 'view');
  // A dead link throws the sharing lane's own uniform 404 rather than returning
  // null: null is sharing's `resource-gone` ("the content was deleted"), which is
  // false here (the approver was revoked, or the change was decided).
  if (!ctx) throw notFound();
  const limit = await takeShared({ scope: 'campaign-ops.portal.read', key: `${tenantId}:${resourceId}`, limit: 120, windowS: 600, failure: 'open' });
  if (!limit.allowed) throw new OpenwopError('rate_limited', 'Too many requests. Try again in a few minutes.', 429, { retryAfterS: limit.retryAfterS });
  if (ctx.state === 'stale') return { kind: APPROVAL_RESOURCE_TYPE, state: 'stale', clientName: ctx.client.displayName };
  const cs = await getChangeSet(tenantId, orgId, ctx.changeSetId);
  if (!cs) return null;
  const req = await getRequest(tenantId, orgId, cs.requestId);
  return {
    kind: APPROVAL_RESOURCE_TYPE,
    state: 'in_review',
    clientName: ctx.client.displayName,
    approverName: ctx.approver.displayName,
    request: req ? req.text : '',
    changeSetHash: cs.hash,
    changes: await diffOf(tenantId, cs),
    maxComment: MAX_COMMENT,
  };
}

const ipKey = (ip: string): string => createHash('sha256').update(ip).digest('hex').slice(0, 32);

/**
 * The approver's decision. Tenant, org and change set come from the link, never
 * the request. Every failure the holder could probe (unknown, expired, revoked,
 * superseded, wrong hash) is the same 404; a stale package is 409 `package_stale`.
 * Limits are the shared counters, failing CLOSED (ADR 0934 D2: this decides).
 */
export async function decideFromPortal(input: { token: string; ip: string; body: unknown; deps: ApprovalDecisionDeps; viewer?: ShareViewer }): Promise<{ status: 'approved' | 'rejected' | 'pending' }> {
  const body = (input.body ?? {}) as { action?: unknown; expectedChangeSetHash?: unknown; comment?: unknown };
  const ipTake = await takeShared({ scope: 'campaign-ops.portal.ip', key: ipKey(input.ip || 'unknown'), limit: 60, windowS: 600, failure: 'closed' });
  const tokenTake = ipTake.allowed
    ? await takeShared({ scope: 'campaign-ops.portal.decide', key: input.token, limit: 10, windowS: 600, failure: 'closed' })
    : ipTake;
  if (!tokenTake.allowed) throw new OpenwopError('rate_limited', 'Too many attempts. Try again in a few minutes.', 429, { retryAfterS: tokenTake.retryAfterS });

  const action = body.action;
  if (action !== 'approve' && action !== 'reject') {
    throw new OpenwopError('validation_error', '`action` must be approve or reject.', 400, { field: 'action' });
  }
  if (body.comment !== undefined && typeof body.comment !== 'string') {
    throw new OpenwopError('validation_error', '`comment` must be text.', 400, { field: 'comment' });
  }
  if (typeof body.comment === 'string' && body.comment.length > MAX_COMMENT) {
    throw new OpenwopError('validation_error', `A comment can be at most ${MAX_COMMENT} characters.`, 400, { field: 'comment' });
  }
  const comment = typeof body.comment === 'string' ? cleanString(body.comment, MAX_COMMENT, '').trim() : '';

  const { resolveActiveResource } = await import('../sharing/sharingService.js');
  // ADR 0924 P2c — the browser session rides, so a recipient-bound link decides
  // only for a session that verified it (otherwise 401 `share_verification_required`,
  // which the page answers by asking for a code again).
  const { tenantId, orgId, resourceId } = await resolveActiveResource(input.token, APPROVAL_RESOURCE_TYPE, input.viewer ? { viewer: input.viewer } : {});
  const ctx = await liveContext(tenantId, orgId, resourceId, 'decide');
  if (!ctx) throw notFound();
  if (ctx.state === 'stale') throw stalePackage();
  // ADR 0924 P2c (C3.2) — re-checked at the vote: a member's address never votes as the client.
  if (await isWorkspaceMemberEmail(tenantId, ctx.approver.email)) throw notFound();
  const cs = await getChangeSet(tenantId, orgId, ctx.changeSetId);
  if (!cs || typeof body.expectedChangeSetHash !== 'string' || body.expectedChangeSetHash !== cs.hash) throw notFound();

  // ADR 0924 P2a (review C1) — the client's vote enters the SAME host vote
  // entry as a member's, on the `client` lane: the kind's per-vote checks, the
  // shared ledger and threshold, and the one finalize. The lane, and so the
  // party, is fixed here from the link, never from the body.
  try {
    const out = await castApprovalVote(input.deps, {
      tenantId,
      decidedBy: clientApproverSubject(ctx.approver.approverId),
      expectedChangeSetHash: cs.hash,
      ...(comment ? { note: comment } : {}),
    }, changeSetApprovalIdOf(tenantId, ctx.changeSetId), action === 'approve' ? 'approved' : 'rejected', {
      party: 'client', approverId: ctx.approver.approverId, sentBy: ctx.record.sentBy,
    });
    return { status: out.status };
  } catch (err) {
    if (err instanceof OpenwopError) {
      const details = err.details as { reason?: string; status?: string } | undefined;
      const reason = details?.reason;
      if (err.code === 'conflict' && (reason === 'request_changed' || reason === 'asset_changed' || reason === 'sender_unavailable')) throw stalePackage();
      // Decided by someone else in the meantime, a hash that moved, a vote this
      // row does not take: the same 404 as every other refusal a holder can probe.
      if (err.code === 'not_found' || err.code === 'forbidden' || err.code === 'forbidden_scope') throw notFound();
      if (err.code === 'conflict' && (reason === 'change_set_mismatch' || details?.status !== undefined)) throw notFound();
    }
    throw err;
  }
}

function stalePackage(): OpenwopError {
  return new OpenwopError('conflict', 'This change was updated after the link was sent. The agency will send you a new link.', 409, { reason: 'package_stale' });
}
