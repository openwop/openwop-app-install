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
    title: session.title || 'New chat',
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
export function loadSession(): ChatSession {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as ChatSession;
  } catch {
    /* fall through to fresh */
  }
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    messages: [],
    createdAt: new Date().toISOString(),
  };
}

/** Persist the current session + mirror its header into the local index
 *  (skipping empty placeholder sessions). */
export function persistSession(session: ChatSession): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(session));
  } catch {
    /* over-quota; silently drop */
  }
  if (session.messages.some((m) => m.role !== 'system')) {
    upsertSessionIndex(session);
  }
}
