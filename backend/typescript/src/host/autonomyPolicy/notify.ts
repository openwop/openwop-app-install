/**
 * ADR 0942 D7 — `notify-after`: the effect ran, and the people the policy names
 * are told.
 *
 * - **Addressed only.** Recipients are the NotifySpec's roles / subjects resolved on
 *   the client org through the one resolver (`resolveNotificationRecipients`). When
 *   they cannot be resolved, nothing is sent: a client's campaign activity is never
 *   broadcast to the agency workspace.
 * - **immediate** → one inbox notice per recipient now (`campaign.autonomy.notice`;
 *   device push rides the emitter). Email and Teams deliveries carry approval types
 *   only today, so those channels are not delivered yet (recorded in the ADR).
 * - **daily** → queued in `autonomy:digest-item`, delivered by ONE scheduled chain per
 *   tenant (`campaign-autonomy.daily-digest`, D7: "one scheduled chain per tenant,
 *   not a new loop"), one digest notice per recipient per day.
 *
 * Emitted only AFTER the effect succeeded (the chokepoint's caller), or by the gate
 * for a class with no chokepoint. Never on a replay.
 */
import { createHash } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../hostExtPersistence.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { resolveNotificationRecipients } from '../approverResolution.js';
import { currentEffectContext } from '../runEffectContext.js';
import { registerJob } from '../schedulingService.js';
import { createLogger } from '../../observability/logger.js';
import type { ActionClass, NotifySpec } from './types.js';

const log = createLogger('autonomy-notify');

export const AUTONOMY_NOTICE_TYPE = 'campaign.autonomy.notice';
export const AUTONOMY_DIGEST_TYPE = 'campaign.autonomy.digest';
/** The digest chain (a chain pack, chain-backed same-id) and its per-tenant job. */
export const DIGEST_CHAIN_ID = 'campaign-autonomy.daily-digest';
export const DIGEST_CRON = '0 8 * * *';
export const digestJobId = (tenantId: string): string => `autonomy-digest:${tenantId}`;

interface DigestItem {
  key: string;
  tenantId: string;
  /** UTC day the effect ran (yyyy-mm-dd). */
  day: string;
  recipientUserId: string;
  actionClass: ActionClass;
  summary: string;
  campaignId?: string;
  createdAt: string;
}

const digestItems = new DurableCollection<DigestItem>('autonomy:digest-item', (i) => i.key, undefined, (i) => i.tenantId);

export async function emitAutonomyNotice(args: {
  tenantId: string; orgId?: string; notify: NotifySpec; actionClass: ActionClass; summary: string; campaignId?: string; runId?: string;
  /** Optional durable notice identity (a veto window), scoped per recipient. */
  noticeId?: string;
}): Promise<number> {
  if (currentEffectContext()?.replaying === true) return 0;
  const recipients = await resolveNotificationRecipients(
    { ...(args.notify.roleRefs ? { approverRoleRefs: args.notify.roleRefs } : {}), ...(args.notify.subjectRefs ? { approverRefs: args.notify.subjectRefs } : {}) },
    { tenantId: args.tenantId, ...(args.orgId ? { orgId: args.orgId } : {}) },
  );
  if (!recipients?.length) {
    log.info('autonomy_notice_skipped', { tenantId: args.tenantId, actionClass: args.actionClass, reason: 'no_addressable_recipients' });
    return 0;
  }
  const now = new Date();
  if (args.notify.digest === 'daily') {
    const day = now.toISOString().slice(0, 10);
    for (const recipientUserId of recipients) {
      const id = createHash('sha256').update([args.tenantId, day, recipientUserId, args.actionClass, args.summary, args.runId ?? '', now.toISOString()].join('\u0000')).digest('hex').slice(0, 16);
      await digestItems.put({
        key: `${args.tenantId}::${day}::${recipientUserId}::${id}`, tenantId: args.tenantId, day, recipientUserId,
        actionClass: args.actionClass, summary: args.summary, ...(args.campaignId ? { campaignId: args.campaignId } : {}), createdAt: now.toISOString(),
      });
    }
    return recipients.length;
  }
  const notices = recipients.map((recipientUserId) => ({
    ...(args.noticeId ? { notificationId: `autonomy-notice-${createHash('sha256').update([args.tenantId, args.noticeId, recipientUserId].join('\u0000')).digest('hex').slice(0, 32)}` } : {}),
    tenantId: args.tenantId,
    recipientUserId,
    type: AUTONOMY_NOTICE_TYPE,
    priority: 'normal' as const,
    title: 'A campaign step ran under its autonomy policy',
    message: args.summary,
    actionUrl: '/campaign-studio',
    metadata: { kind: AUTONOMY_NOTICE_TYPE, actionClass: args.actionClass, ...(args.campaignId ? { campaignId: args.campaignId } : {}), ...(args.runId ? { runId: args.runId } : {}) },
  }));
  const emitter = getNotificationEmitter();
  if (args.noticeId) {
    // A veto cannot elapse merely because a best-effort batch swallowed an
    // insert failure. Reuse the existing single-notice emitter and durable id;
    // re-entry fills missing recipients and verifies every addressed inbox row.
    const storage = hostExtStorage();
    for (const notice of notices) {
      const id = notice.notificationId!;
      if (!await storage.getNotification(id)) await emitter.emit(notice);
      const stored = await storage.getNotification(id);
      if (!stored || stored.tenantId !== args.tenantId || stored.recipientUserId !== notice.recipientUserId || stored.type !== AUTONOMY_NOTICE_TYPE) {
        throw new Error('Veto notification was not durably accepted');
      }
    }
    return notices.length;
  }
  return (await emitter.emitMany(notices)).length;
}

