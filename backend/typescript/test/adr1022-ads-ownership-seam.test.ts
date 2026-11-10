/**
 * ADR 1022 follow-up (adapter seam) — `updateBudget` and `setDeliveryStatus`
 * refuse a campaign the acting org does not own, whoever calls them.
 *
 * #5467 put the ownership check in the core `ad-budget-update` node, but the
 * executor's `ctx.ads` hands both write methods to EVERY node, so a pack could
 * call them with another client's campaign id. The check now lives in the adapter:
 * the org comes from the stored run's host-written client stamp, else the
 * adapter's `deps.orgId` (the executor's `run.tenantId`, or the org a feature
 * route authorized), never from node config or call args. The campaign must be
 * that org's by the ONE predicate (`orgOwnsAdCampaign`, registered at boot).
 *
 * Booted through `createApp`, a pack-like node runs inside a real run so the call
 * goes through the executor-built, feature-gated `ctx.ads`, against real
 * dispatch-ledger rows for two orgs in one tenant on the same ad account.
 *
 * Sabotage (2026-11-02), each alone then reverted:
 * - skip the `updateBudget` ownership refusal → the budget cases go red;
 * - skip the `setDeliveryStatus` ownership refusal → the pause/activate cases go red;
 * - let `deps.orgId` (the executor's `run.tenantId`) win over the run's stamp →
 *   the positive control goes red;
 * - skip the refusal of a route org that differs from its run's stamp → the
 *   mismatch case goes red;
 * - let a missing checker allow the change → the no-checker case goes red;
 * - (w86) refuse the route lane's own org (`deps.orgId` with no stored run) →
 *   org B's route case goes red.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import {
  __putDispatchRecordForTests, getAdsCampaignOwnershipChecker, makeAdsAdapter, setAdsCampaignOwnershipChecker, type AdsAdapter,
} from '../src/host/adsAdapter.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import type { NodeContext, WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const T = 'adr1022-ads-seam';
const ACCOUNT = '1234567890';
const PACK_NODE = 'test.pack.ads-writer';
const OWNED_A = '101';
const OWNED_B = '202';
const MISSING = '303';
let storage: Storage;
let orgA: string;
let orgB: string;
let stampA: unknown;
let n = 0;

type Op = 'budget' | 'pause' | 'activate' | 'budget-preview' | 'pause-preview';
let lastResult: { outcome: string; error?: unknown } | null = null;

/** The executor hands a node the whole gated adapter; `NodeContext['ads']` types
 *  only part of it, and a JS pack sees every method. Checked at runtime. */
function writerOf(ctx: NodeContext): Pick<AdsAdapter, 'updateBudget' | 'setDeliveryStatus'> | null {
  const a: object | undefined = ctx.ads;
  if (!a || !('updateBudget' in a) || !('setDeliveryStatus' in a)) return null;
  return a as Pick<AdsAdapter, 'updateBudget' | 'setDeliveryStatus'>;
}

/** What a third-party pack can do: call `ctx.ads` with ids from its own config. */
async function packNode(ctx: NodeContext) {
  const cfg = (ctx.config ?? {}) as { op: Op; campaignId: string };
  const ads = writerOf(ctx);
  if (!ads) return { status: 'failure' as const, error: { code: 'no_ads', message: 'ctx.ads missing' } };
  const target = { platform: 'google' as const, adAccountId: ACCOUNT, campaignId: cfg.campaignId };
  lastResult = cfg.op === 'budget' ? await ads.updateBudget({ ...target, dailyBudgetMinor: 9_000 })
    : cfg.op === 'budget-preview' ? await ads.updateBudget({ ...target, dailyBudgetMinor: 9_000, dryRun: true })
    : cfg.op === 'pause-preview' ? await ads.setDeliveryStatus({ ...target, status: 'paused', reason: { kind: 'operator', ref: 'test' }, dryRun: true })
    : await ads.setDeliveryStatus({ ...target, status: cfg.op === 'pause' ? 'paused' : 'active', reason: { kind: 'operator', ref: 'test' } });
  return { status: 'success' as const, outputs: {} };
}

