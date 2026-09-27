/**
 * Reverse-pagination message cursor (ADR 0043 Phase 3b) — extracted from
 * routes/chatSessions.ts so the channels routes page with the SAME cursor
 * (CS-CH-3, conversation-stack audit): one owner, no second paging idiom.
 *
 * The cursor is the OLDEST message of the current page as `<ISO-8601>~<id>`.
 * `createdAt` is ISO-8601 (no `~`); `messageId` matches ID_PATTERN (no `~`),
 * so a single `~` delimiter round-trips unambiguously.
 */

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/; // identical to the chatSessions route's id gate

/** Route-level page ceiling shared by every message-paging surface. */
export const MAX_MESSAGE_PAGE = 200;

export function encodeMessageCursor(m: { createdAt: string; messageId: string }): string {
  return `${m.createdAt}~${m.messageId}`;
}

export function decodeMessageCursor(raw: string): { createdAt: string; messageId: string } | null {
  const i = raw.indexOf('~');
  if (i <= 0 || i === raw.length - 1) return null;
  const createdAt = raw.slice(0, i);
  const messageId = raw.slice(i + 1);
  if (!ID_PATTERN.test(messageId) || Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, messageId };
}
