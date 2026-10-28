/**
 * ADR 0942 P2 — the autonomy gate through the REAL executor and the ONE resolve
 * choke point (`resolveAndResume`), with the real pack node from
 * `packs/feature.campaign-orchestration.nodes/index.mjs` and the real
 * `ctx.features['campaign-orchestration']` surface (createApp).
 *
 * Exit criteria (phase row P2): the gate's interrupt resolves through the unchanged
 * review inbox and quorum ledger; an MCP resumeInterrupt on it is refused; the
 * requester's own vote is refused.
 *
 * Sabotage notes (each run, 2026-10-20):
 *  - drop the self-approval block in `resolveAndResume` → red (the requester's own approve resumes the run);
 *  - make `compileApproverSpec` emit no approverRoleRefs → red (MCP consumes the gate; a non-admin's vote counts);
 *  - drop the `legacy` branch in `decideGate` → red (toggle OFF no longer yields today's open gate);
 *  - read the live overlay on a replay (drop the `replaying` check in the surface) → red (the replayed verdict is blocked).
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
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { __awaitRunResumeChainForTests, resolveAndResume } from '../src/routes/interrupts.js';
import { resumeInterrupt } from '../src/host/mcpSemantics.js';
import { tallyDecisions } from '../src/host/reviewDecisionLedger.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign, updateCampaignStatus } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { buildCampaignStudioSurface } from '../src/features/campaign-orchestration/surface.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { dispatchSubWorkflow, setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { createCanvasSurface, setCanvasInvokeDispatcher } from '../src/host/canvasSurface.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { opaquePrincipal } from '../src/host/runOwner.js';
import { isAutonomyRequester } from '../src/host/autonomyPolicy/selfApproval.js';
import {
  AUTONOMY_TOGGLE, bindClientPresetIfAbsent, decideGate, getBinding, presetRules, savePolicy, type ActionRule,
} from '../src/host/autonomyPolicy/index.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Principal, RunRecord } from '../src/types.js';
import { nodes as orchestrationNodes } from '../../../packs/feature.campaign-orchestration.nodes/index.mjs';

const TENANT = 'default';
const GATE = 'feature.campaign-orchestration.nodes.autonomy-gate';
const WF = 'wf.adr0942.autonomy-gate';
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let orgId: string;
let campaign: MarketingCampaign;
let n = 0;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

async function gateRun(opts: { tagged?: boolean; actingUserId?: string; extra?: Record<string, unknown>; campaign?: MarketingCampaign } = {}): Promise<{ run: RunRecord; interruptId?: string; status: string }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-adr0942-${n++}-${Math.random().toString(36).slice(2, 8)}`, workflowId: WF, tenantId: TENANT, status: 'pending', inputs: {},
    metadata: {
      ...(opts.tagged === false ? {} : { campaignOrchestration: stampCampaignRun(opts.campaign ?? campaign, { role: 'spine' }) }),
      actingUserId: opts.actingUserId ?? 'u-requester',
      ...(opts.extra ?? {}),
    },
    configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run);
  const def = (await hostSuite.workflowCatalog.getWorkflow(WF))?.definition;
  if (!def) throw new Error('gate workflow not registered');
  const stored = (await storage.getRun(run.runId)) ?? run;
  const status = (await executeRun(storage, stored, def)).status;
  const [open] = await storage.listOpenInterrupts(run.runId);
  return { run: (await storage.getRun(run.runId)) ?? stored, ...(open ? { interruptId: open.interruptId } : {}), status };
}

const statusOf = async (runId: string): Promise<string | undefined> => (await storage.getRun(runId))?.status;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo).port; res(); }); });
  // The pack node, wrapped the way `packs/tarballLoader.ts` wraps every pack node
  // (a non-success return becomes `failure` with the node's own code).
  getNodeRegistry().register({
    typeId: GATE, version: '1.0.0',
    execute: async (ctx) => {
      const r = await orchestrationNodes[GATE](ctx);
      if (r.status === 'success') return { status: 'success', outputs: r.outputs };
      return { status: 'failure', error: { code: r.error?.code ?? 'pack_node_error', message: r.error?.message ?? 'Pack node returned non-success outcome' } };
    },
  });
  const def = {
    workflowId: WF, name: WF, version: '1.0.0',
    nodes: [
      { nodeId: 'kernel-approve', typeId: GATE, config: { actionClass: 'plan.approve', prompt: 'Approve the messaging kernel?' } },
      { nodeId: 'after', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'kernel-approve', targetNodeId: 'after', triggerRule: 'all_success' }],
  } as unknown as WorkflowDefinition;
  registerHostWorkflow(def);
  await setToggle('campaign-orchestration', true);
  await setToggle(AUTONOMY_TOGGLE, true);
  orgId = (await createOrg({ tenantId: TENANT, createdBy: 'u-owner', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  for (const [subject, role] of [['u-requester', 'admin'], ['u-admin-2', 'admin'], ['u-admin-3', 'admin'], ['u-editor', 'editor']] as const) {
    await createMember({ tenantId: TENANT, orgId, subject, displayName: subject, roles: [role] });
  }
  await bindClientPresetIfAbsent(TENANT, orgId, 'guarded@1', 'u-owner');
  const brief = await createBrief(TENANT, orgId, 'u-owner', { name: 'Spring launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  campaign = (await ensureDraftCampaign(TENANT, brief, 'u-owner')).campaign;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0942 D5 — the gate suspends as an approval decided by the policy', () => {
  it('Guarded plan.approve suspends with role-based approvers and the autonomy block', async () => {
    const { interruptId, status } = await gateRun();
    expect(status).toBe('waiting-approval');
    const it = interruptId ? await storage.getInterrupt(interruptId) : null;
    expect(it?.kind).toBe('approval');
    expect(it?.data).toMatchObject({ approverRoleRefs: ['owner', 'admin'], autonomy: { actionClass: 'plan.approve', ruleId: 'plan.approve#default', policyId: 'preset:guarded' } });
  });

  it('the requester\'s own vote is refused, even as the only other admin would be them; another admin resumes it', async () => {
    const { run, interruptId } = await gateRun();
    if (!interruptId) throw new Error('expected an open gate');
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-requester' }))
      .rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
    expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
    // A non-approver role is not eligible either (the unchanged ADR 0075 eligibility).
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-editor' })).rejects.toMatchObject({ httpStatus: 403 });
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-admin-2' });
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('completed');
  });

  it('the requester may still reject their own request', async () => {
    const { run, interruptId } = await gateRun();
    if (!interruptId) throw new Error('expected an open gate');
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'reject' }, { subjectRef: 'u-requester' });
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('failed');
  });

  it('an MCP resumeInterrupt on the gate is refused and the gate stays open', async () => {
    const { run, interruptId } = await gateRun();
    if (!interruptId) throw new Error('expected an open gate');
    const deps = { storage, hostSuite, principal: { principalId: 'mcp:peer', tenants: [TENANT] } as unknown as Principal };
    const out = await resumeInterrupt(deps, interruptId, { action: 'approve' });
    expect(out.kind).toBe('failed');
    expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
    expect(await statusOf(run.runId)).toBe('waiting-approval');
  });

  it('a quorum of two runs through the unchanged ledger', async () => {
    const rules: ActionRule[] = presetRules('guarded@1').map((r) => (r.actionClass === 'plan.approve'
      ? { actionClass: 'plan.approve', default: { outcome: 'approve', approver: { roleRefs: ['owner', 'admin'], requiredApprovals: 2, delegation: 'allowed' } } }
      : r));
    await savePolicy({ tenantId: TENANT, orgId, campaignId: campaign.id, input: { kind: 'custom', name: 'Two sign-offs', basePreset: 'guarded@1', rules }, actor: 'u-owner', expected: null });
    const { run, interruptId } = await gateRun();
    if (!interruptId) throw new Error('expected an open gate');
    expect((await storage.getInterrupt(interruptId))?.data).toMatchObject({ requiredApprovals: 2 });
    for (const action of ['approve', 'accept']) {
      for (const decision of ['reject', 'rejected']) {
        await expect(resolveAndResume(storage, hostSuite, interruptId, { action, decision }, { subjectRef: 'u-requester' }))
          .rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
        expect((await tallyDecisions(interruptId)).accepts).toEqual([]);
        expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
      }
    }
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'accept' }, { subjectRef: 'u-admin-2' });
    expect((await tallyDecisions(interruptId)).accepts).toEqual(['u-admin-2']);
    expect(await statusOf(run.runId)).toBe('waiting-approval');
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'accept' }, { subjectRef: 'u-admin-3' });
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('completed');
  });
});

describe('ADR 0942 recovery — requester aliases deny without granting authority', () => {
  it('uses actor before an unrelated cause and canonicalizes both sides of a delegated requester', async () => {
    const { key } = await issueApiKey({ tenantId: TENANT, name: 'requester alias', createdBy: 'u-requester' });
    const run = { tenantId: TENANT, metadata: { actingUserId: `apikey:${key.keyId}`, orgScopeSubject: 'u-admin-2' } };
    expect(await isAutonomyRequester(run, ['u-requester'])).toBe(true);
    expect(await isAutonomyRequester(run, ['u-admin-2'])).toBe(false);
    expect(await isAutonomyRequester({ tenantId: TENANT, metadata: { orgScopeSubject: 'u-requester' } }, [`apikey:${key.keyId}`])).toBe(true);
  });

  it('retains the raw API-key owner identity and refuses unresolved or cross-tenant delegation', async () => {
    const { key } = await issueApiKey({ tenantId: TENANT, name: 'owner alias', createdBy: 'u-admin-2' });
    const subject = `apikey:${key.keyId}`;
    const principal = opaquePrincipal(subject);
    const run = { tenantId: TENANT, metadata: { owner: { principal, subject: { issuer: 'urn:openwop-app:api-key', subjectId: principal, lane: 'api-key', kind: 'workload' } } } };
    expect(await isAutonomyRequester(run, [subject])).toBe(true);
    expect(await isAutonomyRequester({ tenantId: TENANT }, ['apikey:missing'])).toBe(true);
    const foreign = await issueApiKey({ tenantId: 'foreign-autonomy', name: 'foreign', createdBy: 'u-requester' });
    expect(await isAutonomyRequester({ tenantId: TENANT, metadata: { orgScopeSubject: `apikey:${foreign.key.keyId}` } }, ['u-admin-2'])).toBe(true);
    expect(await isAutonomyRequester({ tenantId: TENANT }, [`apikey:${foreign.key.keyId}`])).toBe(true);
  });

  it.each(['subworkflow', 'canvas'] as const)('%s retains frozen policy and refuses the causing admin and their key', async (method) => {
    await savePolicy({ tenantId: TENANT, orgId, campaignId: campaign.id, input: { kind: 'preset', preset: 'guarded@1' }, actor: 'u-owner', expected: await getBinding(TENANT, orgId, campaign.id) });
    const { run: parent } = await gateRun();
    const frozen = parent.metadata?.campaignAutonomy;
    // A live edit cannot relax the already-started parent's child.
    await savePolicy({ tenantId: TENANT, orgId, campaignId: campaign.id, input: { kind: 'preset', preset: 'autopilot@1' }, actor: 'u-owner', expected: await getBinding(TENANT, orgId, campaign.id) });
    const childWorkflowId = `${WF}.child-${n++}`;
    const original = (await hostSuite.workflowCatalog.getWorkflow(WF))!.definition;
    const childDefinition: WorkflowDefinition = { ...original, workflowId: childWorkflowId };
    registerHostWorkflow(childDefinition);
    let finished!: () => void;
    const executed = new Promise<void>((resolve) => { finished = resolve; });
    const execute = async (db: Storage, child: RunRecord): Promise<void> => {
      try { await executeRun(db, child, childDefinition); } finally { finished(); }
    };
    setSubWorkflowDispatcher({ storage, hostSuite, executeRun: execute });
    setCanvasInvokeDispatcher({ storage, getWorkflow: async () => ({ definition: childDefinition }), executeRun: execute });
    const result = method === 'subworkflow'
      ? await dispatchSubWorkflow({ parentRunId: parent.runId, parentTenantId: TENANT, childWorkflowId, parentNodeId: 'nested', waitForCompletion: false })
      : await createCanvasSurface({ tenantId: TENANT, runId: parent.runId, actingUserId: 'u-requester' }).invoke(`cv-autonomy-${n++}`, childWorkflowId, {}, { awaitTerminal: false });
    await executed;
    const child = (await storage.getRun(result.childRunId))!;
    expect(child.metadata?.actingUserId).toBeUndefined();
    expect(child.metadata?.owner).toBeUndefined();
    expect(child.metadata?.orgScopeSubject).toBe('u-requester');
    expect(child.metadata?.campaignAutonomy).toEqual(frozen);
    expect((await gateRun()).interruptId).toBeUndefined(); // fresh parent gets the live edit
    const [gate] = await storage.listOpenInterrupts(child.runId);
    if (!gate) throw new Error('expected inherited Guarded gate');
    const { key } = await issueApiKey({ tenantId: TENANT, name: `${method} requester`, createdBy: 'u-requester' });
    for (const subjectRef of ['u-requester', `apikey:${key.keyId}`]) {
      await expect(resolveAndResume(storage, hostSuite, gate.interruptId, { action: 'approve' }, { subjectRef }))
        .rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
      expect((await tallyDecisions(gate.interruptId)).accepts).toEqual([]);
    }
    await resolveAndResume(storage, hostSuite, gate.interruptId, { action: 'approve' }, { subjectRef: 'u-admin-2' });
    await __awaitRunResumeChainForTests(child.runId);
    expect(await statusOf(child.runId)).toBe('completed');
    expect((await storage.getRun(child.runId))?.metadata?.actingUserId).toBeUndefined();
  });
});

describe('ADR 0942 D5 — proceed, blocked and legacy', () => {
  it('Autopilot plan.approve proceeds with the decision recorded, no interrupt', async () => {
    await savePolicy({
      tenantId: TENANT, orgId, campaignId: campaign.id, input: { kind: 'preset', preset: 'autopilot@1' }, actor: 'u-owner',
      expected: await getBinding(TENANT, orgId, campaign.id),
    });
    const { run, interruptId, status } = await gateRun();
    expect(interruptId).toBeUndefined();
    expect(status).toBe('completed');
    void run;
  });

  it('a paused campaign blocks the gate live (tighten-only overlay)', async () => {
    await updateCampaignStatus(TENANT, campaign.id, 'paused', 'u-owner');
    const blocked = decideGate({ run: (await gateRun({}).then((r) => r.run)), actionClass: 'social.post', facts: {}, toggleOn: true, live: { campaignStatus: 'paused' } });
    expect(blocked).toMatchObject({ mode: 'blocked', reason: 'campaign_paused' });
    await updateCampaignStatus(TENANT, campaign.id, 'draft', 'u-owner');
  });

  it('toggle OFF and an unstamped run: exactly today\'s open gate (no approvers, no autonomy block)', async () => {
    await setToggle(AUTONOMY_TOGGLE, false);
    const { run, interruptId } = await gateRun();
    await setToggle(AUTONOMY_TOGGLE, true);
    if (!interruptId) throw new Error('expected an open gate');
    const data = (await storage.getInterrupt(interruptId))?.data as Record<string, unknown>;
    expect(data.autonomy).toBeUndefined();
    expect(data.approverRoleRefs).toBeUndefined();
    // Open gate: the requester may approve, as before the policy existed.
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-requester' });
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('completed');
  });

  it('an unbound (non-campaign) run is legacy', async () => {
    const { interruptId } = await gateRun({ tagged: false });
    if (!interruptId) throw new Error('expected an open gate');
    expect(((await storage.getInterrupt(interruptId))?.data as Record<string, unknown>).autonomy).toBeUndefined();
  });

  it('a gate whose config names approvers is refused', async () => {
    const res = await orchestrationNodes[GATE]({ config: { actionClass: 'plan.approve', approverRoleRefs: ['editor'] }, inputs: {}, features: {} });
    expect(res).toMatchObject({ status: 'failure', error: { code: 'autonomy_config_approvers_refused' } });
  });
});

describe('ADR 0942 D4 — a replay re-derives nothing from the live overlay', () => {
  it('the surface blocks a paused campaign live, but not while replaying', async () => {
    const run = (await gateRun()).run; // a stamped Autopilot run (the policy set above)
    const surface = buildCampaignStudioSurface({ tenantId: TENANT, runId: run.runId });
    const facts = { spendMinor: 0, audienceSize: 1, regulatedCategory: false, findingsHigh: 0, firstForDestination: false };
    await updateCampaignStatus(TENANT, campaign.id, 'paused', 'u-owner');
    try {
      const live = await surface.autonomyResolve({ actionClass: 'social.post', facts });
      expect(live).toMatchObject({ mode: 'blocked', reason: 'campaign_paused' });
      const replayed = await runWithEffectContext({ runId: run.runId, replaying: true }, () => surface.autonomyResolve({ actionClass: 'social.post', facts }));
      expect(replayed).toMatchObject({ mode: 'proceed', outcome: 'notify-after' });
    } finally {
      await updateCampaignStatus(TENANT, campaign.id, 'draft', 'u-owner');
    }
  });

  it('a stamped run\'s verdict does not depend on the toggle (replay never reads toggles)', async () => {
    const run = (await gateRun()).run;
    const facts = { spendMinor: 0, audienceSize: 1, regulatedCategory: false, findingsHigh: 0, firstForDestination: false };
    expect(decideGate({ run, actionClass: 'social.post', facts, toggleOn: true })).toEqual(decideGate({ run, actionClass: 'social.post', facts, toggleOn: false }));
  });
});

describe('ADR 0962 D4 — an external agent cannot satisfy a campaign gate', () => {
  const MCP_RUN = { source: 'mcp-server-mount', trustBoundary: 'untrusted' };
  // Its own campaign: earlier cases move the shared one to Autopilot. This one
  // inherits the client's Guarded default, under which plan.approve waits.
  let guardedCampaign: MarketingCampaign;
  beforeAll(async () => {
    const brief = await createBrief(TENANT, orgId, 'u-owner', { name: 'MCP request', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
    guardedCampaign = (await ensureDraftCampaign(TENANT, brief, 'u-owner')).campaign;
  });
  const mcpDeps = () => ({ storage, hostSuite, principal: { principalId: 'u-requester', tenants: [TENANT] } as unknown as Principal });

  it('D4.2: the person whose key the agent holds cannot approve what their agent requested; another admin can', async () => {
    const { run, interruptId } = await gateRun({ extra: MCP_RUN, campaign: guardedCampaign });
    if (!interruptId) throw new Error('expected an open gate');
    await expect(resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-requester' }))
      .rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
    // Nor through the agent's own MCP retry.
    expect((await resumeInterrupt(mcpDeps(), interruptId, { action: 'approve' })).kind).toBe('failed');
    expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
    await resolveAndResume(storage, hostSuite, interruptId, { action: 'approve' }, { subjectRef: 'u-admin-2' });
    await __awaitRunResumeChainForTests(run.runId);
    expect(await statusOf(run.runId)).toBe('completed');
  });

  it('D4.1: with the autonomy toggle off the gate suspends OPEN (no ACL), and an MCP retry on a campaign run is still refused', async () => {
    await setToggle(AUTONOMY_TOGGLE, false);
    try {
      const { run, interruptId } = await gateRun({ extra: MCP_RUN, campaign: guardedCampaign });
      if (!interruptId) throw new Error('expected an open gate');
      const it = await storage.getInterrupt(interruptId);
      expect(it?.data).not.toHaveProperty('approverRoleRefs'); // the legacy, ACL-less shape
      const out = await resumeInterrupt(mcpDeps(), interruptId, { action: 'approve' });
      expect(out.kind).toBe('failed');
      expect((await storage.getInterrupt(interruptId))?.resolvedAt).toBeUndefined();
      expect(await statusOf(run.runId)).toBe('waiting-approval');
    } finally {
      await setToggle(AUTONOMY_TOGGLE, true);
    }
  });
});
