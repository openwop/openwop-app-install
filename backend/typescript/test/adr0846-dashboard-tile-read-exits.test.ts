/**
 * ADR 0846 — a dashboard tile may never show more than its source's own primary
 * read would show the same viewer. Each leg drives the EXIT the tile calls (the
 * route, plus the run surface that shares it), never the tile. Every leg was RED
 * on `origin/main` (f8a3ea22e).
 *
 * The CRM half reuses the ADR 0837 territory scenario: the rep is a member of
 * West only, so West's $1000 deal is visible and East's $9000 deal is not.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { upsertCrmSnapshot, crmSnapshotId } from '../src/features/crm/entities/snapshots.js';
import { transitionModelViaReview } from './territoryReview.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const reg = getAgentRegistry();
  reg.register({ agentId: 'a0846.agent', persona: 'Briefing Agent', modelClass: 'general' } as Parameters<ReturnType<typeof getAgentRegistry>['register']>[0]);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'territories', 'bi', 'scheduled-agent-chats', 'channels']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T; text: string }
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
type Client = ReturnType<typeof client>;

let n = 0;
const terr = (orgId: string): string => `/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;
const crm = (orgId: string): string => `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;
const bi = (orgId: string): string => `/host/openwop-app/bi/orgs/${encodeURIComponent(orgId)}`;
const sched = (orgId: string, suffix = ''): string => `/host/openwop-app/scheduled-chats/orgs/${encodeURIComponent(orgId)}/chats${suffix}`;
const SCHED_JOBS = '/host/openwop-app/scheduler/jobs';

async function members(): Promise<{ owner: Client; rep: Client; repId: string; ownerId: string; tenantId: string; orgId: string }> {
  const tenantId = `org:a0846-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const rep = client();
  const repId = (await rep.post('/host/openwop-app/test/login', { email: `r-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId as string;
  expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Rep', subject: repId, roles: ['editor'] })).status).toBeLessThan(300);
  return { owner, rep, repId, ownerId, tenantId, orgId };
}

async function territoryScenario() {
  const m = await members();
  const { owner, orgId } = m;
  const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
  const stage30 = pipe.stages.find((s: any) => s.probability === 30).stageId as string;
  const otherStage = pipe.stages.find((s: any) => s.stageId !== stage30 && s.probability > 0 && s.probability < 100).stageId as string;
  const modelId = (await owner.post(`${terr(orgId)}/models`, { name: 'M' })).body.modelId as string;
  const west = (await owner.post(`${terr(orgId)}/models/${modelId}/territories`, { name: 'West', memberSubjectIds: [m.repId] })).body;
  const east = (await owner.post(`${terr(orgId)}/models/${modelId}/territories`, { name: 'East' })).body;
  await owner.post(`${terr(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: east.territoryId, priority: 20, filter: { field: 'amount', op: 'gt', value: 7000 } });
  await owner.post(`${terr(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, priority: 10, filter: { field: 'amount', op: 'lte', value: 7000 } });
  const mk = async (title: string, amount: number) => (await owner.post(`${crm(orgId)}/deals`, { title, amount, pipelineId: pipe.pipelineId, stageId: stage30 })).body.dealId as string;
  await mk('West deal', 1000);
  const eastDeal = await mk('East deal', 9000);
  // A stage move on the HIDDEN deal — the only row `conversions` could count.
  expect((await owner.patch(`${crm(orgId)}/deals/${eastDeal}`, { stageId: otherStage })).status).toBe(200);
  await transitionModelViaReview(owner, terr(orgId), modelId);
  // An org-wide weekly snapshot, as the viewer-less snapshot daemon writes it.
  await upsertCrmSnapshot({
    snapshotId: crmSnapshotId(m.tenantId, orgId, pipe.pipelineId, '2026-W40'), tenantId: m.tenantId, orgId, pipelineId: pipe.pipelineId,
    isoWeek: '2026-W40', at: '2026-10-01T00:00:00.000Z', perStage: [{ stageId: stage30, name: 'Qualified', count: 2, sum: 10000, weightedSum: 3000 }],
  });
  return { ...m, pipelineId: pipe.pipelineId };
}

const total = (r: Res): number => (r.body.result.points as Array<{ value: number }>).reduce((a, p) => a + p.value, 0);

describe('ADR 0846 D2/D3 — BI metrics honour CRM record visibility', () => {
  it('the route: a territory-scoped rep sums only the deals they can see; the owner sums all', async () => {
    const s = await territoryScenario();
    const repRun = await s.rep.post(`${bi(s.orgId)}/metrics/sys-pipeline-value/run`, {});
    expect(repRun.status, repRun.text).toBe(200);
    expect(total(repRun)).toBe(1000); // RED on main: 10000
    expect(total(await s.owner.post(`${bi(s.orgId)}/metrics/sys-pipeline-value/run`, {}))).toBe(10000);
    const count = await s.rep.post(`${bi(s.orgId)}/metrics/sys-deal-count/run`, {});
    expect(total(count)).toBe(1);
    // grade-code H1 — the row count is the caller's too, not the tenant's.
    expect(repRun.body.result.totalRows).toBe(1);
  });

  it('the run surface: viewer is the run actor; a foreign or empty org is refused', async () => {
    const s = await territoryScenario();
    const surface = buildFeatureSurfaces({ tenantId: s.tenantId, runId: 'r-0846', actingUserId: s.repId }).bi!;
    const viaRun = (await surface.runMetric!({ metricId: 'sys-pipeline-value', orgId: s.orgId })) as { result: { points: Array<{ value: number }> } };
    expect(viaRun.result.points.reduce((a, p) => a + p.value, 0)).toBe(1000);
    await expect(surface.runMetric!({ metricId: 'sys-pipeline-value', orgId: '' })).rejects.toMatchObject({ code: 'validation_error' });
    const other = await members(); // a different tenant's org, unknown here
    await expect(surface.runMetric!({ metricId: 'sys-pipeline-value', orgId: other.orgId })).rejects.toMatchObject({ code: expect.stringMatching(/not_found|forbidden/) });
    // grade-code M1 — a run CAUSED by the rep but acting for nobody reads as the rep.
    const caused = buildFeatureSurfaces({ tenantId: s.tenantId, runId: 'r-0846c', orgScopeSubject: s.repId }).bi!;
    const viaCause = (await caused.runMetric!({ metricId: 'sys-pipeline-value', orgId: s.orgId })) as { result: { points: Array<{ value: number }> } };
    expect(viaCause.result.points.reduce((a, p) => a + p.value, 0)).toBe(1000);
  });
});

describe('ADR 0846 D4 — the pipeline report withholds org-wide history from a scoped viewer', () => {
  it('scoped rep: no snapshots (flagged), conversions only over visible deals; owner unchanged', async () => {
    const s = await territoryScenario();
    const rep = await s.rep.get(`${crm(s.orgId)}/reports/pipeline`);
    expect(rep.status, rep.text).toBe(200);
    expect(rep.body.snapshots).toEqual([]); // RED on main: the org-wide row
    expect(rep.body.snapshotsWithheld).toBe(true);
    expect(rep.body.conversions).toEqual([]); // the only move was on the East deal
    const own = await s.owner.get(`${crm(s.orgId)}/reports/pipeline`);
    expect(own.body.snapshots).toHaveLength(1);
    expect(own.body.snapshotsWithheld).toBeUndefined();
    expect(own.body.conversions.reduce((a: number, c: any) => a + c.count, 0)).toBe(1);
  });
});

describe('ADR 0846 D1 — a scheduled chat is managed only by someone who can see its conversation', () => {
  it('list hides, and get/pause/delete 404, a schedule bound to a private conversation; the owner keeps it', async () => {
    const m = await members();
    // ADR 0879 D7 — an ORG schedule can no longer target a channel (channel posts are
    // scheduled from the channel's own owner-gated lane), so the private/visible pair is
    // now the owner's own conversation (hidden from the rep) and a DM WITH the rep.
    const priv = (await m.owner.post('/host/openwop-app/chat/sessions', { title: `a0846p-${n++}` })).body.sessionId as string;
    const pub = (await m.owner.post('/host/openwop-app/chat/conversations/open', { type: 'person', subjectRef: `user:${m.repId}` })).body.sessionId as string;
    expect(priv && pub).toBeTruthy();
    const hidden = await m.owner.post(sched(m.orgId), { agentId: 'a0846.agent', prompt: 'secret-standing-instruction', conversationId: priv, cronExpr: '0 9 * * *' });
    expect(hidden.status, hidden.text).toBe(201);
    const open = await m.owner.post(sched(m.orgId), { agentId: 'a0846.agent', prompt: 'public digest', conversationId: pub, cronExpr: '0 9 * * *' });
    expect(open.status, open.text).toBe(201);
    const chatId = hidden.body.chat.chatId as string;

    const list = await m.rep.get(sched(m.orgId));
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('secret-standing-instruction'); // RED on main
    expect(list.text).toContain('public digest');
    expect((await m.rep.get(sched(m.orgId, `/${chatId}`))).status).toBe(404);
    expect((await m.rep.post(sched(m.orgId, `/${chatId}/pause`), { enabled: false })).status).toBe(404);
    expect((await m.rep.del(sched(m.orgId, `/${chatId}`))).status).toBe(404);

    const ownerView = await m.owner.get(sched(m.orgId, `/${chatId}`));
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.chat.enabled).toBe(true); // the refused pause changed nothing
    expect((await m.owner.get(sched(m.orgId))).text).toContain('secret-standing-instruction');

    // grade-code B1 — the generic scheduler routes reach the same job. They must
    // refuse it the same way, or D1 is a door with a second door beside it.
    const jobId = `schedchat-${chatId}`;
    const jobs = await m.rep.get(SCHED_JOBS);
    expect(jobs.status).toBe(200);
    expect(jobs.text).not.toContain('secret-standing-instruction');
    expect(jobs.text).not.toContain(priv);
    expect((await m.rep.patch(`${SCHED_JOBS}/${jobId}`, { enabled: false })).status).toBe(404);
    expect((await m.rep.post(`${SCHED_JOBS}/${jobId}/trigger`, {})).status).toBe(404);
    expect((await m.rep.del(`${SCHED_JOBS}/${jobId}`)).status).toBe(404);
    expect((await m.owner.get(SCHED_JOBS)).text).toContain('secret-standing-instruction'); // CONTROL: the owner still sees it
    expect((await m.owner.get(sched(m.orgId, `/${chatId}`))).body.chat.enabled).toBe(true);
  });
});