/** Run the pack node once inside a real run; returns what `ctx.ads` answered. */
async function viaPack(metadata: Record<string, unknown>, config: Record<string, unknown>): Promise<{ outcome: string; error?: unknown }> {
  const workflowId = `wf.adr1022-seam.${n++}`;
  const def: WorkflowDefinition = { workflowId, nodes: [{ nodeId: 'pack', typeId: PACK_NODE, config }], edges: [] };
  registerHostWorkflow(def);
  const now = new Date().toISOString();
  const run: RunRecord = { runId: `r-seam-${n}`, workflowId, tenantId: T, status: 'pending', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now };
  await insertRunWithStartContext(storage, run, { admission: { plan: 'exempt:test-fixture' } });
  lastResult = null;
  const status = (await executeRun(storage, (await storage.getRun(run.runId)) ?? run, def)).status;
  if (!lastResult) throw new Error(`the pack node never answered (run ${status})`);
  return lastResult;
}

const refusedBudget = (error: string) => ({ outcome: 'failed', error });
const refusedStatus = (error: string) => ({ outcome: 'refused', error });

beforeAll(async () => {
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  const d = getToggleDefault('campaign-channels');
  if (!d) throw new Error('no campaign-channels toggle');
  await saveConfig({ ...d, status: 'on' }, 'test');
  getNodeRegistry().register({ typeId: PACK_NODE, version: '1.0.0', execute: packNode });
  orgA = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  orgB = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client B', ownerSubject: 'u-owner' })).orgId;
  const campaignA = (await ensureDraftCampaign(T, await createBrief(T, orgA, 'u-owner', { name: 'A launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] }), 'u-owner')).campaign;
  const campaignB = (await ensureDraftCampaign(T, await createBrief(T, orgB, 'u-owner', { name: 'B launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] }), 'u-owner')).campaign;
  const at = new Date().toISOString();
  // The rows each org's launch would have written, on the SAME ad account.
  await __putDispatchRecordForTests({ tenantId: T, platform: 'google', platformCampaignId: OWNED_A, platformAdSetId: 'as-a', platformAdId: 'ad-a', adAccountId: ACCOUNT, createdAt: at, campaignId: campaignA.id, orgId: orgA });
  await __putDispatchRecordForTests({ tenantId: T, platform: 'google', platformCampaignId: OWNED_B, platformAdSetId: 'as-b', platformAdId: 'ad-b', adAccountId: ACCOUNT, createdAt: at, campaignId: campaignB.id, orgId: orgB });
  stampA = stampCampaignRun(campaignA, { role: 'optimizer' });
});

describe('ADR 1022 follow-up — a pack calling ctx.ads meets the ownership seam', () => {
  const runA = () => ({ campaignOrchestration: stampA });

  it('positive control: org A\'s run reaches past the seam for org A\'s campaign', async () => {
    // The preview is what a dry run past every gate returns: nothing refused it.
    expect(await viaPack(runA(), { op: 'budget-preview', campaignId: OWNED_A })).toEqual({ outcome: 'preview', platform: 'google', dailyBudgetMinor: 9_000, target: `customers/${ACCOUNT} campaign ${OWNED_A}` });
    expect(await viaPack(runA(), { op: 'pause-preview', campaignId: OWNED_A })).toMatchObject({ outcome: 'preview', status: 'paused' });
  });

  it('a budget change on ANOTHER org\'s campaign is refused', async () => {
    expect(await viaPack(runA(), { op: 'budget', campaignId: OWNED_B })).toEqual(refusedBudget('ad_campaign_not_in_org'));
    expect(await viaPack(runA(), { op: 'budget-preview', campaignId: OWNED_B })).toEqual(refusedBudget('ad_campaign_not_in_org'));
  });

  it('a cross-org pause and a cross-org activate (resume) are refused', async () => {
    expect(await viaPack(runA(), { op: 'pause', campaignId: OWNED_B })).toEqual(refusedStatus('ad_campaign_not_in_org'));
    expect(await viaPack(runA(), { op: 'activate', campaignId: OWNED_B })).toEqual(refusedStatus('ad_campaign_not_in_org'));
    expect(await viaPack(runA(), { op: 'pause-preview', campaignId: OWNED_B })).toEqual(refusedStatus('ad_campaign_not_in_org'));
  });

  it('a campaign no org owns (missing) gets the same answer', async () => {
    expect(await viaPack(runA(), { op: 'budget', campaignId: MISSING })).toEqual(refusedBudget('ad_campaign_not_in_org'));
    expect(await viaPack(runA(), { op: 'pause', campaignId: MISSING })).toEqual(refusedStatus('ad_campaign_not_in_org'));
  });

  it('a pack-set cfg.orgId cannot change which org the seam resolves', async () => {
    // Stamped for A, the pack names B: still A, so B's campaign is refused.
    expect(await viaPack(runA(), { op: 'budget', campaignId: OWNED_B, orgId: orgB })).toEqual(refusedBudget('ad_campaign_not_in_org'));
    // Unstamped, the pack names B: the run acts for its workspace, not B.
    expect(await viaPack({}, { op: 'budget', campaignId: OWNED_B, orgId: orgB })).toEqual(refusedBudget('ad_campaign_not_in_org'));
    expect(await viaPack({}, { op: 'pause', campaignId: OWNED_B, orgId: orgB })).toEqual(refusedStatus('ad_campaign_not_in_org'));
  });

  it('with no ownership checker registered, both doors fail closed', async () => {
    const registered = getAdsCampaignOwnershipChecker();
    expect(registered).not.toBeNull(); // campaign-intel registered it at boot
    setAdsCampaignOwnershipChecker(null);
    try {
      expect(await viaPack(runA(), { op: 'budget', campaignId: OWNED_A })).toEqual(refusedBudget('capability_not_provided'));
      expect(await viaPack(runA(), { op: 'pause', campaignId: OWNED_A })).toEqual(refusedStatus('capability_not_provided'));
    } finally { setAdsCampaignOwnershipChecker(registered); }
  });
});

describe('ADR 1022 follow-up — the route lane (no stored run) acts for the org it authorized', () => {
  const routeAdapter = (orgId: string) => makeAdsAdapter({ storage, tenantId: T, runId: `hostext:test-route:${n++}`, actingUserId: 'u-owner', orgId });

  it('org B\'s route reaches its own campaign and is refused org A\'s', async () => {
    expect(await routeAdapter(orgB).setDeliveryStatus({ platform: 'google', adAccountId: ACCOUNT, campaignId: OWNED_B, status: 'paused', reason: { kind: 'operator', ref: 'test' }, dryRun: true })).toMatchObject({ outcome: 'preview' });
    expect(await routeAdapter(orgB).setDeliveryStatus({ platform: 'google', adAccountId: ACCOUNT, campaignId: OWNED_A, status: 'paused', reason: { kind: 'operator', ref: 'test' } })).toEqual(refusedStatus('ad_campaign_not_in_org'));
    expect(await routeAdapter(orgB).updateBudget({ platform: 'google', adAccountId: ACCOUNT, campaignId: OWNED_A, dailyBudgetMinor: 9_000 })).toEqual(refusedBudget('ad_campaign_not_in_org'));
  });

  it('an adapter naming a client org other than its stored run\'s stamp is refused', async () => {
    const now = new Date().toISOString();
    const runId = `r-seam-mismatch-${n++}`;
    await storage.insertRun({ runId, workflowId: 'w', tenantId: T, status: 'running', inputs: {}, metadata: { campaignOrchestration: stampA }, configurable: {}, createdAt: now, updatedAt: now });
    const crossed = makeAdsAdapter({ storage, tenantId: T, runId, actingUserId: 'u-owner', orgId: orgB });
    expect(await crossed.updateBudget({ platform: 'google', adAccountId: ACCOUNT, campaignId: OWNED_B, dailyBudgetMinor: 9_000 })).toEqual(refusedBudget('forbidden_scope'));
  });
});
