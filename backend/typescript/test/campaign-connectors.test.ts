/**
 * Campaign Connectors (ADR 0159) — pure CSV import/validate units (R2 CC-SP-7/8/9),
 * the service dedup + KPI projection (R2 CC-SP-2/7), the import route + KPI over
 * HTTP, and the sync node (ADR 0215 C2 live path, SYNC-1 atomic cooldown claim).
 *
 * Sabotage that turns it red: break quoted-field parsing; skip the future-date /
 * negative / clicks>impressions checks; mis-read decimal-comma locales or zero a garbage
 * metric; stop swapping an over-12 DD/MM date; keep a non-ISO currency; drop the
 * natural-key dedup; claim a known currency with no evidence; import under a tenant
 * other than the caller's; live-sync a CSV-only platform; skip a planned account; claim the cooldown
 * before planning; read the platform after a lost cooldown claim.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { parseCsv, autodetectMapping, mapAndValidate, computeDerived } from '../src/features/campaign-connectors/csvImport.js';
import { importCsv, kpiSummary, __clearPerformance } from '../src/features/campaign-connectors/performanceService.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-connectors.nodes/index.mjs';

describe('csvImport — pure parse + validate + compute', () => {
  it('parses quoted CSV and autodetects the mapping', () => {
    const csv = 'Campaign,Day,Cost,Impr.,Clicks,Conversions\n"Q4, Launch",2026-01-05,100,1000,50,5';
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(['Campaign', 'Day', 'Cost', 'Impr.', 'Clicks', 'Conversions']);
    expect(rows[0][0]).toBe('Q4, Launch'); // comma inside quotes preserved
    const mapping = autodetectMapping(headers);
    expect(mapping.campaignName).toBe('Campaign');
    expect(mapping.spend).toBe('Cost');
    expect(mapping.impressions).toBe('Impr.');
  });

  it('computes derived metrics safely', () => {
    expect(computeDerived({ spend: 100, impressions: 1000, clicks: 50, conversions: 5, revenue: 400 })).toEqual({ ctr: 0.05, cpc: 2, cvr: 0.1, cpa: 20, roas: 4 });
    expect(computeDerived({ spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 }).roas).toBe(0); // no div-by-zero
  });

  it('validates: future date + negatives rejected, clicks>impressions warned', () => {
    const headers = ['Day', 'Cost', 'Impr.', 'Clicks'];
    const rows = [['2999-01-01', '10', '100', '5'], ['2026-01-01', '-5', '100', '5'], ['2026-01-01', '10', '50', '80']];
    const { records, issues } = mapAndValidate(headers, rows, autodetectMapping(headers), 'google', '2026-06-27');
    expect(records).toHaveLength(1); // only row 3 valid (rows 1+2 are errors)
    expect(records[0]).toMatchObject({ date: '2026-01-01', clicks: 80, impressions: 50 });
    // Each issue is attributed to ITS row (1-based + header).
    expect(issues).toEqual([
      { row: 2, severity: 'error', message: 'Date is in the future.' },
      { row: 3, severity: 'error', message: 'Negative metric value.' },
      { row: 4, severity: 'warning', message: 'Clicks exceed impressions.' },
    ]);
  });

  it('R2 CC-SP-8: garbage metrics are ISSUE rows, and decimal-comma locales parse correctly', () => {
    const headers = ['Day', 'Cost', 'Impr.', 'Clicks'];
    const rows = [
      ['2026-01-01', 'abc', '100', '5'],        // garbage -> issue, never a silent 0
      ['2026-01-02', '1.234,56', '100', '5'],   // EU thousands+decimal: 1234.56
      ['2026-01-03', '1,234.56', '100', '5'],   // US thousands+decimal: 1234.56
      ['2026-01-04', '12,5', '100', '5'],       // lone decimal comma: 12.5
      ['2026-01-05', '1,234', '100', '5'],      // lone grouping comma: 1234
    ];
    const { records, issues } = mapAndValidate(headers, rows, autodetectMapping(headers), 'google', '2026-06-27');
    expect(issues.filter((i) => i.severity === 'error')).toEqual([{ row: 2, severity: 'error', message: 'Unparseable spend value.' }]);
    expect(records).toHaveLength(4);
    // The old parser stripped the comma AFTER the dot survived: "1.234,56" -> 1.234
    // — a ~1000x silent understatement of spend.
    expect(records.map((r) => r.spend)).toEqual([1234.56, 1234.56, 12.5, 1234]);
  });

  it('R2 CC-SP-9: DD/MM over-12 dates auto-swap with a disclosure; ambiguous MM/DD assumption disclosed ONCE', () => {
    const headers = ['Day', 'Cost'];
    const rows = [
      ['25/12/2025', '10'], // unambiguously DD/MM -> 2025-12-25 (old code: "Date is in the future")
      ['03/04/2026', '10'], // ambiguous -> MM/DD assumed (2026-03-04), flagged
      ['04/03/2026', '10'], // ambiguous too
    ];
    const { records, issues } = mapAndValidate(headers, rows, autodetectMapping(headers), 'google', '2026-06-27');
    expect(records).toHaveLength(3);
    expect(records[0]!.date).toBe('2025-12-25');
    expect(records[1]!.date).toBe('2026-03-04');
    expect(records[2]!.date).toBe('2026-04-03');
    expect(issues.filter((i) => /MM\/DD/.test(i.message))).toHaveLength(1); // one summary, not per row
    expect(issues.some((i) => /first component over 12/.test(i.message))).toBe(true);
  });

  it('R2 CC-SP-7: an ISO currency column is captured; junk is dropped, never guessed', () => {
    const headers = ['Day', 'Cost', 'Currency'];
    const rows = [['2026-01-01', '10', 'eur'], ['2026-01-02', '10', 'DOLLARS'], ['2026-01-03', '10', '']];
    const { records } = mapAndValidate(headers, rows, autodetectMapping(headers), 'google', '2026-06-27');
    expect(records[0]!.currency).toBe('EUR');
    expect(records[1]!.currency).toBeUndefined();
    expect(records[2]!.currency).toBeUndefined();
  });
});

describe('performanceService — dedup + KPI', () => {
  beforeEach(async () => { initHostExtPersistence(openSqliteStorage(':memory:')); await __clearPerformance(); });

  it('dedups by platform|campaign|adSet|date on re-import (no double-count)', async () => {
    const csv = 'Platform,Campaign,Ad Set,Day,Cost,Impr.,Clicks,Conversions,Revenue\nGoogle,Q4,Set A,2026-01-05,100,1000,50,5,400';
    const r1 = await importCsv('t1', 'o1', csv);
    expect(r1.imported).toBe(1);
    const r2 = await importCsv('t1', 'o1', csv); // same rows again
    expect(r2.imported).toBe(0);
    expect(r2.deduped).toBe(1);
    const kpi = await kpiSummary('t1', 'o1');
    expect(kpi.recordCount).toBe(1); // not 2
    expect(kpi.totals.spend).toBe(100);
    expect(kpi.totals.roas).toBe(4);
    expect(kpi.byPlatform[0].platform).toBe('google');
  });

  it('R2 CC-SP-2/7: record currencies drive the KPI currency; NO evidence anywhere = currencyKnown false', async () => {
    // Currency evidence from the RECORDS' own captured field.
    const withCur = 'Platform,Campaign,Ad Set,Day,Cost,Currency\nGoogle,Q4,Set A,2026-01-05,100,EUR';
    await importCsv('t2', 'o2', withCur);
    const kpiEur = await kpiSummary('t2', 'o2');
    expect(kpiEur.currency).toBe('EUR');
    expect(kpiEur.currencyKnown).toBe(true);
    expect(kpiEur.currencyMixed).not.toBe(true);

    // Records but zero currency evidence: the old code returned USD/not-mixed —
    // an unknown labelled `$` with confidence.
    const noCur = 'Platform,Campaign,Ad Set,Day,Cost\nGoogle,Q4,Set A,2026-01-05,100';
    await importCsv('t3', 'o3', noCur);
    const kpiUnknown = await kpiSummary('t3', 'o3');
    expect(kpiUnknown.currencyKnown).toBe(false);
  });
});

let BASE: string; let server: http.Server; let n = 0;
describe('campaign-connectors — routes + sync node', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    const d = getToggleDefault('campaign-connectors'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  function client() {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
      const parsed: unknown = await res.json().catch(() => undefined);
      return { status: res.status, body: parsed };
    };
    return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
  }

  it('imports a CSV and projects KPI over HTTP', async () => {
    const c = client();
    expect((await c.post('/host/openwop-app/test/login', { email: `cc-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
    const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
    const orgBody = org.body;
    if (typeof orgBody !== 'object' || orgBody === null || !('orgId' in orgBody) || typeof orgBody.orgId !== 'string') throw new Error(`org create failed: ${JSON.stringify(org)}`);
    const orgId = orgBody.orgId;
    const csv = 'Platform,Campaign,Day,Cost,Impr.,Clicks,Conversions,Revenue\nMeta,Promo,2026-02-01,200,4000,100,10,1000';
    const imp = await c.post('/host/openwop-app/campaign-connectors/import', { orgId, csv });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body).toMatchObject({ imported: 1, deduped: 0, invalid: 0 });
    const kpi = await c.get(`/host/openwop-app/campaign-connectors/kpi?orgId=${orgId}`);
    expect(kpi.status).toBe(200);
    expect(kpi.body).toMatchObject({ recordCount: 1, totals: { spend: 200, revenue: 1000 }, byPlatform: [{ platform: 'meta', spend: 200 }] });
  });

  // ADR 0215 (C2) → ADR 0907 D3: the sync node asks the feature surface for a
  // plan, reads each planned account through ctx.ads.getAccountMetrics, and
  // hands the rows back to recordAccountRows. CSV-only platforms stay
  // structured-honest; without ctx.ads the node fails host_capability_missing.
  const PLAN = { platform: 'google', scope: 'dispatched', since: '2026-07-08', until: '2026-07-14', adAccountIds: ['123', '456'], ledger: [{ platformCampaignId: 'pc-1', campaignName: 'Promo' }] };
  it('sync node: plans, reads every planned account, records the rows; connector_not_configured for the rest', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const features = { 'campaign-connectors': {
      importCsv: async () => ({}), claimSync: async () => ({ blocked: false }),
      planSync: async () => ({ outcome: 'plan', plan: PLAN }),
      recordAccountRows: async (a: Record<string, unknown>) => { recorded.push(a); return { imported: 1, deduped: 0, campaigns: 1 }; },
    } };
    const off = await nodePack['feature.campaign-connectors.nodes.sync']({ features, inputs: { orgId: 'o1', platform: 'pinterest' } });
    expect(off.status).toBe('failed');
    expect(off.error?.code).toBe('connector_not_configured');
    // ADR 0907 D2 — a reader the host has not verified maps to the same typed refusal.
    const unverifiedFeatures = { 'campaign-connectors': { ...features['campaign-connectors'], planSync: async () => ({ outcome: 'not_verified', platform: 'linkedin' }) } };
    const unverified = await nodePack['feature.campaign-connectors.nodes.sync']({ features: unverifiedFeatures, ads: { getAccountMetrics: async () => ({ outcome: 'ok', rows: [] }) }, inputs: { orgId: 'o1', platform: 'linkedin' } });
    expect(unverified.status).toBe('failed');
    expect(unverified.error?.code).toBe('connector_not_configured');
    expect(unverified.error?.message).toMatch(/not been verified/);
    const noCtx = await nodePack['feature.campaign-connectors.nodes.sync']({ features, inputs: { orgId: 'o1', platform: 'google' } });
    expect(noCtx.status).toBe('failed');
    expect(noCtx.error?.code).toBe('host_capability_missing');

    const asked: Array<Record<string, unknown>> = [];
    const row = { date: '2026-07-14', campaignId: 'pc-1', campaignName: 'Promo', impressions: 10, clicks: 2, spend: 3, conversions: 1, revenue: 9 };
    const ads = {
      getAccountMetrics: async (a: Record<string, unknown>) => {
        asked.push(a);
        return a.adAccountId === '456' ? { outcome: 'rate_limited', retryAfterS: 30 } : { outcome: 'ok', platform: 'google', rows: [row], pages: 1, truncated: false };
      },
    };
    const ok = await nodePack['feature.campaign-connectors.nodes.sync']({ features, ads, inputs: { orgId: 'o1', platform: 'google' } });
    expect(ok.status, JSON.stringify(ok)).toBe('success');
    expect(ok.outputs).toMatchObject({ outcome: 'synced', platform: 'google', scope: 'dispatched', since: '2026-07-08', until: '2026-07-14', campaigns: 1, imported: 1, truncated: false,
      failures: [{ adAccountId: '456', reason: 'rate_limited', retryAfterS: 30 }] });
    expect(asked).toEqual([
      { platform: 'google', adAccountId: '123', level: 'campaign', since: '2026-07-08', until: '2026-07-14' },
      { platform: 'google', adAccountId: '456', level: 'campaign', since: '2026-07-08', until: '2026-07-14' },
    ]);
    expect(recorded).toEqual([{ orgId: 'o1', plan: PLAN, rows: [row] }]);
  });

  // CC-SP-14 + SYNC-1: plan first (a probe never claims), then a lost atomic
  // claim short-circuits to cooldown before any platform read.
  it('sync node: no_dispatches never claims; a blocked claim returns cooldown and never reads', async () => {
    const asked: unknown[] = [];
    let claims = 0;
    const ads = { getAccountMetrics: async (a: unknown) => { asked.push(a); return { outcome: 'ok', rows: [] }; } };
    const empty = { 'campaign-connectors': { importCsv: async () => ({}), claimSync: async () => { claims++; return { blocked: false }; }, planSync: async () => ({ outcome: 'no_dispatches' }), recordAccountRows: async () => ({}) } };
    expect((await nodePack['feature.campaign-connectors.nodes.sync']({ features: empty, ads, inputs: { orgId: 'o1', platform: 'google' } })).outputs).toEqual({ outcome: 'no_dispatches' });
    expect(claims).toBe(0);
    const blocked = { 'campaign-connectors': { importCsv: async () => ({}), claimSync: async () => ({ blocked: true, retryAtIso: '2026-07-02T00:00:00Z' }), planSync: async () => ({ outcome: 'plan', plan: PLAN }), recordAccountRows: async () => ({}) } };
    const out = await nodePack['feature.campaign-connectors.nodes.sync']({ features: blocked, ads, inputs: { orgId: 'o1', platform: 'google', syncScope: 'account' } });
    expect(out.outputs).toEqual({ outcome: 'cooldown', retryAtIso: '2026-07-02T00:00:00Z' });
    expect(asked).toHaveLength(0);
  });
});
