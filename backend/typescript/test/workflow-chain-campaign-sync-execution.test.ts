/**
 * campaign-sync workflow-chain pack — REAL execution (RFC 0013, ADR 0159/
 * 0220, campaign gap plan C2/C7).
 *
 * Unlike every other pack in this session's assignment, NEITHER chain in
 * this pack touches `core.ai.chatCompletion` or any other AI node —
 * `feature.campaign-connectors.nodes.sync` and
 * `feature.campaign-intel.nodes.pacing-check` are both pure `ctx.features`
 * reads/writes over real data. Both chains therefore run through the REAL
 * executor to a genuine `completed` state — no honest-failure mode needed,
 * no mini-scheduler needed.
 *
 * CHAINS CHOSEN: both of the pack's two chains, since each proves a
 * distinctly real, side-effectful outcome:
 *
 * 1. `campaign-sync.daily-metrics` — with NO campaign ever dispatched to
 *    the platform in this fresh org, `sync` reads the REAL (empty)
 *    `ctx.ads.listDispatches()` ledger and returns the honest, graceful
 *    `outcome: 'no_dispatches'` (never a crash, never a fabricated
 *    "synced" result) — the documented contract
 *    `campaign-sync.test.ts`'s `ADR 0215 — sync route` describe block
 *    already pins at the HTTP-route layer; this test pins the SAME
 *    contract at the chain/executor layer. `notify` then runs for real
 *    too and gracefully degrades (`sent: false, error:
 *    'notification_not_connected'`) since no Expo push connection is
 *    configured — the same graceful-degrade shape
 *    `workflow-chain-exec-ops-execution.test.ts` documents for
 *    `calendar`/`finance` connectors.
 *
 * 2. `campaign-sync.pacing-check` — seeds a REAL campaign (a Campaign
 *    Brief with a $100 budget, finalized into a MarketingCampaign via
 *    `POST .../campaign-orchestration/finalize`) and REAL performance data
 *    exceeding that budget (a CSV import of $150 spend via
 *    `POST .../campaign-connectors/import` — no fake ad-platform server
 *    needed; the CSV-import path is itself a first-class, real ingestion
 *    route). The chain's `pace` node reads BOTH the real campaign (via
 *    `campaign-orchestration.listCampaigns`) and the real performance
 *    store (via `campaign-connectors.listRecords`) and correctly computes
 *    `spentPct: 150`, `band: 'over'`, and raises a real alert — proving
 *    the cross-feature READ + the escalation-alert logic against genuine
 *    seeded data end to end, not a structural/expansion-only check.
 *
 * NO BUGS FOUND in this pack: `sync`'s inputs (`orgId`, `platform`) and
 * `pace`'s input (`orgId`) are wired via the node's DAG-level `inputs`
 * field with `{{params.*}}` templates — per the discovery documented in
 * the content-pack execution test, a node's static `inputs` field is
 * STRIPPED at `expandChain`/`validateWorkflowDefinition` time and never
 * reaches `ctx.inputs`. But both `sync` and `pace` are SOURCE nodes (no
 * incoming edge in either chain), so the real executor's
 * `buildNodeInputs` + the single-key "Back-compat" unwrap
 * (`executor/executor.ts`) hands them `ctx.inputs` = the run's raw
 * top-level `inputs` payload directly — and since the chain's declared
 * parameter names (`orgId`, `platform`) are EXACTLY the keys these two
 * node implementations read (`packs/feature.campaign-connectors.nodes` /
 * `packs/feature.campaign-intel.nodes`, `const i = ctx.inputs ?? {}`),
 * the values arrive correctly by construction — no fix needed (this is
 * the SAME lucky-naming-match that makes `commerce.post-purchase-
 * thankyou`'s `order` node and `exec-ops`'s `pipeline`/`tasks` nodes work,
 * and the SAME class of defect `research.web-brief`'s `search` node had
 * when its param was misnamed `question` instead of `query` — see that
 * pack's execution test).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { setKernel } from '../src/features/campaign-brief/briefService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'campaign-brief', 'campaign-orchestration', 'campaign-connectors', 'campaign-intel']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:campsyncchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `campsyncchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

interface RunSnapshot { status: string; error?: { code: string; message: string } }
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < 80; i++) {
    const r = await owner.get(`/v1/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body as RunSnapshot;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled' || snap.status.startsWith('waiting')) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return snap;
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }
async function bundleEvents(owner: Client, runId: string): Promise<BundleEvent[]> {
  const b = await owner.get(`/v1/runs/${runId}/debug-bundle`);
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  return (b.body.events as BundleEvent[]) ?? [];
}
function completedOutputs(events: BundleEvent[], nodeSuffix: string): Record<string, unknown> {
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith(`_${nodeSuffix}`));
  expect(ev, `expected a node.completed event for node "${nodeSuffix}": ${JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBeTruthy();
  return (ev!.payload!.outputs as Record<string, unknown>) ?? {};
}

describe('campaign-sync.daily-metrics — real executor, honest empty-ledger outcome', () => {
  it('reads the real (empty) dispatch ledger and completes with outcome:no_dispatches, then gracefully degrades the push', async () => {
    const { owner, orgId } = await ownerOrg();

    const found = getChain('campaign-sync.daily-metrics');
    expect(found, 'campaign-sync.daily-metrics chain must be loaded at boot').toBeTruthy();
    const params = { orgId, platform: 'meta' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status, `run did not complete cleanly: ${JSON.stringify(snap)}`).toBe('completed');

    const events = await bundleEvents(owner, runId);
    const syncOutputs = completedOutputs(events, 'sync');
    expect(syncOutputs).toMatchObject({ outcome: 'no_dispatches' });

    const notifyOutputs = completedOutputs(events, 'notify');
    // Was `{ sent:false, provider:'expo', error:'notification_not_connected' }` —
    // a push that never went anywhere, under a green run. The in-app node delivers.
    expect(notifyOutputs).toMatchObject({ emitted: true, audience: 'tenant' });
  });
});

describe('campaign-sync.pacing-check — real executor, real over-budget alert', () => {
  it('reads the REAL seeded campaign + performance rows and alerts band:over', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();

    // Real campaign with a $100 budget.
    const brief = await owner.post('/v1/host/openwop-app/campaign-brief/briefs', {
      orgId, name: 'Summer Sale', budget: { totalMinor: 10000, currency: 'USD' },
    });
    expect(brief.status, JSON.stringify(brief.body)).toBe(201);
    const briefId = brief.body.brief.id as string;
    // ORCH-1: finalize requires an approved messaging kernel.
    await setKernel(tenantId, briefId, {
      headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
      tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
    });
    const finalize = await owner.post('/v1/host/openwop-app/campaign-orchestration/finalize', { briefId });
    expect(finalize.status, JSON.stringify(finalize.body)).toBe(201);
    const campaignId = finalize.body.campaign.id as string;
    const campaignName = finalize.body.campaign.name as string;

    // Real performance data — $150 spend against the $100 plan (over budget).
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const csv = `date,campaign,spend,impressions,clicks,conversions,revenue\n${yesterday},${campaignName},150,1000,50,5,300`;
    const imp = await owner.post('/v1/host/openwop-app/campaign-connectors/import', { orgId, csv, campaignId });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body.imported).toBe(1);

    const found = getChain('campaign-sync.pacing-check');
    expect(found, 'campaign-sync.pacing-check chain must be loaded at boot').toBeTruthy();
    const params = { orgId };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/v1/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status, `run did not complete cleanly: ${JSON.stringify(snap)}`).toBe('completed');

    const events = await bundleEvents(owner, runId);
    const paceOutputs = completedOutputs(events, 'pace');
    const alerted = paceOutputs.alerted as Array<{ campaignId: string; band: string }>;
    expect(alerted).toEqual([{ campaignId, band: 'over' }]);

    const rows = (paceOutputs.report as { rows: Array<{ campaignId: string; spend: number; budget: number; spentPct: number; band: string }> }).rows;
    const row = rows.find((r) => r.campaignId === campaignId);
    expect(row, JSON.stringify(rows)).toMatchObject({ spend: 150, budget: 100, spentPct: 150, band: 'over' });
  });
});
