/**
 * ADR 0942 P4 — SLA ladders on both approval lanes, delegation off, and the
 * notify-after notices (immediate + the daily digest chain), through the real
 * sweep, the real gate node, the real ads adapter against a fake platform and the
 * real notification store.
 *
 * Exit criteria (phase row P4): remind and escalate fire ONCE each across
 * instances (concurrent sweeps); expiry rejects.
 *
 * Sabotage notes (each run, 2026-10-20):
 *  - drop the CAS in `fireOnce` (fire unconditionally) → red (two concurrent sweeps remind twice);
 *  - expire a per-row SLA row WITHOUT the waiter resume → red (the waiting run never resumes);
 *  - ignore `allowDelegation` in `resolveEligibleApprovers` → red (the delegate votes on a delegation-off gate);
 *  - emit the notify-after notice BEFORE the platform write → red (a failed write still notifies);
 *  - make `deliverAutonomyDigest` keep a delivered day's items → red (a second delivery repeats the digest).
 * Re-probed 2026-11-04 (w84g1-*): the per-row expiry status, the escalateTo branch,
 * the delegation-off join in `resolveEligibleApprovers` and the notify-after
 * placement each red their case.
 *
 * Double guard (recorded): on the interrupt lane's first pass two concurrent sweeps
 * are held by `interruptSla.putIfAbsent` AND by `fireOnce`'s CAS (approvalSla.ts),
 * so a CAS-only edit cannot red "a gate reminds once"; it is witnessed as a held
 * pair (w84g1-held-sla-gate-cas). The per-row lane has only the CAS.
 *
 * One world for every case: u-admin-2's active delegation to u-delegate is created
 * in `beforeAll` (it used to be created inside the delegation case, which made the
 * file pass only in source order). Recipients are therefore asserted exactly, never
 * as a count that could hold for another reason: on the gate lane and the
 * notify-after notices, the admin plus their delegate (ADR 0198 fan-out); on the
 * per-row spend ladder, ONE admin-role operator notice, because `campaign-spend`
 * is a tenant-scoped kind (approvalAudience.ts).
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
import { createDelegation } from '../src/host/approvalDelegations.js';
import { __putDispatchRecordForTests, makeAdsAdapter } from '../src/host/adsAdapter.js';
import { getApproval } from '../src/host/approvalService.js';
import { sweepApprovalSla } from '../src/host/approvalSla.js';
import { sweepExpiredApprovalGates } from '../src/executor/approvalGateTimeout.js';
import { getJob } from '../src/host/schedulingService.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { __awaitRunResumeChainForTests, resolveAndResume } from '../src/routes/interrupts.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import {
  AUTONOMY_DIGEST_TYPE, AUTONOMY_NOTICE_TYPE, AUTONOMY_TOGGLE, DIGEST_CHAIN_ID, applyPolicyChange, bindClientPresetIfAbsent,
  deliverAutonomyDigest, digestJobId, getBinding, presetRules, savePolicy, type ActionRule, type ApproverSpec, type Decision,
} from '../src/host/autonomyPolicy/index.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { NotificationRecord, RunRecord } from '../src/types.js';
import { nodes as orchestrationNodes } from '../../../packs/feature.campaign-orchestration.nodes/index.mjs';
import { emitAutonomyNotice } from '../src/host/autonomyPolicy/index.js';

const T = 'adr0942-p4';
const GATE = 'feature.campaign-orchestration.nodes.autonomy-gate';
const MIN = 60_000;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let platform: http.Server;
let platformFails = false;
let orgId: string;
let campaign: MarketingCampaign;
let n = 0;

async function setToggle(id: string): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: 'on' }, 'test');
}

const approver = (extra: Partial<ApproverSpec> = {}): ApproverSpec => ({ roleRefs: ['admin'], requiredApprovals: 1, delegation: 'allowed', ...extra });
async function setRule(actionClass: ActionRule['actionClass'], decision: Decision): Promise<void> {
  const rules = presetRules('guarded@1').map((r) => (r.actionClass === actionClass ? { actionClass, default: decision } : r));
  await savePolicy({ tenantId: T, orgId, campaignId: campaign.id, actor: 'u-owner', expected: await getBinding(T, orgId, campaign.id), input: { kind: 'custom', name: 'p4', basePreset: 'guarded@1', rules } });
}

async function campaignRun(workflowId = 'wf.p4'): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `r-p4-${n++}-${Math.random().toString(36).slice(2, 8)}`, workflowId, tenantId: T, status: 'pending', inputs: {},
    metadata: { campaignOrchestration: stampCampaignRun(campaign, { role: 'optimizer' }), actingUserId: 'u1' }, configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run, { admission: { plan: 'exempt:test-fixture' } });
  return (await storage.getRun(run.runId)) ?? run;
}

const notices = async (type: string): Promise<NotificationRecord[]> =>
  (await storage.listNotifications({ tenantId: T, includeArchived: true })).filter((r) => r.type === type);
/** The rows of `type` written since `before` (by id: the list is newest-first, so never slice by count). */
const freshSince = async (type: string, before: readonly NotificationRecord[]): Promise<NotificationRecord[]> => {
  const seen = new Set(before.map((r) => r.notificationId));
  return (await notices(type)).filter((r) => !seen.has(r.notificationId));
};
const recipients = (rows: readonly NotificationRecord[]): string[] => rows.map((r) => r.recipientUserId ?? '(none)').sort();
const ads = (runId: string) => makeAdsAdapter({ storage, tenantId: T, runId, actingUserId: 'u1', orgId: T });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await __resetConnectionsStore();
  platform = http.createServer((req, res) => {
    req.resume();
    if (platformFails) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ customer: { currencyCode: 'USD' }, resourceName: 'customers/1/campaignBudgets/1', campaign: { campaignBudget: 'customers/1/campaignBudgets/1' } }] }));
  });
  await new Promise<void>((r) => platform.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_GOOGLE_ADS_API_BASE = `http://127.0.0.1:${(platform.address() as AddressInfo).port}/google`;
  registerProvider({ id: 'google-ads', label: 'google-ads', kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
  await createSecretConnection({ tenantId: T, provider: 'google-ads', kind: 'bearer', secret: 'TOK', scope: 'workspace' });
  for (const id of ['campaign-orchestration', 'campaign-channels', AUTONOMY_TOGGLE]) await setToggle(id);
  getNodeRegistry().register({
    typeId: GATE, version: '1.0.0',
    execute: async (ctx) => {
      const r = await orchestrationNodes[GATE](ctx);
      if (r.status === 'success') return { status: 'success', outputs: r.outputs };
      return { status: 'failure', error: { code: r.error?.code ?? 'pack_node_error', message: r.error?.message ?? '' } };
    },
  });
  orgId = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client P4', ownerSubject: 'u-owner' })).orgId;
  for (const [subject, role] of [['u1', 'editor'], ['u-admin-2', 'admin'], ['u-delegate', 'editor']] as const) {
    await createMember({ tenantId: T, orgId, subject, displayName: subject, roles: [role] });
  }
  // ADR 0198 — u-admin-2 (the only admin approver) has an active delegate for the whole file,
  // including the digest-chain case's item emitted under a clock set back one day.
  const now = Date.now();
  await createDelegation({ tenantId: T, fromSubject: 'u-admin-2', toSubject: 'u-delegate', startsAt: new Date(now - 48 * 60 * MIN).toISOString(), endsAt: new Date(now + 48 * 60 * MIN).toISOString(), createdBy: 'u-admin-2' });
  await bindClientPresetIfAbsent(T, orgId, 'guarded@1', 'u-owner');
  const brief = await createBrief(T, orgId, 'u-owner', { name: 'SLA launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  campaign = (await ensureDraftCampaign(T, brief, 'u-owner')).campaign;
  // The budget node refuses a campaign its run's org does not own: seed the
  // dispatch row the launch of platform campaign 9 would have written.
  await __putDispatchRecordForTests({ tenantId: T, platform: 'google', platformCampaignId: '9', platformAdSetId: 'as-9', platformAdId: 'ad-9', adAccountId: '1234567890', createdAt: new Date().toISOString(), campaignId: campaign.id, orgId });
});
afterAll(async () => {
  delete process.env.OPENWOP_GOOGLE_ADS_API_BASE;
  delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
  await new Promise<void>((r) => platform.close(() => r()));
});

describe('ADR 0942 D7 — a per-row SLA ladder on a spend row', () => {
  it('remind and escalate fire once each under concurrent sweeps; expiry rejects and resumes the waiting run', async () => {
    await setRule('ads.budget', { outcome: 'approve', approver: approver({ sla: { remindAfterMs: MIN, escalateAfterMs: 2 * MIN, expireAfterMs: 3 * MIN }, escalateTo: { roleRefs: ['owner'] } }) });
    const def: WorkflowDefinition = {
      workflowId: 'wf.p4.budget',
      nodes: [{ nodeId: 'budget', typeId: 'core.openwop.connectors.ad-budget-update', config: { platform: 'google', adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: 52_000, dryRun: false } }],
      edges: [],
    };
    registerHostWorkflow(def);
    const run = await campaignRun('wf.p4.budget');
    expect((await executeRun(storage, run, def)).status).toBe('waiting-external');
    const [open] = await storage.listOpenInterrupts(run.runId);
    const approvalId = (open?.data as { approvalId?: string } | undefined)?.approvalId;
    if (!approvalId) throw new Error('expected a spend wait');
    const row = await getApproval(approvalId);
    expect(row?.policy).toMatchObject({ sla: { remindAfterMs: MIN }, escalateTo: { roleRefs: ['owner'] } });
    const created = Date.parse(row?.createdAt ?? '');
    const at = (ms: number) => new Date(created + ms);

    const before = await notices('approval.sla-reminder');
    await Promise.all([sweepApprovalSla(at(MIN + 1_000)), sweepApprovalSla(at(MIN + 1_000))]);
    // A `campaign-spend` row is a tenant-scoped kind (approvalAudience.ts: `'campaign-spend': null`),
    // so its reminder is ONE operator notice to the admin role, never a per-user fan-out. Reminded
    // ONCE: a double fire makes two rows.
    const reminders = await freshSince('approval.sla-reminder', before);
    expect(reminders.map((r) => ({ recipientUserId: r.recipientUserId, recipientRole: r.recipientRole }))).toEqual([{ recipientUserId: undefined, recipientRole: 'admin' }]);
    await Promise.all([sweepApprovalSla(at(2 * MIN + 1_000)), sweepApprovalSla(at(2 * MIN + 1_000))]);
    const escalated = (await notices('approval.sla-escalated')).filter((r) => r.recipientUserId === 'u-owner');
    expect(escalated).toHaveLength(1);
    await sweepApprovalSla(at(3 * MIN + 1_000));
    expect((await getApproval(approvalId))?.status).toBe('rejected');
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getRun(run.runId))?.status).toBe('failed');
  });
});

describe('ADR 0942 D7 — the interrupt lane', () => {
  const gateDef = (id: string): WorkflowDefinition => ({
    workflowId: id,
    nodes: [{ nodeId: 'gate', typeId: GATE, config: { actionClass: 'plan.approve', prompt: 'Approve the plan?' } }, { nodeId: 'after', typeId: 'core.noop', config: {} }],
    edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'after', triggerRule: 'all_success' }],
  });

  it('a gate reminds once under concurrent sweeps, and expires as a rejection', async () => {
    await setRule('plan.approve', { outcome: 'approve', approver: approver({ sla: { remindAfterMs: MIN, expireAfterMs: 2 * MIN } }) });
    registerHostWorkflow(gateDef('wf.p4.gate'));
    const run = await campaignRun('wf.p4.gate');
    expect((await executeRun(storage, run, gateDef('wf.p4.gate'))).status).toBe('waiting-approval');
    const [open] = await storage.listOpenInterrupts(run.runId);
    if (!open) throw new Error('expected a gate');
    expect(open.data).toMatchObject({ timeoutMs: 2 * MIN, autonomy: { sla: { remindAfterMs: MIN } } });
    const created = Date.parse(open.createdAt);
    const before = await notices('approval.sla-reminder');
    await Promise.all([sweepApprovalSla(new Date(created + MIN + 1_000)), sweepApprovalSla(new Date(created + MIN + 1_000))]);
    expect(recipients(await freshSince('approval.sla-reminder', before))).toEqual(['u-admin-2', 'u-delegate']);
    // Expiry: the existing gate-timeout sweep rejects it (RFC 0093: expiry is a rejection).
    await sweepExpiredApprovalGates(storage, created + 2 * MIN + 1_000);
    await __awaitRunResumeChainForTests(run.runId);
    expect((await storage.getInterrupt(open.interruptId))?.resolvedValue).toMatchObject({ action: 'reject', reason: 'timeout' });
    expect((await storage.getRun(run.runId))?.status).toBe('failed');
  });

  it('delegation:"none" — an active delegate of the approver may not vote; with delegation allowed they may', async () => {
    // The delegation u-admin-2 → u-delegate is active (beforeAll).
    await setRule('plan.approve', { outcome: 'approve', approver: approver({ delegation: 'none' }) });
    registerHostWorkflow(gateDef('wf.p4.gate2'));
    const run = await campaignRun('wf.p4.gate2');
    await executeRun(storage, run, gateDef('wf.p4.gate2'));
    const [open] = await storage.listOpenInterrupts(run.runId);
    if (!open) throw new Error('expected a gate');
    expect(open.data).toMatchObject({ allowDelegation: false });
    const refused = await resolveAndResume(storage, hostSuite, open.interruptId, { action: 'approve' }, { subjectRef: 'u-delegate' }).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ httpStatus: 403, code: 'forbidden', message: 'You are not an eligible approver for this gate.' });
    // The gate is still open: the refusal recorded nothing.
    expect((await storage.getInterrupt(open.interruptId))?.resolvedAt).toBeFalsy();

    await setRule('plan.approve', { outcome: 'approve', approver: approver() });
    registerHostWorkflow(gateDef('wf.p4.gate3'));
    const run2 = await campaignRun('wf.p4.gate3');
    await executeRun(storage, run2, gateDef('wf.p4.gate3'));
    const [open2] = await storage.listOpenInterrupts(run2.runId);
    if (!open2) throw new Error('expected a gate');
    await resolveAndResume(storage, hostSuite, open2.interruptId, { action: 'approve' }, { subjectRef: 'u-delegate' });
    await __awaitRunResumeChainForTests(run2.runId);
    expect((await storage.getRun(run2.runId))?.status).toBe('completed');
  });
});

