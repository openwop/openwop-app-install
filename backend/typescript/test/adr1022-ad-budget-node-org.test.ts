/**
 * ADR 1022 follow-up (Q-1) — the core `ad-budget-update` node changes a live
 * budget only for a campaign the run's org owns.
 *
 * The node takes `(platform, adAccountId, campaignId)` from its config, and in an
 * agency set-up one ad-platform token reaches every client's accounts. It now
 * resolves the run's org (the host-written client stamp, else an explicit
 * `orgId`), applies the ADR 0832 run-lane floor, and asks the ONE ownership
 * predicate (`orgOwnsAdCampaign`, registered by campaign-intel at boot) BEFORE
 * `ctx.ads.updateBudget`. A refusal is a typed failure, never an empty success.
 *
 * Booted through `createApp`, so the predicate is the one the feature registers,
 * read against real dispatch-ledger rows for two orgs in the same tenant.
 *
 * Sabotage (2026-11-02): drop the `ownsCampaign` refusal in
 * `bootstrap/nodes.ts` → the cross-org and missing-campaign cases go red (the
 * adapter is called and the step reports `applied:true`). Drop the stamp-vs-named
 * refusal → the mismatch case goes red. Skip `assertRunScopeOrg` → the outsider
 * case goes red. Skip the no-checker refusal → that case throws instead of
 * failing typed. (w86) The named-org refusal and the floor share a code, so the
 * cases assert the message: before that, dropping the named check left the
 * unstamped case green on the floor's refusal. Ignore the run's stamp (act for
 * the workspace) → the positive control goes red.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { __putDispatchRecordForTests, getAdsCampaignOwnershipChecker, setAdsCampaignOwnershipChecker } from '../src/host/adsAdapter.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';

// Three refusals share `forbidden_scope`; the message tells them apart, so a case
// cannot pass on the floor when it claims the named-org check (or the reverse).
const NAMES_OTHER_ORG = 'This step names a different organization from the one this run is for, so the budget was not changed.';
const FLOOR_REFUSED = 'The person this run acts for cannot change budgets in that organization.';

const T = 'adr1022-budget-node';
const ACCOUNT = '1234567890';
let storage: Storage;
let orgA: string;
let orgB: string;
let stampA: unknown;

type AdsSurface = NonNullable<NodeContext['ads']>;
type BudgetAsk = Parameters<NonNullable<AdsSurface['updateBudget']>>[0];

async function insertRun(runId: string, metadata: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  await storage.insertRun({ runId, workflowId: 'wf.adr1022-budget-node', tenantId: T, status: 'running', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now });
}

/** Run the node once; `calls` records every adapter budget call. */
async function runBudget(runId: string, config: Record<string, unknown>, actingUserId = 'u1'): Promise<{ res: Awaited<ReturnType<NonNullable<ReturnType<ReturnType<typeof getNodeRegistry>['get']>>['execute']>>; calls: BudgetAsk[] }> {
  const calls: BudgetAsk[] = [];
  const ads: AdsSurface = {
    publishAd: async () => ({ outcome: 'no_connection' as const }),
    updateBudget: async (a) => { calls.push(a); return { outcome: 'updated', platform: 'google', dailyBudgetMinor: 9_000, target: 'customers/1/campaignBudgets/1' }; },
  };
  const ctx: NodeContext = {
    runId, nodeId: 'budget', tenantId: T, actingUserId, inputs: {}, configurable: {}, attempt: 1, secrets: {},
    emit: async () => ({ eventId: 'e1', sequence: 1 }), ads,
    config: { platform: 'google', adAccountId: ACCOUNT, dailyBudgetMinor: 9_000, dryRun: false, ...config },
  };
  const node = getNodeRegistry().get('core.openwop.connectors.ad-budget-update');
  if (!node) throw new Error('ad-budget-update is not registered');
  return { res: await node.execute(ctx), calls };
}

