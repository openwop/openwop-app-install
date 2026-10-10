/**
 * ADR 0853 D3 — the seam a feature uses to hear that a PERSON posted a message in
 * a multi-party conversation (a channel post, a turn in a group chat), without
 * core importing the feature. Observers must be CHEAP and non-blocking in the
 * request (enqueue, don't call a model): an observer runs in-request because a
 * detached continuation may never run under CPU throttling (ADR 0699 D1).
 * Fail-soft.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.humanChatMessageObservers');

export interface HumanChatMessage {
  tenantId: string;
  /** The chat session id (ConversationMeta key). */
  conversationId: string;
  /** Stable per message. */
  messageRef: string;
  text: string;
  authorUserId?: string;
}

type Observer = (m: HumanChatMessage) => Promise<void>;
const observers: Observer[] = [];

export function registerHumanChatMessageObserver(fn: Observer): void { observers.push(fn); }

export async function notifyHumanChatMessage(m: HumanChatMessage): Promise<void> {
  for (const fn of observers) {
    try { await fn(m); } catch (err) {
      log.warn('human_chat_message_observer_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
