/**
 * ADR 0957 P1 (non-gate parts) — the report nodes, the publish CAS and scheduling.
 *
 * Exit criteria covered here: a changed snapshot cannot publish under an old
 * approval (the CAS on snapshotHash); scheduled runs pin the definition version.
 * The chain and its ADR 0942 gate step ship once the org-scoped freeze lands.
 *
 * Sabotage witnesses:
 * - drop the hash comparison in publishReport → "a changed snapshot cannot publish";
 * - drop the version pin check in computeReportSnapshot → "a scheduled run pins its version";
 * - drop the client-status check in the fire gate → "the fire gate refuses";
 * - skip the re-arm on edit → "every edit re-arms the job".
 *
 * (Shared setup copied from adr0957-client-reports.test.ts.)
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { persistRecords } from '../src/features/campaign-connectors/performanceService.js';
import { createReport, getDefinition, getReport, listReports, publishReport } from '../src/features/campaign-ops/reports/reportService.js';
import { reportFireGate, reportJobId, CLIENT_REPORT_CHAIN_ID } from '../src/features/campaign-ops/reports/schedule.js';
import { getJob } from '../src/host/schedulingService.js';
import { buildCampaignOpsSurface } from '../src/features/campaign-ops/surface.js';
import { nodes as opsNodes } from '../../../packs/feature.campaign-ops.nodes/index.mjs';
import type { ReportDefinition } from '../src/features/campaign-ops/reports/types.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { loadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';
import { getChainBackedWorkflow, registerChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let adminCookie: string;
let operatorCookie: string;
let operatorUserId: string;
let adminUserId: string;
let orgA: string;
let orgB: string;
let fixtureRoot: string | undefined;

/** A test-only compute chain exercises scheduling bookkeeping. Production
 * publication remains unavailable until the real review/publish chain ships. */
function installScheduleFixture(): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'owp-report-chain-fixture-'));
  const dir = join(fixtureRoot, 'report');
  mkdirSync(dir);
  const template = JSON.parse(readFileSync(new URL('../../../examples/workflow-chain-packs/campaign-ops/pack.json', import.meta.url), 'utf8')) as { name: string; version: string; chains: Array<Record<string, unknown>> };
  const pack = { ...template, name: 'core.openwop.workflows.report-fixture', version: '1.0.0', chains: [{
    ...template.chains[0], chainId: CLIENT_REPORT_CHAIN_ID, version: '1.0.0',
    parameters: { type: 'object', properties: { orgId: { type: 'string' }, definitionId: { type: 'string' }, definitionVersion: { type: 'integer' } }, required: ['orgId', 'definitionId', 'definitionVersion'] },
    dag: { nodes: [{ id: 'compute', typeId: 'feature.campaign-ops.nodes.compute-snapshot@1.0.0', inputs: { orgId: '{{params.orgId}}', definitionId: '{{params.definitionId}}', definitionVersion: '{{params.definitionVersion}}' } }], edges: [] },
  }] };
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(pack));
  expect(loadWorkflowChainPacks({ roots: [fixtureRoot] }).errors).toEqual([]);
  registerChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID, { featureId: 'campaign-ops.client-reports' });
  expect(getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID)).toBeDefined();
}

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
  adminUserId = admin.userId;
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
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); if (fixtureRoot) rmSync(fixtureRoot, { recursive: true }); });

const DEF = { title: 'Monthly results', sections: [{ kind: 'kpi' }], period: { kind: 'month', timezone: 'UTC' } };

async function newDefinition(extra: Record<string, unknown> = {}): Promise<ReportDefinition> {
  const d = await call<DefRes>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, { ...DEF, ...extra });
  expect(d.status, d.raw).toBe(201);
  return d.body.definition;
}
const surface = () => buildCampaignOpsSurface({ tenantId: TENANT, actingUserId: operatorUserId, runId: `run_${Math.random().toString(36).slice(2)}` });

