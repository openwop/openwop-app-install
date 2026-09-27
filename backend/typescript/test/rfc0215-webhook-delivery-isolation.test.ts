/**
 * RFC 0215 (ADR 0752) — webhook delivery isolation + unregister-stops-delivery.
 *
 * §A.1  the START of an attempt to one subscription MUST NOT wait for an attempt
 *       to a DIFFERENT subscription to finish;
 * §A.2  ... sustained while at least 8 subscriptions have unanswered attempts;
 * §B    after `deleteWebhook` returns, NO further attempt starts for that
 *       subscription, scheduled retries included (one in flight MAY complete).
 *
 * THE TEST MUST CREATE THE INTERFERENCE IT MEASURES (the WHD-1 lesson). Every §A
 * case here holds 8 receivers OPEN — they accept the request and never answer —
 * and asserts the healthy attempt ARRIVES WHILE ALL 8 ARE STILL OPEN. That is
 * the conformance scenario's pass condition, and it is an ordering fact, not a
 * timing bound: no clock threshold for a loaded CI box to trip.
 *
 * Before ADR 0752 the worker awaited each claimed batch (3 wide at the
 * production pool of 4) and the tick awaited the batch, so the healthy row
 * waited out the held attempts' 10 s timeouts: every §A case below fails there.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { WebhookDeliveryRecord } from '../src/types.js';
import {
  createWebhookDispatcher,
  processDueWebhookDeliveries,
  startWebhookDeliveryWorker,
  webhookMaxInFlight,
  webhookMaxInFlightPerTenant,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MIN_IN_FLIGHT,
  type WebhookDeliveryWorker,
} from '../src/host/webhookDeliveryWorker.js';

const HELD = 8; // the §A.2 floor

let server: http.Server;
let port = 0;
let storage: Storage;
/** Receivers holding a request open. Released in `afterEach`. */
const held: ServerResponse[] = [];
/** Held requests whose connection closed before we answered — i.e. the HOST
 *  abandoned the attempt (its timeout fired). The scenario's pass condition is
 *  "no held attempt abandoned", so "still open" must mean BOTH ends. Counting
 *  only `writableEnded` would miss a host that gave up and moved on — a
 *  sabotage that restored the batch barrier passed that weaker witness. */
const abandoned = new WeakSet<ServerResponse>();
const hits: Array<{ path: string; at: number; openHeld: number }> = [];
let failWith500 = false;
/** Every dispatcher a test starts; stopped + settled in `afterEach` so a test's
 *  leftover backlog cannot re-pump into the next test's receiver log. */
