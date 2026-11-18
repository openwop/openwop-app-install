/**
 * ADR 0768 P1 — the "needs you" projection: every interrupt still open across a
 * conversation, newest message first, each labelled with the gate's friendly
 * name. Pure over `ChatMessage.activeInterrupts` (the SAME field the inline
 * `InterruptCardStack` renders from), so the tray and the cards can never
 * disagree about what is open.
 *
 * CC-CHAT-6: "needs you" means a person must act. A self-resuming wait (an
 * outside event, a timer: `needsPersonInput`, the CC-ORCH-3 rule) is not listed,
 * and nothing on a finished run is, even when an older saved message still
 * carries the interrupt.
 */

import type { ChatMessage } from '../types.js';
import { needsPersonInput } from '../interruptKinds.js';

const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

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
    if (m.workflowRun && FINISHED.has(m.workflowRun.status)) continue;
    for (const it of m.activeInterrupts) {
      if (!needsPersonInput(it.kind)) continue;
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
