import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { QueueSurface, QueueBusSurface } from '../src/host/inMemorySurfaces.js';
import { createDurableQueue, createDurableQueueBus } from '../src/host/durable/durableQueue.js';
import { _setDurableStorageForTesting } from '../src/host/durable/durableKv.js';

let storage: Storage;

beforeAll(async () => {
  storage = await openStorage('memory://');
  _setDurableStorageForTesting(storage);
});
afterAll(async () => { await storage.close(); });

describe('durable queue surface', () => {
  const q: QueueSurface = createDurableQueue({ tenantId: 'q-t' });

  it('enqueue/dequeue is FIFO and survives in the shared store', async () => {
    await q.enqueue({ queue: 'jobs', payload: { n: 1 } });
    await q.enqueue({ queue: 'jobs', payload: { n: 2 } });
    await q.enqueue({ queue: 'jobs', payload: { n: 3 } });
    expect((await q.dequeue({ queue: 'jobs' })).payload).toEqual({ n: 1 });
    expect((await q.dequeue({ queue: 'jobs' })).payload).toEqual({ n: 2 });
    expect((await q.dequeue({ queue: 'jobs' })).payload).toEqual({ n: 3 });
    expect(await q.dequeue({ queue: 'jobs' })).toEqual({ found: false });
  });

  it('delivers each message at most once under concurrent consumers', async () => {
    for (let i = 0; i < 50; i++) await q.enqueue({ queue: 'race', payload: i });
    // 50 messages, 80 concurrent dequeues — each message claimed by exactly one.
    const results = await Promise.all(
      Array.from({ length: 80 }, () => q.dequeue({ queue: 'race' })),
    );
    const got = results.filter((r) => (r as { found: boolean }).found).map((r) => (r as { payload: number }).payload);
    expect(got.length).toBe(50);
    expect(new Set(got).size).toBe(50); // no duplicates
  });

  it('isolates queues and tenants', async () => {
    await q.enqueue({ queue: 'a', payload: 'x' });
    const other = createDurableQueue({ tenantId: 'q-other' });
    expect(await other.dequeue({ queue: 'a' })).toEqual({ found: false }); // other tenant can't see it
    expect(await q.dequeue({ queue: 'b' })).toEqual({ found: false }); // different queue
  });
});

describe('durable queueBus surface', () => {
  const bus: QueueBusSurface = createDurableQueueBus({ tenantId: 'bus-t' });

  it('publish → consume → ack removes the in-flight entry', async () => {
    await bus.publish({ subject: 's1', payload: { hi: true } });
    const m = await bus.consume({ subject: 's1' }) as { found: boolean; deliveryToken: string; payload: unknown; deliveryCount: number };
    expect(m.found).toBe(true);
    expect(m.payload).toEqual({ hi: true });
    expect(m.deliveryCount).toBe(1);
    expect(await bus.ack({ deliveryToken: m.deliveryToken })).toEqual({ acked: true, deliveryToken: m.deliveryToken });
    // double-ack is a no-op
    expect((await bus.ack({ deliveryToken: m.deliveryToken }) as { acked: boolean }).acked).toBe(false);
    expect(await bus.consume({ subject: 's1' })).toEqual({ found: false }); // drained
  });

  it('nack requeues with an incremented deliveryCount', async () => {
    await bus.publish({ subject: 's2', payload: 'job' });
    const m1 = await bus.consume({ subject: 's2' }) as { deliveryToken: string };
    expect((await bus.nack({ deliveryToken: m1.deliveryToken })) as { nacked: boolean; requeued: boolean }).toEqual({ nacked: true, requeued: true });
    const m2 = await bus.consume({ subject: 's2' }) as { found: boolean; deliveryCount: number };
    expect(m2.found).toBe(true);
    expect(m2.deliveryCount).toBe(2);
  });

  it('nack with requeue:false drops the message', async () => {
    await bus.publish({ subject: 's3', payload: 'x' });
    const m = await bus.consume({ subject: 's3' }) as { deliveryToken: string };
    expect(await bus.nack({ deliveryToken: m.deliveryToken, requeue: false })).toEqual({ nacked: true, requeued: false });
    expect(await bus.consume({ subject: 's3' })).toEqual({ found: false });
  });

  it('deadLetter routes to <subject>.dlq with the wrapped payload', async () => {
    await bus.publish({ subject: 's4', payload: { v: 1 } });
    const m = await bus.consume({ subject: 's4' }) as { deliveryToken: string };
    const res = await bus.deadLetter({ deliveryToken: m.deliveryToken, reason: 'bad' }) as { deadLettered: boolean; dlqSubject: string };
    expect(res.deadLettered).toBe(true);
    expect(res.dlqSubject).toBe('s4.dlq');
    const dl = await bus.consume({ subject: 's4.dlq' }) as { found: boolean; payload: { original: unknown; deadLetterReason: string } };
    expect(dl.found).toBe(true);
    expect(dl.payload).toEqual({ original: { v: 1 }, deadLetterReason: 'bad' });
  });

  it('nack/deadLetter on an unknown token report cleanly', async () => {
    expect(await bus.nack({ deliveryToken: 'nope' })).toEqual({ nacked: false, reason: 'unknown_delivery_token' });
    expect(await bus.deadLetter({ deliveryToken: 'nope' })).toEqual({ deadLettered: false, reason: 'unknown_delivery_token' });
  });

  it('stream snapshot returns records only when fromBeginning', async () => {
    await bus.streamPublish({ stream: 'evt', record: { a: 1 } });
    await bus.streamPublish({ stream: 'evt', record: { a: 2 } });
    expect(await bus.streamSubscribe({ stream: 'evt', fromBeginning: false })).toEqual({ records: [], fromBeginningSnapshot: false });
    const snap = await bus.streamSubscribe({ stream: 'evt', fromBeginning: true }) as { records: Array<{ payload: unknown }>; count: number };
    expect(snap.count).toBe(2);
    expect(snap.records.map((r) => r.payload)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
