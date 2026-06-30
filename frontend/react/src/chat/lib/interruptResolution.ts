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
 * Decide how to resolve a specific interrupt on a given message. `nodeId`
 * selects which open interrupt to resolve — a message can carry several at
 * once when a workflow fans out into parallel human gates. When `nodeId` is
 * omitted the single open interrupt is used (chat-turn path / legacy callers);
 * if more than one is open and no `nodeId` is given we can't safely pick, so
 * we return null. Returns null when there's nothing actionable (no matching
 * interrupt, or no runId to resume) — the caller should still clear any stale
 * card in that case.
 */
export function planInterruptResolution(
  session: ChatSession,
  messageId: string,
  nodeId?: string,
): InterruptPlan | null {
  const msg = session.messages.find((m) => m.id === messageId);
  if (!msg) return null;
  const open = msg.activeInterrupts ?? [];
  const interrupt = nodeId
    ? open.find((i) => i.nodeId === nodeId) ?? null
    : open.length === 1
      ? open[0]!
      : null;
  const runId = msg.workflowRun?.runId ?? msg.meta?.runId ?? null;
  if (!interrupt || !runId) return null;
  return { runId, nodeId: interrupt.nodeId, interrupt };
}

/** Merge freshly-listed open interrupts into the existing set, deduped by
 *  `interruptId`, preserving first-seen order. Used by the `node.suspended`
 *  SSE handlers + the reload resurface path: each suspend re-lists ALL open
 *  interrupts, so a plain replace would also work, but merging is resilient
 *  to a list call that races a just-resolved row out of the result. */
export function mergeOpenInterrupts(
  existing: readonly OpenInterrupt[] | undefined,
  incoming: readonly OpenInterrupt[],
): OpenInterrupt[] {
  const byId = new Map<string, OpenInterrupt>();
  for (const i of existing ?? []) byId.set(i.interruptId, i);
  for (const i of incoming) byId.set(i.interruptId, i);
  return [...byId.values()];
}

/** Drop a resolved interrupt from the open set by `nodeId`. The
 *  `node.interrupt.resolved` event carries the node id, not the interrupt id,
 *  so we match on node. */
export function removeInterruptByNode(
  open: readonly OpenInterrupt[] | undefined,
  nodeId: string,
): OpenInterrupt[] {
  return (open ?? []).filter((i) => i.nodeId !== nodeId);
}
