/**
 * ADR 0852 P1 — a campaign's linked project, and campaign runs binding to it.
 *
 * Real app, real sign-ins for the routes; the service for finalize (the brief
 * pipeline is exercised elsewhere):
 *
 *   - finalizing a campaign creates exactly ONE linked project (`facet:'campaign'`,
 *     org-visible); re-finalizing reuses it; GET returns its `projectId`;
 *   - a project that cannot be created never fails the finalize (fail-soft);
 *   - the lazy route under a race yields one project, and replaces a stale link;
 *   - the project cannot be made private while linked; deleting the campaign
 *     archives the project, clears the facet, and lifts the lock;
 *   - a campaign agent run is stamped with the project's ledger version; a
 *     caller-supplied `campaignOrchestration` is stripped by `POST /runs`'s rule.
 *
 * Sabotage-witnessed (/grade-tests w30): an unconditional `putIfAbsent` win, the
 * race loser NOT deleting its project (orphan), a thrown link failure, the stale
 * link never removed, the private-visibility lock, the facet clear / archive on
 * delete, the campaignChannel run binding, the campaign keys in
 * `stripCallerAttribution` (only witness for those two keys), GET dropping
 * `projectId`, and finalize not linking each turn a case red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { stripCallerAttribution } from '../src/host/runDispatch.js';
import { createBrief, setKernel, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief, deleteCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { ensureCampaignProject, getCampaignProjectId, linkProjectOnFinalize } from '../src/features/campaign-orchestration/campaignProject.js';
import { deleteProject, getProject, listProjects } from '../src/features/projects/projectsService.js';
import { readTeamLedgerStamp } from '../src/features/team-intent-ledger/runStamp.js';
import type { RunRecord } from '../src/types.js';

let BASE: string;
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
  for (const id of ['campaign-orchestration']) await saveConfig({ ...getToggleDefault(id)!, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The route bodies this suite reads (each field it touches is asserted). */
interface Body { user: { userId: string }; orgId: string; campaign: { projectId?: string }; projectId: string }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const parsed = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as Body; // JSON boundary
    return { status: res.status, body: parsed };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
const KERNEL = { headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see', tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z' };
const C = '/host/openwop-app/campaign-orchestration';

