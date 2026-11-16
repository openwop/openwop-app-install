/**
 * ADR 0897 — the host ends every host-extension stream after a few minutes and
 * the voice transcript stream has no replay. A message posted in the reconnect
 * gap sends no frame, so a REconnect reloads the thread once. The first connect
 * does not (the caller loaded the thread when it subscribed).
 *
 * Red when: the first connect refreshes; a reconnect does not refresh; a
 * reconnect refreshes more than once.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { subscribeVoiceTranscripts } from '../voiceClient.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const drain = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const ended = (): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { c.close(); } });

describe('subscribeVoiceTranscripts — ADR 0897 bounded close', () => {
  it('a reconnect refreshes once; the first connect does not', async () => {
    const fetchMock = vi.fn(async () => new Response(ended(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // The backoff after a connect is a RANDOM 500–1000 ms. With a short roll the
    // reconnected stream ends and its next timer still falls inside the 1 s
    // advance below, so a third connect refreshes again (red under load; red
    // every time with random=0). Pin the roll to 1: every backoff is exactly
    // 1000 ms and the next timer lands outside the window.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    // Each refresh records WHICH connect it followed, so "once, on the reconnect"
    // is one value: [2]. A first-connect refresh reads [1, …]; a double one [2, 2].
    const refreshedAfterConnect: number[] = [];
    const onMessage = (): void => { refreshedAfterConnect.push(fetchMock.mock.calls.length); };
    const unsub = subscribeVoiceTranscripts('conv-1', onMessage);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await drain();
    expect(refreshedAfterConnect).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await drain();
    unsub();
    expect(refreshedAfterConnect).toEqual([2]);
  });
});
