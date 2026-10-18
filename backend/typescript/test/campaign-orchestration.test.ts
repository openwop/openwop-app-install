/**
 * Campaign Studio orchestration (ADR 0158) — the MarketingCampaign route (finalize
 * from a brief), the consistency-check + finalize nodes over stubbed surfaces, the
 * registered PARALLEL orchestration spine (RFC 0118), and the Campaign Strategist
 * agent.
 *
 * Access: a cross-TENANT stranger is refused by the tenant-keyed read; a
 * SAME-tenant non-member (second `test/login` into the tenant — zero scopes) is
 * what witnesses the org-scope check (`hasOrgScope` in `loadCampaignScoped` and
 * the list filter). Gap ids: CO-SP-5 (typed PATCH 400, validate-before-write),
 * ORCH-1 (kernel-less finalize 409), CFP-1 (strategist tools).
 *
 * Sabotage: dropping the status allowlist reds CO-SP-5; dropping `hasOrgScope`
 * from the scoped read reds the same-tenant non-member case; skipping the
 * by-brief lookup in finalize reds the one-campaign-per-brief case.
 *
 * The sequential spine / `parallelFanOutEnabled` / `CAMPAIGN_ORCHESTRATION`
 * env-override cases were cut in /grade-tests w31: no product code reads those
 * exports (`features/index.ts` registers only `campaignOrchestrationParallel`,
 * "sequential kill-switch retired").
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { checkMappingCapability } from '../src/host/workflowDefinitionValidation.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-orchestration.nodes/index.mjs';
import { campaignOrchestrationParallel, ORCHESTRATION_ID } from '../src/features/campaign-orchestration/orchestrationWorkflow.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import type { CampaignBrief } from '../src/features/campaign-brief/types.js';
import { CHANNEL_WORKFLOW_IDS } from '../src/features/campaign-channels/channelWorkflows.js';
import { setKernel } from '../src/features/campaign-brief/briefService.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'campaign-brief']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
/** Error envelope the host error handler writes. */
interface ErrBody { error: string; message: string }
type CampaignRes = { campaign: MarketingCampaign } & Partial<ErrBody>;
type CampaignsRes = { campaigns: MarketingCampaign[] } & Partial<ErrBody>;
interface Client {
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}
const uniqEmail = (): string => `cs-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const owner = client();
  // Explicit tenant so a test can set the kernel via the service (there is no
  // kernel HTTP route — it's set by the orchestration workflow surface).
  const tenantId = `user:cs-${Date.now()}-${n++}`;
  expect((await owner.post('/host/openwop-app/test/login', { email: uniqEmail(), tenantId })).status).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

const FINALIZE_KERNEL = {
  headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
  tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
};

describe('campaign-studio — finalize route', () => {
  it('404s when off', async () => {
    const d = getToggleDefault('campaign-orchestration');
    expect(d).toBeTruthy();
    await saveConfig({ ...d!, status: 'off' }, 'test');
    try {
      const c = client(); await c.post('/host/openwop-app/test/login', { email: uniqEmail() });
      const r = await c.get<ErrBody>('/host/openwop-app/campaign-orchestration/campaigns');
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('not_found');
    } finally {
      // Restore even on failure — every later case needs the feature ON.
      await saveConfig({ ...d!, status: 'on' }, 'test');
    }
  });

  it('finalizes a brief into a campaign (one per brief) and lists it', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const brief = await owner.post<{ brief: CampaignBrief }>('/host/openwop-app/campaign-brief/briefs', { orgId, name: 'Q4', productName: 'FlashPick' });
    const briefId = brief.body.brief.id;
    await owner.patch(`/host/openwop-app/campaign-brief/briefs/${briefId}`, { channels: [{ type: 'landing_page', enabled: true, config: {} }] });
    // ORCH-1: finalize now requires an approved messaging kernel — set it before finalizing.
    await setKernel(tenantId, briefId, FINALIZE_KERNEL);

    const fin = await owner.post<CampaignRes>('/host/openwop-app/campaign-orchestration/finalize', { briefId });
    expect(fin.status, JSON.stringify(fin.body)).toBe(201);
    expect(fin.body.campaign.briefId).toBe(briefId);
    expect(fin.body.campaign.channels).toEqual(['landing_page']);
    const campaignId = fin.body.campaign.id;

    // Re-finalize → same campaign (upsert by briefId, no duplicate).
    const fin2 = await owner.post<CampaignRes>('/host/openwop-app/campaign-orchestration/finalize', { briefId });
    expect(fin2.body.campaign.id).toBe(campaignId);

    const list = await owner.get<CampaignsRes>(`/host/openwop-app/campaign-orchestration/campaigns?orgId=${orgId}`);
    expect(list.body.campaigns.map((c) => c.id)).toEqual([campaignId]);
  });

  it('a cross-TENANT stranger cannot read a foreign campaign (404)', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const brief = await owner.post<{ brief: CampaignBrief }>('/host/openwop-app/campaign-brief/briefs', { orgId, name: 'Secret', productName: 'P' });
    await setKernel(tenantId, brief.body.brief.id, FINALIZE_KERNEL);
    const fin = await owner.post<CampaignRes>('/host/openwop-app/campaign-orchestration/finalize', { briefId: brief.body.brief.id });
    const stranger = client(); await stranger.post('/host/openwop-app/test/login', { email: uniqEmail() });
    const r = await stranger.get<ErrBody>(`/host/openwop-app/campaign-orchestration/campaigns/${fin.body.campaign.id}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('R2 CO-SP-5: PATCH with an invalid status is a typed 400 naming the allowlist — never a 200 no-op', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const brief = await owner.post<{ brief: CampaignBrief }>('/host/openwop-app/campaign-brief/briefs', { orgId, name: 'P5', productName: 'X' });
    await setKernel(tenantId, brief.body.brief.id, FINALIZE_KERNEL);
    const fin = await owner.post<CampaignRes>('/host/openwop-app/campaign-orchestration/finalize', { briefId: brief.body.brief.id });
    const id = fin.body.campaign.id;

    // The old guard silently DROPPED an invalid status and returned 200 with
    // the unchanged campaign — an agent's repair loop got success-with-no-op.
    const bad = await owner.patch<CampaignRes>(`/host/openwop-app/campaign-orchestration/campaigns/${id}`, { status: 'launched' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/launched/);
    expect(bad.body.message).toMatch(/draft.*active.*paused/);

    const badType = await owner.patch<CampaignRes>(`/host/openwop-app/campaign-orchestration/campaigns/${id}`, { status: 42 });
    expect(badType.status).toBe(400);

    const badName = await owner.patch<CampaignRes>(`/host/openwop-app/campaign-orchestration/campaigns/${id}`, { name: '   ' });
    expect(badName.status).toBe(400);

    // Polarity: a VALID patch still lands.
    const ok = await owner.patch<CampaignRes>(`/host/openwop-app/campaign-orchestration/campaigns/${id}`, { status: 'paused', name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.campaign.status).toBe('paused');
    expect(ok.body.campaign.name).toBe('Renamed');

    // Review fold-in: a COMBINED body validates whole before ANY write — the
    // 400 promises nothing changed, so the valid name must NOT have landed
    // beside the invalid status.
    const mixed = await owner.patch<CampaignRes>(`/host/openwop-app/campaign-orchestration/campaigns/${id}`, { name: 'ShouldNotLand', status: 'bogus' });
    expect(mixed.status).toBe(400);
    const after = await owner.get<CampaignsRes>(`/host/openwop-app/campaign-orchestration/campaigns?orgId=${orgId}`);
    const row = after.body.campaigns.find((c) => c.id === id);
    expect(row?.name).toBe('Renamed');
    expect(row?.status).toBe('paused');
  });

  it('R2: the dispatches route answers over HTTP (empty ledger => designed empty, stranger => 404)', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const brief = await owner.post<{ brief: CampaignBrief }>('/host/openwop-app/campaign-brief/briefs', { orgId, name: 'D5', productName: 'X' });
    await setKernel(tenantId, brief.body.brief.id, FINALIZE_KERNEL);
    const fin = await owner.post<CampaignRes>('/host/openwop-app/campaign-orchestration/finalize', { briefId: brief.body.brief.id });
    const id = fin.body.campaign.id;

    const ok = await owner.get<{ dispatches: unknown[] }>(`/host/openwop-app/campaign-orchestration/campaigns/${id}/dispatches`);
    expect(ok.status).toBe(200);
    expect(ok.body.dispatches).toEqual([]);

    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: uniqEmail() });
    expect((await stranger.get(`/host/openwop-app/campaign-orchestration/campaigns/${id}/dispatches`)).status).toBe(404);
  });

  it('a SAME-tenant non-member gets 404 on the campaign, its dispatches and its PATCH, and the list omits it', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const brief = await owner.post<{ brief: CampaignBrief }>('/host/openwop-app/campaign-brief/briefs', { orgId, name: 'Members only', productName: 'P' });
    await setKernel(tenantId, brief.body.brief.id, FINALIZE_KERNEL);
    const fin = await owner.post<CampaignRes>('/host/openwop-app/campaign-orchestration/finalize', { briefId: brief.body.brief.id });
    expect(fin.status).toBe(201);
    const id = fin.body.campaign.id;
    // Positive control: the owner reads it.
    expect((await owner.get<CampaignRes>(`/host/openwop-app/campaign-orchestration/campaigns/${id}`)).body.campaign.id).toBe(id);

    // Same tenant, no org membership: the tenant-keyed read FINDS the row, so only
    // the org-scope check can refuse it (a cross-tenant stranger never reaches it).
    const peer = client();
    expect((await peer.post('/host/openwop-app/test/login', { email: uniqEmail(), tenantId })).status).toBe(201);
    const one = await peer.get<ErrBody>(`/host/openwop-app/campaign-orchestration/campaigns/${id}`);
    expect(one.status).toBe(404);
    expect(one.body.error).toBe('not_found');
    const disp = await peer.get<ErrBody>(`/host/openwop-app/campaign-orchestration/campaigns/${id}/dispatches`);
    expect(disp.status).toBe(404);
    expect(disp.body.error).toBe('not_found');
    const patch = await peer.patch<ErrBody>(`/host/openwop-app/campaign-orchestration/campaigns/${id}`, { status: 'paused' });
    expect(patch.status).toBe(404);
    const list = await peer.get<CampaignsRes>(`/host/openwop-app/campaign-orchestration/campaigns?orgId=${orgId}`);
    expect(list.status).toBe(200);
    expect(list.body.campaigns).toEqual([]);
    // The refused PATCH changed nothing.
    expect((await owner.get<CampaignRes>(`/host/openwop-app/campaign-orchestration/campaigns/${id}`)).body.campaign.status).toBe('draft');
  });

  it('rejects finalizing a kernel-less brief with 409 (ORCH-1)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const brief = await owner.post<{ brief: CampaignBrief }>('/host/openwop-app/campaign-brief/briefs', { orgId, name: 'NoKernel', productName: 'P' });
    // No setKernel — the brief has no messaging kernel.
    const fin = await owner.post<CampaignRes>('/host/openwop-app/campaign-orchestration/finalize', { briefId: brief.body.brief.id });
    expect(fin.status).toBe(409);
    expect(fin.body.error).toBe('conflict');
    // And it produced no campaign.
    const list = await owner.get<CampaignsRes>(`/host/openwop-app/campaign-orchestration/campaigns?orgId=${orgId}`);
    expect(list.body.campaigns.length).toBe(0);
  });
});

