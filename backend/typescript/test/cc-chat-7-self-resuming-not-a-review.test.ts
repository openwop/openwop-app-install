/**
 * CC-CHAT-7: a wait that resumes on its own is not a review.
 *
 * MEASURED on prod 2026-11-17 (build 2c83c256ec, run a3971138): a live campaign
 * orchestration waiting on its channel runs (`external-event` at channel-dispatch)
 * was listed by `GET /reviews?status=pending` as `canDecide: true` with a
 * `resolve` action that takes a value. The chat rail counted it, so the
 * conversation sat under "Needs you · Waiting on you". The conversation showed a
 * "Needs your approval" card, while the run page said "continues on its own.
 * There is nothing to do here."
 *
 * The pending inbox now skips `external-event` and `timer` interrupts, as it
 * already skipped `conversation`. A person's gate on the same run still lists.
 * Each case also runs the global-scan fallback (an adapter without the
 * tenant-scoped query), so the filter is witnessed on both read paths.
 *
 * Red on main: main lists the external-event and timer rows, so the id lists
 * below gain two entries.
 */
import { describe, expect, it } from 'vitest';
import type { Storage } from '../src/storage/storage.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { listReviews } from '../src/host/reviewProjection.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

function withoutTenantScan(storage: Storage): Storage {
  return new Proxy<Storage>(storage, {
    get(target, prop) {
      if (prop === 'listOpenInterruptsForTenant') return undefined;
      const v: unknown = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

let seq = 0;
async function seedRun(storage: Storage, tenantId: string, status: RunRecord['status']): Promise<string> {
  const now = new Date(Date.now() + ++seq).toISOString();
  const run: RunRecord = {
    runId: `run-cc7-${seq}`, workflowId: 'campaign-studio.campaign-orchestration', tenantId, status,
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  return run.runId;
}
async function seedInterrupt(storage: Storage, runId: string, nodeId: string, kind: InterruptRecord['kind']): Promise<string> {
  const now = new Date(Date.now() + ++seq).toISOString();
  const it: InterruptRecord = {
    interruptId: `int-cc7-${seq}`, runId, nodeId, kind,
    token: `tok-cc7-${seq}`, data: kind === 'approval' ? { prompt: 'Approve the kernel?' } : {}, createdAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  await storage.insertInterrupt(it);
  return it.interruptId;
}

describe('CC-CHAT-7: the pending inbox lists only waits a person answers', () => {
  it('a live orchestration waiting on its channel runs is not a review; its approval gate is', async () => {
    const storage = openSqliteStorage(':memory:');
    initHostExtPersistence(storage);
    const orchestration = await seedRun(storage, 't-cc7', 'waiting-external');
    await seedInterrupt(storage, orchestration, 'channel-dispatch', 'external-event');
    const channel = await seedRun(storage, 't-cc7', 'waiting-approval');
    const gate = await seedInterrupt(storage, channel, 'email-sequence-approve', 'approval');
    const delayed = await seedRun(storage, 't-cc7', 'waiting-input');
    await seedInterrupt(storage, delayed, 'wait-a-day', 'timer');

    for (const [label, s] of [['tenant query', storage], ['global-scan fallback', withoutTenantScan(storage)]] as const) {
      const items = await listReviews(s, { tenantId: 't-cc7' }, { status: 'pending' });
      expect(items.map((r) => r.interruptId), label).toEqual([gate]);
      expect(items[0]!.kind, label).toBe('approval');
    }
    await storage.close();
  });

  it('on one run, the self-resuming wait drops out and a question for a person stays', async () => {
    const storage = openSqliteStorage(':memory:');
    initHostExtPersistence(storage);
    const run = await seedRun(storage, 't-cc7b', 'waiting-external');
    const waitId = await seedInterrupt(storage, run, 'channel-dispatch', 'external-event');
    const clarification = await seedInterrupt(storage, run, 'ask-brief', 'clarification');
    const items = await listReviews(storage, { tenantId: 't-cc7b' }, { status: 'pending' });
    expect(items.map((r) => r.interruptId)).toEqual([clarification]);
    expect(items.some((r) => r.interruptId === waitId)).toBe(false);
    await storage.close();
  });
});
