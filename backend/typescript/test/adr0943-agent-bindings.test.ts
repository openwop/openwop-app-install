/**
 * ADR 0943 P0 — per-client agent bindings, frozen at run start.
 *
 *   - the agent runner honours the node pin (`nodes[].agent.agentId`, F1) and a
 *     frozen binding outranks config, configurable and the pin (only inputs win);
 *   - bindings are written closed-world (both agents installed, replacement not
 *     paused, its tools cover the pinned agent's, a pinned key is this tenant's
 *     own) and a stored-key pin needs `host:byok:manage`;
 *   - client B's override never applies to client A's run;
 *   - `:fork` over the real route keeps the source's bindings after the override
 *     changes, and never GAINS bindings its source was born without (ADR 0604);
 *   - a caller cannot supply the frozen map through `POST /runs` (reserved key);
 *   - the runner dispatches the frozen replacement on a real stored run.
 *
 * Sabotage notes (each run, 2026-10-20):
 *  - drop the `derivedFromRun` early return in the contributor → red (the
 *    redrive-shaped contributor case). Both `:fork` cases stay green alone,
 *    correctly: the fork route passes no definition, and the bound source is
 *    also held by run-start's never-overwrite merge;
 *  - read the org from any stamp regardless of mismatch / key bindings by tenant
 *    only (drop the `orgId` filter in `listAgentBindings`) → red (B's override
 *    lands on A's run);
 *  - un-reserve `openwop-app.agentBindings` → red (the forged map survives);
 *  - drop the `nodeAgent` rung in `resolveParams` → red; put the binding after
 *    config → red;
 *  - drop the tools-cover check → red; drop the BYOK-manage gate on the route →
 *    red (the operator pins an agency key);
 *  - read a toggle/bindings fault as "no binding" (return {} in the catch), or
 *    drop the runner's unresolved refusal → red; let the binding model fall back
 *    to the node's credentialRef → red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { AiCallRequest, AiCallResult, NodeContext, WorkflowDefinition } from '../src/executor/types.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { fromWireRunId, toWireRunId } from '../src/host/v2Ids.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { createRosterEntry, updateRosterEntry } from '../src/host/rosterService.js';
import agentRunnerNode, { AGENT_RUNNER_TYPE_ID, resolveParams } from '../src/host/agentRunnerNode.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { dispatchSubWorkflow, setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { createCanvasSurface, setCanvasInvokeDispatcher } from '../src/host/canvasSurface.js';
import { RUN_AGENT_BINDINGS_KEY } from '../src/host/runAgentBindings.js';
import * as toggleService from '../src/host/featureToggles/service.js';
import * as bindingService from '../src/features/campaign-ops/agentBindingService.js';
import { CAMPAIGN_OPS_RUN_STAMP, buildCampaignOpsSurface } from '../src/features/campaign-ops/surface.js';
import { agentBindingContributor, authoredNodeId, runClientOrg } from '../src/features/campaign-ops/agentBindingContributor.js';
import type { ClientAgentBinding } from '../src/features/campaign-ops/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let appHostSuite: HostAdapterSuite;
let TENANT: string;
let adminCookie: string;
let operatorCookie: string;
let operatorUserId: string;
let orgA: string;
let orgB: string;
let fixtureWorkflowId: string;
let n = 0;

const PIN = 'test.cs.pinned-writer';
const REPLACEMENT = 'test.cs.client-writer';
const OTHER = 'test.cs.other-writer';
const NARROW = 'test.cs.narrow-writer';

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

interface Res<T> { status: number; body: T; raw: string }
async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const ops = (orgId: string): string => `/host/openwop-app/campaign-ops/clients/${orgId}/agent-bindings`;

function registerAgents(): void {
  const reg = getAgentRegistry();
  const base = { modelClass: 'chat', systemPrompt: 'You write.', packName: 'test', packVersion: '0' } as const;
  reg.register({ ...base, agentId: PIN, persona: 'Pinned', toolAllowlist: ['openwop:kb.search'] });
  reg.register({ ...base, agentId: REPLACEMENT, persona: 'Client', toolAllowlist: ['openwop:kb.search', 'openwop:cms.read'] });
  reg.register({ ...base, agentId: OTHER, persona: 'Other', toolAllowlist: ['openwop:kb.search'] });
  reg.register({ ...base, agentId: NARROW, persona: 'Narrow', toolAllowlist: [] });
}

/** A definition with one agent-runner node pinned through `config.agentId` (the
 *  only way a chain pack can pin today) and one pinned through `nodes[].agent`. */
