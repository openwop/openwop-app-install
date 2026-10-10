/**
 * ADR 0768 P1 — the "needs you" projection: every interrupt still open across a
 * conversation, newest message first, each labelled with the gate's friendly
 * name. Pure over `ChatMessage.activeInterrupts` (the SAME field the inline
 * `InterruptCardStack` renders from), so the tray and the cards can never
 * disagree about what is open.
 */

import type { ChatMessage } from '../types.js';

export interface OpenInterruptEntry {
  messageId: string;
  interruptId: string;
  kind: string;
  /** The gate's display name (`workflowRun.nodeNames`), else the raw nodeId. */
  gateName: string;
  workflowName: string | null;
}

export function collectOpenInterrupts(messages: readonly ChatMessage[]): OpenInterruptEntry[] {
  const out: OpenInterruptEntry[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m?.activeInterrupts?.length) continue;
    for (const it of m.activeInterrupts) {
      out.push({
        messageId: m.id,
        interruptId: it.interruptId,
        kind: it.kind,
        gateName: m.workflowRun?.nodeNames?.[it.nodeId] ?? it.nodeId,
        workflowName: m.workflowRun?.workflowName ?? null,
      });
    }
  }
  return out;
}
