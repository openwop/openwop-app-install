/**
 * ADR 0862 — a loop whose last run FAILED says why.
 *
 * ADR 0662 D3 made `listLoopStatuses` project `lastRunStatus` "because fixing the run half
 * alone would have left the panel green". The panel never rendered it, so in production a
 * calendar loop failing most of its runs on a lapsed Google connection read "Last run 9:02"
 * beside a green "On". The status alone does not name the fix, so the run's typed
 * `error.code` rides with it — a code, never the message (provider text stays off the wire).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { enableLoop, listLoopStatuses } from '../src/features/assistant/loops.js';
import { recordJobRun } from '../src/host/schedulingService.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const TENANT = 'default';
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 18999, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
});

describe('the loop status names the failure', () => {
  it('projects the failed run\'s error CODE, and nothing from its message', async () => {
    const job = await enableLoop(TENANT, 'calendar-ingest', { actingUserId: 'user:lre' });
    expect(job).toBeTruthy();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const failed: RunRecord = {
      runId, workflowId: 'assistant.loop.calendar-ingest', tenantId: TENANT, status: 'failed', inputs: {}, metadata: {}, configurable: {},
      createdAt: now, updatedAt: now,
      error: { code: 'connection_reauth_required', message: 'Google Calendar rejected the sign-in (HTTP 401, authError) — secret provider text' },
    };
    await storage.insertRun(failed);
    await recordJobRun(job!.jobId, runId);
    const cal = (await listLoopStatuses(TENANT)).find((l) => l.loopId === 'calendar-ingest');
    expect(cal?.lastRunStatus).toBe('failed');
    expect(cal?.lastRunErrorCode).toBe('connection_reauth_required');
    expect(JSON.stringify(cal)).not.toContain('secret provider text');
  });

  it('a completed run carries no error code', async () => {
    const job = await enableLoop(TENANT, 'drive-ingest', { actingUserId: 'user:lre' });
    const runId = randomUUID();
    const now = new Date().toISOString();
    const done: RunRecord = { runId, workflowId: 'assistant.loop.drive-ingest', tenantId: TENANT, status: 'completed', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
    await storage.insertRun(done);
    await recordJobRun(job!.jobId, runId);
    const drive = (await listLoopStatuses(TENANT)).find((l) => l.loopId === 'drive-ingest');
    expect(drive?.lastRunStatus).toBe('completed');
    expect(drive?.lastRunErrorCode).toBeUndefined();
  });
});
