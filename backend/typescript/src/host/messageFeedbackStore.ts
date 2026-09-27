/**
 * Per-(user, chat-message) feedback store (ADR 0071) — durable thumbs-up/down +
 * an optional reason on an assistant chat message.
 *
 * DISTINCT from `feedbackClient`/RFC 0056 run annotations (`run.annotated`,
 * capability-gated, per-RUN): this is a host-ext CHAT quality signal, per-user
 * and per-message (a conversation run holds many messages, so it is not 1:1 with
 * a run annotation), and multiple users may rate the same message. A future
 * bridge from a per-turn message → `run.annotated` is possible but out of scope.
 *
 * Keyed `(tenantId, conversationId, messageId, subjectRef)`, so a re-rate
 * overwrites the same user's prior rating (idempotent) and distinct users keep
 * distinct rows. The reason is free text → secret-scrubbed before persistence.
 *
 * Backed by the host-ext `DurableCollection`. NON-NORMATIVE.
 *
 * @see docs/adr/0071-chat-ui-state-and-feedback.md
 *
 * DISTINCT from `messageReactionsStore` (ADR 0195 D3b boundary ruling):
 * feedback is a PRIVATE per-user AI-quality rating (never rendered to other
 * members; feeds the ADR 0123 leaderboard); a reaction is PUBLIC social state
 * (one row per (user, emoji), visible to the room). Neither feeds the other.
 */

import { DurableCollection } from './hostExtPersistence.js';
import { sanitizeFreeText } from '../byok/textRedaction.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';

export type FeedbackRating = 'up' | 'down' | 'neutral';
const MAX_REASON_LEN = 1000;

export interface MessageFeedback {
  tenantId: string;
  conversationId: string;
  messageId: string;
  subjectRef: string;
  rating: FeedbackRating;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

const feedback = new DurableCollection<MessageFeedback>(
  'chat:message-feedback',
  (f) => `${f.tenantId}:${f.conversationId}:${f.messageId}:${f.subjectRef}`,
);

export function isFeedbackRating(v: unknown): v is FeedbackRating {
  return v === 'up' || v === 'down' || v === 'neutral';
}

/** Record (overwrite) the caller's feedback on a message. The reason is
 *  secret-scrubbed and bounded; 'neutral' clears a prior up/down. */
export async function setMessageFeedback(input: {
  tenantId: string;
  conversationId: string;
  messageId: string;
  subjectRef: string;
  rating: FeedbackRating;
  reason?: string;
}): Promise<MessageFeedback> {
  const now = new Date().toISOString();
  const existing = await feedback.get(`${input.tenantId}:${input.conversationId}:${input.messageId}:${input.subjectRef}`);
  const reason = typeof input.reason === 'string' && input.reason.trim().length > 0
    ? sanitizeFreeText(input.reason.trim().slice(0, MAX_REASON_LEN))
    : undefined;
  const record: MessageFeedback = {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    subjectRef: input.subjectRef,
    rating: input.rating,
    ...(reason ? { reason } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await feedback.put(record);
  return record;
}

/** The caller's own feedback on a message (or null). */
export async function getMessageFeedback(tenantId: string, conversationId: string, messageId: string, subjectRef: string): Promise<MessageFeedback | null> {
  return feedback.get(`${tenantId}:${conversationId}:${messageId}:${subjectRef}`);
}

/** All feedback on a message (every rater) — for the conversation owner / quality
 *  aggregation. Caller visibility is enforced at the route. */
/** ADR 0123 — every feedback row for a tenant (the leaderboard aggregation
 *  source). A prefix scan over the tenant slice. */
export async function listFeedbackForTenant(tenantId: string): Promise<MessageFeedback[]> {
  return feedback.listByPrefix(`${tenantId}:`);
}

export async function listMessageFeedback(tenantId: string, conversationId: string, messageId: string): Promise<MessageFeedback[]> {
  return feedback.listByPrefix(`${tenantId}:${conversationId}:${messageId}:`);
}

/** The CALLER's own ratings across a whole conversation (ADR 0102 Phase 3) — so
 *  reopening a chat can re-display 👍/👎 on each message in one round-trip instead
 *  of an N+1 per-message fetch. Prefix-scans the session's feedback rows and keeps
 *  only `subjectRef`'s; the route gates visibility + pins the subject to the caller. */
export async function listMessageFeedbackForSession(tenantId: string, conversationId: string, subjectRef: string): Promise<MessageFeedback[]> {
  const all = await feedback.listByPrefix(`${tenantId}:${conversationId}:`);
  return all.filter((f) => f.subjectRef === subjectRef);
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// A feedback row is a PRIVATE per-user rating authored by ONE subject (their
// thumbs + free-text reason), keyed by their `user:<id>` subjectRef. It is that
// subject's own data → a DSAR DELETES every feedback row they authored, tenant-
// wide (other raters' rows on the same message stay). Tenant-scoped prefix scan;
// idempotent.

/** DSAR eraser — drop every feedback row authored by the subject, tenant-wide. */
export async function eraseSubjectFeedback(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const f of await feedback.listByPrefix(`${tenantId}:`)) {
    if (forms.has(f.subjectRef)) await feedback.delete(`${f.tenantId}:${f.conversationId}:${f.messageId}:${f.subjectRef}`);
  }
}

/** Register the message-feedback DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerMessageFeedbackErasure(): void {
  registerSubjectEraser(eraseSubjectFeedback);
}

/** ADR 0288 P2 — drop every feedback row for a DELETED conversation (called
 *  directly by the chat delete route; host-owned sidecar, no seam needed).
 *  Bounded prefix scan; idempotent. */
export async function deleteFeedbackForConversation(tenantId: string, conversationId: string): Promise<number> {
  let n = 0;
  for (const f of await feedback.listByPrefix(`${tenantId}:${conversationId}:`)) {
    await feedback.delete(`${f.tenantId}:${f.conversationId}:${f.messageId}:${f.subjectRef}`);
    n += 1;
  }
  return n;
}
