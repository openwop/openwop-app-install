/**
 * chatPersistence — the chat's localStorage seam (frontend enterprise-review
 * Batch I; subject-scoped keys per ADR 0434 Phase 3 — anonymous, as here, is the
 * bare key). Breaks it: a system-only placeholder session indexed into History,
 * an unbounded (quota-blowing) or oldest-first index that drops the user's most
 * recent chats, or a corrupt blob crashing the chat on boot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSession, persistSession, readSessionIndex, sessionHeader, LOCAL_INDEX_MAX,
} from '../chatPersistence.js';
import type { ChatSession, ChatMessage } from '../../types.js';

const SESSION_KEY = 'openwop-app.chat.session';

function userMsg(id: string): ChatMessage {
  return { id, role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00Z' };
}
function session(over: Partial<ChatSession> = {}): ChatSession {
  return { id: 's1', title: 'Chat', messages: [userMsg('m1')], createdAt: '2026-01-01T00:00:00Z', ...over };
}

describe('chatPersistence', () => {
  beforeEach(() => localStorage.clear());

  it('loadSession returns a fresh empty session when nothing is stored', () => {
    const s = loadSession();
    expect(s.messages).toEqual([]);
    expect(typeof s.id).toBe('string');
  });

  it('round-trips a persisted session', () => {
    persistSession(session());
    const loaded = loadSession();
    expect(loaded.id).toBe('s1');
    expect(loaded.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('mirrors non-empty sessions into the local index but skips system-only ones', () => {
    persistSession(session());
    expect(readSessionIndex().map((h) => h.sessionId)).toEqual(['s1']);

    localStorage.clear();
    persistSession(session({ messages: [{ id: 'sys', role: 'system', content: 'x', createdAt: '2026-01-01T00:00:00Z' }] }));
    expect(readSessionIndex()).toEqual([]); // system-only → not indexed
  });

  it('loadSession survives a corrupt blob', () => {
    localStorage.setItem(SESSION_KEY, '{not json');
    expect(loadSession().messages).toEqual([]);
  });

  it('sessionHeader counts only non-system messages', () => {
    const h = sessionHeader(session({ messages: [userMsg('a'), { id: 'sys', role: 'system', content: '', createdAt: '' }] }), 'now');
    expect(h.messageCount).toBe(1);
  });

  it('bounds the index at LOCAL_INDEX_MAX entries, keeping the newest and dropping the oldest', () => {
    // 55 inserts: an ODD count past the cap, size checked after every insert so
    // an over-trim that later refills cannot pass.
    for (let i = 0; i < LOCAL_INDEX_MAX + 5; i++) {
      persistSession(session({ id: `s${i}` }));
      expect(readSessionIndex().length).toBe(Math.min(i + 1, LOCAL_INDEX_MAX));
    }
    const ids = readSessionIndex().map((h) => h.sessionId);
    expect(ids[0]).toBe('s54'); // newest first
    expect(ids[ids.length - 1]).toBe('s5'); // oldest survivor
    for (const dropped of ['s0', 's1', 's2', 's3', 's4']) expect(ids).not.toContain(dropped);
  });
});