/**
 * Deliver every queued item from days BEFORE `now`'s day: one digest notice per
 * recipient per day (deterministic notification id, so a re-run cannot double it),
 * then the items are deleted. Called by the digest chain's node.
 */
export async function deliverAutonomyDigest(tenantId: string, now = new Date()): Promise<{ recipients: number; items: number }> {
  const today = now.toISOString().slice(0, 10);
  const groups = new Map<string, DigestItem[]>();
  for (const item of await digestItems.listForTenantIndexed(tenantId)) {
    if (item.tenantId !== tenantId || item.day >= today) continue;
    const k = `${item.day}::${item.recipientUserId}`;
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  let items = 0;
  for (const [k, list] of groups) {
    const [day, recipientUserId] = k.split('::') as [string, string];
    const lines = list.slice(0, 20).map((i) => `• ${i.summary}`).join('\n');
    await getNotificationEmitter().emit({
      notificationId: `autonomy-digest-${createHash('sha256').update([tenantId, day, recipientUserId].join('\u0000')).digest('hex').slice(0, 32)}`,
      tenantId,
      recipientUserId,
      type: AUTONOMY_DIGEST_TYPE,
      priority: 'normal',
      title: `Campaign steps that ran on ${day}`,
      message: list.length > 20 ? `${lines}\n…and ${list.length - 20} more.` : lines,
      actionUrl: '/campaign-studio',
      metadata: { kind: AUTONOMY_DIGEST_TYPE, day, count: list.length },
    });
    for (const i of list) await digestItems.delete(i.key);
    items += list.length;
  }
  return { recipients: groups.size, items };
}

/** A tenant whose saved policy has a daily NotifySpec gets the digest job (idempotent upsert; host-owned, no acting person). */
export async function ensureDigestJob(tenantId: string): Promise<void> {
  const r = await registerJob({
    jobId: digestJobId(tenantId), tenantId, cronExpr: DIGEST_CRON, workflowId: DIGEST_CHAIN_ID,
    featureId: 'campaign-orchestration', enabled: true,
  });
  if (!r.ok) log.warn('autonomy_digest_job_register_failed', { tenantId, error: r.error.code });
}

/** Subject erasure: a person's queued digest items are theirs; they are deleted. */
export async function eraseDigestItemsFor(tenantId: string, forms: ReadonlySet<string>): Promise<number> {
  let n = 0;
  for (const item of await digestItems.listForTenantIndexed(tenantId)) {
    if (item.tenantId === tenantId && forms.has(item.recipientUserId) && (await digestItems.delete(item.key))) n++;
  }
  return n;
}
