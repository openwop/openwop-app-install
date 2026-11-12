import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';
import type { StorageSubjectState } from '../../../platform/useStorageSubject.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';

/**
 * ADR 1040 D1/D2 — a persisted EMBED (`detached`) is a real, saved conversation
 * that is never the singleton main chat:
 *   - it starts fresh, never from the main chat's current-session slot, and
 *     never writes that slot;
 *   - it is not reseeded from that slot when auth settles (IDN-11);
 *   - its first send creates the row WITH the agent stamp;
 *   - neither reset nor a `not_found` load eagerly creates an empty row (a tab
 *     needs that to stop a remount loop; a detached embed does not remount).
 *
 * Red when: core.ts loads or writes the slot for a detached hook
 * (`useCurrentCache`, `writeCurrentCache`), the IDN-11 reseed guard admits it,
 * useSessionPersistence drops `participants` from the create, either eager
 * create (reset, `not_found` recovery) loses its `!detached` guard, or the
 * `not_found` recovery stops opening a fresh chat.
 */

vi.mock('../../../client/streamsClient.js', () => ({ subscribeToRun: () => ({ close: vi.fn() }) }));
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
  listChatSessionMessagesPage: vi.fn(() => Promise.resolve({ messages: [], nextCursor: null })),
  setConversationRun: vi.fn(() => Promise.resolve()),
  updateChatMessage: vi.fn(() => Promise.resolve()),
  getSessionFeedback: vi.fn(() => Promise.resolve({})),
}));
type Transport = typeof import('../../conversationTransport.js');
const { openConversationSessionMock } = vi.hoisted(() => ({
  openConversationSessionMock: vi.fn<Transport['openConversationSession']>(() => Promise.resolve({ runId: 'conv-run-1', nodeId: 'gate' })),
}));
vi.mock('../../conversationTransport.js', async (importOriginal) => ({
  ...(await importOriginal<Transport>()),
  openConversationSession: openConversationSessionMock,
  // A synchronous exchange (the agent turn is already on the wire), so `send` settles.
  sendConversationTurn: vi.fn<Transport['sendConversationTurn']>(() => Promise.resolve({
    turns: [
      { messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'hello guide', ts: 0 },
      { messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: 'assistant', content: 'hi', ts: 0 },
    ],
    lastSeq: 2,
  })),
  fetchTurns: vi.fn<Transport['fetchTurns']>(() => Promise.resolve({ turns: [], lastSeq: 0 })),
}));
// The storage subject, controllable: the IDN-11 reseed fires when it settles.
const subject = vi.hoisted((): { value: StorageSubjectState } => ({ value: { status: 'pending' } }));
vi.mock('../../../platform/useStorageSubject.js', () => ({ useStorageSubject: () => subject.value }));

import { useChatSession } from '../useChatSession.js';
import { createChatSession, listChatSessionMessagesPage } from '../../../client/chatSessionsClient.js';
import { persistSession } from '../../lib/chatPersistence.js';
import { LS_CURRENT_SESSION_KEY } from '../../lib/storageKeys.js';
import type { ChatSession } from '../../types.js';

const CONFIG: BYOKActiveConfig = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' };
const PARTICIPANTS = ['agent:host:guide'];
const MAIN: ChatSession = {
  id: 'main-chat', title: 'My main chat', createdAt: '2026-01-01T00:00:00Z',
  messages: [{ id: 'main:u1', role: 'user', content: 'main chat text', createdAt: '2026-01-01T00:00:00Z' }],
};

beforeEach(() => {
  localStorage.clear();
  subject.value = { status: 'pending' };
  vi.mocked(createChatSession).mockReset();
  // The real client answers the created row's header.
  vi.mocked(createChatSession).mockImplementation(async (opts): Promise<ChatSessionHeader> => ({
    sessionId: opts?.sessionId ?? 'minted', tenantId: 't-1', title: opts?.title ?? 'New chat',
    createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', messageCount: 0,
  }));
  vi.mocked(listChatSessionMessagesPage).mockReset();
  vi.mocked(listChatSessionMessagesPage).mockResolvedValue({ messages: [], nextCursor: null });
  // The user's main chat is in the singleton slot.
  persistSession(MAIN);
});