function definition(workflowId: string): WorkflowDefinition {
  return {
    workflowId,
    version: '1',
    nodes: [
      { nodeId: 'write', typeId: AGENT_RUNNER_TYPE_ID, config: { agentId: PIN, task: 'Write the ad.' } },
      { nodeId: 'review', typeId: AGENT_RUNNER_TYPE_ID, agent: { agentId: PIN }, config: { task: 'Review it.' } },
    ],
    edges: [{ from: 'write', to: 'review' }],
  } as unknown as WorkflowDefinition;
}

async function clientRun(orgId: string | undefined, workflowId: string, extra: Record<string, unknown> = {}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-agb-${String(n++).padStart(12, '0')}`, workflowId, tenantId: TENANT, status: 'pending', inputs: {},
    metadata: { ...(orgId ? { [CAMPAIGN_OPS_RUN_STAMP]: { orgId } } : {}), ...extra },
    configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run, { definition: definition(workflowId) });
  return (await storage.getRun(run.runId))!;
}
const bindingsOf = (run: RunRecord): unknown => (run.metadata as Record<string, unknown> | undefined)?.[RUN_AGENT_BINDINGS_KEY];
function localRunId(wire: string): string {
  const r = fromWireRunId(wire, TENANT);
  if (!r.ok) throw new Error(`run id ${wire} is not this tenant's`);
  return r.runId;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  appHostSuite = app.locals.hostSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  registerAgents();
  const ws = await createWorkspace({ name: 'Bindings Agency', ownerSubject: 'oidc:agb-owner' });
  TENANT = ws.tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:agb-admin', source: 'oidc' });
  const operator = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:agb-operator', source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: operator.userId, displayName: 'Operator', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: operator.userId, displayName: 'Operator', roles: ['editor'] });
  adminCookie = cookieFor(admin.userId, 'ws:home-agb-admin');
  operatorCookie = cookieFor(operator.userId, 'ws:home-agb-operator');
  operatorUserId = operator.userId;
  for (const [orgId, name] of [[orgA, 'Client A'], [orgB, 'Client B']] as const) {
    const r = await call(adminCookie, 'POST', '/host/openwop-app/campaign-ops/clients', { name, orgId });
    expect(r.status, r.raw).toBe(201);
  }
  const disco = await call<{ fixtures?: string[] }>(adminCookie, 'GET', '/.well-known/openwop');
  fixtureWorkflowId = disco.body?.fixtures?.[0] ?? 'openwop-app.uppercase';
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0943 D2.1 — the runner honours the pin and the frozen binding', () => {
  const ctx = (over: Partial<NodeContext>): NodeContext => ({ inputs: {}, configurable: {}, ...over } as unknown as NodeContext);

  it('falls back to nodes[].agent.agentId when nothing else names an agent (F1)', () => {
    expect(resolveParams(ctx({ nodeAgent: { agentId: 'pinned' } })).agentId).toBe('pinned');
    expect(resolveParams(ctx({ nodeAgent: { agentId: 'pinned' }, config: { agentId: 'cfg' } })).agentId).toBe('cfg');
  });

  it('a frozen binding beats config, configurable and the pin; inputs still win', () => {
    const binding = { agentId: 'bound', model: { provider: 'openai', model: 'gpt-x', credentialRef: 'k1' } };
    const p = resolveParams(ctx({ nodeAgent: { agentId: 'pinned' }, config: { agentId: 'cfg', provider: 'anthropic' }, configurable: { agentId: 'conf' } }), binding);
    expect(p).toMatchObject({ agentId: 'bound', provider: 'openai', model: 'gpt-x', credentialRef: 'k1' });
    expect(resolveParams(ctx({ inputs: { agentId: 'input' }, config: { agentId: 'cfg' } }), binding).agentId).toBe('input');
    // A binding without a model leaves the node's model alone.
    expect(resolveParams(ctx({ config: { provider: 'anthropic' } }), { agentId: 'bound' }).provider).toBe('anthropic');
  });

  it("a binding's model never borrows the node's key (it may be another vendor's)", () => {
    const p = resolveParams(ctx({ config: { provider: 'anthropic', credentialRef: 'agency-anthropic' } }), { agentId: 'bound', model: { provider: 'openai', model: 'gpt-x' } });
    expect(p.provider).toBe('openai');
    expect(p.credentialRef).toBeUndefined();
  });

  it('a node binding names the chain-authored id; expansion prefixes are recognised', () => {
    const def = { metadata: { expandedFrom: { chainId: 'campaign-ops.change-request' } } };
    expect(authoredNodeId(def, 'campaign-ops_change-request_3fa9c1d2_write')).toBe('write');
    expect(authoredNodeId(def, 'campaign-ops_change-request_3fa9c1d2_draft_copy')).toBe('draft_copy');
    expect(authoredNodeId(def, 'other_3fa9c1d2_write')).toBeUndefined();
    expect(authoredNodeId({}, 'write')).toBeUndefined();
  });

  it('two stamps naming different clients bind nothing', () => {
    expect(runClientOrg({ campaignOrchestration: { orgId: 'a' }, [CAMPAIGN_OPS_RUN_STAMP]: { orgId: 'b' } })).toBeNull();
    expect(runClientOrg({ campaignOrchestration: { orgId: 'a' } })).toBe('a');
    expect(runClientOrg({})).toBeUndefined();
  });
});

