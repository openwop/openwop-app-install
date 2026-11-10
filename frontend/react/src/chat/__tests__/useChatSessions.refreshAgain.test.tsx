/**
 * ADR 1019 D4 — a header-change notice (`session:renamed`, e.g. an auto-title) that
 * arrives while the rail is already refreshing is not dropped: the in-flight fetch may
 * predate the change, so one more fetch runs after it and the rail shows the new title.
 * A plain refresh during a fetch is still coalesced: the hook's two mount refreshes (the
 * mount effect and the storage-subject effect) make ONE fetch, with no replay.
 * Sabotage (2026-10-31, re-measured wave 82): channel handler back to the coalescing
 * `refresh()`, or the replay loop removed → the first case keeps the placeholder title and
 * reds; every in-flight refresh requesting a replay (not only a header change) → the
 * second case sees two fetches and reds; no in-flight guard → both red on the parallel
 * mount fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ChatSessionHeader, listChatSessions as ListChatSessions } from '../../client/chatSessionsClient.js';

const listChatSessions = vi.fn<typeof ListChatSessions>();
vi.mock('../../client/chatSessionsClient.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../client/chatSessionsClient.js')>();
  return { ...original, listChatSessions: (...a: Parameters<typeof ListChatSessions>) => listChatSessions(...a) };
});

import { useChatSessions } from '../hooks/useChatSessions.js';
import { announceSessionRenamed, CHAT_SESSIONS_CHANNEL } from '../lib/sessionBroadcast.js';

const header = (title: string): ChatSessionHeader => ({
  sessionId: 's1', tenantId: 't', title, createdAt: '2026-10-31T09:00:00.000Z', updatedAt: '2026-10-31T09:00:00.000Z', messageCount: 2,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const drain = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

afterEach(() => { listChatSessions.mockReset(); });

describe('useChatSessions — a rename notice during a refresh (ADR 1019 D4)', () => {
  it('fetches again after the in-flight refresh, so the new title lands', async () => {
    const first = deferred<ChatSessionHeader[]>();
    listChatSessions.mockImplementationOnce(() => first.promise).mockResolvedValue([header('Trip Planning')]);
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(1));
    // Settle signal for the notice: a second listener on the same channel sees it, then
    // a drain lets the hook's own listener run. The mount fetch is still out.
    const probe = new BroadcastChannel(CHAT_SESSIONS_CHANNEL);
    const delivered = new Promise<void>((r) => { probe.onmessage = () => r(); });
    announceSessionRenamed('s1');
    await delivered;
    probe.close();
    await drain();
    // The notice landed while the fetch was in flight and started no parallel fetch.
    expect(listChatSessions).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve([header('plan a trip to lisbon in may')]); });
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe('Trip Planning'));
    expect(listChatSessions).toHaveBeenCalledTimes(2);
  });

  it('two plain mount refreshes during the fetch make ONE fetch (coalesced, no replay)', async () => {
    const first = deferred<ChatSessionHeader[]>();
    listChatSessions.mockImplementationOnce(() => first.promise).mockResolvedValue([header('should not be fetched')]);
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(1));
    await act(async () => { first.resolve([header('plan a trip to lisbon in may')]); });
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe('plan a trip to lisbon in may'));
    await act(async () => { await drain(); });
    expect(listChatSessions).toHaveBeenCalledTimes(1);
    expect(result.current.sessions[0]?.title).toBe('plan a trip to lisbon in may');
  });
});
