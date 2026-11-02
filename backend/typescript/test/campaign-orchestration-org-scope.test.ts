/**
 * Campaign-orchestration surface org scoping (security fix, 2026-10-20; the
 * campaign-brief fix's shape, reported by build-0906-domains).
 *
 * `getCampaign`, `attachAssets` (a write) and `finalizeFromBrief` (a write) on
 * `ctx.features['campaign-orchestration']` were tenant-only by id, so in an
 * agency workspace a client-A run could read client B's campaign, attach assets
 * to it, or finalize B's brief into B's campaign. Now:
 *  - `orgId` given: the row must belong to it (uniform not-found otherwise);
 *  - `orgId` absent: the run's person (actor, else causing member) must hold the
 *    scope in the ROW's org (`workspace:write` for the two writes);
 *  - an actorless, causeless system run keeps the tenant-trusted model.
 *
 * Driven through the real seam (`buildFeatureSurfaces`).
 *
 * Tracker: TST-CBA-6 (/grade-tests wave 67). Red when (probe-witnessed,
 * 2026-10-29): `mayUseOrg` stops comparing the row's org with a given `orgId`
 * (case 2); stops checking the person in the row's org (cases 1, 3, 4); the list
 * stops filtering by readable org (cases 1, 3); a personless system run is no
 * longer tenant-trusted (case 3); `finalizeFromBrief` reads at the
 * `workspace:read` bar (case 4); the seam floor's `methodScopes` for the two
 * writes drop to `workspace:read` (case 4, with `orgId` passed — the floor runs
 * only then); a tagged run's live-membership recheck is skipped (revocation cases).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces, type FeatureSurface } from '../src/host/featureSurfaces.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import type { Storage } from '../src/storage/storage.js';
import { deleteMember, listMembers } from '../src/host/accessControlService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief, getCampaign } from '../src/features/campaign-orchestration/campaignService.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'campaign-brief', 'campaign-orchestration']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface LoginBody { user: { userId: string } }
interface OrgBody { orgId: string }
function client(): { post: (p: string, b?: unknown) => Promise<{ status: number; body: unknown }> } {
  let cookie = '';
  return {
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      const parsed: unknown = await res.json().catch(() => undefined);
      return { status: res.status, body: parsed };
    },
  };
}
function userIdOf(body: unknown): string {
  const id = (body as Partial<LoginBody> | undefined)?.user?.userId;
  if (typeof id !== 'string') throw new Error(`login failed: ${JSON.stringify(body)}`);
  return id;
}
function orgIdOf(body: unknown): string {
  const id = (body as Partial<OrgBody> | undefined)?.orgId;
  if (typeof id !== 'string') throw new Error(`org create failed: ${JSON.stringify(body)}`);
  return id;
}

const H = '/host/openwop-app';
const SECRET = 'Client B launch: confidential pricing';
const leaks = (v: unknown): boolean => JSON.stringify(v ?? null).includes(SECRET);

/** One agency tenant, two client orgs. The OWNER is in both; the MEMBER edits A
 *  only; the VIEWER reads A only. */
