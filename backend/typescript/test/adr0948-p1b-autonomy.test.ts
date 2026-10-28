/**
 * ADR 0948 P1b × ADR 0942 — a funnel publish requested by a CAMPAIGN-BOUND run asks
 * the campaign's frozen autonomy policy (class `content.publish`), through the real
 * chokepoint, real stamped runs, a real saved policy and the real decision core.
 *
 *  - `approve` with named roles: the row carries the policy and the source run; only
 *    an eligible NON-requester decides it (`autonomy_not_eligible` for a writer the
 *    policy does not name, `autonomy_self_approval_refused` for the requester), on top
 *    of the funnels handler's own `workspace:write` floor. The named approver publishes.
 *  - `blocked`: the request is refused before any row exists; the funnel stays a draft.
 *  - ceiling `approve`: an `auto` policy still opens a review (a funnel never
 *    publishes without a person).
 *  - unbound (a plain run): the writers-only review, exactly as before.
 *  - a writers-only request for the same content returns the open GATED review rather
 *    than adding a weaker path to the same publish.
 *
 * Sabotage notes (2026-10-26): drop the `registerAutonomyPolicyRowEligibility`
 * registration → red (a writer the policy does not name publishes); drop the gate
 * from the row identity / the stronger-row return → red (a weaker row coexists);
 * map `blocked` to unbound → red (the blocked request opens a review).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { claimApproval } from '../src/host/approvalDecision.js';
import { getApproval, listApprovals } from '../src/host/approvalService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import { createClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { AUTONOMY_TOGGLE, DEFAULT_APPROVER, getBinding, savePolicy, type ActionRule } from '../src/host/autonomyPolicy/index.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { createFunnel, getFunnel } from '../src/features/funnels/funnelsService.js';
import { requestFunnelPublish } from '../src/features/funnels/funnelPublishApproval.js';
import type { RunRecord } from '../src/types.js';

const T = 'adr0948-p1b-autonomy';
let storage: Storage;
const deps = { storage: null as unknown as Storage, hostSuite: null as unknown as HostAdapterSuite };
let orgId: string;
let campaign: MarketingCampaign;
let n = 0;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

async function insertRun(metadata: Record<string, unknown>): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `r-p1b-auto-${n++}-${Math.random().toString(36).slice(2, 8)}`, workflowId: 'wf.p1b', tenantId: T, status: 'running', inputs: {},
    metadata, configurable: {}, createdAt: now, updatedAt: now,
  };
  await insertRunWithStartContext(storage, run);
  return (await storage.getRun(run.runId)) ?? run;
}
/** A campaign run stamped through the real seam; the acting requester is u1. */
const campaignRun = (): Promise<RunRecord> => insertRun({ campaignOrchestration: stampCampaignRun(campaign, { role: 'stage' }), actingUserId: 'u1' });

async function setCampaignRules(rules: ActionRule[]): Promise<void> {
  const expected = await getBinding(T, orgId, campaign.id);
  await savePolicy({ tenantId: T, orgId, campaignId: campaign.id, actor: 'u-owner', expected, input: { kind: 'custom', name: `p1b-${n++}`, basePreset: 'guarded@1', rules } });
}
const ownerOnly: ActionRule = { actionClass: 'content.publish', default: { outcome: 'approve', approver: { ...DEFAULT_APPROVER, roleRefs: ['owner'] } } };

/** A draft funnel whose one step page is published (the precondition every review checks). */
async function draftFunnel(): Promise<string> {
  const page = await createPage({ tenantId: T, orgId, title: `Landing ${n++}`, createdBy: 'seed' });
  await transitionPage(T, orgId, page.pageId, 'publish', 'seed');
  return (await createFunnel({ tenantId: T, orgId, createdBy: 'seed', name: `Funnel ${n++}`, steps: [{ kind: 'landing', pageId: page.pageId }] })).funnelId;
}
const decide = (approvalId: string, decidedBy: string) => claimApproval(deps, { tenantId: T, decidedBy }, approvalId);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  deps.storage = storage; deps.hostSuite = app.locals.hostSuite as HostAdapterSuite;
  for (const id of ['funnels', 'campaign-orchestration', 'campaign-channels', AUTONOMY_TOGGLE]) await setToggle(id, true);
  orgId = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  for (const [subject, role] of [['u1', 'admin'], ['u-admin-2', 'admin'], ['u-editor', 'editor']] as const) {
    await createMember({ tenantId: T, orgId, subject, displayName: subject, roles: [role] });
  }
  await createClient({ tenantId: T, name: 'Client A', orgId, createdBy: 'u-owner' });
  await updateClient(T, orgId, { mode: 'live' });
  const brief = await createBrief(T, orgId, 'u-owner', { name: 'Spring launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] });
  campaign = (await ensureDraftCampaign(T, brief, 'u-owner')).campaign;
});
afterAll(async () => { /* memory storage: nothing to close */ });

