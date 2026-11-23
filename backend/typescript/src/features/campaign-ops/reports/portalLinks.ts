/**
 * ADR 0957 P2 — the link-only client report portal (D5) and its emailed link (D7).
 *
 * This is ADR 0924's portal extended, not a second one. The recipient is the
 * same person the approval portal already serves: an ADR 0958
 * `ExternalCollaborator` of kind `client-stakeholder` in link-only mode
 * (`portal.listApprovers`). Each (report, stakeholder) pair gets one `view`
 * grant on the report (resource kind `client-report`, system-minted only) and
 * one sharing link whose resourceId is `${reportId}:${grantId}` (the ADR 0448 D3
 * resolver shape; `sign_request` and `campaign_approval` are the precedent).
 * There is no token store of its own.
 *
 * Every view re-checks, live, from storage (ADR 0887, never cached):
 *  - both portal toggles AND both client-report toggles, on the LINK's tenant;
 *  - the client account is active;
 *  - the grant is live and unexpired, its collaborator active and link-only
 *    (`checkGrantLink`, the one per-use check), and the grant is the CURRENT one
 *    for this pair (a re-send supersedes the old link);
 *  - the member who sent it still holds `workspace:write` on the client, or is
 *    still an agency admin (the link is handed out under their authority, the
 *    ADR 0924 sender rule);
 *  - the report is `published` and its stored hash is its snapshot's.
 * Any failure is the sharing lane's uniform 404. Views are limited per link on
 * the ADR 0934 shared counter, failing OPEN (a read decides nothing).
 *
 * The projection is the frozen snapshot and nothing about the agency's people:
 * no `generatedBy`, `publishedBy`, `runId` or definition id.
 *
 * The email carries the link only (`reportLinkMail.ts`), through the ONE
 * transactional seam (`sendTransactional` → the brokered transport → the email
 * adapter, whose recipient egress guard applies erasure, bounce, complaint and
 * manual-hold suppression). No email connection or sender means no email: the
 * response says `emailed: false` and the operator copies the link.
 *
 * Proposed defaults (ADR 0957 Q2, undecided): sending is explicit per report,
 * never automatic on publish, and only to stakeholders the agency already
 * added; the grant lasts until the report's NEXT period ends plus 30 days
 * (between 7 and 180 days). Everything here is behind the client-portal
 * sub-toggle, which is off by default.
 *
 * @see docs/adr/0957-client-reporting-and-portal.md
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../../types.js';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { resolveToggle } from '../../../host/featureToggles/service.js';
import { takeShared } from '../../../host/sharedRateLimit.js';
import { assertOrgScope } from '../../../host/accessControlService.js';
import { checkGrantLink, grantAccess, grantLinkResourceId, revokeGrant, type ExternalCollaborator } from '../../../host/externalCollaborators.js';
import { sendTransactional } from '../../../host/transactionalEmail.js';
import { getClient } from '../clientService.js';
import { listApprovers, portalEnabled } from '../portal.js';
import type { ClientAccount } from '../types.js';
import { getReport, snapshotHashOf } from './reportService.js';
import { CLIENT_REPORT_LINK_KIND, type ClientReportLinkMailData } from './reportLinkMail.js';
import type { ClientReport } from './types.js';

export const CLIENT_REPORT_RESOURCE_TYPE = 'client_report' as const;
/** The grant resource kind a report link views through (campaign-ops registers it). */
export const CLIENT_REPORT_GRANT_KIND = 'client-report';
const LINK_ACTOR = 'system:campaign-ops-report-portal';
const CLIENT_REPORTS_TOGGLE = 'campaign-ops.client-reports';
const DAY_MS = 86_400_000;
const MIN_LINK_DAYS = 7;
const MAX_LINK_DAYS = 180;
const MAX_RECIPIENTS = 20;

/** One (report, stakeholder) link. `createdBy` is the member who sent it: the
 *  per-view re-check follows them, and the campaign-ops eraser tombstones it. */
interface ReportLinkRecord {
  tenantId: string;
  orgId: string;
  reportId: string;
  collaboratorId: string;
  grantId: string;
  createdBy: string;
  sentAt: string;
}
const reportLinks = new DurableCollection<ReportLinkRecord>(
  'campaign-ops:report-link',
  (r) => `${r.tenantId}::${r.orgId}::${r.reportId}::${r.collaboratorId}`,
  undefined,
  (r) => r.tenantId,
);

