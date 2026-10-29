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
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { getChainBackedWorkflow, registerChainBackedWorkflow, _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { classifyPackDir } from '../src/host/packTrust.js';
import { AUTONOMY_STAMP_KEY, AUTONOMY_TOGGLE } from '../src/host/autonomyPolicy/index.js';
import { __awaitRunResumeChainForTests, resolveAndResume } from '../src/routes/interrupts.js';
import { getRunArtifact, runArtifactKey } from '../src/host/runArtifactStore.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { bareRunId } from './support/bareRunId.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let adminCookie: string;
let operatorCookie: string;
let otherClientCookie: string;
let forkReviewerCookie: string;
let operatorUserId: string;
let adminUserId: string;
let orgA: string;
let orgB: string;
let storage: Storage;
let hostSuite: HostAdapterSuite;
function restoreReportChain(): void {
  registerChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID, { featureId: 'campaign-ops.client-reports' });
  expect(getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID)?.nodes).toHaveLength(3);
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
  storage = app.locals.storage;
  hostSuite = app.locals.hostSuite;
  // Resolve through the real boot-installed lazy resolver and local mount. No
  // explicit pack load or direct registration may bypass discovery or trust.
  // The focused delegate tests later still use opsNodes directly.
  for (const [name, typeIds] of [
    ['feature.campaign-ops.nodes', [
      'feature.campaign-ops.nodes.compute-snapshot',
      'feature.campaign-ops.nodes.publish-report',
    ]],
    ['feature.campaign-orchestration.nodes', [
      'feature.campaign-orchestration.nodes.autonomy-gate',
    ]],
  ] as const) {
    const packDir = fileURLToPath(new URL(`../../../packs/${name}/`, import.meta.url));
    const trust = classifyPackDir(packDir, { noCache: true });
    expect(trust, name).toMatchObject({ tier: 'steward', dispatchable: true, reason: 'steward_manifest_digest_match' });
    expect(trust.allowedByBreakGlass, name).toBeUndefined();
    expect(getNodeRegistry().get(typeIds[0]), `${name} must start unloaded`).toBeNull();
    for (const typeId of typeIds) {
      const loaded = await getNodeRegistry().resolve(typeId);
      expect(loaded, typeId).toMatchObject({
        typeId, version: trust.version,
        packOrigin: { packName: name, packVersion: trust.version, tier: 'steward' },
      });
      expect(realpathSync(loaded!.packOrigin!.packDir), typeId).toBe(realpathSync(packDir));
    }
  }
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
  await createMember({ tenantId: TENANT, orgId: orgA, subject: admin.userId, displayName: 'Reviewer', roles: ['admin'] });
  const other = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rpt-other-client', source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: other.userId, displayName: 'Other client operator', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: other.userId, displayName: 'Other client operator', roles: ['editor'] });
  otherClientCookie = cookieFor(other.userId, 'ws:home-other');
  adminCookie = cookieFor(admin.userId, 'ws:home-admin');
  operatorCookie = cookieFor(operator.userId, 'ws:home-operator');
  const forkReviewer = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rpt-fork-reviewer', source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: forkReviewer.userId, displayName: 'Fork reviewer', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: forkReviewer.userId, displayName: 'Fork reviewer', roles: ['admin'] });
  forkReviewerCookie = cookieFor(forkReviewer.userId, 'ws:home-fork-reviewer');
  expect((await call(adminCookie, 'POST', '/clients', { name: 'Client A', orgId: orgA })).status).toBe(201);
  expect((await call(adminCookie, 'POST', '/clients', { name: 'Client B', orgId: orgB })).status).toBe(201);
  await persistRecords(TENANT, orgA, [row('2026-09-01', 120.5, 40, 3), row('2026-09-02', 80, 25, null)], 'csv');
  await persistRecords(TENANT, orgB, [row('2026-09-01', 999, 99, 9)], 'csv');
});

