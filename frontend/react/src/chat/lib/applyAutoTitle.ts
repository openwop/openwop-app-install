/**
 * ADR 0151 / `ATU-1` / ADR 1019 D4 — the auto-titler's title reaching the person.
 * One helper so every path (the in-exchange SSE event, the header follow) does the
 * same three things:
 *  - swaps the open chat's title, only when it is still the chat that was titled;
 *  - announces it politely (a rename is information, not an alert) with the new title;
 *  - tells every session list — the rail and the tab labels, in this tab and others —
 *    to refetch the header. Before ADR 1019 only the first happened, and nothing a
 *    person looks at read it.
 */
import i18n from '../../i18n/index.js';
import { announce } from '../../ui/announce.js';
import { announceSessionRenamed } from './sessionBroadcast.js';

export function applyAutoTitle<S extends { id: string; title: string }>(
  title: string,
  setSession: (updater: (s: S) => S) => void,
  sessionId: string,
  /** Is `sessionId` the chat on screen right now? A person who switched away is not
   *  told a chat they are not looking at was renamed (its rail row still updates). */
  isOpen: boolean,
): void {
  setSession((s) => (s.id === sessionId ? { ...s, title } : s));
  if (isOpen) announce(i18n.t('chat:conversationRenamed', { title }));
  announceSessionRenamed(sessionId);
}
