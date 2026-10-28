/**
 * ADR 0944 P0 — client-scoped agent memory: the `org` subject, `memoryScope:
 * 'per-org'`, and ONE resolver on every dispatch lane (D1 + D3).
 *
 * Covers the ADR's D7 tests 1 (run lane + retrieve path), 4 (sentinel, never
 * `agent:<id>`) and the run-stamp rules from D2. The ratchet (test 7) is
 * `adr0944-memory-scope-ratchet.test.ts`.
 *
 * Sabotage-witnessed (P0): replacing the `:no-org` sentinel return in
 * `resolveAgentMemory` with `agentMemoryScope(profile.profileId)` reds the
 * "per-org with no client" and "refused client" cases; restoring the runner's
 * `agentMemoryScope(runnerIdentity.profileId)` reds "client A's fact never reaches
 * client B"; dropping the both-stamps comparison in `runClientStamp` reds
 * "two stamps naming different clients".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { createApp } from '../src/index.js';
import agentRunnerNode from '../src/host/agentRunnerNode.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { createMember, createOrg, createWorkspace, deleteMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import {
  agentMemoryScope, createAgentMemoryPort, isSentinelMemoryScope, resolveAgentMemory, resolveAgentMemoryScope,
} from '../src/host/agentMemoryAdapter.js';
import { resolveAgentKnowledgeRetrieve } from '../src/host/agentKnowledgeComposition.js';
import { runClientStamp, resolveRunMemoryClient } from '../src/host/runClientOrg.js';
import { buildLiveDispatchLane } from '../src/host/liveDispatchLane.js';
import { orgSubject, subjectScope } from '../src/host/subject.js';
import { subjectMemoryScope } from '../src/host/subjectMemory.js';
import { listMemoryEntries } from '../src/host/inMemorySurfaces.js';
import type { AiCallRequest, AiCallResult, NodeContext, WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { dispatchSubWorkflow, setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { createCanvasSurface, setCanvasInvokeDispatcher } from '../src/host/canvasSurface.js';

const AGENT = 'test.adr0944-copywriter';
const SHARED_AGENT = 'test.adr0944-shared';
const OPS_STAMP = 'openwop-app.campaignOps';

let server: http.Server;
let TENANT: string;
let both: string; // a member of client A and client B
let onlyA: string; // a member of client A only
let orgA: string;
let orgB: string;
let storage: Storage;
let appHostSuite: HostAdapterSuite;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  appHostSuite = app.locals.hostSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:adr0944-owner' });
  TENANT = ws.tenantId;
  both = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:adr0944-both', source: 'oidc' })).userId;
  onlyA = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:adr0944-only-a', source: 'oidc' })).userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: both, displayName: 'Both', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: both, displayName: 'Both', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: onlyA, displayName: 'Only A', roles: ['editor'] });
  await upsertAgentProfile(TENANT, AGENT, { roleKey: 'copywriter', autonomy: { specLevel: 'recommend' }, memoryScope: 'per-org' });
  await upsertAgentProfile(TENANT, SHARED_AGENT, { roleKey: 'strategist', autonomy: { specLevel: 'recommend' } });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const registry = getAgentRegistry();
beforeEach(() => {
  registry._resetForTest();
  for (const agentId of [AGENT, SHARED_AGENT]) {
    registry.register({
      agentId, persona: agentId, modelClass: 'chat', systemPrompt: 'You write campaign copy.',
      packName: 'test', packVersion: '0', toolAllowlist: [], memoryShape: { longTerm: true },
    } as ResolvedAgentManifest);
  }
  vi.restoreAllMocks();
});

async function stampedRun(metadata: Record<string, unknown>): Promise<string> {
  const runId = `run-0944-${randomBytes(5).toString('hex')}`;
  await hostExtStorage().insertRun({
    runId, workflowId: 'w', tenantId: TENANT, status: 'running', inputs: null,
    metadata, configurable: {}, createdAt: 'x', updatedAt: 'x',
  });
  return runId;
}

/** Run one agent node; return the prompt the model saw. */
async function runNode(opts: { runId: string; agentId?: string; actor?: string; task: string; reply: string }): Promise<string> {
  const stored = await storage.getRun(opts.runId);
  const cause = stored?.metadata?.orgScopeSubject;
  let prompt = '';
  const callAI = vi.fn<(req: AiCallRequest) => Promise<AiCallResult>>(async (req) => {
    prompt = JSON.stringify(req.messages);
    return { content: opts.reply } as AiCallResult;
  });
  const out = await agentRunnerNode.execute({
    tenantId: TENANT, runId: opts.runId, nodeId: 'copy', configurable: {},
    inputs: { agentId: opts.agentId ?? AGENT, task: opts.task, credentialRef: 'managed:openwop-free' },
    config: { offerTools: [] },
    ...(opts.actor ? { actingUserId: opts.actor } : {}),
    ...(typeof cause === 'string' ? { orgScopeSubject: cause } : {}),
    emit: async () => {},
    callAI,
    callAIWithTools: vi.fn(async () => { throw new Error('no tools offered'); }),
  } as unknown as NodeContext);
  expect(out.status, JSON.stringify(out)).toBe('success');
  expect(callAI).toHaveBeenCalledTimes(1);
  return prompt;
}

