import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * ADR 0140 P1 gate — the multi-tab persistence-isolation test.
 *
 * The load-bearing invariant: a backend-keyed session (one chat tab) must NEVER
 * touch the SHARED singleton localStorage current-session cache
 * (`LS_CURRENT_SESSION_KEY`), because N concurrent tabs would clobber it. The
 * durable backend store + the keyed local index are per-`sessionId` and stay
 * isolated. This pins both halves:
 *   (1) the persistence seam directly (no React) — the clobber property, and
 *   (2) the hook — two concurrent backend-keyed sessions stay isolated and the
 *       singleton cache is never written, while the singleton main chat STILL
 *       writes it (no regression).
 */

// --- client mocks (mirror the integration harness) -----------------------
vi.mock('../../../client/streamsClient.js', () => ({
  subscribeToRun: () => ({ close: vi.fn() }),
}));
vi.mock('../../../client/runsClient.js', () => ({
  createRun: vi.fn(() => Promise.resolve({ runId: 'run-1' })),
  cancelRun: vi.fn(() => Promise.resolve()),
  getRun: vi.fn(() => Promise.resolve({ status: 'running' })),
  pollEvents: vi.fn(() => Promise.resolve({ events: [], isComplete: true })),
  getSdkClient: vi.fn(),
}));
vi.mock('../../../client/interruptsClient.js', () => ({
  listOpenInterrupts: vi.fn(() => Promise.resolve([])),
  resolveByRun: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../client/chatSessionsClient.js', () => ({
  createChatSession: vi.fn(() => Promise.resolve()),
  appendChatMessage: vi.fn(() => Promise.resolve()),
  listChatSessionMessages: vi.fn(() => Promise.resolve([])),
  // Per-session distinct thread so we can prove in-memory isolation.
  listChatSessionMessagesPage: vi.fn((sessionId: string) => Promise.resolve({
    messages: [{
      messageId: `${sessionId}:m1`,
      content: JSON.stringify({ role: 'user', content: `hello from ${sessionId}`, createdAt: '2026-01-01T00:00:00Z' }),
      createdAt: '2026-01-01T00:00:00Z',
    }],
    nextCursor: null,
  })),
  setConversationRun: vi.fn(() => Promise.resolve()),
  updateChatMessage: vi.fn(() => Promise.resolve()),
  getSessionFeedback: vi.fn(() => Promise.resolve({})),
}));

import { useChatSession } from '../useChatSession.js';
import { createChatSession, listChatSessionMessagesPage } from '../../../client/chatSessionsClient.js';
import {
  persistSession,
  readSessionIndex,
  loadSession,
} from '../../lib/chatPersistence.js';
import { LS_CURRENT_SESSION_KEY } from '../../lib/storageKeys.js';
import i18n from '../../../i18n/index.js';
import type { ChatSession } from '../../types.js';

