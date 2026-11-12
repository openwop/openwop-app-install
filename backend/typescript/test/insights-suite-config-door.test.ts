/**
 * ADR 1102 D4 / D5 / D6 — the config door: who the suite runs as, and what a save
 * leaves behind.
 *
 * `PUT /config` used to take `principalUserId` from the body, so any workspace writer
 * could make the weekly run owned by, and attributed to, anyone (`INS91-4`). The ids it
 * armed embedded that principal, so a save by a second person armed theirs and left the
 * first person's job firing weekly, invisible to `GET /config` (`INS91-5`). It also
 * stored `planSource` verbatim and kept only the first of a list of business units
 * (`INS91-10`, `-11`), and it armed an anniversary trigger that could never run (`-6`).
 *
 * Runs in demo mode so the dev token is a workspace writer with the toggle on. The dev
 * token's key principal is therefore THE caller in every case; "another person" is
 * planted directly through `applyConfig`, the only way a second identity exists here.
 *
 * Red when: a body principal naming someone else is accepted; a save by a non-principal
 * goes through without `takeOver`; a take-over leaves the previous principal's job; a
 * stray `insights-weekly:<tenant>:*` job survives a save; any closed-world refusal below
 * is relaxed; the generic scheduler can mint under the reserved prefix.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __clearToggleStore, getEffectiveConfig, saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetInsightsSuiteStore, applyConfig, getConfig } from '../src/features/insights-suite/insightsSuiteService.js';
import { configPrincipalSpellings } from '../src/features/insights-suite/routes.js';
import { getJob, listJobs, registerJob, resetScheduling, setJobEnabled } from '../src/host/schedulingService.js';
import type { Request } from 'express';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;
const URL_ = () => `${BASE}/host/openwop-app/insights-suite/config`;
const WEEKLY = 'insights-weekly:default:';
const ARMED = { scheduleCron: '0 6 * * 2', planSource: { projectId: 'acme-analytics' } };

type ErrBody = { error?: string; message?: string; details?: { reason?: string; field?: string; principalUserId?: string; managedBy?: string } };
const put = (body: unknown) => fetch(URL_(), { method: 'PUT', headers: H, body: JSON.stringify(body) });
const weeklyJobs = async () => (await listJobs('default')).filter((j) => j.jobId.startsWith(WEEKLY));

/** The caller's own principal, as the door derives it. */
let me = '';