describe('ADR 0943 D2.2 — closed-world writes', () => {
  it('rejects an unknown agent, a pinned agent that is not installed, and a node without its workflow', async () => {
    const unknown = await call(adminCookie, 'PUT', ops(orgA), { pinnedAgentId: PIN, agentId: 'test.cs.nope' });
    expect(unknown.status, unknown.raw).toBe(422);
    expect(unknown.raw).toContain('agent_unknown');
    expect((await call(adminCookie, 'PUT', ops(orgA), { pinnedAgentId: 'test.cs.nope', agentId: REPLACEMENT })).raw).toContain('pinned_agent_unknown');
    expect((await call(adminCookie, 'PUT', ops(orgA), { pinnedAgentId: PIN, agentId: REPLACEMENT, nodeId: 'write' })).raw).toContain('node_without_workflow');
  });

  it('refuses a replacement that cannot use every tool the pinned agent can, naming them', async () => {
    const r = await call<{ details?: { missingTools?: string[] } }>(adminCookie, 'PUT', ops(orgA), { pinnedAgentId: PIN, agentId: NARROW });
    expect(r.status, r.raw).toBe(422);
    expect(r.raw).toContain('tools_not_covered');
    expect(r.raw).toContain('openwop:kb.search');
  });

  it('refuses a paused replacement', async () => {
    const entry = await createRosterEntry({ tenantId: TENANT, persona: `Paused ${Date.now()}`, agentRef: { agentId: OTHER, version: '0' } });
    await updateRosterEntry(TENANT, entry.rosterId, { enabled: false });
    const r = await call(adminCookie, 'PUT', ops(orgA), { pinnedAgentId: PIN, agentId: entry.rosterId });
    expect(r.status, r.raw).toBe(422);
    expect(r.raw).toContain('agent_paused');
  });

  it('pinning a stored key needs host:byok:manage; a key the tenant does not hold is refused', async () => {
    const body = { pinnedAgentId: PIN, agentId: REPLACEMENT, model: { provider: 'openai', model: 'gpt-4o', credentialRef: 'agency-openai' } };
    const op = await call(operatorCookie, 'PUT', ops(orgA), body);
    expect(op.status, op.raw).toBe(403);
    const ad = await call(adminCookie, 'PUT', ops(orgA), body);
    expect(ad.status, ad.raw).toBe(422);
    expect(ad.raw).toContain('unknown_credential_ref');
  });

  it('another client is a uniform 404 to the operator', async () => {
    expect((await call(operatorCookie, 'GET', ops(orgB))).status).toBe(404);
    expect((await call(operatorCookie, 'PUT', ops(orgB), { pinnedAgentId: PIN, agentId: OTHER })).status).toBe(404);
  });

  it('one row per scope: a second write to the same scope replaces the first', async () => {
    const a = await call<{ binding: ClientAgentBinding }>(operatorCookie, 'PUT', ops(orgA), { pinnedAgentId: PIN, agentId: OTHER });
    expect(a.status, a.raw).toBe(200);
    const b = await call<{ binding: ClientAgentBinding }>(operatorCookie, 'PUT', ops(orgA), { pinnedAgentId: PIN, agentId: REPLACEMENT });
    expect(b.body.binding.bindingId).toBe(a.body.binding.bindingId);
    const list = await call<{ bindings: ClientAgentBinding[] }>(operatorCookie, 'GET', ops(orgA));
    expect(list.body.bindings.map((x) => x.agentId)).toEqual([REPLACEMENT]);
  });
});

