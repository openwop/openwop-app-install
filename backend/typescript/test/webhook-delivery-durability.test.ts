/**
 * V2-06 / PRD §24.6 ("at-least-once durable delivery, retry/backoff, dead letter") — the
 * webhook delivery queue must survive a PROCESS RESTART: rows enqueued (and rows already
 * dead-lettered) by one process are drained / listed / retried by a fresh process opened on
 * the same durable store. The in-memory suite (`webhook-delivery-queue.test.ts`) proves the
 * lane; this one proves the DURABILITY on the file-backed sqlite store, the same `Storage`
 * contract the Postgres deploy runs (the Postgres adapter is exercised by the live
 * testcontainer lane). (Found while building a white-label fork; the README used to list this queue as omitted.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetch as undiciFetch, Response as UndiciResponse } from 'undici';
import { openStorage } from '../src/storage/index.js';
import type { WebhookDeliveryRecord } from '../src/types.js';
import { processDueWebhookDeliveries, WEBHOOK_MAX_ATTEMPTS } from '../src/host/webhookDeliveryWorker.js';

vi.mock('undici', async (importOriginal) => { const actual = await importOriginal<typeof import('undici')>(); return { ...actual, fetch: vi.fn() }; });
const fetchMock = vi.mocked(undiciFetch);
const T0 = 1_700_000_000_000;
const row = (over: Partial<WebhookDeliveryRecord>): WebhookDeliveryRecord => ({ deliveryId: `d-${Math.random().toString(36).slice(2)}`, subscriptionId: 'sub-1', url: 'https://example.test/hook', secret: 'shh', eventType: 'run.completed', payload: JSON.stringify({ type: 'run.completed', runId: 'r1' }), status: 'pending', attempts: 0, maxAttempts: WEBHOOK_MAX_ATTEMPTS, nextAttemptAt: T0, claimedBy: null, claimExpiresAt: null, lastError: null, createdAt: T0, updatedAt: T0, ...over });

afterEach(() => { fetchMock.mockReset(); vi.restoreAllMocks(); });

describe('webhook delivery queue — durability across a process restart (V2-06)', () => {
  it('rows enqueued by process A are delivered by process B; a dead row and its manual retry survive the restart too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-webhook-durable-'));
    const dsn = `sqlite://${join(dir, 'engine.db')}`;
    try {
      // Process A: enqueue a due row + a row already dead-lettered; crash before draining (no worker ran).
      const a = await openStorage(dsn);
      const due = row({ deliveryId: 'due-1' });
      const dead = row({ deliveryId: 'dead-1', status: 'dead', attempts: WEBHOOK_MAX_ATTEMPTS, lastError: '503 from endpoint' });
      await a.insertWebhook({ subscriptionId: 'sub-1', tenantId: 'default', url: 'https://example.test/hook', events: ['*'], secret: 'shh', createdAt: new Date(T0).toISOString() }); // ADR 0747 — the worker signs from the subscription
      await a.enqueueWebhookDelivery(due); await a.enqueueWebhookDelivery(dead);
      await a.close();
      // Process B: a fresh Storage on the same file sees both rows.
      const b = await openStorage(dsn);
      const before = await b.listWebhookDeliveries({ subscriptionIds: ['sub-1'], limit: 10 });
      expect(before.map((r) => [r.deliveryId, r.status]).sort()).toEqual([['dead-1', 'dead'], ['due-1', 'pending']]);
      fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 200 }));
      expect(await processDueWebhookDeliveries(b, 'worker-b', T0)).toBe(1);        // the due row, once
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const afterDrain = await b.listWebhookDeliveries({ subscriptionIds: ['sub-1'], limit: 10 });
      expect(afterDrain.find((r) => r.deliveryId === 'due-1')?.status).toBe('delivered');
      expect(afterDrain.find((r) => r.deliveryId === 'dead-1')?.status).toBe('dead');   // DLQ row untouched by the drain
      // Operator retry of the dead row (ADR 0395) is durable too: it re-queues and process C delivers it.
      expect(await b.retryWebhookDelivery('dead-1', T0)).toBe(true);
      await b.close();
      const c = await openStorage(dsn);
      expect(await processDueWebhookDeliveries(c, 'worker-c', T0)).toBe(1);
      expect((await c.listWebhookDeliveries({ subscriptionIds: ['sub-1'], status: 'delivered', limit: 10 })).map((r) => r.deliveryId).sort()).toEqual(['dead-1', 'due-1']);
      expect(await processDueWebhookDeliveries(c, 'worker-c', T0 + 60_000)).toBe(0);   // nothing left; at-least-once, not twice
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await c.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a row claimed by a process that crashed mid-delivery is re-claimed by another process after the lease expires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-webhook-lease-'));
    const dsn = `sqlite://${join(dir, 'engine.db')}`;
    try {
      const a = await openStorage(dsn);
      await a.insertWebhook({ subscriptionId: 'sub-1', tenantId: 'default', url: 'https://example.test/hook', events: ['*'], secret: 'shh', createdAt: new Date(T0).toISOString() }); // ADR 0747 — the worker signs from the subscription
      await a.enqueueWebhookDelivery(row({ deliveryId: 'claimed-1' }));
      const claimed = await a.claimDueWebhookDeliveries('worker-a', T0, 120_000, 5);
      expect(claimed.map((r) => r.deliveryId)).toEqual(['claimed-1']);
      await a.close();                                                              // crash while holding the lease
      const b = await openStorage(dsn);
      fetchMock.mockResolvedValue(new UndiciResponse(null, { status: 200 }));
      expect(await processDueWebhookDeliveries(b, 'worker-b', T0 + 1_000)).toBe(0);   // lease still held — not stolen
      expect(await processDueWebhookDeliveries(b, 'worker-b', T0 + 121_000)).toBe(1); // lease expired — recovered
      expect((await b.listWebhookDeliveries({ subscriptionIds: ['sub-1'], limit: 10 }))[0]?.status).toBe('delivered');
      await b.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