async function setup() {
  const tenantId = `org:cp-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: `cp-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'CampCo' })).body.orgId as string;
  const brief = await createBrief(tenantId, orgId, ownerId, {
    name: `Spring launch ${n}`, objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' },
    channels: [{ type: 'ad_variants', enabled: true, config: {} }],
  });
  await setKernel(tenantId, brief.id, KERNEL);
  await updateBrief(tenantId, brief.id, { status: 'confirmed' }, ownerId);
  const confirmed = { ...brief, kernel: KERNEL, status: 'confirmed' as const };
  return { tenantId, orgId, owner, ownerId, confirmed };
}
describe('ADR 0852 P1 — a campaign has one linked project', () => {
  it('finalize creates exactly one org-visible campaign project; re-finalize reuses it; GET returns it', async () => {
    const s = await setup();
    const c = await finalizeFromBrief(s.tenantId, s.confirmed, s.ownerId);
    const projectId = await getCampaignProjectId(s.tenantId, c.id);
    expect(projectId).toBeTruthy();
    const p = (await getProject(s.tenantId, projectId!))!;
    expect(p).toMatchObject({ facet: 'campaign', visibility: 'org', orgId: s.orgId, name: c.name });
    await finalizeFromBrief(s.tenantId, s.confirmed, s.ownerId);
    expect(await getCampaignProjectId(s.tenantId, c.id)).toBe(projectId);
    const got = await s.owner.get(`${C}/campaigns/${c.id}`);
    expect(got.status).toBe(200);
    expect(got.body.campaign.projectId).toBe(projectId);
  });

  it('a project that cannot be created never fails the finalize', async () => {
    const s = await setup();
    const c = await finalizeFromBrief(s.tenantId, s.confirmed, s.ownerId);
    await deleteProject(s.tenantId, (await getCampaignProjectId(s.tenantId, c.id))!);
    // An empty name is refused by createProject: the link step fails, and says so in the log only.
    await expect(linkProjectOnFinalize({ ...c, name: '' }, s.ownerId)).resolves.toBeUndefined();
    expect(await getCampaignProjectId(s.tenantId, c.id)).toBeUndefined();
  });

  it('the lazy route replaces a stale link; concurrent ensures yield ONE project and leave no orphan', async () => {
    const s = await setup();
    const c = await finalizeFromBrief(s.tenantId, s.confirmed, s.ownerId);
    const first = (await getCampaignProjectId(s.tenantId, c.id))!;
    await deleteProject(s.tenantId, first); // the link is now stale
    const r = await s.owner.post(`${C}/campaigns/${c.id}/project`);
    expect(r.status).toBe(200);
    expect(r.body.projectId).not.toBe(first);
    // A real race, at the service: ten ensures interleave on their awaits.
    await deleteProject(s.tenantId, r.body.projectId);
    const ids = await Promise.all(Array.from({ length: 10 }, () => ensureCampaignProject(c, s.ownerId)));
    expect(new Set(ids).size).toBe(1);
    const campaignProjects = (await listProjects(s.tenantId)).filter((p) => p.facet === 'campaign');
    expect(campaignProjects.map((p) => p.id)).toEqual([ids[0]]);
  });

  it('cannot be made private while linked; deleting the campaign archives it and lifts the lock', async () => {
    const s = await setup();
    const c = await finalizeFromBrief(s.tenantId, s.confirmed, s.ownerId);
    const projectId = (await getCampaignProjectId(s.tenantId, c.id))!;
    const refused = await s.owner.patch(`/host/openwop-app/projects/${projectId}/visibility`, { visibility: 'private' });
    expect(refused.status).toBe(409);
    expect(await deleteCampaign(s.tenantId, c.id, s.ownerId)).toBe(true);
    const p = (await getProject(s.tenantId, projectId))!;
    expect(p.facet).toBeUndefined();
    expect(p.charter?.status).toBe('archived');
    // The lock lifted: the same PATCH now lands, and the project IS private.
    const lifted = await s.owner.patch(`/host/openwop-app/projects/${projectId}/visibility`, { visibility: 'private' });
    expect(lifted.status).toBe(200);
    expect((await getProject(s.tenantId, projectId))!.visibility).toBe('private');
  });
});

describe('ADR 0852 P1 — campaign runs bind to the campaign project', () => {
  it("a campaign agent run is stamped with the project's ledger version; an unlinked brief is not", async () => {
    const s = await setup();
    const c = await finalizeFromBrief(s.tenantId, s.confirmed, s.ownerId);
    const projectId = (await getCampaignProjectId(s.tenantId, c.id))!;
    expect((await s.owner.post(`/host/openwop-app/team-ledger/projects/${projectId}`)).status).toBe(201);
    const mk = async (metadata: Record<string, unknown>) => {
      const now = new Date().toISOString();
      const run: RunRecord = { runId: `run-cp-${n++}`, workflowId: 'wf.test.cp', tenantId: s.tenantId, status: 'pending', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now };
      await insertRunWithStartContext(storage, run);
      return (await storage.getRun(run.runId))!;
    };
    const bound = await mk({ campaignOrchestration: { briefId: c.briefId, agentId: 'a' }, actingUserId: s.ownerId });
    expect(readTeamLedgerStamp(bound.metadata)).toMatchObject({ version: 1 });
    const channel = await mk({ campaignChannel: { channel: 'ad_variants', briefId: c.briefId, agentId: 'a' }, actingUserId: s.ownerId });
    expect(readTeamLedgerStamp(channel.metadata)).toMatchObject({ version: 1 });
    const unlinked = await mk({ campaignOrchestration: { briefId: 'brief-none', agentId: 'a' }, actingUserId: s.ownerId });
    expect(readTeamLedgerStamp(unlinked.metadata)).toBeUndefined();
  });

  it("POST /runs's caller rule strips campaign attribution", () => {
    const out = stripCallerAttribution({ campaignOrchestration: { briefId: 'b' }, campaignChannel: { briefId: 'b' }, keep: 1 });
    expect(out).toEqual({ keep: 1 });
    // ADR 0921 D3 — the campaign-ops run stamp names the approved run; a caller
    // may not forge it (campaign-ops client-portal security review, 2026-10-19).
    expect(stripCallerAttribution({ 'openwop-app.campaignOps': { approvalId: 'a', changeSetHash: 'h' }, keep: 1 })).toEqual({ keep: 1 });
  });
});