describe('ADR 0943 matrix row 3 — the workflow surface reads bindings client-bound', () => {
  it('reads its own client, refuses another and an actorless run, and never exposes a key name', async () => {
    const surface = buildCampaignOpsSurface({ tenantId: TENANT, actingUserId: operatorUserId });
    const own = await surface.listAgentBindings({ orgId: orgA }) as { bindings: Array<Record<string, unknown>> };
    expect(own.bindings.map((b) => b.agentId)).toEqual([REPLACEMENT]);
    expect(JSON.stringify(own)).not.toContain('credentialRef');
    await expect(surface.listAgentBindings({ orgId: orgB })).rejects.toBeTruthy();
    await expect(buildCampaignOpsSurface({ tenantId: TENANT }).listAgentBindings({ orgId: orgA })).rejects.toMatchObject({ details: { reason: 'no_acting_user' } });
  });
});

describe('ADR 0943 D2.3 — frozen at run start, per client', () => {
  it("client B's override never applies to client A's run", async () => {
    // A: pin-only binding → REPLACEMENT (from the previous block). B: OTHER, plus a node binding.
    expect((await call(adminCookie, 'PUT', ops(orgB), { pinnedAgentId: PIN, agentId: OTHER })).status).toBe(200);
    expect((await call(adminCookie, 'PUT', ops(orgB), { pinnedAgentId: PIN, agentId: REPLACEMENT, workflowId: 'wf.agb', nodeId: 'review' })).status).toBe(200);
    const runA = await clientRun(orgA, 'wf.agb');
    expect(bindingsOf(runA)).toMatchObject({ write: { agentId: REPLACEMENT }, review: { agentId: REPLACEMENT } });
    const runB = await clientRun(orgB, 'wf.agb');
    // The node binding outranks B's pin-only binding on `review`.
    expect(bindingsOf(runB)).toMatchObject({ write: { agentId: OTHER }, review: { agentId: REPLACEMENT } });
    expect(bindingsOf(await clientRun(undefined, 'wf.agb')), 'no client stamp, no bindings').toBeUndefined();
  });

  it('a caller cannot supply the frozen map through POST /runs', async () => {
    const r = await call<{ runId: string }>(adminCookie, 'POST', '/runs', {
      workflowId: fixtureWorkflowId, inputs: {},
      metadata: { [RUN_AGENT_BINDINGS_KEY]: { write: { agentId: 'test.cs.forged' } } },
    });
    expect(r.status, r.raw).toBe(201);
    expect(bindingsOf((await storage.getRun(localRunId(r.body.runId)))!)).toBeUndefined();
  });

  it(':fork keeps the source bindings after the override changes', async () => {
    const src = await clientRun(orgA, fixtureWorkflowId);
    expect(bindingsOf(src)).toMatchObject({ write: { agentId: REPLACEMENT } });
    await getEventLog().append({ runId: src.runId, type: 'run.started', payload: { workflowId: fixtureWorkflowId } });
    expect((await call(adminCookie, 'PUT', ops(orgA), { pinnedAgentId: PIN, agentId: OTHER })).status).toBe(200);
    const forked = await call<{ runId: string }>(adminCookie, 'POST', `/runs/${encodeURIComponent(toWireRunId(src.runId, TENANT))}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(forked.status, forked.raw).toBe(201);
    const fork = (await storage.getRun(localRunId(forked.body.runId)))!;
    expect(bindingsOf(fork)).toMatchObject({ write: { agentId: REPLACEMENT } });
  });

  it('a fork never GAINS bindings its source was born without', async () => {
    // Born before client A had any binding for this pin: simulate by stripping it.
    const born = await clientRun(orgA, fixtureWorkflowId);
    const { [RUN_AGENT_BINDINGS_KEY]: _dropped, ...unbound } = born.metadata as Record<string, unknown>;
    await storage.updateRun(born.runId, { metadata: unbound });
    await getEventLog().append({ runId: born.runId, type: 'run.started', payload: { workflowId: fixtureWorkflowId } });
    const forked = await call<{ runId: string }>(adminCookie, 'POST', `/runs/${encodeURIComponent(toWireRunId(born.runId, TENANT))}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(forked.status, forked.raw).toBe(201);
    expect(bindingsOf((await storage.getRun(localRunId(forked.body.runId)))!)).toBeUndefined();
  });

  it('a node binding authored with the bare chain node id applies to the expanded node', async () => {
    const expanded = {
      ...definition('wf.agb.chain'),
      nodes: [{ nodeId: 'demo_chain_0a1b2c_write', typeId: AGENT_RUNNER_TYPE_ID, config: { agentId: PIN } }],
      edges: [],
      metadata: { expandedFrom: { chainId: 'demo.chain', version: '1', params: {} } },
    } as unknown as WorkflowDefinition;
    expect((await call(adminCookie, 'PUT', ops(orgB), { pinnedAgentId: PIN, agentId: REPLACEMENT, workflowId: 'wf.agb.chain', nodeId: 'write' })).status).toBe(200);
    const out = await agentBindingContributor({ tenantId: TENANT, metadata: { [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgB } }, definition: expanded });
    expect(out).toEqual({ [RUN_AGENT_BINDINGS_KEY]: { demo_chain_0a1b2c_write: expect.objectContaining({ agentId: REPLACEMENT }) } });
  });

  it('a derived run that DOES carry its definition (the debug redrive lane) still contributes nothing', async () => {
    // The `:fork` route passes no definition, so that lane is doubly held; the
    // redrive (`routes/workflowDebug.ts`) passes one with `derivedFromRun`, so
    // only the derivedFromRun rule holds it. Client A has a binding right now.
    const meta = { [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA } };
    expect(await agentBindingContributor({ tenantId: TENANT, metadata: meta, definition: definition('wf.agb') })).toHaveProperty(RUN_AGENT_BINDINGS_KEY);
    expect(await agentBindingContributor({ tenantId: TENANT, metadata: meta, definition: definition('wf.agb'), derivedFromRun: true })).toEqual({});
  });

  it('a fault reading the bindings or the toggle is recorded per pinned node, never read as "no binding"', async () => {
    const meta = { [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA } };
    const listSpy = vi.spyOn(bindingService, 'listAgentBindings').mockRejectedValueOnce(new Error('storage down'));
    expect(await agentBindingContributor({ tenantId: TENANT, metadata: meta, definition: definition('wf.agb') }))
      .toEqual({ [RUN_AGENT_BINDINGS_KEY]: { write: { unresolved: true }, review: { unresolved: true } } });
    listSpy.mockRestore();
    const toggleSpy = vi.spyOn(toggleService, 'resolveOne').mockResolvedValueOnce({ id: 'campaign-ops', status: 'on', enabled: false, variant: null, blockedBy: 'unresolved' });
    expect(await agentBindingContributor({ tenantId: TENANT, metadata: meta, definition: definition('wf.agb') }))
      .toEqual({ [RUN_AGENT_BINDINGS_KEY]: { write: { unresolved: true }, review: { unresolved: true } } });
    toggleSpy.mockRestore();
  });

  it('deleting a binding removes it from runs started after, not before', async () => {
    const before = await clientRun(orgA, 'wf.agb');
    const list = await call<{ bindings: ClientAgentBinding[] }>(adminCookie, 'GET', ops(orgA));
    for (const b of list.body.bindings) expect((await call(adminCookie, 'DELETE', `${ops(orgA)}/${b.bindingId}`)).status).toBe(204);
    expect(bindingsOf(await clientRun(orgA, 'wf.agb'))).toBeUndefined();
    expect(bindingsOf((await storage.getRun(before.runId))!)).toBeDefined();
  });
});

describe('ADR 0943 D2 — the runner dispatches the frozen replacement', () => {
  it('a stored run with a binding runs the client agent, not the pin', async () => {
    const now = new Date().toISOString();
    const runId = `run-agb-exec-${String(n++).padStart(8, '0')}`;
    await storage.insertRun({
      runId, workflowId: 'wf.agb', tenantId: TENANT, status: 'running', inputs: {}, configurable: {}, createdAt: now, updatedAt: now,
      metadata: { [RUN_AGENT_BINDINGS_KEY]: { write: { agentId: REPLACEMENT, bindingId: 'agb_x' } } },
    } as RunRecord);
    const callAI = vi.fn<(req: AiCallRequest) => Promise<AiCallResult>>(async () => ({ data: 'done' }));
    const callAIWithTools = vi.fn(async () => { throw new Error('no tools were offered'); });
    const out = await agentRunnerNode.execute({
      tenantId: TENANT, runId, nodeId: 'write', inputs: {}, configurable: {}, emit: async () => {},
      actingUserId: 'someone',
      config: { agentId: PIN, task: 'Write the ad.', offerTools: [], credentialRef: 'managed:openwop-free' },
      callAI, callAIWithTools,
    } as unknown as NodeContext);
    expect(out.status, JSON.stringify(out)).toBe('success');
    expect((out as { outputs: Record<string, unknown> }).outputs.agentId).toBe(REPLACEMENT);
  });

  it('a binding whose agent was uninstalled after start is a typed node failure, never the pin', async () => {
    const now = new Date().toISOString();
    const runId = `run-agb-exec-${String(n++).padStart(8, '0')}`;
    await storage.insertRun({
      runId, workflowId: 'wf.agb', tenantId: TENANT, status: 'running', inputs: {}, configurable: {}, createdAt: now, updatedAt: now,
      metadata: { [RUN_AGENT_BINDINGS_KEY]: { write: { agentId: 'test.cs.uninstalled-writer' } } },
    } as RunRecord);
    const callAI = vi.fn(async () => ({ data: 'should not run' }));
    const out = await agentRunnerNode.execute({
      tenantId: TENANT, runId, nodeId: 'write', inputs: {}, configurable: {}, emit: async () => {}, actingUserId: 'someone',
      config: { agentId: PIN, task: 'Write the ad.', offerTools: [], credentialRef: 'managed:openwop-free' }, callAI, callAIWithTools: callAI,
    } as unknown as NodeContext);
    expect(out).toMatchObject({ status: 'failure', error: { code: 'agent_not_found' } });
    expect(callAI).not.toHaveBeenCalled();
  });

  it('a run whose bindings could not be read refuses the node instead of running the pin', async () => {
    const now = new Date().toISOString();
    const runId = `run-agb-exec-${String(n++).padStart(8, '0')}`;
    await storage.insertRun({
      runId, workflowId: 'wf.agb', tenantId: TENANT, status: 'running', inputs: {}, configurable: {}, createdAt: now, updatedAt: now,
      metadata: { [RUN_AGENT_BINDINGS_KEY]: { write: { unresolved: true } } },
    } as RunRecord);
    const callAI = vi.fn(async () => ({ data: 'should not run' }));
    const out = await agentRunnerNode.execute({
      tenantId: TENANT, runId, nodeId: 'write', inputs: {}, configurable: {}, emit: async () => {}, actingUserId: 'someone',
      config: { agentId: PIN, task: 'Write the ad.', offerTools: [] }, callAI, callAIWithTools: callAI,
    } as unknown as NodeContext);
    expect(out).toMatchObject({ status: 'failure', error: { code: 'agent_binding_unresolved' } });
    expect(callAI).not.toHaveBeenCalled();
  });
});


describe('fresh nested campaign-ops children inherit client scope only', () => {
  async function spawn(method: 'subworkflow' | 'canvas', parent: RunRecord, childWorkflowId: string, beforeCanvasWorkflow?: () => Promise<void>): Promise<RunRecord> {
    const hostSuite: HostAdapterSuite = {
      ...appHostSuite,
      workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: definition(id) }) },
      providerPolicyResolver: { resolveForRun: async () => [] },
    };
    // These witnesses exercise the real constructors/start contributors/storage;
    // the injected execution boundary completes without invoking an AI provider.
    const finish = async (db: Storage, run: RunRecord): Promise<void> => { await db.updateRun(run.runId, { status: 'completed' }); };
    setSubWorkflowDispatcher({ storage, hostSuite, executeRun: finish });
    setCanvasInvokeDispatcher({ storage, getWorkflow: async (_tenantId, id) => {
      await beforeCanvasWorkflow?.();
      return { definition: definition(id) };
    }, executeRun: finish });
    const result = method === 'subworkflow'
      ? await dispatchSubWorkflow({ parentRunId: parent.runId, parentTenantId: TENANT, childWorkflowId, parentNodeId: 'child', waitForCompletion: false,
        childMetadata: { [RUN_AGENT_BINDINGS_KEY]: { write: { agentId: 'forged' } } } })
      : await createCanvasSurface({ tenantId: TENANT, runId: parent.runId, actingUserId: operatorUserId }).invoke(`cv-child-${n++}`, childWorkflowId, {}, { awaitTerminal: true });
    const child = await storage.getRun(result.childRunId);
    if (!child) throw new Error('child constructor did not persist its run');
    return child;
  }

  it.each(['subworkflow', 'canvas'] as const)('%s freezes its own workflow binding and strips parent execution authority', async (method) => {
    const parentWorkflow = `wf.agb.parent-${n++}`;
    const childWorkflow = `wf.agb.child-${n++}`;
    await bindingService.upsertAgentBinding({ tenantId: TENANT, orgId: orgA, updatedBy: operatorUserId,
      body: { pinnedAgentId: PIN, agentId: REPLACEMENT, workflowId: parentWorkflow, nodeId: 'write' } });
    await bindingService.upsertAgentBinding({ tenantId: TENANT, orgId: orgA, updatedBy: operatorUserId,
      body: { pinnedAgentId: PIN, agentId: OTHER, workflowId: childWorkflow, nodeId: 'write' } });
    const parent = await clientRun(orgA, parentWorkflow, { actingUserId: operatorUserId,
      [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA, approvalId: 'parent-approval', changeSetId: 'parent-change-set', changeSetHash: 'a'.repeat(64), requestId: 'parent-request' } });
    expect(bindingsOf(parent)).toMatchObject({ write: { agentId: REPLACEMENT } });
    const child = await spawn(method, parent, childWorkflow);
    expect(child.metadata?.[CAMPAIGN_OPS_RUN_STAMP]).toEqual({ orgId: orgA });
    expect(child.metadata?.actingUserId).toBeUndefined();
    expect(child.metadata?.orgScopeSubject).toBe(operatorUserId);
    expect(bindingsOf(child)).toMatchObject({ write: { agentId: OTHER } });
    expect(runClientOrg(child.metadata as Record<string, unknown>)).toBe(orgA);
  });

  it.each(['subworkflow', 'canvas'] as const)('%s refuses malformed parent client scope instead of silently dropping it', async (method) => {
    const parent = await clientRun(undefined, `wf.agb.bad-parent-${n++}`, { [CAMPAIGN_OPS_RUN_STAMP]: { approvalId: 'parent-approval', orgId: '' } });
    await expect(spawn(method, parent, `wf.agb.bad-child-${n++}`)).rejects.toMatchObject({ code: 'validation_error', details: { reason: 'campaign_client_unresolved' } });
  });

  it.each(['subworkflow', 'canvas'] as const)('%s preserves conflicting scope stamps so wrong_client cannot become an unscoped child', async (method) => {
    const parent = await clientRun(orgA, `wf.agb.mismatch-parent-${n++}`, {
      campaignOrchestration: { campaignId: 'cmp_mismatch', orgId: orgB, goalVersion: 0 }, actingUserId: operatorUserId,
    });
    const child = await spawn(method, parent, `wf.agb.mismatch-child-${n++}`);
    expect(child.metadata?.[CAMPAIGN_OPS_RUN_STAMP]).toEqual({ orgId: orgA });
    expect(child.metadata?.campaignOrchestration).toMatchObject({ orgId: orgB });
    expect(runClientOrg(child.metadata as Record<string, unknown>)).toBeNull();
    expect(bindingsOf(child)).toBeUndefined();
  });

  it.each(['subworkflow', 'canvas'] as const)('%s refuses a parent row from another tenant before inheriting metadata', async (method) => {
    const source = await clientRun(orgA, `wf.agb.foreign-parent-${n++}`);
    const parent: RunRecord = { ...source, runId: `run-agb-foreign-${n++}`, tenantId: 'different-tenant' };
    await storage.insertRun(parent);
    await expect(spawn(method, parent, `wf.agb.foreign-child-${n++}`)).rejects.toThrow(/parent.*tenant/i);
  });

  it.each(['subworkflow', 'canvas'] as const)('%s refuses a missing immediate parent instead of creating an unscoped child', async (method) => {
    const parent = await clientRun(orgA, `wf.agb.missing-parent-${n++}`);
    await storage.deleteRun(parent.runId);
    await expect(spawn(method, parent, `wf.agb.missing-child-${n++}`)).rejects.toThrow(/parent.*tenant/i);
  });

  it('canvas refuses a parent deleted while its child workflow is being resolved', async () => {
    const parent = await clientRun(orgA, `wf.agb.vanishing-parent-${n++}`);
    await expect(spawn('canvas', parent, `wf.agb.vanishing-child-${n++}`, async () => {
      expect(await storage.deleteRun(parent.runId)).toBe(true);
    })).rejects.toThrow(/parent.*tenant/i);
  });
});