describe('ADR 0942 D7 — notify-after', () => {
  const notify = (digest: 'immediate' | 'daily'): Decision => ({ outcome: 'notify-after', notify: { roleRefs: ['admin'], channels: ['inbox'], digest } });

  it('an immediate notice goes to the named role AFTER the change lands, never on a failed write', async () => {
    await setRule('ads.budget', notify('immediate'));
    const run = await campaignRun();
    const before = await notices(AUTONOMY_NOTICE_TYPE);
    platformFails = true;
    try {
      expect((await ads(run.runId).updateBudget({ platform: 'google', adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: 1_200 })).outcome).toBe('failed');
    } finally { platformFails = false; }
    expect(await freshSince(AUTONOMY_NOTICE_TYPE, before)).toEqual([]);
    expect((await ads(run.runId).updateBudget({ platform: 'google', adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: 1_300 })).outcome).toBe('updated');
    // The admin role on the client org, plus that admin's active delegate (ADR 0198: notification fan-out
    // inherits delegates; the delegation is set up in beforeAll); never the editor who caused it, never a broadcast.
    expect(recipients(await freshSince(AUTONOMY_NOTICE_TYPE, before))).toEqual(['u-admin-2', 'u-delegate']);
  });

  it('a daily digest batches the day into one notice per person, once, and the save schedules the digest chain', async () => {
    const expected = await getBinding(T, orgId, campaign.id);
    const rules = presetRules('guarded@1').map((r) => (r.actionClass === 'ads.budget' ? { actionClass: 'ads.budget' as const, default: notify('daily') } : r));
    await applyPolicyChange({ tenantId: T, orgId, campaignId: campaign.id, input: { kind: 'custom', name: 'digest', basePreset: 'guarded@1', rules }, actor: 'u-owner', ...(expected ? { ifMatch: `${expected.policyId}@${expected.version}` } : { ifMatch: 'none' }), authorize: async () => undefined });
    expect(await getJob(digestJobId(T))).toMatchObject({ tenantId: T, workflowId: DIGEST_CHAIN_ID, enabled: true });
    expect(getChainBackedWorkflow(DIGEST_CHAIN_ID)).toBeTruthy();
    const run = await campaignRun();
    for (const amount of [1_400, 1_500]) expect((await ads(run.runId).updateBudget({ platform: 'google', adAccountId: '1234567890', campaignId: '9', dailyBudgetMinor: amount })).outcome).toBe('updated');
    const tomorrow = new Date(Date.now() + 24 * 60 * MIN);
    expect(await deliverAutonomyDigest(T, tomorrow)).toEqual({ recipients: 2, items: 4 });
    expect(await deliverAutonomyDigest(T, tomorrow)).toEqual({ recipients: 0, items: 0 });
    const digests = await notices(AUTONOMY_DIGEST_TYPE);
    expect(recipients(digests.filter((r) => r.message.includes('Daily budget set to 1400')))).toEqual(['u-admin-2', 'u-delegate']);
  });
});

