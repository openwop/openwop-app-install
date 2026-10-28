/**
 * ADR 0941 P5 — the campaign as a workflow and agent read.
 *
 *   1. `ctx.features['campaign-orchestration'].campaignContext` / `.links` resolve
 *      ONLY from the calling run's host-written tag. An untagged run is
 *      `not_a_campaign_run`, a tag/client-stamp mismatch is `wrong_client`, and the
 *      goal returned is the one FROZEN on the run, not the live one. In a tagged
 *      run, `getCampaign` refuses another client's campaign.
 *   2. The `campaign-context` node relays that as a typed success or failure.
 *   3. The Strategist's `get-campaign` read tool shares the routes' predicate and
 *      fails EMPTY (one shape) without an acting user, the toggle, the campaign
 *      or access.
 *   4. Prompt ⇔ allowlist ⇔ registered tools parity for the Strategist.
 *   5. `finalize` is a served side-effect node (a fork serves its recorded outcome).
 *
 * Sabotage witnesses (each reds the named case; run 2026-10-20):
 *   - `campaignContext` reading the live goal instead of the run's frozen goal:
 *     "the goal is the frozen one";
 *   - `visibleTo` returning the campaign unchanged: "getCampaign refuses…";
 *   - the `hasOrgScope` check in `runGetCampaignTool` removed: "get-campaign fails EMPTY…";
 *   - dropping get-campaign from the pack allowlist: "parity";
 *   - finalize back to role "action" + regenerated floor: "finalize is served".
 */
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { getBrief, createBrief } from '../src/features/campaign-brief/briefService.js';
import { deleteCampaign, getCampaign, ensureDraftCampaign, setCampaignGoal } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { buildCampaignStudioSurface } from '../src/features/campaign-orchestration/surface.js';
import { CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, CAMPAIGN_ORCH_GET_TOOL_ID, CAMPAIGN_ORCH_RUN_TOOL_ID, CAMPAIGN_ORCH_STATUS_TOOL_ID } from '../src/features/campaign-orchestration/agentTools.js';
import { MANIFEST_FAST_PATH_SERVED, MANIFEST_SIDE_EFFECT_FLOOR } from '../src/executor/sideEffectFloor.generated.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import type { RunRecord } from '../src/types.js';

const nodesPack = (await import(new URL('../../../packs/feature.campaign-orchestration.nodes/index.mjs', import.meta.url).href)) as {
  nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string } }>>;
};

const TENANT = 'default';
const GOAL = { outcome: { metric: 'leads' as const, target: 200 } };
let storage: Storage;
let orgA: string;
let orgB: string;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Client A', ownerSubject: 'u-1' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'u-9', name: 'Client B', ownerSubject: 'u-9' })).orgId;
});
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
beforeEach(async () => { await setToggle('campaign-orchestration', 'on'); });

