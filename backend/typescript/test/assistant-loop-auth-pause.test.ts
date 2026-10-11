/**
 * ADR 0862 — a loop refused by its connection stops burning runs.
 *
 * MEASURED in production (2026-09-08 → 09-29): the calendar and drive loops failed
 * 1,233 scheduled runs on a Google 403, one every 30 minutes, with nothing to stop
 * them. After `AUTH_PAUSE_AFTER` consecutive reconnect-class refusals the loop now
 * pauses itself and tells the person it acts as, once. Re-enabling clears it.
 *
 * Sabotage witnesses (/grade-tests w11): the pause threshold, the notify-once
 * `job.enabled` guard, the success reset, the reconnect-code filter, the fork
 * exclusion, the cron-trigger filter, the run-id dedupe, the bounded-ledger
 * high-water mark, the panel's `autoPausedCode`, the notice recipient, and the
 * re-enable health reset. Honest ceiling: "a run with no schedule" cannot be
 * failed from inside `onLoopRunTerminal` — with no `schedule.jobId` there is no job
 * to update (MEASURED: removing the whole schedule check reds only the manual-Run
 * case). It stays as the contract statement.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type EmittedNotice = Parameters<ReturnType<typeof import('../src/notifications/emitter.js')['getNotificationEmitter']>['emit']>[0];
const emitted = vi.hoisted(() => [] as EmittedNotice[]);
vi.mock('../src/notifications/emitter.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/notifications/emitter.js')>();
  return {
    ...orig,
    getNotificationEmitter: () => {
      const real = orig.getNotificationEmitter();
      return { ...real, emit: async (n: Parameters<typeof real.emit>[0]) => { emitted.push(n); return real.emit(n); } };
    },
  };
});

import { createApp } from '../src/index.js';
import { AUTH_PAUSE_AFTER, enableLoop, listLoopStatuses, onLoopRunTerminal } from '../src/features/assistant/loops.js';
import { getJob } from '../src/host/schedulingService.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let storage: Storage;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 18995, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
});

async function scheduledRun(tenantId: string, jobId: string, status: 'failed' | 'completed', code?: string, overrides: Partial<RunRecord> = {}): Promise<string> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId, workflowId: 'assistant.loop.calendar-ingest', tenantId, status, inputs: {}, configurable: {},
    metadata: { schedule: { jobId, source: 'schedule', trigger: 'cron' } }, createdAt: now, updatedAt: now,
    ...(code ? { error: { code, message: 'refused' } } : {}), ...overrides,
  };
  await storage.insertRun(run);
  return runId;
}
const pausedNotices = () => emitted.filter((n) => n.metadata?.assistantLoopAutoPaused === true);

describe('the loop pauses itself after repeated connection refusals', () => {
  it(`pauses on the ${AUTH_PAUSE_AFTER}th consecutive reconnect-class refusal, tells the owner ONCE, and the panel says why`, async () => {
    const tenant = 'org:loop-pause-1';
    const job = (await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner-1' }))!;
    for (let i = 0; i < AUTH_PAUSE_AFTER - 1; i++) await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'failed', 'connection_scope_missing'), 'failed');
    expect((await getJob(job.jobId))?.enabled).toBe(true);
    await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'failed', 'connection_scope_missing'), 'failed');
    expect((await getJob(job.jobId))?.enabled).toBe(false);
    const notices = pausedNotices().filter((n) => n.tenantId === tenant);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ recipientUserId: 'user:owner-1', actionUrl: '/connections' });
    const status = (await listLoopStatuses(tenant)).find((l) => l.loopId === 'calendar-ingest');
    expect(status?.autoPausedCode).toBe('connection_scope_missing');

    // A further terminal (an in-flight run landing late) does not notify again.
    await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'failed', 'connection_scope_missing'), 'failed');
    expect(pausedNotices().filter((n) => n.tenantId === tenant)).toHaveLength(1);

    // Re-enabling (after reconnecting) clears the count and the marker.
    await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner-1' });
    const after = (await listLoopStatuses(tenant)).find((l) => l.loopId === 'calendar-ingest');
    expect(after?.enabled).toBe(true);
    expect(after?.autoPausedCode).toBeUndefined();
  });

  it('a non-connection failure neither counts nor resets; a success resets', async () => {
    const tenant = 'org:loop-pause-2';
    const job = (await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner-2' }))!;
    for (let i = 0; i < AUTH_PAUSE_AFTER - 1; i++) await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'failed', 'connection_reauth_required'), 'failed');
    await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'failed', 'upstream_unavailable'), 'failed');
    expect((await getJob(job.jobId))?.enabled, 'a flaky upstream is not a dead connection').toBe(true);
    await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'completed'), 'completed');
    await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'failed', 'connection_reauth_required'), 'failed');
    expect((await getJob(job.jobId))?.enabled, 'the success reset the run of refusals').toBe(true);
  });

  it('a run with no schedule (a person pressed Run now) does not count', async () => {
    const tenant = 'org:loop-pause-3';
    const job = (await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner-3' }))!;
    for (let i = 0; i < AUTH_PAUSE_AFTER + 1; i++) {
      const runId = randomUUID();
      const now = new Date().toISOString();
      await storage.insertRun({ runId, workflowId: 'assistant.loop.calendar-ingest', tenantId: tenant, status: 'failed', inputs: {}, configurable: {}, metadata: {}, createdAt: now, updatedAt: now, error: { code: 'connection_reauth_required', message: 'x' } });
      await onLoopRunTerminal(runId, 'failed');
    }
    expect((await getJob(job.jobId))?.enabled).toBe(true);
  });
  it.each([undefined, '0 * * * *'])('deduplicates terminal observations across concurrency, success, and re-enable (%s)', async (cronExpr) => {
    const tenant = `org:loop-dedupe-${cronExpr ?? 'same'}`;
    const job = (await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner' }))!;
    const failed = await scheduledRun(tenant, job.jobId, 'failed', 'connection_scope_missing');
    await Promise.all(Array.from({ length: 4 }, () => onLoopRunTerminal(failed, 'failed')));
    expect((await getJob(job.jobId))?.metadata?.assistantLoopHealth).toMatchObject({ consecutiveAuthFailures: 1 });
    const successful = await scheduledRun(tenant, job.jobId, 'completed');
    await onLoopRunTerminal(successful, 'completed');
    await onLoopRunTerminal(failed, 'failed');
    expect((await getJob(job.jobId))?.metadata?.assistantLoopHealth).toMatchObject({ consecutiveAuthFailures: 0 });
    await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner', cronExpr });
    await onLoopRunTerminal(failed, 'failed');
    expect((await getJob(job.jobId))?.enabled).toBe(true);
    expect((await getJob(job.jobId))?.metadata?.assistantLoopHealth).not.toHaveProperty('consecutiveAuthFailures');
    expect(pausedNotices().filter((n) => n.tenantId === tenant)).toHaveLength(0);
  });
  it('concurrent distinct runs retain every increment and notify only the pause winner', async () => {
    const tenant = 'org:loop-concurrent';
    const job = (await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner' }))!;
    await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'failed', 'connection_scope_missing'), 'failed');
    const runs = await Promise.all(Array.from({ length: 3 }, () => scheduledRun(tenant, job.jobId, 'failed', 'connection_scope_missing')));
    await Promise.all(runs.map((id) => onLoopRunTerminal(id, 'failed')));
    expect((await getJob(job.jobId))?.enabled).toBe(false);
    expect((await getJob(job.jobId))?.metadata?.assistantLoopHealth).toMatchObject({ consecutiveAuthFailures: 4 });
    expect(pausedNotices().filter((n) => n.tenantId === tenant)).toHaveLength(1);
  });
  it.each(['replay', 'branch'] as const)('%s fork schedule provenance neither counts nor resets cron health', async (forkMode) => {
    const tenant = `org:loop-fork-${forkMode}`;
    const job = (await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner' }))!;
    for (let i = 0; i < AUTH_PAUSE_AFTER - 1; i++) await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'failed', 'connection_scope_missing'), 'failed');
    const before = await getJob(job.jobId);
    for (const status of ['failed', 'completed'] as const) {
      const id = await scheduledRun(tenant, job.jobId, status, status === 'failed' ? 'connection_scope_missing' : undefined, { parentRunId: randomUUID(), forkMode });
      await onLoopRunTerminal(id, status);
    }
    expect(await getJob(job.jobId)).toEqual(before);
    expect(pausedNotices().filter((n) => n.tenantId === tenant)).toHaveLength(0);
  });
  it('scheduled manual Run now does not change cron health', async () => {
    const tenant = 'org:loop-manual';
    const job = (await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner' }))!;
    await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'failed', 'connection_scope_missing'), 'failed');
    const before = await getJob(job.jobId);
    for (const status of ['failed', 'completed'] as const) {
      const id = await scheduledRun(tenant, job.jobId, status, status === 'failed' ? 'connection_scope_missing' : undefined, { metadata: { schedule: { jobId: job.jobId, trigger: 'manual' } } });
      await onLoopRunTerminal(id, status);
    }
    expect(await getJob(job.jobId)).toEqual(before);
  });
  it('bounds its ledger and refuses an evicted old observation', async () => {
    const tenant = 'org:loop-bounded';
    const job = (await enableLoop(tenant, 'calendar-ingest', { actingUserId: 'user:owner' }))!;
    const old = await scheduledRun(tenant, job.jobId, 'failed', 'connection_scope_missing', { createdAt: '2020-01-01T00:00:00.000Z' });
    await onLoopRunTerminal(old, 'failed');
    for (let i = 0; i < 65; i++) await onLoopRunTerminal(await scheduledRun(tenant, job.jobId, 'completed'), 'completed');
    const before = await getJob(job.jobId);
    expect(before?.metadata?.assistantLoopHealth).toMatchObject({ consecutiveAuthFailures: 0, observedThrough: expect.any(String) });
    expect((before?.metadata?.assistantLoopHealth as { observedRuns: unknown[] }).observedRuns).toHaveLength(64);
    await onLoopRunTerminal(old, 'failed');
    expect(await getJob(job.jobId)).toEqual(before);
  });

});
