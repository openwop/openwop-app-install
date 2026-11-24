/**
 * The cross-instance pub/sub LISTEN connection (#6133).
 *
 * One physical channel multiplexes every logical channel: a NOTIFY payload is
 * `{ c: logicalChannel, p: payload }`, and one dedicated connection, held out of
 * the pool, LISTENs and fans each notification to its channel's handlers.
 *
 * Why this is its own module. The listener used to re-establish itself only on an
 * `'error'`, and a connection that goes silently half-open (the network drops it
 * with no FIN and no RST) emits nothing at all. The old code kept that dead client
 * as "listening" forever. Every NOTIFY was then lost while the SSE heartbeats, which
 * are local timers, kept flowing. Measured on openwop-dev 2026-11-19: a certify cut
 * ~3 h into a revision's life got 0 frames on /host/events, and every host-event
 * row failed (#6133). A killed backend and a clean FIN both reach node-pg as an
 * `'error'`, so the old code survived those; only the half-open case reproduces
 * the bug (`issue6133-pubsub-listener-postgres-live.test.ts`). In production a
 * `ping-timeout` recycle fired 26 min after boot and delivery resumed within 1 s.
 *
 * The guards:
 *   - A self-ping, the one that fixes #6133. Every `pingIntervalMs`, a NOTIFY on
 *     the reserved logical channel goes out through the POOL. The listener must
 *     see it within `pingTimeoutMs`, or the connection is recycled even though it
 *     reported nothing.
 *   - `'end'` is treated exactly like `'error'`: drop the client and re-listen.
 *     Defensive; no observed failure needed it.
 *   - Every recycle is logged with a running counter, so a deploy can see how
 *     often it happens.
 *
 * Re-listening retries with a capped backoff (`retryMs` doubling to `maxRetryMs`)
 * for as long as anyone is subscribed. The old single retry left every open stream
 * deaf for good if that one attempt failed, for example during a database
 * failover. A connection whose LISTEN fails is released, not leaked out of the pool.
 *
 * NOTIFY is not durable. An event published while the listener is down is lost on
 * the live lane, and the durable answer is the RFC 0250 replay path
 * (`?replay=required`).
 */
import { randomUUID } from 'node:crypto';
import type { LogReasonCode } from '../../observability/logReasonCodes.js';

