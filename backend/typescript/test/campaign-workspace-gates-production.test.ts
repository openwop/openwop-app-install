/**
 * ADR 0356 — workspace, setup gates, production-in-the-loop. Pins:
 *  - the spine SLOTS production-plan post-merge/pre-consistency;
 *  - the production node SKIPS honestly when the feature is off, and resolves
 *    org/channels from the brief when spine-called;
 *  - setup-check auto-resolves a fully-bound brief and names missing slots;
 *  - extract-seeds proposes (never writes) and fails closed on no coverage;
 *  - the consistency blend degrades to deterministic-only without a provider;
 *  - growthInterests outrank generic interests in production ranking;
 *  - the workspace aggregate 404s uniformly for a cross-tenant campaign id.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setKernel } from '../src/features/campaign-brief/briefService.js';
import type { Profile } from '../src/features/profiles/profilesService.js';
import { campaignOrchestrationWorkflow, campaignOrchestrationParallel } from '../src/features/campaign-orchestration/orchestrationWorkflow.js';
import { nodes as orchNodes } from '../../../packs/feature.campaign-orchestration.nodes/index.mjs';
import { nodes as briefNodes } from '../../../packs/feature.campaign-brief.nodes/index.mjs';
import { nodes as prodNodes } from '../../../packs/feature.production.nodes/index.mjs';

describe('spine slot (P1)', () => {
  it('production-plan sits post-merge, pre-consistency, in BOTH spines', () => {
    for (const wf of [campaignOrchestrationWorkflow, campaignOrchestrationParallel]) {
      const ids = wf.nodes.map((n) => n.nodeId);
      const plan = ids.indexOf('production-plan');
      const consistency = ids.indexOf('consistency');
      const finalize = ids.indexOf('finalize');
      expect(plan).toBeGreaterThan(-1);
      expect(plan).toBeLessThan(consistency);
      expect(consistency).toBeLessThan(finalize);
    }
  });

  it('the production node skips honestly when the feature is off', async () => {
    const out = await prodNodes['feature.production.nodes.plan-generate']({ features: {}, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('success');
    expect(out.outputs).toMatchObject({ skipped: true });
  });
});

describe('setup-check (P4)', () => {
  const briefSurface = (brief: Record<string, unknown>) => ({
    'campaign-brief': { getBrief: async () => ({ found: true, brief }) },
  });

  it('auto-resolves a fully-bound brief; names missing slots otherwise', async () => {
    const bound = await orchNodes['feature.campaign-orchestration.nodes.setup-check']({
      features: briefSurface({ id: 'b1', brandId: 'br1', personaIds: ['p1'], kbCollectionId: 'kb1' }), inputs: { briefId: 'b1' },
    });
    expect(bound.status).toBe('success');
    expect(bound.outputs).toMatchObject({ ready: true, missing: [] });

    const missing = await orchNodes['feature.campaign-orchestration.nodes.setup-check']({
      features: briefSurface({ id: 'b1', personaIds: [] }), inputs: { briefId: 'b1' },
    });
    expect(missing.outputs!.ready).toBe(false);
    expect((missing.outputs!.missing as Array<{ slot: string }>).map((m) => m.slot).sort()).toEqual(['brand', 'kb', 'persona']);
  });
});

describe('extract-seeds (P3)', () => {
  it('fails closed on no coverage; proposes with citations otherwise', async () => {
    const none = await briefNodes['feature.campaign-brief.nodes.extract-seeds']({
      features: { kb: { rag: async () => ({ coverage: 'none', citations: [], augmentedPrompt: '' }) } },
      callAI: async () => ({ data: {} }),
      inputs: { orgId: 'o1', collectionId: 'c1' },
    });
    expect(none.status).toBe('failed');
    expect(none.error?.code).toBe('grounding_insufficient');

    const ok = await briefNodes['feature.campaign-brief.nodes.extract-seeds']({
      features: { kb: { rag: async () => ({ coverage: 'ok', citations: [{ docId: 'd1' }], augmentedPrompt: 'CONTEXT' }) } },
      callAI: async () => ({ data: { personas: [{ name: 'Ops Director', role: 'ops', buyerStage: 'problem_aware', painPoints: ['labor'], objections: [], sources: [1] }], productSummary: 'Robots', competitors: ['AcmePick'] } }),
      inputs: { orgId: 'o1', collectionId: 'c1' },
    });
    expect(ok.status).toBe('success');
    expect(ok.outputs!.note).toContain('PROPOSALS');
    expect((ok.outputs!.proposals as { competitors: string[] }).competitors).toEqual(['AcmePick']);
    expect(ok.outputs!.citations).toEqual([{ docId: 'd1' }]);
  });
});

describe('consistency blend (P5)', () => {
  const drafts = [{ channel: 'ad_variants', headline: 'FlashPick picks faster' }];
  const kernelSurface = {
    'campaign-brief': { getBrief: async () => ({ found: true, brief: { kernel: { headline: 'FlashPick picks faster', primaryCta: 'Demo', proofPoints: [] } } }) },
  };

  it('no provider → deterministic-only; provider → 60/40 blend dimension', async () => {
    const det = await orchNodes['feature.campaign-orchestration.nodes.consistency-check']({
      features: kernelSurface, inputs: { briefId: 'b1', drafts },
    });
    expect(det.status).toBe('success');
    const detReport = det.outputs!.report as { dimensions: Array<{ name: string }> };
    expect(detReport.dimensions.map((d) => d.name)).toEqual(['kernelEcho']);

    const blended = await orchNodes['feature.campaign-orchestration.nodes.consistency-check']({
      features: kernelSurface, callAI: async () => ({ data: { score: 50 } }), inputs: { briefId: 'b1', drafts },
    });
    const rep = blended.outputs!.report as { score: number; dimensions: Array<{ name: string }> };
    expect(rep.dimensions.map((d) => d.name)).toContain('semanticJudge');
    expect(rep.score).toBe(Math.round(100 * 0.6 + 50 * 0.4));
  });
});

describe('growth interests (P6)', () => {
  const profileOf = (userId: string, over: Partial<Profile> = {}): Profile => ({
    userId, tenantId: 't', portfolioAssetTokens: [], skills: [], equipment: [], interests: [],
    workflows: [], pinnedAgentIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  });

  it('growthInterests outrank generic interests in production ranking', async () => {
    const { buildProductionContext } = await import('../src/features/production/productionContext.js');
    // Two profiles with IDENTICAL skills; only one declares a growth aspiration
    // matching the brief's channels — that member must rank first.
    const skills = [{ name: 'Graphic design', proficiency: 3, endorsements: [] }];
    const aspiring = profileOf('u-growth', { skills, growthInterests: ['video editing'] });
    const generic = profileOf('u-generic', { skills, interests: ['cooking'] });
    const ctx = buildProductionContext({ channels: ['creative_briefs'], profiles: [generic, aspiring], vendors: [] });
    expect(ctx.rankedMembers.map((m) => m.userId)).toEqual(['u-growth', 'u-generic']);
    expect(ctx.rankedMembers[0]!.score).toBeGreaterThan(ctx.rankedMembers[1]!.score);
  });
});

// ── Workspace aggregate route (ADR 0356 P2) — cross-tenant isolation ─────────
describe('workspace aggregate — uniform 404 for a cross-tenant campaign', () => {
  const ORCH = '/v1/host/openwop-app/campaign-orchestration';
  const FINALIZE_KERNEL = {
    headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
    tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
  };
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
    for (const id of ['campaign-brief', 'campaign-orchestration']) {
      const d = getToggleDefault(id);
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  interface Res<T = any> { status: number; body: T }
  interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
  function client(): Client {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
    };
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
  }
  async function login(): Promise<{ c: Client; tenantId: string }> {
    const c = client();
    const tenantId = `user:cwg-${Date.now()}-${n++}`;
    const r = await c.post('/v1/host/openwop-app/test/login', { email: `cwg-${Date.now()}-${n++}@acme.test`, tenantId });
    expect(r.status).toBe(201);
    return { c, tenantId };
  }

  it('owner reads the aggregate; a foreign tenant gets the SAME 404 as a nonexistent id', async () => {
    const { c: owner, tenantId } = await login();
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status).toBe(201);
    const brief = await owner.post('/v1/host/openwop-app/campaign-brief/briefs', { orgId: org.body.orgId, name: 'Q4', productName: 'FlashPick' });
    expect(brief.status, JSON.stringify(brief.body)).toBe(201);
    await setKernel(tenantId, brief.body.brief.id, FINALIZE_KERNEL);
    const fin = await owner.post(`${ORCH}/finalize`, { briefId: brief.body.brief.id });
    expect(fin.status, JSON.stringify(fin.body)).toBe(201);
    const campaignId = fin.body.campaign.id;

    // The owner's aggregate carries the brief (no swallowed store error — ORCH-CODE-3).
    const ws = await owner.get(`${ORCH}/campaigns/${campaignId}/workspace`);
    expect(ws.status, JSON.stringify(ws.body)).toBe(200);
    expect(ws.body.campaign.id).toBe(campaignId);
    expect(ws.body.brief?.id).toBe(brief.body.brief.id);

    // A stranger in ANOTHER tenant: the real cross-tenant id must be
    // indistinguishable from a nonexistent one (uniform 404, same body shape).
    const { c: stranger } = await login();
    const foreign = await stranger.get(`${ORCH}/campaigns/${campaignId}/workspace`);
    const missing = await stranger.get(`${ORCH}/campaigns/does-not-exist/workspace`);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const shape = (b: any): unknown => JSON.parse(JSON.stringify(b, (k, v) => (k === 'campaignId' ? '<id>' : v)));
    expect(shape(foreign.body)).toEqual(shape(missing.body));
  });
});
