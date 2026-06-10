/**
 * A7 — durable WORK queue (src/host/durableQueue.ts). Survives a restart (fresh
 * storage handle on the same file) and claims each item at most once under
 * concurrency. Distinct from the in-memory queueBus surface test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { DurableQueue } from '../src/host/durableQueue.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owop-q-'));
});
afterEach(() => {
  __resetHostExtPersistence();
  rmSync(dir, { recursive: true, force: true });
});

describe('durable work queue (A7)', () => {
  it('survives a restart (work persists across a fresh handle)', async () => {
    const path = join(dir, 'q.db');
    const a = openSqliteStorage(path);
    initHostExtPersistence(a);
    const q1 = new DurableQueue<{ task: string }>('work');
    await q1.enqueue('j1', 1, { task: 'a' });
    await q1.enqueue('j2', 2, { task: 'b' });
    await a.close();

    // "Restart": a fresh storage handle on the same file.
    const b = openSqliteStorage(path);
    initHostExtPersistence(b);
    const q2 = new DurableQueue<{ task: string }>('work');
    const pending = await q2.pending();
    expect(pending.map((p) => p.id)).toEqual(['j1', 'j2']); // FIFO, durable
    const claimed = await q2.claimNext();
    expect(claimed?.id).toBe('j1');
    await b.close();
  });

  it('claims each item at most once under concurrency', async () => {
    const s = openSqliteStorage(join(dir, 'q2.db'));
    initHostExtPersistence(s);
    const q = new DurableQueue<number>('c');
    await q.enqueue('only', 1, 42);

    const claims = await Promise.all([q.claimNext(), q.claimNext(), q.claimNext()]);
    const winners = claims.filter((c) => c?.id === 'only');
    expect(winners).toHaveLength(1); // exactly one claimer
    expect(claims.filter((c) => c === null)).toHaveLength(2);

    await q.ack('only');
    expect(await q.pending()).toHaveLength(0);
    await s.close();
  });
});