const contents = async (scope: string): Promise<string[]> =>
  (await listMemoryEntries(TENANT, scope)).map((e) => e.content);

describe('ADR 0944 D1 — the resolver', () => {
  it('a client binding resolves to the shared `org:<orgId>` scope, writable', () => {
    const r = resolveAgentMemory({ profileId: 'p1', memoryScope: 'per-org' }, { client: { orgId: 'org-a' } });
    expect(r).toEqual({ scope: subjectScope(orgSubject('org-a')), writable: true });
    expect(r.scope).toBe('org:org-a');
  });

  it('per-org with no client → the `:no-org` sentinel: never written, never `agent:<id>`, the model is told', () => {
    const r = resolveAgentMemory({ profileId: 'p1', memoryScope: 'per-org' }, { userId: 'u1' });
    expect(r.scope).not.toBe(agentMemoryScope('p1'));
    expect(r.scope.startsWith(agentMemoryScope('p1'))).toBe(true);
    expect(isSentinelMemoryScope(r.scope)).toBe(true);
    expect(r.writable).toBe(false);
    expect(r.unavailable).toBe('client-memory');
  });

  it('a REFUSED client binding is the sentinel for every profile — never a fallback to the profile scope', () => {
    for (const memoryScope of ['agent', 'per-user', 'per-org', undefined] as const) {
      const r = resolveAgentMemory({ profileId: 'p1', ...(memoryScope ? { memoryScope } : {}) }, { userId: 'u1', client: { refused: 'forbidden' } });
      expect(isSentinelMemoryScope(r.scope), String(memoryScope)).toBe(true);
      expect(r.scope).not.toBe(agentMemoryScope('p1'));
      expect(r.scope).not.toBe(subjectMemoryScope({ kind: 'user', id: 'u1' }));
      expect(r.writable).toBe(false);
    }
  });

  it('Q6 — a client binding governs an `agent`- or `per-user`-scoped agent too (no client fact lands in a cross-client scope)', () => {
    expect(resolveAgentMemoryScope({ profileId: 'p1' }, { client: { orgId: 'org-a' } })).toBe('org:org-a');
    expect(resolveAgentMemoryScope({ profileId: 'p1', memoryScope: 'per-user' }, { userId: 'u1', client: { orgId: 'org-a' } })).toBe('org:org-a');
  });

  it('with no client, `agent` and `per-user` are unchanged (ADR 0442)', () => {
    expect(resolveAgentMemory({ profileId: 'p1' }, {})).toEqual({ scope: agentMemoryScope('p1'), writable: true });
    expect(resolveAgentMemory({ profileId: 'p1', memoryScope: 'per-user' }, { userId: 'u1' })).toEqual({ scope: subjectMemoryScope({ kind: 'user', id: 'u1' }), writable: true });
    const noActor = resolveAgentMemory({ profileId: 'p1', memoryScope: 'per-user' }, {});
    expect(noActor.writable).toBe(false);
    expect(noActor.unavailable).toBeUndefined(); // the silent ADR 0442 sentinel stays silent
  });
});