beforeAll(async () => {
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_DEMO_MODE = 'true';
  initHostExtPersistence(await openStorage('memory://'));
  await __clearToggleStore();
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const base = (await getEffectiveConfig('insights-suite')) ?? getToggleDefault('insights-suite');
  if (base) await saveConfig({ ...base, status: 'beta' }, 'config-door-test');
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await __resetInsightsSuiteStore();
  const res = await put({});
  me = ((await res.json()) as { config: { principalUserId: string } }).config.principalUserId;
  expect(me, 'the door must derive a principal from the caller').toBeTruthy();
});
afterAll(async () => {
  delete process.env.OPENWOP_DEMO_MODE;
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => {
  await __resetInsightsSuiteStore();
  await resetScheduling();
});

describe('D4 — the suite runs as the person who saves it', () => {
  it('refuses a body principal that names someone else, and writes nothing', async () => {
    const res = await put({ principalUserId: 'u-ceo', ...ARMED });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrBody).details?.reason).toBe('forbidden_principal');
    expect(await getConfig('default')).toBeNull();
    expect(await weeklyJobs()).toEqual([]);
  });

  it('accepts its own GET back as a PUT (the echo keys are ignored, the principal is checked)', async () => {
    expect((await put(ARMED)).status).toBe(200);
    const got = ((await (await fetch(URL_(), { headers: H })).json()) as { config: Record<string, unknown> }).config;
    const res = await put({ ...got, scheduleCron: '0 7 * * 2' });
    expect(res.status).toBe(200);
    const [job] = await weeklyJobs();
    expect(job?.cronExpr).toBe('0 7 * * 2');
    expect(job?.ownerUserId).toBe(me);
    expect(job?.metadata?.actingUserId, 'the run must act as its principal, not merely name them').toBe(me);
  });

  it('a save over someone else\'s suite is a 409 naming them, until takeOver: true', async () => {
    await applyConfig({ tenantId: 'default', principalUserId: 'u-other', businessUnit: 'TX', ...ARMED, updatedAt: '2026-11-01T00:00:00.000Z' });
    expect((await weeklyJobs()).map((j) => j.jobId)).toEqual([`${WEEKLY}u-other`]);

    // The panel is told, with the PUT's own predicates, that this suite is not the caller's.
    const view = (await (await fetch(URL_(), { headers: H })).json()) as { runsAsYou: boolean | null; canWrite: boolean };
    expect(view).toMatchObject({ runsAsYou: false, canWrite: true });

    const refused = await put(ARMED);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as ErrBody;
    expect(body.details).toMatchObject({ reason: 'principal_conflict', principalUserId: 'u-other' });
    expect((await getConfig('default'))?.principalUserId, 'a refused take-over must not move the suite').toBe('u-other');

    const taken = await put({ ...ARMED, takeOver: true });
    expect(taken.status).toBe(200);
    // INS91-5 — exactly one job, the new principal's. The previous person's no longer fires.
    expect((await weeklyJobs()).map((j) => j.jobId), 'the previous principal\'s job was orphaned').toEqual([`${WEEKLY}${me}`]);
    expect((await getConfig('default'))?.principalUserId).toBe(me);
    const after = (await (await fetch(URL_(), { headers: H })).json()) as { runsAsYou: boolean | null; scheduleArmed: boolean };
    expect(after).toMatchObject({ runsAsYou: true, scheduleArmed: true });
  });

  it('echoing the current principal WITHOUT takeOver is still the 409, and moves nothing', async () => {
    await applyConfig({ tenantId: 'default', principalUserId: 'u-other', ...ARMED, updatedAt: '2026-11-01T00:00:00.000Z' });
    const res = await put({ principalUserId: 'u-other', ...ARMED });
    expect(res.status, 'the echo exemption skipped the take-over guard').toBe(409);
    expect((await getConfig('default'))?.principalUserId).toBe('u-other');
    expect((await weeklyJobs()).map((j) => j.jobId)).toEqual([`${WEEKLY}u-other`]);
  });

  it('a GET → PUT round trip with takeOver is accepted: the echoed principal is not a claim', async () => {
    await applyConfig({ tenantId: 'default', principalUserId: 'u-other', ...ARMED, updatedAt: '2026-11-01T00:00:00.000Z' });
    const got = ((await (await fetch(URL_(), { headers: H })).json()) as { config: Record<string, unknown> }).config;
    expect(got.principalUserId).toBe('u-other');
    const res = await put({ ...got, takeOver: true });
    expect(res.status, 'the echo of the current principal was refused as forbidden_principal').toBe(200);
    expect((await getConfig('default'))?.principalUserId).toBe(me);
  });
});

describe('D4 — whose spellings count, by tenant (the round-1 code re-grade)', () => {
  // A bound session presents `user:`/raw ids AND an IdP principal. The raw IdP
  // principal is the caller's own only in their PERSONAL tenant; in a shared
  // workspace two people from different IdPs can share a raw `sub`.
  const req = { userId: 'u-1', personalTenant: 'p-home', tenantId: 'ws-shared', principal: { principalId: 'oidc:abc', tenants: ['ws-shared'], token: '', auth: { kind: 'subject' } } } as unknown as Request;

  it('in a shared workspace, the raw IdP principal is NOT the caller', async () => {
    const shared = await configPrincipalSpellings(req, 'ws-shared');
    expect(shared).toContain('u-1');
    expect(shared, 'a stranger sharing a raw sub would skip the 409').not.toContain('oidc:abc');
  });

  it('in the caller\'s personal tenant, it is', async () => {
    expect(await configPrincipalSpellings(req, 'p-home')).toEqual(expect.arrayContaining(['u-1', 'oidc:abc']));
  });
});

