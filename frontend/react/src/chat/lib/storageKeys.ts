/**
 * Single source of truth for the chat-surface localStorage keys.
 *
 * Both `useChatSession` (writer) and `useChatSessions` (reader fallback)
 * touch these keys. Keeping the literals in one module prevents silent
 * divergence if a future refactor renames one side without the other.
 */

/** Current single in-flight chat session (full message thread). */
export const LS_CURRENT_SESSION_KEY = 'openwop-app.chat.session';

/** Multi-session index — list of session HEADERS for the History drawer
 *  to render when the BE write-through is in a cold-start / 401 state
 *  and `listChatSessions()` returns empty. */
export const LS_SESSION_INDEX_KEY = 'openwop-app.chat.sessions-index';

/** Bump when `LocalSessionHeader` shape changes. Older cached entries
 *  with a different version are discarded on read so the drawer never
 *  shows stale data with a wrong shape. */
export const LS_SESSION_INDEX_VERSION = 1;

/** Multi-tab chat working-set descriptor (ADR 0140 P6). Namespaced PER USER —
 *  localStorage is per-origin, so the key carries the authenticated subject to keep
 *  user A's open tabs from surfacing for user B on a shared browser. */
export const LS_TABDECK_KEY_PREFIX = 'openwop-app.chat.tabdeck';
export const LS_TABDECK_VERSION = 1;
export const tabDeckKey = (subject: string): string => `${LS_TABDECK_KEY_PREFIX}:${subject}`;
