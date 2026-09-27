/**
 * Teams approval-card delivery (ADR 0198 Phase B) — deliver a user's
 * action-needed notifications to their Microsoft Teams chat as an adaptive
 * card with a "Review in OpenWOP" deep link. DELIVERY ONLY: deciding stays
 * in-app — there is no Teams bot, no callback endpoint, no
 * actionable-messages registration (that would be a decision surface and a
 * whole new inbound trust boundary; explicitly deferred).
 *
 * Posture (architect-reviewed):
 *   - The card is sent via the RECIPIENT's OWN microsoft365 connection to a
 *     chat THEY chose — `brokeredFetch` keys credentials per
 *     (tenant, provider, actingUser=recipient), so no cross-user credential
 *     use is possible and a missing connection fails closed (ADR 0033
 *     deploy-gating: nothing configured ⇒ silent no-op).
 *   - Addressed notifications only (`recipientUserId`, ADR 0050) — a
 *     broadcast (open-gate) approval never sprays personal chats.
 *   - Best-effort at the emitter chokepoint (the webPush precedent): a
 *     delivery failure can never break the notification insert.
 *   - Logs carry ids only — never the card contents (approval summaries are
 *     tenant data).
 */

import type { Storage } from '../storage/storage.js';
import type { NotificationRecord } from '../types.js';
import { DurableCollection } from './hostExtPersistence.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';
import { brokeredFetch } from './brokeredEgress.js';

/** The action-needed types worth a Teams card (review.updated etc. are not). */
const DELIVERABLE_TYPES = new Set(['openwop-app.workflow.approval-needed', 'workflow.input_needed']);

export interface TeamsApprovalDeliveryPref {
  tenantId: string;
  userId: string;
  /** The user's microsoft365 connection the card is sent through. */
  connectionId: string;
  /** The Teams chat (or channel thread) Graph message target. */
  chatId: string;
  createdAt: string;
}

const prefs = new DurableCollection<TeamsApprovalDeliveryPref>(
  'approval:teams-delivery',
  (p) => `${p.tenantId}:${p.userId}`,
);

export async function getTeamsDeliveryPref(tenantId: string, userId: string): Promise<TeamsApprovalDeliveryPref | null> {
  return prefs.get(`${tenantId}:${userId}`);
}

export async function setTeamsDeliveryPref(input: { tenantId: string; userId: string; connectionId: string; chatId: string }): Promise<TeamsApprovalDeliveryPref> {
  const pref: TeamsApprovalDeliveryPref = { ...input, createdAt: new Date().toISOString() };
  await prefs.put(pref);
  return pref;
}

export async function clearTeamsDeliveryPref(tenantId: string, userId: string): Promise<boolean> {
  return prefs.delete(`${tenantId}:${userId}`);
}

/**
 * ADR 0464 — subject-erasure reach into the Teams-delivery store. The whole row is
 * this user's personal delivery config (their chosen chat + their own microsoft365
 * connection), keyed `${tenantId}:${userId}`, so an erased subject's row is deleted
 * outright. Invoked once per linked identity key. Tenant-scoped (the key embeds
 * the tenant), idempotent (a delete of an absent key is a no-op), no
 * notifications. Deletes every subject-key FORM (the row keys on the raw
 * `userId`, but the DSAR entry point accepts raw or scoped). Returns the count
 * removed.
 */
export async function eraseTeamsDeliveryForSubject(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  let removed = 0;
  for (const form of subjectKeyForms(subjectKey).forms) {
    if (await prefs.delete(`${tenantId}:${form}`)) removed += 1;
  }
  return removed;
}
/** ADR 0464 — called from `registerHostSubjectErasers()`. */
export function registerTeamsDeliveryErasure(): void {
  registerSubjectEraser(async function eraseTeamsDelivery(tenantId, subjectKey) { await eraseTeamsDeliveryForSubject(tenantId, subjectKey); });
}

/** The Graph chatMessage body carrying one adaptive card (Microsoft's wire
 *  format on Microsoft's API — not OpenWOP wire). Exported for tests. */
export function buildApprovalCardMessage(record: NotificationRecord, reviewUrl: string): Record<string, unknown> {
  const attachmentId = record.notificationId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 32) || 'openwop-approval';
  return {
    body: {
      contentType: 'html',
      content: `<attachment id="${attachmentId}"></attachment>`,
    },
    attachments: [
      {
        id: attachmentId,
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: JSON.stringify({
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          body: [
            { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: record.title, wrap: true },
            ...(record.message ? [{ type: 'TextBlock', text: record.message, wrap: true }] : []),
          ],
          actions: [
            { type: 'Action.OpenUrl', title: 'Review in OpenWOP', url: reviewUrl },
          ],
        }),
      },
    ],
  };
}

/** Test seam — replaces the Graph POST. Production default is brokeredFetch
 *  (the sole credential authority, apiHosts-pinned to microsoft.com). */
export type TeamsDeliveryTransport = (opts: {
  storage: Storage;
  tenantId: string;
  actingUserId: string;
  chatId: string;
  message: Record<string, unknown>;
  correlationId: string;
}) => Promise<void>;

let transport: TeamsDeliveryTransport | null = null;
export function setTeamsDeliveryTransportForTest(fn: TeamsDeliveryTransport | null): void {
  transport = fn;
}

async function defaultTransport(opts: Parameters<TeamsDeliveryTransport>[0]): Promise<void> {
  await brokeredFetch(
    { storage: opts.storage, tenantId: opts.tenantId, runId: opts.correlationId, actingUserId: opts.actingUserId },
    {
      provider: 'microsoft365',
      url: `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(opts.chatId)}/messages`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify(opts.message),
    },
  );
}

/** The review deep link — the SPA inbox (OPENWOP_PUBLIC_BASE_URL is the SPA
 *  origin; never repointed for backend reachability). */
function reviewUrl(): string {
  const base = (process.env.OPENWOP_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return base ? `${base}/inbox` : '/inbox';
}

/**
 * Best-effort Teams delivery for one just-inserted notification. Returns
 * whether a card was sent (for tests); every miss is a silent no-op by
 * design (wrong type, broadcast, no pref) and every failure is logged with
 * ids only.
 */
export async function deliverTeamsApprovalCard(storage: Storage, record: NotificationRecord): Promise<boolean> {
  if (!DELIVERABLE_TYPES.has(String(record.type))) return false;
  const recipient = record.recipientUserId;
  if (!recipient) return false; // broadcast/open-gate — never spray personal chats
  const pref = await getTeamsDeliveryPref(record.tenantId, recipient);
  if (!pref) return false;
  const message = buildApprovalCardMessage(record, reviewUrl());
  const send = transport ?? defaultTransport;
  await send({
    storage,
    tenantId: record.tenantId,
    actingUserId: recipient,
    chatId: pref.chatId,
    message,
    correlationId: `notification:${record.notificationId}`,
  });
  return true;
}