describe('D5 — a save leaves exactly the intended rows', () => {
  it('a failed write after arming puts the job back (no job the row does not describe)', async () => {
    // A take-over whose row write fails: the new principal's job must not survive
    // beside the old one (the round-2 code re-grade).
    await applyConfig({ tenantId: 'default', principalUserId: 'u-other', ...ARMED, updatedAt: '2026-11-01T00:00:00.000Z' });
    const before = (await weeklyJobs()).map((j) => j.jobId);
    const real = DurableCollection.prototype.put;
    const spy = vi.spyOn(DurableCollection.prototype, 'put').mockImplementation(async function (this: DurableCollection<unknown>, item: unknown) {
      if ((this as unknown as { name: string }).name === 'insights:config') throw new Error('injected write failure');
      return real.call(this, item);
    });
    try {
      const res = await put({ ...ARMED, scheduleCron: '0 9 * * 3', takeOver: true });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await weeklyJobs()).map((j) => j.jobId), 'a second weekly job nobody can see').toEqual(before);
    expect((await getConfig('default'))?.principalUserId).toBe('u-other');
  });

  it('GET says a saved schedule that was paused elsewhere is not armed', async () => {
    expect((await put(ARMED)).status).toBe(200);
    await setJobEnabled(`${WEEKLY}${me}`, false);
    expect((await getJob(`${WEEKLY}${me}`))?.enabled).toBe(false);
    const view = (await (await fetch(URL_(), { headers: H })).json()) as { scheduleArmed: boolean };
    expect(view.scheduleArmed).toBe(false);
  });

  it('removes a stray insights-weekly job for this tenant, whatever its principal', async () => {
    await registerJob({ jobId: `${WEEKLY}u-stray`, tenantId: 'default', cronExpr: '0 5 * * 1', featureId: 'insights-suite', enabled: true });
    expect((await put({})).status).toBe(200);
    expect(await weeklyJobs(), 'a stray weekly job survived a save').toEqual([]);
  });

  it('does not touch another tenant\'s job under the same prefix', async () => {
    await registerJob({ jobId: 'insights-weekly:t-other:u-x', tenantId: 't-other', cronExpr: '0 5 * * 1', featureId: 'insights-suite', enabled: true });
    expect((await put({})).status).toBe(200);
    expect((await listJobs('t-other')).map((j) => j.jobId)).toEqual(['insights-weekly:t-other:u-x']);
  });

  it.each([
    ['an unknown key', { cadence: 'weekly' }, 'cadence'],
    ['two business units', { businessUnits: ['TX', 'CA'] }, 'businessUnits'],
    ['both spellings of the business unit', { businessUnit: 'TX', businessUnits: ['TX'] }, 'businessUnits'],
    ['an object projectId', { scheduleCron: '0 6 * * 2', planSource: { projectId: { evil: true } } }, 'planSource.projectId'],
    ['an unknown planSource key', { planSource: { projectId: 'acme-analytics', table: 'x' } }, 'planSource.table'],
    ['a projectId that is not a project id', { planSource: { projectId: 'Not A Project!' } }, 'planSource.projectId'],
    ['an over-long business unit', { businessUnit: 'x'.repeat(121) }, 'businessUnit'],
    ['a dataset (stored and read by nothing)', { planSource: { projectId: 'acme-analytics', dataset: 'finance' } }, 'planSource.dataset'],
    ['a cron that parses but never fires', { scheduleCron: '0 0 31 2 *', planSource: { projectId: 'acme-analytics' } }, 'scheduleCron'],
  ])('refuses %s with a field-named, reasoned 400, and writes nothing', async (_label, body, field) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    const details = ((await res.json()) as ErrBody).details;
    expect(details?.field).toBe(field);
    // Every refusal names a closed reason the settings panel localizes.
    expect(details?.reason, 'a field refusal with no reason reaches the panel as developer English').toMatch(/^[a-z_]+$/);
    expect(await getConfig('default')).toBeNull();
    expect(await weeklyJobs()).toEqual([]);
  });

  it('stores ONE business unit, and a legacy one-entry list becomes it', async () => {
    expect((await put({ ...ARMED, businessUnits: ['TX'] })).status).toBe(200);
    const stored = await getConfig('default');
    expect(stored?.businessUnit).toBe('TX');
    expect(stored).not.toHaveProperty('businessUnits');
    expect((await weeklyJobs())[0]?.inputs).toEqual({ projectId: 'acme-analytics', businessUnit: 'TX' });
  });
});

describe('D6 — the anniversary trigger is refused at the door', () => {
  it('a 400 naming why, and nothing written', async () => {
    const res = await put({ anniversaryTriggerEnabled: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrBody).details).toMatchObject({ field: 'anniversaryTriggerEnabled', reason: 'trigger_lane_unrunnable' });
    expect(await getConfig('default')).toBeNull();
  });
});

describe('D4 (architect H5) — the generic scheduler cannot mint under the reserved prefix', () => {
  it('POST /scheduler/jobs with an insights-weekly id is a 409 naming the feature', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/scheduler/jobs`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ jobId: `${WEEKLY}${me}`, cronExpr: '0 6 * * 2', workflowId: 'openwop-app.insights.weekly-variance' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrBody).details?.managedBy).toBe('insights-suite');
    expect(await weeklyJobs()).toEqual([]);
  });
});
