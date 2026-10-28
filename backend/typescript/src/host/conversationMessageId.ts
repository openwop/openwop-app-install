/**
 * The CANONICAL chat-message id for an RFC 0005 conversation wire turn — the
 * backend twin of the SPA's `conversationMessageId`
 * (`frontend/react/src/chat/hooks/chatSession/lib.ts`).
 *
 * The SPA keys a turn's bubble, its durable row AND its rating on this id, not
 * on the wire id (`${runId}:gate:0:N:role` — the colons fail the chat-message
 * store's id pattern). A host store that must join a rating back to the turn it
 * rates therefore keys on the same value (ADR 0986 D1 / architect B1).
 *
 * Kept byte-identical to the SPA's function; `adr0986-conversation-message-id-parity.test.ts`
 * runs one fixture list through both.
 */
export function conversationMessageId(wireId: string): string {
  const sanitized = wireId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (sanitized.length <= 64) return sanitized;
  // FNV-1a (32-bit) over the FULL wire id, combined with the readable tail
  // (turnIndex + role) so two long ids cannot collide on the hash.
  let h = 0x811c9dc5;
  for (let i = 0; i < wireId.length; i += 1) { h ^= wireId.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `cm_${(h >>> 0).toString(36)}_${sanitized.slice(-40)}`;
}
