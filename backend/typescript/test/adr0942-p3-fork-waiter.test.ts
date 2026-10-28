/**
 * ADR 0942 P3a (grade-workflows finding) — a `:fork` that lands inside a node's
 * wait on a spend approval must be resumed by that approval's decision too.
 *
 * ADR 0751 re-creates the waiting interrupt row for the fork WITHOUT re-running
 * the node, so nothing registered the fork in the approval-waiter store: the
 * decision resumed the source and the fork stranded at the gate. The re-create
 * path now registers the fork. Driven through the real `:fork` route.
 *
 * Sabotage note (2026-10-20): drop the `recordApprovalWaiter` call in
 * `executor/forkInterrupts.ts` → red (the fork stays `waiting-external`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { claimApproval } from '../src/host/approvalDecision.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { executeRun } from '../src/executor/executor.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { AUTONOMY_TOGGLE, bindClientPresetIfAbsent, reconcileApprovalWaits } from '../src/host/autonomyPolicy/index.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import { bareRunId } from './support/bareRunId.js';

const T = 'default';
let server: http.Server;
let BASE: string;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let platform: http.Server;
let responseBarrier: Promise<void> | null = null;
let platformCalls = 0;

async function setToggle(id: string): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: 'on' }, 'test');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await __resetConnectionsStore();
  platform = http.createServer(async (req, res) => { platformCalls++; req.resume(); if (responseBarrier) await responseBarrier; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ results: [{ customer: { currencyCode: 'USD' }, resourceName: 'customers/1/campaignBudgets/1', campaign: { campaignBudget: 'customers/1/campaignBudgets/1' } }] })); });
  await new Promise<void>((r) => platform.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_GOOGLE_ADS_API_BASE = `http://127.0.0.1:${(platform.address() as AddressInfo).port}/google`;
  registerProvider({ id: 'google-ads', label: 'google-ads', kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
  await createSecretConnection({ tenantId: T, provider: 'google-ads', kind: 'bearer', secret: 'TOK', scope: 'workspace' });
  for (const id of ['campaign-orchestration', 'campaign-channels', AUTONOMY_TOGGLE]) await setToggle(id);
});
afterAll(async () => {
  delete process.env.OPENWOP_GOOGLE_ADS_API_BASE;
  delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
  await new Promise<void>((r) => platform.close(() => r()));
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0942 — a fork inside a spend wait is resumed by the decision', () => {
  it('the decision resumes the source and every fork waiting on it; a branch fork then asks for its own approval', async () => {
    const orgId = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Fork client', ownerSubject: 'u-owner' })).orgId;
    await createMember({ tenantId: T, orgId, subject: 'u-admin-2', displayName: 'Admin', roles: ['admin'] });
    await bindClientPresetIfAbsent(T, orgId, 'guarded@1', 'u-owner');
    const brief = await createBrief(T, orgId, 'u-owner', { name: 'Fork launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
    const campaign = (await ensureDraftCampaign(T, brief, 'u-owner')).campaign;
    const def = {
      workflowId: 'wf.p3.fork', name: 'wf.p3.fork', version: '1.0.0',
      nodes: [{ nodeId: 'budget', typeId: 'core.openwop.connectors.ad-budget-update', config: { platform: 'google', adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: 41_000, dryRun: false } }],
      edges: [],
    } as unknown as WorkflowDefinition;
    registerHostWorkflow(def);
    const now = new Date().toISOString();
    const src: RunRecord = {
      runId: `r-fork-src-${Math.random().toString(36).slice(2, 8)}`, workflowId: 'wf.p3.fork', tenantId: T, status: 'pending', inputs: {},
      metadata: { campaignOrchestration: stampCampaignRun(campaign, { role: 'optimizer' }), actingUserId: 'u-requester' },
      configurable: {}, createdAt: now, updatedAt: now,
    };
    await insertRunWithStartContext(storage, src);
    expect((await executeRun(storage, (await storage.getRun(src.runId)) ?? src, def)).status).toBe('waiting-external');
    const [open] = await storage.listOpenInterrupts(src.runId);
    const approvalId = (open?.data as { approvalId?: string } | undefined)?.approvalId;
    if (!approvalId) throw new Error('expected the source to wait on an approval');

    const fromSeq = await getEventLog().getMaxSequence(src.runId);
    const forkOf = async (mode: 'replay' | 'branch', expected: 'waiting-external' | 'completed' = 'waiting-external'): Promise<string> => {
      const res = await fetch(`${BASE}/runs/${encodeURIComponent(`${T}/${src.runId}`)}:fork`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
        body: JSON.stringify({ fromSeq, mode }),
      });
      const body = (await res.json()) as { runId?: string };
      expect(res.status, JSON.stringify(body)).toBe(201);
      const id = bareRunId(body.runId ?? '');
      // Let the fork's dispatch reach its re-created gate.
      for (let i = 0; i < 50 && (await storage.getRun(id))?.status !== expected; i++) await new Promise((r) => setTimeout(r, 20));
      expect((await storage.getRun(id))?.status, mode).toBe(expected);
      return id;
    };
    const replayFork = await forkOf('replay');
    const branchFork = await forkOf('branch');

    // Hold the live provider response while the replay resumes: the source
    // cannot have a recorded terminal outcome yet, so the missing-source arm
    // is deterministic instead of depending on executor scheduling.
    let release!: () => void;
    responseBarrier = new Promise<void>(resolve => { release = resolve; });
    try {
      await claimApproval({ storage, hostSuite }, { tenantId: T, decidedBy: 'u-admin-2' }, approvalId);
      await __awaitRunResumeChainForTests(replayFork);
    } finally { responseBarrier = null; release(); }
    for (const id of [src.runId, branchFork]) await __awaitRunResumeChainForTests(id);

    const srcRow = await storage.getRun(src.runId);
    expect(srcRow?.status, JSON.stringify(srcRow?.error ?? null)).toBe('completed');
    // A replay fork was resumed (not stranded), and then refused to fire an effect
    // its source never recorded: a replay never creates a new side effect.
    const replayRow = await storage.getRun(replayFork);
    expect(replayRow?.status).toBe('failed');
    expect(replayRow?.error).toMatchObject({ code: 'replay_source_missing' });
    // A branch fork was resumed, re-ran its chokepoint under the attended posture,
    // and now waits on ITS OWN approval, never the source's (D10.4).
    expect((await storage.getRun(branchFork))?.status).toBe('waiting-external');
    const [again] = await storage.listOpenInterrupts(branchFork);
    const forkApproval = (again?.data as { approvalId?: string } | undefined)?.approvalId;
    expect(forkApproval).toBeTruthy();
    expect(forkApproval).not.toBe(approvalId);

    // Forking the old wait AFTER the approval finalized cannot rely on the
    // finalizer firing again. The existing dispatch recovery must wake it.
    const calls = platformCalls;
    expect(calls).toBeGreaterThan(0);
    const lateReplay = await forkOf('replay', 'completed');
    expect(await reconcileApprovalWaits(storage, hostSuite)).toBe(0);
    await __awaitRunResumeChainForTests(lateReplay);
    expect((await storage.getRun(lateReplay))?.status).toBe('completed');
    expect(platformCalls).toBe(calls);
    const output = async (id: string) => (await storage.listEvents(id)).find(e => e.type === 'node.completed' && e.nodeId === 'budget')?.payload;
    const original = await output(src.runId);
    expect(original).toMatchObject({ outputs: { applied: true } });
    expect(await output(lateReplay)).toMatchObject({ outputs: (original as { outputs: unknown }).outputs });
  });
});
