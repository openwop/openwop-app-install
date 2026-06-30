/**
 * Chat message-feedback client (ADR 0071) — durable per-(user, message)
 * thumbs-up/down over `/v1/host/openwop-app/chat/messages/:messageId/feedback`.
 *
 * DISTINCT from `src/client/feedbackClient.ts` (RFC 0056 run annotations, per-RUN,
 * capability-gated). This is a host-ext chat quality signal, per-user and
 * per-message; it survives reload and is not stored only in local message state.
 *
 * Mirrors `host/messageFeedbackStore.ts`.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type FeedbackRating = 'up' | 'down' | 'neutral';

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

const base = (messageId: string): string => `/v1/host/openwop-app/chat/messages/${encodeURIComponent(messageId)}/feedback`;

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init?.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

/** Record (overwrite) the caller's feedback on a message. 'neutral' clears it. */
export async function setMessageFeedback(messageId: string, conversationId: string, rating: FeedbackRating, reason?: string): Promise<MessageFeedback> {
  return http<MessageFeedback>(base(messageId), {
    method: 'POST',
    body: JSON.stringify({ conversationId, rating, ...(reason ? { reason } : {}) }),
  });
}

/** The caller's own feedback on a message, or null. */
export async function getMessageFeedback(messageId: string, conversationId: string): Promise<MessageFeedback | null> {
  const r = await http<{ feedback: MessageFeedback | null }>(`${base(messageId)}?conversationId=${encodeURIComponent(conversationId)}`);
  return r.feedback;
}
