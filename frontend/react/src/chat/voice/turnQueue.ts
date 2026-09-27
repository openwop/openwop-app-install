/**
 * Board voice turn queue (ADR 0304 P2) — the PURE half of the multi-speaker
 * walkie loop. A live boardroom produces a stream of attributed assistant turns
 * (the FE cadence, ADR 0043 Phase 5A); this module decides which of them are
 * speakable and in what order, so `useVoiceMode` can voice each in its own
 * agent's voice. Side-effect-free and unit-tested in isolation.
 */
import type { ChatMessage } from '../types.js';
import { messageText } from '../types.js';

export interface SpeakableTurn {
  messageId: string;
  /** The turn's speaker (`message.agentId`); absent ⇒ the session agent / host default voice. */
  agentId?: string;
  text: string;
}

/**
 * Collect the NEW settled assistant turns beyond `seen`, in conversation order.
 * A turn is speakable when it is an assistant turn, done streaming, has real
 * text, and isn't an error or a tombstone. The caller owns `seen` (baselined at
 * session start so history is never re-voiced) and marks returned ids seen.
 */
export function collectSpeakableTurns(messages: readonly ChatMessage[], seen: ReadonlySet<string>): SpeakableTurn[] {
  const fresh: SpeakableTurn[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || seen.has(m.id)) continue;
    if (m.isStreaming) continue; // not settled yet — picked up on a later pass
    if (m.meta?.error || m.meta?.deletedAt) continue;
    const text = messageText(m).trim();
    if (!text) continue;
    fresh.push({ messageId: m.id, ...(m.agentId ? { agentId: m.agentId } : {}), text });
  }
  return fresh;
}
