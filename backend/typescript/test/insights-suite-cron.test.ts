/**
 * ADR 0081 Phase 6 — cron validation at PUT /config.
 *
 * A malformed `scheduleCron` previously persisted a silently never-firing job (ADR 0078
 * P2 review LOW). The route now validates the cron at the HTTP boundary with the
 * scheduler's single parser (host/cronSchedule#parseCron) and 400s a bad expression.
 *
 * Runs in demo mode so the dev-token principal resolves to the tenant owner
 * (workspace:write) and the toggle is enabled — letting the request reach the cron guard.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __clearToggleStore, getEffectiveConfig, saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetInsightsSuiteStore, getConfig } from '../src/features/insights-suite/insightsSuiteService.js';
import { listJobs, registerJob } from '../src/host/schedulingService.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_DEMO_MODE = 'true'; // dev principal → tenant owner (workspace:write)
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearToggleStore();
  await __resetInsightsSuiteStore();
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // Enable the toggle so requireFeatureEnabled passes (mirrors the demo seeder).
  const base = (await getEffectiveConfig('insights-suite')) ?? getToggleDefault('insights-suite');
  if (base) await saveConfig({ ...base, status: 'beta' }, 'cron-test');
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_DEMO_MODE;
  await new Promise<void>((res) => server.close(() => res()));
});

const putConfig = (bodyObj: Record<string, unknown>) =>
  fetch(`${BASE}/v1/host/openwop-app/insights-suite/config`, { method: 'PUT', headers: H, body: JSON.stringify(bodyObj) });

describe('ADR 0081 §6 — cron validation at PUT /config', () => {
  it('rejects a malformed cron with 400 invalid_request', async () => {
    const res = await putConfig({ principalUserId: 'u-ceo', scheduleCron: 'not a cron' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('invalid_request');
  });

  it('rejects an out-of-range cron field with 400', async () => {
    const res = await putConfig({ principalUserId: 'u-ceo', scheduleCron: '99 * * * *' });
    expect(res.status).toBe(400);
  });

  it('accepts a valid cron with 200 and persists it', async () => {
    const res = await putConfig({ principalUserId: 'u-ceo', businessUnits: ['TX'], scheduleCron: '0 6 * * 2', scheduleTimezone: 'America/Chicago', planSource: { projectId: 'acme-analytics' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { config?: { scheduleCron?: string } };
    expect(body.config?.scheduleCron).toBe('0 6 * * 2');
  });

  it('accepts an absent cron (schedule simply not configured) with 200', async () => {
    const res = await putConfig({ principalUserId: 'u-ceo', businessUnits: ['TX'] });
    expect(res.status).toBe(200);
  });
});

/**
 * ADR 0599 §6 — VALIDATE EVERY FIELD BEFORE ANY WRITE.
 *
 * The cron guard above existed precisely so a bad cadence could not persist a
 * silently never-firing job. The very next field, feeding the very same parser,
 * had no guard at all — and its failure mode was strictly worse: `applyConfig`
 * persists FIRST, then `registerJob → computeNextFire → Intl.DateTimeFormat`
 * throws an uncaught `RangeError` on an invalid zone. The caller got a 500 they
 * read as a server fault, `GET /config` then reported a cron and a timezone as
 * if configured, and `listJobs` held nothing. A refusal that persists is worse
 * than the bug it replaced.
 *
 * Note the ordering that makes it bite and that this suite therefore pins: an
 * invalid cron short-circuits to `null` and never reaches the throw, so it is a
 * VALID cron with a typo'd zone that is the live case.
 */
