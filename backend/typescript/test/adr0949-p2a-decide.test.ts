/**
 * ADR 0949 P2a — Decide mode end to end through the HTTP boundary.
 *
 *   1. The routes are toggle-gated and org-scoped; another org's experiment is
 *      the same 404 as a missing one.
 *   2. A draft is closed-world (unknown fields refused); locking derives the
 *      sample size (Fleiss: 0.10 → 0.12 at α 0.05 / power 0.8 = 3,841) and the
 *      plan hash; after the lock every edit is 409 `plan_locked` (the P2 exit).
 *   3. Launch runs through the surface's own start (CMS: one running per page)
 *      and is idempotent; the CMS legacy routes refuse to start, edit or promote
 *      a managed experiment, and the CMS public read serves it.
 *   4. An SRM fixture halts (the P2 exit); a balanced effect past the gates is a
 *      winner; before `minDays` it is `running`, never a call.
 *   5. A legacy experiment has no Decide verdict (409 `legacy_experiment`).
 *   6. A funnel step experiment launches by writing the step pointer, is served
 *      by the public step read, and the legacy funnel stop refuses it.
 *   7. A legacy write path never strips the plan (the merge guard).
 *
 * Sabotage (run 2026-10-20): removing the plan_locked check reds 2; dropping the
 * SRM halt reds 4; dropping `assertNotManaged` from CMS start reds 3; making
 * `saveExperiment` rebuild the row reds 7.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __putRawEventForTests } from '../src/features/analytics/analyticsService.js';
import { getExperimentRow, putExperimentRow } from '../src/host/experiments/store.js';
import { decideVerdict } from '../src/host/experiments/decide.js';
import { experimentSurface } from '../src/host/experiments/adapters.js';
import { assignVariantForVisitor, createExperiment as createLegacy, findRunningExperiment, stopExperiment } from '../src/features/cms/pageExperimentsService.js';
import { createFunnel, publicFunnelStep, getFunnel, stopStepExperiment } from '../src/features/funnels/funnelsService.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';

let BASE: string;
let server: http.Server;
let n = 0;

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['experiments', 'analytics', 'funnels', 'cdp']) await setToggle(id, 'on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON boundary
interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m?.[1]) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}

const X = (orgId: string, suffix = ''): string => `/host/openwop-app/experiments/orgs/${encodeURIComponent(orgId)}${suffix}`;
const PLAN = { primaryMetric: { kind: 'conversion', name: 'signup' }, guardrails: [], baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8, fdrQ: 0.05, minDays: 7, maxDays: 30 };

async function setup() {
  const tenantId = `org:p2a-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `p2a-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Client A' })).body.orgId as string;
  const otherOrgId = (await owner.post('/host/openwop-app/orgs', { name: 'Client B' })).body.orgId as string;
  const page = await createPage({ tenantId, orgId, title: `LP ${n}`, createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
  return { tenantId, orgId, otherOrgId, owner, page };
}

const ARMS = [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: null, weight: 50 }];

async function lockedDraft(s: Awaited<ReturnType<typeof setup>>) {
  const created = await s.owner.post(X(s.orgId, '/experiments'), { name: 'Hero test', hypothesis: 'A shorter hero lifts signups', surface: { kind: 'cms.page', ref: s.page.pageId }, arms: ARMS });
  expect(created.status).toBe(201);
  const id = created.body.experiment.experimentId as string;
  expect((await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/lock`), { plan: PLAN })).status).toBe(200);
  return id;
}

function seedSessions(tenantId: string, orgId: string, experimentId: string, arm: string, sessions: number, conversions: number, ts: string): Promise<void[]> {
  const writes: Promise<void>[] = [];
  for (let i = 0; i < sessions; i++) {
    const sessionKey = `${experimentId}-${arm}-${i}`;
    const experiment = { id: experimentId, variant: arm, derived: true as const };
    writes.push(__putRawEventForTests({ eventId: `ev-${n++}`, tenantId, orgId, type: 'pageview', ts, sessionKey, experiment }));
    if (i < conversions) writes.push(__putRawEventForTests({ eventId: `ev-${n++}`, tenantId, orgId, type: 'conversion', ts, sessionKey, experiment }));
  }
  return Promise.all(writes);
}

describe('ADR 0949 P2a — 1/2. gates, closed-world drafts, plan lock', () => {
  it('is toggle-gated, org-scoped, and refuses unknown fields', async () => {
    const s = await setup();
    const id = await lockedDraft(s);
    expect((await s.owner.get(X(s.otherOrgId, `/experiments/${encodeURIComponent(id)}`))).status).toBe(404);
    expect((await s.owner.post(X(s.orgId, '/experiments'), { name: 'x', surface: { kind: 'cms.page', ref: s.page.pageId }, arms: ARMS, winner: 'b' })).status).toBe(400);
    const unsupported = await s.owner.post(X(s.orgId, '/experiments'), { name: 'x', surface: { kind: 'nope', ref: 'r' }, arms: ARMS });
    expect([unsupported.status, unsupported.body.details.reason]).toEqual([400, 'unsupported_surface']);
    await setToggle('experiments', 'off');
    try {
      expect((await s.owner.get(X(s.orgId, '/experiments'))).status).not.toBe(200);
    } finally { await setToggle('experiments', 'on'); }
  });

  it('locking derives the sample size and the hash; a locked plan refuses every edit (409)', async () => {
    const s = await setup();
    const id = await lockedDraft(s);
    const got = (await s.owner.get(X(s.orgId, `/experiments/${encodeURIComponent(id)}`))).body.experiment;
    expect(got.plan).toMatchObject({ minSamplePerArm: 3841, minDays: 7, planHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    for (const body of [{ name: 'renamed' }, { arms: [{ key: 'control', ref: null, weight: 30 }, { key: 'b', ref: null, weight: 70 }] }, { plan: { ...PLAN, mde: 0.05 } }]) {
      const res = await s.owner.patch(X(s.orgId, `/experiments/${encodeURIComponent(id)}`), body);
      expect(res.status).toBe(409);
      expect(res.body.details.reason).toBe('plan_locked');
    }
    expect((await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/lock`), { plan: PLAN })).status).toBe(409);
    // A guardrail is refused rather than ignored, and minDays is floored at 7.
    const draft = (await s.owner.post(X(s.orgId, '/experiments'), { name: 'G', surface: { kind: 'cms.page', ref: s.page.pageId }, arms: ARMS })).body.experiment.experimentId as string;
    const g = await s.owner.patch(X(s.orgId, `/experiments/${encodeURIComponent(draft)}`), { plan: { ...PLAN, guardrails: [{ metric: { kind: 'conversion', name: 'refund' }, direction: 'up_is_bad', niMargin: 0.01 }] } });
    expect(g.body.details.reason).toBe('unsupported_metric');
    const short = await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(draft)}/lock`), { plan: { ...PLAN, minDays: 2 } });
    expect(short.body.experiment.plan.minDays).toBe(7);
  });
});

describe('ADR 0949 P2a — 3/4/5. launch, CMS integration, verdicts', () => {
  it('launch is idempotent, goes through the CMS start, and the CMS legacy verbs refuse a managed experiment', async () => {
    const s = await setup();
    const id = await lockedDraft(s);
    const launched = await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/launch`));
    expect(launched.body.experiment).toMatchObject({ status: 'running', epochs: [{ epoch: 0, reason: 'launch', weights: { control: 50, b: 50 } }] });
    expect((await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/launch`))).body.experiment.epochs).toHaveLength(1);
    const served = await findRunningExperiment(s.tenantId, s.orgId, s.page.pageId);
    expect(served?.experimentId).toBe(id);
    expect(['control', 'b']).toContain(assignVariantForVisitor(served!, 'vk-1')?.key);
    const cms = `/host/openwop-app/cms/orgs/${encodeURIComponent(s.orgId)}/pages/${encodeURIComponent(s.page.pageId)}/experiments/${encodeURIComponent(id)}`;
    for (const [verb, path, body] of [['patch', cms, { name: 'x' }], ['post', `${cms}/stop`, undefined], ['post', `${cms}/promote`, { variantKey: 'b' }]] as const) {
      const r = verb === 'patch' ? await s.owner.patch(path, body) : await s.owner.post(path, body);
      expect(r.status).toBe(409);
      expect(r.body.details.reason).toBe('managed_by_experiments');
    }
    // One running per page holds across legacy and managed.
    const legacy = await createLegacy({ tenantId: s.tenantId, orgId: s.orgId, pageId: s.page.pageId, name: 'old', variants: [{ key: 'a', versionId: null, weight: 50 }, { key: 'b', versionId: null, weight: 50 }], createdBy: 'u' });
    const legacyStart = await s.owner.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(s.orgId)}/pages/${encodeURIComponent(s.page.pageId)}/experiments/${encodeURIComponent(legacy.experimentId)}/start`);
    expect(legacyStart.status).toBe(409);
  });

  it('an SRM fixture halts; past the gates a real effect is a winner; before minDays it is running', async () => {
    const s = await setup();
    const id = await lockedDraft(s);
    await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/launch`));
    const ts = new Date().toISOString();
    await seedSessions(s.tenantId, s.orgId, id, 'control', 300, 30, ts);
    await seedSessions(s.tenantId, s.orgId, id, 'b', 100, 10, ts);
    const halted = await s.owner.get(X(s.orgId, `/experiments/${encodeURIComponent(id)}/results`));
    expect(halted.status).toBe(200);
    expect(halted.body.verdict).toEqual({ kind: 'srm_halt' });
    expect(halted.body.srm.mismatch).toBe(true);
    expect(halted.body).not.toHaveProperty('significant');

    const s2 = await setup();
    const id2 = await lockedDraft(s2);
    await s2.owner.post(X(s2.orgId, `/experiments/${encodeURIComponent(id2)}/launch`));
    await seedSessions(s2.tenantId, s2.orgId, id2, 'control', 4000, 400, ts);
    await seedSessions(s2.tenantId, s2.orgId, id2, 'b', 4000, 560, ts);
    const early = await s2.owner.get(X(s2.orgId, `/experiments/${encodeURIComponent(id2)}/results`));
    expect(early.body.verdict).toEqual({ kind: 'running' });
    expect(early.body.gates).toMatchObject({ met: false, minSamplePerArm: 3841, smallestArm: 4000 });
    expect(early.body.arms[1].confidenceSequence[0]).toBeGreaterThan(0);
    const row = await getExperimentRow(s2.tenantId, s2.orgId, id2);
    await putExperimentRow({ ...row!, startedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    const later = await s2.owner.get(X(s2.orgId, `/experiments/${encodeURIComponent(id2)}/results`));
    expect(later.body.verdict).toEqual({ kind: 'winner', arm: 'b' });
  });

  it('a legacy experiment has no Decide verdict', async () => {
    const s = await setup();
    const legacy = await createLegacy({ tenantId: s.tenantId, orgId: s.orgId, pageId: s.page.pageId, name: 'old', variants: [{ key: 'a', versionId: null, weight: 50 }, { key: 'b', versionId: null, weight: 50 }], createdBy: 'u' });
    const r = await s.owner.get(X(s.orgId, `/experiments/${encodeURIComponent(legacy.experimentId)}/results`));
    expect(r.status).toBe(409);
    expect(r.body.details.reason).toBe('legacy_experiment');
  });

  it('review fixes: an adapter never launches a row that changed underneath it; an abandoned test makes no call; bad power inputs are a 400', async () => {
    const s = await setup();
    const id = await lockedDraft(s);
    expect((await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/abandon`))).body.experiment.status).toBe('abandoned');
    const abandoned = (await getExperimentRow(s.tenantId, s.orgId, id))!;
    // The race the engine's draft check cannot see: the adapter is handed a row that is no longer a draft.
    await expect(experimentSurface('cms.page')!.launch(abandoned, 'u')).rejects.toMatchObject({ details: { reason: 'not_launchable' } });
    await expect(experimentSurface('funnel.step')!.launch({ ...abandoned, surface: { kind: 'funnel.step', ref: 'f:s' } }, 'u')).rejects.toBeTruthy();
    expect((await getExperimentRow(s.tenantId, s.orgId, id))?.status).toBe('abandoned');
    expect((await getExperimentRow(s.tenantId, s.orgId, id))?.epochs).toEqual([]);
    const plan = { ...PLAN, minSamplePerArm: 100, lockedAt: '', planHash: '' };
    expect(decideVerdict({ arms: ARMS, plan, status: 'abandoned', startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: '2026-03-01T00:00:00.000Z' }, [{ key: 'control', units: 5000, conversions: 500 }, { key: 'b', units: 5000, conversions: 800 }], 'complete', '2026-03-01T00:00:00.000Z').verdict)
      .toEqual({ kind: 'insufficient_data', reason: 'abandoned' });
    const bad = await s.owner.get(X(s.orgId, '/power?baselineRate=0.1&mde=0.02&alpha=2&power=0.8'));
    expect([bad.status, bad.body.details.field]).toEqual([400, 'alpha']);
  });

  it('no_difference and inconclusive_at_max (pure)', () => {
    const plan = { ...PLAN, minSamplePerArm: 100, lockedAt: '', planHash: '' };
    const base = { arms: [{ key: 'a', ref: null, weight: 50 }, { key: 'b', ref: null, weight: 50 }], plan, status: 'running' as const, startedAt: '2026-01-01T00:00:00.000Z' };
    const tight = decideVerdict(base, [{ key: 'a', units: 200_000, conversions: 20_000 }, { key: 'b', units: 200_000, conversions: 20_050 }], 'complete', '2026-01-10T00:00:00.000Z');
    expect(tight.verdict).toEqual({ kind: 'no_difference' });
    const wide = decideVerdict(base, [{ key: 'a', units: 150, conversions: 15 }, { key: 'b', units: 150, conversions: 18 }], 'complete', '2026-03-01T00:00:00.000Z');
    expect(wide.verdict).toEqual({ kind: 'inconclusive_at_max' });
    expect(decideVerdict(base, [{ key: 'a', units: 150, conversions: 15 }, { key: 'b', units: 150, conversions: 18 }], 'partial', '2026-03-01T00:00:00.000Z').verdict).toEqual({ kind: 'insufficient_data', reason: 'coverage' });
  });
});

describe('ADR 0949 P2a — 6/7. funnel steps and the merge guard', () => {
  it('a funnel step experiment launches by writing the pointer, is served, and the legacy stop refuses it', async () => {
    const s = await setup();
    await transitionPage(s.tenantId, s.orgId, s.page.pageId, 'publish', 'u');
    const f = await createFunnel({ tenantId: s.tenantId, orgId: s.orgId, createdBy: 'u', name: `F ${n}`, steps: [{ stepId: 's1', kind: 'landing', pageId: s.page.pageId }] });
    const created = await s.owner.post(X(s.orgId, '/experiments'), { name: 'Step', surface: { kind: 'funnel.step', ref: `${f.funnelId}:s1` }, arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: s.page.pageId, weight: 50 }] });
    expect(created.status).toBe(201);
    const id = created.body.experiment.experimentId as string;
    await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/lock`), { plan: PLAN });
    expect((await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/launch`))).body.experiment.status).toBe('running');
    const funnel = await getFunnel(s.tenantId, s.orgId, f.funnelId);
    expect(funnel?.steps[0]?.experiment?.experimentId).toBe(id);
    expect((await publicFunnelStep(s.tenantId, s.orgId, funnel!, 0, 'vk-9'))?.experiment?.experimentId).toBe(id);
    await expect(stopStepExperiment(s.tenantId, s.orgId, f.funnelId, 's1')).rejects.toMatchObject({ details: { reason: 'managed_by_experiments' } });
    expect((await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/stop`))).body.experiment.status).toBe('stopped');
    expect((await getFunnel(s.tenantId, s.orgId, f.funnelId))?.steps[0]?.experiment?.status).toBe('stopped');
  });

  it('a legacy write path never strips the plan', async () => {
    const s = await setup();
    const id = await lockedDraft(s);
    await s.owner.post(X(s.orgId, `/experiments/${encodeURIComponent(id)}/launch`));
    await stopExperiment(s.tenantId, s.orgId, s.page.pageId, id, 'u', { managed: true });
    const row = await getExperimentRow(s.tenantId, s.orgId, id);
    expect(row).toMatchObject({ status: 'stopped', hypothesis: 'A shorter hero lifts signups', plan: { minSamplePerArm: 3841 } });
    expect(row?.legacy).toBeUndefined();
  });
});
