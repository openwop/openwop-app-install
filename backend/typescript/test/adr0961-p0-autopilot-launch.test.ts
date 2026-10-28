/**
 * ADR 0961 P0 — the campaign autopilot launches from a campaign, tagged with it.
 *
 * Real app (memory storage, cookie sessions). Exit criteria (ADR 0961 § Phased
 * plan, P0, as corrected: ADR 0959 installations do not exist yet, so the launch
 * is from the campaign and carries no playbook stamp):
 *   - both toggles gate the routes (404 when either is off);
 *   - a campaign of another client is a uniform 404; a read-only member may see
 *     the preflight but not launch (403);
 *   - the launched run is tagged by the one tag writer (campaign, client org,
 *     goal version, role `spine`) and carries the frozen goal;
 *   - a second launch inside the ignition window reuses the run, and a launch
 *     after it joins the campaign's live spine (one live spine per campaign);
 *   - a `:fork` of the launched run copies the tag and goal verbatim, even after
 *     the goal is edited;
 *   - the spine expands to preflight → start the drafting stage, deterministically;
 *   - a ready campaign passes preflight and the drafting stage starts as its OWN
 *     campaign run (role `stage`, derived id), never a nested sub-chain;
 *   - an incomplete brief stops the run at the preflight node (since P1 it
 *     waits on a checklist card); the drafting stage never starts;
 *   - the surface refuses an untagged or actorless run, an unknown stage, and
 *     a stage start by a read-only person.
 *
 * Sabotage witnesses (each reds the named case; run 2026-10-20):
 *   - `requireFeatureEnabled(req, 'campaign-orchestration', …)` removed from
 *     `requireAutopilot`: "both toggles gate…";
 *   - `loadCampaignScoped(req, 'workspace:write')` → `'workspace:read'` on launch:
 *     "a read-only member…";
 *   - `claimIgnition` result ignored (always start): "a second launch…";
 *   - the surface reading `args.campaignId` instead of the run tag is not
 *     expressible (the surface takes no argument); dropping the `!tag` refusal
 *     reds "the preflight surface refuses…";
 *   - `startWorkflowRun` without the derived `runId`: "the run is tagged…" (the
 *     stage run is not found by its id);
 *   - `taggedCampaignOf(scope, 'workspace:write')` → `'workspace:read'` in
 *     `startStageRun`: "starting a stage needs…";
 *   - the `isStage` arm dropped from `liveAutopilotRun`: "a live drafting STAGE…";
 *   - the `if (live)` join removed: "after the ignition window…";
 *   - `if (!ready)` block removed from the preflight node: "an incomplete brief…".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign, setCampaignGoal } from '../src/features/campaign-orchestration/campaignService.js';
import { readCampaignRunTag } from '../src/features/campaign-orchestration/campaignRunTag.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { buildChainBackedDefinition, getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { buildCampaignAutopilotSurface } from '../src/features/campaign-autopilot/surface.js';
import { AUTOPILOT_CHAIN_ID } from '../src/features/campaign-autopilot/ids.js';
import { stageRunId } from '../src/features/campaign-autopilot/stageRun.js';
import { bareRunId } from './support/bareRunId.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { buildAutonomyStamp, FALLBACK_PRESET, presetPolicy } from '../src/host/autonomyPolicy/index.js';
import { __resetIgnitionClaims } from '../src/host/ignitionGuard.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let TENANT: string;
let adminCookie: string;
let viewerCookie: string;
let adminUser: string;
let viewerUser: string;
let orgA: string;
let orgB: string;

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

interface Res<T> { status: number; body: T }
async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T };
}
const ap = (id: string, leaf: 'preflight' | 'launch'): string => `/host/openwop-app/campaign-autopilot/campaigns/${encodeURIComponent(id)}/${leaf}`;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

/** A campaign whose brief is complete (or not), owned by `orgId`. */
async function campaignFor(orgId: string, complete = true): Promise<MarketingCampaign> {
  const brief = await createBrief(TENANT, orgId, adminUser, {
    name: `Launch ${randomBytes(3).toString('hex')}`,
    ...(complete ? { productName: 'Widget', personaIds: ['p-1'], messaging: { primaryValueProp: 'Faster' } } : {}),
    channels: [{ type: 'email_sequence', enabled: true, config: {} }],
  });
  return (await ensureDraftCampaign(TENANT, brief, adminUser)).campaign;
}