beforeAll(async () => {
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  orgA = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  orgB = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client B', ownerSubject: 'u-owner' })).orgId;
  // u1 writes in BOTH orgs, so the floor passes and only ownership decides.
  for (const orgId of [orgA, orgB]) await createMember({ tenantId: T, orgId, subject: 'u1', displayName: 'u1', roles: ['editor'] });
  const campaignA = (await ensureDraftCampaign(T, await createBrief(T, orgA, 'u-owner', { name: 'A launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] }), 'u-owner')).campaign;
  const campaignB = (await ensureDraftCampaign(T, await createBrief(T, orgB, 'u-owner', { name: 'B launch', channels: [{ type: 'email_sequence', enabled: true, config: {} }] }), 'u-owner')).campaign;
  const at = new Date().toISOString();
  // The rows each org's launch would have written, on the SAME ad account.
  await __putDispatchRecordForTests({ tenantId: T, platform: 'google', platformCampaignId: 'pc-a', platformAdSetId: 'as-a', platformAdId: 'ad-a', adAccountId: ACCOUNT, createdAt: at, campaignId: campaignA.id, orgId: orgA });
  await __putDispatchRecordForTests({ tenantId: T, platform: 'google', platformCampaignId: 'pc-b', platformAdSetId: 'as-b', platformAdId: 'ad-b', adAccountId: ACCOUNT, createdAt: at, campaignId: campaignB.id, orgId: orgB });
  stampA = stampCampaignRun(campaignA, { role: 'optimizer' });
  await insertRun('run-a', { campaignOrchestration: stampA, actingUserId: 'u1' });
  await insertRun('run-unstamped', { actingUserId: 'u1' });
});

describe('ADR 1022 follow-up — ad-budget-update refuses a campaign the run\'s org does not own', () => {
  it('positive control: org A\'s run changes org A\'s campaign', async () => {
    const { res, calls } = await runBudget('run-a', { campaignId: 'pc-a' });
    expect(res).toMatchObject({ status: 'success', outputs: { applied: true, target: 'customers/1/campaignBudgets/1' } });
    expect(calls).toEqual([{ platform: 'google', adAccountId: ACCOUNT, campaignId: 'pc-a', dailyBudgetMinor: 9_000, dryRun: false }]);
  });

  it('a campaign of ANOTHER org in the same tenant is refused before the adapter call', async () => {
    const { res, calls } = await runBudget('run-a', { campaignId: 'pc-b' });
    expect(res).toMatchObject({ status: 'failure', error: { code: 'ad_campaign_not_in_org' } });
    expect(calls).toHaveLength(0);
  });

  it('a campaign no org owns (missing) is refused the same way', async () => {
    const { res, calls } = await runBudget('run-a', { campaignId: 'pc-missing' });
    expect(res).toMatchObject({ status: 'failure', error: { code: 'ad_campaign_not_in_org' } });
    expect(calls).toHaveLength(0);
  });

  it('a step naming an org other than the run\'s stamped client is refused', async () => {
    const { res, calls } = await runBudget('run-a', { campaignId: 'pc-b', orgId: orgB });
    expect(res).toMatchObject({ status: 'failure', error: { code: 'forbidden_scope', message: NAMES_OTHER_ORG } });
    expect(calls).toHaveLength(0);
  });

  it('an unstamped run acts for its workspace: naming a client org is refused, not honoured', async () => {
    // CORRECTED (adapter seam): node config is caller-controlled, so it no longer
    // picks the org. Before, `orgId: orgB` here applied to B's campaign.
    const named = await runBudget('run-unstamped', { campaignId: 'pc-b', orgId: orgB });
    expect(named.res).toMatchObject({ status: 'failure', error: { code: 'forbidden_scope', message: NAMES_OTHER_ORG } });
    expect(named.calls).toHaveLength(0);
    // Unnamed, it acts for the workspace, where u1 cannot write (u1 writes in A
    // and B only): the floor refuses before ownership is asked. The workspace's
    // own ownership answer is witnessed at the seam (adr1022-ads-ownership-seam).
    const none = await runBudget('run-unstamped', { campaignId: 'pc-b' });
    expect(none.res).toMatchObject({ status: 'failure', error: { code: 'forbidden_scope', message: FLOOR_REFUSED } });
    expect(none.calls).toHaveLength(0);
  });

  it('a run acting for someone with no write access in the org is refused (ADR 0832 floor)', async () => {
    const { res, calls } = await runBudget('run-a', { campaignId: 'pc-a' }, 'u-outsider');
    expect(res).toMatchObject({ status: 'failure', error: { code: 'forbidden_scope', message: FLOOR_REFUSED } });
    expect(calls).toHaveLength(0);
  });

  it('with no ownership checker registered, a live change fails closed', async () => {
    const registered = getAdsCampaignOwnershipChecker();
    expect(registered).not.toBeNull(); // campaign-intel registered it at boot
    setAdsCampaignOwnershipChecker(null);
    try {
      const { res, calls } = await runBudget('run-a', { campaignId: 'pc-a' });
      expect(res).toMatchObject({ status: 'failure', error: { code: 'capability_not_provided' } });
      expect(calls).toHaveLength(0);
    } finally { setAdsCampaignOwnershipChecker(registered); }
  });
});