async function campaignIn(orgId: string, owner = 'u-1'): Promise<MarketingCampaign> {
  const brief = await createBrief(TENANT, orgId, owner, { name: `B ${n++}`, channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  return (await ensureDraftCampaign(TENANT, brief, owner)).campaign;
}

async function runWith(metadata: Record<string, unknown>): Promise<string> {
  const now = new Date().toISOString();
  const run: RunRecord = { runId: `r-p5-${n++}`, workflowId: 'w', tenantId: TENANT, status: 'running', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now };
  await insertRunWithStartContext(storage, run);
  return run.runId;
}

describe('ADR 0941 P5 — 1. the surface reads only the run\'s own campaign', () => {
  it('the goal is the frozen one, not the live one', async () => {
    const c = (await setCampaignGoal(TENANT, (await campaignIn(orgA)).id, GOAL)) as MarketingCampaign;
    const runId = await runWith({ campaignOrchestration: stampCampaignRun(c, { role: 'spine' }) });
    await setCampaignGoal(TENANT, c.id, { outcome: { metric: 'leads', target: 999 } });
    const out = await buildCampaignStudioSurface({ tenantId: TENANT, runId }).campaignContext({}) as { found: boolean; campaign: { id: string; orgId: string }; goal: { outcome: { target: number }; version: number } };
    expect(out.found).toBe(true);
    expect(out.campaign).toMatchObject({ id: c.id, orgId: orgA });
    expect(out.goal).toMatchObject({ outcome: { target: 200 }, version: 1 });
  });

  it('an untagged run is not a campaign run; a wrong_client run is refused', async () => {
    const untagged = await runWith({});
    expect(await buildCampaignStudioSurface({ tenantId: TENANT, runId: untagged }).campaignContext({})).toMatchObject({ found: false, error: { code: 'not_a_campaign_run' } });
    const c = await campaignIn(orgA);
    const mixed = await runWith({ campaignOrchestration: stampCampaignRun(c, { role: 'stage' }), 'openwop-app.campaignOps': { orgId: orgB } });
    expect(await buildCampaignStudioSurface({ tenantId: TENANT, runId: mixed }).links({})).toMatchObject({ found: false, error: { code: 'wrong_client' } });
  });

  it('in a tagged run, getCampaign refuses another client\'s campaign', async () => {
    const mine = await campaignIn(orgA);
    const theirs = await campaignIn(orgB, 'u-9');
    const runId = await runWith({ campaignOrchestration: stampCampaignRun(mine, { role: 'stage' }) });
    const surface = buildCampaignStudioSurface({ tenantId: TENANT, runId });
    expect(await surface.getCampaign({ campaignId: theirs.id })).toEqual({ campaign: null });
    expect((await surface.getCampaign({ campaignId: mine.id }) as { campaign: { id: string } }).campaign.id).toBe(mine.id);
    // code-review (security fix): nor finalize another client's brief into its campaign.
    expect(await surface.finalizeFromBrief({ briefId: theirs.briefId })).toEqual({ found: false });
    expect(await surface.finalizeFromBrief({ briefId: mine.briefId })).toMatchObject({ found: true });
  });
});

describe('ADR 0941 P5 — 2. the campaign-context node', () => {
  const node = (): ((ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string } }>) => {
    const fn = nodesPack.nodes['feature.campaign-orchestration.nodes.campaign-context'];
    if (!fn) throw new Error('campaign-context node missing');
    return fn;
  };
  it('a tagged run gets its campaign; an untagged run fails typed (never an empty success)', async () => {
    const c = await campaignIn(orgA);
    const runId = await runWith({ campaignOrchestration: stampCampaignRun(c, { role: 'spine' }) });
    const ok = await node()({ inputs: {}, features: { 'campaign-orchestration': buildCampaignStudioSurface({ tenantId: TENANT, runId }) } });
    expect(ok.status).toBe('success');
    expect(ok.outputs?.campaign).toMatchObject({ id: c.id, orgId: orgA, autonomy: null });
    const untagged = await runWith({});
    const bad = await node()({ inputs: {}, features: { 'campaign-orchestration': buildCampaignStudioSurface({ tenantId: TENANT, runId: untagged }) } });
    expect(bad).toMatchObject({ status: 'failed', error: { code: 'not_a_campaign_run' } });
  });
});

describe('ADR 0941 P5 — 3. the Strategist\'s get-campaign read tool', () => {
  const exec = (input: Record<string, unknown>, actingUserId?: string) =>
    createAgentToolProvider({ tenantId: TENANT, ...(actingUserId ? { actingUserId } : {}) }).executeTool({ name: CAMPAIGN_ORCH_GET_TOOL_ID, input });

  it('reads a campaign the caller can see, by id or by brief', async () => {
    const c = await campaignIn(orgA);
    const out = JSON.parse((await exec({ campaignId: c.id }, 'u-1')).content) as { campaign: { id: string; finalized: boolean }; products: { status: string }; linked: Record<string, unknown> };
    expect(out.campaign).toMatchObject({ id: c.id, finalized: false });
    expect(out.linked).toHaveProperty('runs');
    expect(JSON.parse((await exec({ briefId: c.briefId }, 'u-1')).content).campaign.id).toBe(c.id);
  });

  it('get-campaign fails EMPTY, one shape, without access, an acting user, the toggle or the campaign', async () => {
    const c = await campaignIn(orgA);
    const EMPTY = { campaign: null };
    expect(JSON.parse((await exec({ campaignId: c.id }, 'u-9')).content)).toEqual(EMPTY); // u-9 is not in client A
    expect(JSON.parse((await exec({ campaignId: c.id })).content)).toEqual(EMPTY);
    expect(JSON.parse((await exec({ campaignId: 'cmp_missing' }, 'u-1')).content)).toEqual(EMPTY);
    await setToggle('campaign-orchestration', 'off');
    try { expect(JSON.parse((await exec({ campaignId: c.id }, 'u-1')).content)).toEqual(EMPTY); }
    finally { await setToggle('campaign-orchestration', 'on'); }
  });
});

describe('ADR 0941 P5 — 4. parity', () => {
  it('prompt ⇔ allowlist ⇔ registered tools', () => {
    const pack = JSON.parse(readFileSync(new URL('../../../packs/vendor.openwop-app.campaign-orchestration.agents/pack.json', import.meta.url), 'utf8')) as { agents: Array<{ toolAllowlist: string[] }> };
    const allowlist = [...(pack.agents[0]?.toolAllowlist ?? [])].sort();
    expect(allowlist).toEqual([CAMPAIGN_ORCH_AUTONOMY_TOOL_ID, CAMPAIGN_ORCH_GET_TOOL_ID, CAMPAIGN_ORCH_RUN_TOOL_ID, CAMPAIGN_ORCH_STATUS_TOOL_ID].sort());
    const prompt = readFileSync(new URL('../../../packs/vendor.openwop-app.campaign-orchestration.agents/prompts/campaign-strategist.md', import.meta.url), 'utf8');
    const named = [...new Set(prompt.match(/openwop:campaign-orchestration\.[a-z-]+/g) ?? [])].sort();
    expect(named).toEqual(allowlist);
    expect(prompt).toMatch(/four tools/);
    for (const id of allowlist) expect(builtinAgentToolIds(), id).toContain(id);
  });
});

describe('ADR 0941 P5 — 5. finalize is a served side-effect node', () => {
  it('finalize is served', () => {
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has('feature.campaign-orchestration.nodes.finalize')).toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has('feature.campaign-orchestration.nodes.finalize')).toBe(true);
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has('feature.campaign-orchestration.nodes.campaign-context')).toBe(false);
  });
});