// Byte-identical to the sharing lane's own 404.
const notFound = (): OpenwopError => new OpenwopError('not_found', 'Shared link not found.', 404, {});
const isStakeholder = (c: ExternalCollaborator): boolean => c.kind === 'client-stakeholder' && c.mode === 'link-only';

/** May `subject` hand out this client's report? The same two doors the report
 *  routes admit (`authorizeClient`): `workspace:write` on the client org, or an
 *  agency admin (`host:members:manage` on the workspace root). */
async function senderMayShare(tenantId: string, orgId: string, subject: string): Promise<boolean> {
  for (const [scopeOrg, scope] of [[orgId, 'workspace:write'], [tenantId, 'host:members:manage']] as const) {
    try {
      await assertOrgScope(tenantId, subject, scopeOrg, scope);
      return true;
    } catch { /* try the next door */ }
  }
  return false;
}

/** Both portal toggles (`portalEnabled`) AND the client-reports sub-toggle, on `tenantId`. */
export async function reportPortalEnabled(tenantId: string): Promise<boolean> {
  if (!(await portalEnabled(tenantId))) return false;
  const t = await resolveToggle(CLIENT_REPORTS_TOGGLE, { tenantId }).catch(() => null);
  return t?.enabled === true;
}

/** The Q2 proposed default: the report's next period ends, plus 30 days, from
 *  now; at least 7 and at most 180 (the ADR 0958 grant ceiling). */
