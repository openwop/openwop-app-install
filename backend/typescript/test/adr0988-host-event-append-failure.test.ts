/**
 * ADR 0988 D2 — a failed replay-log append no longer makes an oversized event
 * reach one instance only.
 *
 * Before D2, `fanOutHostEvent` tried the append once and, on failure, published
 * with no log sequence. An event over NOTIFY's 7,900-byte limit then fell back to
 * LOCAL delivery: on a multi-instance host, subscribers on every other instance
 * never saw it and it could not be replayed. Now the append is retried (bounded,
 * ~1 s); if it still fails, an event that fits NOTIFY is published with its body
 * (every instance gets it), and one that does not is kept as a dead-letter row
 * instead. `openwop.host_event.log.append_failed` counts each case by outcome.
 *
 * Single process on `memory://`, so it runs in the gate. The cross-process half is
 * in `adr0988-host-event-two-process-postgres-live.test.ts`.
 * `OPENWOP_INSTANCE_TOPOLOGY` is read per call, so one app runs both topologies.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostEventEnvelope } from '../src/host/hostEventTypes.js';
import { fanOutHostEvent } from '../src/routes/webhooks.js';
import { attachHostEventSubscriber } from '../src/host/hostEventStream.js';
import {
  _failHostEventAppendsForTesting,
  hostEventDeadLetterSummary,
  resolveHostEventCursor,
} from '../src/host/hostEventLog.js';
import { _resetMetricsForTest, emissionsOf } from '../src/observability/metrics.js';
import { getSetCookies } from './headerCookies.js';

let app: Express;
let server: http.Server;
let BASE = '';
let storage: Storage;
let n = 0;

beforeAll(async () => {
  vi.stubEnv('OPENWOP_HOST_EVENTS_V2', 'true');
  vi.stubEnv('OPENWOP_STORAGE_DSN', 'memory://');
  vi.stubEnv('OPENWOP_SESSION_SECRET', 'test-session-secret-at-least-32-characters-long');
  vi.stubEnv('OPENWOP_TEST_AUTH_ENABLED', 'true');
  vi.stubEnv('OPENWOP_AUTH_DISABLE_COOKIES', '');
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => { server.closeAllConnections?.(); server.close(() => res()); });
  vi.unstubAllEnvs();
});
beforeEach(() => {
  _resetMetricsForTest();
});
afterEach(() => {
  _failHostEventAppendsForTesting(0);
  vi.stubEnv('OPENWOP_INSTANCE_TOPOLOGY', '');
});

const id = (k: string): string => `hev-00000000-0000-4000-8000-${k.padStart(12, '0')}`;
function ev(eventId: string, opts: { delivery?: 'durable' | 'ephemeral'; bytes?: number } = {}): HostEventEnvelope {
  const delivery = opts.delivery ?? 'durable';
  return {
    eventId,
    type: delivery === 'durable' ? 'example.thing-happened' : 'example.thing-noticed',
    timestamp: new Date().toISOString(),
    delivery,
    payload: opts.bytes ? { blob: 'x'.repeat(opts.bytes) } : {},
  };
}
/** Frames this process's subscribers receive for `tenantId`. */
function subscribe(tenantId: string): { ids: () => string[]; detach: () => void } {
  const frames: string[] = [];
  const detach = attachHostEventSubscriber(tenantId, (f) => frames.push(f), null);
  return { ids: () => frames.map((f) => /^id: (.+)$/m.exec(f)?.[1] ?? '').filter(Boolean), detach };
}
async function settle(ms = 300): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }
const outcomes = (): string[] => emissionsOf('openwop.host_event.log.append_failed').map((e) => String(e.attributes['outcome']));

describe('ADR 0988 D2 — append failure', () => {
  it('a transient failure is absorbed by the bounded retry: logged, delivered, not counted', async () => {
    const T = `org:d2-retry-${n++}`;
    const sub = subscribe(T);
    _failHostEventAppendsForTesting(2); // the first try and the first retry fail
    await fanOutHostEvent(storage, T, ev(id('a1')));
    await settle();
    sub.detach();
    expect(await resolveHostEventCursor(T, id('a1'))).not.toBeNull();
    expect(sub.ids()).toEqual([id('a1')]);
    expect(outcomes()).toEqual([]);
  });

  it('a persistent failure on an event that fits NOTIFY publishes it with its body (published_full)', async () => {
    vi.stubEnv('OPENWOP_INSTANCE_TOPOLOGY', 'multi');
    const T = `org:d2-small-${n++}`;
    const sub = subscribe(T);
    _failHostEventAppendsForTesting(4); // all 1 + 3 attempts
    await fanOutHostEvent(storage, T, ev(id('b1')));
    await settle();
    sub.detach();
    expect(await resolveHostEventCursor(T, id('b1'))).toBeNull();
    expect(sub.ids()).toEqual([id('b1')]);
    expect(outcomes()).toEqual(['published_full']);
  });

  it('on a multi-instance host, an oversized event that cannot be logged is dead-lettered, never delivered on one instance only', async () => {
    vi.stubEnv('OPENWOP_INSTANCE_TOPOLOGY', 'multi');
    const T = `org:d2-big-${n++}`;
    const sub = subscribe(T);
    const before = (await hostEventDeadLetterSummary()).total;
    _failHostEventAppendsForTesting(4);
    await fanOutHostEvent(storage, T, ev(id('c1'), { bytes: 9000 }));
    await settle();
    sub.detach();
    expect(sub.ids()).toEqual([]); // no local-only delivery
    expect(outcomes()).toEqual(['dead_lettered']);
    const after = await hostEventDeadLetterSummary();
    expect(after.total).toBe(before + 1);
    expect(after.byType.find((t) => t.type === 'example.thing-happened')?.count).toBeGreaterThanOrEqual(1);
    expect(await resolveHostEventCursor(T, id('c1'))).toBeNull(); // a dead letter is not a cursor
  });

  it('on a single-instance host the same event is still delivered: local delivery reaches every subscriber there', async () => {
    vi.stubEnv('OPENWOP_INSTANCE_TOPOLOGY', 'single');
    const T = `org:d2-single-${n++}`;
    const sub = subscribe(T);
    _failHostEventAppendsForTesting(4);
    await fanOutHostEvent(storage, T, ev(id('d1'), { bytes: 9000 }));
    await settle();
    sub.detach();
    expect(sub.ids()).toEqual([id('d1')]);
    expect(outcomes()).toEqual(['published_full']);
  });

  it('an ephemeral event is never appended, retried or counted', async () => {
    const T = `org:d2-eph-${n++}`;
    _failHostEventAppendsForTesting(4);
    const started = Date.now();
    await fanOutHostEvent(storage, T, ev(id('e1'), { delivery: 'ephemeral' }));
    expect(Date.now() - started).toBeLessThan(100); // no retry backoff
    expect(outcomes()).toEqual([]);
  });

  it('the dead-letter summary is superadmin-only', async () => {
    const r = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `d2-${Date.now()}-${n++}@acme.test` }),
    });
    const cookie = (getSetCookies(r.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
    const res = await fetch(`${BASE}/host/openwop-app/operations/host-events/dead-letters`, { headers: { cookie } });
    expect(res.status).toBe(403);
  });
});