describe('tagged mutations keep the original campaign generation', () => {
  it('an old tagged run cannot finalize or attach through its brief after recreation', async () => {
    const old = await campaignIn(orgA);
    const brief = (await getBrief(TENANT, old.briefId!))!;
    const runId = await runWith({ campaignOrchestration: stampCampaignRun(old, { role: 'stage' }) });
    const surface = buildCampaignStudioSurface({ tenantId: TENANT, runId });
    await deleteCampaign(TENANT, old.id);
    const next = (await ensureDraftCampaign(TENANT, brief, 'u-1')).campaign;
    expect(next.id).not.toBe(old.id);
    expect(await surface.finalizeFromBrief({ briefId: brief.id })).toEqual({ found: false });
    expect(await surface.attachAssets({ briefId: brief.id, assetIds: ['masset:unseen'] })).toEqual({ found: false });
    expect(await surface.attachAssets({ campaignId: next.id, assetIds: ['masset:unseen'] })).toEqual({ found: false });
    expect(await getCampaign(TENANT, next.id)).toEqual(next);
    expect(await getCampaign(TENANT, old.id)).toBeNull();
  });

  it('a live tag cannot mutate another campaign even in the same client org', async () => {
    const own = await campaignIn(orgA);
    const other = await campaignIn(orgA);
    const runId = await runWith({ campaignOrchestration: stampCampaignRun(own, { role: 'stage' }) });
    const surface = buildCampaignStudioSurface({ tenantId: TENANT, runId });
    expect(await surface.finalizeFromBrief({ briefId: other.briefId })).toEqual({ found: false });
    expect(await surface.attachAssets({ briefId: other.briefId, assetIds: ['masset:unseen'] })).toEqual({ found: false });
    expect(await surface.attachAssets({ campaignId: other.id, assetIds: ['masset:unseen'] })).toEqual({ found: false });
    expect(await getCampaign(TENANT, other.id)).toEqual(other);
    expect(await surface.finalizeFromBrief({ briefId: own.briefId })).toMatchObject({ found: true, campaign: { id: own.id } });
    expect(await surface.attachAssets({ campaignId: own.id, assetIds: ['masset:own'] })).toMatchObject({ found: true, campaign: { id: own.id, assetIds: ['masset:own'] } });
  });

  it.each(['finalize', 'attach'] as const)('%s refuses when retirement wins after its read but before its conditional write', async (operation) => {
    const old = await campaignIn(orgA);
    const brief = (await getBrief(TENANT, old.briefId!))!;
    const runId = await runWith({ campaignOrchestration: stampCampaignRun(old, { role: 'stage' }) });
    const surface = buildCampaignStudioSurface({ tenantId: TENANT, runId });
    const cas = storage.kvCompareAndSwap.bind(storage);
    let raced = false;
    let next: MarketingCampaign | undefined;
    storage.kvCompareAndSwap = async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
      if (!raced && args[0] === `hostext:campaign-orchestration:campaign:${TENANT}::${old.id}`) {
        raced = true;
        expect(await deleteCampaign(TENANT, old.id)).toBe(true);
        next = (await ensureDraftCampaign(TENANT, brief, 'u-1')).campaign;
      }
      return cas(...args);
    };
    try {
      const result = operation === 'finalize' ? await surface.finalizeFromBrief({ briefId: brief.id })
        : await surface.attachAssets({ briefId: brief.id, assetIds: ['masset:unseen'] });
      expect(raced).toBe(true);
      expect(result).toEqual({ found: false });
      expect(next).toBeDefined();
      expect(await getCampaign(TENANT, next!.id)).toEqual(next);
      expect(await getCampaign(TENANT, old.id)).toBeNull();
    } finally { storage.kvCompareAndSwap = cas; }
  });
});
