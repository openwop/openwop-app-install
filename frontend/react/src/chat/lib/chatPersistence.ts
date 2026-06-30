/**
 * chatPersistence — the chat domain's localStorage I/O, extracted from
 * useChatSession so persistence is a separately testable seam (frontend
 * enterprise-review Batch I). Behavior is identical to the prior inline
 * implementation: a single current-session blob plus a bounded session-header
 * index the History drawer falls back to when the BE list is unavailable.
 *
 * Keys + the index version live in storageKeys.ts. See STORAGE.md for the
 * class (`content`) and retention policy.
 */

import i18n from '../../i18n/index.js';
import type { ChatSession } from '../types.js';
import {
  LS_CURRENT_SESSION_KEY as LS_KEY,
  LS_SESSION_INDEX_KEY as LS_INDEX_KEY,
  LS_SESSION_INDEX_VERSION,
} from './storageKeys.js';

/** Max session headers retained in the local index — bounded for quota. */
export const LOCAL_INDEX_MAX = 50;

export interface LocalSessionHeader {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface LocalSessionIndexEnvelope {
  v: number;
  items: LocalSessionHeader[];
}

export function readSessionIndex(): LocalSessionHeader[] {
  try {
    const raw = localStorage.getItem(LS_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<LocalSessionIndexEnvelope>;
    // Drop payloads from a different version — shape may have drifted.
    if (parsed.v !== LS_SESSION_INDEX_VERSION) return [];
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items;
  } catch {
    /* corrupt; treat as empty */
  }
  return [];
}

export function writeSessionIndex(items: readonly LocalSessionHeader[]): void {
  try {
    const envelope: LocalSessionIndexEnvelope = {
      v: LS_SESSION_INDEX_VERSION,
      items: [...items],
    };
    localStorage.setItem(LS_INDEX_KEY, JSON.stringify(envelope));
  } catch {
    /* over-quota; silently drop */
  }
}

/** Build the index header for a session (pure). */
export function sessionHeader(session: ChatSession, now: string): LocalSessionHeader {
  return {
    sessionId: session.id,
    title: session.title || i18n.t('chat:newChat'),
    createdAt: session.createdAt,
    updatedAt: now,
    messageCount: session.messages.filter((m) => m.role !== 'system').length,
  };
}

/** Upsert a session header into the local index. The drawer reads this as a
 *  fallback when the BE session list is unavailable. */
export function upsertSessionIndex(session: ChatSession): void {
  const items = readSessionIndex();
  const idx = items.findIndex((it) => it.sessionId === session.id);
  const header = sessionHeader(session, new Date().toISOString());
  if (idx >= 0) items[idx] = header;
  else items.unshift(header);
  writeSessionIndex(items.slice(0, LOCAL_INDEX_MAX));
}

/** Load the current session from localStorage, or a fresh empty one. */
/** A brand-new empty session. Used as the loadSession fallback AND as the
 *  initial session for an ephemeral (non-persisted) chat — e.g. the builder's
 *  embedded authoring chat (ADR 0073 Phase 3), which must NOT read the shared
 *  `openwop-app.chat.session` key. */
export function freshSession(id?: string): ChatSession {
  return {
    // A caller may pin the id (multi-tab backend-keyed sessions, ADR 0140, start
    // as an empty placeholder under their own conversation id before the backend
    // thread hydrates). Defaults to a fresh random id for the singleton/ephemeral
    // callers, unchanged.
    id: id ?? crypto.randomUUID(),
    title: i18n.t('chat:newChat'),
    messages: [],
    createdAt: new Date().toISOString(),
  };
}

/** Generic placeholder titles that must never DOWNGRADE a real index header
 *  (ADR 0140): a freshly backend-loaded tab carries the "Saved chat" placeholder
 *  until the real title arrives, and N keyed tabs share the local index. */
function isPlaceholderTitle(title: string): boolean {
  return title === i18n.t('chat:newChat') || title === i18n.t('chat:savedChat');
}

export function loadSession(): ChatSession {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as ChatSession;
  } catch {
    /* fall through to fresh */
  }
  return freshSession();
}

/** Persist the current session + mirror its header into the local index
 *  (skipping empty placeholder sessions).
 *
 *  `writeCurrentCache` (default true) controls the SHARED singleton current-session
 *  blob (`LS_CURRENT_SESSION_KEY`). The singleton "main" chat writes it; a
 *  backend-keyed multi-tab session (ADR 0140) passes `false` — N concurrent tabs
 *  must NOT clobber the one current cache. The keyed index upsert (the offline
 *  History-drawer fallback) still runs for both, since it is per-`sessionId` and
 *  collision-free — except a keyed tab won't downgrade a real title to a
 *  placeholder (see `isPlaceholderTitle`). */
export function persistSession(session: ChatSession, opts: { writeCurrentCache?: boolean } = {}): void {
  const writeCurrentCache = opts.writeCurrentCache !== false;
  if (writeCurrentCache) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(session));
    } catch {
      /* over-quota; silently drop */
    }
  }
  if (!session.messages.some((m) => m.role !== 'system')) return;
  // Backend-keyed tabs: the BE session list is authoritative for titles; never
  // let a just-loaded "Saved chat" placeholder overwrite a real index header.
  if (!writeCurrentCache && isPlaceholderTitle(session.title)) return;
  upsertSessionIndex(session);
}
