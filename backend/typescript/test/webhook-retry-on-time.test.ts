/**
 * Webhook retries arrive on their backoff schedule, not on the next poll tick
 * after it (RFC 0173 §Durability, the exponential-backoff leg).
 *
 * Measured on openwop-dev (the 2.49.7 certify cut, 2026-11-19): against the
 * 2 s / 4 s schedule the receiver saw gaps of 4054 / 5016 ms. The worker's tick
 * returned early while its sweeps were still running, before it pumped, so a due
 * retry waited whole poll intervals. The second gap was then less than 1.25x
 * the first, and the suite's "an exponential backoff widens" check failed on a
 * correct schedule. The dispatcher now wakes itself when a rescheduled retry
 * falls due.
 *
 * This drives the dispatcher ALONE (no poll loop) and pumps it once. Every
 * later attempt can only come from that wake, so before the fix there was no
 * second attempt at all.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { WebhookDeliveryRecord } from '../src/types.js';
import { createWebhookDispatcher, webhookBackoffMs, WEBHOOK_MAX_ATTEMPTS } from '../src/host/webhookDeliveryWorker.js';

let server: http.Server;
let port = 0;
const hits: number[] = [];
/** Paths answered 200 (the overlap case); everything else 500s. */
const okHits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url?.startsWith('/ok/')) {
        okHits.push(req.url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      hits.push(Date.now());
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
});

async function until(cond: () => boolean, what: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('webhook retries on their backoff schedule', () => {
  it('a failing delivery is retried at 2 s then 4 s with no poll tick, and the gaps widen as RFC 0173 requires', async () => {
    const storage: Storage = await openStorage('memory://');
    const now = Date.now();
    await storage.insertWebhook({ subscriptionId: 'sub-1', tenantId: 'default', url: `http://127.0.0.1:${port}/r`, events: ['*'], secret: 'shh', createdAt: new Date().toISOString() });
    const rec: WebhookDeliveryRecord = {
      deliveryId: 'd-1', subscriptionId: 'sub-1', url: `http://127.0.0.1:${port}/r`, secret: 'shh',
      eventType: 'run.completed', payload: JSON.stringify({ type: 'run.completed', runId: 'r1' }),
      status: 'pending', attempts: 0, maxAttempts: WEBHOOK_MAX_ATTEMPTS, nextAttemptAt: now,
      claimedBy: null, claimExpiresAt: null, lastError: null, createdAt: now, updatedAt: now,
    };
    await storage.enqueueWebhookDelivery(rec);
    const d = createWebhookDispatcher(storage, 'w-on-time');
    try {
      await d.pump(); // the only explicit pump
      await until(() => hits.length >= 3, 'three attempts from a single pump', 12_000);
      const gap1 = hits[1]! - hits[0]!;
      const gap2 = hits[2]! - hits[1]!;
      // Each gap is the backoff plus one local round trip and a DB write.
      expect(gap1).toBeGreaterThanOrEqual(webhookBackoffMs(1));
      expect(gap1).toBeLessThan(webhookBackoffMs(1) + 700);
      expect(gap2).toBeGreaterThanOrEqual(webhookBackoffMs(2));
      expect(gap2).toBeLessThan(webhookBackoffMs(2) + 700);
      // The conformance leg: the second gap is wider than the first by at least a quarter of it.
      expect(gap2 - gap1).toBeGreaterThanOrEqual(gap1 / 4);
    } finally {
      d.stop();
      await d.settled();
      await storage.close();
    }
  }, 20_000);

  it('overlapping pumps (a tick, a wake, a completion, all at once) send each delivery exactly once', async () => {
    // The tick used to be non-re-entrant only because `if (running) return` came
    // before the pump. The pump is serialized by its own `claiming` guard, and a
    // claim leases each row and skips subscriptions with an attempt in flight.
    // Fire 50 pumps without awaiting any, and every row must be sent exactly once.
    const storage: Storage = await openStorage('memory://');
    // Every row is already due: with no poll loop here, a row due a few ms in the
    // future would only be picked up by a tick this test does not run.
    const now = Date.now();
    const N = 20;
    for (let i = 0; i < N; i += 1) {
      const sub = `sub-ok-${i % 5}`;
      const url = `http://127.0.0.1:${port}/ok/${i}`;
      if ((await storage.getWebhook(sub)) === null) {
        await storage.insertWebhook({ subscriptionId: sub, tenantId: 'default', url, events: ['*'], secret: 'shh', createdAt: new Date().toISOString() });
      }
      await storage.enqueueWebhookDelivery({
        deliveryId: `ok-${i}`, subscriptionId: sub, url, secret: 'shh',
        eventType: 'run.completed', payload: JSON.stringify({ type: 'run.completed', runId: `r${i}` }),
        status: 'pending', attempts: 0, maxAttempts: WEBHOOK_MAX_ATTEMPTS, nextAttemptAt: now - N + i,
        claimedBy: null, claimExpiresAt: null, lastError: null, createdAt: now - N + i, updatedAt: now - N + i,
      });
    }
    const d = createWebhookDispatcher(storage, 'w-overlap');
    try {
      await Promise.all(Array.from({ length: 50 }, () => d.pump()));
      await until(() => okHits.length >= N, `all ${N} deliveries sent`, 10_000);
      await new Promise((r) => setTimeout(r, 500)); // room for a duplicate to show up
      await d.settled();
      const counts = new Map<string, number>();
      for (const h of okHits) counts.set(h, (counts.get(h) ?? 0) + 1);
      expect(counts.size).toBe(N);
      expect([...counts.values()].every((n) => n === 1), `a delivery was sent twice: ${JSON.stringify([...counts].filter(([, n]) => n > 1))}`).toBe(true);
    } finally {
      d.stop();
      await d.settled();
      await storage.close();
    }
  }, 20_000);
});
