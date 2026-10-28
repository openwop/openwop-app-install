/**
 * ADR 0948 P1 — the draft writers a funnel blueprint chain needs, and what a fork does
 * to them.
 *
 *  - `feature.cms.nodes.create-draft-page` and `feature.funnels.nodes.create` are
 *    `role:"side-effect"`, so a REPLAY fork is served the recorded output: still ONE
 *    page and ONE funnel, and the fork's nodes carry the SOURCE run's ids.
 *  - A BRANCH fork is a new, independent run: it drafts its OWN page
 *    (`page:<forkRunId>:n1`), never the source run's (which may be published by then).
 *  - The page id is derived from the run and node, never an input: a node cannot claim
 *    an existing page as its draft.
 *  - The funnel id a run's `create` gets is derived from tenant + run + node key: a
 *    re-delivered create returns the same draft (before the slug check, which would
 *    otherwise refuse it against itself), concurrent deliveries write once, and the
 *    same id in another tenant is a uniform 409, never an overwrite.
 *
 * BORN RED: with the 1.0.x `action` role, the replay fork re-runs `create` and fails on
 * its own slug (or, keyed on the fork's run id, mints a second draft).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listPages, getPage } from '../src/features/cms/cmsService.js';
import { listFunnels, createFunnel, runFunnelId, getFunnel, publishFunnel } from '../src/features/funnels/funnelsService.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { nodes as funnelNodes } from '../../../packs/feature.funnels.nodes/index.mjs';
import { buildFunnelsSurface } from '../src/features/funnels/surface.js';
import { getSetCookies } from './headerCookies.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE = '';
let cookie = '';
const TENANT = `org:adr0948p1-${Date.now()}`;
interface Ev { type: string; nodeId?: string; payload?: { outputs?: { page?: { pageId?: string }; funnelId?: string } } }
interface Body { runId: string; status: string; error: unknown; orgId: string; events: Ev[] }
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
  return { status: res.status, body: (await res.json().catch(() => undefined)) as Body }; // json() is untyped: the one boundary narrowing
};
const settleRun = async (runId: string): Promise<string> => {
  // A run has no settle hook to await: poll the snapshot until it is terminal.
  let snap: { status?: string; error?: unknown } = {};
  await vi.waitFor(async () => {
    snap = (await call('GET', `/runs/${runId}`)).body ?? snap;
    expect(['completed', 'failed', 'cancelled']).toContain(snap.status ?? '');
  }, { timeout: 5000, interval: 25 });
  return snap.status === 'completed' ? 'completed' : `${snap.status}:${JSON.stringify(snap.error)}`;
};
type Outputs = NonNullable<NonNullable<Ev['payload']>['outputs']>;
const nodeOutputs = async (runId: string, nodeId: string): Promise<Outputs | undefined> => {
  const bundle = await call('GET', `/host/openwop-app/runs/${bareRunId(runId)}/debug-bundle`);
  const done = (bundle.body?.events ?? []).find((e) => e.type === 'node.completed' && e.nodeId === nodeId);
  return done?.payload?.outputs;
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'funnels']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('ADR 0948 P1 — draft writers under replay and branch forks', () => {
  it('replay fork: still ONE page and ONE funnel, carrying the source ids; branch fork: its OWN page', async () => {
    const login = await call('POST', '/host/openwop-app/test/login', { email: 'adr0948p1-owner@acme.test', tenantId: TENANT });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const orgId = org.body.orgId;

    const workflowId = 'adr0948.p1.draft-writers';
    registerWorkflow({
      workflowId,
      nodes: [
        { nodeId: 'n1', typeId: 'feature.cms.nodes.create-draft-page', config: { orgId, title: 'Lead magnet', sections: [{ type: 'hero', data: { heading: 'Get the guide' } }] } },
        { nodeId: 'n2', typeId: 'feature.funnels.nodes.create', config: { orgId, name: 'Lead magnet funnel' } },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2' }],
    });

    const create = await call('POST', '/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId;
    expect(await settleRun(runId)).toBe('completed');
    const pageId = `page:${bareRunId(runId)}:n1`;
    const funnelId = runFunnelId(TENANT, bareRunId(runId), 'n2');
    expect((await getPage(TENANT, orgId, pageId))?.status).toBe('draft');
    expect((await listFunnels(TENANT, orgId)).map((f) => f.funnelId)).toEqual([funnelId]);

    const replay = await call('POST', `/runs/${runId}:fork`, { mode: 'replay' });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    const replayRunId = replay.body.runId;
    expect(await settleRun(replayRunId), 'a re-executed create would refuse its own slug').toBe('completed');
    expect((await listPages(TENANT, orgId)).map((p) => p.pageId), 'a replay fork drafted a second page').toEqual([pageId]);
    expect((await listFunnels(TENANT, orgId)).map((f) => f.funnelId), 'a replay fork minted a second funnel').toEqual([funnelId]);
    expect((await nodeOutputs(replayRunId, 'n1'))?.page?.pageId).toBe(pageId);
    expect((await nodeOutputs(replayRunId, 'n2'))?.funnelId).toBe(funnelId);

    // A branch is independent (executor.ts fork semantics): it drafts its own page.
    const page2 = 'adr0948.p1.page-only';
    registerWorkflow({ workflowId: page2, nodes: [{ nodeId: 'n1', typeId: 'feature.cms.nodes.create-draft-page', config: { orgId, title: 'Branch witness', sections: [{ type: 'hero', data: { heading: 'B' } }] } }], edges: [] });
    const src = await call('POST', '/runs', { workflowId: page2, inputs: {} });
    expect(await settleRun(src.body.runId)).toBe('completed');
    const branch = await call('POST', `/runs/${src.body.runId}:fork`, { mode: 'branch', fromSeq: 0 });
    expect(branch.status, JSON.stringify(branch.body)).toBe(201);
    expect(await settleRun(branch.body.runId)).toBe('completed');
    const branchPage = `page:${bareRunId(branch.body.runId)}:n1`;
    expect((await nodeOutputs(branch.body.runId, 'n1'))?.page?.pageId).toBe(branchPage);
    expect((await getPage(TENANT, orgId, branchPage))?.status).toBe('draft');
    expect((await getPage(TENANT, orgId, `page:${bareRunId(src.body.runId)}:n1`))?.status).toBe('draft');
  }, 30_000);
});

describe('ADR 0948 P1 — derived ids', () => {
  const surfaceCtx = (cms: object, runId?: string) => ({ features: { cms }, config: {}, ...(runId ? { runId, nodeId: 'n1' } : {}) });

  it('create-draft-page derives its page id; an input pageId is ignored; no run → typed failure', async () => {
    // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does; the cms-nodes.test precedent)
    const { nodes: cmsNodes } = (await import('../../../packs/feature.cms.nodes/index.mjs')) as { nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string } }>> };
    const calls: Array<Record<string, unknown>> = [];
    const cms = { getPage: async () => null, createDraftPage: async (a: Record<string, unknown>) => { calls.push(a); return { pageId: a.pageId, status: 'draft', title: a.title }; } };
    const sections = [{ type: 'hero', data: { heading: 'H' } }];
    const ok = await cmsNodes['feature.cms.nodes.create-draft-page']({ ...surfaceCtx(cms, 'run-1'), inputs: { orgId: 'o', title: 'T', sections, pageId: 'page:someone-elses', key: 'step 1!' } });
    expect(ok.status).toBe('success');
    expect(calls[0]!.pageId).toBe('page:run-1:n1:step1');
    const noRun = await cmsNodes['feature.cms.nodes.create-draft-page']({ ...surfaceCtx(cms), inputs: { orgId: 'o', title: 'T', sections } });
    expect(noRun).toMatchObject({ status: 'failed', error: { code: 'run_context_required' } });
    const noSections = await cmsNodes['feature.cms.nodes.create-draft-page']({ ...surfaceCtx(cms, 'run-1'), inputs: { orgId: 'o', title: 'T', sections: [] } });
    expect(noSections).toMatchObject({ status: 'failed', error: { code: 'validation_error' } });
  });

  it('a run create is idempotent and race-safe; the same id elsewhere is a 409, never an overwrite', async () => {
    const t = `org:p1-ids-${Date.now()}`;
    const surface = buildFunnelsSurface({ tenantId: t, runId: 'run-ids' } as never);
    const [a, b] = await Promise.all([
      surface.create!({ orgId: 'o1', name: 'Twice', key: 'n2' }),
      surface.create!({ orgId: 'o1', name: 'Twice', key: 'n2' }),
    ]) as Array<{ funnelId: string }>;
    expect(a!.funnelId).toBe(runFunnelId(t, 'run-ids', 'n2'));
    expect(b!.funnelId).toBe(a!.funnelId);
    expect(await listFunnels(t, 'o1')).toHaveLength(1);
    // A re-delivery after the first landed: the same draft, not a slug refusal.
    const again = await surface.create!({ orgId: 'o1', name: 'Twice', key: 'n2' }) as { funnelId: string; reused?: boolean };
    expect(again).toMatchObject({ funnelId: a!.funnelId, reused: true });

    // The same id in another org (or tenant) never reads or overwrites the row.
    await expect(createFunnel({ tenantId: t, orgId: 'o2', createdBy: 'x', name: 'Squat', funnelId: a!.funnelId })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(createFunnel({ tenantId: 'org:other', orgId: 'o1', createdBy: 'x', name: 'Squat', funnelId: a!.funnelId })).rejects.toMatchObject({ httpStatus: 409 });
    expect((await getFunnel(t, 'o1', a!.funnelId))?.name).toBe('Twice');
    // Different tenants derive different ids for the same run and key.
    expect(runFunnelId('org:other', 'run-ids', 'n2')).not.toBe(a!.funnelId);
  });

  it('a node run again with new inputs, or after a publish, FAILS — never a stale or live funnel as success', async () => {
    const t = `org:p1-stale-${Date.now()}`;
    const run = (inputs: Record<string, unknown>, nodeId = 'n2') =>
      funnelNodes['feature.funnels.nodes.create']({ features: { funnels: buildFunnelsSurface({ tenantId: t, runId: 'run-stale' } as never) }, nodeId, inputs: { orgId: 'o1', ...inputs } });
    const first = await run({ name: 'Original' });
    expect(first.status).toBe('success');
    const second = await run({ name: 'Revised' });
    expect(second).toMatchObject({ status: 'failed', error: { code: 'run_funnel_exists' } });
    // A loop key separates executions of one node.
    const looped = await run({ name: 'Revised', key: 'iteration-2' });
    expect(looped.status).toBe('success');
    expect(looped.outputs.funnelId).not.toBe(first.outputs.funnelId);

    // Published since: the same inputs are refused too, and set-steps is draft-only.
    const page = await createPage({ tenantId: t, orgId: 'o1', title: 'Step', createdBy: 'u' });
    const withStep = await run({ name: 'Live', steps: [{ kind: 'landing', pageId: page.pageId }] }, 'n9');
    const liveId = withStep.outputs.funnelId as string;
    await publishFunnel(t, 'o1', liveId);
    expect(await run({ name: 'Live', steps: [{ kind: 'landing', pageId: page.pageId }] }, 'n9'))
      .toMatchObject({ status: 'failed', error: { code: 'run_funnel_exists' } });
    const surface = buildFunnelsSurface({ tenantId: t, runId: 'run-stale' } as never);
    const edit = await funnelNodes['feature.funnels.nodes.set-steps']({ features: { funnels: surface }, inputs: { orgId: 'o1', funnelId: liveId, steps: [] } });
    expect(edit).toMatchObject({ status: 'failed', error: { code: 'funnel_not_draft' } });
    expect((await getFunnel(t, 'o1', liveId))?.steps).toHaveLength(1);
    const missing = await funnelNodes['feature.funnels.nodes.set-steps']({ features: { funnels: surface }, inputs: { orgId: 'o1', funnelId: 'fn_nope', steps: [] } });
    expect(missing).toMatchObject({ status: 'failed', error: { code: 'not_found' } });
  });

  it('create-draft-page fails when the derived id already holds a different or published page', async () => {
    // @ts-expect-error — untyped .mjs pack module (the cms-nodes.test precedent)
    const { nodes: cmsNodes } = (await import('../../../packs/feature.cms.nodes/index.mjs')) as { nodes: Record<string, (ctx: unknown) => Promise<{ status: string; error?: { code: string } }>> };
    const sections = [{ type: 'hero', data: { heading: 'H' } }];
    const stored = (title: string, status: string) => ({ getPage: async () => null, createDraftPage: async (a: Record<string, unknown>) => ({ pageId: a.pageId, status, title }) });
    const ctx = (cms: object, title: string) => ({ features: { cms }, runId: 'r', nodeId: 'n1', inputs: { orgId: 'o', title, sections } });
    expect((await cmsNodes['feature.cms.nodes.create-draft-page'](ctx(stored('Same', 'draft'), 'Same'))).status).toBe('success');
    expect(await cmsNodes['feature.cms.nodes.create-draft-page'](ctx(stored('Old title', 'draft'), 'New title'))).toMatchObject({ status: 'failed', error: { code: 'run_page_exists' } });
    expect(await cmsNodes['feature.cms.nodes.create-draft-page'](ctx(stored('Same', 'published'), 'Same'))).toMatchObject({ status: 'failed', error: { code: 'run_page_exists' } });
  });
});
