/**
 * Durable queue + message-bus host surfaces (Phase 2) over `Storage`.
 *
 * `host.queue` (RFC 0015 §queue) and `host.messaging` (RFC 0017) backed by the
 * shared `Storage` kv table instead of process-local arrays, so enqueued
 * messages survive restarts and are delivered exactly once across instances —
 * the property the in-memory demo queue lacks (it loses messages on restart and
 * can't fan out across instances).
 *
 * Cloud-agnostic: pure `Storage` kv primitives, so the same code runs on sqlite
 * (single node) and Postgres (multi-instance). No vendor-specific path.
 *
 * Mechanics:
 *  - FIFO order is a durable per-(tenant,queue) monotonic sequence, zero-padded
 *    so the kv key sorts lexicographically === chronologically. `kvList` returns
 *    keys ascending, so the lowest key is the head.
 *  - At-most-once delivery across instances: a consumer CLAIMS the head by
 *    `kvDelete` — which returns whether THIS caller removed the row. Two
 *    instances racing the same head: exactly one delete returns true, the other
 *    moves to the next candidate. No two consumers ever get the same message.
 *  - `queueBus` consume moves the claimed message to a durable in-flight row
 *    keyed by an opaque deliveryToken; ack deletes it, nack re-publishes,
 *    deadLetter routes to `<subject>.dlq`.
 *
 * Trade-off vs the in-memory impl (documented): nack-requeue re-publishes at the
 * TAIL with an incremented deliveryCount (visibility-timeout-style redelivery,
 * as real brokers do), not at the head — strict head-requeue isn't expressible
 * over an append-only durable log without a negative sequence.
 */

import { randomUUID } from 'node:crypto';
import type { BundleScope, QueueSurface, QueueBusSurface } from '../inMemorySurfaces.js';
import { requireDurableStorage } from './durableStore.js';

const enc = encodeURIComponent;
const SEQ_WIDTH = 16; // supports 1e16 messages per (tenant, queue/subject)
const padSeq = (n: number): string => String(n).padStart(SEQ_WIDTH, '0');

interface BusMessage { id: string; payload: unknown; subject: string; deliveryCount: number }

/** Atomic durable monotonic counter (per key) via compare-and-swap retry. */
async function nextSequence(counterKey: string): Promise<number> {
  const storage = requireDurableStorage();
  for (let attempt = 0; attempt < 256; attempt++) {
    const raw = await storage.kvGet(counterKey);
    const cur = raw ? Number(JSON.parse(raw)) : 0;
    const next = cur + 1;
    const res = await storage.kvCompareAndSwap(counterKey, raw, JSON.stringify(next));
    if (res.swapped) return next;
  }
  throw Object.assign(new Error('durable queue sequence: exceeded retry budget'), { code: 'cas_contention' });
}

/** Claim the lexicographically-lowest (oldest) row under `prefix`, returning it
 *  iff THIS caller removed it. Skips rows another instance grabbed first. */
async function claimHead(prefix: string): Promise<{ key: string; value: string } | null> {
  const storage = requireDurableStorage();
  const rows = await storage.kvList(prefix); // ascending by key
  for (const row of rows) {
    if (await storage.kvDelete(row.key)) return row;
  }
  return null;
}

// ── host.queue ──────────────────────────────────────────────────────
export function createDurableQueue(scope: BundleScope): QueueSurface {
  const t = enc(scope.tenantId);
  const itemPrefix = (queue: unknown) => `hostsurf:queue:${t}:${enc(String(queue))}:`;
  const counterKey = (queue: unknown) => `hostsurf:queueseq:${t}:${enc(String(queue))}`;
  const storage = () => requireDurableStorage();

  return {
    async enqueue({ queue, payload }) {
      const seq = await nextSequence(counterKey(queue));
      const id = `q-${seq}`;
      await storage().kvSet(`${itemPrefix(queue)}${padSeq(seq)}`, JSON.stringify({ id, payload }));
      return { id, enqueued: true };
    },
    async dequeue({ queue }) {
      const claimed = await claimHead(itemPrefix(queue));
      if (!claimed) return { found: false };
      const { id, payload } = JSON.parse(claimed.value) as { id: string; payload: unknown };
      return { found: true, id, payload };
    },
  };
}

// ── host.messaging (queueBus) ───────────────────────────────────────
export function createDurableQueueBus(scope: BundleScope): QueueBusSurface {
  const t = enc(scope.tenantId);
  const msgPrefix = (subject: unknown) => `hostsurf:bus:${t}:${enc(String(subject ?? 'default'))}:`;
  const counterKey = (subject: unknown) => `hostsurf:busseq:${t}:${enc(String(subject ?? 'default'))}`;
  const inflightKey = (token: string) => `hostsurf:businflight:${t}:${token}`;
  const storage = () => requireDurableStorage();

  async function publishTo(subject: string, payload: unknown, deliveryCount: number): Promise<string> {
    const seq = await nextSequence(counterKey(subject));
    const id = `m-${seq}`;
    const msg: BusMessage = { id, payload, subject, deliveryCount };
    await storage().kvSet(`${msgPrefix(subject)}${padSeq(seq)}`, JSON.stringify(msg));
    return id;
  }

  return {
    async publish({ subject, payload }) {
      const id = await publishTo(String(subject), payload, 1);
      return { id, published: true };
    },
    async consume({ subject }) {
      const claimed = await claimHead(msgPrefix(subject));
      if (!claimed) return { found: false };
      const msg = JSON.parse(claimed.value) as BusMessage;
      const deliveryToken = `dt-${randomUUID()}`;
      await storage().kvSet(inflightKey(deliveryToken), claimed.value);
      return {
        found: true,
        deliveryToken,
        id: msg.id,
        subject: msg.subject,
        payload: msg.payload,
        deliveryCount: msg.deliveryCount,
      };
    },
    async ack({ deliveryToken }) {
      const existed = await storage().kvDelete(inflightKey(String(deliveryToken)));
      return { acked: existed, deliveryToken };
    },
    async nack({ deliveryToken, requeue }) {
      const k = inflightKey(String(deliveryToken));
      const raw = await storage().kvGet(k);
      if (raw === null) return { nacked: false, reason: 'unknown_delivery_token' };
      await storage().kvDelete(k);
      if (requeue === false) return { nacked: true, requeued: false };
      const msg = JSON.parse(raw) as BusMessage;
      await publishTo(msg.subject, msg.payload, msg.deliveryCount + 1);
      return { nacked: true, requeued: true };
    },
    async deadLetter({ deliveryToken, reason }) {
      const k = inflightKey(String(deliveryToken));
      const raw = await storage().kvGet(k);
      if (raw === null) return { deadLettered: false, reason: 'unknown_delivery_token' };
      await storage().kvDelete(k);
      const msg = JSON.parse(raw) as BusMessage;
      const dlqSubject = `${msg.subject}.dlq`;
      await publishTo(dlqSubject, { original: msg.payload, deadLetterReason: String(reason ?? 'unspecified') }, 1);
      return { deadLettered: true, dlqSubject };
    },
    async streamPublish({ stream, record }) {
      const id = await publishTo(String(stream), record, 1);
      return { id, published: true };
    },
    async streamSubscribe({ stream, fromBeginning }) {
      if (fromBeginning !== true) return { records: [], fromBeginningSnapshot: false };
      const rows = await storage().kvList(msgPrefix(stream));
      const records = rows.map((r) => {
        const m = JSON.parse(r.value) as BusMessage;
        return { id: m.id, payload: m.payload };
      });
      return { records, fromBeginningSnapshot: true, count: records.length };
    },
  };
}
