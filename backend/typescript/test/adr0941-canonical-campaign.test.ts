/**
 * ADR 0941 P0 — the campaign exists before its first run, and the run says so.
 *
 * Real app (memory storage). Exit criteria (ADR 0941 § Phased plan, P0):
 *   - two concurrent ignitions of one brief produce ONE campaign, with the
 *     deterministic `cmp_` id; the loser reads the winner;
 *   - the ignited run's tag (`run.metadata.campaignOrchestration`) names the
 *     campaign, its client org and the goal version;
 *   - a caller-supplied tag or goal is stripped (`POST /runs`);
 *   - the per-campaign index lists the run (and a `:fork` of it) WITHOUT a
 *     tenant scan;
 *   - the goal is frozen at run start, never re-resolved on `:fork`, and never
 *     stamped when it has moved past the tag's version;
 *   - finalize UPDATES the ignition draft (version stays 1) and a re-finalize
 *     bumps it; pre-0941 rows are indexed once and resolve to the oldest row.
 *
 * Sabotage witnesses (each reds the named case; run 2026-10-20):
 *   - `campaigns.putIfAbsent` → `put` in ensureDraftCampaign: "two concurrent…"
 *     (more than one `created:true`);
 *   - dropping `campaignGoal` from RESERVED_RUN_METADATA_KEYS: "caller-supplied…";
 *   - `registerRunInsertedHook` call removed: "the run tool…", "the index lists…"
 *     and "…without a tenant scan";
 *   - `if (ctx.derivedFromRun) return {}` removed: "a goal-less run stays…";
 *   - the goalVersion equality check removed: "a goal that moved…";
 *   - `listCampaignRuns` swapped for a tenant prefix: "…without a tenant scan".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { inheritedRunMetadata } from '../src/host/inheritedRunMetadata.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import type { CampaignBrief } from '../src/features/campaign-brief/types.js';
import { runOrchestrationRunTool, CAMPAIGN_ORCH_RUN_TOOL_ID, CAMPAIGN_ORCH_STATUS_TOOL_ID } from '../src/features/campaign-orchestration/agentTools.js';
import {
  __putCampaignRow, buildCampaignFromBrief, listCampaignVersions, briefCampaignId, deleteCampaign, ensureDraftCampaign, finalizeFromBrief, getCampaign,
  getCampaignByBrief, listCampaigns, setCampaignGoal,
} from '../src/features/campaign-orchestration/campaignService.js';
import {
  campaignGoalContributor, listCampaignRuns, readCampaignRunTag, stampCampaignRun,
} from '../src/features/campaign-orchestration/campaignRunTag.js';
import type { CampaignRunTag, MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { getCampaignProjectId } from '../src/features/campaign-orchestration/campaignProject.js';
import { getProject } from '../src/features/projects/projectsService.js';
import { bareRunId } from './support/bareRunId.js';
import { getEventLog } from '../src/executor/eventLog.js';
import type { RunRecord } from '../src/types.js';

const TENANT = 'default';
const TOKEN = 'dev-token';
let server: http.Server;
let storage: Storage;
let BASE: string;
let orgId: string;
let fixtureWorkflowId: string;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  orgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Client A', ownerSubject: 'u-1' })).orgId;
  const disco = await jf<{ fixtures?: string[] }>('/.well-known/openwop');
  fixtureWorkflowId = disco.body.fixtures?.[0] ?? 'openwop-app.uppercase';
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => {
  const d = getToggleDefault('campaign-orchestration');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});

async function jf<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as T }; // JSON boundary
}

async function newBrief(): Promise<CampaignBrief> {
  return createBrief(TENANT, orgId, 'u-1', { name: `Launch ${n++}`, channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
}

/** Narrow a nullable result, failing the case with a message instead of a `!`. */
function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

const runMeta = async (runId: string): Promise<Record<string, unknown>> =>
  ((await storage.getRun(bareRunId(runId)))?.metadata ?? {}) as Record<string, unknown>;