describe('ADR 0942 D7 — the digest chain runs as the scheduler runs it (actorless, chain-backed)', () => {
  it('the chain-backed digest workflow delivers queued notices from an actorless run', async () => {
    getNodeRegistry().register({
      typeId: 'feature.campaign-orchestration.nodes.autonomy-digest', version: '1.0.0',
      execute: async (ctx) => {
        const r = await orchestrationNodes['feature.campaign-orchestration.nodes.autonomy-digest'](ctx);
        if (r.status === 'success') return { status: 'success', outputs: r.outputs };
        return { status: 'failure', error: { code: 'pack_node_error', message: 'digest failed' } };
      },
    });
    // Queue an item dated YESTERDAY so today's run delivers it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 24 * 60 * MIN));
    try {
      await emitAutonomyNotice({ tenantId: T, orgId, actionClass: 'ads.budget', summary: 'Yesterday\'s budget move', notify: { roleRefs: ['admin'], channels: ['inbox'], digest: 'daily' } });
    } finally {
      vi.useRealTimers();
    }
    const def = (await hostSuite.workflowCatalog.getWorkflow(DIGEST_CHAIN_ID))?.definition;
    if (!def) throw new Error('the digest chain is not resolvable by id');
    const now = new Date().toISOString();
    // Exactly the scheduler's shape for a host-owned job: no acting user.
    const run: RunRecord = { runId: `r-p4-digest-${n++}`, workflowId: DIGEST_CHAIN_ID, tenantId: T, status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
    await insertRunWithStartContext(storage, run, { admission: { plan: 'exempt:test-fixture' } });
    const before = await notices(AUTONOMY_DIGEST_TYPE);
    const result = await executeRun(storage, (await storage.getRun(run.runId)) ?? run, def);
    const row = await storage.getRun(run.runId);
    expect(result.status, JSON.stringify(row?.error ?? null)).toBe('completed');
    // Yesterday's queued item reached the admin and their delegate, as one digest each.
    const delivered = (await freshSince(AUTONOMY_DIGEST_TYPE, before)).filter((r) => r.message.includes('Yesterday\'s budget move'));
    expect(recipients(delivered)).toEqual(['u-admin-2', 'u-delegate']);
  });
});
