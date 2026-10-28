/**
 * ADR 0960 P0 — the campaign command snapshot.
 *
 * Real app (memory storage, cookie sessions). Exit criteria (ADR 0960 § Phased
 * plan, P0): a client-B operator gets 404 on client A's campaign; a spoofed
 * `campaignOrchestration` in `POST /runs` metadata is stripped (so the run never
 * reaches the campaign's snapshot). Also:
 *   - a campaign run waiting on a gate shows as a run, its live nodes, and one
 *     gate — and NO interrupt token appears anywhere in the payload;
 *   - an index row whose run no longer carries this campaign's tag is dropped;
 *   - the toggle gates the route; sections whose owner is absent say so.
 *
 * Sabotage witnesses (each reds the named case; run 2026-10-20):
 *   - `loadCampaignScoped(req, 'workspace:read')` swapped for a bare
 *     `getCampaign`: "a client-B operator…";
 *   - the explicit gate fields replaced by `{ ...i, ageMs }`: "…no interrupt token…";
 *   - the stored-tag re-check removed: "an index row whose run…".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { CAMPAIGN_RUN_TAG_KEY, stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { bareRunId } from './support/bareRunId.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let TENANT: string;
let memberA: string;
let cookieA: string;
let cookieB: string;
let cookieAdmin: string;
let orgA: string;
let orgB: string;
const GATED = `adr0960.gated.${randomBytes(4).toString('hex')}`;

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; raw: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

async function campaignIn(orgId: string): Promise<MarketingCampaign> {
  const brief = await createBrief(TENANT, orgId, memberA, { name: `C ${randomBytes(3).toString('hex')}`, channels: [] });
  return (await ensureDraftCampaign(TENANT, brief, memberA)).campaign;
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Snapshot {
  campaign: { id: string; orgId: string };
  runs: Array<{ runId: string; status: string; role: string }>;
  nodes: Array<{ runId: string; nodeId: string; status: string }>;
  gates: Array<{ interruptId: string; runId: string; nodeId: string; kind: string }>;
  unavailable: Record<string, string>;
}
const commandOf = (cookie: string, id: string) => call<{ command: Snapshot }>(cookie, 'GET', `/host/openwop-app/campaign-orchestration/campaigns/${encodeURIComponent(id)}/command`);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await setToggle('campaign-orchestration', true);
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:cc-owner' });
  TENANT = ws.tenantId;
  const a = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:cc-a', source: 'oidc' });
  const b = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:cc-b', source: 'oidc' });
  memberA = a.userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: a.userId, displayName: 'A', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: b.userId, displayName: 'B', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: a.userId, displayName: 'A', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: b.userId, displayName: 'B', roles: ['editor'] });
  cookieA = cookieFor(a.userId, 'ws:home-cc-a');
  cookieB = cookieFor(b.userId, 'ws:home-cc-b');
  // A workspace admin for setup (registering the workflow, the spoof attempt).
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:cc-admin', source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  cookieAdmin = cookieFor(admin.userId, 'ws:home-cc-admin');
  // A tiny gated workflow, registered through the real route.
  const reg = await call(cookieAdmin, 'POST', '/host/openwop-app/workflows', { workflowId: GATED, nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { title: 'Review' } }], edges: [] });
  expect([200, 201], reg.raw).toContain(reg.status);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0960 P0 — the command snapshot', () => {
  it('a client-B operator gets 404 on client A\'s campaign; the toggle gates the route', async () => {
    const c = await campaignIn(orgA);
    expect((await commandOf(cookieA, c.id)).status).toBe(200);
    expect((await commandOf(cookieB, c.id)).status).toBe(404);
    expect((await commandOf(cookieB, 'cmp_nothing')).status).toBe(404);
    await setToggle('campaign-orchestration', false);
    try { expect((await commandOf(cookieA, c.id)).status).toBe(404); } finally { await setToggle('campaign-orchestration', true); }
  });

  it('a campaign run waiting on a gate shows as a run, its live node and one gate — and no interrupt token appears', async () => {
    const c = await campaignIn(orgA);
    const runId = await startWorkflowRun({ storage, hostSuite }, {
      tenantId: TENANT, workflowId: GATED, inputs: {},
      metadata: { actingUserId: memberA, [CAMPAIGN_RUN_TAG_KEY]: stampCampaignRun(c, { role: 'stage' }) },
    });
    expect(runId).toBeTruthy();
    const id = bareRunId(runId as string);
    await until(() => storage.getRun(id), (r) => !!r && r.status.startsWith('waiting'));
    const open = await storage.listOpenInterrupts(id);
    expect(open).toHaveLength(1);
    const res = await until(() => commandOf(cookieA, c.id), (r) => (r.body?.command?.gates ?? []).length > 0);
    const snap = res.body.command;
    expect(snap.runs).toEqual([expect.objectContaining({ runId: id, role: 'stage' })]);
    expect(snap.runs[0]?.status).toMatch(/^waiting/);
    expect(snap.nodes).toEqual([expect.objectContaining({ runId: id, status: 'suspended' })]);
    expect(snap.gates).toEqual([expect.objectContaining({ runId: id, interruptId: open[0]?.interruptId, kind: 'approval' })]);
    expect(res.raw).not.toContain(open[0]?.token as string);
    expect(res.raw).not.toContain('"token"');
    expect(snap.unavailable).toMatchObject({ autonomy: 'campaign-orchestration.autonomy', playbook: 'campaign-playbooks' });
  });

  it('a spoofed campaign tag in POST /runs metadata is stripped, so the run never reaches the snapshot', async () => {
    const c = await campaignIn(orgA);
    const created = await call<{ runId: string }>(cookieAdmin, 'POST', '/runs', {
      workflowId: GATED, inputs: {},
      metadata: { campaignOrchestration: { campaignId: c.id, orgId: orgA, goalVersion: 0, role: 'spine' } },
    });
    expect(created.status, created.raw).toBe(201);
    const meta = ((await storage.getRun(bareRunId(created.body.runId)))?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.campaignOrchestration).toBeUndefined();
    expect((await commandOf(cookieA, c.id)).body.command.runs).toEqual([]);
  });

  it('an index row whose run no longer carries this campaign\'s tag is dropped', async () => {
    const c = await campaignIn(orgA);
    const other = await campaignIn(orgA);
    const now = new Date().toISOString();
    const run = { runId: `r-cc-${randomBytes(4).toString('hex')}`, workflowId: GATED, tenantId: TENANT, status: 'completed' as const, inputs: {}, metadata: { [CAMPAIGN_RUN_TAG_KEY]: stampCampaignRun(c, { role: 'spine' }) }, configurable: {}, createdAt: now, updatedAt: now };
    await insertRunWithStartContext(storage, run);
    expect((await commandOf(cookieA, c.id)).body.command.runs.map((r) => r.runId)).toEqual([run.runId]);
    await storage.updateRun(run.runId, { metadata: { [CAMPAIGN_RUN_TAG_KEY]: stampCampaignRun(other, { role: 'spine' }) } });
    expect((await commandOf(cookieA, c.id)).body.command.runs).toEqual([]);
  });
});

describe('ADR 0960 P1 — the run definition for the read-only graph', () => {
  it('returns the definition a campaign run executed, only for a run of that campaign and only to its client', async () => {
    const c = await campaignIn(orgA);
    const other = await campaignIn(orgA);
    const runId = bareRunId((await startWorkflowRun({ storage, hostSuite }, {
      tenantId: TENANT, workflowId: GATED, inputs: {},
      metadata: { actingUserId: memberA, [CAMPAIGN_RUN_TAG_KEY]: stampCampaignRun(c, { role: 'stage' }) },
    })) as string);
    await until(() => storage.getRun(runId), (r) => !!r && r.status !== 'pending');
    const path = (cid: string, rid: string) => `/host/openwop-app/campaign-orchestration/campaigns/${encodeURIComponent(cid)}/command/runs/${encodeURIComponent(rid)}/definition`;
    const ok = await call<{ workflowId: string; definition: { nodes: Array<{ nodeId: string }> } }>(cookieA, 'GET', path(c.id, runId));
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body.workflowId).toBe(GATED);
    expect(ok.body.definition.nodes.map((n) => n.nodeId)).toEqual(['gate']);
    // Another campaign's id, another client, an unknown run: all a uniform 404.
    expect((await call(cookieA, 'GET', path(other.id, runId))).status).toBe(404);
    expect((await call(cookieB, 'GET', path(c.id, runId))).status).toBe(404);
    expect((await call(cookieA, 'GET', path(c.id, 'r-nothing'))).status).toBe(404);
  });
});