describe('ADR 0948 P1b × ADR 0942 — a campaign run\'s funnel publish follows the campaign\'s policy', () => {
  it('approve with named roles: only an eligible non-requester decides; the named approver publishes', async () => {
    await setCampaignRules([ownerOnly]);
    const funnelId = await draftFunnel();
    const run = await campaignRun();
    const out = await requestFunnelPublish(T, orgId, funnelId, { requestedBy: 'u1', runId: run.runId });
    if (!out) throw new Error('expected a review');
    const row = await getApproval(out.approvalId);
    expect(row).toMatchObject({ kind: 'funnel-publish', status: 'pending', autonomySourceRunId: run.runId, policy: { approverRoleRefs: ['owner'] } });
    expect(row?.funnelPublish?.gate, 'the row records which gate it carries').toBeTruthy();

    await expect(decide(out.approvalId, 'u1')).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
    // Writers the policy does not name: they pass the funnels floor, not the policy.
    for (const who of ['u-admin-2', 'u-editor']) {
      await expect(decide(out.approvalId, who)).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_not_eligible' } });
    }
    expect((await getFunnel(T, orgId, funnelId))?.status).toBe('draft');
    await decide(out.approvalId, 'u-owner');
    expect((await getFunnel(T, orgId, funnelId))?.status).toBe('published');
  });

  it('blocked: the request is refused before any review exists; the funnel stays a draft', async () => {
    await setCampaignRules([{ actionClass: 'content.publish', default: { outcome: 'blocked', reason: 'no funnel publishing from workflows' } }]);
    const funnelId = await draftFunnel();
    const run = await campaignRun();
    await expect(requestFunnelPublish(T, orgId, funnelId, { requestedBy: 'u1', runId: run.runId })).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_blocked' } });
    expect((await listApprovals(T, 'pending')).filter((a) => a.funnelPublish?.funnelId === funnelId)).toEqual([]);
    expect((await getFunnel(T, orgId, funnelId))?.status).toBe('draft');
  });

  it('ceiling approve: an auto policy still opens a review; a funnel never publishes without a person', async () => {
    await setCampaignRules([{ actionClass: 'content.publish', default: { outcome: 'auto' } }]);
    const funnelId = await draftFunnel();
    const run = await campaignRun();
    const out = await requestFunnelPublish(T, orgId, funnelId, { requestedBy: 'u1', runId: run.runId });
    expect(out?.status).toBe('pending_approval');
    expect((await getFunnel(T, orgId, funnelId))?.status).toBe('draft');
    expect((await getApproval(out!.approvalId))?.policy?.approverRoleRefs?.length ?? 0, 'the default approvers are named').toBeGreaterThan(0);
  });

  it('unbound (a plain run): the writers-only review, decidable by another writer', async () => {
    const funnelId = await draftFunnel();
    const run = await insertRun({ actingUserId: 'u1' });
    const out = await requestFunnelPublish(T, orgId, funnelId, { requestedBy: 'u1', runId: run.runId });
    const row = await getApproval(out!.approvalId);
    expect(row?.policy).toBeUndefined();
    expect(row?.funnelPublish?.gate).toBeUndefined();
    await decide(out!.approvalId, 'u-editor');
    expect((await getFunnel(T, orgId, funnelId))?.status).toBe('published');
  });

  it('a writers-only request for the same content returns the open GATED review, never a weaker second one', async () => {
    await setCampaignRules([ownerOnly]);
    const funnelId = await draftFunnel();
    const gated = await requestFunnelPublish(T, orgId, funnelId, { requestedBy: 'u1', runId: (await campaignRun()).runId });
    const plain = await requestFunnelPublish(T, orgId, funnelId, { requestedBy: 'u-admin-2', runId: (await insertRun({ actingUserId: 'u-admin-2' })).runId });
    expect(plain?.approvalId).toBe(gated?.approvalId);
    const open = (await listApprovals(T, 'pending')).filter((a) => a.funnelPublish?.funnelId === funnelId);
    expect(open.map((a) => a.approvalId)).toEqual([gated!.approvalId]);

    // And the reverse: a gated request supersedes an open writers-only review of the same content.
    const funnel2 = await draftFunnel();
    const weak = await requestFunnelPublish(T, orgId, funnel2, { requestedBy: 'u-admin-2', runId: (await insertRun({ actingUserId: 'u-admin-2' })).runId });
    const strong = await requestFunnelPublish(T, orgId, funnel2, { requestedBy: 'u1', runId: (await campaignRun()).runId });
    expect(strong?.approvalId).not.toBe(weak?.approvalId);
    expect((await getApproval(weak!.approvalId))?.status).toBe('rejected');
    expect((await listApprovals(T, 'pending')).filter((a) => a.funnelPublish?.funnelId === funnel2).map((a) => a.approvalId)).toEqual([strong!.approvalId]);
  });
});