async function fixture() {
  const tenantId = `org:orchscope-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = userIdOf((await owner.post(`${H}/test/login`, { email: `os-o-${n++}@acme.test`, tenantId })).body);
  const member = client();
  const memberId = userIdOf((await member.post(`${H}/test/login`, { email: `os-m-${n++}@acme.test`, tenantId })).body);
  const viewer = client();
  const viewerId = userIdOf((await viewer.post(`${H}/test/login`, { email: `os-v-${n++}@acme.test`, tenantId })).body);
  const orgA = orgIdOf((await owner.post(`${H}/orgs`, { name: 'Client A' })).body);
  const orgB = orgIdOf((await owner.post(`${H}/orgs`, { name: 'Client B' })).body);
  expect((await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject: memberId, roles: ['editor'] })).status).toBe(201);
  expect((await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] })).status).toBe(201);
  const briefA = await createBrief(tenantId, orgA, ownerId, { name: 'Client A launch', productName: 'Widget' });
  const briefB = await createBrief(tenantId, orgB, ownerId, { name: SECRET, productName: SECRET });
  const campA = await finalizeFromBrief(tenantId, briefA, ownerId);
  const campB = await finalizeFromBrief(tenantId, briefB, ownerId);
  return { tenantId, ownerId, memberId, viewerId, orgA, orgB, briefA: briefA.id, briefB: briefB.id, campA: campA.id, campB: campB.id };
}
const surface = (scope: BundleScope): FeatureSurface => buildFeatureSurfaces(scope)['campaign-orchestration']!;

describe('campaign-orchestration surface — a client-A run cannot reach client B rows', () => {
  it('1. actor not in B: by-id reads are a uniform not-found, the list drops B, writes refuse and B is untouched', async () => {
    const f = await fixture();
    const s = surface({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    expect(await s.getCampaign!({ campaignId: f.campB })).toEqual({ campaign: null });
    const listed = await s.listCampaigns!({});
    expect(leaks(listed)).toBe(false);
    expect(JSON.stringify(listed)).toContain(f.campA);
    const before = (await getCampaign(f.tenantId, f.campB))!;
    expect(await s.finalizeFromBrief!({ briefId: f.briefB, createdBy: 'x' })).toEqual({ found: false });
    expect(await s.attachAssets!({ campaignId: f.campB, assetIds: ['asset:pwned'] })).toEqual({ found: false });
    expect(await s.attachAssets!({ briefId: f.briefB, assetIds: ['asset:pwned'] })).toEqual({ found: false });
    const after = (await getCampaign(f.tenantId, f.campB))!;
    expect(after.assetIds ?? []).not.toContain('asset:pwned');
    expect(after.updatedAt).toBe(before.updatedAt);
    // Its own org's campaign still reads and takes assets.
    expect((await s.getCampaign!({ campaignId: f.campA })).campaign).toMatchObject({ id: f.campA });
    expect(await s.attachAssets!({ campaignId: f.campA, assetIds: ['asset:ok'] })).toMatchObject({ found: true, attached: 1 });
  });

  it("2. a member of BOTH orgs naming A cannot reach B's rows by id", async () => {
    const f = await fixture();
    const s = surface({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.ownerId });
    expect(await s.getCampaign!({ orgId: f.orgA, campaignId: f.campB })).toEqual({ campaign: null });
    expect(await s.attachAssets!({ orgId: f.orgA, briefId: f.briefB, assetIds: ['asset:x'] })).toEqual({ found: false });
    expect(await s.finalizeFromBrief!({ orgId: f.orgA, briefId: f.briefB })).toEqual({ found: false });
    expect(leaks(await s.getCampaign!({ campaignId: f.campB }))).toBe(true); // that member's right
  });

  it('3. the causing member of an actorless run is held to the same rule; a system run is tenant-trusted', async () => {
    const f = await fixture();
    const caused = surface({ tenantId: f.tenantId, runId: 'r1', orgScopeSubject: f.memberId });
    expect(await caused.getCampaign!({ campaignId: f.campB })).toEqual({ campaign: null });
    expect(leaks(await caused.listCampaigns!({}))).toBe(false);
    const system = surface({ tenantId: f.tenantId, runId: 'r1' });
    expect(leaks(await system.getCampaign!({ campaignId: f.campB }))).toBe(true);
  });

  it('4. the write bar: a viewer of A reads A but cannot attach to or finalize it', async () => {
    const f = await fixture();
    const viewer = surface({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.viewerId });
    // Naming the org runs the seam floor at the method's declared scope (write).
    const missingWrite = { code: 'forbidden_scope', message: 'Missing required scope: workspace:write' };
    await expect(viewer.attachAssets!({ orgId: f.orgA, campaignId: f.campA, assetIds: ['asset:v'] })).rejects.toMatchObject(missingWrite);
    await expect(viewer.finalizeFromBrief!({ orgId: f.orgA, briefId: f.briefA })).rejects.toMatchObject(missingWrite);
    // Without it, the row's own org is held to the same write bar.
    expect((await viewer.getCampaign!({ campaignId: f.campA })).campaign).toMatchObject({ id: f.campA });
    expect(await viewer.attachAssets!({ campaignId: f.campA, assetIds: ['asset:v'] })).toEqual({ found: false });
    expect(await viewer.finalizeFromBrief!({ briefId: f.briefA })).toEqual({ found: false });
    expect((await getCampaign(f.tenantId, f.campA))?.assetIds ?? []).not.toContain('asset:v');
  });
});


describe('tagged campaign reads recheck live membership', () => {
  it.each(['actor', 'cause'] as const)('%s loses argument-free campaign and link access after revocation', async (kind) => {
    const f = await fixture();
    const c = (await getCampaign(f.tenantId, f.campA))!;
    const runId = `tagged-scope-${n++}`;
    const person = kind === 'actor' ? { actingUserId: f.memberId } : { orgScopeSubject: f.memberId };
    const now = new Date().toISOString();
    await storage.insertRun({ runId, workflowId: 'w', tenantId: f.tenantId, status: 'running', inputs: {}, configurable: {},
      metadata: { campaignOrchestration: stampCampaignRun(c, { role: 'stage' }), ...person }, createdAt: now, updatedAt: now });
    const s = surface({ tenantId: f.tenantId, runId, ...person });
    expect(await s.campaignContext!({})).toMatchObject({ found: true, campaign: { id: f.campA, orgId: f.orgA } });
    expect(await s.links!({})).toMatchObject({ found: true, campaignId: f.campA });
    const member = (await listMembers(f.tenantId, f.orgA)).find((m) => m.subject === f.memberId)!;
    expect(await deleteMember(member.memberId)).toBe(true);
    const refused = { found: false, error: { code: 'campaign_not_found', message: 'The campaign this run belongs to no longer exists.' } };
    expect(await s.campaignContext!({})).toEqual(refused);
    expect(await s.links!({})).toEqual(refused);
    // Revocation narrows a person's run, not a truly personless system run.
    const systemRunId = `${runId}-system`;
    await storage.insertRun({ runId: systemRunId, workflowId: 'w', tenantId: f.tenantId, status: 'running', inputs: {}, configurable: {},
      metadata: { campaignOrchestration: stampCampaignRun(c, { role: 'stage' }) }, createdAt: now, updatedAt: now });
    const system = surface({ tenantId: f.tenantId, runId: systemRunId });
    expect(await system.campaignContext!({})).toMatchObject({ found: true, campaign: { id: f.campA } });
    expect(await system.links!({})).toMatchObject({ found: true, campaignId: f.campA });
  });
});