describe('ADR 0957 P1 — publish CAS', () => {
  it('a lost report-write acknowledgement resumes the frozen report instead of recomputing a duplicate', async () => {
    const def = await newDefinition();
    const period = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
    const opts = { runId: `report-retry-${randomBytes(4).toString('hex')}` };
    const storage = hostExtStorage();
    const cas = storage.kvCompareAndSwap.bind(storage);
    let lost = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      const result = await cas(...args);
      if (!lost && args[0].startsWith('hostext:campaign-ops:report:') && result.swapped) { lost = true; throw new Error('lost-report-ack'); }
      return result;
    });
    try {
      await expect(createReport(def, period, operatorUserId, opts)).rejects.toThrow('lost-report-ack');
      const written = await listReports(TENANT, orgA, def.definitionId);
      expect(written).toHaveLength(1);
      const resumed = await createReport(def, period, operatorUserId, opts);
      expect(resumed).toEqual(written[0]);
      expect(await listReports(TENANT, orgA, def.definitionId)).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it('a changed stored snapshot cannot publish under its stale stored fingerprint', async () => {
    const def = await newDefinition();
    const report = await createReport(def, { periodStart: '2026-09-01', periodEnd: '2026-09-30' }, operatorUserId, { runId: 'tampered-report' });
    const changed = { ...report, snapshot: { ...report.snapshot, metrics: {} } };
    await hostExtStorage().kvSet(`hostext:campaign-ops:report:${TENANT}::${orgA}::${report.reportId}`, JSON.stringify(changed));
    await expect(publishReport(TENANT, orgA, report.reportId, report.snapshotHash, adminUserId)).rejects.toMatchObject({ details: { reason: 'report_snapshot_changed' } });
    expect((await getReport(TENANT, orgA, report.reportId))?.status).toBe('in_review');
  });
  it('a chain-computed report is in review; only its approved snapshot publishes', async () => {
    const def = await newDefinition();
    const r1 = await createReport(def, { periodStart: '2026-09-01', periodEnd: '2026-09-30' }, operatorUserId, { runId: 'run_a' });
    expect(r1.status).toBe('in_review');
    await persistRecords(TENANT, orgA, [row('2026-09-05', 7, 3, 1)], 'csv');
    const r2 = await createReport(def, { periodStart: '2026-09-01', periodEnd: '2026-09-30' }, operatorUserId, { runId: 'run_b' });
    expect(r2.snapshotHash).not.toBe(r1.snapshotHash);
    // The approval named r1's numbers; r2 cannot publish under it.
    await expect(publishReport(TENANT, orgA, r2.reportId, r1.snapshotHash, adminUserId)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'report_snapshot_changed' } });
    const pub = await publishReport(TENANT, orgA, r1.reportId, r1.snapshotHash, adminUserId);
    expect(pub).toMatchObject({ status: 'published', publishedBy: adminUserId });
    // A replayed publish returns the same row.
    expect((await publishReport(TENANT, orgA, r1.reportId, r1.snapshotHash, adminUserId)).publishedAt).toBe(pub.publishedAt);
    // A manual draft never publishes.
    const draft = await createReport(def, { periodStart: '2026-09-01', periodEnd: '2026-09-30' }, operatorUserId);
    await expect(publishReport(TENANT, orgA, draft.reportId, draft.snapshotHash, adminUserId)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'report_not_in_review' } });
    // Another client's path cannot reach it.
    await expect(publishReport(TENANT, orgB, r1.reportId, r1.snapshotHash, adminUserId)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('ADR 0957 P1 — the report nodes over the real surface', () => {
  it('compute-snapshot and report-snapshot-read work; publish-report refuses until the review gate exists', async () => {
    const def = await newDefinition();
    const ctx = (inputs: Record<string, unknown>) => ({ inputs, features: { 'campaign-ops': surface() } });
    const c = await opsNodes['feature.campaign-ops.nodes.compute-snapshot'](ctx({ orgId: orgA, definitionId: def.definitionId, definitionVersion: def.version }));
    expect(c.status).toBe('success');
    const out = c.outputs as { reportId: string; snapshotHash: string } | undefined;
    if (!out) throw new Error('no outputs');
    const stored = await getReport(TENANT, orgA, out.reportId);
    expect(stored).toMatchObject({ status: 'in_review', snapshotHash: out.snapshotHash });
    expect(stored?.runId).toMatch(/^run_/);
    const read = await opsNodes['feature.campaign-ops.nodes.report-snapshot-read'](ctx({ orgId: orgA, reportId: out.reportId }));
    expect(read.outputs).toMatchObject({ found: true, snapshotHash: out.snapshotHash });
    // Until the ADR 0942 gate can approve a client-bound run, the node refuses:
    // a hand-built workflow must not publish numbers nobody reviewed.
    await expect(opsNodes['feature.campaign-ops.nodes.publish-report'](ctx({ orgId: orgA, reportId: out.reportId, snapshotHash: out.snapshotHash })))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'report_publish_unavailable' } });
    expect((await getReport(TENANT, orgA, out.reportId))?.status).toBe('in_review');
  });

  it('a scheduled run pins its definition version: an edit since then is a typed failure', async () => {
    const def = await newDefinition();
    expect((await call(operatorCookie, 'PATCH', `/clients/${orgA}/report-definitions/${def.definitionId}`, { ...DEF, title: 'Edited' })).status).toBe(200);
    await expect(surface().computeReportSnapshot({ orgId: orgA, definitionId: def.definitionId, definitionVersion: 1 }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'report_definition_changed' } });
  });

  it('a run for another client is refused', async () => {
    const def = await newDefinition();
    await expect(surface().computeReportSnapshot({ orgId: orgB, definitionId: def.definitionId })).rejects.toMatchObject({ httpStatus: 403 });
  });
});

