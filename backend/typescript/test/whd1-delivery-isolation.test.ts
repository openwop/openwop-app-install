/**
 * WHD-1 — a slow subscriber MUST NOT delay unrelated subscribers.
 *
 * `processDueWebhookDeliveries` used to `await sendDelivery(rec)` per row, so a
 * claimed batch cost up to `CLAIM_BATCH x DELIVERY_TIMEOUT_MS` and every row
 * waited behind the slowest one *before* it. The cost landed on whatever
 * unrelated subscriptions shared the batch, not on the slow one.
 *
 * MEASURED on deployed `3080f2f24a0f` before the fix: with a handful of dead
 * endpoints queued, a healthy subscriber's FIRST attempt arrived ~5.5 min after
 * its event, and successive attempts were 9.0 / 5.3 / 7.6 minutes apart against
 * a configured backoff of 2s / 4s / 8s. The row was due seconds later and
 * simply was not claimed.
 *
 * THE TEST MUST CREATE THE INTERFERENCE IT MEASURES. A test that enqueues one
 * healthy delivery and asserts it is prompt passes on the broken code too —
 * there is nothing for it to queue behind. So this enqueues slow rows
 * alongside the fast one and asserts on WALL-CLOCK SEPARATION:
 *
 *   sequential  >= SLOW_COUNT * SLOW_MS   (4 x 400ms = 1600ms)
 *   concurrent  ~=              SLOW_MS   (        ~400ms)
 *
 * The bound below sits between those, far enough from both that ordinary CI
 * jitter cannot reach it. It is deliberately NOT a tight timing assertion:
 * it fails only if the rows are serialised at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { WebhookDeliveryRecord } from '../src/types.js';
import { deliveryConcurrency, processDueWebhookDeliveries, WEBHOOK_MAX_ATTEMPTS } from '../src/host/webhookDeliveryWorker.js';

const T0 = 1_700_000_000_000;
const SLOW_MS = 400;
const SLOW_COUNT = 4;
/** Between concurrent (~400ms) and sequential (>=1600ms), clear of both. */
const SERIALISED_FLOOR_MS = 1_200;

let server: http.Server;
let port = 0;
let storage: Storage;
const fastHits: number[] = [];
const slowCompletions: number[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/fast') {
      fastHits.push(Date.now());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    // A slow-but-reachable subscriber: it occupies a worker slot for SLOW_MS.
    // Reachable matters — an unresolvable host would be refused before it could
    // occupy anything, so the interference would not exist to be measured.
    setTimeout(() => {
      slowCompletions.push(Date.now());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }, SLOW_MS);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // loopback receiver
  storage = await openStorage('memory://');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
});

// ADR 0747 — the worker signs with the SUBSCRIPTION's secret at send time, so
// every queued row needs the subscription it belongs to (production never has a
// pending row without one: WHD-16 deletes them together).
async function enqueue(path: string, deliveryId: string, subscriptionId: string): Promise<void> {
  await storage.insertWebhook({ subscriptionId, tenantId: 'default', url: `http://127.0.0.1:${port}${path}`, events: ['*'], secret: 'shh', createdAt: new Date(T0).toISOString() });
  await storage.enqueueWebhookDelivery(delivery(path, deliveryId, subscriptionId));
}

function delivery(path: string, deliveryId: string, subscriptionId: string): WebhookDeliveryRecord {
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
    nextAttemptAt: T0,
    claimedBy: null,
    claimExpiresAt: null,
    lastError: null,
    createdAt: T0,
    updatedAt: T0,
  };
}

describe('WHD-1 — per-subscription delivery independence', () => {
  it('a slow subscriber does not serialise the batch behind it', async () => {
    for (let i = 0; i < SLOW_COUNT; i += 1) {
      await enqueue('/slow', `d-slow-${i}`, `sub-slow-${i}`);
    }
    await enqueue('/fast', 'd-fast', 'sub-fast');

    const startedAt = Date.now();
    const processed = await processDueWebhookDeliveries(storage, 'whd1-worker', T0 + 1);
    const elapsed = Date.now() - startedAt;

    expect(processed, 'all five rows claimed in one batch (CLAIM_BATCH = 5)').toBe(SLOW_COUNT + 1);
    expect(fastHits.length, 'the healthy subscriber was delivered to').toBe(1);

    // PRIMARY assertion — ORDER, not wall-clock (WHD-34 review).
    //
    // The original form asserted `elapsed < 1200ms`. That is a real signal but a
    // clock-dependent one, and this repo's CI box has sat at load 130-190 for
    // hours at a time; event-loop starvation inflates even the concurrent case,
    // so the bound could redden on a correct host. Observation order tests the
    // SAME property — that the healthy row is not queued behind the slow ones —
    // without asking the machine to be quiet.
    const lastSlow = Math.max(...slowCompletions);
    expect(
      fastHits[0]!,
      `the healthy subscriber was answered at +${fastHits[0]! - startedAt}ms, after the last slow ` +
        `subscriber completed at +${lastSlow - startedAt}ms — it was queued BEHIND them, which is ` +
        'WHD-1 regressing (one slow subscriber delaying unrelated ones)',
    ).toBeLessThan(lastSlow);

    // SECONDARY, kept deliberately loose: a sanity bound that only trips on full
    // serialisation, well clear of the concurrent case on any machine.
    expect(
      elapsed,
      `batch took ${elapsed}ms; fully sequential delivery needs >= ${SLOW_COUNT * SLOW_MS}ms`,
    ).toBeLessThan(SERIALISED_FLOOR_MS);
  });

  it('never puts more rows in flight than the connection pool can serve (WHD-34)', () => {
    // sendDelivery is HTTP-only and each row's DB write lands AFTER it, so the
    // completions cluster: an unbounded Promise.all over the batch can demand
    // CLAIM_BATCH connections at once. Production runs OPENWOP_PG_POOL_MAX=4
    // against CLAIM_BATCH=5, on a pool SHARED with request handling — so the
    // worker could take every slot. The bound must leave at least one.
    expect(deliveryConcurrency('4', 5), 'prod shape: pool 4, batch 5').toBe(3);
    expect(deliveryConcurrency('1', 5), 'a 1-connection pool still makes progress').toBe(1);
    expect(deliveryConcurrency('10', 5), 'a roomy pool is bounded by the batch, not the pool').toBe(5);
    expect(deliveryConcurrency(undefined, 5), 'default pool (10) → batch-bound').toBe(5);
    expect(deliveryConcurrency('garbage', 5), 'unparseable → the pool default, not 0').toBe(5);
  });
});