describe('ADR 1040 D1 — a detached embed is never the main chat', () => {
  it('starts fresh, never from the main chat slot, and never writes it', async () => {
    const before = localStorage.getItem(LS_CURRENT_SESSION_KEY);
    const { result } = renderHook(() => useChatSession({ persist: true, detached: true, participants: PARTICIPANTS }));
    expect(result.current.session.id).not.toBe(MAIN.id);
    expect(result.current.session.messages).toEqual([]);
    await act(async () => { await result.current.send('hello guide', CONFIG); });
    // The turn landed (so the post-send persist ran), and still not into the slot.
    expect(result.current.session.messages.map((m) => m.content)).toContain('hello guide');
    expect(localStorage.getItem(LS_CURRENT_SESSION_KEY)).toBe(before);
  });

  it('is not reseeded from the main chat slot when auth settles', async () => {
    const { result, rerender } = renderHook(() => useChatSession({ persist: true, detached: true, participants: PARTICIPANTS }));
    const id = result.current.session.id;
    subject.value = { status: 'user', subject: 'u-1' };
    rerender();
    await act(async () => { await Promise.resolve(); });
    expect(result.current.session.id).toBe(id);
    expect(result.current.session.messages).toEqual([]);
  });

  it('the main chat (control) IS reseeded on that same settle', async () => {
    localStorage.clear();
    const { result, rerender } = renderHook(() => useChatSession());
    persistSession(MAIN);
    expect(result.current.session.id).not.toBe(MAIN.id);
    subject.value = { status: 'user', subject: 'u-1' };
    rerender();
    // The SAME drain the detached case uses: the reseed lands within it.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.session.id).toBe(MAIN.id);
  });
});

describe('ADR 1040 D1/D2 — the row: created by the first send, with the agent stamp, never eagerly', () => {
  it('no row on mount; the first send creates it naming the agent', async () => {
    const { result } = renderHook(() => useChatSession({ persist: true, detached: true, participants: PARTICIPANTS }));
    await act(async () => { await Promise.resolve(); });
    expect(vi.mocked(createChatSession)).not.toHaveBeenCalled();
    await act(async () => { await result.current.send('hello guide', CONFIG); });
    await waitFor(() => expect(vi.mocked(createChatSession)).toHaveBeenCalled());
    expect(result.current.session.messages.map((m) => m.content)).toContain('hello guide');
    // Every create (the run-id write-through and the message persist may both
    // ensure the row) names this conversation and its agent, and nothing else.
    for (const [arg] of vi.mocked(createChatSession).mock.calls) {
      expect(arg).toEqual({ sessionId: result.current.session.id, title: expect.any(String), participants: PARTICIPANTS });
    }
  });

  it('reset in a reopened (backend-keyed) detached embed creates no empty row', async () => {
    const onSessionIdChange = vi.fn();
    const { result } = renderHook(() => useChatSession({ persist: true, detached: true, participants: PARTICIPANTS, sessionId: 'opened-1', onSessionIdChange }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));
    act(() => { result.current.reset(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.session.id).not.toBe('opened-1');
    expect(onSessionIdChange).toHaveBeenCalledWith(result.current.session.id);
    expect(vi.mocked(createChatSession)).not.toHaveBeenCalled();
  });

  it('a stale (not_found) conversation id recovers to a fresh chat without creating a row', async () => {
    vi.mocked(listChatSessionMessagesPage).mockRejectedValueOnce(new Error('not_found: chat_session "gone" not found.'));
    const { result } = renderHook(() => useChatSession({ persist: true, detached: true, participants: PARTICIPANTS, sessionId: 'gone' }));
    await waitFor(() => expect(result.current.isHydrating).toBe(false));
    expect(result.current.session.id).not.toBe('gone');
    expect(result.current.error).toBeNull();
    expect(vi.mocked(createChatSession)).not.toHaveBeenCalled();
  });
});
