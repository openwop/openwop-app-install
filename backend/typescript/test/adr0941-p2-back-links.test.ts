/**
 * ADR 0941 P2 — children point up at the campaign, and a dangling id is refused
 * at every writer.
 *
 * Real app, real sign-ins for the routes; services for the lanes with no route
 * of their own. Exit criteria (ADR 0941 § Phased plan, P2):
 *   - email send `marketingCampaignId`: a missing or other-org campaign is a 404
 *     at the route AND at the service every caller shares; the publish surface
 *     takes it from the run tag, else from the brief, never from an argument;
 *   - plan link: one route, uniform 404 for a missing / other-org campaign and
 *     for a plan whose project is in another org; canvas delete and campaign
 *     delete both clear it;
 *   - campaign-ops asset and change request `campaignId`: refused when dangling
 *     or another client's;
 *   - a standalone channel run carries the run tag (role `stage`);
 *   - the links read lists the new children (legacy rows flagged `legacy`).
 * The ad-dispatch leg lives in `ads-adapter-meta.test.ts` (it needs the Meta mock).
 *
 * Sabotage witnesses (each reds the named case; run 2026-10-20):
 *   - `assertCampaignRef` in `createCampaign` removed: "an email send…" (service leg);
 *   - `campaignForRun` in the email surface replaced by `null`: "the publish surface…";
 *   - the project-org check in `loadPlan` removed: "a plan whose project…";
 *   - `registerPlanLinkHooks()` removed: "canvas delete and campaign delete…";
 *   - `assertCampaignRef` in `addAsset` removed: "campaign-ops…";
 *   - the channel tool's tag spread removed: "a standalone channel run…".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { createOrg, createMember, createWorkspace } from '../src/host/accessControlService.js';
import { createCanvasForTenant, deleteCanvasForTenant } from '../src/host/canvasSurface.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import type { CampaignBrief } from '../src/features/campaign-brief/types.js';
import { createCampaign, createTemplate, getCampaign as getEmailSend } from '../src/features/email/emailService.js';
import { buildEmailSurface } from '../src/features/email/surface.js';
import { createProject } from '../src/features/projects/projectsService.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { addAsset } from '../src/features/campaign-ops/assetService.js';
import { createRequest } from '../src/features/campaign-ops/requestService.js';
import { CAMPAIGN_CHANNELS_GENERATE_TOOL_ID } from '../src/features/campaign-channels/agentTools.js';
import { deleteCampaign, ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { readCampaignRunTag, stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { clearPlanLink, getPlanLink, listPlansForCampaign, setPlanLink } from '../src/features/campaign-studio/planLinks.js';
import { bareRunId } from './support/bareRunId.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
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
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'email', 'campaign-studio', 'campaign-channels', 'campaign-ops']) await setToggle(id, 'on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Body {
  user: { userId: string };
  orgId: string;
  marketingCampaignId?: string;
  campaignId?: string | null;
  links: Record<string, { status: string; items?: Array<Record<string, unknown>> }>;
}
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as Body }; // JSON boundary
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}

async function setup() {
  const tenantId = `org:bl-${Date.now()}-${n++}`;
  const owner = client();
  const userId = (await owner.post('/host/openwop-app/test/login', { email: `bl-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Client A' })).body.orgId;
  const otherOrgId = (await owner.post('/host/openwop-app/orgs', { name: 'Client B' })).body.orgId;
  const brief = await createBrief(tenantId, orgId, userId, { name: `Launch ${n}`, channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  const { campaign } = await ensureDraftCampaign(tenantId, brief, userId);
  const otherBrief = await createBrief(tenantId, otherOrgId, userId, { name: `Other ${n}`, channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  const { campaign: otherCampaign } = await ensureDraftCampaign(tenantId, otherBrief, userId);
  return { tenantId, orgId, otherOrgId, userId, owner, brief, campaign, otherCampaign };
}

describe('ADR 0941 P2 — email sends', () => {
  it('an email send naming a missing or other-org campaign is refused, at the route and at the service', async () => {
    const s = await setup();
    const tpl = await createTemplate({ tenantId: s.tenantId, orgId: s.orgId, name: 'T', subject: 'S', body: 'B', createdBy: s.userId });
    const route = `/host/openwop-app/email/orgs/${s.orgId}/campaigns`;
    expect((await s.owner.post(route, { templateId: tpl.templateId, marketingCampaignId: 'cmp_missing' })).status).toBe(404);
    expect((await s.owner.post(route, { templateId: tpl.templateId, marketingCampaignId: s.otherCampaign.id })).status).toBe(404);
    const ok = await s.owner.post(route, { templateId: tpl.templateId, marketingCampaignId: s.campaign.id });
    expect(ok.status).toBe(201);
    expect(ok.body.marketingCampaignId).toBe(s.campaign.id);
    // The service is the exit every caller shares.
    await expect(createCampaign({ tenantId: s.tenantId, orgId: s.orgId, templateId: tpl.templateId, createdBy: 'x', marketingCampaignId: s.otherCampaign.id }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it('the publish surface takes the campaign from the run tag, else the brief, never from an argument', async () => {
    const s = await setup();
    const now = new Date().toISOString();
    await storage.insertRun({ runId: `run-tag-${n}`, workflowId: 'w', tenantId: s.tenantId, status: 'pending', inputs: null, metadata: { campaignOrchestration: stampCampaignRun(s.campaign, { role: 'stage' }) }, configurable: {}, createdAt: now, updatedAt: now });
    const emails = [{ position: 1, subjectLines: ['Hi'], body: 'Body' }];
    // A forged argument names the other org's campaign; it is ignored.
    const tagged = await buildEmailSurface({ tenantId: s.tenantId, runId: `run-tag-${n}` }).createDraftCampaign({ orgId: s.orgId, name: 'Seq', emails, marketingCampaignId: s.otherCampaign.id }) as { campaignIds: string[] };
    expect((await getEmailSend(s.tenantId, s.orgId, tagged.campaignIds[0] ?? ''))?.marketingCampaignId).toBe(s.campaign.id);
    const byBrief = await buildEmailSurface({ tenantId: s.tenantId, runId: 'run-without-tag' }).createDraftCampaign({ orgId: s.orgId, name: 'Seq2', emails, sourceBriefId: s.brief.id }) as { campaignIds: string[] };
    expect((await getEmailSend(s.tenantId, s.orgId, byBrief.campaignIds[0] ?? ''))?.marketingCampaignId).toBe(s.campaign.id);
  });
});

describe('ADR 0941 P2 — plan links', () => {
  const planRoute = (orgId: string, canvasId: string) => `/host/openwop-app/campaign-studio/orgs/${orgId}/canvases/${canvasId}/campaign`;

  it('a plan links to a campaign of its org; a missing or other-org campaign is a 404', async () => {
    const s = await setup();
    const canvas = await createCanvasForTenant(s.tenantId, { canvasTypeId: 'canvas.campaign', name: 'Plan', initialState: { name: 'Plan', channels: [{ name: 'c', type: 'email' }] } });
    expect((await s.owner.put(planRoute(s.orgId, canvas.canvasId), { campaignId: 'cmp_missing' })).status).toBe(404);
    expect((await s.owner.put(planRoute(s.orgId, canvas.canvasId), { campaignId: s.otherCampaign.id })).status).toBe(404);
    const ok = await s.owner.put(planRoute(s.orgId, canvas.canvasId), { campaignId: s.campaign.id });
    expect(ok.status).toBe(200);
    expect((await s.owner.get(planRoute(s.orgId, canvas.canvasId))).body.campaignId).toBe(s.campaign.id);
    const links = await s.owner.get(`/host/openwop-app/campaign-orchestration/campaigns/${s.campaign.id}/links`);
    expect(links.body.links.plans).toEqual({ status: 'ok', items: [{ canvasId: canvas.canvasId, linkedAt: expect.any(String) }] });
  });

  it.each(['manual-clear', 'campaign-delete'] as const)('a stale %s cannot clear a concurrent replacement', async (kind) => {
    const s = await setup();
    const canvas = await createCanvasForTenant(s.tenantId, { canvasTypeId: 'canvas.campaign', initialState: { name: 'Race', channels: [{ name: 'c', type: 'email' }] } });
    const original = { tenantId: s.tenantId, canvasId: canvas.canvasId, orgId: s.orgId, campaignId: s.campaign.id, linkedAt: '2026-10-20T00:00:00.000Z' };
    await setPlanLink(original);
    const replacement = { ...original, campaignId: s.otherCampaign.id, orgId: s.otherOrgId };
    const cas = storage.kvCompareAndSwap.bind(storage);
    let moved = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (!moved && args[0].startsWith('hostext:campaign-studio:plan-link:') && args[0].endsWith(`::${canvas.canvasId}`)) {
        moved = true;
        await setPlanLink(replacement);
        // Same timestamp and identical public A fields exercise ABA identity.
        if (kind === 'manual-clear') await setPlanLink(original);
      }
      return cas(...args);
    });
    try {
      if (kind === 'manual-clear') expect((await s.owner.del(planRoute(s.orgId, canvas.canvasId))).status).toBe(409);
      else expect(await deleteCampaign(s.tenantId, s.campaign.id)).toBe(true);
    } finally { spy.mockRestore(); }
    expect(moved).toBe(true);
    const expected = kind === 'manual-clear' ? original : replacement;
    expect(await getPlanLink(s.tenantId, canvas.canvasId)).toEqual(expected);
    expect(await listPlansForCampaign(s.tenantId, expected.campaignId)).toEqual([expected]);
  });

  it('a relink cleanup cannot remove a newer A marker after A→B→A', async () => {
    const s = await setup();
    const canvas = await createCanvasForTenant(s.tenantId, { canvasTypeId: 'canvas.campaign', initialState: { name: 'ABA', channels: [{ name: 'c', type: 'email' }] } });
    const a = { tenantId: s.tenantId, canvasId: canvas.canvasId, orgId: s.orgId, campaignId: s.campaign.id, linkedAt: '2026-10-20T00:00:00.000Z' };
    await setPlanLink(a);
    const cas = storage.kvCompareAndSwap.bind(storage);
    let returnedToA = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      const result = await cas(...args);
      if (!returnedToA && result.swapped && args[0].startsWith('hostext:campaign-studio:plan-link:') && args[0].endsWith(`::${canvas.canvasId}`)) {
        returnedToA = true;
        await setPlanLink(a);
      }
      return result;
    });
    try { await setPlanLink({ ...a, campaignId: s.otherCampaign.id, orgId: s.otherOrgId }); }
    finally { spy.mockRestore(); }
    expect(returnedToA).toBe(true);
    expect(await listPlansForCampaign(s.tenantId, s.campaign.id)).toEqual([a]);
    await deleteCampaign(s.tenantId, s.campaign.id);
    expect(await getPlanLink(s.tenantId, canvas.canvasId)).toBeNull();
  });

  it.each(['campaign', 'canvas'] as const)('a %s deleted before the forward CAS cannot leave an active plan link', async (parent) => {
    const s = await setup();
    const canvas = await createCanvasForTenant(s.tenantId, { canvasTypeId: 'canvas.campaign', initialState: { name: 'Deleted parent', channels: [{ name: 'c', type: 'email' }] } });
    const cas = storage.kvCompareAndSwap.bind(storage);
    let deleted = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (!deleted && args[0].startsWith('hostext:campaign-studio:plan-link:') && args[0].endsWith(`::${canvas.canvasId}`)) {
        deleted = true;
        if (parent === 'campaign') await deleteCampaign(s.tenantId, s.campaign.id);
        else await deleteCanvasForTenant(s.tenantId, canvas.canvasId);
      }
      return cas(...args);
    });
    try { expect((await s.owner.put(planRoute(s.orgId, canvas.canvasId), { campaignId: s.campaign.id })).status).toBe(404); }
    finally { spy.mockRestore(); }
    expect(deleted).toBe(true);
    expect(await getPlanLink(s.tenantId, canvas.canvasId)).toBeNull();
    expect(await listPlansForCampaign(s.tenantId, s.campaign.id)).toEqual([]);
  });

  it('repeated clear is a no-op and a later attachment replaces the retained clear marker', async () => {
    const s = await setup();
    const canvas = await createCanvasForTenant(s.tenantId, { canvasTypeId: 'canvas.campaign', initialState: { name: 'Clear', channels: [{ name: 'c', type: 'email' }] } });
    const route = planRoute(s.orgId, canvas.canvasId);
    expect((await s.owner.put(route, { campaignId: s.campaign.id })).status).toBe(200);
    expect((await s.owner.del(route)).status).toBe(200);
    expect(await getPlanLink(s.tenantId, canvas.canvasId)).toBeNull();
    expect(await clearPlanLink(s.tenantId, canvas.canvasId)).toBe(false);
    expect((await s.owner.put(route, { campaignId: s.campaign.id })).status).toBe(200);
    expect((await getPlanLink(s.tenantId, canvas.canvasId))?.campaignId).toBe(s.campaign.id);
    expect((await s.owner.del(planRoute(s.otherOrgId, canvas.canvasId))).status).toBe(404);
    expect((await getPlanLink(s.tenantId, canvas.canvasId))?.campaignId).toBe(s.campaign.id);
  });

  it('a plan whose project is in another org cannot plan this org\'s campaign', async () => {
    const s = await setup();
    const sameOrg = await createProject(s.tenantId, s.orgId, { name: 'P-A' }, s.userId);
    const otherOrg = await createProject(s.tenantId, s.otherOrgId, { name: 'P-B' }, s.userId);
    const state = { name: 'Plan', channels: [{ name: 'c', type: 'email' }] };
    const good = await createCanvasForTenant(s.tenantId, { canvasTypeId: 'canvas.campaign', projectId: sameOrg.id, initialState: state });
    const bad = await createCanvasForTenant(s.tenantId, { canvasTypeId: 'canvas.campaign', projectId: otherOrg.id, initialState: state });
    expect((await s.owner.put(planRoute(s.orgId, good.canvasId), { campaignId: s.campaign.id })).status).toBe(200);
    expect((await s.owner.put(planRoute(s.orgId, bad.canvasId), { campaignId: s.campaign.id })).status).toBe(404);
  });

  it('with email, campaign-studio or campaign-ops OFF, its links section is unavailable, never read', async () => {
    const s = await setup();
    const route = `/host/openwop-app/campaign-orchestration/campaigns/${s.campaign.id}/links`;
    for (const id of ['email', 'campaign-studio', 'campaign-ops']) await setToggle(id, 'off');
    try {
      const res = await s.owner.get(route);
      expect(res.status).toBe(200);
      for (const k of ['emailSends', 'plans', 'opsAssets']) expect(res.body.links[k]).toEqual({ status: 'unavailable', reason: 'feature_off' });
      expect(res.body.links.runs?.status).toBe('ok');
    } finally {
      for (const id of ['email', 'campaign-studio', 'campaign-ops']) await setToggle(id, 'on');
    }
    for (const k of ['emailSends', 'plans', 'opsAssets']) expect((await s.owner.get(route)).body.links[k]?.status).toBe('ok');
  });

  it('canvas delete and campaign delete both clear the link', async () => {
    const s = await setup();
    const state = { name: 'Plan', channels: [{ name: 'c', type: 'email' }] };
    const a = await createCanvasForTenant(s.tenantId, { canvasTypeId: 'canvas.campaign', initialState: state });
    const b = await createCanvasForTenant(s.tenantId, { canvasTypeId: 'canvas.campaign', initialState: state });
    for (const c of [a, b]) expect((await s.owner.put(planRoute(s.orgId, c.canvasId), { campaignId: s.campaign.id })).status).toBe(200);
    await deleteCanvasForTenant(s.tenantId, a.canvasId);
    expect(await getPlanLink(s.tenantId, a.canvasId)).toBeNull();
    expect(await getPlanLink(s.tenantId, b.canvasId)).not.toBeNull();
    await deleteCampaign(s.tenantId, s.campaign.id);
    expect(await getPlanLink(s.tenantId, b.canvasId)).toBeNull();
  });
});

describe('ADR 0941 P2 — campaign-ops and channel runs', () => {
  it('campaign-ops: an asset or change request naming a dangling or other-client campaign is refused', async () => {
    const tenantId = (await createWorkspace({ name: `Agency ${n++}`, ownerSubject: `oidc:bl-owner-${n}` })).tenantId;
    const orgA = (await createOrg({ tenantId, createdBy: 'seed', name: 'Client A' })).orgId;
    const orgB = (await createOrg({ tenantId, createdBy: 'seed', name: 'Client B' })).orgId;
    await createMember({ tenantId, orgId: orgA, subject: 'seed', displayName: 'seed', roles: ['admin'] });
    await createClient({ tenantId, orgId: orgA, name: 'Client A', createdBy: 'seed' });
    const mk = async (orgId: string): Promise<CampaignBrief> => createBrief(tenantId, orgId, 'seed', { name: `B ${n++}`, channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
    const { campaign: mine } = await ensureDraftCampaign(tenantId, await mk(orgA), 'seed');
    const { campaign: theirs } = await ensureDraftCampaign(tenantId, await mk(orgB), 'seed');
    const page = await createPage({ tenantId, orgId: orgA, title: 'LP', createdBy: 'seed', sections: [{ type: 'hero', data: { heading: 'Hello' } }] });
    await transitionPage(tenantId, orgA, page.pageId, 'publish', 'seed');
    const field = `sections[${page.sections[0]?.sectionId ?? ''}].data.heading`;
    const asset = (campaignId?: string) => addAsset({ tenantId, orgId: orgA, destination: 'openwop.cms.page', locator: { pageId: page.pageId }, label: 'LP', editableFields: [field], createdBy: 'seed', ...(campaignId ? { campaignId } : {}) });
    await expect(asset('cmp_missing')).rejects.toMatchObject({ httpStatus: 404 });
    await expect(asset(theirs.id)).rejects.toMatchObject({ httpStatus: 404 });
    const ok = await asset(mine.id);
    expect(ok.campaignId).toBe(mine.id);
    await expect(createRequest({ tenantId, orgId: orgA, text: 'Change it', assetIds: [ok.assetId], createdBy: 'seed', campaignId: theirs.id })).rejects.toMatchObject({ httpStatus: 404 });
    expect((await createRequest({ tenantId, orgId: orgA, text: 'Change it', assetIds: [ok.assetId], createdBy: 'seed', campaignId: mine.id })).campaignId).toBe(mine.id);
  });

  it('a standalone channel run carries the run tag (role stage) when its brief has a campaign', async () => {
    const tenantId = 'default';
    const orgId = (await createOrg({ tenantId, createdBy: 'u-ch', name: `Ch ${n++}`, ownerSubject: 'u-ch' })).orgId;
    const brief = await createBrief(tenantId, orgId, 'u-ch', { name: 'Ch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
    const { campaign } = await ensureDraftCampaign(tenantId, brief, 'u-ch');
    const out = await createAgentToolProvider({ tenantId, actingUserId: 'u-ch' }).executeTool({ name: CAMPAIGN_CHANNELS_GENERATE_TOOL_ID, input: { briefId: brief.id, channel: 'email_sequence' } });
    expect(out.isError).toBeFalsy();
    const runId = (JSON.parse(out.content) as { runId: string }).runId;
    const run = await storage.getRun(bareRunId(runId));
    expect(readCampaignRunTag(run?.metadata as Record<string, unknown> | undefined)).toMatchObject({ campaignId: campaign.id, orgId, role: 'stage' });
  });
});