const runOf = async (runId: string) => storage.getRun(bareRunId(runId));

async function untilTerminal(runId: string, ms = 15_000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const s = (await runOf(runId))?.status ?? 'missing';
    if (['completed', 'failed', 'cancelled'].includes(s) || Date.now() > end) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const GOAL = { outcome: { metric: 'leads' as const, target: 200 }, mediaBudget: { totalMinor: 500_00, currency: 'USD' } };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'campaign-autopilot']) await setToggle(id, true);
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:ap-owner' });
  TENANT = ws.tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:ap-admin', source: 'oidc' });
  const viewer = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:ap-viewer', source: 'oidc' });
  adminUser = admin.userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: viewer.userId, displayName: 'Viewer', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: admin.userId, displayName: 'Admin', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: viewer.userId, displayName: 'Viewer', roles: ['viewer'] });
  adminCookie = cookieFor(admin.userId, 'ws:home-ap-admin');
  viewerCookie = cookieFor(viewer.userId, 'ws:home-ap-viewer');
  viewerUser = viewer.userId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0961 P0 — gating and access', () => {
  it('both toggles gate the routes (404 when either is off)', async () => {
    const c = await campaignFor(orgA);
    for (const off of ['campaign-autopilot', 'campaign-orchestration']) {
      await setToggle(off, false);
      try {
        expect((await call(adminCookie, 'GET', ap(c.id, 'preflight'))).status, off).toBe(404);
        expect((await call(adminCookie, 'POST', ap(c.id, 'launch'))).status, off).toBe(404);
      } finally { await setToggle(off, true); }
    }
  });

  it('a campaign of another client is a uniform 404', async () => {
    const other = await campaignFor(orgB);
    expect((await call(adminCookie, 'GET', ap(other.id, 'preflight'))).status).toBe(404);
    expect((await call(adminCookie, 'POST', ap(other.id, 'launch'))).status).toBe(404);
    expect((await call(adminCookie, 'GET', ap('cmp_nothing', 'preflight'))).status).toBe(404);
  });

  it('a read-only member may see the preflight but not launch (403)', async () => {
    const c = await campaignFor(orgA);
    const view = await call<{ canLaunch: boolean }>(viewerCookie, 'GET', ap(c.id, 'preflight'));
    expect(view.status).toBe(200);
    expect(view.body.canLaunch).toBe(false);
    expect((await call<{ canLaunch: boolean }>(adminCookie, 'GET', ap(c.id, 'preflight'))).body.canLaunch).toBe(true);
    expect((await call(viewerCookie, 'POST', ap(c.id, 'launch'))).status).toBe(403);
  });
});