describe('ADR 0944 D2 — the run lane reads the client from host-written stamps only', () => {
  it('reads either stamp; two stamps naming different clients are refused `wrong_client`', () => {
    expect(runClientStamp({ campaignOrchestration: { orgId: 'a', campaignId: 'c' } })).toEqual({ orgId: 'a' });
    expect(runClientStamp({ [OPS_STAMP]: { orgId: 'a' } })).toEqual({ orgId: 'a' });
    expect(runClientStamp({ campaignOrchestration: { orgId: 'a' }, [OPS_STAMP]: { orgId: 'a' } })).toEqual({ orgId: 'a' });
    expect(runClientStamp({ campaignOrchestration: { orgId: 'a' }, [OPS_STAMP]: { orgId: 'b' } })).toEqual({ refused: 'wrong_client' });
    expect(runClientStamp({ campaignOrchestration: { briefId: 'x' } })).toEqual({ refused: 'unreadable' });
    expect(runClientStamp({ orgId: 'a' })).toBeUndefined(); // a bare caller key names nothing
  });

  it('refuses every malformed present client stamp, including one beside a valid stamp', () => {
    for (const block of [null, 'a', [], {}, { orgId: '' }, { orgId: '  ' }, { orgId: 3 }]) {
      expect(runClientStamp({ [OPS_STAMP]: block })).toEqual({ refused: 'unreadable' });
      expect(runClientStamp({ [OPS_STAMP]: { orgId: 'a' }, campaignOrchestration: block })).toEqual({ refused: 'unreadable' });
    }
    expect(runClientStamp({ [OPS_STAMP]: undefined })).toBeUndefined();
  });

  it('checks the person behind the run on that client; an org of another tenant is refused', async () => {
    const runA = await stampedRun({ [OPS_STAMP]: { orgId: orgA } });
    const runB = await stampedRun({ [OPS_STAMP]: { orgId: orgB } });
    expect(await resolveRunMemoryClient({ tenantId: TENANT, runId: runA, actingUserId: onlyA })).toEqual({ orgId: orgA });
    expect(await resolveRunMemoryClient({ tenantId: TENANT, runId: runB, actingUserId: onlyA })).toEqual({ refused: 'forbidden' });
    expect(await resolveRunMemoryClient({ tenantId: TENANT, runId: runB, orgScopeSubject: onlyA })).toEqual({ refused: 'forbidden' });
    const foreign = await stampedRun({ [OPS_STAMP]: { orgId: 'org-of-someone-else' } });
    expect(await resolveRunMemoryClient({ tenantId: TENANT, runId: foreign })).toEqual({ refused: 'forbidden' });
    expect(await resolveRunMemoryClient({ tenantId: TENANT, runId: await stampedRun({}) })).toBeUndefined();
    // A run of another tenant is not this run.
    expect(await resolveRunMemoryClient({ tenantId: 'other-tenant', runId: runA })).toEqual({ refused: 'unreadable' });
  });
});

