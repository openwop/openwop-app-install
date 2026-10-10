/**
 * Per-session monotonic `created_at` for chat/channel messages — the ONE
 * mechanism both storage adapters use to make thread order equal append order.
 *
 * Threads are listed and paged `ORDER BY created_at, message_id`, and message
 * ids are random UUIDs. So two messages appended in the same millisecond used
 * to come back in id order (random), and the `(created_at, message_id)`
 * before-cursor could skip or repeat one across that boundary. The adapters now
 * read the session's newest stored `created_at` inside the append transaction
 * and pass it here: a stamp that is not strictly after it becomes head + 1 ms.
 *
 * Rows already stored are never rewritten, and a cursor is still
 * `<ISO>~<messageId>` — only NEW appends can move, and only forward, by the
 * smallest step that restores a strict order. A burst of N same-ms appends
 * therefore spans N ms.
 */
export function nextChatMessageCreatedAt(requested: string, head: string | null): string {
  if (head === null) return requested;
  const req = Date.parse(requested);
  const last = Date.parse(head);
  // An unparseable stamp on either side: do not invent a time. Order then
  // falls back to the `(created_at, message_id)` tie-break, as before.
  if (!Number.isFinite(req) || !Number.isFinite(last)) return requested;
  return req > last ? requested : new Date(last + 1).toISOString();
}
