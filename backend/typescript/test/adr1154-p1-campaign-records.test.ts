/**
 * ADR 1154 P1 — the campaign records the guided flow reads.
 *
 * Real app (memory storage, cookie sessions), real HTTP for the routes.
 *
 *   D3. "New campaign" creates the brief and its draft campaign together; a
 *       brief without a campaign gets one on request (create-or-return); a
 *       brief-step run tag carries role `brief`.
 *   D6. The launch checklist is a read on the campaign's owner: it answers with
 *       `campaign-autopilot` OFF, 404s with `campaign-orchestration` off, and is
 *       the same result the autopilot route returns.
 *   D5. A review carries its campaign. An approval gate on a campaign run names
 *       the campaign from the run's host-written tag; `?campaignId=` keeps only
 *       that campaign's reviews and never widens what the caller may see.
 *   D7. The campaign-intel overview and anomalies reads take `?campaignId=`
 *       and then count only that campaign's records.
 *   D4. A channel run records what it reached on its OWN campaign: the campaign
 *       and the run id come from the stored run, never from an argument; the
 *       write is idempotent by run and channel; it never moves `status`.
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
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign, getCampaign, getCampaignByBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { campaignRunTagForBrief, readCampaignRunTag } from '../src/host/campaignRefs.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { buildCampaignStudioSurface } from '../src/features/campaign-orchestration/surface.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';
import { persistRecords } from '../src/features/campaign-connectors/performanceService.js';
import { computeDerived } from '../src/features/campaign-connectors/csvImport.js';
import { createCampaignSpendApproval } from '../src/host/approvalService.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let TENANT: string;
let adminCookie: string;
let adminUser: string;
let orgA: string;
let orgB: string;
let n = 0;

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

async function post<T = Record<string, unknown>>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
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

async function campaignIn(orgId: string): Promise<MarketingCampaign> {
  const brief = await createBrief(TENANT, orgId, adminUser, {
    name: `Refill ${n++}`,
    productName: 'Widget', personaIds: ['p-1'], messaging: { primaryValueProp: 'Faster' },
    channels: [{ type: 'email_sequence', enabled: true, config: {} }],
  });
  return (await ensureDraftCampaign(TENANT, brief, adminUser)).campaign;
}

async function runWith(metadata: Record<string, unknown>): Promise<string> {
  const now = new Date().toISOString();
  const run: RunRecord = { runId: `r-1154-${n++}`, workflowId: 'campaign-studio.channel.email-sequence', tenantId: TENANT, status: 'running', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now };
  await insertRunWithStartContext(storage, run, { admission: { plan: 'exempt:test-fixture' } });
  return run.runId;
}

const taggedRun = (c: MarketingCampaign): Promise<string> =>
  runWith({ campaignOrchestration: stampCampaignRun(c, { role: 'stage' }), actingUserId: adminUser });

async function openGate(runId: string): Promise<string> {
  const interruptId = `int-1154-${n++}`;
  await storage.insertInterrupt({ interruptId, runId, nodeId: 'approve', kind: 'approval', token: randomBytes(8).toString('hex'), data: { prompt: 'Review the email sequence.' }, createdAt: new Date().toISOString() } as InterruptRecord);
  return interruptId;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await setToggle('campaign-orchestration', true);
  await setToggle('campaign-brief', true);
  await setToggle('campaign-autopilot', false);
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:gf1-owner' });
  TENANT = ws.tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:gf1-admin', source: 'oidc' });
  adminUser = admin.userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  for (const o of [orgA, orgB]) await createMember({ tenantId: TENANT, orgId: o, subject: admin.userId, displayName: 'Admin', roles: ['editor'] });
  adminCookie = cookieFor(admin.userId, 'ws:home-gf1-admin');
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 1154 D3 — a campaign exists from the first click', () => {
  const ORCH = '/host/openwop-app/campaign-orchestration';
  interface Created { campaign: { id: string; briefId: string; orgId: string; status: string; name: string }; brief?: { id: string; orgId: string } }

  it('POST /campaigns creates the brief and its draft campaign together', async () => {
    const r = await post<Created>(`${ORCH}/campaigns`, { orgId: orgA, name: 'Spring refill' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.brief).toMatchObject({ orgId: orgA });
    expect(r.body.campaign).toMatchObject({ briefId: r.body.brief?.id, orgId: orgA, status: 'draft', name: 'Spring refill' });
    // One row per brief: the stored campaign of that brief is this one.
    expect((await getCampaignByBrief(TENANT, r.body.brief!.id))?.id).toBe(r.body.campaign.id);
    expect((await get(`${ORCH}/campaigns/${r.body.campaign.id}`)).status).toBe(200);
  });

  it('POST /campaigns needs a name and the brief toggle', async () => {
    expect((await post(`${ORCH}/campaigns`, { orgId: orgA })).status).toBe(400);
    await setToggle('campaign-brief', false);
    try {
      expect((await post(`${ORCH}/campaigns`, { orgId: orgA, name: 'Off' })).status).toBe(404);
    } finally {
      await setToggle('campaign-brief', true);
    }
  });

  it('for-brief gives an older brief its campaign once, and returns it after', async () => {
    const brief = await createBrief(TENANT, orgA, adminUser, { name: `Older ${n++}` });
    expect(await getCampaignByBrief(TENANT, brief.id)).toBeNull();
    const first = await post<Created>(`${ORCH}/campaigns/for-brief`, { briefId: brief.id });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await post<Created>(`${ORCH}/campaigns/for-brief`, { briefId: brief.id });
    expect(again.status).toBe(200);
    expect(again.body.campaign.id).toBe(first.body.campaign.id);
    expect((await post(`${ORCH}/campaigns/for-brief`, { briefId: 'no-such-brief' })).status).toBe(404);
  });

  it('a brief-step run tag names the campaign with role brief; no campaign, no tag', async () => {
    const c = await campaignIn(orgA);
    const tag = await campaignRunTagForBrief(TENANT, c.briefId, { role: 'brief' });
    expect(tag).toMatchObject({ campaignId: c.id, orgId: orgA, briefId: c.briefId, role: 'brief' });
    // The reader keeps the role (an unknown role is dropped by `readCampaignRunTag`).
    expect(readCampaignRunTag({ campaignOrchestration: tag })?.role).toBe('brief');
    const bare = await createBrief(TENANT, orgA, adminUser, { name: `Bare ${n++}` });
    expect(await campaignRunTagForBrief(TENANT, bare.id, { role: 'brief' })).toBeNull();
  });
});

describe('ADR 1154 D6 — the launch checklist is a read on the campaign', () => {
  const path = (id: string): string => `/host/openwop-app/campaign-orchestration/campaigns/${id}/preflight`;

  it('answers with campaign-autopilot OFF, where the autopilot route 404s', async () => {
    const c = await campaignIn(orgA);
    const own = await get<{ preflight: { campaignId: string; ready: boolean; items: Array<{ id: string; status: string; blocking: boolean }> } }>(path(c.id));
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.preflight.campaignId).toBe(c.id);
    expect(own.body.preflight.items.map((i) => i.id)).toEqual(['brief', 'brief-complete', 'brief-setup', 'goal']);
    expect(own.body.preflight.items.find((i) => i.id === 'brief')).toMatchObject({ status: 'ok', blocking: true });
    // No goal yet: a warning, never a blocker.
    expect(own.body.preflight.items.find((i) => i.id === 'goal')).toMatchObject({ status: 'warn', blocking: false });
    expect((await get(`/host/openwop-app/campaign-autopilot/campaigns/${c.id}/preflight`)).status).toBe(404);
  });

  it('is the same result the autopilot route returns once that toggle is on', async () => {
    const c = await campaignIn(orgA);
    await setToggle('campaign-autopilot', true);
    try {
      const own = await get<{ preflight: unknown }>(path(c.id));
      const auto = await get<{ preflight: unknown }>(`/host/openwop-app/campaign-autopilot/campaigns/${c.id}/preflight`);
      expect(auto.status).toBe(200);
      expect(own.body.preflight).toEqual(auto.body.preflight);
    } finally {
      await setToggle('campaign-autopilot', false);
    }
  });

  it('404s for an unknown campaign, and when campaign-orchestration is off', async () => {
    const c = await campaignIn(orgA);
    expect((await get(path('cmp_nope'))).status).toBe(404);
    await setToggle('campaign-orchestration', false);
    try {
      expect((await get(path(c.id))).status).toBe(404);
    } finally {
      await setToggle('campaign-orchestration', true);
    }
  });
});

describe('ADR 1154 D5 — a review carries its campaign', () => {
  interface Review { reviewId: string; campaignId?: string; runId?: string }
  const list = async (query = ''): Promise<Review[]> => {
    const r = await get<{ items: Review[] }>(`/host/openwop-app/reviews${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.items;
  };

  it('a gate on a campaign run names the campaign from the run tag; ?campaignId= keeps only its reviews', async () => {
    const a = await campaignIn(orgA);
    const b = await campaignIn(orgB);
    const gateA = await openGate(await taggedRun(a));
    const gateB = await openGate(await taggedRun(b));
    const plain = await openGate(await runWith({ actingUserId: adminUser }));

    const all = await list();
    const byId = new Map(all.map((r) => [r.reviewId, r]));
    expect(byId.get(`interrupt:${gateA}`)?.campaignId).toBe(a.id);
    expect(byId.get(`interrupt:${gateB}`)?.campaignId).toBe(b.id);
    // A run with no tag names no campaign (the field is absent, not empty).
    expect(byId.get(`interrupt:${plain}`)).toBeDefined();
    expect(byId.get(`interrupt:${plain}`)).not.toHaveProperty('campaignId');

    const onlyA = await list(`?campaignId=${encodeURIComponent(a.id)}`);
    expect(onlyA.map((r) => r.reviewId)).toEqual([`interrupt:${gateA}`]);
    // A filter narrows; an id that matches nothing lists nothing.
    expect(await list('?campaignId=cmp_nope')).toEqual([]);
  });

  it('gate data cannot name a campaign: only the run tag does', async () => {
    const a = await campaignIn(orgA);
    const runId = await runWith({ actingUserId: adminUser });
    const interruptId = `int-1154-${n++}`;
    await storage.insertInterrupt({ interruptId, runId, nodeId: 'approve', kind: 'approval', token: randomBytes(8).toString('hex'), data: { prompt: 'x', campaignId: a.id }, createdAt: new Date().toISOString() } as InterruptRecord);
    const onlyA = await list(`?campaignId=${encodeURIComponent(a.id)}`);
    expect(onlyA.map((r) => r.reviewId)).not.toContain(`interrupt:${interruptId}`);
  });

  it('a spend approval written for a campaign lists under it; one written without a campaign does not', async () => {
    const a = await campaignIn(orgA);
    const spend = (campaignId?: string) => createCampaignSpendApproval({
      tenantId: TENANT, orgId: orgA, spendKind: 'budget', platform: 'meta', adAccountId: 'act_1', dailyBudgetMinor: 5000,
      spendIdemKey: `k-1154-${n++}`, proposal: 'Raise the daily budget.', ...(campaignId ? { campaignId } : {}),
    });
    const named = await spend(a.id);
    const bare = await spend();
    const onlyA = await list(`?campaignId=${encodeURIComponent(a.id)}`);
    expect(onlyA.map((r) => r.reviewId)).toEqual([`approval:${named.approvalId}`]);
    expect(onlyA[0]?.campaignId).toBe(a.id);
    const all = new Map((await list()).map((r) => [r.reviewId, r]));
    expect(all.get(`approval:${bare.approvalId}`)).toBeDefined();
    expect(all.get(`approval:${bare.approvalId}`)).not.toHaveProperty('campaignId');
  });
});

describe('ADR 1154 D4 — a channel run records its outcome on its own campaign', () => {
  const record = (runId: string | undefined, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    buildCampaignStudioSurface({ tenantId: TENANT, ...(runId ? { runId } : {}) }).recordChannelOutcome(args) as Promise<Record<string, unknown>>;

  it('writes the state under the run\'s own id, and never moves status', async () => {
    const c = await campaignIn(orgA);
    const runId = await taggedRun(c);
    expect(await record(runId, { channel: 'email_sequence', state: 'awaiting-review' })).toMatchObject({ recorded: true, changed: true, campaignId: c.id });
    const after = await getCampaign(TENANT, c.id);
    expect(after?.channelState?.email_sequence).toMatchObject({ runId, state: 'awaiting-review' });
    expect(after?.status).toBe('draft');
  });

  it('is idempotent by run and channel: a repeat changes nothing and keeps the first time', async () => {
    const c = await campaignIn(orgA);
    const runId = await taggedRun(c);
    await record(runId, { channel: 'email_sequence', state: 'approved' });
    const first = (await getCampaign(TENANT, c.id))?.channelState?.email_sequence;
    expect(await record(runId, { channel: 'email_sequence', state: 'approved' })).toMatchObject({ recorded: true, changed: false });
    expect((await getCampaign(TENANT, c.id))?.channelState?.email_sequence).toEqual(first);
  });

  it('a newer run of the same channel replaces the entry; another channel is untouched', async () => {
    const c = await campaignIn(orgA);
    const older = await taggedRun(c);
    const newer = await taggedRun(c);
    await record(older, { channel: 'email_sequence', state: 'rejected' });
    await record(older, { channel: 'social_posts', state: 'approved' });
    await record(newer, { channel: 'email_sequence', state: 'drafting' });
    const state = (await getCampaign(TENANT, c.id))?.channelState;
    expect(state?.email_sequence).toMatchObject({ runId: newer, state: 'drafting' });
    expect(state?.social_posts).toMatchObject({ runId: older, state: 'approved' });
  });

  it('an argument cannot name another campaign or run', async () => {
    const mine = await campaignIn(orgA);
    const theirs = await campaignIn(orgB);
    const runId = await taggedRun(mine);
    await record(runId, { channel: 'email_sequence', state: 'approved', campaignId: theirs.id, runId: 'r-forged' });
    expect((await getCampaign(TENANT, theirs.id))?.channelState).toBeUndefined();
    expect((await getCampaign(TENANT, mine.id))?.channelState?.email_sequence).toMatchObject({ runId, state: 'approved' });
  });

  it('refuses typed: an untagged run, no run, an unknown channel, an unknown state', async () => {
    const c = await campaignIn(orgA);
    const tagged = await taggedRun(c);
    const untagged = await runWith({ actingUserId: adminUser });
    expect(await record(untagged, { channel: 'email_sequence', state: 'approved' })).toMatchObject({ recorded: false, error: { code: 'not_a_campaign_run' } });
    expect(await record(undefined, { channel: 'email_sequence', state: 'approved' })).toMatchObject({ recorded: false, error: { code: 'not_a_campaign_run' } });
    expect(await record(tagged, { channel: 'billboard', state: 'approved' })).toMatchObject({ recorded: false, error: { code: 'unknown_channel' } });
    expect(await record(tagged, { channel: 'email_sequence', state: 'live' })).toMatchObject({ recorded: false, error: { code: 'unknown_state' } });
    expect((await getCampaign(TENANT, c.id))?.channelState).toBeUndefined();
  });
});

describe('ADR 1154 D7 — campaign-intel reads narrow to one campaign', () => {
  const row = (campaignName: string, impressions: number) => {
    const base = { spend: 100, impressions, clicks: 10, conversions: 1, revenue: 200 };
    return { platform: 'meta' as const, campaignName, adSet: 'a', date: '2026-07-01', ...base, ...computeDerived(base) };
  };
  interface Overview { funnel: Array<{ platform: string; impressions: number }> }
  const overview = (query: string) => get<Overview>(`/host/openwop-app/campaign-intel/overview?orgId=${encodeURIComponent(orgA)}${query}`);

  it('overview counts the whole client without the filter, and one campaign with it', async () => {
    await setToggle('campaign-intel', true);
    const one = await campaignIn(orgA);
    const two = await campaignIn(orgA);
    await persistRecords(TENANT, orgA, [row('One', 1000)], 'csv', one.id);
    await persistRecords(TENANT, orgA, [row('Two', 300)], 'csv', two.id);

    const whole = await overview('');
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    expect(whole.body.funnel).toEqual([expect.objectContaining({ platform: 'meta', impressions: 1300 })]);
    expect((await overview(`&campaignId=${encodeURIComponent(one.id)}`)).body.funnel).toEqual([expect.objectContaining({ impressions: 1000 })]);
    expect((await overview(`&campaignId=${encodeURIComponent(two.id)}`)).body.funnel).toEqual([expect.objectContaining({ impressions: 300 })]);
    // Another client's campaign id matches nothing in this client's records.
    const foreign = await campaignIn(orgB);
    expect((await overview(`&campaignId=${encodeURIComponent(foreign.id)}`)).body.funnel).toEqual([]);
  });

  it('attribution keeps only the named campaign\'s row, with the same numbers as the whole report', async () => {
    await setToggle('campaign-intel', true);
    interface Report { rows: Array<{ campaignId: string; spend: number }>; unattributedConversions: number }
    const attribution = (query: string) => get<Report>(`/host/openwop-app/campaign-intel/attribution?orgId=${encodeURIComponent(orgA)}${query}`);
    const one = await campaignIn(orgA);
    await persistRecords(TENANT, orgA, [row('Attributed', 500)], 'csv', one.id);

    const whole = await attribution('');
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    expect(whole.body.rows.length).toBeGreaterThan(1);
    const mine = whole.body.rows.find((r) => r.campaignId === one.id);
    expect(mine?.spend).toBe(100);

    const narrowed = await attribution(`&campaignId=${encodeURIComponent(one.id)}`);
    expect(narrowed.body.rows).toEqual([mine]);
    expect(narrowed.body.unattributedConversions).toBe(whole.body.unattributedConversions);
    const foreign = await campaignIn(orgB);
    expect((await attribution(`&campaignId=${encodeURIComponent(foreign.id)}`)).body.rows).toEqual([]);
  });
});
