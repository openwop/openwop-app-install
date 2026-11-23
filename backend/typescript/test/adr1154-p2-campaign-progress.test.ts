/**
 * ADR 1154 P2 — a campaign's place on the guided path is a READ.
 *
 * Real app (memory storage, cookie sessions), real HTTP for the routes; the
 * fold itself is pure and is driven with real rows changed one field at a time.
 *
 *   Fold.   The six steps come out in order; the current step is the first one
 *           not done; a waiting decision outranks the path; a brief or approvals
 *           read that failed is `unknown`, never done and never not started; a
 *           brief of another client is no brief.
 *   Route.  `GET …/campaigns/:id/progress` returns that fold plus detail, counts
 *           an open gate on the campaign's own run as waiting, writes nothing,
 *           and 404s for an unknown campaign and with the toggle off.
 *   Home.   `GET …/home` lists each campaign with the SAME current step the
 *           workspace read gives, and a brief that has no campaign yet.
 *   Chat.   The Strategist's status tool returns the same fold for a campaign,
 *           and nothing without an acting user.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createBrief, getBrief } from '../src/features/campaign-brief/briefService.js';
import type { CampaignBrief } from '../src/features/campaign-brief/types.js';
import { ensureDraftCampaign, getCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { CAMPAIGN_STEPS, foldProgress, type CampaignProgress } from '../src/features/campaign-orchestration/progress.js';
import { runStatusTool } from '../src/features/campaign-orchestration/agentTools.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let TENANT: string;
let adminCookie: string;
let adminUser: string;
let orgA: string;
let orgB: string;
let n = 0;

const ORCH = '/host/openwop-app/campaign-orchestration';

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

async function get<T = Record<string, unknown>>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: adminCookie } });
  const raw = await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T };
}

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

async function briefIn(orgId: string): Promise<CampaignBrief> {
  return createBrief(TENANT, orgId, adminUser, {
    name: `Refill ${n++}`,
    productName: 'Widget', personaIds: ['p-1'], messaging: { primaryValueProp: 'Faster' },
    channels: [{ type: 'email_sequence', enabled: true, config: {} }],
  });
}

async function campaignIn(orgId: string): Promise<{ campaign: MarketingCampaign; brief: CampaignBrief }> {
  const brief = await briefIn(orgId);
  return { campaign: (await ensureDraftCampaign(TENANT, brief, adminUser)).campaign, brief };
}

async function openGateOn(c: MarketingCampaign): Promise<void> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `r-1154p2-${n++}`, workflowId: 'campaign-studio.channel.email-sequence', tenantId: TENANT, status: 'running', inputs: {},
    metadata: { campaignOrchestration: stampCampaignRun(c, { role: 'stage' }), actingUserId: adminUser }, configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run, { admission: { plan: 'exempt:test-fixture' } });
  await storage.insertInterrupt({ interruptId: `int-1154p2-${n++}`, runId: run.runId, nodeId: 'approve', kind: 'approval', token: randomBytes(8).toString('hex'), data: { prompt: 'Review the email sequence.' }, createdAt: now } as InterruptRecord);
}

const stateOf = (p: CampaignProgress, step: string): string | undefined => p.steps.find((s) => s.step === step)?.state;

/** A brief that asks for nothing more: complete, message approved, confirmed. */
const finished = (b: CampaignBrief): CampaignBrief => ({
  ...b, status: 'confirmed', brandId: 'brand-1', kbCollectionId: 'kb-1', kernelStale: false,
  kernel: { headline: 'Faster refills', supportingStatement: 'In a day.', proofPoints: ['9 in 10 reorder'], primaryCta: 'Reorder', secondaryCta: '', tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-11-21T00:00:00.000Z' },
});
const GOAL = { outcome: { metric: 'purchases' as const, target: 500 }, version: 1 };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await setToggle('campaign-orchestration', true);
  await setToggle('campaign-brief', true);
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:gf2-owner' });
  TENANT = ws.tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:gf2-admin', source: 'oidc' });
  adminUser = admin.userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  for (const o of [orgA, orgB]) await createMember({ tenantId: TENANT, orgId: o, subject: admin.userId, displayName: 'Admin', roles: ['editor'] });
  adminCookie = cookieFor(admin.userId, 'ws:home-gf2-admin');
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 1154 D1 — the fold', () => {
  it('walks the path one step at a time as the records fill in', async () => {
    const { campaign, brief } = await campaignIn(orgA);

    // A fresh campaign: the brief exists but has no approved message.
    let p = foldProgress({ campaign, brief, waiting: 0 });
    expect(p.steps.map((s) => s.step)).toEqual([...CAMPAIGN_STEPS]);
    expect(p).toMatchObject({ current: 'brief', next: 'complete-brief' });
    expect(p.steps[0]).toMatchObject({ state: 'in-progress' });
    expect(p.steps[0]!.missing).toContain('message');

    // Brief done; no goal and no plan.
    const done = finished(brief);
    p = foldProgress({ campaign, brief: done, waiting: 0 });
    expect(p).toMatchObject({ current: 'plan', next: 'set-goal' });
    expect(p.steps[1]).toMatchObject({ state: 'not-started', missing: ['goal', 'plan'] });

    // Goal set: the plan is half made.
    let c: MarketingCampaign = { ...campaign, goal: GOAL };
    p = foldProgress({ campaign: c, brief: done, waiting: 0 });
    expect(p).toMatchObject({ current: 'plan', next: 'make-plan' });
    expect(p.steps[1]).toMatchObject({ state: 'in-progress', missing: ['plan'] });

    // Plan done: channels have nothing yet.
    c = { ...c, productionPlanId: 'plan-1' };
    p = foldProgress({ campaign: c, brief: done, waiting: 0 });
    expect(p).toMatchObject({ current: 'create', next: 'draft-channels' });
    expect(p.steps[2]).toMatchObject({ state: 'not-started', channels: [{ channel: 'email_sequence', state: 'not-started' }] });
    expect(stateOf(p, 'review')).toBe('not-started');

    // The channel draft is approved: nothing waits, so the next move is to launch.
    c = { ...c, channelState: { email_sequence: { runId: 'r-1', state: 'approved', at: '2026-11-21T00:00:00.000Z' } } };
    p = foldProgress({ campaign: c, brief: done, waiting: 0 });
    expect(stateOf(p, 'create')).toBe('done');
    expect(stateOf(p, 'review')).toBe('done');
    expect(p).toMatchObject({ current: 'launch', next: 'launch' });

    // Live: launch is done and measuring has started.
    p = foldProgress({ campaign: { ...c, status: 'active' }, brief: done, waiting: 0 });
    expect(stateOf(p, 'launch')).toBe('done');
    expect(p).toMatchObject({ current: 'measure', next: 'view-results' });
    expect(foldProgress({ campaign: { ...c, status: 'paused' }, brief: done, waiting: 0 }).next).toBe('resume');
    expect(stateOf(foldProgress({ campaign: { ...c, status: 'completed' }, brief: done, waiting: 0 }), 'measure')).toBe('done');
  });

  it('a waiting decision is the next action, and Review needs you', async () => {
    const { campaign, brief } = await campaignIn(orgA);
    const c: MarketingCampaign = { ...campaign, goal: GOAL, productionPlanId: 'plan-1', channelState: { email_sequence: { runId: 'r-1', state: 'awaiting-review', at: '2026-11-21T00:00:00.000Z' } } };
    const p = foldProgress({ campaign: c, brief: finished(brief), waiting: 2 });
    expect(stateOf(p, 'create')).toBe('needs-you');
    expect(p.steps[3]).toMatchObject({ state: 'needs-you', waiting: 2 });
    expect(p).toMatchObject({ current: 'create', next: 'review-waiting' });
  });

  it('a rejected draft sends the user back to redo it', async () => {
    const { campaign, brief } = await campaignIn(orgA);
    const c: MarketingCampaign = { ...campaign, goal: GOAL, productionPlanId: 'plan-1', channelState: { email_sequence: { runId: 'r-1', state: 'rejected', at: '2026-11-21T00:00:00.000Z' } } };
    expect(foldProgress({ campaign: c, brief: finished(brief), waiting: 0 })).toMatchObject({ current: 'create', next: 'redo-rejected' });
  });

  it('what could not be read is unknown: never done, never not started', async () => {
    const { campaign, brief } = await campaignIn(orgA);
    const c: MarketingCampaign = { ...campaign, goal: GOAL, productionPlanId: 'plan-1' };

    let p = foldProgress({ campaign: c, brief: 'unknown', waiting: 0 });
    expect(stateOf(p, 'brief')).toBe('unknown');
    expect(p.current).toBe('brief');

    p = foldProgress({ campaign: c, brief: finished(brief), waiting: 'unknown' });
    expect(stateOf(p, 'review')).toBe('unknown');

    // Finalized before channel outcomes were recorded: drafts exist that this read cannot see.
    p = foldProgress({ campaign: { ...c, finalizedAt: '2026-10-01T00:00:00.000Z' }, brief: finished(brief), waiting: 0 });
    expect(stateOf(p, 'create')).toBe('unknown');
    expect(stateOf(p, 'review')).toBe('unknown');
    expect(p.current).toBe('create');
  });

  it('a brief of another client is no brief for this campaign', async () => {
    const { campaign } = await campaignIn(orgA);
    const foreign = finished(await briefIn(orgB));
    const p = foldProgress({ campaign, brief: foreign, waiting: 0 });
    expect(p.steps[0]).toMatchObject({ state: 'not-started' });
    expect(p.next).toBe('write-brief');
  });
});

