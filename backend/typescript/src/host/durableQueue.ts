/**
 * A7 — a durable work queue backed by the host `Storage` kv table (via
 * DurableCollection), so queued work SURVIVES A RESTART and is claimed at most
 * once across instances. Closes the deep-dive gap "persistent work queue —
 * queued runs subject to loss on restart" and "heartbeat not durable across
 * restarts." A production host swaps for SQS/PubSub/Redis; the contract
 * (`enqueue` / `claimNext` / `ack` / `pending`) is the same.
 *
 * Claim-once is enforced with the same atomic compare-and-swap (`kvCompareAndSwap`)
 * the approval claim uses (A7) — no in-process lock, correct cross-instance.
 */

import { DurableCollection } from './hostExtPersistence.js';

export type QueueStatus = 'queued' | 'claimed' | 'done';

export interface QueueItem<T> {
  id: string;
  /** Monotonic enqueue ordinal for FIFO claim order (caller-supplied so the
   *  queue stays free of the replay-unsafe `Date.now()` and ties break stably). */
  seq: number;
  payload: T;
  status: QueueStatus;
}

export class DurableQueue<T> {
  private readonly col: DurableCollection<QueueItem<T>>;
  constructor(name: string) {
    this.col = new DurableCollection<QueueItem<T>>(`queue:${name}`, (i) => i.id);
  }

  /** Enqueue an item. `seq` orders claims (FIFO); pass a monotonic counter. */
  async enqueue(id: string, seq: number, payload: T): Promise<void> {
    await this.col.put({ id, seq, payload, status: 'queued' });
  }

  /** Atomically claim the oldest queued item (CAS queued→claimed). Returns the
   *  claimed item, or null when the queue is empty. Exactly one caller wins a
   *  given item even under concurrency. */
  async claimNext(): Promise<QueueItem<T> | null> {
    const queued = (await this.col.list()).filter((i) => i.status === 'queued').sort((a, b) => a.seq - b.seq);
    for (const item of queued) {
      const claimed: QueueItem<T> = { ...item, status: 'claimed' };
      if (await this.col.compareAndSwap(item, claimed)) return claimed;
      // lost this one to a concurrent claimer — try the next.
    }
    return null;
  }

  /** Mark a claimed item done (idempotent). */
  async ack(id: string): Promise<void> {
    const item = await this.col.get(id);
    if (item && item.status !== 'done') await this.col.put({ ...item, status: 'done' });
  }

  /** Return a claimed item to the queue (e.g. after a failed attempt). */
  async nack(id: string): Promise<void> {
    const item = await this.col.get(id);
    if (item && item.status === 'claimed') await this.col.put({ ...item, status: 'queued' });
  }

  /** Items still awaiting a claim, FIFO. */
  async pending(): Promise<QueueItem<T>[]> {
    return (await this.col.list()).filter((i) => i.status === 'queued').sort((a, b) => a.seq - b.seq);
  }

  async __clear(): Promise<void> {
    await this.col.__clear();
  }
}
