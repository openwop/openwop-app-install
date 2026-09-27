/**
 * Durable webhook-delivery queue (replaces the old setImmediate fire-and-forget
 * path). Exercises the storage queue + the worker drain against the in-memory
 * sqlite backend: signed successful delivery, exponential-backoff retry through
 * to dead-letter, and the claim lease that makes the queue crash-recoverable /
 * multi-instance-safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { fetch as undiciFetch, Response as UndiciResponse } from 'undici';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { WebhookDeliveryRecord } from '../src/types.js';
import {
  processDueWebhookDeliveries,
  webhookBackoffMs,
  WEBHOOK_MAX_ATTEMPTS,
} from '../src/host/webhookDeliveryWorker.js';

// The worker delivers through undici's fetch (NOT globalThis.fetch) so it can
// pin resolution via the egress-guard dispatcher (RFC 0093 §A.1) — mock the
// module export. `importOriginal` keeps Agent/Response real.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});
const fetchMock = vi.mocked(undiciFetch);

const T0 = 1_700_000_000_000; // fixed epoch ms

function makeDelivery(over: Partial<WebhookDeliveryRecord> = {}): WebhookDeliveryRecord {
  return {
    deliveryId: over.deliveryId ?? `d-${Math.random().toString(36).slice(2)}`,
    subscriptionId: 'sub-1',
    url: 'https://example.test/hook',
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
    ...over,
  };
}

describe('durable webhook delivery queue', () => {
  let storage: Storage;

  beforeEach(async () => {
    storage = await openStorage('memory://');
    // ADR 0747 — the worker signs with the SUBSCRIPTION's secret at send time, so a
    // queue row needs the subscription it belongs to (production never has a
    // pending row without one: WHD-16 deletes them together).
    await storage.insertWebhook({ subscriptionId: 'sub-1', tenantId: 'default', url: 'https://example.test/hook', events: ['*'], secret: 'shh', createdAt: new Date(T0).toISOString() });
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });


  // ADR 0606 — the delivery layer decides what actually leaves the process, so
  // it re-checks the SCHEME the way the dispatcher re-checks the resolved
  // address. MEASURED before the fix: this exact row produced
  // `fetches=1 to=http://example.test/hook` — one plaintext POST carrying the
  // payload and the `x-openwop-signature` header. Registration refuses such a
  // url now, but rows enqueued before that arm existed still reach here.
  it('ADR 0606 — a stored http:// row is NOT delivered; it fails closed', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 200 }));
    await storage.enqueueWebhookDelivery(makeDelivery({ deliveryId: 'plain', url: 'http://example.test/hook' }));

    const processed = await processDueWebhookDeliveries(storage, 'worker-a', T0);
    expect(processed).toBe(1);
    // The load-bearing assertion: nothing left the process.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // POSITIVE CONTROL for the arm above — without this, an arm that refused
  // EVERY delivery would look identical to one that refuses only plaintext.
  it('ADR 0606 positive control — an https row on the same path still delivers', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 200 }));
    await storage.enqueueWebhookDelivery(makeDelivery({ deliveryId: 'tls', url: 'https://example.test/hook' }));

    await processDueWebhookDeliveries(storage, 'worker-a', T0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://example.test/hook');
  });

  // The dev flag that opens every other egress arm opens this one too, so the
  // conformance suite's plaintext loopback receiver keeps working.
  it('ADR 0606 — OPENWOP_WEBHOOK_ALLOW_PRIVATE=true reopens plaintext delivery', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    try {
      const fetchSpy = fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 200 }));
      await storage.enqueueWebhookDelivery(makeDelivery({ deliveryId: 'devflag', url: 'http://127.0.0.1:9/hook' }));
      await processDueWebhookDeliveries(storage, 'worker-a', T0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    }
  });

  it('delivers a signed POST once and marks the row terminal', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 200 }));
    await storage.enqueueWebhookDelivery(makeDelivery({ deliveryId: 'ok' }));

    const processed = await processDueWebhookDeliveries(storage, 'worker-a', T0);
    expect(processed).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // RFC 0165 §C.1 dual emission (ADR 0625) — the v1.x `X-openwop-*` family
    // AND the `OpenWOP-*` family the v2 cut keeps, IDENTICAL values, one delivery.
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://example.test/hook');
    const headers = (init!.headers ?? {}) as Record<string, string>;
    // Canonical (webhooks.md §"Headers"):
    expect(headers['x-openwop-webhook-id']).toBe('sub-1');
    expect(headers['x-openwop-event-type']).toBe('run.completed');
    expect(headers['x-openwop-timestamp']).toMatch(/^\d+$/);
    expect(headers['x-openwop-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['x-openwop-signature-algorithm']).toBe('v1');
    expect(headers['user-agent']).toMatch(/^openwop-webhook-dispatcher\/\S+$/);
    // RFC 0165 §C.1 — the `OpenWOP-*` family, value-identical to `X-openwop-*`:
    for (const h of ['webhook-id', 'event-type', 'timestamp', 'signature', 'signature-algorithm']) {
      expect(headers[`openwop-${h}`], `OpenWOP-${h} MUST equal X-openwop-${h}`).toBe(headers[`x-openwop-${h}`]);
    }
    // ADR 0538 Phase 2 closed: the pre-spec combined encoding and the
    // `openwop-subscription-id` name are gone, not merely joined.
    expect(headers['openwop-subscription-id']).toBeUndefined();
    expect(headers['openwop-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    // RFC 0093 §A.1-A.2 — every delivery refuses redirects and rides the
    // egress-guard dispatcher (pinned-resolution re-validation).
    expect(init!.redirect).toBe('error');
    expect(init!.dispatcher).toBeDefined();

    // Terminal: nothing more is due, even far in the future.
    expect(await processDueWebhookDeliveries(storage, 'worker-a', T0 + 3_600_000)).toBe(0);
  });

  it('emits the durable major-2 wire subscription id in both webhook header families', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 200 }));
    await storage.insertWebhook({ subscriptionId: '11111111-2222-4333-8444-555555555555', tenantId: 'acme', url: 'https://example.test/hook', events: ['*'], secret: 'shh', createdAt: new Date(T0).toISOString(), protocolMajor: 2 });
    await storage.enqueueWebhookDelivery(makeDelivery({
      deliveryId: 'v2-bound-header',
      subscriptionId: '11111111-2222-4333-8444-555555555555',
      wireSubscriptionId: 'acme/11111111-2222-4333-8444-555555555555',
    }));

    await processDueWebhookDeliveries(storage, 'worker-a', T0);
    const headers = (fetchSpy.mock.calls[0]![1]!.headers ?? {}) as Record<string, string>;
    expect(headers['openwop-webhook-id']).toBe('acme/11111111-2222-4333-8444-555555555555');
    expect(headers['x-openwop-webhook-id']).toBe(headers['openwop-webhook-id']);
  });

  it('ADR 0538 / RFC 0165 §C.1 — the X-openwop-Signature verifies per webhooks.md, and the OpenWOP-* family verifies the SAME bytes', async () => {
    const secret = 'shh';
    const payload = JSON.stringify({ type: 'run.completed', runId: 'r1' });
    const fetchSpy = fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 200 }));
    await storage.enqueueWebhookDelivery(makeDelivery({ deliveryId: 'sig', secret, payload }));

    await processDueWebhookDeliveries(storage, 'worker-a', T0);
    const headers = (fetchSpy.mock.calls[0]![1]!.headers ?? {}) as Record<string, string>;

    // Verify EXACTLY as webhooks.md §"Verification recipe" tells a subscriber:
    // strip `sha256=`, recompute HMAC-SHA256 over `${timestamp}.${rawBody}`.
    const ts = headers['x-openwop-timestamp']!;
    const canonicalSig = headers['x-openwop-signature']!.replace(/^sha256=/, '');
    const expected = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
    expect(canonicalSig).toBe(expected);

    // RFC 0165 §C.1 — a subscriber reading ONLY the `OpenWOP-*` family verifies
    // the same bytes with the same recipe: one delivery, two names, no drift.
    const ts2 = headers['openwop-timestamp']!;
    const sig2 = headers['openwop-signature']!.replace(/^sha256=/, '');
    expect(headers['openwop-signature-algorithm']).toBe('v1');
    expect(ts2).toBe(ts);
    expect(sig2).toBe(canonicalSig);
    expect(createHmac('sha256', secret).update(`${ts2}.${payload}`).digest('hex')).toBe(sig2);
  });

  it('retries with exponential backoff and dead-letters after maxAttempts', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 500 }));
    await storage.enqueueWebhookDelivery(makeDelivery({ deliveryId: 'fail' }));

    let now = T0;
    let totalFetches = 0;
    // Drive the backoff schedule: each failure reschedules at now+backoff(attempt).
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS + 2; attempt++) {
      const processed = await processDueWebhookDeliveries(storage, 'worker-a', now);
      if (processed === 0) break; // dead-lettered — no longer due
      totalFetches++;
      now += webhookBackoffMs(attempt); // advance past the reschedule delay
    }
    // Attempted exactly maxAttempts times, then dead-lettered (no further claims).
    expect(totalFetches).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(fetchSpy).toHaveBeenCalledTimes(WEBHOOK_MAX_ATTEMPTS);
    expect(await processDueWebhookDeliveries(storage, 'worker-a', now + 1_000_000)).toBe(0);
  });

  it('is not due before its backoff elapses', async () => {
    fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 503 }));
    await storage.enqueueWebhookDelivery(makeDelivery({ deliveryId: 'wait' }));

    expect(await processDueWebhookDeliveries(storage, 'worker-a', T0)).toBe(1); // first attempt fails
    // Immediately after, it's scheduled in the future — not yet due.
    expect(await processDueWebhookDeliveries(storage, 'worker-a', T0 + 1)).toBe(0);
    // After the first backoff window, due again.
    expect(await processDueWebhookDeliveries(storage, 'worker-a', T0 + webhookBackoffMs(1))).toBe(1);
  });

  it('leases a claimed row and re-claims it only after the lease expires (crash recovery)', async () => {
    await storage.enqueueWebhookDelivery(makeDelivery({ deliveryId: 'lease' }));
    const leaseMs = 30_000;

    const first = await storage.claimDueWebhookDeliveries('worker-a', T0, leaseMs, 10);
    expect(first.map((d) => d.deliveryId)).toEqual(['lease']);

    // A second instance can't grab it while the lease is live (worker-a "crashed"
    // before completing — the row stays claimed).
    expect(await storage.claimDueWebhookDeliveries('worker-b', T0 + 5_000, leaseMs, 10)).toEqual([]);

    // Once the lease expires, another instance re-claims it.
    const reclaim = await storage.claimDueWebhookDeliveries('worker-b', T0 + leaseMs + 1, leaseMs, 10);
    expect(reclaim.map((d) => d.deliveryId)).toEqual(['lease']);
    expect(reclaim[0]!.claimedBy).toBe('worker-b');
  });
});
