/**
 * Campaign Connectors (ADR 0159) — pure CSV import/validate units, the service
 * dedup + KPI projection, the import route + KPI, and the sync node honest-off.
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
    expect(issues.some((i) => i.severity === 'error' && /future/i.test(i.message))).toBe(true);
    expect(issues.some((i) => i.severity === 'error' && /negative/i.test(i.message))).toBe(true);
    expect(issues.some((i) => i.severity === 'warning' && /exceed impressions/i.test(i.message))).toBe(true);
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
});

let BASE: string; let server: http.Server; let n = 0;
describe('campaign-connectors — routes + sync node', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    const d = getToggleDefault('campaign-connectors'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  function client() {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: await res.json().catch(() => undefined) } as { status: number; body: any };
    };
    return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
  }

  it('imports a CSV and projects KPI over HTTP', async () => {
    const c = client();
    expect((await c.post('/v1/host/openwop-app/test/login', { email: `cc-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
    const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId;
    const csv = 'Platform,Campaign,Day,Cost,Impr.,Clicks,Conversions,Revenue\nMeta,Promo,2026-02-01,200,4000,100,10,1000';
    const imp = await c.post('/v1/host/openwop-app/campaign-connectors/import', { orgId, csv });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body.imported).toBe(1);
    const kpi = await c.get(`/v1/host/openwop-app/campaign-connectors/kpi?orgId=${orgId}`);
    expect(kpi.body.totals.spend).toBe(200);
    expect(kpi.body.byPlatform[0].platform).toBe('meta');
  });

  it('sync node is honest-off (connector_not_configured)', async () => {
    const out = await nodePack['feature.campaign-connectors.nodes.sync']({ features: { 'campaign-connectors': { importCsv: async () => ({}) } }, inputs: { orgId: 'o1', platform: 'google' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('connector_not_configured');
  });
});