describe('ADR 0957 P1b — run-now HTTP route through the real executor', () => {
  async function review(cookie: string, runId: string, nodeId: string, action: string) {
    const response = await fetch(`${BASE}/runs/${encodeURIComponent(`${TENANT}/${runId}`)}/interrupts/${encodeURIComponent(nodeId)}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ resumeValue: { action } }),
    });
    return { status: response.status, raw: await response.text() };
  }
  async function launchToReview() {
    const toggle = getToggleDefault(AUTONOMY_TOGGLE);
    if (!toggle) throw new Error('autonomy toggle missing');
    await saveConfig({ ...toggle, status: 'on' }, 'test');
    expect((await call(adminCookie, 'PATCH', `/clients/${orgA}`, { mode: 'live' })).status).toBe(200);
    const def = await newDefinition();
    const started = await call<{ runId: string }>(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${def.definitionId}/runs`, { periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    expect(started.status, started.raw).toBe(202);
    const runId = started.body.runId;
    await vi.waitFor(async () => {
      const run = await storage.getRun(runId);
      expect(run?.status, JSON.stringify(run)).toBe('waiting-approval');
    }, { timeout: 8000, interval: 25 });
    const run = await storage.getRun(runId);
    expect(run?.metadata).toMatchObject({ orgScopeSubject: operatorUserId, [AUTONOMY_STAMP_KEY]: { orgId: orgA }, 'openwop-app.campaignOps': { orgId: orgA, definitionId: def.definitionId, definitionVersion: def.version, periodStart: '2026-09-01', periodEnd: '2026-09-30' } });
    const reports = (await listReports(TENANT, orgA, def.definitionId)).filter((report) => report.runId === runId);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    const interrupts = await storage.listOpenInterrupts(runId);
    expect(interrupts).toHaveLength(1);
    const interrupt = interrupts[0]!;
    expect(interrupt.data).toMatchObject({ key: 'autonomy-gate', autonomy: { actionClass: 'report.publish', contentHash: report.snapshotHash } });
    const preview = await getRunArtifact(runArtifactKey(runId, interrupt.nodeId));
    expect(preview?.role).toBe('gate-preview');
    expect(JSON.parse(preview!.content)).toMatchObject({ reportId: report.reportId, snapshotHash: report.snapshotHash, snapshot: report.snapshot });
    expect(report.status).toBe('in_review');
    return { runId, report, interrupt };
  }

  it.each(['approve', 'accept'])('a separate reviewer can %s the exact computed snapshot', async (action) => {
    const { runId, report, interrupt } = await launchToReview();
    const selfReview = await review(operatorCookie, runId, interrupt.nodeId, action);
    expect(selfReview.status, selfReview.raw).toBe(403);
    expect((await storage.getInterrupt(interrupt.interruptId))?.resolvedAt).toBeUndefined();
    const reviewed = await review(adminCookie, runId, interrupt.nodeId, action);
    expect(reviewed.status, reviewed.raw).toBe(200);
    await __awaitRunResumeChainForTests(runId);
    expect((await storage.getRun(runId))?.status, JSON.stringify(await storage.listEvents(runId))).toBe('completed');
    expect(await getReport(TENANT, orgA, report.reportId)).toMatchObject({ status: 'published', snapshotHash: report.snapshotHash, snapshot: report.snapshot });
  });

  it('rejecting the real review keeps the report unpublished', async () => {
    const { runId, report, interrupt } = await launchToReview();
    await expect(resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'reject' }, { subjectRef: operatorUserId }))
      .rejects.toMatchObject({ httpStatus: 403 });
    expect((await storage.getInterrupt(interrupt.interruptId))?.resolvedAt).toBeUndefined();
    await resolveAndResume(storage, hostSuite, interrupt.interruptId, { action: 'reject' }, { subjectRef: adminUserId });
    await __awaitRunResumeChainForTests(runId);
    expect((await storage.getRun(runId))?.status).toBe('failed');
    expect((await getReport(TENANT, orgA, report.reportId))?.status).toBe('in_review');
    expect((await storage.listEvents(runId)).some((event) => event.type === 'node.completed' && event.nodeId?.endsWith('_publish'))).toBe(false);
  });

  it('the review preview exposes the frozen figures only to the report client', async () => {
    const { runId, report, interrupt } = await launchToReview();
    const data = interrupt.data as { artifactId: string; revisionId: string };
    const path = `${BASE}/host/openwop-app/artifacts/${encodeURIComponent(data.artifactId)}/revisions/${encodeURIComponent(data.revisionId)}`;
    const visible = await fetch(path, { headers: { cookie: adminCookie } });
    expect(visible.status).toBe(200);
    const revision = await visible.json() as { content: string };
    expect(JSON.parse(revision.content)).toMatchObject({ reportId: report.reportId, snapshotHash: report.snapshotHash, snapshot: report.snapshot });
    const denied = await fetch(path, { headers: { cookie: otherClientCookie } });
    expect(denied.status, await denied.text()).toBe(404);
    await review(adminCookie, runId, interrupt.nodeId, 'reject');
    await __awaitRunResumeChainForTests(runId);
  });

  it.each(['before-compute', 'after-compute'] as const)('a branch fork %s needs its own review and preserves the source snapshot', async (point) => {
    const { runId, report, interrupt } = await launchToReview();
    const marker = await getEventLog().append({ runId, type: 'log.message', payload: { message: 'Report fork checkpoint' } });
    const response = await fetch(`${BASE}/runs/${encodeURIComponent(`${TENANT}/${runId}`)}:fork`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'branch', fromSeq: point === 'before-compute' ? 0 : marker.sequence }),
    });
    const raw = await response.text();
    expect(response.status, raw).toBe(201);
    const forkId = bareRunId((JSON.parse(raw) as { runId: string }).runId);
    try {
      await vi.waitFor(async () => {
        expect((await storage.getRun(forkId))?.status, JSON.stringify(await storage.listEvents(forkId))).toBe('waiting-approval');
      }, { timeout: 8000, interval: 25 });
      const fork = await storage.getRun(forkId);
      expect(fork).toMatchObject({ parentRunId: runId, forkMode: 'branch', tenantId: TENANT });
      expect(fork?.metadata?.[AUTONOMY_STAMP_KEY]).toEqual((await storage.getRun(runId))?.metadata?.[AUTONOMY_STAMP_KEY]);
      expect(fork?.metadata?.['openwop-app.campaignOps']).toEqual((await storage.getRun(runId))?.metadata?.['openwop-app.campaignOps']);
      const open = await storage.listOpenInterrupts(forkId);
      expect(open).toHaveLength(1);
      const gate = open[0]!;
      expect(gate.interruptId).not.toBe(interrupt.interruptId);
      expect(gate.token).not.toBe(interrupt.token);
      const forkReports = (await listReports(TENANT, orgA, report.definitionId)).filter((item) => item.runId === forkId);
      if (point === 'before-compute') expect(forkReports).toHaveLength(1);
      else expect(forkReports).toHaveLength(0);
      const target = point === 'before-compute' ? forkReports[0]! : report;
      expect(gate.data).toMatchObject({ autonomy: { actionClass: 'report.publish', contentHash: target.snapshotHash } });
      expect((await getReport(TENANT, orgA, target.reportId))?.status).toBe('in_review');
      const selfReview = await review(adminCookie, forkId, gate.nodeId, 'accept');
      expect(selfReview.status, selfReview.raw).toBe(403);
      const approved = await review(forkReviewerCookie, forkId, gate.nodeId, 'accept');
      expect(approved.status, approved.raw).toBe(200);
      await __awaitRunResumeChainForTests(forkId);
      expect((await storage.getRun(forkId))?.status, JSON.stringify(await storage.listEvents(forkId))).toBe('completed');
      expect(await getReport(TENANT, orgA, target.reportId)).toMatchObject({ status: 'published', snapshot: target.snapshot, snapshotHash: target.snapshotHash });
      expect((await storage.getRun(runId))?.status).toBe('waiting-approval');
      expect(await getReport(TENANT, orgA, report.reportId)).toMatchObject({ snapshot: report.snapshot, snapshotHash: report.snapshotHash });
    } finally {
      for (const id of [forkId, runId]) {
        const pending = await storage.listOpenInterrupts(id);
        for (const gate of pending) {
          const rejected = await review(forkReviewerCookie, id, gate.nodeId, 'reject');
          expect(rejected.status, rejected.raw).toBe(200);
          await __awaitRunResumeChainForTests(id);
        }
      }
    }
  });

  it('run-now refuses another client, a foreign definition and the disabled feature', async () => {
    const def = await newDefinition();
    const foreign = await call<DefRes>(adminCookie, 'POST', `/clients/${orgB}/report-definitions`, DEF);
    expect(foreign.status, foreign.raw).toBe(201);
    for (const [org, id] of [[orgB, foreign.body.definition.definitionId], [orgA, foreign.body.definition.definitionId]]) {
      const result = await call(operatorCookie, 'POST', `/clients/${org}/report-definitions/${id}/runs`, {});
      expect(result.status, result.raw).toBe(404);
      expect(result.body).not.toHaveProperty('runId');
    }
    const toggle = getToggleDefault('campaign-ops.client-reports')!;
    await saveConfig({ ...toggle, status: 'off' }, 'test');
    try {
      const result = await call(operatorCookie, 'POST', `/clients/${orgA}/report-definitions/${def.definitionId}/runs`, {});
      expect(result.status, result.raw).toBe(404);
      expect(result.body).not.toHaveProperty('runId');
    } finally { await saveConfig({ ...toggle, status: 'on' }, 'test'); }
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

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
  it('compute-snapshot and report-snapshot-read work; another run cannot publish the report', async () => {
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
    // Each surface() fixture has a different run id. Publication cannot borrow
    // the report computed by a different run.
    await expect(opsNodes['feature.campaign-ops.nodes.publish-report'](ctx({ orgId: orgA, reportId: out.reportId, snapshotHash: out.snapshotHash })))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'report_not_from_this_run' } });
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
    _resetChainBackedWorkflowsForTest();
    try {
      expect(getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID)).toBeUndefined();
      const before = (await call<{ definitions: ReportDefinition[] }>(operatorCookie, 'GET', `/clients/${orgA}/report-definitions`)).body.definitions.length;
      const response = await call(operatorCookie, 'POST', `/clients/${orgA}/report-definitions`, { ...DEF, schedule: { cron: '0 9 1 * *' } });
      expect(response.status).toBe(400);
      expect(response.raw).toContain('workflow is installed');
      expect((await call<{ definitions: ReportDefinition[] }>(operatorCookie, 'GET', `/clients/${orgA}/report-definitions`)).body.definitions).toHaveLength(before);
    } finally { restoreReportChain(); }
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
