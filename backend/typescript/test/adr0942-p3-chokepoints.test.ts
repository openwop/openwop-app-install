/**
 * ADR 0942 P3 — the effect chokepoints consult the campaign's frozen autonomy
 * policy, through the REAL ads and SMS adapters against a local fake platform,
 * the real approval decision core, and real runs.
 *
 * Exit criteria (phase row P3): a budget move above the grant re-asks; an auto
 * send is audited; a preview client is blocked.
 *
 * Sabotage notes (each run, 2026-10-20):
 *  - drop the `att:` namespacing in evaluateSpendGate → red (a branch fork reuses the source's approval);
 *  - return early from `registerAutonomySpendEligibility`'s check → red (the requester / a non-approver decides);
 *  - skip `enforceCampaignAction` in smsAdapter → red (no decision audited; no grant needed);
 *  - drop the client floor seam registration → red (a preview client's spend proceeds to approval);
 *  - skip `resumeAwaitingRunsSafely` on approve → red (the waiting run never resumes).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { makeSmsAdapter } from '../src/host/smsAdapter.js';
import { pushCatalogItems } from '../src/host/catalogPushAdapter.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { pushCatalog, saveFeedSettings } from '../src/features/campaign-connectors/catalogFeed.js';
import { MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { nodes as connectorNodes } from '../../../packs/feature.campaign-connectors.nodes/index.mjs';
import { claimApproval, rejectApproval } from '../src/host/approvalDecision.js';
import { createCampaignSpendApproval, getApproval } from '../src/host/approvalService.js';
import { listChain } from '../src/host/auditChainService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { createClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import {
  AUTONOMY_TOGGLE, FORK_POSTURE_KEY, getBinding, presetRules, savePolicy, type ActionRule,
  reconcileApprovalWaits,
} from '../src/host/autonomyPolicy/index.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { opaquePrincipal } from '../src/host/runOwner.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import { nodes as channelNodes } from '../../../packs/feature.campaign-channels.nodes/index.mjs';

const T = 'adr0942-p3';
let srv: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let hits = 0;
let orgId: string;
let campaign: MarketingCampaign;
let n = 0;
const deps = { storage: null as unknown as Storage, hostSuite: null as unknown as HostAdapterSuite };

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

/** A campaign run stamped through the real seam (the requester is u1). */
async function campaignRun(extraMeta: Record<string, unknown> = {}, extra: Partial<RunRecord> = {}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `r-p3-${n++}-${Math.random().toString(36).slice(2, 8)}`, workflowId: 'wf.p3', tenantId: T, status: 'pending', inputs: {},
    metadata: { campaignOrchestration: stampCampaignRun(campaign, { role: 'optimizer' }), actingUserId: 'u1', ...extraMeta },
    configurable: {}, createdAt: now, updatedAt: now, ...extra,
  };
  await insertRunWithStartContext(storage, run);
  return (await storage.getRun(run.runId)) ?? run;
}

const ads = (runId: string) => makeAdsAdapter({ storage, tenantId: T, runId, actingUserId: 'u1', orgId: T });
const budget = (amount: number) => ({ platform: 'google' as const, adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: amount });
const decide = (approvalId: string, decidedBy: string) => claimApproval(deps, { tenantId: T, decidedBy }, approvalId);
const autonomyAudits = async (): Promise<Array<Record<string, unknown>>> =>
  (await listChain(T)).filter((e) => e.kind === 'campaign.autonomy.decision').map((e) => e.payload as Record<string, unknown>);

