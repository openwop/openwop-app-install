/**
 * The cross-tab session-list channel (Phase 2C.2), shared by its listener
 * (`useChatSessions`) and by a publisher that is not that hook — the auto-titler
 * (ADR 1019 D4). A message posted from a SEPARATE channel object reaches every
 * listener with the same name, the publishing tab's own `useChatSessions` included,
 * so one post refreshes the rail and the tab labels everywhere the chat is shown.
 */
export const CHAT_SESSIONS_CHANNEL = 'openwop-sample-chat';

/** Tell every mounted session list (this tab and others) that `sessionId`'s header
 *  changed, so each refetches it. Best-effort: a browser without BroadcastChannel
 *  just keeps its list until the next refresh. */
export function announceSessionRenamed(sessionId: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(CHAT_SESSIONS_CHANNEL);
    ch.postMessage({ kind: 'session:renamed', sessionId });
    ch.close();
  } catch { /* best-effort */ }
}
