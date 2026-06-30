/**
 * Campaign Studio orchestration (ADR 0158) — the MarketingCampaign route (finalize
 * from a brief), the consistency-check + finalize nodes over stubbed surfaces, the
 * parent orchestration workflow (DAG validity, sequential channel spine), and the
 * Campaign Strategist agent.
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
import { campaignOrchestrationWorkflow, campaignOrchestrationParallel, parallelFanOutEnabled, CAMPAIGN_ORCHESTRATION, ORCHESTRATION_ID } from '../src/features/campaign-orchestration/orchestrationWorkflow.js';
import { CHANNEL_WORKFLOW_IDS } from '../src/features/campaign-channels/channelWorkflows.js';

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
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'campaign-brief']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}
const uniqEmail = (): string => `cs-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail() })).status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId };
}

describe('campaign-studio — finalize route', () => {
  it('404s when off', async () => {
    const d = getToggleDefault('campaign-orchestration'); if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    const c = client(); await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail() });
    expect((await c.get('/v1/host/openwop-app/campaign-orchestration/campaigns')).status).toBe(404);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  });

  it('finalizes a brief into a campaign (one per brief) and lists it', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const brief = await owner.post('/v1/host/openwop-app/campaign-brief/briefs', { orgId, name: 'Q4', productName: 'FlashPick' });
    const briefId = brief.body.brief.id;
    await owner.patch(`/v1/host/openwop-app/campaign-brief/briefs/${briefId}`, { channels: [{ type: 'landing_page', enabled: true, config: {} }] });

    const fin = await owner.post('/v1/host/openwop-app/campaign-orchestration/finalize', { briefId });
    expect(fin.status, JSON.stringify(fin.body)).toBe(201);
    expect(fin.body.campaign.briefId).toBe(briefId);
    expect(fin.body.campaign.channels).toEqual(['landing_page']);
    const campaignId = fin.body.campaign.id;

    // Re-finalize → same campaign (upsert by briefId, no duplicate).
    const fin2 = await owner.post('/v1/host/openwop-app/campaign-orchestration/finalize', { briefId });
    expect(fin2.body.campaign.id).toBe(campaignId);

    const list = await owner.get(`/v1/host/openwop-app/campaign-orchestration/campaigns?orgId=${orgId}`);
    expect(list.body.campaigns.map((c: any) => c.id)).toEqual([campaignId]);
  });

  it('a stranger cannot read a foreign campaign (404)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const brief = await owner.post('/v1/host/openwop-app/campaign-brief/briefs', { orgId, name: 'Secret', productName: 'P' });
    const fin = await owner.post('/v1/host/openwop-app/campaign-orchestration/finalize', { briefId: brief.body.brief.id });
    const stranger = client(); await stranger.post('/v1/host/openwop-app/test/login', { email: uniqEmail() });
    expect((await stranger.get(`/v1/host/openwop-app/campaign-orchestration/campaigns/${fin.body.campaign.id}`)).status).toBe(404);
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
    const r = out.outputs?.report as Record<string, any>;
    expect(r.score).toBe(50); // 1 of 2 echoes "faster"
    expect(r.divergences.length).toBe(1);
  });

  it('consistency-check returns a neutral report with no drafts', async () => {
    const features = { 'campaign-brief': { getBrief: async () => ({ brief: { kernel: { headline: 'X' } } }) } };
    const out = await nodePack['feature.campaign-orchestration.nodes.consistency-check']({ features, inputs: { briefId: 'b1' } });
    expect((out.outputs?.report as Record<string, unknown>).passesThreshold).toBe(true);
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
    const artifact = out.outputs?.artifact as { artifactTypeId: string; payload: any; title: string };
    expect(artifact.artifactTypeId).toBe('canvas.campaign');
    expect(artifact.title).toBe('Q4 Launch');
    // channel-vocab mapping: landing_page→content, email_sequence→email, social_posts→social
    expect(artifact.payload.channels.map((c: any) => c.type)).toEqual(['content', 'email', 'social']);
    expect(artifact.payload.assets[0].headline).toBe('Pick faster');
    expect(artifact.payload.funnel.map((f: any) => f.stage)).toEqual(['awareness', 'conversion']);
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

describe('campaign-studio — orchestration workflow', () => {
  it('is a sequential validate→kernel→approve→5 channels→consistency→finalize spine', () => {
    expect(campaignOrchestrationWorkflow.workflowId).toBe(ORCHESTRATION_ID);
    const ids = campaignOrchestrationWorkflow.nodes.map((nd) => nd.nodeId);
    expect(ids).toEqual(['validate', 'kernel', 'kernel-approve', 'sw-landing-page', 'sw-ad-variants', 'sw-email-sequence', 'sw-creative-briefs', 'sw-social-posts', 'consistency', 'finalize']);
    // The five channel nodes dispatch via core.subWorkflow, sequential.
    const swNodes = campaignOrchestrationWorkflow.nodes.filter((nd) => nd.typeId === 'core.subWorkflow');
    expect(swNodes).toHaveLength(5);
    for (const sw of swNodes) {
      expect((sw.config as Record<string, unknown>).inputMapping).toEqual({ briefId: 'briefId' });
      expect((sw.config as Record<string, unknown>).onChildFailure).toBe('absorb');
    }
    // Linear chain of 9 edges; briefId is the shared variable.
    expect(campaignOrchestrationWorkflow.edges).toHaveLength(9);
    expect(campaignOrchestrationWorkflow.variables?.[0]?.name).toBe('briefId');
    expect(campaignOrchestrationWorkflow.metadata?.parallelUpgrade).toBe('RFC-0118');
  });

  // ADR 0158 §P1.5 — the parallel spine is prepped but DORMANT until the host
  // implements RFC 0118 (env-gated, default off → sequential ships today).
  it('defaults to the SEQUENTIAL spine (parallel gated off)', () => {
    expect(parallelFanOutEnabled()).toBe(false);
    expect(CAMPAIGN_ORCHESTRATION).toHaveLength(1);
    expect(CAMPAIGN_ORCHESTRATION[0]).toBe(campaignOrchestrationWorkflow);
    expect(CAMPAIGN_ORCHESTRATION[0].metadata?.fanOut).toBe('sequential');
  });

  it('the PARALLEL spine (RFC 0118) is supervisor → core.dispatch(parallel), same workflowId', () => {
    expect(campaignOrchestrationParallel.workflowId).toBe(ORCHESTRATION_ID); // same id → clean swap
    const ids = campaignOrchestrationParallel.nodes.map((nd) => nd.nodeId);
    expect(ids).toEqual(['validate', 'kernel', 'kernel-approve', 'channel-supervisor', 'channel-dispatch', 'consistency', 'finalize']);
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
  it('loads the Campaign Strategist with cross-pack tool-allowlist', () => {
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'feature.campaign-orchestration.agents'));
    expect(loaded.length).toBe(1);
    expect(loaded[0].agentId).toBe('feature.campaign-orchestration.agents.campaign-strategist');
    expect(loaded[0].toolAllowlist).toEqual(expect.arrayContaining([
      'openwop:feature.campaign-brief.nodes.generate-kernel',
      'openwop:feature.campaign-channels.nodes.generate',
      'openwop:feature.campaign-orchestration.nodes.finalize',
    ]));
  });
});