export function reportLinkDays(report: Pick<ClientReport, 'periodStart' | 'periodEnd'>, now = new Date()): number {
  const start = Date.parse(`${report.periodStart}T00:00:00Z`);
  const end = Date.parse(`${report.periodEnd}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return MIN_LINK_DAYS;
  const length = end - start + DAY_MS;
  const until = end + length + 30 * DAY_MS;
  const days = Math.ceil((until - now.getTime()) / DAY_MS);
  return Math.min(MAX_LINK_DAYS, Math.max(MIN_LINK_DAYS, days));
}

async function dropLink(r: ReportLinkRecord, by: string = LINK_ACTOR): Promise<void> {
  const { purgeLinksForResource } = await import('../../sharing/sharingService.js');
  await purgeLinksForResource(r.tenantId, CLIENT_REPORT_RESOURCE_TYPE, grantLinkResourceId(r.reportId, r.grantId));
  await revokeGrant(r.tenantId, r.orgId, r.grantId, by).catch(() => undefined);
  await reportLinks.delete(`${r.tenantId}::${r.orgId}::${r.reportId}::${r.collaboratorId}`);
}

async function linksOf(tenantId: string, orgId: string, match: (r: ReportLinkRecord) => boolean): Promise<ReportLinkRecord[]> {
  return (await reportLinks.listForTenantIndexed(tenantId)).filter((r) => r.tenantId === tenantId && r.orgId === orgId && match(r));
}

/** Withdrawal and client archive: every link of the report (or client) goes now.
 *  The per-view check would refuse them anyway; this makes it immediate. */
export async function dropReportLinks(tenantId: string, orgId: string, reportId?: string, by?: string): Promise<number> {
  const rows = await linksOf(tenantId, orgId, (r) => reportId === undefined || r.reportId === reportId);
  for (const r of rows) await dropLink(r, by);
  return rows.length;
}

export interface SentReportLink {
  collaboratorId: string;
  displayName: string;
  email: string;
  url: string;
  expiresAt?: string;
  /** False when no email went out (no email connection, no sender, a suppressed
   *  or erased address). The operator copies the link instead. */
  emailed: boolean;
}

/**
 * Mint one link per chosen stakeholder for a PUBLISHED report and email it.
 * `collaboratorIds` absent = every active stakeholder of the client. A re-send
 * replaces that pair's earlier link (its sharing row and grant go).
 */
export async function sendReportLinks(input: {
  tenantId: string; client: ClientAccount; reportId: string; sentBy: string; baseUrl: string; collaboratorIds?: unknown;
}): Promise<SentReportLink[]> {
  const { tenantId, client, reportId, sentBy } = input;
  const orgId = client.orgId;
  if (!(await reportPortalEnabled(tenantId))) {
    throw new OpenwopError('validation_error', 'The client portal is turned off for this workspace.', 409, { reason: 'portal_off' });
  }
  if (client.status !== 'active') throw new OpenwopError('validation_error', 'This client is not active.', 409, { reason: 'client_inactive' });
  const report = await getReport(tenantId, orgId, reportId);
  if (!report) throw new OpenwopError('not_found', 'Report not found.', 404, { reportId });
  if (report.status !== 'published') {
    throw new OpenwopError('validation_error', 'Only a published report can be sent to the client.', 409, { reason: 'report_not_published', status: report.status });
  }
  const active = (await listApprovers(tenantId, orgId)).filter((a) => a.status === 'active');
  let chosen = active;
  if (input.collaboratorIds !== undefined) {
    const ids = input.collaboratorIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_RECIPIENTS || !ids.every((x) => typeof x === 'string')) {
      throw new OpenwopError('validation_error', `\`collaboratorIds\` must list 1–${MAX_RECIPIENTS} client contacts.`, 400, { field: 'collaboratorIds' });
    }
    const wanted = new Set(ids as string[]);
    chosen = active.filter((a) => wanted.has(a.approverId));
    if (chosen.length !== wanted.size) {
      throw new OpenwopError('validation_error', 'Each recipient must be an active contact of this client.', 400, { field: 'collaboratorIds', reason: 'recipient_not_client_contact' });
    }
  }
  if (chosen.length === 0) throw new OpenwopError('validation_error', 'Add a client contact first.', 409, { reason: 'no_client_contact' });
  // The links are handed out under the sender's authority and re-checked on
  // every view, so a sender who could not pass that check is refused now.
  if (!(await senderMayShare(tenantId, orgId, sentBy))) {
    throw new OpenwopError('forbidden_scope', 'Only someone who can edit this client can send its report.', 403, { requiredScope: 'workspace:write' });
  }

  const { createLink } = await import('../../sharing/sharingService.js');
  const days = reportLinkDays(report);
  const out: SentReportLink[] = [];
  for (const a of chosen) {
    const priorKey = `${tenantId}::${orgId}::${reportId}::${a.approverId}`;
    const prior = await reportLinks.get(priorKey);
    if (prior) await dropLink(prior);
    const grant = await grantAccess({
      tenantId, orgId, collaboratorId: a.approverId, resource: { kind: CLIENT_REPORT_GRANT_KIND, id: reportId },
      actions: ['view'], expiresInDays: days, createdBy: LINK_ACTOR,
    });
    await reportLinks.put({ tenantId, orgId, reportId, collaboratorId: a.approverId, grantId: grant.grantId, createdBy: sentBy, sentAt: new Date().toISOString() });
    const link = await createLink(tenantId, orgId, LINK_ACTOR, {
      resourceType: CLIENT_REPORT_RESOURCE_TYPE, resourceId: grantLinkResourceId(reportId, grant.grantId), expiresInDays: days,
    }, { lane: 'visitor', why: 'the client report link for one published report (ADR 0957 D5)' });
    const url = `${input.baseUrl.replace(/\/$/, '')}/shared/${encodeURIComponent(link.token)}`;
    const mail = await sendTransactional<ClientReportLinkMailData>(CLIENT_REPORT_LINK_KIND, {
      to: a.email,
      data: { clientName: client.displayName, title: report.title, url },
      context: { tenantId, orgId, actingUserId: sentBy, idempotencyKey: `client-report-link:${grant.grantId}` },
    });
    out.push({
      collaboratorId: a.approverId, displayName: a.displayName, email: a.email, url,
      ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}), emailed: mail.sent,
    });
  }
  const { auditOps } = await import('../approval.js');
  auditOps(tenantId, 'report.links-sent', {
    orgId, reportId, snapshotHash: report.snapshotHash, collaboratorIds: chosen.map((a) => a.approverId),
    emailed: out.filter((l) => l.emailed).length, by: sentBy,
  });
  return out;
}

