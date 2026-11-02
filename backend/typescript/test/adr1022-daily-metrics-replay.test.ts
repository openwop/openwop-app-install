/**
 * ADR 1022 D6 — `campaign-sync.daily-metrics` through the real executor, then
 * a `mode:'replay'` fork. `feature.campaign-connectors.nodes.sync` claims the
 * 15-minute cooldown, reads the ad platform and writes performance rows, so it
 * is `role:"side-effect"` + `side-effectful`: a replay fork is SERVED the
 * recorded outcome. It reads nothing and leaves the live cooldown alone.
 *
 * Sabotage (run red, then reverted): declare the sync node `role:"action"`
 * (and regenerate the floor). The replay then re-executes the node, which finds
 * the cooldown the source run claimed and reports `cooldown` instead of the
 * recorded `synced`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { __putDispatchRecordForTests } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { getSyncStatus } from '../src/features/campaign-connectors/syncService.js';
import { answerCurrencyRead } from './adsCurrencyFixture.js';

let BASE: string;
let server: http.Server;
let meta: http.Server;
let insightReads = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-connectors', 'notifications']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await __resetConnectionsStore();
  meta = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (answerCurrencyRead(req.url ?? '', raw, res)) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      if ((req.url ?? '').includes('/insights')) {
        insightReads += 1;
        res.end(JSON.stringify({ data: [{ campaign_id: 'pc-r', campaign_name: 'Replayed', impressions: '100', clicks: '5', spend: '12.50', account_currency: 'USD', date_start: '2026-07-01' }] }));
        return;
      }
      res.end('{}');
    });
  });
  await new Promise<void>((r) => meta.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_META_API_BASE = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
  registerProvider({ id: 'meta-ads', label: 'Meta Ads', kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
});

afterAll(async () => {
  delete process.env.OPENWOP_META_API_BASE;
  await new Promise<void>((r) => meta.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

interface Body { runId?: string; orgId?: string; status?: string; user?: { userId: string }; events?: Array<{ type?: string; nodeId?: string; payload?: Record<string, unknown> }> }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
type Client = ReturnType<typeof client>;
async function settle(c: Client, runId: string): Promise<string> {
  let status = 'pending';
  for (let i = 0; i < 120; i++) {
    status = (await c.get(`/runs/${runId}`)).body.status ?? 'pending';
    if (status === 'completed' || status === 'failed' || status === 'cancelled') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return status;
}
async function syncOutputs(c: Client, runId: string): Promise<Record<string, unknown>> {
  const events = (await c.get(`/runs/${runId}/debug-bundle`)).body.events ?? [];
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_sync'));
  return (ev?.payload?.outputs as Record<string, unknown>) ?? {};
}

describe('ADR 1022 D6 — a replay fork of daily-metrics reads nothing and keeps the cooldown', () => {
  it('the source syncs; the replay is served its recorded outcome', async () => {
    const tenantId = `org:cp71-replay-${Date.now()}`;
    const owner = client();
    const userId = (await owner.post('/host/openwop-app/test/login', { email: `cp71r-${Date.now()}@acme.test`, tenantId })).body.user!.userId;
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId!;
    await createSecretConnection({ tenantId, provider: 'meta-ads', kind: 'bearer', secret: 'META', scope: 'user', userId });
    await __putDispatchRecordForTests({ tenantId, platform: 'meta', platformCampaignId: 'pc-r', platformAdSetId: 's', platformAdId: 'a', createdAt: '2026-07-01T00:00:00Z', campaignId: 'mc-r', orgId, campaignName: 'Replayed', adAccountId: 'act_7' });

    const found = getChain('campaign-sync.daily-metrics');
    expect(found, 'the chain must load at boot').toBeTruthy();
    const expanded = expandChain(found!.chain, { params: { orgId, platform: 'meta' } });
    registerWorkflow(expanded);

    const run = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: { orgId, platform: 'meta' } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const src = run.body.runId!;
    expect(await settle(owner, src)).toBe('completed');
    const recorded = await syncOutputs(owner, src);
    expect(recorded).toMatchObject({ outcome: 'synced', imported: 1, failures: [] });
    expect(insightReads).toBe(1);
    const claimedAt = (await getSyncStatus(tenantId, orgId))[0]?.lastSyncAt;
    expect(claimedAt).toEqual(expect.any(String));

    const replay = await owner.post(`/runs/${src}:fork`, { mode: 'replay', fromSeq: 0 });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(await settle(owner, replay.body.runId!)).toBe('completed');
    expect(await syncOutputs(owner, replay.body.runId!)).toEqual(recorded);
    expect(insightReads, 'the replay read nothing from the platform').toBe(1);
    expect((await getSyncStatus(tenantId, orgId))[0]?.lastSyncAt, 'the live cooldown is untouched').toBe(claimedAt);
  });
});
