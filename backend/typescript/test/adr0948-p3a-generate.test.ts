/**
 * ADR 0948 P3a (D5) — generate a DRAFT funnel from a blueprint, through the HTTP route
 * and the Funnel Architect's tools, which share one service.
 *
 * The real lead-magnet blueprint ships in P2 (its own test: adr0948-p2-lead-magnet).
 * A FIXTURE blueprint (real nodes, no sub-chains) witnesses the generate mechanism
 * end to end here; the P3 exit (the real lead-magnet chain through chat) is P3b.
 *
 * Legs:
 *  1. Before the fixture is installed: only the shipped blueprints are listed; generate on the fixture is `unknown_blueprint`.
 *  2. With the fixture: listed with its own `parameters`; generate starts a run that
 *     drafts a page and a funnel (nothing published), and an identical repeat reuses it.
 *  3. Typed refusals: unconfirmed brief, another org's brief (a uniform not-found),
 *     a campaign that is not this brief's, invalid params (validated against the chain's
 *     own schema: `startWorkflowRun` validates nothing).
 *  4. Authority: a reader cannot generate (403); the tool needs an acting person.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { loadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';
import { __admitBlueprintPackForTest, registerFunnelBlueprints } from '../src/features/funnels/blueprints.js';
import { createBrief, updateBrief, getBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { generateFunnelFromBlueprint } from '../src/features/funnels/generateService.js';
import { tryDurableStorage } from '../src/host/durable/durableStore.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { listFunnels } from '../src/features/funnels/funnelsService.js';
import { listPages } from '../src/features/cms/cmsService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { FUNNELS_BLUEPRINTS_TOOL_ID, FUNNELS_GENERATE_TOOL_ID } from '../src/features/funnels/agentTools.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { listCampaignRuns } from '../src/features/campaign-orchestration/campaignRunTag.js';

let BASE = '';
let close: () => Promise<void>;
let n = 0;
const FIXTURE = 'funnels.blueprint.test-lead';
const H = '/host/openwop-app';

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; close = h.close;
  delete process.env.OPENWOP_DEMO_MODE;
  for (const id of ['users', 'funnels', 'cms', 'campaign-brief']) await enableToggle(id, 'on');
});
afterAll(async () => { await close(); });

function loadFixture(): void {
  const root = mkdtempSync(join(tmpdir(), 'adr0948-p3a-'));
  const dir = join(root, 'private.test.funnelblueprints');
  mkdirSync(dir);
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: 'private.test.funnelblueprints', version: '1.0.0', kind: 'workflow-chain',
    description: 'Test-only funnel blueprint (ADR 0948 P3a).', author: 'test', license: 'Apache-2.0',
    engines: { openwop: '>=1.1.0 <3.0.0' },
    chains: [{
      chainId: FIXTURE, version: '1.0.0', label: 'Test lead magnet', description: 'One opt-in page and a draft funnel.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['orgId', 'briefId', 'headline'],
        properties: {
          orgId: { type: 'string' }, briefId: { type: 'string' }, campaignId: { type: 'string' },
          headline: { type: 'string', minLength: 1, description: 'The opt-in page headline.' },
          extras: { type: 'object', description: 'Nested settings (witnesses the canonical ignition key).' },
        },
      },
      dag: {
        nodes: [
          { id: 'page', typeId: 'feature.cms.nodes.create-draft-page@1.0.0', config: {}, inputs: { orgId: '{{params.orgId}}', title: '{{params.headline}}', sections: [{ type: 'hero', data: { heading: 'Get the guide' } }] } },
          { id: 'funnel', typeId: 'feature.funnels.nodes.create@1.1.0', config: {}, inputs: { orgId: '{{params.orgId}}', name: '{{params.headline}}' } },
        ],
        edges: [{ from: 'page', to: 'funnel' }],
      },
    }, {
      // No `campaignId` under additionalProperties:false: generate could never call it,
      // so it is not a blueprint (never listed, never runnable).
      chainId: 'funnels.blueprint.no-contract', version: '1.0.0', label: 'Broken', description: 'Lacks the generate contract.',
      parameters: { type: 'object', additionalProperties: false, required: ['orgId'], properties: { orgId: { type: 'string' }, briefId: { type: 'string' } } },
      dag: { nodes: [{ id: 'list', typeId: 'feature.funnels.nodes.list@1.0.0', config: {}, inputs: { orgId: '{{params.orgId}}' } }], edges: [] },
    }],
  }));
  const out = loadWorkflowChainPacks({ roots: [root] });
  expect(out.errors, JSON.stringify(out.errors)).toEqual([]);
  __admitBlueprintPackForTest('private.test.funnelblueprints');
  registerFunnelBlueprints();
}

async function team() {
  const tenantId = `org:p3a-${Date.now()}-${n++}`;
  const owner = makeClient(() => BASE);
  const ownerId = (await owner.post(`${H}/test/login`, { email: uniqEmail('p3a-o'), tenantId })).body.user.userId as string;
  const orgA = (await owner.post(`${H}/orgs`, { name: 'Client A' })).body.orgId as string;
  const orgB = (await owner.post(`${H}/orgs`, { name: 'Client B' })).body.orgId as string;
  const viewer = makeClient(() => BASE);
  const viewerId = (await viewer.post(`${H}/test/login`, { email: uniqEmail('p3a-v'), tenantId })).body.user.userId as string;
  expect((await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] })).status).toBeLessThan(300);
  // `as never`: the brief input carries many optional fields; only these matter here.
  const brief = await createBrief(tenantId, orgA, ownerId, { name: 'Guide launch', productName: 'Guide' } as never);
  const briefB = await createBrief(tenantId, orgB, ownerId, { name: 'Other client', productName: 'X' } as never);
  return { tenantId, owner, ownerId, viewer, orgA, orgB, briefId: brief.id, briefB: briefB.id };
}
const gen = (c: Client, orgId: string, body: Record<string, unknown>) => c.post(`${H}/funnels/orgs/${encodeURIComponent(orgId)}/generate`, body);
const code = (r: { body: unknown }): string => JSON.stringify(r.body);

describe('ADR 0948 P3a — before the fixture is installed', () => {
  it('lists only the shipped blueprints and refuses an uninstalled one as unknown_blueprint', async () => {
    const t = await team();
    const list = await t.owner.get(`${H}/funnels/orgs/${encodeURIComponent(t.orgA)}/blueprints`);
    expect(list.status).toBe(200);
    expect(list.body.blueprints.filter((b: { chainId: string }) => b.chainId === FIXTURE)).toEqual([]);
    const tool = await createAgentToolProvider({ tenantId: t.tenantId, actingUserId: t.ownerId }).executeTool({ name: FUNNELS_BLUEPRINTS_TOOL_ID, input: { orgId: t.orgA } });
    const parsed = JSON.parse(tool.content) as { blueprints: Array<{ chainId: string }>; note?: string };
    // ADR 0948 P2 ships the real blueprints (lead-magnet, then tripwire), so the tool lists them and the
    // "none installed" note is gone (the note still covers an empty set).
    expect(parsed.blueprints.map((b) => b.chainId)).toEqual(['funnels.blueprint.lead-magnet', 'funnels.blueprint.tripwire']);
    expect(parsed.note).toBeUndefined();
    const r = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: { headline: 'x' } });
    expect(r.status).toBe(404);
    expect(code(r)).toContain('unknown_blueprint');
  });
});

describe('ADR 0948 P3a — with a blueprint installed', () => {
  beforeAll(() => { loadFixture(); });

  it('lists the blueprint with its own parameters; generate drafts a page and a funnel, nothing published', async () => {
    const t = await team();
    const list = await t.owner.get(`${H}/funnels/orgs/${encodeURIComponent(t.orgA)}/blueprints`);
    const bp = list.body.blueprints.find((b: { chainId: string }) => b.chainId === FIXTURE);
    expect(bp?.parameters?.properties?.headline).toMatchObject({ type: 'string' });
    expect(list.body.filledByGenerate).toEqual(['orgId', 'briefId', 'campaignId']);

    await updateBrief(t.tenantId, t.briefId, { status: 'confirmed' } as never);
    const r = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: { headline: 'Free watercolor guide' } });
    expect(r.status, code(r)).toBe(201);
    const runId = r.body.runId as string;
    // The service returns the stored id; the protocol path takes the tenant-bound one.
    const wire = toWireRunId(runId, t.tenantId);
    // A run has no settle hook to await: poll its status until terminal.
    await vi.waitFor(async () => { expect(['completed', 'failed']).toContain((await t.owner.get(`/runs/${wire}`)).body?.status); }, { timeout: 8000, interval: 50 });
    const final = (await t.owner.get(`/runs/${wire}`)).body;
    expect(final?.status, JSON.stringify(final?.error)).toBe('completed');
    const funnels = await listFunnels(t.tenantId, t.orgA);
    expect(funnels.map((f) => [f.name, f.status])).toEqual([['Free watercolor guide', 'draft']]);
    expect((await listPages(t.tenantId, t.orgA)).filter((p) => p.title === 'Free watercolor guide').map((p) => p.status)).toEqual(['draft']);

    // The same request again reuses the run (no second funnel).
    const again = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: { headline: 'Free watercolor guide' } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ runId, started: false });
  });

  it('typed refusals: unconfirmed brief, another org\'s brief, a mismatched campaign, invalid params', async () => {
    const t = await team();
    const draft = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: { headline: 'x' } });
    expect(draft.status).toBe(409);
    expect(code(draft)).toContain('brief_not_confirmed');

    await updateBrief(t.tenantId, t.briefB, { status: 'confirmed' } as never);
    const cross = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefB, params: { headline: 'x' } });
    expect(cross.status).toBe(404);
    expect(code(cross)).toContain('brief_not_found');

    await updateBrief(t.tenantId, t.briefId, { status: 'confirmed' } as never);
    const camp = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, campaignId: 'cmp-not-here', params: { headline: 'x' } });
    expect(camp.status).toBe(404);
    expect(code(camp)).toContain('campaign_mismatch');

    const bad = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: { headline: '' } });
    expect(bad.status).toBe(400);
    expect(code(bad)).toContain('invalid_params');
    expect(await listFunnels(t.tenantId, t.orgA)).toEqual([]);
  });

  it('authority: a reader cannot generate; the tool needs an acting person and reaches the same refusals', async () => {
    const t = await team();
    await updateBrief(t.tenantId, t.briefId, { status: 'confirmed' } as never);
    expect((await gen(t.viewer, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: { headline: 'x' } })).status).toBe(403);

    const nobody = await createAgentToolProvider({ tenantId: t.tenantId }).executeTool({ name: FUNNELS_GENERATE_TOOL_ID, input: { blueprintId: FIXTURE, briefId: t.briefId } });
    expect(nobody.content).toContain('acting_user_required');
    const viaTool = await createAgentToolProvider({ tenantId: t.tenantId, actingUserId: t.ownerId }).executeTool({ name: FUNNELS_GENERATE_TOOL_ID, input: { orgId: t.orgA, blueprintId: FIXTURE, briefId: t.briefId, paramsJson: '{}' } });
    expect(viaTool.content).toContain('invalid_params');
    const listed = JSON.parse((await createAgentToolProvider({ tenantId: t.tenantId, actingUserId: t.ownerId }).executeTool({ name: FUNNELS_BLUEPRINTS_TOOL_ID, input: { orgId: t.orgA } })).content) as { blueprints: Array<{ chainId: string }> };
    expect(listed.blueprints.map((b) => b.chainId)).toContain(FIXTURE);
  });

  it('a chain without the generate contract is not a blueprint', async () => {
    const t = await team();
    const list = await t.owner.get(`${H}/funnels/orgs/${encodeURIComponent(t.orgA)}/blueprints`);
    expect(list.body.blueprints.map((b: { chainId: string }) => b.chainId)).not.toContain('funnels.blueprint.no-contract');
  });

  it('distinct nested params are distinct requests (canonical ignition key), not a reused run', async () => {
    const t = await team();
    await updateBrief(t.tenantId, t.briefId, { status: 'confirmed' } as never);
    const a = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: { headline: 'Nested', extras: { a: { x: 1 } } } });
    const b = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: { headline: 'Nested', extras: { a: { x: 2 } } } });
    expect(a.status, code(a)).toBe(201);
    expect(b.status, 'an array replacer would collapse this onto the first run').toBe(201);
    expect(b.body.runId).not.toBe(a.body.runId);
    expect((await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: 'nope' })).status).toBe(400);
  });

  it('a REAL campaign of another org, or of another brief, is campaign_mismatch; the tool refuses another org\'s brief', async () => {
    const t = await team();
    await updateBrief(t.tenantId, t.briefId, { status: 'confirmed' } as never);
    const otherOrg = await finalizeFromBrief(t.tenantId, (await getBrief(t.tenantId, t.briefB))!, t.ownerId);
    const r1 = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, campaignId: otherOrg.id, params: { headline: 'x' } });
    expect(r1.status).toBe(404);
    expect(code(r1)).toContain('campaign_mismatch');
    const brief2 = await createBrief(t.tenantId, t.orgA, t.ownerId, { name: 'Another brief', productName: 'Y' } as never);
    const otherBrief = await finalizeFromBrief(t.tenantId, brief2, t.ownerId);
    const r2 = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, campaignId: otherBrief.id, params: { headline: 'x' } });
    expect(code(r2)).toContain('campaign_mismatch');
    const own = await finalizeFromBrief(t.tenantId, (await getBrief(t.tenantId, t.briefId))!, t.ownerId);
    const linked = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, campaignId: own.id, params: { headline: 'Linked' } });
    expect(linked.status, code(linked)).toBe(201);
    const runId = String(linked.body.runId);
    const storage = tryDurableStorage();
    if (!storage) throw new Error('Planning storage missing');
    const run = await storage.getRun(runId);
    expect(run?.metadata?.campaignOrchestration).toMatchObject({ campaignId: own.id, orgId: t.orgA, briefId: t.briefId, role: 'stage', goalVersion: 0 });
    expect((await listCampaignRuns(t.tenantId, own.id)).map((r) => r.runId)).toContain(runId);
    const inferred = await gen(t.owner, t.orgA, { blueprintId: FIXTURE, briefId: t.briefId, params: { headline: 'Linked' } });
    expect(inferred.status).toBe(200);
    expect(inferred.body).toMatchObject({ runId, started: false });

    await updateBrief(t.tenantId, t.briefB, { status: 'confirmed' } as never);
    const viaTool = await createAgentToolProvider({ tenantId: t.tenantId, actingUserId: t.ownerId }).executeTool({ name: FUNNELS_GENERATE_TOOL_ID, input: { orgId: t.orgA, blueprintId: FIXTURE, briefId: t.briefB, paramsJson: '{"headline":"x"}' } });
    expect(viaTool.content).toContain('brief_not_found');
  });

  it('the launch gate refuses the run itself when funnels is off (independent of the route\'s check)', async () => {
    const t = await team();
    await updateBrief(t.tenantId, t.briefId, { status: 'confirmed' } as never);
    await enableToggle('funnels', 'off');
    try {
      const storage = tryDurableStorage()!;
      await expect(generateFunnelFromBlueprint({ storage, hostSuite: createHostAdapterSuite({ storage }) }, {
        tenantId: t.tenantId, actingUserId: t.ownerId, orgId: t.orgA, blueprintId: FIXTURE, briefId: t.briefId, params: { headline: 'Gate' },
      })).rejects.toBeTruthy();
      expect((await listFunnels(t.tenantId, t.orgA)).filter((f) => f.name === 'Gate')).toEqual([]);
    } finally {
      await enableToggle('funnels', 'on');
    }
  });
});