/** The parts of a `pg` client the listener uses. */
export interface ListenClient {
  query(sql: string): Promise<unknown>;
  on(event: 'notification', fn: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error' | 'end', fn: (err?: unknown) => void): unknown;
  release(destroy?: boolean | Error): void;
}

export interface ListenerLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface PubSubListenerOptions {
  /** A fresh connection held out of the pool. */
  connect(): Promise<ListenClient>;
  /** Send a NOTIFY through the pool (NOT the listen connection). */
  notify(physicalChannel: string, payload: string): Promise<void>;
  physicalChannel: string;
  log: ListenerLog;
  /** Default 60 s: well inside a typical proxy/LB idle cut. */
  pingIntervalMs?: number;
  /** Default 10 s. */
  pingTimeoutMs?: number;
  /** First delay before re-listening after a drop. Default 1 s. */
  retryMs?: number;
  /** Backoff cap. Default 30 s. */
  maxRetryMs?: number;
}

/** Reserved logical channel for the liveness ping; never handed to subscribers. */
export const LISTENER_PING_CHANNEL = '__openwop_listener_ping__';

export function createPubSubListener(opts: PubSubListenerOptions) {
  const { physicalChannel, log } = opts;
  const pingIntervalMs = opts.pingIntervalMs ?? 60_000;
  const pingTimeoutMs = opts.pingTimeoutMs ?? 10_000;
  const retryMs = opts.retryMs ?? 1_000;
  const maxRetryMs = opts.maxRetryMs ?? 30_000;
  let nextRetryMs = retryMs;
  let retryTimer: NodeJS.Timeout | null = null;
  const handlers = new Map<string, Set<(payload: string) => void>>();
  let client: ListenClient | null = null;
  let starting: Promise<void> | null = null;
  let closing = false;
  let recoveries = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  let pending: { nonce: string; timer: NodeJS.Timeout } | null = null;

  /** Re-listen after a capped, doubling delay; keeps trying while anyone is subscribed. */
  function scheduleRetry(): void {
    if (closing || handlers.size === 0 || retryTimer) return;
    const delay = nextRetryMs;
    nextRetryMs = Math.min(nextRetryMs * 2, maxRetryMs);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      ensure().catch((err) => {
        log.warn('pubsub_listener_restart_failed', { error: err instanceof Error ? err.message : String(err), nextRetryMs });
        scheduleRetry();
      });
    }, delay);
    retryTimer.unref?.();
  }

  /**
   * Drop `c` (if it is still the live client) and re-listen. `reason` may carry a
   * driver error message, so the log mask hashes it; `reasonCode` is the fixed
   * literal a probe can count (ADR 0900 D2).
   */
  function recycle(c: ListenClient, reason: string, reasonCode: LogReasonCode): void {
    if (client !== c) return;
    client = null;
    recoveries += 1;
    log.warn('pubsub_listener_recycled', { reason, reasonCode, recoveries });
    if (pending) { clearTimeout(pending.timer); pending = null; }
    try { c.release(true); } catch { /* already gone */ }
    scheduleRetry();
  }

  async function start(): Promise<void> {
    const c = await opts.connect();
    c.on('notification', (msg) => {
      if (msg.channel !== physicalChannel || !msg.payload) return;
      let parsed: { c: string; p: string };
      try { parsed = JSON.parse(msg.payload) as { c: string; p: string }; } catch { return; }
      if (parsed.c === LISTENER_PING_CHANNEL) {
        if (pending && parsed.p === pending.nonce) { clearTimeout(pending.timer); pending = null; }
        return;
      }
      const set = handlers.get(parsed.c);
      if (set) for (const h of set) {
        try { h(parsed.p); } catch { /* a handler must not break delivery */ }
      }
    });
    c.on('error', (err) => recycle(c, `error: ${err instanceof Error ? err.message : String(err)}`, 'pubsub_listener_error'));
    c.on('end', () => recycle(c, 'end', 'pubsub_listener_end'));
    try {
      await c.query(`LISTEN ${physicalChannel}`);
    } catch (err) {
      // Never leak a pool slot on a failed LISTEN (a slot is a Cloud SQL connection).
      try { c.release(err instanceof Error ? err : true); } catch { /* already gone */ }
      throw err;
    }
    client = c;
    nextRetryMs = retryMs;
    log.info('pubsub_listener_started', { channel: physicalChannel, recoveries });
    startPinging();
  }

  async function ensure(): Promise<void> {
    if (client || closing) return;
    if (!starting) starting = start().finally(() => { starting = null; });
    await starting;
  }

  /** One liveness check. The ping goes out on the pool and must come back on the listen connection. */
  async function ping(): Promise<void> {
    const c = client;
    if (!c || closing || pending) return;
    const nonce = randomUUID();
    pending = { nonce, timer: setTimeout(() => { pending = null; recycle(c, 'ping-timeout', 'pubsub_listener_ping_timeout'); }, pingTimeoutMs) };
    pending.timer.unref?.();
    try {
      await opts.notify(physicalChannel, JSON.stringify({ c: LISTENER_PING_CHANNEL, p: nonce }));
    } catch (err) {
      // The pool could not send it: that is not evidence against the listener.
      if (pending?.nonce === nonce) { clearTimeout(pending.timer); pending = null; }
      log.warn('pubsub_listener_ping_send_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  function startPinging(): void {
    if (pingTimer) return;
    pingTimer = setInterval(() => { void ping(); }, pingIntervalMs);
    pingTimer.unref?.();
  }

  return {
    async subscribe(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>> {
      let set = handlers.get(channel);
      if (!set) { set = new Set(); handlers.set(channel, set); }
      set.add(handler);
      try {
        await ensure();
      } catch (err) {
        // The handler stays registered and the backoff keeps trying, so a stream that
        // subscribed during an outage starts hearing events once the database is back.
        scheduleRetry();
        throw err;
      }
      return async () => {
        const s = handlers.get(channel);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) handlers.delete(channel);
      };
    },
    close(): void {
      closing = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (pending) { clearTimeout(pending.timer); pending = null; }
      const c = client;
      client = null;
      if (c) { try { c.release(); } catch { /* already gone */ } }
    },
    /** For tests and diagnostics. */
    state(): { listening: boolean; recoveries: number } {
      return { listening: client !== null, recoveries };
    },
    /** Test seam: run one liveness check now. */
    pingNow: ping,
  };
}