describe('campaign-studio — nodes', () => {
  it('finalize fails closed without the studio surface', async () => {
    await expect(nodePack['feature.campaign-orchestration.nodes.finalize']({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('consistency-check scores drafts that echo the kernel', async () => {
    const features = { 'campaign-brief': { getBrief: async () => ({ brief: { kernel: { headline: 'Pick faster grocery', primaryCta: 'Demo', proofPoints: ['40 percent faster'] } } }) } };
    const drafts = [{ channel: 'landing_page', title: 'Pick faster with FlashPick' }, { channel: 'social_posts', content: 'unrelated text' }];
    const out = await nodePack['feature.campaign-orchestration.nodes.consistency-check']({ features, inputs: { briefId: 'b1', drafts } });
    expect(out.status).toBe('success');
    const r = out.outputs?.report as { score: number; divergences: Array<{ channel: string }> };
    expect(r.score).toBe(50); // 1 of 2 echoes "faster"
    expect(r.divergences.map((d) => d.channel)).toEqual(['social_posts']);
  });

  it('consistency-check returns a neutral report with no drafts', async () => {
    const features = { 'campaign-brief': { getBrief: async () => ({ brief: { kernel: { headline: 'X' } } }) } };
    const out = await nodePack['feature.campaign-orchestration.nodes.consistency-check']({ features, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('success');
    expect(out.outputs?.report).toMatchObject({ score: 100, divergences: [], passesThreshold: true, note: 'no drafts to compare' });
  });

  it('finalize creates the campaign via the surface', async () => {
    const features = { 'campaign-orchestration': { finalizeFromBrief: async (a: { briefId: string }) => ({ found: true, campaign: { id: 'camp-1', briefId: a.briefId } }) } };
    const out = await nodePack['feature.campaign-orchestration.nodes.finalize']({ features, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('success');
    expect((out.outputs?.campaign as Record<string, unknown>).id).toBe('camp-1');
  });

  // ADR 0161 — finalize also emits a canvas.campaign artifact that validates
  // against the canvas feature's registered schema (the engine produces the picture).
  it('finalize emits a schema-valid canvas.campaign artifact (channels mapped, assets from the kernel)', async () => {
    const campaign = {
      id: 'camp-2', name: 'Q4 Launch', objective: 'Generate leads',
      channels: ['landing_page', 'email_sequence', 'social_posts'],
      kernel: { headline: 'Pick faster', supportingStatement: 'Cut picking time 40%', primaryCta: 'Book a demo', proofPoints: ['40% faster', 'ROI in 6 months'] },
    };
    const features = { 'campaign-orchestration': { finalizeFromBrief: async () => ({ found: true, campaign }) } };
    const out = await nodePack['feature.campaign-orchestration.nodes.finalize']({ features, inputs: { briefId: 'b1' } });
    const artifact = out.outputs?.artifact as {
      artifactTypeId: string; title: string;
      payload: { channels: Array<{ type: string }>; assets: Array<{ headline: string }>; funnel: Array<{ stage: string }> };
    };
    expect(artifact.artifactTypeId).toBe('canvas.campaign');
    expect(artifact.title).toBe('Q4 Launch');
    // channel-vocab mapping: landing_page→content, email_sequence→email, social_posts→social
    expect(artifact.payload.channels.map((c) => c.type)).toEqual(['content', 'email', 'social']);
    expect(artifact.payload.assets[0].headline).toBe('Pick faster');
    expect(artifact.payload.funnel.map((f) => f.stage)).toEqual(['awareness', 'conversion']);
    // Validates against the ACTUAL canvas.campaign schema (the shared reconciliation contract).
    const { campaignSchema } = await import('../src/features/campaign-studio/artifactTypes.js');
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const validate = new Ajv2020({ strict: false }).compile(campaignSchema());
    expect(validate(artifact.payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it('finalize omits the canvas artifact when the campaign has no channels', async () => {
    const features = { 'campaign-orchestration': { finalizeFromBrief: async () => ({ found: true, campaign: { id: 'c', name: 'X', channels: [] } }) } };
    const out = await nodePack['feature.campaign-orchestration.nodes.finalize']({ features, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('success');
    expect(out.outputs?.artifact).toBeUndefined();
  });
});

describe('campaign-studio — orchestration workflow (the registered PARALLEL spine)', () => {
  it('the PARALLEL spine (RFC 0118) is supervisor → core.dispatch(parallel), same workflowId', () => {
    expect(campaignOrchestrationParallel.workflowId).toBe(ORCHESTRATION_ID); // same id → clean swap
    const ids = campaignOrchestrationParallel.nodes.map((nd) => nd.nodeId);
    expect(ids).toEqual(['validate', 'kernel', 'kernel-approve', 'channel-supervisor', 'channel-dispatch', 'production-plan', 'consistency', 'finalize']); // ADR 0356 P1
    const supervisor = campaignOrchestrationParallel.nodes.find((nd) => nd.typeId === 'core.orchestrator.supervisor')!;
    const plan = (supervisor.config as { mockDispatchPlan: Array<{ kind: string; nextWorkerIds?: string[] }> }).mockDispatchPlan;
    // The supervisor fans out to ALL five channel child workflows, then terminates.
    expect(plan[0].nextWorkerIds).toEqual([...CHANNEL_WORKFLOW_IDS]);
    expect(plan[1].kind).toBe('terminate');
    const dispatch = campaignOrchestrationParallel.nodes.find((nd) => nd.typeId === 'core.dispatch')!;
    const cfg = dispatch.config as Record<string, unknown>;
    expect(cfg.fanOutPolicy).toBe('parallel'); // RFC 0118
    expect(cfg.joinPolicy).toEqual({ mode: 'wait-all', onChildFailure: 'collect' }); // §B resolved defaults
    expect(cfg.inputMapping).toEqual({ briefId: 'briefId' }); // RFC 0022 §B — briefId → each child
    expect(campaignOrchestrationParallel.metadata?.fanOut).toBe('parallel');
  });

  // ADR 0158 §P1.5 — end-to-end unblock proof: once the host arm (RFC 0118, #994) lands,
  // the parallel spine's core.dispatch config is ACCEPTED by the live registration validator
  // (it would have thrown `capability_not_provided` before #994). Guards the contract.
  it('the PARALLEL spine REGISTERS against the live host validation (RFC 0118 consumer contract)', () => {
    const dispatch = campaignOrchestrationParallel.nodes.find((nd) => nd.typeId === 'core.dispatch')!;
    expect(() => checkMappingCapability([{ nodeId: dispatch.nodeId, typeId: 'core.dispatch', config: dispatch.config as Record<string, unknown> }])).not.toThrow();
  });
});

describe('campaign-studio — agent pack', () => {
  it('loads the Campaign Strategist with its registered tool-allowlist', () => {
    // CFP-1: the strategist drives the orchestration through two REAL registered
    // tools (status read + workflow igniter), not phantom node typeIds — the
    // resolution tripwire is test/agent-allowlist-resolution.test.ts.
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'vendor.openwop-app.campaign-orchestration.agents'));
    expect(loaded.length).toBe(1);
    expect(loaded[0].agentId).toBe('vendor.openwop-app.campaign-orchestration.agents.campaign-strategist');
    expect([...(loaded[0].toolAllowlist ?? [])].sort()).toEqual([
      'openwop:campaign-orchestration.run',
      'openwop:campaign-orchestration.status',
    ]);
  });
});
