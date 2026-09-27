/**
 * Per-message emoji reactions (ADR 0195 D3) — PUBLIC social state on a
 * conversation message: one row per (user, message, emoji), visible to every
 * viewer of the conversation.
 *
 * DISTINCT from `messageFeedbackStore` (ADR 0071 — the same key family but a
 * PRIVATE per-user AI-quality rating feeding the ADR 0123 leaderboard, never
 * rendered to other members). The ADR 0195 boundary ruling: reactions never
 * feed quality aggregation; feedback never renders publicly; messaging-gateway
 * inbound reactions (ADR 0175 envelope v2 — declared, not yet emitted) sink
 * ONLY here, after mapping the platform message id to the internal messageId
 * and validating it against the ID grammar.
 *
 * Key: `${tenantId}:${conversationId}:${messageId}:${subjectRef}:${emoji}` —
 * conversationId/messageId are colon-free (ID_PATTERN / randomUUID), so ONE
 * `listByPrefix('${tenant}:${conversation}:')` loads a whole conversation's
 * reactions (the `messageFeedbackStore.listMessageFeedbackForSession`
 * precedent; scale posture matches the unpaginated channel feed — when
 * pagination lands, reactions page with the message window since messageId is
 * in the key).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';

/** The curated reaction vocabulary (ADR 0195 D3) — bounded server-side so the
 *  store can't accumulate arbitrary grapheme clusters; emoji here are CONTENT
 *  (a user's expression), not iconography, so the Lucide-only icon rule is
 *  untouched. */
export const REACTION_EMOJI = ['👍', '✅', '👀', '🎉', '❤️', '😄', '🚀', '🤔'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export function isReactionEmoji(v: unknown): v is ReactionEmoji {
  return typeof v === 'string' && (REACTION_EMOJI as readonly string[]).includes(v);
}

export interface MessageReaction {
  tenantId: string;
  conversationId: string;
  messageId: string;
  /** The reacting principal (`user:<id>` — agents don't react in v1). */
  subjectRef: string;
  emoji: ReactionEmoji;
  reactedAt: string;
}

const reactions = new DurableCollection<MessageReaction>(
  'chat:message-reactions',
  (r) => `${r.tenantId}:${r.conversationId}:${r.messageId}:${r.subjectRef}:${r.emoji}`,
);

/** Idempotent add — re-reacting with the same emoji is a no-op overwrite. */
export async function addReaction(r: Omit<MessageReaction, 'reactedAt'>): Promise<void> {
  await reactions.put({ ...r, reactedAt: new Date().toISOString() });
}

/** Idempotent remove. */
export async function removeReaction(r: Omit<MessageReaction, 'reactedAt'>): Promise<void> {
  await reactions.delete(`${r.tenantId}:${r.conversationId}:${r.messageId}:${r.subjectRef}:${r.emoji}`);
}

/** One batched read per conversation → `messageId → rows` (the projection joins
 *  it into the message list as `{emoji, count, mine}` aggregates). */
export async function listReactionsForConversation(tenantId: string, conversationId: string): Promise<Map<string, MessageReaction[]>> {
  const rows = await reactions.listByPrefix(`${tenantId}:${conversationId}:`);
  const out = new Map<string, MessageReaction[]>();
  for (const r of rows) {
    const list = out.get(r.messageId);
    if (list) list.push(r);
    else out.set(r.messageId, [r]);
  }
  return out;
}

/** Aggregate one message's rows into the wire shape. Stable emoji order (the
 *  curated-set order), viewer-aware `mine`. */
export function aggregateReactions(rows: readonly MessageReaction[] | undefined, viewerRef: string | null): Array<{ emoji: ReactionEmoji; count: number; mine: boolean }> {
  if (!rows?.length) return [];
  const byEmoji = new Map<ReactionEmoji, { count: number; mine: boolean }>();
  for (const r of rows) {
    const agg = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
    agg.count += 1;
    if (viewerRef !== null && r.subjectRef === viewerRef) agg.mine = true;
    byEmoji.set(r.emoji, agg);
  }
  return REACTION_EMOJI.filter((e) => byEmoji.has(e)).map((e) => ({ emoji: e, ...byEmoji.get(e)! }));
}

/** Cascade for a tombstoned message (ADR 0195 D2 — best-effort). */
export async function deleteReactionsForMessage(tenantId: string, conversationId: string, messageId: string): Promise<void> {
  const rows = await reactions.listByPrefix(`${tenantId}:${conversationId}:${messageId}:`);
  await Promise.all(rows.map((r) => reactions.delete(`${r.tenantId}:${r.conversationId}:${r.messageId}:${r.subjectRef}:${r.emoji}`)));
}

/** ADR 0288 P2 — drop every reaction for a DELETED conversation (direct call
 *  from the chat delete route). Bounded prefix scan; idempotent. */
export async function deleteReactionsForConversation(tenantId: string, conversationId: string): Promise<number> {
  let n = 0;
  for (const r of await reactions.listByPrefix(`${tenantId}:${conversationId}:`)) {
    await reactions.delete(`${r.tenantId}:${r.conversationId}:${r.messageId}:${r.subjectRef}:${r.emoji}`);
    n += 1;
  }
  return n;
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// A reaction is the subject's OWN social expression (one row per (user, message,
// emoji)), keyed by their `user:<id>` subjectRef. A DSAR DELETES every reaction
// they authored, tenant-wide — other members' reactions on the same message
// stay, so the aggregate counts simply decrement. Tenant-scoped prefix scan;
// idempotent.

/** DSAR eraser — drop every reaction authored by the subject, tenant-wide. */
export async function eraseSubjectReactions(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const r of await reactions.listByPrefix(`${tenantId}:`)) {
    if (forms.has(r.subjectRef)) await reactions.delete(`${r.tenantId}:${r.conversationId}:${r.messageId}:${r.subjectRef}:${r.emoji}`);
  }
}

/** Register the reactions DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerReactionsErasure(): void {
  registerSubjectEraser(eraseSubjectReactions);
}
