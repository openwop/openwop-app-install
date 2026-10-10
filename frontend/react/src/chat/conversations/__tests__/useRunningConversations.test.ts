/**
 * ADR 0776 P2 — the rail's "Running" for closed conversations. Pins: the
 * server's answer becomes the set; a FAILED read keeps the last answer (a blip
 * must not claim nothing is running); a hidden page does not poll; focus
 * re-reads. The client is mocked with a plain function (a cleared vi.fn whose
 * promise rejects fails the test under Vitest 4 even when handled).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

let impl: () => Promise<unknown> = async () => ({ conversations: [], truncated: false });
let calls = 0;
vi.mock('../../../client/chatSessionsClient.js', () => ({
  listRunningConversations: () => { calls++; return impl(); },
}));

import { useRunningConversations } from '../useRunningConversations.js';

const answer = (...ids: string[]) => async () => ({ conversations: ids.map((conversationId) => ({ conversationId, runs: 1 })), truncated: false });
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  calls = 0;
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('useRunningConversations (ADR 0776 P2)', () => {
  it('reflects the server\'s answer and re-reads on focus', async () => {
    impl = answer('a');
    const { result } = renderHook(() => useRunningConversations());
    await waitFor(() => expect([...result.current]).toEqual(['a']));
    impl = answer('a', 'b');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect([...result.current].sort()).toEqual(['a', 'b']));
  });

  it('a failed read keeps the last answer', async () => {
    impl = answer('a');
    const { result } = renderHook(() => useRunningConversations());
    await waitFor(() => expect([...result.current]).toEqual(['a']));
    impl = async () => { throw new Error('503'); };
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { await Promise.resolve(); });
    expect(calls).toBe(2);
    expect([...result.current]).toEqual(['a']);
  });

  it('polls every 20 s while visible, not while hidden', async () => {
    vi.useFakeTimers();
    impl = answer();
    renderHook(() => useRunningConversations());
    expect(calls).toBe(1);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(calls).toBe(2);
    visibility = 'hidden';
    await act(async () => { vi.advanceTimersByTime(40_000); });
    expect(calls).toBe(2);
  });

  it('asks nothing when disabled', () => {
    renderHook(() => useRunningConversations(false));
    expect(calls).toBe(0);
  });
});
