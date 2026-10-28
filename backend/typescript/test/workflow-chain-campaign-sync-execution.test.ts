/**
 * campaign-sync workflow-chain pack — REAL execution (RFC 0013, ADR 0159/0220,
 * campaign gap plan C2/C7).
 *
 * Neither chain uses an AI node: `feature.campaign-connectors.nodes.sync` and
 * `feature.campaign-intel.nodes.pacing-check` are `ctx.features` / `ctx.ads`
 * reads and writes over real data, so both run through the REAL executor to a
 * genuine `completed`.
 *
 * 1. `campaign-sync.daily-metrics` — a fresh org has no dispatched campaign, so
 *    `sync` reads the REAL (empty) `ctx.ads.listDispatches()` ledger and returns
 *    the honest `outcome: 'no_dispatches'` (the HTTP-route twin is pinned in
 *    `campaign-sync.test.ts`). `notify` (the in-app notifications node) then
 *    delivers to the tenant: `emitted: true, audience: 'tenant'`. Its `title`
 *    rides the node's declared `inputs`, which reach `ctx.inputs` through ADR
 *    0237 / CHAINX-5 (an earlier header said declared inputs were stripped and
 *    that `notify` degraded to `sent:false` — both stale, corrected w31).
 * 2. `campaign-sync.pacing-check` — seeds a REAL campaign (a $100-budget brief
 *    finalized via `POST …/campaign-orchestration/finalize`) and REAL spend ($150
 *    via the CSV import route). `pace` reads both and reports `spentPct: 150`,
 *    `band: 'over'`, and alerts once for that campaign.
 *
 * Sabotage: a non-empty dispatch ledger reds case 1's `no_dispatches`; refusing
 * the notify title reds `emitted:true`; moving the `over` threshold above 150 %
 * or failing the campaignId match in `buildPacing` reds case 2.
 * The 25 ms × 80 run-settle poll is an honest ceiling (no settle hook).
 *
 * Product note (grade-code, w31): the chain `sync` node re-implements
 * `runMetricsSync`, so the chain path has no cooldown claim, campaign link or
 * CONN-1 platform date — this file pins only the no_dispatches contract.
 * CORRECTED (ADR 0907 P1): no longer true. The node now asks the surface for
 * the plan (`planSync`) and hands the rows back (`recordAccountRows`), the same
 * two functions `runMetricsSync` uses, and it claims the cooldown. The
 * conversions-dispatch chain (P4) is pinned in `ads-conversion-delivery.test.ts`.
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
  for (const id of ['users', 'campaign-brief', 'campaign-orchestration', 'campaign-connectors', 'campaign-intel', 'commerce']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The union of response-body fields this file reads (each route returns a subset). */
interface Body {
  runId?: string; orgId?: string; status?: string; imported?: number;
  brief?: { id: string };
  campaign?: { id: string; name: string };
  events?: BundleEvent[];
  error?: { code: string; message: string };
}
interface Res { status: number; body: Body }
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
    const out = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body;
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:campsyncchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/host/openwop-app/test/login', { email: `campsyncchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId as string, tenantId };
}

