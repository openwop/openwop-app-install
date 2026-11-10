/**
 * ADR 1022 follow-up (ad-metrics read) — a campaign's metrics are read only for a
 * campaign the acting org owns.
 *
 * #5491 put campaign ownership in the ad adapter's two WRITE doors. The read door,
 * `getMetrics`, still took a caller-chosen `(platform, adAccountId, campaignId)`:
 * through the core `ad-metrics` node, or a pack calling `ctx.ads.getMetrics`, a
 * run for client A could read client B's spend, clicks and CPC over a shared agency
 * token. `getMetrics` now asks the same predicate first (`adsOwnershipRefusal`;
 * the org from the run's client stamp, else `deps.orgId`, never node config), and
 * the node maps the refusal to the typed failure `ad_campaign_not_in_org`: a
 * typed refusal, never `metrics: null`, which would read as "no data".
 *
 * Booted through `createApp` (the real predicate), against a mock Google Ads API
 * and real dispatch-ledger rows for two orgs in one tenant on one ad account.
 *
 * Witnessed red on main (2026-11-04): the cross-org cases returned client B's
 * metrics. Sabotage, each alone then reverted:
 * - skip the `getMetrics` ownership refusal → 3 red (the node's cross-org and
 *   missing cases, and the pack's direct call);
 * - map the refusal to the generic `ad_metrics_failed` in the node → 2 red (the
 *   node's cross-org and missing cases).
 * Re-measured in /grade-tests wave 98 (each alone, then reverted):
 * - call the platform before returning the refusal → the 3 refusal cases red on
 *   `platformCalls` (the "never asked" half is its own claim);
 * - take `deps.orgId` (the executor sets it to the tenant) over the run's client
 *   stamp → the positive control red (the stamp is what names client A);
 * - make every ledger row belong to the asking org (`dispatchBelongsToOrg`) → the
 *   node's and the pack's cross-org cases red.
 * The app boot gets the repo's 120 s hook bound: under a loaded gate the default
 * 30 s timed out and SKIPPED all four cases (w98 read that as a vacuous probe).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { __putDispatchRecordForTests } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { stampCampaignRun } from '../src/features/campaign-orchestration/campaignRunTag.js';
import type { NodeContext, WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

type MetricsRead = Awaited<ReturnType<NonNullable<NonNullable<NodeContext['ads']>['getMetrics']>>>;

const T = 'adr1022-metrics';
const ACCOUNT = '1234567890';
const PACK_NODE = 'test.pack.ads-metrics-read';
let storage: Storage;
let api: http.Server;
let platformCalls = 0;
let stampA: unknown;
let n = 0;
let packResult: MetricsRead | null = null;
const TOGGLES = ['campaign-connectors', 'campaign-orchestration'] as const;

async function run(node: { typeId: string; config: Record<string, unknown> }): Promise<{ status: string; error?: RunRecord['error'] }> {
  const workflowId = `wf.adr1022-metrics.${n++}`;
  const def: WorkflowDefinition = { workflowId, nodes: [{ nodeId: 'm', ...node }], edges: [] };
  registerHostWorkflow(def);
  const now = new Date().toISOString();
  const rec: RunRecord = { runId: `r-m-${n}-${Math.random().toString(36).slice(2, 8)}`, workflowId, tenantId: T, status: 'pending', inputs: {}, metadata: { actingUserId: 'u1', campaignOrchestration: stampA }, configurable: {}, createdAt: now, updatedAt: now };
  await insertRunWithStartContext(storage, rec, { admission: { plan: 'exempt:test-fixture' } });
  const status = (await executeRun(storage, (await storage.getRun(rec.runId)) ?? rec, def)).status;
  const row = await storage.getRun(rec.runId);
  return { status, ...(row?.error ? { error: row.error } : {}) };
}
const metricsNode = (campaignId: string) => ({ typeId: 'core.openwop.connectors.ad-metrics', config: { platform: 'google', adAccountId: ACCOUNT, campaignId } });

beforeAll(async () => {
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await __resetConnectionsStore();
  ensureNodesRegistered();
  for (const id of TOGGLES) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  api = http.createServer((req, res) => {
    platformCalls++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ metrics: { impressions: '900', clicks: '30', costMicros: '12000000', ctr: '3.3', averageCpc: '400000' } }] }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_GOOGLE_ADS_API_BASE = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  await createSecretConnection({ tenantId: T, provider: 'google-ads', kind: 'bearer', secret: 'AGENCY-TOKEN', scope: 'workspace' });
  const orgA = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  const orgB = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client B', ownerSubject: 'u-owner' })).orgId;
  const campaignA = (await ensureDraftCampaign(T, await createBrief(T, orgA, 'u-owner', { name: 'A', channels: [{ type: 'email_sequence', enabled: true, config: {} }] }), 'u-owner')).campaign;
  const campaignB = (await ensureDraftCampaign(T, await createBrief(T, orgB, 'u-owner', { name: 'B', channels: [{ type: 'email_sequence', enabled: true, config: {} }] }), 'u-owner')).campaign;
  const at = new Date().toISOString();
  await __putDispatchRecordForTests({ tenantId: T, platform: 'google', platformCampaignId: '101', platformAdSetId: 'as-a', platformAdId: 'ad-a', adAccountId: ACCOUNT, createdAt: at, campaignId: campaignA.id, orgId: orgA });
  await __putDispatchRecordForTests({ tenantId: T, platform: 'google', platformCampaignId: '202', platformAdSetId: 'as-b', platformAdId: 'ad-b', adAccountId: ACCOUNT, createdAt: at, campaignId: campaignB.id, orgId: orgB });
  stampA = stampCampaignRun(campaignA, { role: 'optimizer' });
  getNodeRegistry().register({
    typeId: PACK_NODE, version: '1.0.0',
    async execute(ctx: NodeContext) {
      const campaignId = typeof ctx.config?.campaignId === 'string' ? ctx.config.campaignId : '';
      packResult = ctx.ads?.getMetrics ? await ctx.ads.getMetrics({ platform: 'google', adAccountId: ACCOUNT, campaignId }) : null;
      return { status: 'success', outputs: {} };
    },
  });
}, 120_000);
afterAll(async () => {
  for (const id of TOGGLES) {
    const d = getToggleDefault(id);
    if (d) await saveConfig(d, 'test');
  }
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.OPENWOP_GOOGLE_ADS_API_BASE;
  delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
  await new Promise<void>((r) => api.close(() => r()));
});
beforeEach(() => { platformCalls = 0; });

describe('ADR 1022 follow-up — the ad-metrics read meets the ownership seam', () => {
  it('positive control: client A\'s run reads client A\'s campaign', async () => {
    expect(await run(metricsNode('101'))).toMatchObject({ status: 'completed' });
    expect(platformCalls).toBe(1);
  });

  it('the core node: another org\'s campaign is a typed refusal, and the platform is never asked', async () => {
    expect(await run(metricsNode('202'))).toMatchObject({ status: 'failed', error: { code: 'ad_campaign_not_in_org' } });
    expect(platformCalls).toBe(0);
  });

  it('a campaign no org owns gets the same answer', async () => {
    expect(await run(metricsNode('303'))).toMatchObject({ status: 'failed', error: { code: 'ad_campaign_not_in_org' } });
    expect(platformCalls).toBe(0);
  });

  it('a pack calling ctx.ads.getMetrics directly is refused the same way', async () => {
    packResult = null;
    await run({ typeId: PACK_NODE, config: { campaignId: '202' } });
    expect(packResult).toEqual({ outcome: 'failed', error: 'ad_campaign_not_in_org' });
    expect(platformCalls).toBe(0);
  });
});