describe('ADR 0944 D7 — isolation on the run lane (test 1) and the sentinel (test 4)', () => {
  it("client A's fact never reaches client B; it does reach client A's next run", async () => {
    const runA = await stampedRun({ campaignOrchestration: { orgId: orgA, campaignId: 'cmp-a' } });
    await runNode({ runId: runA, actor: both, task: 'Draft the hero line for client A', reply: 'FACT-ALPHA: never mention the rival brand' });
    expect((await contents('org:' + orgA)).join('\n')).toContain('FACT-ALPHA');
    expect(await contents(agentMemoryScope(AGENT))).toEqual([]);

    const runB = await stampedRun({ [OPS_STAMP]: { orgId: orgB } });
    const promptB = await runNode({ runId: runB, actor: both, task: 'Draft the hero line for client B', reply: 'FACT-BETA' });
    expect(promptB).not.toContain('FACT-ALPHA');
    expect((await contents('org:' + orgB)).join('\n')).toContain('FACT-BETA');

    const runA2 = await stampedRun({ [OPS_STAMP]: { orgId: orgA } });
    const promptA2 = await runNode({ runId: runA2, actor: both, task: 'Draft a subject line for client A', reply: 'ok' });
    expect(promptA2, 'non-vacuity: the same lane DOES recall A in an A run').toContain('FACT-ALPHA');
    expect(promptA2).not.toContain('FACT-BETA');
  });

  it('an `agent`-scoped agent in a client run writes the client scope, not its shared one (Q6)', async () => {
    const runA = await stampedRun({ [OPS_STAMP]: { orgId: orgA } });
    await runNode({ runId: runA, agentId: SHARED_AGENT, actor: both, task: 'Plan client A', reply: 'FACT-SHARED-A' });
    expect(await contents(agentMemoryScope(SHARED_AGENT))).toEqual([]);
    expect((await contents('org:' + orgA)).join('\n')).toContain('FACT-SHARED-A');
  });

  it('a per-org agent with no client: empty recall, a degradation notice, nothing written anywhere', async () => {
    const runX = await stampedRun({});
    const prompt = await runNode({ runId: runX, actor: both, task: 'Draft without a client', reply: 'FACT-NOWHERE' });
    expect(prompt).toContain("this client's shared memory");
    expect(prompt).not.toContain('FACT-ALPHA');
    expect(await contents(agentMemoryScope(AGENT))).toEqual([]);
    expect(await contents(`${agentMemoryScope(AGENT)}:no-org`)).toEqual([]);
    for (const org of [orgA, orgB]) expect((await contents('org:' + org)).join('\n')).not.toContain('FACT-NOWHERE');
  });

  it('a person without rows on the client gets the sentinel, not the client memory', async () => {
    const runB = await stampedRun({ [OPS_STAMP]: { orgId: orgB } });
    const prompt = await runNode({ runId: runB, actor: onlyA, task: 'Draft for B', reply: 'FACT-DENIED' });
    expect(prompt).not.toContain('FACT-BETA');
    expect(prompt).toContain("this client's shared memory");
    expect((await contents('org:' + orgB)).join('\n')).not.toContain('FACT-DENIED');
  });

  it('two stamps naming different clients: the sentinel, nothing read or written', async () => {
    const run = await stampedRun({ campaignOrchestration: { orgId: orgA }, [OPS_STAMP]: { orgId: orgB } });
    const prompt = await runNode({ runId: run, actor: both, task: 'Draft', reply: 'FACT-CONFLICT' });
    expect(prompt).not.toContain('FACT-ALPHA');
    expect(prompt).not.toContain('FACT-BETA');
    for (const org of [orgA, orgB]) expect((await contents('org:' + org)).join('\n')).not.toContain('FACT-CONFLICT');
  });
});

describe('ADR 0944 D3 — the other lanes go through the same resolver', () => {
  it('the ad-hoc dispatch lane hands a per-org agent the sentinel and the degradation label', async () => {
    const lane = await buildLiveDispatchLane({ tenantId: TENANT, agentId: AGENT, dispatchRunId: 'adhoc-0944', userId: both });
    expect(isSentinelMemoryScope(lane.deps.memoryScope ?? '')).toBe(true);
    expect(lane.deps.memoryUnavailable).toBe("this client's shared memory");
    expect(lane.deps.memoryWrite?.skip).toBe(true);
  });

  it('the knowledge path reads the bound client and only it', async () => {
    await upsertAgentProfile(TENANT, AGENT, { roleKey: 'copywriter', autonomy: { specLevel: 'recommend' }, memoryScope: 'per-org', capabilities: ['knowledge'] });
    const memory = createAgentMemoryPort(TENANT);
    const text = async (ctx: Parameters<typeof resolveAgentKnowledgeRetrieve>[3]): Promise<string> => {
      const retrieve = await resolveAgentKnowledgeRetrieve(TENANT, AGENT, memory, ctx);
      return retrieve ? JSON.stringify(await retrieve('hero line')) : '';
    };
    expect(await text({ client: { orgId: orgA } })).toContain('FACT-ALPHA');
    expect(await text({ client: { orgId: orgB } })).not.toContain('FACT-ALPHA');
    expect(await text({ userId: both })).not.toContain('FACT-ALPHA'); // the retrieve preview: no client ⇒ sentinel
  });
});

