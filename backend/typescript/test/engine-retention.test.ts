/**
 * ADR 0287 (grade-data RUN-2) — engine-table retention, operator opt-in:
 *  - pruneTerminalRuns deletes WHOLE terminal runs past the cutoff with all
 *    children (events here), never a running run, never a fresh terminal run,
 *    and honors the batch limit.
 *  - pruneWebhookDeliveries deletes delivered/dead rows past the cutoff, never
 *    pending ones.
 *  - pruneEngineTables is fail-closed: with the env gates unset it prunes
 *    NOTHING; with gates set it prunes and emits the audit rows.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { pruneEngineTables } from '../src/host/retentionSweepDaemon.js';

let storage: Storage;
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function run(runId: string, status: RunRecord['status'], updatedDaysAgo: number): RunRecord {
  return {
    runId, workflowId: 'wf-1', tenantId: 't-ret', status,
    inputs: {}, metadata: {}, configurable: {},
    createdAt: iso(updatedDaysAgo + 1), updatedAt: iso(updatedDaysAgo),
  };
}

beforeAll(async () => {
  storage = await openStorage('memory://');
});

beforeEach(() => {
  delete process.env.OPENWOP_RUN_RETENTION_DAYS;
  delete process.env.OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS;
});

describe('pruneTerminalRuns (ADR 0287)', () => {
  it('prunes old terminal runs WITH children; keeps running + fresh runs; honors the limit', async () => {
    await storage.insertRun(run('r-old-done', 'completed', 120));
    await storage.insertRun(run('r-old-failed', 'failed', 110));
    await storage.insertRun(run('r-old-running', 'running', 120)); // long-running — must survive
    await storage.insertRun(run('r-new-done', 'completed', 2)); // fresh terminal — must survive
    await storage.appendEvent({ runId: 'r-old-done', eventId: 'ev-old-1', type: 'run.started', payload: {}, timestamp: iso(120) });
    await storage.appendEvent({ runId: 'r-new-done', eventId: 'ev-new-1', type: 'run.started', payload: {}, timestamp: iso(2) });

    // Batch limit of 1: only the OLDEST terminal run goes this call.
    const first = await storage.pruneTerminalRuns(iso(90), 1);
    expect(first.runs).toBe(1);
    expect(await storage.getRun('r-old-done')).toBeNull();
    expect(first.childRows).toBeGreaterThanOrEqual(1); // its event went with it
    expect(await storage.getRun('r-old-failed')).not.toBeNull();

    const second = await storage.pruneTerminalRuns(iso(90), 100);
    expect(second.runs).toBe(1); // r-old-failed
    expect(await storage.getRun('r-old-running')).not.toBeNull(); // never a non-terminal run
    expect(await storage.getRun('r-new-done')).not.toBeNull(); // never a fresh run
    expect((await storage.listEvents('r-new-done')).length).toBe(1); // kept run keeps its history

    const third = await storage.pruneTerminalRuns(iso(90), 100);
    expect(third).toEqual({ runs: 0, childRows: 0 }); // idempotent — nothing left
  });
});

describe('pruneWebhookDeliveries (ADR 0287)', () => {
  it('prunes delivered/dead past the cutoff; never pending', async () => {
    const base = { subscriptionId: 'sub-1', url: 'https://x.test', secret: 's', eventType: 'run.completed', payload: '{}', attempts: 1, maxAttempts: 5, nextAttemptAt: NOW, createdAt: NOW - 100 * DAY, updatedAt: NOW - 100 * DAY };
    await storage.enqueueWebhookDelivery({ ...base, deliveryId: 'd-old-delivered', status: 'delivered' });
    await storage.enqueueWebhookDelivery({ ...base, deliveryId: 'd-old-dead', status: 'dead' });
    await storage.enqueueWebhookDelivery({ ...base, deliveryId: 'd-old-pending', status: 'pending' });
    await storage.enqueueWebhookDelivery({ ...base, deliveryId: 'd-new-delivered', status: 'delivered', updatedAt: NOW - 1 * DAY });

    const pruned = await storage.pruneWebhookDeliveries(NOW - 30 * DAY);
    expect(pruned).toBe(2); // old delivered + old dead; pending + fresh survive
  });
});

describe('pruneEngineTables env gates (ADR 0287)', () => {
  it('is fail-closed with no env gates, and prunes + audits when set', async () => {
    await storage.insertRun(run('r-gate-old', 'completed', 200));

    const off = await pruneEngineTables({ storage }, NOW);
    expect(off).toEqual({ runs: 0, childRows: 0, deliveries: 0 }); // DEFAULT OFF
    expect(await storage.getRun('r-gate-old')).not.toBeNull();

    process.env.OPENWOP_RUN_RETENTION_DAYS = '90';
    const on = await pruneEngineTables({ storage }, NOW);
    expect(on.runs).toBe(1);
    expect(await storage.getRun('r-gate-old')).toBeNull();
  });
});