describe('ADR 0599 §6 — every field is validated BEFORE the row is written', () => {
  it('rejects an invalid IANA timezone with 400 and writes NOTHING', async () => {
    const before = await getConfig('default');
    // One transposed letter — a valid cron with an invalid zone, the live case.
    const res = await putConfig({ principalUserId: 'u-tz', businessUnits: ['TX'], scheduleCron: '0 6 * * 2', scheduleTimezone: 'America/Chicgo', planSource: { projectId: 'p' } });
    expect(res.status, 'an invalid timezone must be a 400 refusal, not a 500 after the write').toBe(400);
    expect((await res.json() as { error?: string }).error).toBe('invalid_request');
    // The refusal did not persist: the stored row is untouched.
    expect(await getConfig('default')).toEqual(before);
    expect((await listJobs()).some((j) => j.ownerUserId === 'u-tz')).toBe(false);
  });

  it('refuses to ARM a schedule with no planSource.projectId — every fire would die at node 1', async () => {
    const res = await putConfig({ principalUserId: 'u-nosource', businessUnits: ['TX'], scheduleCron: '0 6 * * 2' });
    expect(res.status).toBe(400);
    expect((await listJobs()).some((j) => j.ownerUserId === 'u-nosource')).toBe(false);
  });

  /**
   * ADR 0599 §Correction 6 — the `ISC-7` refusal branch, made MEASURABLE and then
   * moved ahead of the write.
   *
   * `registerJob` fails by value for two codes. `schedule_horizon_exceeded` needs
   * `firstFireAtMs`, which `applyConfig` never passes — genuinely unreachable.
   * `jobid_conflict` was believed impossible too "because `weeklyScheduleJobId`
   * embeds the tenantId", and that reasoning is WRONG: the public scheduler route
   * (`routes/scheduler.ts`) takes `body.jobId` VERBATIM and registers it under the
   * CALLER's tenant, so any authenticated tenant can squat another tenant's
   * deterministic insights job id. The victim's every config save then 400s.
   *
   * Which made the ordering bite for real, and in the direction this very PR fixed
   * one function-call away (`ISC-6`): the refusal was thrown AFTER `configs.put`,
   * so the victim got a 400 while their row landed and `GET /config` advertised a
   * cron that was not armed and could not be armed.
   */
  it('a squatted job id is refused BEFORE the write, not 400d after it', async () => {
    const before = await getConfig('default');
    // Another tenant squats this tenant's deterministic weekly-variance job id —
    // reachable today through `POST /scheduler/jobs` with an explicit `jobId`.
    const squatted = await registerJob({
      jobId: 'insights-weekly:default:u-squat',
      tenantId: 't-attacker',
      cronExpr: '0 6 * * 3',
    });
    expect(squatted.ok, 'the squat itself must succeed — otherwise this probe proves nothing').toBe(true);

    const res = await putConfig({ principalUserId: 'u-squat', businessUnits: ['TX'], scheduleCron: '0 6 * * 2', planSource: { projectId: 'p' } });
    expect(res.status, 'an unarmable schedule must be a 400 refusal').toBe(400);
    expect((await res.json() as { error?: string }).error).toBe('invalid_request');
    // The refusal did not persist — the same guarantee `ISC-6` established one
    // field over. Without the pre-flight this assertion is the one that fails:
    // the row lands and only THEN does the 400 come back.
    expect(await getConfig('default'), 'a refused save must not leave a config row claiming a cron').toEqual(before);
    // And it did not clobber the other tenant's row on the way out.
    expect((await listJobs()).find((j) => j.jobId === 'insights-weekly:default:u-squat')?.tenantId).toBe('t-attacker');
  });

  it('an armed schedule carries featureId + the inputs the chain needs', async () => {
    const res = await putConfig({ principalUserId: 'u-armed', businessUnits: ['TX'], scheduleCron: '0 6 * * 2', scheduleTimezone: 'America/Chicago', planSource: { projectId: 'acme-analytics' } });
    expect(res.status).toBe(200);
    const job = (await listJobs()).find((j) => j.ownerUserId === 'u-armed');
    expect(job?.featureId).toBe('insights-suite');
    expect(job?.inputs).toEqual({ projectId: 'acme-analytics', businessUnit: 'TX' });
  });
});