async function setCampaignPolicy(rules: ActionRule[] | 'autopilot@1' | 'guarded@1'): Promise<void> {
  const expected = await getBinding(T, orgId, campaign.id);
  await savePolicy({
    tenantId: T, orgId, campaignId: campaign.id, actor: 'u-owner', expected,
    input: typeof rules === 'string' ? { kind: 'preset', preset: rules } : { kind: 'custom', name: 'test', basePreset: 'guarded@1', rules },
  });
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  deps.storage = storage; deps.hostSuite = hostSuite;
  await __resetConnectionsStore();
  srv = http.createServer((req, res) => { hits++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'x', results: [{ customer: { currencyCode: 'USD' }, resourceName: 'customers/1/campaignBudgets/1', campaign: { campaignBudget: 'customers/1/campaignBudgets/1' } }] })); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_GOOGLE_ADS_API_BASE = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/google`;
  registerProvider({ id: 'google-ads', label: 'google-ads', kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
  await createSecretConnection({ tenantId: T, provider: 'google-ads', kind: 'bearer', secret: 'TOK', scope: 'user', userId: 'u1' });
  for (const id of ['campaign-orchestration', 'campaign-channels', AUTONOMY_TOGGLE]) await setToggle(id, true);
  orgId = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  for (const [subject, role] of [['u1', 'admin'], ['u-admin-2', 'admin'], ['u-editor', 'editor']] as const) {
    await createMember({ tenantId: T, orgId, subject, displayName: subject, roles: [role] });
  }
  // A real agency client (so the client floor applies), live and active.
  await createClient({ tenantId: T, name: 'Client A', orgId, createdBy: 'u-owner' });
  await updateClient(T, orgId, { mode: 'live' });
  const brief = await createBrief(T, orgId, 'u-owner', { name: 'Spring launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  campaign = (await ensureDraftCampaign(T, brief, 'u-owner')).campaign;
});
afterAll(async () => {
  delete process.env.OPENWOP_GOOGLE_ADS_API_BASE;
  delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
  await new Promise<void>((r) => srv.close(() => r()));
});

describe('ADR 0942 P3 — ads: the policy decides a campaign run\'s spend', () => {
  it('refuses the causing admin of an actorless run and a delegated spelling of that admin', async () => {
    const { key } = await issueApiKey({ tenantId: T, name: 'causing admin', createdBy: 'u1' });
    const run = await campaignRun({ actingUserId: undefined, orgScopeSubject: 'u1' });
    const out = await ads(run.runId).updateBudget(budget(36_101));
    if (out.outcome !== 'requires_approval') throw new Error('expected approval');
    expect(await getApproval(out.approvalId)).toMatchObject({ autonomySourceRunId: run.runId, submitterCauses: ['u1'] });
    for (const who of ['u1', `apikey:${key.keyId}`]) {
      await expect(decide(out.approvalId, who)).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
    }
    await expect(decide(out.approvalId, 'u-admin-2')).resolves.toBeDefined();
  });

  it('canonicalizes a delegated requester in the stored row, keeping actor-before-cause precedence', async () => {
    const { key } = await issueApiKey({ tenantId: T, name: 'acting admin', createdBy: 'u1' });
    const run = await campaignRun({ actingUserId: `apikey:${key.keyId}`, orgScopeSubject: 'u-admin-2' });
    const out = await ads(run.runId).updateBudget(budget(36_102));
    if (out.outcome !== 'requires_approval') throw new Error('expected approval');
    await expect(decide(out.approvalId, 'u1')).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
    await expect(decide(out.approvalId, 'u-admin-2')).resolves.toBeDefined();
  });

  it('refuses the raw API-key owner even when its issuer differs from the acting requester', async () => {
    const { key } = await issueApiKey({ tenantId: T, name: 'owning admin', createdBy: 'u-admin-2' });
    const subject = `apikey:${key.keyId}`;
    const principal = opaquePrincipal(subject);
    const run = await campaignRun({ owner: { principal, subject: { issuer: 'urn:openwop-app:api-key', subjectId: principal, lane: 'api-key', kind: 'workload' } } });
    const out = await ads(run.runId).updateBudget(budget(36_103));
    if (out.outcome !== 'requires_approval') throw new Error('expected approval');
    await expect(decide(out.approvalId, subject)).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
  });

  it('refuses a second requesting run\'s admin when two runs share the same pending spend', async () => {
    const first = await campaignRun();
    const out = await ads(first.runId).updateBudget(budget(36_105));
    if (out.outcome !== 'requires_approval') throw new Error('expected approval');
    const second = await campaignRun({ actingUserId: 'u-admin-2' });
    expect(await ads(second.runId).updateBudget(budget(36_105))).toMatchObject({ outcome: 'requires_approval', approvalId: out.approvalId });
    await expect(decide(out.approvalId, 'u-admin-2')).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
    await expect(decide(out.approvalId, 'u-owner')).resolves.toBeDefined();
  });
  it('a budget move asks under Guarded; the approval names the client\'s roles; above the grant re-asks', async () => {
    const run = await campaignRun();
    hits = 0;
    const first = await ads(run.runId).updateBudget(budget(30_000));
    expect(first).toMatchObject({ outcome: 'requires_approval', autonomy: true });
    if (first.outcome !== 'requires_approval') throw new Error('expected an approval');
    expect(hits).toBe(0);
    const row = await getApproval(first.approvalId);
    expect(row).toMatchObject({ kind: 'campaign-spend', orgId, submitters: ['u1'], policy: { approverRoleRefs: ['owner', 'admin'], requiredApprovals: 1 } });
    // D10.2 — the requester may not decide; a non-approver role may not either.
    await expect(decide(first.approvalId, 'u1')).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
    await expect(decide(first.approvalId, 'u-editor')).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_not_eligible' } });
    await decide(first.approvalId, 'u-admin-2');
    // The same move now applies; a larger move is a new ask.
    expect((await ads(run.runId).updateBudget(budget(30_000))).outcome).toBe('updated');
    const bigger = await ads(run.runId).updateBudget(budget(45_000));
    expect(bigger).toMatchObject({ outcome: 'requires_approval', autonomy: true });
    if (bigger.outcome === 'requires_approval') expect(bigger.approvalId).not.toBe(first.approvalId);
  });

  it('a branch fork does not reuse its source\'s spend approval (D10.4)', async () => {
    const src = await campaignRun();
    const r = await ads(src.runId).updateBudget(budget(31_000));
    if (r.outcome !== 'requires_approval') throw new Error('expected an approval');
    await decide(r.approvalId, 'u-admin-2');
    expect((await ads(src.runId).updateBudget(budget(31_000))).outcome).toBe('updated');
    const fork = await campaignRun({ campaignAutonomy: src.metadata?.campaignAutonomy, [FORK_POSTURE_KEY]: 'attended', approverOrgId: orgId }, { forkMode: 'branch', parentRunId: src.runId });
    const forked = await ads(fork.runId).updateBudget(budget(31_000));
    expect(forked).toMatchObject({ outcome: 'requires_approval', autonomy: true });
  });

  it('does not reuse a different frozen policy\'s one-person approval for a new two-person requirement', async () => {
    const first = await campaignRun();
    const out = await ads(first.runId).updateBudget(budget(36_104));
    if (out.outcome !== 'requires_approval') throw new Error('expected approval');
    await decide(out.approvalId, 'u-admin-2');
    await setCampaignPolicy(presetRules('guarded@1').map(r => r.actionClass === 'ads.budget'
      ? { actionClass: 'ads.budget', default: { outcome: 'approve', approver: { roleRefs: ['admin'], requiredApprovals: 2, delegation: 'allowed' } } } : r));
    try {
      const second = await campaignRun();
      const next = await ads(second.runId).updateBudget(budget(36_104));
      expect(next).toMatchObject({ outcome: 'requires_approval', autonomy: true });
      if (next.outcome !== 'requires_approval') throw new Error('expected distinct approval');
      expect(next.approvalId).not.toBe(out.approvalId);
      expect((await getApproval(next.approvalId))?.policy?.requiredApprovals).toBe(2);
    } finally { await setCampaignPolicy('guarded@1'); }
  });

  it('a policy-blocked class fails typed, and the decision is audited', async () => {
    await setCampaignPolicy(presetRules('guarded@1').map((x) => (x.actionClass === 'ads.budget' ? { actionClass: 'ads.budget', default: { outcome: 'blocked', reason: 'No budget moves this quarter' } } : x)));
    const run = await campaignRun();
    hits = 0;
    expect(await ads(run.runId).updateBudget(budget(1_000))).toEqual({ outcome: 'failed', error: 'autonomy_blocked' });
    expect(hits).toBe(0);
    expect((await autonomyAudits()).at(-1)).toMatchObject({ actionClass: 'ads.budget', outcome: 'blocked', runId: run.runId, campaignId: campaign.id });
    await setCampaignPolicy('guarded@1');
  });

  it('a preview client is blocked at the chokepoint (the client floor)', async () => {
    await updateClient(T, orgId, { mode: 'preview' });
    try {
      const run = await campaignRun();
      expect(await ads(run.runId).updateBudget(budget(1_000))).toEqual({ outcome: 'failed', error: 'autonomy_blocked' });
      expect((await autonomyAudits()).at(-1)).toMatchObject({ outcome: 'blocked', layer: 'floor' });
    } finally {
      await updateClient(T, orgId, { mode: 'live' });
    }
  });

  it('a non-campaign run keeps today\'s gate: no threshold, no ask', async () => {
    const now = new Date().toISOString();
    await storage.insertRun({ runId: 'r-p3-plain', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
    const plain = await ads('r-p3-plain').updateBudget(budget(50_000));
    expect(plain, JSON.stringify(plain)).toMatchObject({ outcome: 'updated' });
  });

  it('a spend row without policy approvers keeps today\'s decide rules (any approver, even the proposer)', async () => {
    const row = await createCampaignSpendApproval({ tenantId: T, spendKind: 'budget', platform: 'google', adAccountId: 'a', dailyBudgetMinor: 1, spendIdemKey: `legacy-${n++}`, proposal: 'legacy' });
    await expect(decide(row.approvalId, 'u-editor')).resolves.toBeDefined();
  });
});

describe('ADR 0942 P3 — a campaign run WAITS on its spend approval and resumes', () => {
  it('recovers an approval decided before the executor could persist the wait', async () => {
    const def = {
      workflowId: 'wf.p3.early-decision', name: 'early decision', version: '1.0.0',
      nodes: [{ nodeId: 'budget', typeId: 'core.openwop.connectors.ad-budget-update', config: { platform: 'google', adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: 36_201, dryRun: false } }], edges: [],
    } as unknown as WorkflowDefinition;
    registerHostWorkflow(def);
    const run = await campaignRun({}, { workflowId: def.workflowId });
    const original = storage.insertInterrupt.bind(storage);
    let approvalId = '';
    const intercept = vi.spyOn(storage, 'insertInterrupt').mockImplementation(async (interrupt) => {
      const data = interrupt.data as { approvalId?: string } | undefined;
      if (interrupt.runId === run.runId && data?.approvalId) {
        approvalId = data.approvalId;
        await decide(approvalId, 'u-admin-2');
      }
      return original(interrupt);
    });
    try { expect((await executeRun(storage, run, def)).status).toBe('waiting-external'); }
    finally { intercept.mockRestore(); }
    expect((await getApproval(approvalId))?.status).toBe('approved');
    hits = 0;
    expect(await reconcileApprovalWaits(storage, hostSuite)).toBeGreaterThanOrEqual(1);
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))?.status).toBe('completed');
    expect(hits).toBeGreaterThan(0);
    expect(await reconcileApprovalWaits(storage, hostSuite)).toBe(0);
  });
  it('the budget node suspends, the decision resumes it, and the move applies', async () => {
    const def = {
      workflowId: 'wf.p3.budget', name: 'wf.p3.budget', version: '1.0.0',
      nodes: [{ nodeId: 'budget', typeId: 'core.openwop.connectors.ad-budget-update', config: { platform: 'google', adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: 33_000, dryRun: false } }],
      edges: [],
    } as unknown as WorkflowDefinition;
    registerHostWorkflow(def);
    const run = await campaignRun({}, { workflowId: 'wf.p3.budget' });
    const status = (await executeRun(storage, run, def)).status;
    const failedRow = await storage.getRun(run.runId);
    expect(status, JSON.stringify(failedRow?.error ?? null)).toBe('waiting-external');
    const [open] = await storage.listOpenInterrupts(run.runId);
    const approvalId = (open?.data as { approvalId?: string } | undefined)?.approvalId;
    if (!approvalId) throw new Error('expected the node to wait on an approval');
    hits = 0;
    await decide(approvalId, 'u-admin-2');
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))?.status).toBe('completed');
    expect(hits).toBeGreaterThan(0);
  });

  it('a rejection resumes the run and fails the step', async () => {
    const def = {
      workflowId: 'wf.p3.budget2', name: 'wf.p3.budget2', version: '1.0.0',
      nodes: [{ nodeId: 'budget', typeId: 'core.openwop.connectors.ad-budget-update', config: { platform: 'google', adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: 34_000, dryRun: false } }],
      edges: [],
    } as unknown as WorkflowDefinition;
    registerHostWorkflow(def);
    const run = await campaignRun({}, { workflowId: 'wf.p3.budget2' });
    await executeRun(storage, run, def);
    const [open] = await storage.listOpenInterrupts(run.runId);
    const approvalId = (open?.data as { approvalId?: string } | undefined)?.approvalId;
    if (!approvalId) throw new Error('expected the node to wait on an approval');
    await rejectApproval(deps, { tenantId: T, decidedBy: 'u-admin-2' }, approvalId);
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))?.status).toBe('failed');
  });
});

describe('ADR 0942 P3 — sms.send (interrupt lane): audit and the covering grant', () => {
  const sms = (runId: string, text = 'Your spring launch is live') => makeSmsAdapter({ storage, tenantId: T, runId, actingUserId: 'u1', orgId: T }).sendSms({ to: '+15550000001', from: '+15550000002', text });

  it('an auto send is audited (and then reaches the provider step)', async () => {
    await setCampaignPolicy(presetRules('guarded@1').map((x) => (x.actionClass === 'sms.send' ? { actionClass: 'sms.send', default: { outcome: 'auto' } } : x)));
    const run = await campaignRun();
    const out = await sms(run.runId);
    expect(out.error).toBe('sms_not_connected'); // past the gate: no Twilio connection in this test
    expect((await autonomyAudits()).at(-1)).toMatchObject({ actionClass: 'sms.send', outcome: 'auto', runId: run.runId, lane: 'interrupt' });
    await setCampaignPolicy('guarded@1');
  });

  it('approve without a covering grant is refused; an approved gate for the same content covers it', async () => {
    const run = await campaignRun();
    expect((await sms(run.runId)).error).toBe('autonomy_approval_required');
    // An approved autonomy gate for sms.send in THIS run, on the same content.
    const { contentHashOf } = await import('../src/host/autonomyPolicy/index.js');
    const interruptId = `int-p3-${n++}`;
    const now = new Date().toISOString();
    await storage.insertInterrupt({
      interruptId, runId: run.runId, nodeId: 'sms-gate', kind: 'approval', token: `tok-${interruptId}`, createdAt: now,
      data: { autonomy: { actionClass: 'sms.send', facts: { audienceSize: 1 }, contentHash: contentHashOf('Your spring launch is live') } },
    });
    await storage.resolveInterrupt(interruptId, { action: 'approve' }, now);
    const { getEventLog } = await import('../src/executor/eventLog.js');
    await getEventLog().append({ runId: run.runId, type: 'interrupt.resolved', payload: { interruptId, kind: 'approval', decision: 'accepted', action: 'accept' } });
    expect((await sms(run.runId)).error).toBe('sms_not_connected');
    // Different content is not covered.
    expect((await sms(run.runId, 'A different message')).error).toBe('autonomy_approval_required');
  });

  it('an approval with no content identity cannot authorize an SMS with real content', async () => {
    const run = await campaignRun();
    const interruptId = `int-unbound-${n++}`;
    const now = new Date().toISOString();
    await storage.insertInterrupt({
      interruptId, runId: run.runId, nodeId: 'unbound-sms-gate', kind: 'approval', token: `tok-${interruptId}`, createdAt: now,
      data: { autonomy: { actionClass: 'sms.send', facts: { audienceSize: 1 } } },
    });
    await storage.resolveInterrupt(interruptId, { action: 'approve' }, now);
    const { getEventLog } = await import('../src/executor/eventLog.js');
    await getEventLog().append({ runId: run.runId, type: 'interrupt.resolved', payload: { interruptId, kind: 'approval', decision: 'accepted', action: 'accept' } });
    expect((await sms(run.runId)).error).toBe('autonomy_approval_required');
  });
});

describe('ADR 0942 P3 — publish-ad-variants waits on a policy-asked spend approval', () => {
  const draft = { platformSets: [{ platform: 'meta', variants: [{ headline: 'Paint boldly' }] }] };
  it('suspends OUTSIDE its catch-all, so the executor sees the suspend (not a failure)', async () => {
    const signal = new Error('suspend-signal');
    let suspended: Record<string, unknown> | null = null;
    const run = channelNodes['feature.campaign-channels.nodes.publish-ad-variants']({
      inputs: { platform: 'meta', adAccountId: 'act_1', briefId: 'b1', draft },
      ads: { publishAd: async () => ({ outcome: 'requires_approval', approvalId: 'appr:x', autonomy: true }) },
      suspend: async (p: Record<string, unknown>) => { suspended = p; throw signal; },
    });
    await expect(run).rejects.toBe(signal);
    expect(suspended).toMatchObject({ kind: 'external-event', key: 'approval:appr:x' });
  });
  it('a non-campaign approval keeps today\'s "approve, then re-run" failure', async () => {
    const out = await channelNodes['feature.campaign-channels.nodes.publish-ad-variants']({
      inputs: { platform: 'meta', adAccountId: 'act_1', briefId: 'b1', draft },
      ads: { publishAd: async () => ({ outcome: 'requires_approval', approvalId: 'appr:y' }) },
      suspend: async () => { throw new Error('must not suspend'); },
    });
    expect(out).toMatchObject({ status: 'failed', error: { code: 'spend_approval_pending' } });
  });
});

describe('ADR 0942 × ADR 0952 P7 — a catalog push is ads.publish, on the PendingApproval lane', () => {
  // Listings can show publicly and feed shopping ads, so the push is a publish
  // (team-lead decision, 2026-10-25 integration). ads.publish is a PendingApproval-
  // lane class: the ads spend gate opens a campaign-spend approval (kind publish,
  // budget 0) keyed on exactly what is sent; an in-run gate node cannot open it.
  // (Replaces 0dd29c59f's interrupt-lane test, which hand-inserted an interrupt
  // the system never creates for this class.)
  const item = { id: 'sku-1', title: 'Mug', description: 'A mug', link: 'https://x.test/store/o', image_link: 'https://x.test/a.png', availability: 'in_stock' as const, price: '12.00 USD', condition: 'new' as const, brand: 'Client A' };
  const target = { metaCatalogId: '777', contentLanguage: 'en', feedLabel: 'US' };
  const adapterDeps = (runId: string) => ({ storage, tenantId: T, runId, actingUserId: 'u1', orgId: T });
  const push = (runId: string, items = [item]) => pushCatalogItems(adapterDeps(runId), 'meta', target, items, []);
  const autoPublish = (): ActionRule[] => presetRules('guarded@1').map((x) => (x.actionClass === 'ads.publish' ? { actionClass: 'ads.publish', default: { outcome: 'auto' } } : x));

  beforeAll(async () => {
    process.env.OPENWOP_ADS_VERIFIED_CATALOG_PUSH = 'meta';
    process.env.OPENWOP_META_API_BASE = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/meta`;
    registerProvider({ id: 'meta-ads', label: 'meta-ads', kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
    await createSecretConnection({ tenantId: T, provider: 'meta-ads', kind: 'bearer', secret: 'TOK', scope: 'user', userId: 'u1' });
    await setToggle('campaign-connectors', true);
    await setToggle('commerce', true); // the feed serves only while the store does (INTWF-1)
  });
  afterAll(() => { delete process.env.OPENWOP_ADS_VERIFIED_CATALOG_PUSH; delete process.env.OPENWOP_META_API_BASE; delete process.env.OPENWOP_PUBLIC_BASE_URL; });

  it('Guarded: opens ONE publish approval for this content with no vendor call; approved ⇒ the same content pushes; other content asks again', async () => {
    await setCampaignPolicy('guarded@1');
    const run = await campaignRun();
    const before = hits;
    const first = await push(run.runId);
    if (first.outcome !== 'requires_approval') throw new Error(`expected an approval, got ${JSON.stringify(first)}`);
    expect(first.autonomy).toBe(true);
    expect(hits).toBe(before);
    expect(await getApproval(first.approvalId)).toMatchObject({ kind: 'campaign-spend', spendKind: 'publish', platform: 'meta', dailyBudgetMinor: 0, status: 'pending' });
    // A retry before the decision is the SAME approval, never a second one.
    expect(await push(run.runId)).toMatchObject({ outcome: 'requires_approval', approvalId: first.approvalId });
    await decide(first.approvalId, 'u-admin-2');
    expect((await push(run.runId)).outcome).toBe('pushed');
    expect(hits).toBeGreaterThan(before);
    const after = hits;
    const other = await push(run.runId, [{ ...item, price: '99.00 USD' }]);
    expect(other.outcome).toBe('requires_approval');
    expect(other.outcome === 'requires_approval' && other.approvalId).not.toBe(first.approvalId);
    expect(hits).toBe(after);
  });

  it('Auto: the push goes out without stopping (and is audited as an auto decision)', async () => {
    await setCampaignPolicy(autoPublish());
    try {
      const run = await campaignRun();
      const before = hits;
      expect((await push(run.runId, [{ ...item, id: 'sku-auto' }])).outcome).toBe('pushed');
      expect(hits).toBeGreaterThan(before);
      expect((await autonomyAudits()).at(-1)).toMatchObject({ actionClass: 'ads.publish', outcome: 'auto', runId: run.runId });
    } finally { await setCampaignPolicy('guarded@1'); }
  });

  it('the push node waits on the approval under a campaign policy, and keeps "approve, then re-run" outside one', async () => {
    const signal = new Error('suspend-signal');
    let suspended: Record<string, unknown> | null = null;
    const node = connectorNodes['feature.campaign-connectors.nodes.push-catalog-feed'];
    await expect(node({
      inputs: { orgId: 'o', platform: 'meta' },
      features: { 'campaign-connectors': { importCsv: async () => ({}), pushCatalog: async () => ({ outcome: 'requires_approval', approvalId: 'appr:c', autonomy: true }) } },
      suspend: async (p: Record<string, unknown>) => { suspended = p; throw signal; },
    })).rejects.toBe(signal);
    expect(suspended).toMatchObject({ kind: 'external-event', key: 'approval:appr:c', approvalId: 'appr:c' });
    expect(await node({
      inputs: { orgId: 'o', platform: 'meta' },
      features: { 'campaign-connectors': { importCsv: async () => ({}), pushCatalog: async () => ({ outcome: 'requires_approval', approvalId: 'appr:d' }) } },
      suspend: async () => { throw new Error('must not suspend'); },
    })).toMatchObject({ status: 'failed', error: { code: 'publish_approval_pending' } });
  });

  it('chain level (real loader + executor): Guarded ⇒ the run waits and pushes nothing; the approval resumes it and the catalog is published once', async () => {
    await setCampaignPolicy('guarded@1');
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://shop.example';
    await saveFeedSettings(T, orgId, { enabled: true, metaCatalogId: '778' });
    await createProduct({ tenantId: T, orgId, createdBy: 'u-owner', type: 'digital', name: 'Guide', price: 9, currency: 'USD', imageAssetTokens: ['img-g'] });
    const found = getChain('campaign-sync.catalog-feed');
    if (!found) throw new Error('campaign-sync.catalog-feed must load at boot');
    const params = { orgId, platform: 'meta' };
    const def = expandChain(found.chain, { params });
    registerHostWorkflow(def);
    const run = await campaignRun({}, { workflowId: def.workflowId, inputs: params });
    const before = hits;
    const status = (await executeRun(storage, run, def)).status;
    expect(status, JSON.stringify((await storage.getRun(run.runId))?.error ?? null)).toBe('waiting-external');
    expect(hits).toBe(before);
    const [open] = await storage.listOpenInterrupts(run.runId);
    const approvalId = (open?.data as { approvalId?: string } | undefined)?.approvalId;
    if (!approvalId) throw new Error('expected the push to wait on an approval');
    expect(await getApproval(approvalId)).toMatchObject({ spendKind: 'publish', dailyBudgetMinor: 0 });
    await decide(approvalId, 'u-admin-2');
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))?.status).toBe('completed');
    expect(hits).toBe(before + 1); // ONE items_batch

    // No second push of the same content: a replay fork never re-executes the node
    // (it is fast-path served the recorded outcome), and a fresh push of the same
    // feed has nothing changed to send, so it makes no vendor call.
    expect(MANIFEST_FAST_PATH_SERVED.has('feature.campaign-connectors.nodes.push-catalog-feed')).toBe(true);
    const again = await pushCatalog(adapterDeps(run.runId), T, orgId, 'meta', 'https://shop.example');
    expect(again).toMatchObject({ outcome: 'pushed', sent: 0, removed: 0 });
    expect(hits).toBe(before + 1);
  });
});
