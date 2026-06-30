/**
 * In-flight spoken-reply tracking (ADR 0138 P2) — the barge-in cancel point.
 *
 * Voice mode is the audio ADAPTER on the ONE chat: the existing chat generates the
 * agent's reply TEXT (the real chat-responder, with tools/streaming — NOT re-derived
 * here, no second chat), and `/speak` voices it. This tracks the session's currently-
 * playing reply so a `/barge-in` can cancel it — the §F `voice-bargein-no-partial-leak`
 * point: a cancelled turn serves no further synthesis.
 *
 * In-memory + per-session (same-instance, like the audio buffers — the transport needs
 * session affinity anyway). Holds no durable content (the chat owns the turns).
 */

interface SpeakTurn { turnId: string; cancelled: boolean }

const active = new Map<string, SpeakTurn>();

/** Mark the start of a spoken reply for a session; returns its turn id. */
export function beginSpeak(sessionId: string, turnId: string): void {
  active.set(sessionId, { turnId, cancelled: false });
}

/** Has this exact reply turn been barged-in (cancelled)? */
export function isSpeakCancelled(sessionId: string, turnId: string): boolean {
  const t = active.get(sessionId);
  return !!t && t.turnId === turnId && t.cancelled;
}

/** Cancel the session's current spoken reply (barge-in). Returns the cancelled turn id, or null if none active. */
export function cancelSpeak(sessionId: string): string | null {
  const t = active.get(sessionId);
  if (!t || t.cancelled) return null;
  t.cancelled = true;
  return t.turnId;
}

/** Clear a finished reply turn (only if it is still the active one). */
export function endSpeak(sessionId: string, turnId: string): void {
  const t = active.get(sessionId);
  if (t && t.turnId === turnId) active.delete(sessionId);
}

/** Drop any active reply turn for a session (session end). */
export function dropSpeak(sessionId: string): void {
  active.delete(sessionId);
}

/** Test-only reset. */
export function __resetVoiceTurns(): void {
  active.clear();
}
