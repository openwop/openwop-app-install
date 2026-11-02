/**
 * createSemaphore (ADR 0411 §P3 / grade-code VID-2) — bounds concurrent heavy
 * ops so generative-video buffers can't OOM a small instance. Proves it never
 * exceeds `max` in-flight, releases on both success and throw, hands slots to
 * waiters in FIFO order, and is a zero-overhead pass-through when disabled.
 *
 * Tracker TST-BEA-4 (w66). Red when: `acquire` admits at `active <= max`; the
 * slot is released only on success; waiters are taken LIFO (`pop`); `max <= 0`
 * stops being a pass-through. Settling is microtask/`setImmediate`-driven, so
 * the cases drain instead of sleeping.
 */
import { describe, it, expect } from 'vitest';
import { createSemaphore } from '../src/util/asyncSemaphore.js';

const drain = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('createSemaphore', () => {
  it('never runs more than `max` tasks concurrently', async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const gate = defer();
    const task = async () => sem.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    });
    const all = Promise.all([task(), task(), task(), task()]);
    // Let the first wave acquire; only 2 should be active with the gate held.
    await drain();
    expect(active).toBe(2);
    gate.resolve();
    await all;
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('releases the slot even when the task throws', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // A second task must still acquire (the slot was released in `finally`):
    // asserted after a drain, so a leaked slot fails here, not at the timeout.
    let settled = false;
    const second = sem.run(async () => 'ok').then((v) => { settled = true; return v; });
    await drain();
    expect(settled).toBe(true);
    await expect(second).resolves.toBe('ok');
  });

  it('hands slots to waiters in FIFO order', async () => {
    const sem = createSemaphore(1);
    const order: number[] = [];
    const hold = defer();
    const first = sem.run(async () => { await hold.promise; }); // occupies the only slot
    await drain();
    const second = sem.run(async () => { order.push(2); });
    const third = sem.run(async () => { order.push(3); });
    hold.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual([2, 3]);
  });

  it('is an unbounded pass-through when max <= 0', async () => {
    const sem = createSemaphore(0);
    let active = 0;
    let peak = 0;
    const gate = defer();
    const task = () => sem.run(async () => { active += 1; peak = Math.max(peak, active); await gate.promise; active -= 1; });
    const all = Promise.all([task(), task(), task(), task(), task()]);
    await drain();
    expect(peak).toBe(5); // all ran at once — no limit imposed
    gate.resolve();
    await all;
  });
});
