/**
 * Interrupt-card resolution for the chat session (ADR 0327 P2 — the ADR's
 * `useInterruptResolution`). The decision logic lives in the pure, tested
 * `planInterruptResolution`; this hook owns the optimistic card drop, the
 * resolve POST, and the restore-on-failure path.
 */

import { useCallback } from 'react';
import { resolveByRun } from '../../../client/interruptsClient.js';
import { chatSessionReducer } from '../../lib/chatSessionReducer.js';
import { planInterruptResolution, removeInterruptByNode } from '../../lib/interruptResolution.js';
import type { ChatSessionCore } from './core.js';

export function useInterruptResolution(core: ChatSessionCore) {
  const { setSession, setError, sessionRef } = core;

  const resolveInterrupt = useCallback(async (messageId: string, value: unknown, nodeId?: string) => {
    // Read latest session from the ref so this stable callback doesn't depend
    // on `session` (which would invalidate it on every message tick). The
    // decision logic lives in the pure planInterruptResolution (tested).
    // `nodeId` selects WHICH open interrupt to resolve — a message can carry
    // several at once when a workflow fans out into parallel human gates.
    const plan = planInterruptResolution(sessionRef.current, messageId, nodeId);
    if (!plan) {
      // Nothing actionable for this target — leave any other open cards alone.
      return;
    }
    const targetNode = plan.nodeId;
    // Optimistically drop ONLY the resolved card for immediate feedback; the BE
    // call + SSE reconcile happen below. Sibling gates stay open.
    setSession((s) => chatSessionReducer(s, {
      type: 'updateMessage',
      id: messageId,
      patch: { activeInterrupts: removeInterruptByNode(
        s.messages.find((m) => m.id === messageId)?.activeInterrupts, targetNode) },
    }));
    try {
      await resolveByRun(plan.runId, targetNode, value);
    } catch (err) {
      // Resume failed — restore just this interrupt so the user can retry. Via
      // the reducer's id-scoped update so a concurrent SSE write to other
      // fields on the same message is preserved.
      const message = err instanceof Error ? err.message : String(err);
      setSession((s) => {
        const existing = s.messages.find((m) => m.id === messageId)?.activeInterrupts ?? [];
        const restored = existing.some((i) => i.nodeId === targetNode)
          ? existing
          : [...existing, plan.interrupt];
        return chatSessionReducer(s, { type: 'updateMessage', id: messageId, patch: { activeInterrupts: restored } });
      });
      setError(`Could not resolve interrupt: ${message}`);
    }
  }, [sessionRef, setError, setSession]);

  return { resolveInterrupt };
}