const dispatchers: Array<ReturnType<typeof createWebhookDispatcher>> = [];
const dispatcher = (...args: Parameters<typeof createWebhookDispatcher>) => {
  const d = createWebhookDispatcher(...args);
  dispatchers.push(d);
  return d;
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '';
    // Drain the body so the socket is healthy, then decide.
    req.resume();
    req.on('end', () => {
      hits.push({ path, at: Date.now(), openHeld: openHeld() });
      if (path.startsWith('/held')) {
        held.push(res); // accept, never answer
        res.on('close', () => {
          if (!res.writableEnded) abandoned.add(res);
        });
        return;
      }
      res.writeHead(failWith500 ? 500 : 200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // loopback receiver
  process.env.OPENWOP_PG_POOL_MAX = '4'; // the production shape (DB gate = 3)
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.OPENWOP_PG_POOL_MAX;
});

beforeEach(async () => {
  storage = await openStorage('memory://');
  hits.length = 0;
  failWith500 = false;
});

afterEach(async () => {
  for (const d of dispatchers) d.stop();
  for (const res of held.splice(0)) {
    if (!res.writableEnded) {
      res.writeHead(200);
      res.end('{}');
    }
  }
  await Promise.all(dispatchers.splice(0).map((d) => d.settled()));
});

function delivery(path: string, deliveryId: string, subscriptionId: string, at = Date.now()): WebhookDeliveryRecord {
  return {
    deliveryId,
    subscriptionId,
    url: `http://127.0.0.1:${port}${path}`,
    secret: 'shh',
    eventType: 'run.completed',
    payload: JSON.stringify({ type: 'run.completed', runId: 'r1' }),
    status: 'pending',
    attempts: 0,
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    nextAttemptAt: at,
    claimedBy: null,
    claimExpiresAt: null,
    lastError: null,
    createdAt: at,
    updatedAt: at,
  };
}

// ADR 0747 — the worker signs with the SUBSCRIPTION's secret at send time, so a
// queued row needs the subscription it belongs to; a row without one is
// dead-lettered, never sent (production has none: RFC 0215 §B's conditional
// enqueue and WHD-16's cascade keep them together).
async function enqueueSubscribed(rec: WebhookDeliveryRecord): Promise<void> {
  if ((await storage.getWebhook(rec.subscriptionId)) === null) {
    await storage.insertWebhook({ subscriptionId: rec.subscriptionId, tenantId: 'default', url: rec.url, events: ['*'], secret: 'shh', createdAt: new Date().toISOString() });
  }
  await storage.enqueueWebhookDelivery(rec);
}

async function until(cond: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function openHeld(): number {
  return held.filter((r) => !r.writableEnded && !abandoned.has(r)).length;
}

describe('RFC 0215 §A — an unanswered attempt never delays another subscription', () => {
  it('capacity is floored at 9 (8 held + 1), whatever is configured', () => {
    expect(WEBHOOK_MIN_IN_FLIGHT).toBe(HELD + 1);
    expect(webhookMaxInFlight('1')).toBe(HELD + 1);
    expect(webhookMaxInFlight('not-a-number')).toBeGreaterThanOrEqual(HELD + 1);
    expect(webhookMaxInFlight('64')).toBe(64);
  });

  it('§A.2 — 8 held subscriptions, then a healthy one: it arrives while all 8 are still open (dispatcher at the floor)', async () => {
    const d = dispatcher(storage, 'w-a2', { maxInFlight: WEBHOOK_MIN_IN_FLIGHT });
    for (let i = 0; i < HELD; i += 1) await enqueueSubscribed(delivery(`/held/${i}`, `h-${i}`, `sub-held-${i}`));
    await d.pump();
    await until(() => openHeld() === HELD, '8 held attempts open');

    // The healthy row is enqueued only NOW, so it cannot share a claim with the
    // held rows: this is the "later work behind unanswered work" shape.
    await enqueueSubscribed(delivery('/healthy', 'ok-1', 'sub-healthy'));
    await d.pump();
    await until(() => hits.some((h) => h.path === '/healthy'), 'healthy attempt');

    const healthy = hits.find((h) => h.path === '/healthy')!;
    expect(healthy.openHeld, 'the healthy attempt arrived only after a held attempt was abandoned (§A.2)').toBe(HELD);
    expect(openHeld()).toBe(HELD);
  });

  it('§A.1 through the RUNNING worker: the poll tick does not wait on held attempts', async () => {
    let worker: WebhookDeliveryWorker | undefined;
    try {
      worker = startWebhookDeliveryWorker(storage, 'w-running');
      for (let i = 0; i < HELD; i += 1) await enqueueSubscribed(delivery(`/held/r${i}`, `hr-${i}`, `sub-hr-${i}`));
      await until(() => openHeld() === HELD, '8 held attempts open via the poll loop');
      await enqueueSubscribed(delivery('/healthy', 'ok-r', 'sub-healthy-r'));
      await until(() => hits.some((h) => h.path === '/healthy'), 'healthy attempt via the poll loop');
      expect(hits.find((h) => h.path === '/healthy')!.openHeld).toBe(HELD);
    } finally {
      worker?.stop();
    }
  });

  it('one subscription’s backlog occupies ONE lane, not the capacity', async () => {
    // Without per-subscription lanes, a claim of 9 takes 9 of the flooded
    // subscription's rows and the healthy one is not even claimed.
    const d = dispatcher(storage, 'w-lane', { maxInFlight: WEBHOOK_MIN_IN_FLIGHT });
    const t = Date.now() - 1_000; // older than the healthy row: first in line
    for (let i = 0; i < 20; i += 1) await enqueueSubscribed(delivery('/held/flood', `f-${i}`, 'sub-flood', t + i));
    await enqueueSubscribed(delivery('/healthy', 'ok-f', 'sub-healthy-f'));
    await d.pump();
    await until(() => hits.some((h) => h.path === '/healthy'), 'healthy attempt behind a flooded subscription');
    expect(hits.filter((h) => h.path === '/held/flood'), 'the flooded subscription has ONE attempt in flight').toHaveLength(1);
    expect(d.inFlight()).toBe(1);
  });
});

describe('RFC 0215 §B — unregister stops delivery', () => {
  const sub = (id: string) => ({
    subscriptionId: id,
    tenantId: 'default',
    url: `http://127.0.0.1:${port}/x`,
    events: ['*'],
    secret: 'shh',
    createdAt: new Date().toISOString(),
  });

  it('a retry scheduled BEFORE the delete never fires', async () => {
    await storage.insertWebhook(sub('sub-b1'));
    const t0 = Date.now();
    expect(await storage.enqueueWebhookDelivery(delivery('/fail', 'b1', 'sub-b1', t0), { requireSubscription: true })).toBe(true);
    failWith500 = true;
    expect(await processDueWebhookDeliveries(storage, 'w-b', t0)).toBe(1); // attempt 1 → 500 → retry scheduled
    expect(hits).toHaveLength(1);

    await storage.deleteWebhook('sub-b1');

    // Far past every backoff step: nothing is due, nothing is attempted.
    expect(await processDueWebhookDeliveries(storage, 'w-b', t0 + 24 * 3_600_000)).toBe(0);
    expect(hits).toHaveLength(1);
  });

  it('an attempt IN FLIGHT at the delete may complete, and starts no retry', async () => {
    await storage.insertWebhook(sub('sub-b2'));
    await storage.enqueueWebhookDelivery(delivery('/held/b2', 'b2', 'sub-b2'), { requireSubscription: true });
    const d = dispatcher(storage, 'w-b2');
    await d.pump();
    await until(() => openHeld() === 1, 'attempt in flight');

    await storage.deleteWebhook('sub-b2');
    const res = held.pop()!;
    res.writeHead(500);
    res.end('{}'); // it completes, failed — the retry path is what §B governs
    await d.settled();

    const later = await storage.claimDueWebhookDeliveries('w-b2', Date.now() + 24 * 3_600_000, 60_000, 50);
    expect(later.filter((r) => r.subscriptionId === 'sub-b2'), 'no retry row survived the unregister').toEqual([]);
    expect(hits.filter((h) => h.path === '/held/b2')).toHaveLength(1);
  });

  it('an enqueue racing the unregister inserts nothing once the delete has landed', async () => {
    // The fan-out reads `listWebhooks`, then enqueues. If the 204 lands between
    // the two, the enqueue must re-check, not trust that earlier read.
    await storage.insertWebhook(sub('sub-b3'));
    await storage.deleteWebhook('sub-b3');
    expect(await storage.enqueueWebhookDelivery(delivery('/x', 'b3', 'sub-b3'), { requireSubscription: true })).toBe(false);
    expect(await storage.claimDueWebhookDeliveries('w-b3', Date.now() + 1_000, 60_000, 50)).toEqual([]);
  });
});

describe('RFC 0215 §A.3 — one tenant cannot take the capacity another needs (ADR 0752 P2)', () => {
  const forTenant = (path: string, id: string, sub: string, tenantId: string, at?: number): WebhookDeliveryRecord =>
    ({ ...delivery(path, id, sub, at), tenantId });

  it('the per-tenant cap defaults to half the capacity, and never drops below the §A.2 floor', () => {
    expect(webhookMaxInFlightPerTenant(32, undefined)).toBe(16);
    expect(webhookMaxInFlightPerTenant(32, '4'), 'a cap below 9 would break §A.2 inside ONE tenant').toBe(WEBHOOK_MIN_IN_FLIGHT);
    expect(webhookMaxInFlightPerTenant(9, undefined), 'at the capacity floor, one tenant may use all 9').toBe(9);
    expect(webhookMaxInFlightPerTenant(32, '64'), 'never above the capacity').toBe(32);
  });

  it('a tenant with 20 hung receivers holds at most its cap; another tenant still starts while all of them are open', async () => {
    const d = dispatcher(storage, 'w-a3', { maxInFlight: 32 }); // per-tenant cap 16
    const t = Date.now() - 1_000; // older than tenant B's row: first in line
    for (let i = 0; i < 20; i += 1) await enqueueSubscribed(forTenant(`/held/a${i}`, `ta-${i}`, `sub-a-${i}`, 'tenant-a', t + i));
    await d.pump();
    await until(() => openHeld() === 16, "tenant A's 16 held attempts open");
    // Give the dispatcher every chance to overshoot: re-pump repeatedly.
    for (let i = 0; i < 5; i += 1) await d.pump();
    expect(openHeld(), 'tenant A is capped at 16 in flight').toBe(16);

    await enqueueSubscribed(forTenant('/healthy', 'tb-1', 'sub-b-1', 'tenant-b'));
    await d.pump();
    await until(() => hits.some((h) => h.path === '/healthy'), "tenant B's attempt");
    expect(hits.find((h) => h.path === '/healthy')!.openHeld, 'B started while all 16 of A were still open').toBe(16);
    expect(hits.filter((h) => h.path.startsWith('/held/a')), 'A never exceeded its cap').toHaveLength(16);
  });

  it('§A.2 still holds INSIDE one tenant at the capacity floor: 8 held + 1 healthy, same tenant', async () => {
    const d = dispatcher(storage, 'w-a3-one', { maxInFlight: WEBHOOK_MIN_IN_FLIGHT });
    for (let i = 0; i < HELD; i += 1) await enqueueSubscribed(forTenant(`/held/s${i}`, `ts-${i}`, `sub-s-${i}`, 'tenant-solo'));
    await d.pump();
    await until(() => openHeld() === HELD, '8 held attempts open');
    await enqueueSubscribed(forTenant('/healthy', 'ts-ok', 'sub-s-ok', 'tenant-solo'));
    await d.pump();
    await until(() => hits.some((h) => h.path === '/healthy'), 'the same tenant’s healthy attempt');
    expect(hits.find((h) => h.path === '/healthy')!.openHeld).toBe(HELD);
  });

  it('a row enqueued before the column existed (no tenant) is never excluded', async () => {
    const d = dispatcher(storage, 'w-a3-null', { maxInFlight: WEBHOOK_MIN_IN_FLIGHT });
    for (let i = 0; i < 9; i += 1) await enqueueSubscribed(forTenant(`/held/n${i}`, `tn-${i}`, `sub-n-${i}`, 'tenant-n'));
    await d.pump();
    await until(() => openHeld() === 9, 'tenant n at the floor cap');
    const claimed = await storage.claimDueWebhookDeliveries('w-probe', Date.now() + 1, 60_000, 5, { excludeTenantIds: ['tenant-n'] });
    expect(claimed).toEqual([]);
    await storage.enqueueWebhookDelivery(delivery('/x', 'legacy-1', 'sub-legacy')); // tenantId absent
    const legacy = await storage.claimDueWebhookDeliveries('w-probe', Date.now() + 1, 60_000, 5, { excludeTenantIds: ['tenant-n'] });
    expect(legacy.map((r) => r.deliveryId)).toEqual(['legacy-1']);
    expect(legacy[0]!.tenantId ?? null).toBeNull();
  });
});