describe('ADR 0957 P1 — scheduling', () => {
  it('a missing report workflow refuses scheduling before a definition is persisted', async () => {
    expect(getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID)).toBeUndefined();
    const before = (await call<{ definitions: ReportDefinition[] }>(operatorCookie, 'GET', `/clients/${orgA}/report-definitions`)).body.definitions.length;
    const response = await call(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, { ...DEF, schedule: { cron: '0 9 1 * *' } });
    expect(response.status).toBe(400);
    expect(response.raw).toContain('workflow is installed');
    expect((await call<{ definitions: ReportDefinition[] }>(operatorCookie, 'GET', `/clients/${orgA}/report-definitions`)).body.definitions).toHaveLength(before);
    installScheduleFixture();
  });
  it('every edit re-arms the job with the new pinned version; clearing the schedule removes it', async () => {
    const def = await newDefinition({ schedule: { cron: '0 9 1 * *' } });
    const jobId = reportJobId(TENANT, orgA, def.definitionId);
    const job = await getJob(jobId);
    expect(job).toMatchObject({ workflowId: CLIENT_REPORT_CHAIN_ID, enabled: true, inputs: { orgId: orgA, definitionId: def.definitionId, definitionVersion: 1 } });
    expect(job?.metadata).toMatchObject({ orgScopeSubject: operatorUserId });
    expect((await call(operatorCookie, 'PATCH', `/clients/${orgA}/report-definitions/${def.definitionId}`, { ...DEF, schedule: { cron: '0 9 * * 1' } })).status).toBe(200);
    expect(await getJob(jobId)).toMatchObject({ cronExpr: '0 9 * * 1', inputs: { definitionVersion: 2 } });
    expect((await call(operatorCookie, 'PATCH', `/clients/${orgA}/report-definitions/${def.definitionId}`, DEF)).status).toBe(200);
    expect(await getJob(jobId)).toBeNull();
  });

  it('an invalid cadence is refused before anything is written', async () => {
    const before = (await call<{ definitions: ReportDefinition[] }>(operatorCookie, 'GET', `/clients/${orgA}/report-definitions`)).body.definitions.length;
    const bad = await call<{ details?: { reason?: string } }>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, { ...DEF, schedule: { cron: '99 99 * * *' } });
    expect(bad.status).toBe(400);
    expect((await call<{ definitions: ReportDefinition[] }>(operatorCookie, 'GET', `/clients/${orgA}/report-definitions`)).body.definitions.length).toBe(before);
  });

  it('the fire gate refuses when the toggles are off, the client is not active, or the pin is stale', async () => {
    const def = await newDefinition({ schedule: { cron: '0 9 1 * *' } });
    const job = await getJob(reportJobId(TENANT, orgA, def.definitionId));
    if (!job) throw new Error('job not armed');
    expect(await reportFireGate(job)).toBeNull();
    expect(await reportFireGate({ ...job, inputs: { ...job.inputs, definitionVersion: 99 } })).toBe('dispatch-error');
    const t = getToggleDefault('campaign-ops.client-reports');
    if (!t) throw new Error('sub-toggle missing');
    await saveConfig({ ...t, status: 'off' }, 'test');
    try { expect(await reportFireGate(job)).toBe('feature-disabled'); } finally { await saveConfig({ ...t, status: 'on' }, 'test'); }
    expect((await call(adminCookie, 'PATCH', `/clients/${orgA}`, { status: 'paused' })).status).toBe(200);
    try { expect(await reportFireGate(job)).toBe('client-inactive'); } finally { await call(adminCookie, 'PATCH', `/clients/${orgA}`, { status: 'active' }); }
    expect(await getDefinition(TENANT, orgA, def.definitionId)).not.toBeNull();
  });
});