/** Insert a run the way a campaign service does (host path, through the seam). */
async function insertTaggedRun(tag: CampaignRunTag, extra: Partial<RunRecord> = {}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `r-${Date.now()}-${n++}`, workflowId: fixtureWorkflowId, tenantId: TENANT, status: 'completed',
    inputs: {}, metadata: { campaignOrchestration: tag }, configurable: {}, createdAt: now, updatedAt: now, ...extra,
  };
  await insertRunWithStartContext(storage, run);
  // A fork needs a source event to fork from.
  await getEventLog().append({ runId: run.runId, type: 'log.message', payload: { message: 'adr0941 fork point' } });
  return run;
}

describe('ADR 0941 P0 — the campaign is born at ignition', () => {
  it('two concurrent ignitions of one brief produce ONE campaign with the deterministic id', async () => {
    const brief = await newBrief();
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureDraftCampaign(TENANT, brief, 'u-1')));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const ids = new Set(results.map((r) => r.campaign.id));
    expect([...ids]).toEqual([briefCampaignId(TENANT, brief.id)]);
    expect([...ids][0]).toMatch(/^cmp_[a-z2-7]{24}$/);
    expect((await listCampaigns(TENANT, orgId)).filter((c) => c.briefId === brief.id)).toHaveLength(1);
    const c = must(await getCampaignByBrief(TENANT, brief.id), 'the brief\'s campaign');
    expect(c).toMatchObject({ status: 'draft', orgId, version: 1 });
    expect(c.ignitedAt).toBeTruthy();
    expect(c.finalizedAt).toBeUndefined();
  });

  it('the run tool creates the campaign BEFORE the run, and the run tag names it', async () => {
    const brief = await newBrief();
    expect(await getCampaignByBrief(TENANT, brief.id)).toBeNull();
    const out = await createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_ORCH_RUN_TOOL_ID, input: { briefId: brief.id } });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { runId: string; campaignId: string };
    const campaign = must(await getCampaignByBrief(TENANT, brief.id), 'the brief\'s campaign');
    expect(parsed.campaignId).toBe(campaign.id);
    const tag = readCampaignRunTag(await runMeta(parsed.runId));
    expect(tag).toEqual({
      campaignId: campaign.id, orgId, briefId: brief.id, goalVersion: 0, role: 'spine',
      agentId: 'vendor.openwop-app.campaign-orchestration.agents.campaign-strategist',
    });
    const indexed = await listCampaignRuns(TENANT, campaign.id);
    expect(indexed.map((r) => r.runId)).toContain(bareRunId(parsed.runId));
    // The readiness tool tells the ignition draft from a finalized campaign.
    const status = await createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_ORCH_STATUS_TOOL_ID, input: { briefId: brief.id } });
    expect((JSON.parse(status.content) as { brief: { existingCampaign: unknown } }).brief.existingCampaign).toMatchObject({ id: campaign.id, status: 'draft', finalized: false });
  });

  it('a caller-supplied tag or goal is stripped from POST /runs', async () => {
    const created = await jf<{ runId: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: fixtureWorkflowId, inputs: {},
        metadata: { campaignOrchestration: { campaignId: 'cmp_forged', orgId }, campaignGoal: { outcome: { metric: 'cpa', target: 1 }, version: 9 }, note: 'kept' },
      }),
    });
    expect(created.status).toBe(201);
    const meta = await runMeta(created.body.runId);
    expect(meta.campaignOrchestration).toBeUndefined();
    expect(meta.campaignGoal).toBeUndefined();
    expect(meta.note).toBe('kept');
  });
});

