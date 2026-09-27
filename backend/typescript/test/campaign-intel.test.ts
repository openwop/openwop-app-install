/**
 * Campaign Intelligence (ADR 0160) — pure budget optimizer + forecaster units,
 * the budget/forecast routes over the performance store, the nodes, and the
 * Campaign Intelligence Analyst agent.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { optimizeBudget, forecastCampaigns } from '../src/features/campaign-intel/intelligence.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-intel.nodes/index.mjs';
import type { CampaignPerformanceRecord } from '../src/features/campaign-connectors/types.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

function rec(o: Partial<CampaignPerformanceRecord>): CampaignPerformanceRecord {
  return { id: 'r', tenantId: 't', orgId: 'o', platform: 'google', campaignName: 'C', adSet: '', date: '2026-01-01', spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, ctr: 0, cpc: 0, cvr: 0, cpa: 0, roas: 0, source: 'csv', createdAt: 'now', ...o } as CampaignPerformanceRecord;
}

describe('intelligence — budget optimizer (pure)', () => {
  it('shifts budget from low-ROAS to high-ROAS platform', () => {
    const records = [
      rec({ platform: 'meta', spend: 1000, revenue: 1500 }),    // ROAS 1.5
      rec({ platform: 'google', spend: 1000, revenue: 4000 }),  // ROAS 4.0
    ];
    const r = optimizeBudget(records, { maxShiftPct: 0.2 });
    expect(r.reallocations).toHaveLength(2);
    const meta = r.reallocations.find((x) => x.platform === 'meta')!;
    const google = r.reallocations.find((x) => x.platform === 'google')!;
    expect(meta.changeAmount).toBeLessThan(0); // trimmed
    expect(google.changeAmount).toBeGreaterThan(0); // scaled
    expect(r.projectedRoasGain).toBeGreaterThan(0);
    // R2 CI-SP-3 — the structured note the FE localizes (the prose mirror no
    // longer mints a '$').
    expect(r.noteCode).toBe('shift');
    expect(r.noteParams).toMatchObject({ from: 'meta', to: 'google' });
    expect(r.noteParams!.shift).toBeGreaterThan(0);
    expect(r.note).not.toContain('$');
  });

  it('no reallocation when a single platform dominates', () => {
    const r = optimizeBudget([rec({ platform: 'google', spend: 1000, revenue: 4000 })]);
    expect(r.reallocations).toHaveLength(0);
    expect(r.noteCode).toBe('not_enough_platforms');
  });
});

describe('intelligence — forecaster (pure)', () => {
  it('detects creative fatigue when CTR declines in the second half', () => {
    const records = [
      rec({ date: '2026-01-01', impressions: 1000, clicks: 100 }), // CTR .10
      rec({ date: '2026-01-02', impressions: 1000, clicks: 90 }),  // .09
      rec({ date: '2026-01-03', impressions: 1000, clicks: 40 }),  // .04
      rec({ date: '2026-01-04', impressions: 1000, clicks: 30 }),  // .03
    ];
    const [f] = forecastCampaigns(records);
    expect(f.creativeFatigue.detected).toBe(true);
    expect(f.creativeFatigue.dropPercent).toBeGreaterThan(15);
    expect(f.projection.projectedSpend).toBeGreaterThanOrEqual(0);
  });

  it('R2 CI-SP-6: a multi-ad-set campaign projects per DAY, not per record', () => {
    // A record is one day of ONE AD-SET. Two ad-sets over four days = eight
    // records; dividing by record count halved the daily run-rate and
    // projected HALF of truth. Aggregate per date first.
    const records = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'].flatMap((date) => [
      rec({ date, adSet: 'a', spend: 60, conversions: 3, impressions: 1000, clicks: 50 }),
      rec({ date, adSet: 'b', spend: 40, conversions: 2, impressions: 1000, clicks: 50 }),
    ]);
    const [f] = forecastCampaigns(records, { horizonDays: 30 });
    // 100/day x 30 = 3000 (the per-record math said 50/day -> 1500).
    expect(f.projection.projectedSpend).toBe(3000);
    expect(f.projection.projectedConversions).toBe(150);
    // Flat CTR across halves - no fatigue false-positive from ad-set mixing.
    expect(f.creativeFatigue.detected).toBe(false);
  });
});

describe('campaign-intel — nodes + agent', () => {
  it('budget-optimize fails closed without the surface', async () => {
    await expect(nodePack['feature.campaign-intel.nodes.budget-optimize']({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('budget-optimize returns the recommendation; narrate adds an AI narrative', async () => {
    const features = { 'campaign-intel': { optimizeBudget: async () => ({ totalSpend: 2000, reallocations: [{ platform: 'meta' }], projectedRoasGain: 500, note: 'shift' }), forecast: async () => ({ forecasts: [] }) } };
    const plain = await nodePack['feature.campaign-intel.nodes.budget-optimize']({ features, inputs: { orgId: 'o1' } });
    expect((plain.outputs?.recommendation as Record<string, unknown>).totalSpend).toBe(2000);
    expect(plain.outputs?.narrative).toBeUndefined();
    const narrated = await nodePack['feature.campaign-intel.nodes.budget-optimize']({ features, callAI: async () => ({ content: 'Shift Meta to Google.' }), inputs: { orgId: 'o1', narrate: true } });
    expect(narrated.outputs?.narrative).toBe('Shift Meta to Google.');
  });

  it('plan-budget narrates from the host callAI `content` field (XCH-CI-1 regression)', async () => {
    // The node once read `ai.completion`, which the host never returns — the
    // narrative silently stayed empty. Pin the `.content` read.
    const features = { 'campaign-intel': { planBudget: async () => ({ plan: { totalBudgetMinor: 500000, channels: [] } }) } };
    const narrated = await nodePack['feature.campaign-intel.nodes.plan-budget']({ features, callAI: async () => ({ content: 'Half a million minor units across channels.' }), inputs: { orgId: 'o1', totalBudgetMinor: 500000, targetConversions: 100 } });
    expect(narrated.outputs?.narrative).toBe('Half a million minor units across channels.');
  });

  it('loads the Campaign Intelligence Analyst', () => {
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'feature.campaign-intel.agents'));
    expect(loaded[0].agentId).toBe('feature.campaign-intel.agents.intelligence-analyst');
    // CFP-1: the allowlist now points at REGISTERED chat tools (agentTools.ts),
    // not the surface-backed node typeIds that never resolved at dispatch. That
    // these ids are actually offerable is asserted in campaign-intel-agent-tools.test.ts.
    expect(loaded[0].toolAllowlist).toContain('openwop:campaign-intel.budget-optimize');
  });
});

let BASE: string; let server: http.Server; let n = 0;
describe('campaign-intel — routes', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    for (const id of ['campaign-intel', 'campaign-connectors']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('computes budget recommendations over imported performance', async () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: await res.json().catch(() => undefined) } as { status: number; body: any };
    };
    expect((await call('POST', '/v1/host/openwop-app/test/login', { email: `ci-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
    const org = await call('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId;
    const csv = 'Platform,Campaign,Day,Cost,Impr.,Clicks,Conversions,Revenue\nMeta,A,2026-01-01,1000,10000,100,10,1500\nGoogle,B,2026-01-01,1000,10000,100,40,4000';
    expect((await call('POST', '/v1/host/openwop-app/campaign-connectors/import', { orgId, csv })).status).toBe(201);
    const budget = await call('GET', `/v1/host/openwop-app/campaign-intel/budget?orgId=${orgId}`);
    expect(budget.status).toBe(200);
    expect(budget.body.reallocations.length).toBe(2);
    expect(budget.body.projectedRoasGain).toBeGreaterThan(0);
  });
});
