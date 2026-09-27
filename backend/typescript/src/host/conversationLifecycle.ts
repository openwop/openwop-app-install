/**
 * Conversation-lifecycle seam (ADR 0288 Phase 2) — the hook by which FEATURE-
 * owned sidecars react when a conversation is deleted, without the core chat
 * delete path importing features. Fifth and final member of the lifecycle-seam
 * family (see the ARCHITECTURE.md seam-table row) — identical contract: KEYED
 * registration (repeat boots overwrite), idempotent bounded handlers,
 * best-effort fan-out that never throws, FIRED AFTER the session + meta are
 * deleted (`messageIds` captured pre-delete so message-keyed consumers can
 * still address their rows).
 *
 * HOST-owned sidecars (feedback, reactions, read-state, exchange-idempotency)
 * are cleaned by DIRECT calls in the delete route — host-imports-host needs no
 * seam. This seam exists for the feature-owned two (intent-ledger, comments);
 * evals ratings (feedback-derived) and publishing/forms conversationId meta are
 * TOLERATED ON READ (ADR 0288 disposition table).
 */
export interface ConversationDeletedEvent {
  tenantId: string;
  conversationId: string;
  /** The deleted conversation's message ids, captured BEFORE the SQL cascade —
   *  message-keyed consumers (comments on chat messages) need them. */
  messageIds: readonly string[];
}

type ConversationDeletedHandler = (e: ConversationDeletedEvent) => Promise<void>;

const handlers = new Map<string, ConversationDeletedHandler>();

/** A consumer feature registers (idempotently, keyed) its cleanup at boot. */
export function onConversationDeleted(key: string, fn: ConversationDeletedHandler): void {
  handlers.set(key, fn);
}

/** Called by the chat session delete route AFTER the session + meta are gone;
 *  runs every registrant best-effort. Never throws. Returns how many ran. */
export async function fireConversationDeleted(e: ConversationDeletedEvent): Promise<number> {
  let ran = 0;
  for (const h of handlers.values()) {
    try { await h(e); ran += 1; } catch { /* a consumer's cleanup failure must not block the delete */ }
  }
  return ran;
}

