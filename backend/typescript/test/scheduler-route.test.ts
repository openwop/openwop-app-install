/**
 * Sample-extension scheduler CRUD route — /host/openwop-app/scheduler/jobs.
 *
 * Exercises the list/create/patch/delete/trigger surface (C-6) backed by the
 * RFC 0052 scheduling service (`src/routes/scheduler.ts`). Verifies:
 *   - create → list round-trips a job; a missing jobId is minted
 *   - PATCH edits cronExpr/workflowId/timezone in place, PERSISTED (re-read
 *     through the list), and an empty PATCH is a validation_error
 *   - a create with no cronExpr is refused by the ROUTE's own guard (exact
 *     message, so the service-level cadence refusal cannot stand in for it)
 *   - trigger fires and reports the consumed tick (the §B.2 seam). The
 *     "same tick yields 0" half of §B.2 has no reachable product branch
 *     (`singleTick` advances the tick before it compares): grade-code lead
 *     SCHED-TICK-DEAD-1. This file does not claim it.
 *   - WF-COS-4 / ADR 0787 D5: an UNBOUND job's fire records lastRunAt; a BOUND
 *     job whose workflow does not resolve records a SKIP and never lastRunAt
 *   - a firstFireAtMs beyond maxFutureHorizon is rejected with
 *     schedule_horizon_exceeded (RFC 0052 §B.3), with the route's own
 *     `details.maxFutureHorizon` mapping (the service-level refusal is unit
 *     tested in scheduling-service.test.ts)
 *   - delete removes the job; a second delete 404s
 *
 * Sabotage witnesses (grade-tests 8f w2): sr-patch-empty, sr-patch-tz,
 * sr-unbound-lastrun, sr-bound-skip, sr-skip-record, sr-horizon,
 * sr-cron-required, sr-jobid-mint, sr-delete, sr-tick-once.
 *
 * @see RFCS/0052-scheduling-and-time-based-triggers.md §B
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { resetScheduling, MAX_FUTURE_HORIZON_MS, currentTick } from '../src/host/schedulingService.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(async () => {
  await resetScheduling();
});

async function jsonFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  const status = res.status;
  const text = await res.text();
  return { status, body: (text.length ? JSON.parse(text) : null) as T };
}

interface Job {
  jobId: string;
  cronExpr: string;
  workflowId?: string;
  lastFiredTick: number | null;
}

describe('scheduler CRUD route (C-6 / RFC 0052)', () => {
  it('creates a job and lists it back', async () => {
    const created = await jsonFetch<Job>('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-a', cronExpr: '*/5 * * * *', workflowId: 'wf-a' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.jobId).toBe('job-a');
    expect(created.body.cronExpr).toBe('*/5 * * * *');
    expect(created.body.workflowId).toBe('wf-a');

    const list = await jsonFetch<{ jobs: Job[] }>('/host/openwop-app/scheduler/jobs');
    expect(list.status).toBe(200);
    expect(list.body.jobs.some((j) => j.jobId === 'job-a')).toBe(true);
  });

  it('edits a job in place (PATCH cronExpr + workflowId + timezone)', async () => {
    await jsonFetch('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-e', cronExpr: '0 9 * * *', workflowId: 'wf-old' }),
    });
    const patched = await jsonFetch<Job & { timezone?: string; enabled: boolean }>(
      '/host/openwop-app/scheduler/jobs/job-e',
      { method: 'PATCH', body: JSON.stringify({ cronExpr: '0 9 * * 1-5', workflowId: 'wf-new', timezone: 'America/New_York' }) },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.cronExpr).toBe('0 9 * * 1-5');
    expect(patched.body.workflowId).toBe('wf-new');
    expect(patched.body.timezone).toBe('America/New_York');
    // enabled untouched by a partial patch.
    expect(patched.body.enabled).toBe(true);

    // Persisted, not only echoed: read the job back through the list.
    const list = await jsonFetch<{ jobs: Array<Job & { timezone?: string; enabled: boolean }> }>('/host/openwop-app/scheduler/jobs');
    const stored = list.body.jobs.find((j) => j.jobId === 'job-e');
    expect(stored?.cronExpr).toBe('0 9 * * 1-5');
    expect(stored?.workflowId).toBe('wf-new');
    expect(stored?.timezone).toBe('America/New_York');
    expect(stored?.enabled).toBe(true);
  });

  it('PATCH with no editable field is a validation_error', async () => {
    await jsonFetch('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-empty', cronExpr: '0 9 * * *' }),
    });
    const res = await jsonFetch<{ error: string }>('/host/openwop-app/scheduler/jobs/job-empty', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  // WF-COS-4 — the two shapes this route can fire, and they are NOT the same
  // claim. A job bound to NO workflow has no run to name, so the fire IS the
  // event and `lastRunAt` is honest. A job bound to a workflow that does not
  // resolve produced nothing, so stamping `lastRunAt` beside a stale
  // `lastRunId` is the "last run: just now, linking to a run that never
  // happened" defect — reachable from SubjectSchedulesPanel's "Run now".
  it('records lastRunAt when a job with NO bound workflow is triggered (the fire IS the event)', async () => {
    await jsonFetch('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-lr', cronExpr: '* * * * *' }),
    });
    await jsonFetch('/host/openwop-app/scheduler/jobs/job-lr/trigger', { method: 'POST', body: '{}' });
    const list = await jsonFetch<{ jobs: Array<Job & { lastRunAt?: string }> }>('/host/openwop-app/scheduler/jobs');
    const job = list.body.jobs.find((j) => j.jobId === 'job-lr')!;
    expect(typeof job.lastRunAt).toBe('string');
    expect(Number.isNaN(Date.parse(job.lastRunAt!))).toBe(false);
  });

  it('a BOUND workflow that does not resolve records a SKIP, never a lastRunAt', async () => {
    type HonestJob = Job & { lastRunAt?: string; lastRunId?: string; lastSkippedAt?: string; lastSkipReason?: string; lastFiredTick?: number };
    await jsonFetch('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-unresolved', cronExpr: '* * * * *', workflowId: 'wf-does-not-exist' }),
    });
    const fired = await jsonFetch<{ runsFired: number; runId?: string; lastFiredTick: number }>(
      '/host/openwop-app/scheduler/jobs/job-unresolved/trigger',
      { method: 'POST', body: '{}' },
    );
    // The premise: the slot really WAS consumed and no run came back. Without
    // this the assertions below would also pass on a route that never fired.
    expect(fired.status).toBe(200);
    expect(fired.body.runsFired, 'the fire must actually happen, or this test is inert').toBeGreaterThan(0);
    expect(fired.body.runId, 'an unresolvable workflow yields no run id').toBeUndefined();

    const list = await jsonFetch<{ jobs: HonestJob[] }>('/host/openwop-app/scheduler/jobs');
    const job = list.body.jobs.find((j) => j.jobId === 'job-unresolved')!;
    expect(job.lastRunAt, 'no run happened — claiming one is the whole defect').toBeUndefined();
    expect(job.lastRunId).toBeUndefined();
    expect(job.lastSkippedAt).toBeTruthy();
    expect(job.lastSkipReason).toBe('workflow-unresolved');
    // …and the slot still advanced, which is the property the split must keep.
    expect(job.lastFiredTick).toBe(fired.body.lastFiredTick);
  });

  it('assigns a jobId when none is supplied', async () => {
    const created = await jsonFetch<Job>('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ cronExpr: '0 9 * * *' }),
    });
    expect(created.status).toBe(201);
    expect(typeof created.body.jobId).toBe('string');
    expect(created.body.jobId.length).toBeGreaterThan(0);
  });

  it('rejects a create with no cronExpr (validation_error)', async () => {
    const res = await jsonFetch<{ error: string; message: string }>('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'no-cron' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    // The ROUTE's guard, not the service's cadence refusal (same code).
    expect(res.body.message).toBe('Field `cronExpr` is required and MUST be a non-empty string.');
  });

  it('rejects a schedule beyond maxFutureHorizon with schedule_horizon_exceeded', async () => {
    const res = await jsonFetch<{ error: string; details: { maxFutureHorizon: string } }>('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({
        jobId: 'far',
        cronExpr: '* * * * *',
        firstFireAtMs: Date.now() + MAX_FUTURE_HORIZON_MS + 60_000,
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('schedule_horizon_exceeded');
    // The route's own mapping: the advertised horizon (366 days), as a literal.
    expect(res.body.details.maxFutureHorizon).toBe('P366D');
  });

  it('a trigger fires once and reports the consumed tick (§B.2 seam)', async () => {
    await jsonFetch('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-t', cronExpr: '* * * * *' }),
    });
    const fired = await jsonFetch<{ runsFired: number; lastFiredTick: number }>(
      '/host/openwop-app/scheduler/jobs/job-t/trigger',
      { method: 'POST', body: '{}' },
    );
    expect(fired.status).toBe(200);
    expect(fired.body.runsFired).toBe(1);
    expect(fired.body.lastFiredTick).toBeGreaterThan(0);
    // The reported tick is the one the trigger consumed (the clock's current tick).
    expect(fired.body.lastFiredTick).toBe(currentTick());
  });

  it('404s a trigger for an unknown job', async () => {
    const res = await jsonFetch<{ error: string }>(
      '/host/openwop-app/scheduler/jobs/nope/trigger',
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('deletes a job; a second delete 404s', async () => {
    await jsonFetch('/host/openwop-app/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-d', cronExpr: '* * * * *' }),
    });
    const first = await jsonFetch<{ removed: boolean }>(
      '/host/openwop-app/scheduler/jobs/job-d',
      { method: 'DELETE' },
    );
    expect(first.status).toBe(200);
    expect(first.body.removed).toBe(true);

    const second = await jsonFetch<{ error: string }>(
      '/host/openwop-app/scheduler/jobs/job-d',
      { method: 'DELETE' },
    );
    expect(second.status).toBe(404);
    expect(second.body.error).toBe('not_found');
  });
});
