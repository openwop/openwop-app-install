/**
 * ADR 0126 Phase 4 — the FE presence consumer: parse channel.presence SSE frames + POST typing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { subscribeChannelPresence, setChannelTyping } from '../channelsClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

function sseBody(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });
}

describe('subscribeChannelPresence', () => {
  it('parses a channel.presence frame and calls back with the snapshot', async () => {
    const frame = `event: channel.presence\ndata: ${JSON.stringify({ conversationId: 'c1', present: ['user:alice'], typing: ['user:alice'] })}\n\n`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: sseBody(frame) } as unknown as Response)));
    let unsub = (): void => {};
    const snap = await new Promise<{ present: string[]; typing: string[] }>((resolve) => {
      unsub = subscribeChannelPresence('c1', (s) => resolve(s));
    });
    unsub(); // stop the reconnect loop so it doesn't leak into later tests
    expect(snap.present).toEqual(['user:alice']);
    expect(snap.typing).toEqual(['user:alice']);
  });

  it('is silent when presence is off (404 ⇒ no callback, no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, body: null } as unknown as Response)));
    const cb = vi.fn();
    const unsub = subscribeChannelPresence('c1', cb);
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
    unsub();
  });
});

describe('setChannelTyping', () => {
  it('POSTs the typing flag to the presence/typing endpoint', async () => {
    const m = vi.fn(async () => ({ ok: true } as unknown as Response));
    vi.stubGlobal('fetch', m);
    await setChannelTyping('c1', true);
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain('/channels/c1/presence/typing');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ typing: true });
  });
});


describe('subscribeChannelPresence reconnect (ADR 0126 hardening)', () => {
  it('reconnects after the stream ends (a transient drop does not kill presence)', async () => {
    const frame = (who: string): string => `event: channel.presence\ndata: ${JSON.stringify({ conversationId: 'c1', present: [who], typing: [] })}\n\n`;
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      // first connection yields alice then closes; second yields bob then closes
      return { ok: true, status: 200, body: sseBody(call === 1 ? frame('user:alice') : frame('user:bob')) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const unsub = subscribeChannelPresence('c1', (snap) => { seen.push(snap.present[0]!); });
    // wait long enough for the first stream + the backoff + the reconnect (backoff >= 500ms)
    await new Promise((r) => setTimeout(r, 1300));
    unsub();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); // reconnected
    expect(seen).toContain('user:alice');
    expect(seen).toContain('user:bob');
  });

  it('does NOT reconnect on 404 (presence disabled is terminal)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, body: null } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);
    const unsub = subscribeChannelPresence('c1', () => {});
    await new Promise((r) => setTimeout(r, 1300));
    unsub();
    expect(fetchMock.mock.calls.length).toBe(1); // 404 ⇒ no retry
  });
});