function sessionWith(id: string, title: string): ChatSession {
  return {
    id,
    title,
    createdAt: '2026-01-01T00:00:00Z',
    messages: [{ id: `${id}:u1`, role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00Z' }],
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('ADR 0140 — persistence seam: the singleton clobber is closed', () => {
  it('writeCurrentCache:false never writes the shared current-session slot, but DOES key the index', () => {
    persistSession(sessionWith('tab-A', 'Plan the launch'), { writeCurrentCache: false });
    expect(localStorage.getItem(LS_CURRENT_SESSION_KEY)).toBeNull();
    const idx = readSessionIndex();
    expect(idx.map((h) => h.sessionId)).toEqual(['tab-A']);
  });

  it('two backend-keyed sessions produce TWO keyed index headers (no shared slot to clobber)', () => {
    persistSession(sessionWith('tab-A', 'Plan the launch'), { writeCurrentCache: false });
    persistSession(sessionWith('tab-B', 'Draft the memo'), { writeCurrentCache: false });
    expect(localStorage.getItem(LS_CURRENT_SESSION_KEY)).toBeNull();
    const ids = readSessionIndex().map((h) => h.sessionId).sort();
    expect(ids).toEqual(['tab-A', 'tab-B']);
  });

  it('the singleton main chat STILL writes the current-session cache (no regression)', () => {
    persistSession(sessionWith('main', 'My chat'));
    expect(localStorage.getItem(LS_CURRENT_SESSION_KEY)).not.toBeNull();
    expect(loadSession().id).toBe('main');
  });

  it('a backend-keyed load does NOT downgrade a real index title to a placeholder', () => {
    // A real title is recorded (e.g. from a prior write).
    persistSession(sessionWith('tab-A', 'Real title'), { writeCurrentCache: false });
    // Then a fresh load carries the generic "Saved chat" placeholder — must be ignored.
    persistSession(sessionWith('tab-A', i18n.t('chat:savedChat')), { writeCurrentCache: false });
    const header = readSessionIndex().find((h) => h.sessionId === 'tab-A');
    expect(header?.title).toBe('Real title');
  });
});

describe('ADR 0140 — useChatSession: two concurrent backend-keyed tabs stay isolated', () => {
  it('each tab hydrates its OWN thread and neither writes the singleton cache', async () => {
    const a = renderHook(() => useChatSession({ sessionId: 'tab-A' }));
    const b = renderHook(() => useChatSession({ sessionId: 'tab-B' }));
    // Flush the one-shot mount-load + its setState for both hooks.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(a.result.current.session.id).toBe('tab-A');
    expect(b.result.current.session.id).toBe('tab-B');
    // In-memory isolation: each tab shows only its own message.
    const aText = a.result.current.session.messages.map((m) => m.content).join('|');
    const bText = b.result.current.session.messages.map((m) => m.content).join('|');
    expect(aText).toContain('hello from tab-A');
    expect(bText).toContain('hello from tab-B');
    expect(aText).not.toContain('tab-B');
    // The clobber vector is closed: no tab wrote the shared current-session slot.
    expect(localStorage.getItem(LS_CURRENT_SESSION_KEY)).toBeNull();

    a.unmount();
    b.unmount();
  });

  it('the singleton main chat (no sessionId) DOES write the current-session cache', async () => {
    const main = renderHook(() => useChatSession());
    await act(async () => { await Promise.resolve(); });
    expect(localStorage.getItem(LS_CURRENT_SESSION_KEY)).not.toBeNull();
    main.unmount();
  });
});

describe('ADR 0140 — backend-keyed not_found breaks the remount→404→re-key loop', () => {
  it('eagerly creates the re-keyed fresh session server-side (so a remount load is 200, not another 404)', async () => {
    // The bound session is gone server-side → the mount-load 404s. Recovery re-keys
    // the tab to a fresh id; because re-keying remounts the tab (key={sessionId}),
    // that fresh id MUST already exist server-side or the remount's one-shot load
    // 404s again and re-keys again — the unbounded "hundreds of 404s" loop.
    vi.mocked(listChatSessionMessagesPage).mockRejectedValueOnce(
      new Error('not_found: chat_session "dead-tab" not found.'),
    );
    vi.mocked(createChatSession).mockClear();
    const onSessionIdChange = vi.fn();

    const tab = renderHook(() => useChatSession({ sessionId: 'dead-tab', onSessionIdChange }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Recovered to a fresh empty chat under a NEW id, no error surfaced.
    expect(tab.result.current.session.id).not.toBe('dead-tab');
    expect(tab.result.current.session.messages).toEqual([]);
    expect(tab.result.current.error).toBeNull();
    // The tab is told to re-key to that fresh id…
    expect(onSessionIdChange).toHaveBeenCalledWith(tab.result.current.session.id);
    // …and CRUCIALLY the fresh id is created server-side first, so the remount's
    // load resolves 200 (empty) instead of 404 → the loop terminates.
    expect(vi.mocked(createChatSession)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: tab.result.current.session.id }),
    );

    tab.unmount();
  });
});