describe('ADR 0944 — actual nested constructors keep client memory isolated', () => {
  async function child(method: 'subworkflow' | 'canvas', metadata: Record<string, unknown>): Promise<RunRecord> {
    const parentId = await stampedRun(metadata);
    const workflowId = `wf.memory-child-${randomBytes(5).toString('hex')}`;
    const def: WorkflowDefinition = { workflowId, nodes: [{ nodeId: 'copy', typeId: 'local.openwop-app.agent-runner', config: { agentId: AGENT } }] };
    const finish = async (db: Storage, run: RunRecord): Promise<void> => { await db.updateRun(run.runId, { status: 'completed' }); };
    setSubWorkflowDispatcher({ storage, hostSuite: {
      ...appHostSuite, workflowCatalog: { getWorkflow: async () => ({ workflowId, definition: def }) },
      providerPolicyResolver: { resolveForRun: async () => [] },
    }, executeRun: finish });
    setCanvasInvokeDispatcher({ storage, getWorkflow: async () => ({ definition: def }), executeRun: finish });
    const result = method === 'subworkflow'
      ? await dispatchSubWorkflow({ parentRunId: parentId, parentTenantId: TENANT, parentNodeId: 'nested', childWorkflowId: workflowId })
      : await createCanvasSurface({ tenantId: TENANT, runId: parentId,
        ...(typeof metadata.actingUserId === 'string' ? { actingUserId: metadata.actingUserId } : {})
      }).invoke(`cv-memory-${randomBytes(5).toString('hex')}`, workflowId, {}, { awaitTerminal: true });
    const row = await storage.getRun(result.childRunId);
    if (!row) throw new Error('nested constructor did not store its child');
    return row;
  }

  it.each(['subworkflow', 'canvas'] as const)('%s recalls A only for A, isolates B, and keeps an unscoped per-org child at the sentinel', async (method) => {
    const fact = `NESTED-ALPHA-${method}`;
    const a = await child(method, { [OPS_STAMP]: { orgId: orgA }, actingUserId: both });
    expect(a.metadata?.[OPS_STAMP]).toEqual({ orgId: orgA });
    expect(a.metadata?.actingUserId).toBeUndefined();
    expect(a.metadata?.orgScopeSubject).toBe(both);
    await runNode({ runId: a.runId, task: 'Remember the client constraint', reply: fact });
    const a2 = await child(method, { [OPS_STAMP]: { orgId: orgA }, actingUserId: both });
    expect(await runNode({ runId: a2.runId, task: 'Recall the client constraint', reply: 'A recalled' })).toContain(fact);
    const b = await child(method, { [OPS_STAMP]: { orgId: orgB }, actingUserId: both });
    expect(await runNode({ runId: b.runId, task: 'Recall for B', reply: `NESTED-BETA-${method}` })).not.toContain(fact);
    const none = await child(method, { actingUserId: both });
    const prompt = await runNode({ runId: none.runId, task: 'No client', reply: `NESTED-NOWHERE-${method}` });
    expect(prompt).not.toContain(fact);
    expect(prompt).toContain("this client's shared memory");
    expect(await contents(agentMemoryScope(AGENT))).toEqual([]);
    expect(await contents(`${agentMemoryScope(AGENT)}:no-org`)).toEqual([]);
    for (const org of [orgA, orgB]) expect((await contents('org:' + org)).join('\n')).not.toContain(`NESTED-NOWHERE-${method}`);
  });

  it.each(['subworkflow', 'canvas'] as const)('%s rechecks the causing member after child creation, even for an agent with shared defaults', async (method) => {
    const user = await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:memory-revoke-${method}`, source: 'oidc' });
    const member = await createMember({ tenantId: TENANT, orgId: orgA, subject: user.userId, displayName: 'Revoked later', roles: ['editor'] });
    const row = await child(method, { [OPS_STAMP]: { orgId: orgA }, actingUserId: user.userId });
    const unique = `NESTED-BEFORE-REVOKE-${method}`;
    await runNode({ runId: row.runId, agentId: SHARED_AGENT, task: 'Remember before revocation', reply: unique });
    expect((await contents('org:' + orgA)).join('\n')).toContain(unique);
    expect(await deleteMember(member.memberId)).toBe(true);
    const prompt = await runNode({ runId: row.runId, agentId: SHARED_AGENT, task: 'Recall after revocation', reply: `NESTED-DENIED-${method}` });
    expect(prompt).not.toContain(unique);
    expect(prompt).toContain("this client's shared memory");
    expect((await contents('org:' + orgA)).join('\n')).not.toContain(`NESTED-DENIED-${method}`);
    expect(await contents(agentMemoryScope(SHARED_AGENT))).toEqual([]);
  });

  it('missing/foreign runs and malformed stamps never recall or write the shared agent fallback', async () => {
    const valid = await stampedRun({});
    await runNode({ runId: valid, agentId: SHARED_AGENT, actor: both, task: 'Remember shared canary', reply: 'SHARED-HANDLE-CANARY' });
    expect((await contents(agentMemoryScope(SHARED_AGENT))).join('\n')).toContain('SHARED-HANDLE-CANARY');
    const foreign = `run-foreign-memory-${randomBytes(5).toString('hex')}`;
    await storage.insertRun({ runId: foreign, workflowId: 'w', tenantId: 'other-tenant', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    const malformed = await stampedRun({ [OPS_STAMP]: { approvalId: 'no-client' } });
    const badSibling = await stampedRun({ [OPS_STAMP]: { orgId: orgA }, campaignOrchestration: null });
    for (const runId of ['missing-memory-run', foreign, malformed, badSibling]) {
      const prompt = await runNode({ runId, agentId: SHARED_AGENT, actor: both, task: 'Recall', reply: `HANDLE-DENIED-${runId}` });
      expect(prompt).not.toContain('SHARED-HANDLE-CANARY');
      expect(prompt).toContain("this client's shared memory");
      expect((await contents(agentMemoryScope(SHARED_AGENT))).join('\n')).not.toContain(`HANDLE-DENIED-${runId}`);
    }
  });

  it.each(['subworkflow', 'canvas'] as const)('%s gives a shared-default agent only the client scope and revokes it without falling back', async (method) => {
    const who = await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:memory-canaries-${method}`, source: 'oidc' });
    const aOrg = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: `Nested A ${method}` })).orgId;
    const bOrg = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: `Nested B ${method}` })).orgId;
    const member = await createMember({ tenantId: TENANT, orgId: aOrg, subject: who.userId, displayName: 'Both', roles: ['editor'] });
    await createMember({ tenantId: TENANT, orgId: bOrg, subject: who.userId, displayName: 'Both', roles: ['editor'] });
    const scopes = [`org:${aOrg}`, `org:${bOrg}`, agentMemoryScope(SHARED_AGENT), subjectMemoryScope({ kind: 'user', id: who.userId })];
    const canaries = ['NEST-A', 'NEST-B', 'NEST-SHARED', 'NEST-PERSONAL'].map((s) => `${s}-${method}`);
    const memory = createAgentMemoryPort(TENANT);
    for (let i = 0; i < scopes.length; i++) await memory.write(scopes[i]!, { content: canaries[i]! });
    const before = await Promise.all(scopes.map(contents));
    const row = await child(method, { [OPS_STAMP]: { orgId: aOrg }, actingUserId: who.userId });
    const reply = `NEST-OWN-WRITE-${method}`;
    const prompt = await runNode({ runId: row.runId, agentId: SHARED_AGENT, task: 'Recall the client constraint', reply });
    expect(prompt).toContain(canaries[0]);
    for (const canary of canaries.slice(1)) expect(prompt).not.toContain(canary);
    expect((await contents(scopes[0]!)).join('\n')).toContain(reply);
    for (let i = 1; i < scopes.length; i++) expect(await contents(scopes[i]!)).toEqual(before[i]);
    expect(await deleteMember(member.memberId)).toBe(true);
    const afterAllowed = await Promise.all(scopes.map(contents));
    const denied = await runNode({ runId: row.runId, agentId: SHARED_AGENT, task: 'Recall after losing A but retaining B', reply: `NEST-REVOKED-WRITE-${method}` });
    expect(denied).toContain("this client's shared memory");
    for (const canary of canaries) expect(denied).not.toContain(canary);
    expect(await Promise.all(scopes.map(contents))).toEqual(afterAllowed);
    expect(await contents(`${agentMemoryScope(SHARED_AGENT)}:no-org`)).toEqual([]);
  });
});