interface LiveReport { client: ClientAccount; collaborator: ExternalCollaborator; report: ClientReport }

/** The per-view checks, in one place. `null` = dark (uniform 404). */
async function liveReport(tenantId: string, orgId: string, resourceId: string): Promise<LiveReport | null> {
  const i = resourceId.lastIndexOf(':');
  if (i <= 0) return null;
  const reportId = resourceId.slice(0, i);
  if (!(await reportPortalEnabled(tenantId))) return null;
  const client = await getClient(tenantId, orgId);
  if (!client || client.status !== 'active') return null;
  let use;
  try {
    use = await checkGrantLink({ tenantId, orgId, resourceId, action: 'view', target: { kind: CLIENT_REPORT_GRANT_KIND, id: reportId } });
  } catch {
    return null;
  }
  if (!isStakeholder(use.collaborator)) return null;
  const record = await reportLinks.get(`${tenantId}::${orgId}::${reportId}::${use.collaborator.collaboratorId}`);
  if (!record || record.tenantId !== tenantId || record.orgId !== orgId || record.grantId !== use.grant.grantId) return null;
  // The link was handed out under the sender's authority: it lasts only while
  // they could still send it (ADR 0887 D1, re-run on every use).
  if (!(await senderMayShare(tenantId, orgId, record.createdBy))) return null;
  const report = await getReport(tenantId, orgId, reportId);
  if (!report || report.status !== 'published' || snapshotHashOf(report.snapshot) !== report.snapshotHash) return null;
  return { client, collaborator: use.collaborator, report };
}

/** Sharing `validate` (mint): the pair must be live and the report published. */
export async function reportShareValidate(tenantId: string, orgId: string, resourceId: string): Promise<void> {
  if (!(await liveReport(tenantId, orgId, resourceId))) throw notFound();
}

/** Grant kind `exists`: a report is grantable only while published. */
export async function publishedReportExists(tenantId: string, orgId: string, reportId: string): Promise<boolean> {
  const r = await getReport(tenantId, orgId, reportId);
  return r !== null && r.status === 'published';
}

/** Sharing `load`: the frozen figures and their lineage, nothing about the agency's people. */
export async function reportShareLoad(tenantId: string, orgId: string, resourceId: string): Promise<Record<string, unknown> | null> {
  const ctx = await liveReport(tenantId, orgId, resourceId);
  // A dead link throws the sharing lane's uniform 404 rather than returning null
  // (null is sharing's "the content was deleted", which is false here).
  if (!ctx) throw notFound();
  const limit = await takeShared({ scope: 'campaign-ops.report-portal.read', key: createHash('sha256').update(`${tenantId}:${resourceId}`).digest('hex'), limit: 120, windowS: 600, failure: 'open' });
  if (!limit.allowed) throw new OpenwopError('rate_limited', 'Too many requests. Try again in a few minutes.', 429, { retryAfterS: limit.retryAfterS });
  const r = ctx.report;
  return {
    kind: CLIENT_REPORT_RESOURCE_TYPE,
    title: r.title,
    clientName: ctx.client.displayName,
    recipientName: ctx.collaborator.displayName,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    publishedAt: r.publishedAt ?? null,
    snapshotHash: r.snapshotHash,
    snapshot: r.snapshot,
  };
}

/** ADR 0958 P5 hooks — a stakeholder erased or their client org torn down:
 *  every report link they hold goes (sharing row, grant and record). */
export async function dropReportLinksOfCollaborator(c: Pick<ExternalCollaborator, 'tenantId' | 'orgId' | 'collaboratorId'>): Promise<number> {
  const rows = await linksOf(c.tenantId, c.orgId, (r) => r.collaboratorId === c.collaboratorId);
  for (const r of rows) await dropLink(r);
  return rows.length;
}

/** ADR 0464 — the member who sent a link is tombstoned on their erasure. A
 *  tombstoned sender holds no scope, so their links go dark on the next view. */
export async function eraseReportLinkSenders(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const r of await reportLinks.listForTenantIndexed(tenantId)) {
    if (r.tenantId === tenantId && forms.has(r.createdBy) && await reportLinks.compareAndSwap(r, { ...r, createdBy: tombstone })) n++;
  }
  return n;
}
