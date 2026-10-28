/**
 * ADR 0962 P1 — Campaign Studio's MCP read tools, through the real MCP mount.
 *
 *   - the six tools are listed (tools/list + /v1/tools) only with the
 *     `campaign-orchestration` toggle on, as read-tier tools;
 *   - an operator with access to client A only: client A reads work; client B is
 *     the SAME not-found as an unknown id (even with B open to outside agents —
 *     access is checked first);
 *   - D7: client A's `externalAgents` off ⇒ refused; `read` ⇒ allowed; a bad value
 *     is a 400 on the PATCH;
 *   - a campaign or run of client B named under client A is not found;
 *   - D3: the tool's own run is client-stamped (and `approverOrgId` set) after a call.
 *
 * What turns it red: dropping `bindExternalRead` from a read; reading the client
 * row before the access check (B would answer `external_agents_off`); a default of
 * anything but `off`; skipping the campaign/run org checks; not stamping.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { CAMPAIGN_OPS_RUN_STAMP } from '../src/features/campaign-ops/surface.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { listRequests } from '../src/features/campaign-ops/requestService.js';
import { isCampaignRun } from '../src/host/campaignRunGuard.js';
import { mcpGetCampaign, mcpRunStatus, EXTERNAL_AGENT_METADATA_KEY } from '../src/features/campaign-ops/externalRead.js';
import type { HostAdapterSuite } from '../src/host/index.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let TENANT = '';
let agency = '';
let operator = '';
let operatorUserId = '';
let orgA = '';
let orgB = '';
let campaignA: MarketingCampaign;
let campaignB: MarketingCampaign;
let runB = '';
const READ_TOOLS = ['campaign_list', 'campaign_get', 'campaign_performance', 'campaign_pending_gates', 'campaign_run_status', 'campaign_explain'];
const TOOLS = [...READ_TOOLS, 'campaign_request_change'];
let assetA = '';

const setToggle = async (id: string, on: boolean): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
};
function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
async function req<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed as T };
}
let rpcId = 0;
type Rpc = { result?: { isError?: boolean; tools?: Array<{ name: string }>; content?: Array<{ text?: string }> }; error?: { message?: string } };
const mcp = (cookie: string, method: string, params?: unknown) => req<Rpc>(cookie, 'POST', '/host/openwop-app/mcp', { jsonrpc: '2.0', id: ++rpcId, method, ...(params !== undefined ? { params } : {}) });
const tool = async (cookie: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
  const r = await mcp(cookie, 'tools/call', { name, arguments: args });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { isError: r.body.result?.isError === true, text: r.body.result?.content?.[0]?.text ?? JSON.stringify(r.body) };
};
const setAgents = (orgId: string, externalAgents: string) => req(agency, 'PATCH', `/host/openwop-app/campaign-ops/clients/${orgId}`, { externalAgents });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'campaign-ops', 'campaign-brief']) await setToggle(id, true);
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:mcp-owner' });
  TENANT = ws.tenantId;
  const ag = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:mcp-agency', source: 'oidc' });
  const op = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:mcp-operator', source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: ag.userId, displayName: 'Agency', roles: ['admin'] });
  // An agency operator: an editor in the workspace (what a write-tier MCP tool's gate
  // reads — MCP authority is workspace-wide, ADR 0962 X2) and an editor on client A
  // only (what every campaign tool's node checks). Root roles do not reach client
  // orgs, so client B stays invisible.
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: op.userId, displayName: 'Operator', roles: ['editor'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: op.userId, displayName: 'Operator', roles: ['editor'] });
  agency = cookieFor(ag.userId, 'ws:home-mcp-agency');
  operator = cookieFor(op.userId, 'ws:home-mcp-operator');
  operatorUserId = op.userId;
  for (const [name, orgId] of [['Client A', orgA], ['Client B', orgB]] as const) {
    const r = await req(agency, 'POST', '/host/openwop-app/campaign-ops/clients', { name, orgId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  const page = await createPage({ tenantId: TENANT, orgId: orgA, title: 'Spring landing', createdBy: 'seed', sections: [{ type: 'hero', data: { heading: 'Spring is here' } }] });
  const asset = await req<{ asset?: { assetId: string } }>(operator, 'POST', `/host/openwop-app/campaign-ops/clients/${orgA}/assets`, { destination: 'openwop.cms.page', locator: { pageId: page.pageId }, label: 'Spring landing', editableFields: ['title'] });
  expect(asset.status, JSON.stringify(asset.body)).toBe(201);
  assetA = asset.body.asset!.assetId;
  campaignA = await finalizeFromBrief(TENANT, await createBrief(TENANT, orgA, 'seed', { name: 'Spring A', channels: [] }), 'seed');
  campaignB = await finalizeFromBrief(TENANT, await createBrief(TENANT, orgB, 'seed', { name: 'Secret B', channels: [] }), 'seed');
  // A campaign run of client B (the tag is what makes it B's).
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-b-${randomBytes(4).toString('hex')}`, workflowId: 'wf.any', tenantId: TENANT, status: 'completed', inputs: {},
    metadata: { campaignOrchestration: stampCampaignRun(campaignB, { role: 'spine' }) }, configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run);
  runB = run.runId;
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0962 P1 — listing', () => {
  it('the six read tools are listed only with the campaign-orchestration toggle on, as read-tier', async () => {
    const names = async (): Promise<string[]> => ((await mcp(operator, 'tools/list')).body.result?.tools ?? []).map((t) => t.name);
    expect(await names()).toEqual(expect.arrayContaining(TOOLS));
    const catalog = await req<Array<{ toolId: string; safetyTier: string }>>(operator, 'GET', '/tools');
    for (const t of READ_TOOLS) expect(catalog.body.find((d) => d.toolId === `mcp:${t}`)?.safetyTier, t).toBe('read');
    await setToggle('campaign-orchestration', false);
    try {
      const off = await names();
      for (const t of TOOLS) expect(off, t).not.toContain(t);
    } finally { await setToggle('campaign-orchestration', true); }
  });
});

describe('ADR 0962 P1 — one client per call, the agency\'s RBAC', () => {
  it('D7: an outside agent is refused until the client allows it; a bad value is a 400', async () => {
    expect((await setAgents(orgA, 'auto-within-caps')).status).toBe(400);
    const off = await tool(operator, 'campaign_list', { clientId: orgA });
    expect(off.isError).toBe(true);
    expect(off.text).toMatch(/does not allow outside agents/);
    expect((await setAgents(orgA, 'read')).status).toBe(200);
    const on = await tool(operator, 'campaign_list', { clientId: orgA });
    expect(on.isError, on.text).toBe(false);
    expect(on.text).toContain(campaignA.id);
    expect(on.text).not.toContain(campaignB.id);
  });

  it('client B is the same not-found as an unknown client, even with B open to outside agents', async () => {
    await setAgents(orgA, 'read');
    await setAgents(orgB, 'read');
    const b = await tool(operator, 'campaign_list', { clientId: orgB });
    const unknown = await tool(operator, 'campaign_list', { clientId: 'org-does-not-exist' });
    expect(b.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(b.text).toContain('Client not found');
    expect(b.text).toBe(unknown.text);
    expect(b.text).not.toContain('Secret B');
  });

  it('a campaign or run of client B named under client A is not found; A\'s own reads work', async () => {
    await setAgents(orgA, 'read');
    const get = await tool(operator, 'campaign_get', { clientId: orgA, campaignId: campaignA.id });
    expect(get.isError, get.text).toBe(false);
    expect(get.text).toContain('Spring A');
    expect((await tool(operator, 'campaign_get', { clientId: orgA, campaignId: campaignB.id })).text).toContain('Campaign not found');
    expect((await tool(operator, 'campaign_performance', { clientId: orgA, campaignId: campaignB.id })).text).toContain('Campaign not found');
    expect((await tool(operator, 'campaign_run_status', { clientId: orgA, runId: runB })).text).toContain('Run not found');
    expect((await tool(operator, 'campaign_explain', { clientId: orgA, runId: runB })).text).toContain('Run not found');
    const gates = await tool(operator, 'campaign_pending_gates', { clientId: orgA });
    expect(gates.isError, gates.text).toBe(false);
    expect(JSON.parse(gates.text)).toMatchObject({ clientId: orgA, gates: [], truncated: false });
  });

  it('D3: the tool\'s own run is client-stamped, with the approver org', async () => {
    await setAgents(orgA, 'read');
    await tool(operator, 'campaign_list', { clientId: orgA });
    const runs = await storage.listRuns({ tenantId: TENANT, workflowId: 'campaign-studio.mcp.list', limit: 1 });
    const md = (runs[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(md[CAMPAIGN_OPS_RUN_STAMP]).toEqual({ orgId: orgA });
    expect(md.approverOrgId).toBe(orgA);
  });
});

describe('ADR 0962 P2 — campaign_request_change: a request, never an effect', () => {
  it('is listed as a write-tier tool', async () => {
    const catalog = await req<Array<{ toolId: string; safetyTier: string }>>(operator, 'GET', '/tools');
    expect(catalog.body.find((d) => d.toolId === 'mcp:campaign_request_change')?.safetyTier).toBe('write');
  });

  it('a read-only client refuses it; the refusal names what an admin can change', async () => {
    await setAgents(orgA, 'read');
    const r = await tool(operator, 'campaign_request_change', { clientId: orgA, text: 'Change the hero headline to Summer is here', assetIds: [assetA] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/may only read/);
    expect((await listRequests(TENANT, orgA)).length).toBe(0);
  });

  it('client B is still not-found for a request', async () => {
    await setAgents(orgB, 'request');
    const r = await tool(operator, 'campaign_request_change', { clientId: orgB, text: 'Change it', assetIds: ['asset-x'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Client not found');
  });

  it('with `request` allowed: a request row and a governed run, awaiting a person — provenance copied, client-stamped, a campaign run', async () => {
    await setAgents(orgA, 'request');
    const r = await tool(operator, 'campaign_request_change', { clientId: orgA, text: 'Change the hero headline to Summer is here', assetIds: [assetA] });
    expect(r.isError, r.text).toBe(false);
    const out = JSON.parse(r.text) as { requestId: string; runId: string; status: string };
    expect(out.status).toBe('awaiting-input');
    const reqRow = (await listRequests(TENANT, orgA)).find((x) => x.requestId === out.requestId);
    expect(reqRow?.via).toMatchObject({ protocol: 'mcp' });
    const child = await storage.getRun(out.runId);
    const md = (child?.metadata ?? {}) as Record<string, unknown>;
    expect(child?.workflowId).toBe('campaign-ops.change-request');
    expect(md.source).toBe('mcp-server-mount');
    expect(md.trustBoundary).toBe('untrusted');
    expect(md[EXTERNAL_AGENT_METADATA_KEY]).toMatchObject({ protocol: 'mcp' });
    expect((md['openwop-app.campaignOps'] as { orgId?: string } | undefined)?.orgId).toBe(orgA);
    // ADR 0962 D4.1 — any gate on it is refused to an outside agent.
    expect(await isCampaignRun(storage, hostSuite, out.runId)).toBe(true);
    // A replay of the real MCP wrapper serves the recorded request and child-run
    // IDs. It must never create another request or ignite its drafting workflow.
    const source = (await storage.listRuns({ tenantId: TENANT, workflowId: 'campaign-studio.mcp.request-change', limit: 1 }))[0];
    expect(source?.status).toBe('completed');
    const requestsBefore = (await listRequests(TENANT, orgA)).map((r) => r.requestId).sort();
    const childrenBefore = (await storage.listRuns({ tenantId: TENANT, workflowId: 'campaign-ops.change-request', limit: 100 })).map((r) => r.runId).sort();
    const fork = await req<{ runId: string }>(operator, 'POST', `/runs/${encodeURIComponent(`${TENANT}/${source!.runId}`)}:fork`, { mode: 'replay', fromSeq: 0 });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkId = fork.body.runId.includes('/') ? fork.body.runId.slice(fork.body.runId.lastIndexOf('/') + 1) : fork.body.runId;
    const deadline = Date.now() + 10_000;
    let replay = await storage.getRun(forkId);
    while (replay && !['completed', 'failed', 'cancelled'].includes(replay.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25)); replay = await storage.getRun(forkId);
    }
    expect(replay?.status).toBe('completed');
    expect((await listRequests(TENANT, orgA)).map((r) => r.requestId).sort()).toEqual(requestsBefore);
    expect((await storage.listRuns({ tenantId: TENANT, workflowId: 'campaign-ops.change-request', limit: 100 })).map((r) => r.runId).sort()).toEqual(childrenBefore);

  });
});


describe('ADR 0962 recovery — binding and payload privacy', () => {
  it('a missing source run or a campaign-A run cannot bind its tool read to another client', async () => {
    await expect(mcpGetCampaign({ tenantId: TENANT, runId: 'not-a-run', actingUserId: operatorUserId }, orgA, campaignA.id)).rejects.toMatchObject({ httpStatus: 404 });
    const id = `conflicting-source-${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    await insertRunWithStartContext(storage, { runId: id, workflowId: 'wf.any', tenantId: TENANT, status: 'completed', inputs: {},
      metadata: { campaignOrchestration: stampCampaignRun(campaignB, { role: 'spine' }) }, configurable: {}, createdAt: now, updatedAt: now });
    await expect(mcpGetCampaign({ tenantId: TENANT, runId: id, actingUserId: operatorUserId }, orgA, campaignA.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('gate summaries never return payload text or bearer tokens to the external agent', async () => {
    await setAgents(orgA, 'read');
    const id = `private-gate-run-${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    await insertRunWithStartContext(storage, { runId: id, workflowId: 'wf.any', tenantId: TENANT, status: 'waiting-approval', inputs: {},
      metadata: { campaignOrchestration: stampCampaignRun(campaignA, { role: 'spine' }) }, configurable: {}, createdAt: now, updatedAt: now });
    const interruptId = `private-gate-${randomBytes(4).toString('hex')}`;
    await storage.insertInterrupt({ interruptId, runId: id, nodeId: 'review', kind: 'approval', token: 'PRIVATE-BEARER-TOKEN',
      data: { title: 'PRIVATE-CLIENT-PAYLOAD', prompt: 'PRIVATE-CREDENTIAL-TEXT', requiredApprovals: 1 }, createdAt: now });
    try {
      const summary = await tool(operator, 'campaign_pending_gates', { clientId: orgA });
      expect(summary.isError, summary.text).toBe(false);
      expect(JSON.parse(summary.text).gates).toEqual(expect.arrayContaining([expect.objectContaining({ runId: id, title: 'Approval' })]));
      const status = await mcpRunStatus({ tenantId: TENANT, actingUserId: operatorUserId }, orgA, id);
      expect(status.waitingOn).toEqual(['Approval']);
      for (const secret of ['PRIVATE-CLIENT-PAYLOAD', 'PRIVATE-CREDENTIAL-TEXT', 'PRIVATE-BEARER-TOKEN']) {
        expect(summary.text).not.toContain(secret); expect(JSON.stringify(status)).not.toContain(secret);
      }
      // A stale campaign-A index cannot authorize a run whose primary binding moved.
      await storage.mergeRunMetadata(id, { campaignOrchestration: stampCampaignRun(campaignB, { role: 'spine' }) });
      const stale = await tool(operator, 'campaign_pending_gates', { clientId: orgA });
      expect(JSON.parse(stale.text).gates).not.toEqual(expect.arrayContaining([expect.objectContaining({ runId: id })]));
    } finally { await storage.resolveInterrupt(interruptId, {}, new Date().toISOString()); }
  });
});
