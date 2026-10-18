/**
 * The board change stream (`subscribeBoardEvents`) — prod incident witness.
 *
 * 2026-10-09 (595aa8537, #4657): the stream rode the Firebase `/api` proxy, which
 * buffers `text/event-stream` and never forwards the browser's abort, so every
 * board visit held a per-tenant SSE slot for the full 3600 s request timeout;
 * one user filled the 20-slot cap and every new stream 429'd. It must open on
 * `config.sseBaseUrl` (the direct run.app base), with the cookie credentials.
 *
 * 2026-10-10 (f33301fbd): even direct, an in-page abort never reached the
 * container, so the server now ends each stream after KANBAN_STREAM_MAX_AGE_MS.
 * The client must reconnect 1 s after a clean end, back off 5 s → 10 s → … 60 s
 * on a refusal/network error, and NEVER reconnect after unsubscribe (which
 * aborts the in-flight fetch). Breaks: an `/api` base, a dropped `fetchOpts`, a
 * no-op unsubscribe, or a reconnect loop that ignores the abort.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../client/config.js', () => ({
  config: { baseUrl: '/api', sseBaseUrl: 'https://backend.example.run.app', authMode: 'cookie' },
  authedHeaders: (extra?: Record<string, string>) => ({ authorization: 'Bearer t', ...(extra ?? {}) }),
  fetchOpts: (init?: RequestInit) => ({ ...(init ?? {}), credentials: 'include' }),
}));

import { subscribeBoardEvents } from '../kanbanClient.js';

describe('subscribeBoardEvents', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens the board stream on the direct SSE base, not the /api proxy (which never releases the slot)', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const unsubscribe = subscribeBoardEvents('board-1', () => undefined);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://backend.example.run.app/host/openwop-app/kanban/boards/board-1/events');
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer t');

    unsubscribe();
    expect(init?.signal?.aborted).toBe(true);
  });

  // The server ends each stream after KANBAN_STREAM_MAX_AGE_MS (an in-page
  // abort never reached the container in prod), so a subscribed board must
  // reconnect when its stream ends, and must stop once unsubscribed.
  describe('reconnect', () => {
    afterEach(() => vi.useRealTimers());

    const ended = () => new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

    it('reconnects 1 s after the server ends the stream, while still subscribed', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => ended());
      vi.stubGlobal('fetch', fetchMock);
      const unsubscribe = subscribeBoardEvents('board-1', () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      unsubscribe();
    });

    it('backs off on a refusal (429): 5 s, then 10 s', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));
      vi.stubGlobal('fetch', fetchMock);
      const unsubscribe = subscribeBoardEvents('board-1', () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      unsubscribe();
    });

    it('never reconnects after unsubscribe', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => ended());
      vi.stubGlobal('fetch', fetchMock);
      const unsubscribe = subscribeBoardEvents('board-1', () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      unsubscribe();
      await flush();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
