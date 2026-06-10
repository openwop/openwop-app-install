/**
 * interruptResolution — the pure decision logic behind useChatSession's
 * `resolveInterrupt`, extracted so it's testable without the hook (frontend
 * enterprise-review chat decomposition, phase 2). The hook keeps the effectful
 * shell (optimistic state clear via the reducer, the resolveByRun call, error
 * restore); this module decides WHETHER and HOW to resolve.
 */

import type { ChatSession } from '../types.js';
import type { OpenInterrupt } from '../../client/interruptsClient.js';

export interface InterruptPlan {
  runId: string;
  nodeId: string;
  /** The interrupt being resolved — kept so the caller can restore it on failure. */
  interrupt: OpenInterrupt;
}

/**
 * Decide how to resolve the interrupt on a given message. Returns null when
 * there's nothing actionable (no active interrupt, or no runId to resume) — the
 * caller should still clear any stale card in that case.
 */
export function planInterruptResolution(session: ChatSession, messageId: string): InterruptPlan | null {
  const msg = session.messages.find((m) => m.id === messageId);
  if (!msg) return null;
  const interrupt = msg.activeInterrupt ?? null;
  const runId = msg.workflowRun?.runId ?? msg.meta?.runId ?? null;
  if (!interrupt || !runId) return null;
  return { runId, nodeId: interrupt.nodeId, interrupt };
}
