/**
 * ADR 0948 P1b — no node publishes a funnel. `feature.funnels.nodes.request-publish`
 * queues a `funnel-publish` review; only a human's approve publishes, through the ONE
 * function (`publishFunnelAsApproved`) ADR 0942's campaign chokepoint also calls.
 *
 * Legs (all through a real run and the real inbox routes):
 *  1. A run of the node leaves the funnel a DRAFT and opens one pending review.
 *  2. The requester cannot approve their own request while another writer exists; a
 *     second writer's approve publishes it.
 *  3. An edit after the request makes the approve `stale_review` and consumes nothing;
 *     a reject leaves the funnel a draft.
 *  4. Unpublished step pages are refused at request (`step_pages_unpublished`), and the
 *     publish function refuses them too: a funnel publish never publishes its pages.
 *  5. Census: `publishFunnel` / `publishFunnelAsApproved` are CALLED only by the human
 *     route, environment promotion and the decide handler — no chat tool, node or
 *     surface method reaches them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { getApproval, listApprovals, createFunnelPublishApprovalOnce } from '../src/host/approvalService.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { createFunnel, getFunnel, updateFunnel, setStepExperiment, unpublishFunnel, funnelPublishDigest } from '../src/features/funnels/funnelsService.js';
import { funnelsFeature } from '../src/features/funnels/feature.js';
import { issueApiKey, revokeApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { publishFunnelAsApproved, requestFunnelPublish, funnelPublishApprovalId } from '../src/features/funnels/funnelPublishApproval.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;
const client = (): Client => makeClient(() => BASE);
const APPROVALS = '/host/openwop-app/approvals';

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  delete process.env.OPENWOP_DEMO_MODE; // the de-facto-owner bypass would make refusals vacuous
  for (const id of ['cms', 'funnels']) await enableToggle(id, 'on');
});
afterAll(async () => { await closeApp(); });

async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('p1b'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}

async function team() {
  const tenantId = `org:p1b-${Date.now()}-${n++}`;
  const owner = client(); const ownerId = await signup(owner, tenantId);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Agency' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  const editor = client(); const editorId = await signup(editor, tenantId);
  const added = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Editor', subject: editorId, roles: ['editor'] });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  const page = await createPage({ tenantId, orgId, title: `Landing ${n}`, createdBy: 'seed' });
  const funnel = await createFunnel({ tenantId, orgId, createdBy: 'seed', name: `Funnel ${n}`, steps: [{ kind: 'landing', pageId: page.pageId }] });
  return { tenantId, orgId, owner, ownerId, editor, editorId, pageId: page.pageId, funnelId: funnel.funnelId };
}

/** Run the request-publish node as `c`, and return the run's terminal node outcome. */
async function runRequest(c: Client, orgId: string, funnelId: string): Promise<{ status: string; outputs?: { approvalId?: string; status?: string }; error?: { code?: string } }> {
  const workflowId = `adr0948.p1b.request.${n++}`;
  registerWorkflow({ workflowId, nodes: [{ nodeId: 'n1', typeId: 'feature.funnels.nodes.request-publish', config: { orgId, funnelId } }], edges: [] });
  const started = await c.post('/runs', { workflowId, inputs: {} });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const runId = started.body.runId as string;
  let snap: { status?: string; error?: { code?: string } } = {};
  // A run has no settle hook to await: poll the snapshot until it is terminal.
  await vi.waitFor(async () => {
    snap = (await c.get(`/runs/${runId}`)).body ?? snap;
    expect(['completed', 'failed', 'cancelled']).toContain(snap.status ?? '');
  }, { timeout: 5000, interval: 25 });
  const events = ((await c.get(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body?.events ?? []) as Array<{ type: string; nodeId?: string; payload?: { outputs?: Record<string, unknown>; error?: { code?: string } } }>;
  const done = events.find((e) => e.nodeId === 'n1' && (e.type === 'node.completed' || e.type === 'node.failed'));
  return done?.type === 'node.completed'
    ? { status: 'success', outputs: done.payload?.outputs as { approvalId?: string; status?: string } }
    : { status: 'failed', error: done?.payload?.error ?? snap.error ?? {} };
}

describe('ADR 0948 P1b — request-publish never publishes; a human decision does', () => {
  it('legs 1–2: the node opens a review and leaves a draft; self-approval refused; another writer publishes', async () => {
    const t = await team();
    await transitionPage(t.tenantId, t.orgId, t.pageId, 'publish', 'seed');
    const out = await runRequest(t.editor, t.orgId, t.funnelId);
    expect(out.status, JSON.stringify(out)).toBe('success');
    expect(out.outputs?.status).toBe('pending_approval');
    const approvalId = out.outputs!.approvalId!;
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status, 'the node published').toBe('draft');
    const row = await getApproval(approvalId);
    expect(row).toMatchObject({ kind: 'funnel-publish', status: 'pending', orgId: t.orgId, submitters: [t.editorId] });
    expect(row?.funnelPublish).toMatchObject({ funnelId: t.funnelId, stepCount: 1 });

    // The same request again converges on the same open row.
    expect((await runRequest(t.editor, t.orgId, t.funnelId)).outputs).toMatchObject({ approvalId, created: false });
    expect((await listApprovals(t.tenantId)).filter((a) => a.kind === 'funnel-publish')).toHaveLength(1);

    const self = await t.editor.post(`${APPROVALS}/${approvalId}/claim`, {});
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('draft');

    const ok = await t.owner.post(`${APPROVALS}/${approvalId}/claim`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('published');
    expect((await getApproval(approvalId))?.status).toBe('approved');
  });

  it('leg 3: an edit after the request is stale (nothing consumed); a reject leaves a draft', async () => {
    const t = await team();
    await transitionPage(t.tenantId, t.orgId, t.pageId, 'publish', 'seed');
    const first = await runRequest(t.editor, t.orgId, t.funnelId);
    const approvalId = first.outputs!.approvalId!;
    await updateFunnel(t.tenantId, t.orgId, t.funnelId, { slug: `moved-${n}` });
    const stale = await t.owner.post(`${APPROVALS}/${approvalId}/claim`, {});
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('stale_review');
    expect((await getApproval(approvalId))?.status, 'a stale approve must consume nothing').toBe('pending');
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('draft');

    const rej = await t.owner.post(`${APPROVALS}/${approvalId}/reject`, { note: 'not yet' });
    expect(rej.status, JSON.stringify(rej.body)).toBeLessThan(300);
    expect((await getApproval(approvalId))?.status).toBe('rejected');
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('draft');
  });

  it('leg 4: unpublished step pages are refused at request AND by the publish function', async () => {
    const t = await team(); // the step page stays a draft
    const out = await runRequest(t.editor, t.orgId, t.funnelId);
    // The loader namespaces a node's error code on the wire; this is what a chain receives.
    expect(out).toMatchObject({ status: 'failed', error: { code: 'openwop-app.step_pages_unpublished' } });
    await expect(publishFunnelAsApproved(t.tenantId, t.orgId, t.funnelId)).rejects.toMatchObject({ details: { reason: 'step_pages_unpublished' } });
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('draft');
  });
});

describe('ADR 0948 P1b — an approve whose publish fails is undone', () => {
  it('a step page unpublished after the request: the approve fails and the review is pending again', async () => {
    const t = await team();
    await transitionPage(t.tenantId, t.orgId, t.pageId, 'publish', 'seed');
    const approvalId = (await runRequest(t.editor, t.orgId, t.funnelId)).outputs!.approvalId!;
    await transitionPage(t.tenantId, t.orgId, t.pageId, 'unpublish', 'seed');
    const r = await t.owner.post(`${APPROVALS}/${approvalId}/claim`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('step_pages_unpublished');
    expect((await getApproval(approvalId))?.status, 'the row must never claim a publish that did not happen').toBe('pending');
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('draft');
  });
});

describe('ADR 0948 P1b — review lifecycle (grade fixes)', () => {
  it('after a reject, the same content gets a NEW open review — never the decided row reported as pending', async () => {
    const t = await team();
    await transitionPage(t.tenantId, t.orgId, t.pageId, 'publish', 'seed');
    const first = (await runRequest(t.editor, t.orgId, t.funnelId)).outputs!.approvalId!;
    expect((await t.owner.post(`${APPROVALS}/${first}/reject`, { note: 'no' })).status).toBeLessThan(300);
    const again = await runRequest(t.editor, t.orgId, t.funnelId);
    expect(again.outputs).toMatchObject({ status: 'pending_approval', created: true });
    expect(again.outputs!.approvalId).not.toBe(first);
    expect((await getApproval(again.outputs!.approvalId!))?.status).toBe('pending');

    // Published, then unpublished: a new request is a new open review too.
    expect((await t.owner.post(`${APPROVALS}/${again.outputs!.approvalId}/claim`, {})).status).toBeLessThan(300);
    await unpublishFunnel(t.tenantId, t.orgId, t.funnelId);
    const third = await runRequest(t.editor, t.orgId, t.funnelId);
    expect(third.outputs).toMatchObject({ status: 'pending_approval', created: true });
    expect((await getApproval(third.outputs!.approvalId!))?.status).toBe('pending');
  });

  it('a new request after an edit supersedes the old open review; a step rename or a new experiment is stale', async () => {
    const t = await team();
    await transitionPage(t.tenantId, t.orgId, t.pageId, 'publish', 'seed');
    const old = (await runRequest(t.editor, t.orgId, t.funnelId)).outputs!.approvalId!;
    const f = (await getFunnel(t.tenantId, t.orgId, t.funnelId))!;
    // A visitor sees the step name: renaming it after the request makes the review stale.
    await updateFunnel(t.tenantId, t.orgId, t.funnelId, { steps: [{ stepId: f.steps[0]!.stepId, kind: 'landing', pageId: t.pageId, name: 'Renamed' }] });
    const stale = await t.owner.post(`${APPROVALS}/${old}/claim`, {});
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    const fresh = (await runRequest(t.editor, t.orgId, t.funnelId)).outputs!.approvalId!;
    expect((await getApproval(old))?.status, 'the older request is closed as superseded').toBe('rejected');

    // An experiment swaps the page a visitor gets: starting one after the request is stale too.
    const variant = await createPage({ tenantId: t.tenantId, orgId: t.orgId, title: `Variant ${n}`, createdBy: 'seed' });
    await transitionPage(t.tenantId, t.orgId, variant.pageId, 'publish', 'seed');
    await setStepExperiment(t.tenantId, t.orgId, t.funnelId, f.steps[0]!.stepId, [{ key: 'a', pageId: null, weight: 50 }, { key: 'b', pageId: variant.pageId, weight: 50 }]);
    const r = await t.owner.post(`${APPROVALS}/${fresh}/claim`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('stale_review');
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('draft');
  });

  it('a member who CAUSED the request (an actorless run) cannot approve it while another writer exists', async () => {
    const t = await team();
    await transitionPage(t.tenantId, t.orgId, t.pageId, 'publish', 'seed');
    const out = await requestFunnelPublish(t.tenantId, t.orgId, t.funnelId, { causedBy: t.ownerId, runId: 'run-actorless' });
    expect((await getApproval(out!.approvalId))?.submitterCauses).toEqual([t.ownerId]);
    const self = await t.owner.post(`${APPROVALS}/${out!.approvalId}/claim`, {});
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('draft');
  });

  it('revoking a requesting key preserves self-approval refusal and an independent writer can publish', async () => {
    const t = await team();
    await transitionPage(t.tenantId, t.orgId, t.pageId, 'publish', 'seed');
    const key = await issueApiKey({ tenantId: t.tenantId, createdBy: t.editorId, name: 'Funnel requester', scopes: ['workspace:write'] });
    const out = await requestFunnelPublish(t.tenantId, t.orgId, t.funnelId, { requestedBy: `apikey:${key.key.keyId}` });
    if (!out) throw new Error('Publish request missing');
    expect(await revokeApiKey(t.tenantId, key.key.keyId, { callerSubject: t.editorId, isAdmin: false })).toBe(true);
    expect((await t.editor.post(`${APPROVALS}/${out.approvalId}/claim`, {})).status).toBe(403);
    const decision = await t.owner.post(`${APPROVALS}/${out.approvalId}/claim`, {});
    expect(decision.status, JSON.stringify(decision.body)).toBeLessThan(300);
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('published');
    expect((await getApproval(out.approvalId))?.submitters).toEqual([t.editorId]);
  });

  it('an occupied deterministic id cannot return or index another orgs review', async () => {
    const t = await team();
    await transitionPage(t.tenantId, t.orgId, t.pageId, 'publish', 'seed');
    const f = await getFunnel(t.tenantId, t.orgId, t.funnelId);
    if (!f) throw new Error('Funnel missing');
    const digest = funnelPublishDigest(f);
    const approvalId = funnelPublishApprovalId(t.tenantId, f, digest);
    const input = { tenantId: t.tenantId, orgId: 'other-org', approvalId,
      funnelPublish: { funnelId: f.funnelId, funnelName: f.name, slug: f.slug, digest, stepCount: f.steps.length },
      proposal: 'Another orgs review', submitters: [t.editorId] };
    await createFunnelPublishApprovalOnce(input);
    await expect(createFunnelPublishApprovalOnce({ ...input, orgId: t.orgId })).rejects.toMatchObject({ details: { reason: 'review_unconfirmed' } });
    await expect(requestFunnelPublish(t.tenantId, t.orgId, t.funnelId, { requestedBy: t.editorId })).rejects.toMatchObject({ details: { reason: 'review_unconfirmed' } });
    expect(await getApproval(approvalId)).toMatchObject({ orgId: 'other-org', status: 'pending' });
    expect((await getFunnel(t.tenantId, t.orgId, t.funnelId))?.status).toBe('draft');
  });

  it('a run needs workspace:write in the org to request a publish (the route bar)', () => {
    expect(funnelsFeature.surface && 'orgPolicy' in funnelsFeature.surface ? funnelsFeature.surface.orgPolicy?.methodScopes : undefined)
      .toMatchObject({ requestPublish: 'workspace:write', create: 'workspace:write', setSteps: 'workspace:write' });
  });
});

describe('ADR 0948 P1b — census: who can publish a funnel', () => {
  it('only the human route, environment promotion and the decide handler CALL the publish functions', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
    const callers = new Set<string>();
    const sneaky: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      // A CALL, not an import or a declaration (the ADR 0832 call-site census rule),
      // including a namespaced call (`svc.publishFunnel(`).
      if (/\bpublishFunnel(AsApproved)?\(/.test(text.replace(/export async function publishFunnel(AsApproved)?\(/g, ''))) {
        callers.add(relative(SRC, file));
      }
      // An alias or a namespace import would hide a call from the scan above.
      if (/publishFunnel(AsApproved)?\s+as\s+\w+/.test(text) || /import\s+\*\s+as\s+\w+\s+from\s+'[^']*(funnelsService|funnelPublishApproval)\.js'/.test(text)) {
        sneaky.push(relative(SRC, file));
      }
    }
    expect(sneaky, 'an aliased or namespace import of the publish functions').toEqual([]);
    expect([...callers].sort()).toEqual([
      'features/environments/domains/publishPointersDomain.ts',
      'features/funnels/funnelPublishApproval.ts',
      'features/funnels/routes.ts',
    ]);
  });
});
