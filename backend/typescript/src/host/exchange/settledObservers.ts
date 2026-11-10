/**
 * ADR 1042 D7 — `onExchangeSettled`: a conversation exchange whose user and
 * agent turns are both durable is announced here, once, on BOTH the synchronous
 * and the async (tool-loop) path. Dependency inversion: a feature that must act
 * on the agent's reply (the channel-ingress reply transport) registers from its
 * own package; the exchange never imports a feature.
 *
 * Observers are awaited in registration order and FAIL-SOFT: an observer error
 * is logged and never fails the exchange (the turns are already persisted).
 */
import { createLogger } from '../../observability/logger.js';

const log = createLogger('host.exchange.settled');

export interface ExchangeSettledEvent {
  tenantId: string;
  runId: string;
  /** The gate conversation id. */
  conversationId: string;
  /** The chat session the run is bound to, when any. */
  chatSessionId?: string | undefined;
  /** The caller's idempotency key for this exchange, when any. */
  exchangeKey?: string | undefined;
  userText: string;
  /** The agent's reply as text (the one text projection the channel mirror uses). */
  replyText: string;
  /** True when the agent made no contribution (an empty completion turn). */
  noContribution: boolean;
}

type Observer = (event: ExchangeSettledEvent) => Promise<void>;
const observers: Observer[] = [];

/** Register an observer. Re-registering the same function is a no-op (idempotent boot). */
export function registerExchangeSettledObserver(fn: Observer): void {
  if (!observers.includes(fn)) observers.push(fn);
}

export async function notifyExchangeSettled(event: ExchangeSettledEvent): Promise<void> {
  for (const fn of observers) {
    try {
      await fn(event);
    } catch (err) {
      log.warn('exchange settled observer failed', { runId: event.runId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
