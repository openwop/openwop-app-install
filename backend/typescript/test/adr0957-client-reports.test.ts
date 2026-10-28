/**
 * ADR 0957 P0 — report definitions and frozen client reports.
 *
 * Exit criteria: the snapshot's numbers equal the source functions'; a client-B
 * report is a 404 to an operator who holds client A only.
 *
 * Setup is the ADR 0921 posture: a `ws:` agency workspace with clients A and B.
 * The operator holds `editor` on A only; the admin holds `admin` on the root.
 *
 * Sabotage witnesses:
 * - copy a figure through a transform instead of verbatim → "the snapshot equals the sources";
 * - look a report up without its org in the key → "client B is a uniform 404";
 * - drop the email-campaign org check → "an email section naming another client's campaign is refused";
 * - hash something other than the snapshot → "a stored report is frozen".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { persistRecords, kpiSummary } from '../src/features/campaign-connectors/performanceService.js';
import { buildAttribution } from '../src/features/campaign-intel/attribution.js';
import { createCampaign as createEmailCampaign, createTemplate } from '../src/features/email/emailService.js';
import { engagementStats } from '../src/features/email/engagementService.js';
import { eraseCampaignOpsSubject } from '../src/features/campaign-ops/erasure.js';
import { getReport, resolvePeriod, snapshotHashOf } from '../src/features/campaign-ops/reports/reportService.js';
import { WINDOW_NOTE } from '../src/features/campaign-ops/reports/sectionSources.js';
import type { ClientReport, ReportDefinition } from '../src/features/campaign-ops/reports/types.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let adminCookie: string;
let operatorCookie: string;
let operatorUserId: string;
let orgA: string;
let orgB: string;

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
interface Res<T> { status: number; body: T; raw: string }
async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-ops${path}`, {
    method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const row = (date: string, spend: number, clicks: number, conversions: number | null) => ({
  platform: 'meta' as const, campaignName: 'Q4', adSet: 'A', date, spend, impressions: clicks * 20, clicks, conversions, revenue: conversions === null ? null : conversions * 50,
  ctr: 0.05, cpc: spend / clicks, cvr: 0, cpa: 0, roas: 0, currency: 'USD',
});
type DefRes = { definition: ReportDefinition };
type ReportRes = { report: ClientReport };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops', 'campaign-ops.client-reports', 'email', 'campaign-connectors', 'campaign-intel', 'campaign-orchestration']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:rpt-owner' });
  TENANT = ws.tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rpt-admin', source: 'oidc' });
  const operator = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rpt-operator', source: 'oidc' });
  operatorUserId = operator.userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: operator.userId, displayName: 'Operator', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: operator.userId, displayName: 'Operator', roles: ['editor'] });
  adminCookie = cookieFor(admin.userId, 'ws:home-admin');
  operatorCookie = cookieFor(operator.userId, 'ws:home-operator');
  expect((await call(adminCookie, 'POST', '/clients', { name: 'Client A', orgId: orgA })).status).toBe(201);
  expect((await call(adminCookie, 'POST', '/clients', { name: 'Client B', orgId: orgB })).status).toBe(201);
  await persistRecords(TENANT, orgA, [row('2026-09-01', 120.5, 40, 3), row('2026-09-02', 80, 25, null)], 'csv');
  await persistRecords(TENANT, orgB, [row('2026-09-01', 999, 99, 9)], 'csv');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const DEF = { title: 'Monthly results', sections: [{ kind: 'kpi' }, { kind: 'attribution' }], period: { kind: 'month', timezone: 'Europe/London' } };

describe('ADR 0957 P0 — client reports', () => {
  it('source feature shutoff refuses a fresh computation without persisting an empty or stale report', async () => {
    const created = await call<DefRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, DEF);
    expect(created.status).toBe(201);
    const definitionId = created.body.definition.definitionId;
    for (const featureId of ['campaign-connectors', 'campaign-intel']) {
      const config = getToggleDefault(featureId)!;
      try {
        await saveConfig({ ...config, status: 'off' }, 'test');
        const response = await call<{ details?: { reason?: string; featureId?: string } }>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${definitionId}/reports`, {});
        expect(response.status, response.raw).toBe(409);
        expect(response.body.details).toMatchObject({ reason: 'report_source_unavailable', featureId });
      } finally { await saveConfig({ ...config, status: 'on' }, 'test'); }
    }
    const listed = await call<{ reports: ClientReport[] }>(operatorCookie, 'GET', `/clients/${orgA}/reports?definitionId=${definitionId}`);
    expect(listed.body.reports).toEqual([]);
  });

  it('rejects normalized impossible calendar dates and unknown nested definition fields', async () => {
    expect(() => resolvePeriod('custom', { start: '2026-02-31', end: '2026-03-01' })).toThrow(/dates/);
    expect(() => resolvePeriod('custom', { start: '2025-02-29', end: '2025-03-01' })).toThrow(/dates/);
    expect(resolvePeriod('custom', { start: '2024-02-29', end: '2024-03-01' })).toEqual({ periodStart: '2024-02-29', periodEnd: '2024-03-01' });
    for (const change of [{ sections: [{ kind: 'kpi', arbitrary: true }] }, { period: { ...DEF.period, unexpected: true } }, { narrative: 'yes' }, { expectedVersion: '1' }]) {
      expect((await call(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, { ...DEF, ...change })).status).toBe(400);
    }
  });

  it('the snapshot equals the source functions, verbatim, with lineage and honesty notes', async () => {
    const d = await call<DefRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, DEF);
    expect(d.status, d.raw).toBe(201);
    expect(d.body.definition).toMatchObject({ version: 1, campaignIds: 'all', brand: 'agency', narrative: false, audience: [] });
    const r = await call<ReportRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${d.body.definition.definitionId}/reports`, { periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    expect(r.status, r.raw).toBe(201);
    const report = r.body.report;
    expect(report).toMatchObject({ status: 'draft', periodStart: '2026-09-01', periodEnd: '2026-09-30', definitionVersion: 1 });

    const kpi = await kpiSummary(TENANT, orgA);
    for (const [k, v] of Object.entries(kpi.totals)) expect(report.snapshot.metrics[`kpi.${k}`]?.value, k).toBe(v);
    expect(report.snapshot.metrics['kpi.spend']).toMatchObject({ unit: 'currency', currency: 'USD', previous: null });
    expect(report.snapshot.metrics['kpi.spend'].lineage).toMatchObject({ source: 'campaign-connectors.kpiSummary', rows: kpi.recordCount });
    expect(report.snapshot.metrics['kpi.spend'].lineage.notes).toContain(WINDOW_NOTE);
    expect(report.snapshot.metrics['kpi.spend'].lineage.notes).toContain('unreported-conversions:1');
    expect(report.snapshot.tables['kpi.byPlatform'].rows).toHaveLength(kpi.byPlatform.length);
    // Client B's spend is not in client A's report.
    expect(report.snapshot.metrics['kpi.spend'].value).toBe(200.5);

    const attr = await buildAttribution(TENANT, orgA);
    expect(report.snapshot.metrics['attribution.unattributedConversions'].value).toBe(attr.unattributedConversions);
    expect(report.snapshot.tables['attribution.campaigns'].rows).toHaveLength(attr.rows.length);
    expect(report.snapshotHash).toBe(snapshotHashOf(report.snapshot));
  });

  it('an email section reads its campaign only when it is this client\'s', async () => {
    const tplA = await createTemplate({ tenantId: TENANT, orgId: orgA, name: 'T', subject: 'S', body: 'B', createdBy: 'seed' });
    const emA = await createEmailCampaign({ tenantId: TENANT, orgId: orgA, templateId: tplA.templateId, createdBy: 'seed' });
    const tplB = await createTemplate({ tenantId: TENANT, orgId: orgB, name: 'T', subject: 'S', body: 'B', createdBy: 'seed' });
    const emB = await createEmailCampaign({ tenantId: TENANT, orgId: orgB, templateId: tplB.templateId, createdBy: 'seed' });
    const ok = await call<DefRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, { ...DEF, sections: [{ kind: 'email', key: 'launch', params: { emailCampaignId: emA.campaignId } }] });
    expect(ok.status, ok.raw).toBe(201);
    const r = await call<ReportRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${ok.body.definition.definitionId}/reports`, {});
    expect(r.status, r.raw).toBe(201);
    const stats = await engagementStats(TENANT, emA.campaignId);
    expect(r.body.report.snapshot.metrics['launch.clicks'].value).toBe(stats.clicks);
    expect(r.body.report.snapshot.metrics['launch.opens'].lineage.notes).toContain('opens-approximate');
    // The month default is the last complete calendar month.
    expect(r.body.report.periodStart).toBe(resolvePeriod('month', {}).periodStart);

    // Another client's email campaign is refused when the definition is saved…
    const foreign = await call<{ details?: { reason?: string } }>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, { ...DEF, sections: [{ kind: 'email', params: { emailCampaignId: emB.campaignId } }] });
    expect(foreign.status, foreign.raw).toBe(400);
    expect(foreign.body.details?.reason).toBe('report_definition_invalid');
    // …and again at compute time, should a stored definition name one.
    const { createDefinition } = await import('../src/features/campaign-ops/reports/reportService.js');
    const planted = await createDefinition(TENANT, orgA, { title: 'Planted', campaignIds: 'all', sections: [{ kind: 'email', key: 'em', params: { emailCampaignId: emB.campaignId } }], period: { kind: 'month', timezone: 'UTC' }, brand: 'agency', narrative: false }, 'seed');
    const refused = await call<{ details?: { reason?: string } }>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${planted.definitionId}/reports`, {});
    expect(refused.status).toBe(400);
    expect(refused.body.details?.reason).toBe('report_section_invalid');
  });

  it('client B is a uniform 404 to a client-A-only operator, including by id', async () => {
    const d = await call<DefRes>(adminCookie, 'POST', `/clients/${orgB}/report-definitions`, DEF);
    expect(d.status, d.raw).toBe(201);
    const r = await call<ReportRes>(adminCookie, 'POST', `/clients/${orgB}/report-definitions/${d.body.definition.definitionId}/reports`, {});
    expect(r.status, r.raw).toBe(201);
    expect((await call(operatorCookie, 'GET', `/clients/${orgB}/reports/${r.body.report.reportId}`)).status).toBe(404);
    expect((await call(operatorCookie, 'GET', `/clients/${orgB}/report-definitions`)).status).toBe(404);
    // Client B's report id under client A's path is not found either.
    expect((await call(operatorCookie, 'GET', `/clients/${orgA}/reports/${r.body.report.reportId}`)).status).toBe(404);
    expect((await call(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${d.body.definition.definitionId}/reports`, {})).status).toBe(404);
  });

  it('refuses invalid definitions closed-world', async () => {
    const bad = async (body: unknown): Promise<number> => (await call(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, body)).status;
    expect(await bad({ ...DEF, sections: [{ kind: 'spend' }] })).toBe(400);
    expect(await bad({ ...DEF, sections: [{ kind: 'kpi', params: { emailCampaignId: 'x' } }] })).toBe(400);
    expect(await bad({ ...DEF, sections: [{ kind: 'kpi' }, { kind: 'kpi' }] })).toBe(400);
    expect(await bad({ ...DEF, period: { kind: 'month', timezone: 'Mars/Olympus' } })).toBe(400);
    expect(await bad({ ...DEF, campaignIds: ['not-a-campaign'] })).toBe(400);
    expect(await bad({ ...DEF, audience: ['collab_1'] })).toBe(400);
    expect(await bad({ ...DEF, extra: true })).toBe(400);
  });

  it('a definition edit bumps the version; a stale edit is a 409; a report keeps the version it used', async () => {
    const d = await call<DefRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, DEF);
    const id = d.body.definition.definitionId;
    const r1 = await call<ReportRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${id}/reports`, {});
    const e = await call<DefRes>(operatorCookie, 'PATCH', `/clients/${orgA}/report-definitions/${id}`, { ...DEF, title: 'Renamed', expectedVersion: 1 });
    expect(e.status, e.raw).toBe(200);
    expect(e.body.definition.version).toBe(2);
    expect((await call(operatorCookie, 'PATCH', `/clients/${orgA}/report-definitions/${id}`, { ...DEF, expectedVersion: 1 })).status).toBe(409);
    const stored = await getReport(TENANT, orgA, r1.body.report.reportId);
    expect(stored?.definitionVersion).toBe(1);
  });

  it('a stored report is frozen: its hash is its snapshot\'s, and new data makes a new report', async () => {
    const d = await call<DefRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, DEF);
    const id = d.body.definition.definitionId;
    const r1 = (await call<ReportRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${id}/reports`, {})).body.report;
    await persistRecords(TENANT, orgA, [row('2026-09-03', 10, 5, 1)], 'csv');
    const r2 = (await call<ReportRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${id}/reports`, {})).body.report;
    expect(r2.reportId).not.toBe(r1.reportId);
    expect(r2.snapshotHash).not.toBe(r1.snapshotHash);
    const again = await getReport(TENANT, orgA, r1.reportId);
    if (!again) throw new Error('stored report missing');
    expect(again.snapshotHash).toBe(r1.snapshotHash);
    expect(snapshotHashOf(again.snapshot)).toBe(r1.snapshotHash);
  });

  it('404s when the client-reports sub-toggle is off, with campaign-ops on', async () => {
    const t = getToggleDefault('campaign-ops.client-reports');
    if (!t) throw new Error('sub-toggle not registered');
    expect(t.status).toBe('off');
    await saveConfig({ ...t, status: 'off' }, 'test');
    try {
      expect((await call(operatorCookie, 'GET', `/clients/${orgA}/report-definitions`)).status).toBe(404);
    } finally {
      await saveConfig({ ...t, status: 'on' }, 'test');
    }
  });

  it('subject erasure tombstones the author on definitions and reports, and keeps them', async () => {
    const before = await call<{ definitions: ReportDefinition[] }>(operatorCookie, 'GET', `/clients/${orgA}/report-definitions`);
    expect(before.body.definitions.some((x) => x.createdBy === operatorUserId)).toBe(true);
    const out = await eraseCampaignOpsSubject(TENANT, operatorUserId);
    expect(out.rowsTouched).toBeGreaterThan(0);
    const after = await call<{ definitions: ReportDefinition[] }>(adminCookie, 'GET', `/clients/${orgA}/report-definitions`);
    expect(after.body.definitions.length).toBe(before.body.definitions.length);
    expect(after.body.definitions.some((x) => x.createdBy === operatorUserId)).toBe(false);
  });
});