describe('ADR 0961 P0 — the preflight checklist', () => {
  it('names each item, its status and whether it blocks', async () => {
    const ready = await campaignFor(orgA);
    const r = await call<{ preflight: { ready: boolean; items: Array<{ id: string; status: string; blocking: boolean; missing?: string[] }> } }>(adminCookie, 'GET', ap(ready.id, 'preflight'));
    expect(r.status).toBe(200);
    expect(r.body.preflight.ready).toBe(true);
    expect(r.body.preflight.items.map((i) => i.id)).toEqual(['brief', 'brief-complete', 'brief-setup', 'goal']);
    expect(r.body.preflight.items.find((i) => i.id === 'brief-setup')).toMatchObject({ status: 'warn', blocking: false, missing: ['brand', 'kb'] });
    expect(r.body.preflight.items.find((i) => i.id === 'goal')).toMatchObject({ status: 'warn', blocking: false });

    const incomplete = await campaignFor(orgA, false);
    const r2 = await call<{ preflight: { ready: boolean; items: Array<{ id: string; status: string; missing?: string[] }> } }>(adminCookie, 'GET', ap(incomplete.id, 'preflight'));
    expect(r2.body.preflight.ready).toBe(false);
    expect(r2.body.preflight.items.find((i) => i.id === 'brief-complete')).toMatchObject({ status: 'missing', missing: ['productName', 'personaIds', 'messaging.primaryValueProp'] });
  });

  it('the preflight surface refuses an untagged run', async () => {
    const run = { runId: `r-untagged-${randomBytes(4).toString('hex')}`, workflowId: AUTOPILOT_CHAIN_ID, tenantId: TENANT, status: 'running' as const, inputs: {}, metadata: {}, configurable: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await storage.insertRun(run);
    const surface = buildCampaignAutopilotSurface({ tenantId: TENANT, runId: run.runId, actingUserId: adminUser });
    await expect(surface.preflight({})).rejects.toMatchObject({ code: 'forbidden_scope' });
    // And an actorless run is refused before anything is read.
    await expect(buildCampaignAutopilotSurface({ tenantId: TENANT, runId: run.runId }).preflight({})).rejects.toMatchObject({ details: { reason: 'no_acting_user' } });
  });
});

describe('ADR 0961 P0 — the stage surface', () => {
  it('starting a stage needs a known stage and write access on the tagged campaign', async () => {
    const c = await campaignFor(orgA);
    const now = new Date().toISOString();
    const run = { runId: `r-tagged-${randomBytes(4).toString('hex')}`, workflowId: AUTOPILOT_CHAIN_ID, tenantId: TENANT, status: 'running' as const, inputs: {}, metadata: { campaignOrchestration: stampCampaignRun(c, { role: 'spine' }) }, configurable: {}, createdAt: now, updatedAt: now };
    await storage.insertRun(run);
    await expect(buildCampaignAutopilotSurface({ tenantId: TENANT, runId: run.runId, actingUserId: adminUser }).startStage({ stage: 'launch' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(buildCampaignAutopilotSurface({ tenantId: TENANT, runId: run.runId, actingUserId: viewerUser }).startStage({ stage: 'drafts' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    // Caller arguments never retarget the stored campaign tag.
    await expect(buildCampaignAutopilotSurface({ tenantId: TENANT, runId: run.runId, actingUserId: adminUser }).preflight({ orgId: orgB })).resolves.toMatchObject({ campaignId: c.id });
    // The reader may still read the checklist.
    await expect(buildCampaignAutopilotSurface({ tenantId: TENANT, runId: run.runId, actingUserId: viewerUser }).preflight({})).resolves.toMatchObject({ campaignId: c.id });
  });
});

describe('ADR 0961 recovery — frozen stage context', () => {
  it('the internal inheritance seam refuses an unavailable or foreign-tenant source', async () => {
    const foreignId = `foreign-source-${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    await storage.insertRun({ runId: foreignId, workflowId: AUTOPILOT_CHAIN_ID, tenantId: 'foreign-tenant', status: 'running', inputs: {},
      metadata: { campaignForkPosture: 'attended' }, configurable: {}, createdAt: now, updatedAt: now });
    for (const inheritFromRunId of [foreignId, `${foreignId}-missing`]) {
      await expect(startWorkflowRun({ storage, hostSuite }, { tenantId: TENANT, workflowId: AUTOPILOT_CHAIN_ID, inheritFromRunId })).rejects.toMatchObject({ httpStatus: 404 });
    }
  });

  it('an independent stage retains the parent goal, policy and attended fork posture', async () => {
    const c = await campaignFor(orgA);
    await setCampaignGoal(TENANT, c.id, GOAL);
    const frozen = { ...GOAL, version: 1 };
    const now = new Date().toISOString();
    const parentId = `parent-frozen-${randomBytes(4).toString('hex')}`;
    const policy = buildAutonomyStamp({ policy: presetPolicy(FALLBACK_PRESET), source: 'default', campaignId: c.id, orgId: orgA, resolvedAt: now, mcpOrigin: false });
    await storage.insertRun({ runId: parentId, workflowId: AUTOPILOT_CHAIN_ID, tenantId: TENANT, status: 'running', inputs: {},
      metadata: { campaignOrchestration: stampCampaignRun({ ...c, goal: frozen }, { role: 'spine' }), campaignGoal: frozen, campaignAutonomy: policy, campaignForkPosture: 'attended', actingUserId: adminUser },
      configurable: {}, createdAt: now, updatedAt: now });
    await setCampaignGoal(TENANT, c.id, { ...GOAL, outcome: { metric: 'leads', target: 999 } });
    const result = await buildCampaignAutopilotSurface({ tenantId: TENANT, runId: parentId, actingUserId: adminUser }).startStage({ stage: 'drafts' });
    const stage = await runOf(String(result.runId));
    expect(stage?.metadata).toMatchObject({ campaignGoal: frozen, campaignAutonomy: policy, campaignForkPosture: 'attended', campaignOrchestration: { campaignId: c.id, orgId: orgA, role: 'stage', goalVersion: 1 } });
    expect(stage?.parentRunId).toBeUndefined();
  });
});

describe('ADR 0961 P0 — launch', () => {
  it('the spine expands to preflight → start the drafting stage, deterministically', () => {
    const def = getChainBackedWorkflow(AUTOPILOT_CHAIN_ID);
    expect(def).toBeTruthy();
    expect((def?.nodes ?? []).map((n) => n.typeId)).toEqual(['feature.campaign-autopilot.nodes.preflight', 'feature.campaign-autopilot.nodes.start-stage']);
    expect((def?.nodes ?? [])[1]?.config).toMatchObject({ stage: 'drafts' });
    expect(JSON.stringify(def)).not.toContain('core.subWorkflow');
    // Replay determinism: the same chain builds to the same definition every time.
    expect(buildChainBackedDefinition(AUTOPILOT_CHAIN_ID)).toEqual(buildChainBackedDefinition(AUTOPILOT_CHAIN_ID));
  });

  it('the run is tagged with the campaign and carries the frozen goal; a second launch reuses it; :fork copies both verbatim', async () => {
    const c0 = await campaignFor(orgA);
    const c = (await setCampaignGoal(TENANT, c0.id, GOAL)) ?? c0;
    const first = await call<{ runId: string; campaignId: string; reused: boolean }>(adminCookie, 'POST', ap(c.id, 'launch'));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ campaignId: c.id, reused: false });
    const meta = ((await runOf(first.body.runId))?.metadata ?? {}) as Record<string, unknown>;
    expect(readCampaignRunTag(meta)).toEqual({ campaignId: c.id, orgId: orgA, briefId: c.briefId, goalVersion: 1, role: 'spine' });
    expect(meta.campaignGoal).toEqual({ ...GOAL, version: 1 });
    expect(meta.actingUserId).toBe(adminUser);

    const again = await call<{ runId: string; reused: boolean }>(adminCookie, 'POST', ap(c.id, 'launch'));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ runId: first.body.runId, reused: true });

    await untilTerminal(first.body.runId);
    // A ready campaign passes preflight; the drafting stage is its OWN campaign
    // run (derived id, role `stage`, same campaign and frozen goal), and the
    // autopilot run completes with its id instead of waiting on its gates.
    expect((await runOf(first.body.runId))?.status).toBe('completed');
    const stage = await runOf(stageRunId(TENANT, bareRunId(first.body.runId), 'drafts'));
    expect(stage?.workflowId).toBe('campaign-studio.campaign-orchestration');
    expect(stage?.parentRunId).toBeUndefined();
    const stageMeta = (stage?.metadata ?? {}) as Record<string, unknown>;
    expect(readCampaignRunTag(stageMeta)).toEqual({ campaignId: c.id, orgId: orgA, briefId: c.briefId, goalVersion: 1, role: 'stage' });
    expect(stageMeta.campaignGoal).toEqual({ ...GOAL, version: 1 });
    expect(stage?.inputs).toMatchObject({ briefId: c.briefId });
    await setCampaignGoal(TENANT, c.id, { ...GOAL, outcome: { metric: 'leads', target: 999 } });
    const fork = await call<{ runId: string }>(adminCookie, 'POST', `/runs/${encodeURIComponent(`${TENANT}/${bareRunId(first.body.runId)}`)}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forked = ((await runOf(fork.body.runId))?.metadata ?? {}) as Record<string, unknown>;
    expect(forked.campaignOrchestration).toEqual(meta.campaignOrchestration);
    expect(forked.campaignGoal).toEqual({ ...GOAL, version: 1 });
  });

  it('after the ignition window, a launch joins the campaign\'s live spine instead of starting a second', async () => {
    const c = await campaignFor(orgA);
    const now = new Date().toISOString();
    const live = { runId: `r-live-${randomBytes(4).toString('hex')}`, workflowId: AUTOPILOT_CHAIN_ID, tenantId: TENANT, status: 'waiting-approval' as const, inputs: {}, metadata: { campaignOrchestration: stampCampaignRun(c, { role: 'spine' }) }, configurable: {}, createdAt: now, updatedAt: now };
    await insertRunWithStartContext(storage, live);
    await __resetIgnitionClaims();
    const r = await call<{ runId: string; reused: boolean }>(adminCookie, 'POST', ap(c.id, 'launch'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ runId: live.runId, reused: true });
    // Once it ends, a new launch starts a fresh spine.
    await storage.updateRun(live.runId, { status: 'completed' });
    await __resetIgnitionClaims();
    const next = await call<{ runId: string; reused: boolean }>(adminCookie, 'POST', ap(c.id, 'launch'));
    expect(next.status).toBe(201);
    expect(next.body.runId).not.toBe(live.runId);
  });

  it('a live drafting STAGE also counts: a relaunch joins it rather than drafting twice', async () => {
    const c = await campaignFor(orgA);
    const now = new Date().toISOString();
    const stage = { runId: `autopilot-stage-${randomBytes(16).toString('hex')}`, workflowId: 'campaign-studio.campaign-orchestration', tenantId: TENANT, status: 'waiting-approval' as const, inputs: {}, metadata: { campaignOrchestration: stampCampaignRun(c, { role: 'stage' }) }, configurable: {}, createdAt: now, updatedAt: now };
    await insertRunWithStartContext(storage, stage);
    await __resetIgnitionClaims();
    const r = await call<{ runId: string; reused: boolean }>(adminCookie, 'POST', ap(c.id, 'launch'));
    expect(r.body).toMatchObject({ runId: stage.runId, reused: true });
  });

  it('an incomplete brief stops the run at the preflight node; drafting never starts', async () => {
    const c = await campaignFor(orgA, false);
    const r = await call<{ runId: string }>(adminCookie, 'POST', ap(c.id, 'launch'));
    expect(r.status).toBe(201);
    // Since P1 the spine waits on a checklist card instead of failing.
    const end = Date.now() + 15_000;
    let status = '';
    while (Date.now() < end) {
      status = (await runOf(r.body.runId))?.status ?? '';
      if (status !== 'pending' && status !== 'running') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(status).toMatch(/^waiting/);
    expect(await runOf(stageRunId(TENANT, bareRunId(r.body.runId), 'drafts'))).toBeNull();
  });
});
