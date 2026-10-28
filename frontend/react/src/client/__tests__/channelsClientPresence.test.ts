/**
 * ADR 0126 Phase 4 — the FE presence consumer: parse channel.presence SSE frames,
 * reconnect after a transient drop, treat 403/404 as TERMINAL (CS-CH-2), declare the
 * SSE Accept header the rate-limiter exemption keys on (CS-CH-1), and POST typing.
 *
 * What breaks it: a presence-disabled (404) or membership-denied (403) host hammered by
 * reconnects, a transient drop that kills presence for good, or every reconnect burning
 * the per-IP request budget. Backoff runs on FAKE timers (only setTimeout/clearTimeout
 * are faked, so stream microtasks stay real) — no real-clock waits.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { subscribeChannelPresence, subscribeChannelMessages, setChannelTyping } from '../channelsClient.js';
import { config } from '../config.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Max first backoff = 1000 ms (cap/2 + jitter over [cap/2, cap], cap = 1 s). */
const PAST_FIRST_BACKOFF_MS = 1000;
const drain = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function sseBody(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });
}
const frame = (present: string[], typing: string[] = []): string =>
  `event: channel.presence\ndata: ${JSON.stringify({ conversationId: 'c1', present, typing })}\n\n`;
const fetchReturning = (make: () => Response) => vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => make());

describe('subscribeChannelPresence', () => {
  it('parses a channel.presence frame and calls back with the snapshot', async () => {
    vi.stubGlobal('fetch', fetchReturning(() => new Response(sseBody(frame(['user:alice'], ['user:alice'])), { status: 200 })));
    let unsub = (): void => {};
    const snap = await new Promise<{ present: string[]; typing: string[]; connected: boolean }>((resolve) => {
      unsub = subscribeChannelPresence('c1', (s) => resolve(s));
    });
    unsub(); // stop the reconnect loop so it doesn't leak into later tests
    expect(snap).toMatchObject({ conversationId: 'c1', present: ['user:alice'], typing: ['user:alice'], connected: true });
  });
});

describe('setChannelTyping', () => {
  it('POSTs the typing flag to the presence/typing endpoint', async () => {
    const m = fetchReturning(() => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', m);
    await setChannelTyping('c1', true);
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toBe(`${config.baseUrl}/host/openwop-app/channels/c1/presence/typing`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ typing: true });
  });
});

describe('subscribeChannelPresence reconnect (ADR 0126 hardening)', () => {
  it('reconnects after the stream ends (a transient drop does not kill presence)', async () => {
    let call = 0;
    // first connection yields alice then closes; second yields bob then closes
    const fetchMock = fetchReturning(() => { call += 1; return new Response(sseBody(frame([call === 1 ? 'user:alice' : 'user:bob'])), { status: 200 }); });
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const unsub = subscribeChannelPresence('c1', (snap) => { if (snap.connected) seen.push(snap.present[0]!); });
    await vi.waitFor(() => expect(seen).toEqual(['user:alice']));
    await drain(); // the stream has ended; the loop is parked in the backoff sleep
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    await vi.waitFor(() => expect(seen).toEqual(['user:alice', 'user:bob']));
    unsub();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); // reconnected
  });

  // One case per terminal status: silent (no callback, not even `connected:false`) AND no retry.
  it.each([
    ['is silent when presence is off — does NOT reconnect on 404 (presence disabled is terminal)', 404],
    ['CS-CH-2 — does NOT reconnect on 403 (membership denial is terminal, not transient)', 403],
  ])('%s', async (_title, status) => {
    const fetchMock = fetchReturning(() => new Response(null, { status }));
    vi.stubGlobal('fetch', fetchMock);
    const cb = vi.fn();
    const unsub = subscribeChannelPresence('c1', cb);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await drain();
    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    await drain();
    unsub();
    expect(fetchMock).toHaveBeenCalledTimes(1); // terminal ⇒ no retry
    expect(cb).not.toHaveBeenCalled();          // terminal ⇒ no snapshot at all
  });

  it('CS-CH-1 — the stream connect declares Accept: text/event-stream (the rate-limiter SSE exemption gate)', async () => {
    const fetchMock = fetchReturning(() => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const unsub = subscribeChannelPresence('c1', () => {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    unsub();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${config.sseBaseUrl}/host/openwop-app/channels/c1/presence`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(Object.entries(headers).some(([k, v]) => k.toLowerCase() === 'accept' && v.includes('text/event-stream'))).toBe(true);
  });
});

// ADR 0897 — the host now ends every stream after a few minutes (and keeps the
// viewer present through a grace). A clean end of a HEALTHY stream is that
// bound, not a failure: reconnect without flashing "disconnected".
describe('ADR 0897 — bounded close', () => {
  it('a clean end of a healthy presence stream reconnects without a connected:false snapshot', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let call = 0;
    // The reconnect stays open, so only the first stream's end is under test.
    const held = (): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame(['user:alice']))); } });
    const fetchMock = fetchReturning(() => { call += 1; return new Response(call === 1 ? sseBody(frame(['user:alice'])) : held(), { status: 200 }); });
    vi.stubGlobal('fetch', fetchMock);
    const snaps: boolean[] = [];
    // The stream lives 11 s: the clock moves while its first frame is read.
    const unsub = subscribeChannelPresence('c1', (snap) => { snaps.push(snap.connected); if (call === 1) now += 11_000; });
    await vi.waitFor(() => expect(snaps).toEqual([true]));
    await drain();
    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await drain();
    unsub();
    expect(snaps).not.toContain(false);
  });

  it('a presence stream that ends at once still surfaces connected:false', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.stubGlobal('fetch', fetchReturning(() => new Response(sseBody(frame(['user:alice'])), { status: 200 })));
    const snaps: boolean[] = [];
    const unsub = subscribeChannelPresence('c1', (snap) => { snaps.push(snap.connected); });
    await vi.waitFor(() => expect(snaps).toEqual([true, false]));
    unsub();
  });

  it('a REconnected message stream refreshes once (a message in the gap sent no frame); the first connect does not', async () => {
    // Exercise minimum jitter: two immediately closed streams could reconnect
    // twice within this test's 1 s advance. Keep the second stream alive so
    // the callback assertion measures exactly one reconnect (ADR 0897).
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let connections = 0;
    const fetchMock = fetchReturning(() => new Response(
      ++connections === 1 ? sseBody('') : new ReadableStream<Uint8Array>(),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const onMessage = vi.fn();
    const unsub = subscribeChannelMessages('c1', onMessage);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await drain();
    expect(onMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await drain();
    unsub();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith();
  });
});