describe('ADR 0941 P0 — the per-campaign run index', () => {
  it('the index lists the run and its :fork, keyed by the campaign', async () => {
    const { campaign } = await ensureDraftCampaign(TENANT, await newBrief(), 'u-1');
    const src = await insertTaggedRun(stampCampaignRun(campaign, { role: 'spine' }));
    const fork = await jf<{ runId: string }>(`/runs/${encodeURIComponent(`${TENANT}/${src.runId}`)}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }) });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    // `:fork` copies the tag verbatim.
    expect((await runMeta(fork.body.runId)).campaignOrchestration).toEqual(stampCampaignRun(campaign, { role: 'spine' }));
    const rows = await listCampaignRuns(TENANT, campaign.id);
    expect(rows.find((r) => r.runId === src.runId)).toMatchObject({ role: 'spine', orgId, workflowId: fixtureWorkflowId });
    expect(rows.find((r) => r.runId === bareRunId(fork.body.runId))).toMatchObject({ forkOf: src.runId });
  });

  it('…without a tenant scan: every read is a prefix on ONE campaign', async () => {
    const { campaign } = await ensureDraftCampaign(TENANT, await newBrief(), 'u-1');
    await insertTaggedRun(stampCampaignRun(campaign, { role: 'report' }));
    const spy = vi.spyOn(DurableCollection.prototype, 'listByPrefix');
    try {
      expect(await listCampaignRuns(TENANT, campaign.id)).toHaveLength(1);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      for (const [prefix] of spy.mock.calls) expect(prefix).toBe(`${TENANT}::${campaign.id}::`);
    } finally { spy.mockRestore(); }
  });

  it('a tag naming a campaign of another org, or no campaign, is not indexed', async () => {
    const { campaign } = await ensureDraftCampaign(TENANT, await newBrief(), 'u-1');
    const wrongOrg = await insertTaggedRun({ ...stampCampaignRun(campaign, { role: 'spine' }), orgId: 'org-other' });
    const dangling = await insertTaggedRun({ campaignId: 'cmp_nothing', orgId, goalVersion: 0 });
    const runs = (await listCampaignRuns(TENANT, campaign.id)).map((r) => r.runId);
    expect(runs).not.toContain(wrongOrg.runId);
    expect(await listCampaignRuns(TENANT, 'cmp_nothing')).toEqual([]);
    expect(dangling.runId).toBeTruthy();
  });

  it('deleting the campaign clears its run index; re-ignition starts with a new identity', async () => {
    const brief = await newBrief();
    const { campaign } = await ensureDraftCampaign(TENANT, brief, 'u-1');
    await insertTaggedRun(stampCampaignRun(campaign, { role: 'spine' }));
    expect(await deleteCampaign(TENANT, campaign.id)).toBe(true);
    expect(await listCampaignRuns(TENANT, campaign.id)).toEqual([]);
    expect(await getCampaignByBrief(TENANT, brief.id)).toBeNull();
    const again = await ensureDraftCampaign(TENANT, brief, 'u-1');
    expect(again.created).toBe(true);
    expect(again.campaign.id).not.toBe(campaign.id);
    expect(await getCampaign(TENANT, campaign.id)).toBeNull();
  });
});

describe('ADR 0941 P0 — the frozen goal', () => {
  const GOAL = { outcome: { metric: 'leads' as const, target: 200 }, mediaBudget: { totalMinor: 500_00, currency: 'USD' } };

  it('the frozen goal is stamped at run start and copied, never re-resolved, on :fork', async () => {
    const { campaign } = await ensureDraftCampaign(TENANT, await newBrief(), 'u-1');
    const withGoal = must(await setCampaignGoal(TENANT, campaign.id, GOAL), 'the campaign');
    expect(withGoal.goal?.version).toBe(1);
    const src = await insertTaggedRun(stampCampaignRun(withGoal, { role: 'spine' }));
    expect((await runMeta(src.runId)).campaignGoal).toEqual({ ...GOAL, version: 1 });
    // Edit the goal, then fork: the fork keeps v1.
    await setCampaignGoal(TENANT, campaign.id, { ...GOAL, outcome: { metric: 'leads', target: 999 } });
    const fork = await jf<{ runId: string }>(`/runs/${encodeURIComponent(`${TENANT}/${src.runId}`)}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }) });
    expect(fork.status).toBe(201);
    expect((await runMeta(fork.body.runId)).campaignGoal).toEqual({ ...GOAL, version: 1 });
  });

  it('a goal-less run stays goal-less on :fork after a goal is set', async () => {
    const { campaign } = await ensureDraftCampaign(TENANT, await newBrief(), 'u-1');
    const src = await insertTaggedRun(stampCampaignRun(campaign, { role: 'spine' }));
    expect((await runMeta(src.runId)).campaignGoal).toBeUndefined();
    const withGoal = must(await setCampaignGoal(TENANT, campaign.id, GOAL), 'the campaign');
    expect(await campaignGoalContributor({ tenantId: TENANT, derivedFromRun: true, metadata: { campaignOrchestration: stampCampaignRun(withGoal, { role: 'spine' }) } })).toEqual({});
    const fork = await jf<{ runId: string }>(`/runs/${encodeURIComponent(`${TENANT}/${src.runId}`)}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }) });
    expect((await runMeta(fork.body.runId)).campaignGoal).toBeUndefined();
  });

  it('a goal that moved past the tag\'s version is not stamped', async () => {
    const { campaign } = await ensureDraftCampaign(TENANT, await newBrief(), 'u-1');
    const v1 = must(await setCampaignGoal(TENANT, campaign.id, GOAL), 'the campaign');
    const tag = stampCampaignRun(v1, { role: 'stage' });
    await setCampaignGoal(TENANT, campaign.id, { ...GOAL, outcome: { metric: 'leads', target: 1 } });
    expect(await campaignGoalContributor({ tenantId: TENANT, metadata: { campaignOrchestration: tag } })).toEqual({});
  });

  it('a cleared-then-reset goal never reuses a version', async () => {
    const { campaign } = await ensureDraftCampaign(TENANT, await newBrief(), 'u-1');
    await setCampaignGoal(TENANT, campaign.id, GOAL);
    await setCampaignGoal(TENANT, campaign.id, null);
    expect(must(await setCampaignGoal(TENANT, campaign.id, GOAL), 'the campaign').goal?.version).toBe(2);
  });

  it('a sub-workflow child inherits the tag and the frozen goal verbatim', async () => {
    const parent = { campaignOrchestration: { campaignId: 'cmp_x', orgId, goalVersion: 1 }, campaignGoal: { ...GOAL, version: 1 }, actingUserId: 'u-1' };
    expect(inheritedRunMetadata(parent)).toEqual({ campaignOrchestration: parent.campaignOrchestration, campaignGoal: parent.campaignGoal });
  });
});

describe('ADR 0941 P0 — the run tag reader', () => {
  it('refuses a run whose campaign-ops client stamp names another org (wrong_client)', () => {
    expect(() => readCampaignRunTag({ campaignOrchestration: { campaignId: 'cmp_x', orgId: 'org-a', goalVersion: 0 }, 'openwop-app.campaignOps': { orgId: 'org-b' } }))
      .toThrow(expect.objectContaining({ code: 'wrong_client' }));
  });
  it('a pre-0941 block (briefId only) is not a campaign run', () => {
    expect(readCampaignRunTag({ campaignOrchestration: { briefId: 'b-1', agentId: 'a' } })).toBeNull();
  });
});

describe('ADR 0941 P0 — finalize updates the ignition draft', () => {
  it('first finalize keeps version 1; a re-finalize bumps it', async () => {
    const brief = await newBrief();
    const { campaign } = await ensureDraftCampaign(TENANT, brief, 'u-1');
    const first = await finalizeFromBrief(TENANT, brief, 'u-1');
    expect(first.id).toBe(campaign.id);
    expect(first.version).toBe(1);
    expect(first.finalizedAt).toBeTruthy();
    const second = await finalizeFromBrief(TENANT, brief, 'u-1');
    expect(second.version).toBe(2);
    expect(second.finalizedAt).toBe(first.finalizedAt);
  });

  it('pre-0941 rows are indexed once; a brief with two legacy rows resolves to the oldest', async () => {
    const brief = await newBrief();
    const legacy = (id: string, createdAt: string): MarketingCampaign => ({
      id, tenantId: TENANT, orgId, briefId: brief.id, name: 'Legacy', objective: '', personaIds: [], channels: [],
      status: 'active', version: 1, createdBy: 'u-1', createdAt, updatedAt: createdAt,
    });
    // A new tenant marker would hide these rows; use a fresh tenant for the backfill.
    const t = `org:legacy-${Date.now()}`;
    await __putCampaignRow({ ...legacy('11111111-new', '2026-02-01T00:00:00.000Z'), tenantId: t });
    await __putCampaignRow({ ...legacy('22222222-old', '2026-01-01T00:00:00.000Z'), tenantId: t });
    const found = await getCampaignByBrief(t, brief.id);
    expect(found?.id).toBe('22222222-old');
    const ensured = await ensureDraftCampaign(t, { ...brief, tenantId: t }, 'u-1');
    expect(ensured).toMatchObject({ created: false, campaign: { id: '22222222-old' } });
    // A pre-0941 row was finalized at creation: finalize is a RE-finalize.
    expect((await finalizeFromBrief(t, { ...brief, tenantId: t }, 'u-1')).version).toBe(2);
    expect((await getCampaign(t, '22222222-old'))?.status).toBe('active');
  });
});


describe('campaign retirement isolates a successor from old cleanup', () => {
  it('a concurrently ignited successor keeps its versions and separate project after old deletion resumes', async () => {
    const brief = await newBrief();
    const old = await finalizeFromBrief(TENANT, brief, 'u-1');
    const oldProjectId = must(await getCampaignProjectId(TENANT, old.id), 'old project');
    const list = storage.kvList.bind(storage);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    storage.kvList = async (prefix) => {
      const captured = await list(prefix);
      if (!paused && prefix === `hostext:campaign-orchestration:campaignversion:${TENANT}::${old.id}::`) {
        paused = true; enter(); await released;
      }
      return captured;
    };
    const deleting = deleteCampaign(TENANT, old.id);
    try {
      await Promise.race([entered, deleting.then(() => { throw new Error('deletion never reached the version-cleanup barrier'); })]);
      expect(await getCampaign(TENANT, old.id)).toBeNull();
      const successors = await Promise.all(Array.from({ length: 8 }, () => ensureDraftCampaign(TENANT, brief, 'u-1')));
      expect(successors.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(successors.map((r) => r.campaign.id)).size).toBe(1);
      const next = await finalizeFromBrief(TENANT, brief, 'u-1');
      expect(next.id).not.toBe(old.id);
      const nextProjectId = must(await getCampaignProjectId(TENANT, next.id), 'successor project');
      expect(nextProjectId).not.toBe(oldProjectId);
      const versions = await listCampaignVersions(TENANT, next.id);
      expect(versions).not.toHaveLength(0);
      release();
      expect(await deleting).toBe(true);
      expect(await getCampaign(TENANT, next.id)).toEqual(next);
      expect(await listCampaignVersions(TENANT, next.id)).toEqual(versions);
      expect(await getCampaignProjectId(TENANT, next.id)).toBe(nextProjectId);
      expect((await getProject(TENANT, nextProjectId))?.charter?.status).not.toBe('archived');
      expect((await getProject(TENANT, oldProjectId))?.charter?.status).toBe('archived');
      expect(JSON.parse(must(await storage.kvGet(`hostext:campaign-orchestration:campaign:${TENANT}::${old.id}`), 'retirement marker')))
        .toEqual({ tenantId: TENANT, id: old.id, orgId: old.orgId, retired: true, successorId: next.id });
    } finally { release(); storage.kvList = list; await deleting; }
  });

  it('a legacy UUID campaign is reserved before retirement, even before the first backfill', async () => {
    const tenant = `legacy-retire-${n++}`;
    const org = await createOrg({ tenantId: tenant, createdBy: 'u-1', name: 'Legacy client', ownerSubject: 'u-1' });
    const brief = await createBrief(tenant, org.orgId, 'u-1', { name: 'Legacy', channels: [] });
    const now = new Date().toISOString();
    const legacy: MarketingCampaign = { ...buildCampaignFromBrief(brief), id: `legacy-uuid-${n++}`, createdBy: 'private-person', createdAt: now, updatedAt: now };
    await __putCampaignRow(legacy);
    expect(await deleteCampaign(tenant, legacy.id)).toBe(true);
    const next = await ensureDraftCampaign(tenant, brief, 'u-1');
    expect(next.created).toBe(true);
    expect(next.campaign.id).not.toBe(legacy.id);
    expect(next.campaign.id).not.toBe(briefCampaignId(tenant, brief.id));
    expect(await getCampaignByBrief(tenant, brief.id)).toEqual(next.campaign);
  });

  it('a stale brief-index pointer follows retirement rather than resurrecting or hiding the successor', async () => {
    const brief = await newBrief();
    const old = (await ensureDraftCampaign(TENANT, brief, 'u-1')).campaign;
    await deleteCampaign(TENANT, old.id);
    const next = (await ensureDraftCampaign(TENANT, brief, 'u-1')).campaign;
    await storage.kvSet(`hostext:campaign-orchestration:brief-index:${TENANT}::${brief.id}`, JSON.stringify({ tenantId: TENANT, briefId: brief.id, campaignId: old.id }));
    expect(await getCampaignByBrief(TENANT, brief.id)).toEqual(next);
    expect(await ensureDraftCampaign(TENANT, brief, 'u-1')).toEqual({ campaign: next, created: false });
    expect(await getCampaign(TENANT, old.id)).toBeNull();
    expect((await listCampaigns(TENANT)).filter((c) => c.briefId === brief.id)).toEqual([next]);
  });

  it('an expected retired campaign cannot finalize its brief into the successor', async () => {
    const brief = await newBrief();
    const old = (await ensureDraftCampaign(TENANT, brief, 'u-1')).campaign;
    await deleteCampaign(TENANT, old.id);
    const next = await finalizeFromBrief(TENANT, brief, 'u-1');
    await expect(finalizeFromBrief(TENANT, brief, 'u-1', { expectedCampaignId: old.id })).rejects.toMatchObject({ httpStatus: 404 });
    expect(await getCampaign(TENANT, next.id)).toEqual(next);
    expect(await getCampaign(TENANT, old.id)).toBeNull();
  });

  it('corrupt retirement cycles refuse lookup and ignition without creating another root', async () => {
    const brief = await newBrief();
    const old = (await ensureDraftCampaign(TENANT, brief, 'u-1')).campaign;
    await deleteCampaign(TENANT, old.id);
    await storage.kvSet(`hostext:campaign-orchestration:campaign:${TENANT}::${old.id}`, JSON.stringify({ tenantId: TENANT, id: old.id, orgId, retired: true, successorId: old.id }));
    await expect(getCampaignByBrief(TENANT, brief.id)).rejects.toMatchObject({ httpStatus: 409 });
    await expect(ensureDraftCampaign(TENANT, brief, 'u-1')).rejects.toMatchObject({ httpStatus: 409 });
    expect((await listCampaigns(TENANT)).filter((c) => c.briefId === brief.id)).toEqual([]);
  });

  it.each([false, true])('replay cannot create a campaign or successor (previously deleted: %s)', async (deleted) => {
    const brief = await newBrief();
    if (deleted) await deleteCampaign(TENANT, (await ensureDraftCampaign(TENANT, brief, 'u-1')).campaign.id);
    const hostSuite: StartRunDeps['hostSuite'] = {
      workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
      providerPolicyResolver: { resolveForRun: async () => [] },
    };
    await expect(runWithEffectContext({ runId: 'replay-campaign', replaying: true }, () =>
      runOrchestrationRunTool({ storage, hostSuite }, { briefId: brief.id }, { tenantId: TENANT, actingUserId: 'u-1' })))
      .rejects.toMatchObject({ code: 'replay_source_missing', effectKind: 'dispatch' });
    expect(await getCampaignByBrief(TENANT, brief.id)).toBeNull();
  });
});
