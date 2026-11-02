/**
 * ADR 1019 D4 — a header-change notice (`session:renamed`, e.g. an auto-title) that
 * arrives while the rail is already refreshing is not dropped: the in-flight fetch may
 * predate the change, so one more fetch runs after it and the rail shows the new title.
 * A plain refresh during a fetch is still coalesced (no extra fetch on mount).
 * Sabotage (2026-10-31): channel handler back to the coalescing `refresh()` → the
 * first case keeps the placeholder title and reds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const listChatSessions = vi.fn();
vi.mock('../../client/chatSessionsClient.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../client/chatSessionsClient.js')>();
  return { ...original, listChatSessions: (...a: unknown[]) => listChatSessions(...a) };
});

import { useChatSessions } from '../hooks/useChatSessions.js';
import { announceSessionRenamed } from '../lib/sessionBroadcast.js';

const header = (title: string) => ({ sessionId: 's1', tenantId: 't', title, createdAt: 'x', updatedAt: 'x', messageCount: 2 });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => { listChatSessions.mockReset(); });

describe('useChatSessions — a rename notice during a refresh (ADR 1019 D4)', () => {
  it('fetches again after the in-flight refresh, so the new title lands', async () => {
    const first = deferred<unknown[]>();
    listChatSessions.mockImplementationOnce(() => first.promise).mockResolvedValue([header('Trip Planning')]);
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(1));
    announceSessionRenamed('s1'); // arrives while the mount fetch is still out
    await new Promise((r) => setTimeout(r, 20));
    await act(async () => { first.resolve([header('plan a trip to lisbon in may')]); });
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe('Trip Planning'));
    expect(listChatSessions).toHaveBeenCalledTimes(2);
  });
});
