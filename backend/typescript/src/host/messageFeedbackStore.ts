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
 */

import { DurableCollection } from './hostExtPersistence.js';
import { sanitizeFreeText } from '../byok/textRedaction.js';

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

/** Test-only: clear the store. */
export async function __clearMessageFeedback(): Promise<void> {
  await feedback.__clear();
}
