/**
 * ADR 0837 D5 — territory visibility reaches the records that hang off a deal
 * (`CRM-7`, open since 2026-09-02). ADR 0272 filtered deals and companies and gated
 * the writes that LINK to them, but every task and activity read — list, single
 * get, CSV export, and a `PATCH {}` that echoes the row — returned rows on deals
 * the rep cannot open. Each leg below was RED on `origin/main` (869ac06bf).
 *
 * Sabotage-witnessed per exit (w4 grade-tests): unfiltering the task list, the
 * activity list, either CSV, or the run surface's `listTasks`, or dropping the
 * visibility assert on task GET / PATCH / DELETE / surface `completeTask`, each
 * reds this case at its own leg. One case on purpose — the scenario (two
 * territories, review-gated model activation) is the expensive part.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { transitionModelViaReview } from './territoryReview.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'territories']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: unknown; text: string }
/** Narrow a JSON body at its read site (no `any`). */
const bodyAs = <T>(r: Res): T => r.body as T;
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}

let n = 0;
const terr = (orgId: string): string => `/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;
const crm = (orgId: string): string => `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;

async function scenario() {
  const tenantId = `org:a0837t-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const rep = client();
  const repId = bodyAs<{ user: { userId: string } }>(await rep.post('/host/openwop-app/test/login', { email: `r-${Date.now()}-${n++}@acme.test`, tenantId })).user.userId;
  const orgId = bodyAs<{ orgId: string }>(await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).orgId;
  await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Rep', subject: repId, roles: ['editor'] });
  type Pipeline = { pipelineId: string; stages: Array<{ stageId: string; probability: number }> };
  const pipe = bodyAs<{ pipelines: Pipeline[] }>(await owner.get(`${crm(orgId)}/pipelines`)).pipelines[0]!;
  const stageId = pipe.stages.find((s) => s.probability === 30)!.stageId;
  const modelId = bodyAs<{ modelId: string }>(await owner.post(`${terr(orgId)}/models`, { name: 'M' })).modelId;
  const west = bodyAs<{ territoryId: string }>(await owner.post(`${terr(orgId)}/models/${modelId}/territories`, { name: 'West', memberSubjectIds: [repId] }));
  const east = bodyAs<{ territoryId: string }>(await owner.post(`${terr(orgId)}/models/${modelId}/territories`, { name: 'East' }));
  await owner.post(`${terr(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: east.territoryId, priority: 20, filter: { field: 'amount', op: 'gt', value: 7000 } });
  await owner.post(`${terr(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, priority: 10, filter: { field: 'amount', op: 'lte', value: 7000 } });
  const mk = async (title: string, amount: number) => bodyAs<{ dealId: string }>(await owner.post(`${crm(orgId)}/deals`, { title, amount, pipelineId: pipe.pipelineId, stageId })).dealId;
  const westDeal = await mk('W', 1000);
  const eastDeal = await mk('E', 9000);
  await transitionModelViaReview(owner, terr(orgId), modelId);
  const westTask = bodyAs<{ taskId: string }>(await owner.post(`${crm(orgId)}/tasks`, { title: 'west-task-title', dealId: westDeal })).taskId;
  const eastTask = bodyAs<{ taskId: string }>(await owner.post(`${crm(orgId)}/tasks`, { title: 'east-task-title', dealId: eastDeal })).taskId;
  expect((await owner.post(`${crm(orgId)}/activities`, { kind: 'note', body: 'east-activity-body', dealId: eastDeal })).status).toBe(201);
  expect((await owner.post(`${crm(orgId)}/activities`, { kind: 'note', body: 'west-activity-body', dealId: westDeal })).status).toBe(201);
  return { owner, rep, repId, tenantId, orgId, westTask, eastTask, eastDeal };
}

describe('ADR 0837 D5 — tasks and activities on a hidden deal are hidden too', () => {
  it('list, get, patch, delete, export and the run surface all agree', async () => {
    const s = await scenario();
    const repTasks = bodyAs<{ tasks: Array<{ title: string }> }>(await s.rep.get(`${crm(s.orgId)}/tasks`)).tasks.map((t) => t.title);
    expect(repTasks).toEqual(['west-task-title']); // RED on origin/main: both
    expect(bodyAs<{ tasks: unknown[] }>(await s.owner.get(`${crm(s.orgId)}/tasks`)).tasks).toHaveLength(2); // view-all still sees both

    expect((await s.rep.get(`${crm(s.orgId)}/tasks/${s.eastTask}`)).status).toBe(404);
    expect((await s.rep.get(`${crm(s.orgId)}/tasks/${s.westTask}`)).status).toBe(200);
    const patch = await s.rep.patch(`${crm(s.orgId)}/tasks/${s.eastTask}`, {});
    expect(patch.status).toBe(404);
    expect(patch.text).not.toContain('east-task-title');
    expect((await s.rep.del(`${crm(s.orgId)}/tasks/${s.eastTask}`)).status).toBe(404);
    expect((await s.owner.get(`${crm(s.orgId)}/tasks/${s.eastTask}`)).status).toBe(200); // the 404 deleted nothing

    const acts = await s.rep.get(`${crm(s.orgId)}/activities`);
    expect(acts.text).toContain('west-activity-body');
    expect(acts.text).not.toContain('east-activity-body');
    expect(bodyAs<{ activities: unknown[] }>(await s.rep.get(`${crm(s.orgId)}/activities?dealId=${s.eastDeal}`)).activities).toEqual([]);

    const taskCsv = await s.rep.get(`${crm(s.orgId)}/export?entityType=tasks`);
    expect(taskCsv.status).toBe(200);
    expect(taskCsv.text).toContain('west-task-title');
    expect(taskCsv.text).not.toContain('east-task-title');
    expect((await s.rep.get(`${crm(s.orgId)}/export?entityType=activities`)).text).not.toContain('east-activity-body');

    const surface = buildFeatureSurfaces({ tenantId: s.tenantId, runId: 'r-rep', actingUserId: s.repId }).crm!;
    const viaRun = (await surface.listTasks!({ orgId: s.orgId })) as { tasks: Array<{ title: string }> };
    expect(viaRun.tasks.map((t) => t.title)).toEqual(['west-task-title']);
    await expect(surface.completeTask!({ orgId: s.orgId, taskId: s.eastTask })).rejects.toMatchObject({ code: 'not_found' });
  });
});