describe('ADR 1154 D1 — GET …/campaigns/:id/progress', () => {
  interface Body { progress: CampaignProgress & { detail: Record<string, { status: string; value?: Record<string, unknown> }> } }

  it('returns the fold of the stored rows plus detail, and writes nothing', async () => {
    const { campaign, brief } = await campaignIn(orgA);
    const before = await getCampaign(TENANT, campaign.id);
    const r = await get<Body>(`${ORCH}/campaigns/${campaign.id}/progress`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { detail, ...fold } = r.body.progress;
    expect(fold).toEqual(foldProgress({ campaign, brief, waiting: 0 }));
    expect(detail.preflight).toMatchObject({ status: 'ok', value: { campaignId: campaign.id } });
    expect(detail.runs).toEqual({ status: 'ok', value: { count: 0 } });
    expect(detail.reviewWindows).toEqual({ status: 'ok', value: { count: 0 } });
    expect(detail.plans).toEqual({ status: 'ok', value: { count: 0 } });
    // With the canvas feature off the section says so; it is not shown as zero plans.
    await setToggle('campaign-studio', false);
    try {
      const off = await get<Body>(`${ORCH}/campaigns/${campaign.id}/progress`);
      expect(off.body.progress.detail.plans).toEqual({ status: 'unavailable' });
      expect(off.body.progress.current).toBe(fold.current);
    } finally {
      await setToggle('campaign-studio', true);
    }
    expect(await getCampaign(TENANT, campaign.id)).toEqual(before);
    expect((await getBrief(TENANT, brief.id))?.updatedAt).toBe(brief.updatedAt);
  });

  it('counts an open gate on the campaign\'s own run, and not another campaign\'s', async () => {
    const a = await campaignIn(orgA);
    const b = await campaignIn(orgA);
    await openGateOn(a.campaign);
    const pa = (await get<Body>(`${ORCH}/campaigns/${a.campaign.id}/progress`)).body.progress;
    expect(pa.steps[3]).toMatchObject({ step: 'review', state: 'needs-you', waiting: 1 });
    expect(pa.detail.runs).toEqual({ status: 'ok', value: { count: 1 } });
    const pb = (await get<Body>(`${ORCH}/campaigns/${b.campaign.id}/progress`)).body.progress;
    expect(pb.steps[3]).toMatchObject({ step: 'review', waiting: 0 });
  });

  it('404s for an unknown campaign, and when campaign-orchestration is off', async () => {
    const { campaign } = await campaignIn(orgA);
    expect((await get(`${ORCH}/campaigns/nope/progress`)).status).toBe(404);
    await setToggle('campaign-orchestration', false);
    try {
      expect((await get(`${ORCH}/campaigns/${campaign.id}/progress`)).status).toBe(404);
      expect((await get(`${ORCH}/home`)).status).toBe(404);
    } finally {
      await setToggle('campaign-orchestration', true);
    }
  });
});

describe('ADR 1154 — GET …/home', () => {
  interface Home {
    home: {
      campaigns: Array<{ id: string; orgId: string; current: string; next: string; waiting: number | null; steps: Array<{ step: string; state: string }> }>;
      briefsWithoutCampaign: Array<{ briefId: string; orgId: string }>;
      sections: Record<string, string>;
    };
  }

  it('lists each campaign at the same step its workspace read gives, with its waiting count', async () => {
    const a = await campaignIn(orgA);
    await openGateOn(a.campaign);
    const r = await get<Home>(`${ORCH}/home`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.home.sections).toEqual({ briefs: 'ok', waiting: 'ok' });
    const row = r.body.home.campaigns.find((c) => c.id === a.campaign.id);
    const one = (await get<{ progress: CampaignProgress }>(`${ORCH}/campaigns/${a.campaign.id}/progress`)).body.progress;
    expect(row).toMatchObject({ orgId: orgA, current: one.current, next: one.next, waiting: 1 });
    expect(row?.steps).toEqual(one.steps.map((s) => ({ step: s.step, state: s.state })));
  });

  it('lists a brief that has no campaign yet, and stops once it has one', async () => {
    const lone = await briefIn(orgB);
    let home = (await get<Home>(`${ORCH}/home`)).body.home;
    expect(home.briefsWithoutCampaign).toContainEqual(expect.objectContaining({ briefId: lone.id, orgId: orgB }));
    await ensureDraftCampaign(TENANT, lone, adminUser);
    home = (await get<Home>(`${ORCH}/home`)).body.home;
    expect(home.briefsWithoutCampaign.some((b) => b.briefId === lone.id)).toBe(false);
  });

  it('?orgId= keeps one client', async () => {
    await campaignIn(orgA);
    await campaignIn(orgB);
    const home = (await get<Home>(`${ORCH}/home?orgId=${orgB}`)).body.home;
    expect(home.campaigns.length).toBeGreaterThan(0);
    expect(home.campaigns.every((c) => c.orgId === orgB)).toBe(true);
    expect(home.briefsWithoutCampaign.every((b) => b.orgId === orgB)).toBe(true);
  });
});

describe('ADR 1154 D10 — the status tool returns the same read', () => {
  const tool = async (input: Record<string, unknown>, actingUserId?: string): Promise<Record<string, unknown>> =>
    JSON.parse((await runStatusTool(input, { tenantId: TENANT, ...(actingUserId ? { actingUserId } : {}) } as never)).content) as Record<string, unknown>;

  it('a campaignId gives the fold the route gives', async () => {
    const a = await campaignIn(orgA);
    await openGateOn(a.campaign);
    const { detail: _detail, ...fold } = (await get<{ progress: CampaignProgress & { detail: unknown } }>(`${ORCH}/campaigns/${a.campaign.id}/progress`)).body.progress;
    expect((await tool({ campaignId: a.campaign.id }, adminUser)).progress).toEqual(fold);
  });

  it('fails empty without an acting user, and for a campaign that does not exist', async () => {
    const a = await campaignIn(orgA);
    expect(await tool({ campaignId: a.campaign.id })).toEqual({ campaigns: [], brief: null });
    expect(await tool({ campaignId: 'nope' }, adminUser)).toEqual({ campaigns: [], brief: null });
  });
});
