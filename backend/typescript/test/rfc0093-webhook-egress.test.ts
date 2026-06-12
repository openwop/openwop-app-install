/**
 * RFC 0093 §A.1-A.2 — webhook delivery-time egress hardening.
 *
 * Real-network tests (no fetch mocking): a local HTTP receiver on
 * 127.0.0.1 plays the subscriber, and the worker delivers through the
 * actual undici egress-guard dispatcher.
 *
 *   - Redirect refusal (§A.2): a `302` from the receiver MUST be a delivery
 *     failure (not followed), retried per the existing backoff policy.
 *   - Denied-range re-validation (§A.1): with the private-egress override
 *     OFF, a hostname that resolves to loopback (`localhost`) MUST fail at
 *     connect time via the pinned-resolution lookup guard — even though the
 *     URL string itself contains no denied literal.
 *   - The OPENWOP_WEBHOOK_ALLOW_PRIVATE override restores local delivery
 *     (the same env contract as registration).
 *
 * Plus pure-predicate coverage of `isDeniedWebhookHost` (the single shared
 * denied-range predicate — registration + delivery use the same one).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { WebhookDeliveryRecord } from '../src/types.js';
import { processDueWebhookDeliveries, WEBHOOK_MAX_ATTEMPTS } from '../src/host/webhookDeliveryWorker.js';
import { isDeniedWebhookHost } from '../src/host/webhookEgressGuard.js';

const T0 = 1_700_000_000_000;

let server: http.Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${port}/ok` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  hits.length = 0;
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
});

function makeDelivery(url: string, deliveryId: string): WebhookDeliveryRecord {
  return {
    deliveryId,
    subscriptionId: 'sub-egress',
    url,
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

/** Read back the (single) queue row via an expired-lease re-claim so the
 *  test can assert `attempts` / `lastError` without a storage debug API. */
async function reclaimRow(storage: Storage): Promise<WebhookDeliveryRecord | undefined> {
  const rows = await storage.claimDueWebhookDeliveries('inspector', T0 + 86_400_000, 1, 10);
  return rows[0];
}

describe('rfc0093 webhook delivery-time egress hardening', () => {
  it('does NOT follow a 302 — the redirect is a delivery failure that retries', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // loopback receiver is the point here
    const storage = await openStorage('memory://');
    await storage.enqueueWebhookDelivery(makeDelivery(`http://localhost:${port}/redirect`, 'd-redirect'));

    expect(await processDueWebhookDeliveries(storage, 'worker-a', T0)).toBe(1);

    // The receiver saw exactly the redirecting request — never /ok.
    expect(hits).toEqual(['/redirect']);

    // The row failed (attempt 1 recorded) and is rescheduled, not delivered.
    const row = await reclaimRow(storage);
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toBeTruthy();
    await storage.close();
  });

  it('refuses delivery when the hostname resolves into a denied range (pinned-resolution guard)', async () => {
    // No OPENWOP_WEBHOOK_ALLOW_PRIVATE: `localhost` resolves to loopback,
    // which the connect-time lookup guard rejects before any bytes leave.
    const storage = await openStorage('memory://');
    await storage.enqueueWebhookDelivery(makeDelivery(`http://localhost:${port}/ok`, 'd-denied'));

    expect(await processDueWebhookDeliveries(storage, 'worker-a', T0)).toBe(1);

    // Nothing reached the receiver.
    expect(hits).toEqual([]);
    const row = await reclaimRow(storage);
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending'); // failure → retry policy, not delivered
    expect(row!.attempts).toBe(1);
    expect(row!.lastError ?? '').toContain('webhook egress denied');
    await storage.close();
  });

  it('delivers to a loopback receiver when OPENWOP_WEBHOOK_ALLOW_PRIVATE=true (dev override)', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const storage = await openStorage('memory://');
    await storage.enqueueWebhookDelivery(makeDelivery(`http://localhost:${port}/ok`, 'd-ok'));

    expect(await processDueWebhookDeliveries(storage, 'worker-a', T0)).toBe(1);
    expect(hits).toEqual(['/ok']);
    // Delivered (terminal) — nothing left to claim.
    expect(await reclaimRow(storage)).toBeUndefined();
    await storage.close();
  });
});

describe('rfc0093 shared denied-range predicate', () => {
  it.each([
    ['localhost', true],
    ['sub.localhost', true],
    ['127.0.0.1', true],
    ['127.8.9.10', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['::ffff:10.0.0.1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['metadata', true],
    ['metadata.google.internal', true],
    ['example.com', false],
    ['8.8.8.8', false],
    ['172.32.0.1', false],
    ['2606:4700::6810:84e5', false],
  ])('isDeniedWebhookHost(%s) === %s', (host, denied) => {
    expect(isDeniedWebhookHost(host)).toBe(denied);
  });
});
