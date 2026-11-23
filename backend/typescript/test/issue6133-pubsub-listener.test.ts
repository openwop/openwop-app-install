/**
 * #6133 — the Postgres pub/sub LISTEN connection recovers from every way it dies.
 *
 * openwop-dev 2026-11-19: a certify cut ~3 h into a revision's life got 0 frames
 * on /host/events (heartbeats only). The listener re-established itself only on
 * 'error', so a connection that went silently half-open stayed "listening" while
 * every NOTIFY was lost. These cases drive `createPubSubListener` with a fake pg
 * client and pin each recovery path. The one that matches production is the
 * silent connection whose self-ping never comes back; the live-Postgres test
 * shows a killed backend and a clean FIN both surface as 'error'.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPubSubListener, LISTENER_PING_CHANNEL, type ListenClient } from '../src/storage/postgres/pubsubListener.js';

const CH = 'openwop_host_ext';

class FakeClient extends EventEmitter implements ListenClient {
  released = false;
  constructor(private readonly failListen = false) { super(); }
  async query(sql: string): Promise<unknown> {
    if (this.failListen) throw new Error('connection refused');
    if (sql !== `LISTEN ${CH}`) throw new Error(`unexpected ${sql}`);
    return {};
  }
  release(): void { this.released = true; }
  deliver(c: string, p: string): void { this.emit('notification', { channel: CH, payload: JSON.stringify({ c, p }) }); }
}

const silentLog = { info: () => undefined, warn: () => undefined };

/** A harness: every connect() hands out a new FakeClient; notify() echoes to the live one unless muted. */
function harness(opts: { failFirst?: number } = {}) {
  const clients: FakeClient[] = [];
  let failures = opts.failFirst ?? 0;
  let muted = false;
  const live = (): FakeClient | undefined => [...clients].reverse().find((c) => !c.released);
  const listener = createPubSubListener({
    connect: async () => { const c = new FakeClient(failures-- > 0); clients.push(c); return c; },
    notify: async (_ch, payload) => {
      if (muted) return;
      const { c, p } = JSON.parse(payload) as { c: string; p: string };
      live()?.deliver(c, p);
    },
    physicalChannel: CH,
    log: silentLog,
    pingIntervalMs: 60_000,
    pingTimeoutMs: 10_000,
    retryMs: 1_000,
    maxRetryMs: 8_000,
  });
  return { listener, clients, live, mute: (m: boolean) => { muted = m; } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('#6133 — pub/sub listener recovery', () => {
  it('fans a notification to its channel handlers', async () => {
    const h = harness();
    const got: string[] = [];
    await h.listener.subscribe('host-events', (p) => got.push(p));
    h.live()!.deliver('host-events', 'one');
    h.live()!.deliver('other', 'ignored');
    expect(got).toEqual(['one']);
  });

  it('a clean end (no error) re-listens, and the next publish reaches the handler', async () => {
    const h = harness();
    const got: string[] = [];
    await h.listener.subscribe('host-events', (p) => got.push(p));
    const first = h.live()!;
    first.emit('end');
    expect(h.listener.state()).toMatchObject({ listening: false, recoveries: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.listener.state().listening).toBe(true);
    expect(h.live()).not.toBe(first);
    h.live()!.deliver('host-events', 'after-recovery');
    expect(got).toEqual(['after-recovery']);
  });

  it('an error recovers the same way', async () => {
    const h = harness();
    await h.listener.subscribe('host-events', () => undefined);
    h.live()!.emit('error', new Error('Connection terminated unexpectedly'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.listener.state()).toEqual({ listening: true, recoveries: 1 });
  });

  it('a connection that goes silent is recycled when its self-ping does not come back', async () => {
    const h = harness();
    await h.listener.subscribe('host-events', () => undefined);
    const first = h.live()!;
    h.mute(true); // half-open: NOTIFYs are sent, the listener never hears them
    await vi.advanceTimersByTimeAsync(60_000); // ping goes out
    await vi.advanceTimersByTimeAsync(10_000); // and times out
    expect(first.released).toBe(true);
    h.mute(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.listener.state()).toEqual({ listening: true, recoveries: 1 });
  });

  it('a healthy connection answers its ping and is kept', async () => {
    const h = harness();
    await h.listener.subscribe('host-events', () => undefined);
    const first = h.live()!;
    await vi.advanceTimersByTimeAsync(60_000 * 3 + 10_000);
    expect(first.released).toBe(false);
    expect(h.listener.state()).toEqual({ listening: true, recoveries: 0 });
  });

  it('pings are never delivered to subscribers', async () => {
    const h = harness();
    const got: string[] = [];
    await h.listener.subscribe(LISTENER_PING_CHANNEL, (p) => got.push(p));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(got).toEqual([]);
  });

  it('a failed LISTEN releases its client and keeps retrying with backoff until it succeeds', async () => {
    const h = harness({ failFirst: 3 });
    const got: string[] = [];
    await expect(h.listener.subscribe('host-events', (p) => got.push(p))).rejects.toThrow('connection refused');
    expect(h.clients[0]!.released).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000); // retry 1: fails
    await vi.advanceTimersByTimeAsync(2_000); // retry 2: fails
    expect(h.listener.state().listening).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000); // retry 3: succeeds
    expect(h.clients.slice(0, 3).every((c) => c.released)).toBe(true);
    expect(h.listener.state().listening).toBe(true);
    h.live()!.deliver('host-events', 'after-outage');
    expect(got).toEqual(['after-outage']);
  });

  it('close stops every timer and releases the client', async () => {
    const h = harness();
    await h.listener.subscribe('host-events', () => undefined);
    const c = h.live()!;
    h.listener.close();
    expect(c.released).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.clients.length).toBe(1);
  });
});
