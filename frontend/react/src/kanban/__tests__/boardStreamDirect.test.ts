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
});