interface RunSnapshot { status: string; error?: { code: string; message: string } }
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < 80; i++) {
    const r = await owner.get(`/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body as RunSnapshot;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled' || snap.status.startsWith('waiting')) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return snap;
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }
async function bundleEvents(owner: Client, runId: string): Promise<BundleEvent[]> {
  const b = await owner.get(`/runs/${runId}/debug-bundle`);
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

    const create = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
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
    const brief = await owner.post('/host/openwop-app/campaign-brief/briefs', {
      orgId, name: 'Summer Sale', budget: { totalMinor: 10000, currency: 'USD' },
    });
    expect(brief.status, JSON.stringify(brief.body)).toBe(201);
    const briefId = brief.body.brief?.id as string;
    // ORCH-1: finalize requires an approved messaging kernel.
    await setKernel(tenantId, briefId, {
      headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
      tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
    });
    const finalize = await owner.post('/host/openwop-app/campaign-orchestration/finalize', { briefId });
    expect(finalize.status, JSON.stringify(finalize.body)).toBe(201);
    const campaignId = finalize.body.campaign?.id as string;
    const campaignName = finalize.body.campaign?.name as string;

    // Real performance data — $150 spend against the $100 plan (over budget).
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const csv = `date,campaign,spend,impressions,clicks,conversions,revenue\n${yesterday},${campaignName},150,1000,50,5,300`;
    const imp = await owner.post('/host/openwop-app/campaign-connectors/import', { orgId, csv, campaignId });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body.imported).toBe(1);

    // ADR 0952 P1 — a campaign-scoped spend cap, so the chain's enforce-caps root
    // runs as the run owner through the real executor (no dispatch ⇒ $0 spent).
    const cap = await owner.post('/host/openwop-app/campaign-intel/caps', { orgId, scope: { kind: 'campaign', campaignId }, limitMinor: 50_000, currency: 'USD' });
    expect(cap.status, JSON.stringify(cap.body)).toBe(201);

    const found = getChain('campaign-sync.pacing-check');
    expect(found, 'campaign-sync.pacing-check chain must be loaded at boot').toBeTruthy();
    const params = { orgId };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
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

    // The caps root ran as the owner and evaluated the cap; `pace` stays the primary output.
    const capsOutputs = completedOutputs(events, 'caps');
    expect(capsOutputs).toMatchObject({ outcome: 'enforced', caps: [{ capId: (cap.body as { capId?: string }).capId, status: 'ok', spentMinor: 0, transitioned: false }] });
    const primary = expanded.nodes.filter((n) => n.outputRole === 'primary').map((n) => n.nodeId);
    expect(primary).toHaveLength(1);
    expect(primary[0]).toMatch(/_pace$/);
  });
});

describe('campaign-intel.reallocate — real loader + executor (ADR 0952 P3)', () => {
  it('runs optimize → propose → apply as the owner; with nothing to move it ends no_change / no_plan and opens no approval', async () => {
    const { owner, orgId } = await ownerOrg();
    const found = getChain('campaign-intel.reallocate');
    expect(found, 'campaign-intel.reallocate chain must be loaded at boot').toBeTruthy();
    const params = { orgId };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    // The apply step is the chain's one primary output.
    const primary = expanded.nodes.filter((nd) => nd.outputRole === 'primary').map((nd) => nd.nodeId);
    expect(primary).toHaveLength(1);
    expect(primary[0]).toMatch(/_apply$/);

    const create = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const snap = await pollRun(owner, create.body.runId as string);
    expect(snap.status, `run did not complete cleanly: ${JSON.stringify(snap)}`).toBe('completed');
    const events = await bundleEvents(owner, create.body.runId as string);
    // The edge delivered budget-optimize's recommendation; propose did not recompute it.
    expect(completedOutputs(events, 'propose')).toMatchObject({ outcome: 'no_change', dropped: [], recommendationSource: 'upstream' });
    expect(completedOutputs(events, 'apply')).toEqual({ outcome: 'no_plan' });
    const plans = await owner.get(`/host/openwop-app/campaign-intel/reallocations?orgId=${encodeURIComponent(orgId)}`);
    expect(plans.status).toBe(200);
    expect((plans.body as { plans?: unknown[] }).plans).toEqual([]);
  });
});

describe('campaign-sync.catalog-feed — real loader + executor (ADR 0952 P7)', () => {
  it('feed off ⇒ completes with outcome:disabled; feed on but the push unverified ⇒ a typed failure, never success', async () => {
    const { owner, orgId } = await ownerOrg();
    const found = getChain('campaign-sync.catalog-feed');
    expect(found, 'campaign-sync.catalog-feed chain must be loaded at boot').toBeTruthy();
    const params = { orgId, platform: 'meta' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    // Deterministic expansion: the same params give the same workflow id.
    expect(expandChain(found!.chain, { params }).workflowId).toBe(expanded.workflowId);

    const off = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    expect((await pollRun(owner, off.body.runId as string)).status).toBe('completed');
    expect(completedOutputs(await bundleEvents(owner, off.body.runId as string), 'push')).toEqual({ outcome: 'disabled' });

    // Enable through the service (ads-catalog-feed.test.ts covers the PUT route), then push.
    const { saveFeedSettings } = await import('../src/features/campaign-connectors/catalogFeed.js');
    const { getOrg } = await import('../src/host/accessControlService.js');
    const org = await getOrg(orgId);
    if (!org) throw new Error('org missing');
    await saveFeedSettings(org.tenantId, orgId, { enabled: true, metaCatalogId: '777' });

    // No public origin configured: a scheduled push cannot build item links, so it fails typed.
    const noBase = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
    const noBaseSnap = await pollRun(owner, noBase.body.runId as string);
    expect(noBaseSnap.status).toBe('failed');
    expect(noBaseSnap.error?.code ?? '').toMatch(/not_configured$/);

    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://shop.example';
    delete process.env.OPENWOP_ADS_VERIFIED_CATALOG_PUSH;
    const unverified = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
    const snap = await pollRun(owner, unverified.body.runId as string);
    expect(snap.status).toBe('failed');
    expect(snap.error?.code ?? '').toMatch(/connector_not_configured$/);
    delete process.env.OPENWOP_PUBLIC_BASE_URL;
  });
});
