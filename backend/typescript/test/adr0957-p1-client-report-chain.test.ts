/**
 * ADR 0957 P1 — the `client-report` chain and its ADR 0942 `report.publish` gate.
 *
 *   - the chain loads through the REAL loader and is registered same-id:
 *     compute → autonomy-gate(report.publish) → publish, with the hash and report
 *     id carried on recorded output edges;
 *   - publishing is decided host-side from the RUN: a client-bound run frozen
 *     with the client's policy (ADR 0942 P2b) publishes only after the gate's
 *     approval interrupt in this run is explicitly approved for the same snapshot and policy; an unresolved,
 *     rejected or wrong-class interrupt is `report_publish_unapproved`; an
 *     unstamped run (autonomy toggles off at start) is `report_publish_ungated`,
 *     never a legacy pass;
 *   - a scheduled slot and the run-now route both start the chain with the
 *     campaign-ops stamp, so the client's policy is frozen into the run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { createClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import { createDefinition, getReport, listReports, parseDefinition } from '../src/features/campaign-ops/reports/reportService.js';
import { CLIENT_REPORT_CHAIN_ID, reportJobId, syncReportSchedule } from '../src/features/campaign-ops/reports/schedule.js';
import { getJob } from '../src/host/schedulingService.js';
import { buildCampaignOpsSurface } from '../src/features/campaign-ops/surface.js';
import { CLIENT_REPORT_PERIOD_KEY } from '../src/features/campaign-ops/reports/periodStamp.js';
import { stripReservedRunMetadata } from '../src/host/runDispatch.js';
import { AUTONOMY_STAMP_KEY, AUTONOMY_TOGGLE, decideGate } from '../src/host/autonomyPolicy/index.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { recordRevision, HOST_REVISION_TENANT } from '../src/host/workflowRevisions.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { expandChain, findUnfilledExpansionParams, loadWorkflowChainPacks, listChains, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { persistRecords } from '../src/features/campaign-connectors/performanceService.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const TENANT = 'default';
const OPS = 'openwop-app.campaignOps';
const GATE = 'feature.campaign-orchestration.nodes.autonomy-gate';
let storage: Storage;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

async function insertRun(orgId: string, lineage: Partial<Pick<RunRecord, 'parentRunId' | 'parentSeq' | 'forkMode' | 'metadata'>> = {}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    ...lineage, runId: `r957-${randomUUID()}`, workflowId: CLIENT_REPORT_CHAIN_ID, tenantId: TENANT, status: 'running', inputs: {},
    metadata: lineage.metadata ?? { [OPS]: { orgId } }, configurable: {}, createdAt: now, updatedAt: now,
  };
  const definition = getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID);
  if (!definition) throw new Error('report chain missing');
  await recordRevision(HOST_REVISION_TENANT, definition);
  await insertRunWithStartContext(storage, run, { definition });
  const stored = await storage.getRun(run.runId);
  if (!stored) throw new Error('run not stored');
  return stored;
}

async function gateNodeId(): Promise<string> {
  const def = await getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID);
  const gate = def?.nodes.find((n) => n.typeId.replace(/@.*$/, '') === GATE);
  if (!gate) throw new Error('the chain has no review gate');
  return gate.nodeId;
}

async function gateInterrupt(runId: string, nodeId: string, actionClass: string, snapshotHash: string, resolution?: unknown, policyHash?: string): Promise<void> {
  const run = await storage.getRun(runId);
  if (!run) throw new Error('run missing');
  const verdict = decideGate({ run, actionClass: 'report.publish', facts: {}, contentHash: snapshotHash, toggleOn: true });
  if (verdict.mode !== 'approve') throw new Error(`expected review, got ${verdict.mode}`);
  const interruptId = `int-${randomUUID()}`;
  const data = { key: 'autonomy-gate', ...verdict.interruptData, autonomy: { ...verdict.interruptData.autonomy, actionClass, ...(policyHash ? { policyHash } : {}) } };
  await storage.insertInterrupt({ interruptId, runId, nodeId, kind: 'approval', token: randomBytes(8).toString('hex'), data, createdAt: new Date().toISOString() });
  if (resolution !== undefined) {
    await storage.resolveInterrupt(interruptId, resolution, new Date().toISOString());
    await getEventLog().append({ runId, nodeId, type: 'interrupt.resolved', payload: { interruptId, kind: 'approval', decision: 'accepted', action: 'accept' } });
  }
}

let orgId = '';
let definitionId = '';
let definitionVersion = 1;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  // CMS is always on (ADR 0027); the KPI source still has its own gate.
  for (const id of ['campaign-ops', 'campaign-ops.client-reports', 'campaign-connectors']) await setToggle(id, true);
  orgId = (await createClient({ tenantId: TENANT, createdBy: 'u-1', name: `Client ${randomBytes(3).toString('hex')}` })).orgId;
  await updateClient(TENANT, orgId, { mode: 'live' });
  const def = await createDefinition(TENANT, orgId, await parseDefinition(TENANT, orgId, { title: 'Monthly', sections: [{ kind: 'kpi' }], period: { kind: 'month', timezone: 'UTC' } }), 'u-1');
  definitionId = def.definitionId;
  definitionVersion = def.version;
  await persistRecords(TENANT, orgId, [{ platform: 'meta', campaignName: 'Q4', adSet: 'A', date: '2026-09-01', spend: 100, impressions: 800, clicks: 40, conversions: 2, revenue: 100, ctr: 0.05, cpc: 2.5, cvr: 0.05, cpa: 50, roas: 1, currency: 'USD' }], 'csv');
});
afterAll(() => undefined);
beforeEach(async () => {
  await setToggle('campaign-orchestration', true);
  await setToggle(AUTONOMY_TOGGLE, true);
});

describe('ADR 0957 P1 — the client-report chain through the real loader', () => {
  it('compute → report.publish gate → publish; effect inputs use recorded outputs', () => {
    _resetChainRegistryForTest();
    const out = loadWorkflowChainPacks({ roots: [join(REPO, 'examples', 'workflow-chain-packs')] });
    expect(out.errors.filter((e) => e.pack.includes('campaign-ops-reporting'))).toEqual([]);
    const c = listChains().find((x) => x.chain.chainId === CLIENT_REPORT_CHAIN_ID);
    expect(c).toBeTruthy();
    const nodes = c!.chain.dag.nodes;
    expect(nodes.map((n) => n.typeId.replace(/@.*$/, ''))).toEqual(['feature.campaign-ops.nodes.compute-snapshot', GATE, 'feature.campaign-ops.nodes.publish-report']);
    expect(nodes[1]!.config).toMatchObject({ actionClass: 'report.publish' });
    expect((c!.chain.dag.edges ?? []).map((e) => `${e.from}>${e.to}`)).toEqual([
      'compute.orgId>review.orgId', 'compute.orgId>publish.orgId',
      'compute.reportId>review.reportId', 'compute.snapshotHash>review.contentHash',
      'compute.snapshotHash>review.snapshotHash', 'compute.snapshot>review.snapshot',
      'compute.reportId>publish.reportId', 'compute.snapshotHash>publish.snapshotHash', 'review>publish.review',
    ]);
    expect(findUnfilledExpansionParams(expandChain(c!.chain, {}))).toEqual([]);
    expect(c!.chain.dag.edges?.every(edge => edge.triggerRule === 'all_success')).toBe(true);
    expect((c!.chain.producedVariables ?? []).map((v) => v.name).sort()).toEqual(['reportId', 'snapshotHash']);
  });

  it('is registered same-id, with the review gate in the registered definition', async () => {
    expect(await gateNodeId()).toBeTruthy();
  });
});

describe('ADR 0957 P1 — configuration is pinned on the host-bound run', () => {
  const pinned = () => ({ orgId, definitionId, definitionVersion, periodStart: '2026-09-01', periodEnd: '2026-09-30' });
  const surfaceFor = (runId?: string, tenantId = TENANT) => buildCampaignOpsSurface({ tenantId, orgScopeSubject: 'u-1', ...(runId ? { runId } : {}) });

  it('computes from stored configuration without author-time parameters or mutable run inputs', async () => {
    const run = await insertRun(orgId, { metadata: { [OPS]: pinned() } });
    await storage.updateRun(run.runId, { inputs: { orgId: 'another-client', definitionId: 'another-definition' } });
    const out = await surfaceFor(run.runId).computeReportSnapshot!({});
    expect(out).toMatchObject({ orgId });
    expect(await getReport(TENANT, orgId, String(out.reportId))).toMatchObject({
      orgId, definitionId, definitionVersion, periodStart: '2026-09-01', periodEnd: '2026-09-30', runId: run.runId,
    });
  });

  it.each(['orgId', 'definitionId', 'definitionVersion', 'periodStart', 'periodEnd'] as const)('cannot retarget the pinned %s through a node input', async field => {
    const run = await insertRun(orgId, { metadata: { [OPS]: pinned() } });
    const before = await listReports(TENANT, orgId, definitionId);
    const value = field === 'definitionVersion' ? definitionVersion + 1 : 'different';
    await expect(surfaceFor(run.runId).computeReportSnapshot!({ [field]: value })).rejects.toMatchObject({
      details: { reason: 'report_run_config_changed', field },
    });
    expect(await listReports(TENANT, orgId, definitionId)).toEqual(before);
  });

  it.each(['no report stamp', 'incomplete pin', 'wrong tenant', 'no run'] as const)('a parameterless copy with %s refuses before creating a report', async mode => {
    const run = await insertRun(orgId, { metadata: { [OPS]: mode === 'no report stamp' ? { orgId } : mode === 'incomplete pin' ? { orgId, definitionId } : pinned() } });
    const before = await listReports(TENANT, orgId, definitionId);
    const s = surfaceFor(mode === 'no run' ? undefined : run.runId, mode === 'wrong tenant' ? 'other-tenant' : TENANT);
    await expect(s.computeReportSnapshot!({})).rejects.toMatchObject({ details: { reason: 'report_run_unbound' } });
    expect(await listReports(TENANT, orgId, definitionId)).toEqual(before);
  });

  it('a stored stale definition pin refuses even when node inputs are empty', async () => {
    const run = await insertRun(orgId, { metadata: { [OPS]: { ...pinned(), definitionVersion: definitionVersion + 1 } } });
    const before = await listReports(TENANT, orgId, definitionId);
    await expect(surfaceFor(run.runId).computeReportSnapshot!({})).rejects.toMatchObject({ details: { reason: 'report_definition_changed' } });
    expect(await listReports(TENANT, orgId, definitionId)).toEqual(before);
  });
});

describe('ADR 0957 P1b — reporting dates survive delayed execution and forks', () => {
  const reportPin = () => ({ orgId, definitionId, definitionVersion });
  const compute = (runId: string) => buildCampaignOpsSurface({ tenantId: TENANT, orgScopeSubject: 'u-1', runId }).computeReportSnapshot!({});

  it('uses the creation month after dispatch crosses into the next month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-31T23:59:00Z'));
      const run = await insertRun(orgId, { metadata: { [OPS]: reportPin() } });
      vi.setSystemTime(new Date('2026-11-01T00:01:00Z'));
      const out = await compute(run.runId);
      expect(await getReport(TENANT, orgId, String(out.reportId))).toMatchObject({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
      expect(run.metadata).toMatchObject({ [CLIENT_REPORT_PERIOD_KEY]: { version: 1, ...reportPin(), periodStart: '2026-09-01', periodEnd: '2026-09-30' } });
    } finally { vi.useRealTimers(); }
  });

  it('a branch before computation inherits the same dates in a later month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-31T23:59:00Z'));
      const parent = await insertRun(orgId, { metadata: { [OPS]: reportPin() } });
      vi.setSystemTime(new Date('2026-12-01T00:01:00Z'));
      const fork = await insertRun(orgId, { parentRunId: parent.runId, parentSeq: 1, forkMode: 'branch', metadata: parent.metadata });
      const out = await compute(fork.runId);
      expect(await getReport(TENANT, orgId, String(out.reportId))).toMatchObject({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
      expect(fork.metadata).toMatchObject({ [CLIENT_REPORT_PERIOD_KEY]: (parent.metadata as Record<string, unknown>)[CLIENT_REPORT_PERIOD_KEY] });
    } finally { vi.useRealTimers(); }
  });

  it('a derived run without a frozen period refuses instead of filling the inherited absence', async () => {
    const run = await insertRun(orgId, { parentRunId: 'legacy-parent', parentSeq: 1, forkMode: 'branch', metadata: { [OPS]: reportPin() } });
    expect((run.metadata as Record<string, unknown>)[CLIENT_REPORT_PERIOD_KEY]).toBeUndefined();
    const before = await listReports(TENANT, orgId, definitionId);
    await expect(compute(run.runId)).rejects.toMatchObject({ details: { reason: 'report_period_unbound' } });
    expect(await listReports(TENANT, orgId, definitionId)).toEqual(before);
  });

  it('refuses a period stamp for another definition before creating a report', async () => {
    const run = await insertRun(orgId, { metadata: { [OPS]: reportPin() } });
    const metadata = run.metadata as Record<string, unknown>;
    const period = metadata[CLIENT_REPORT_PERIOD_KEY] as Record<string, unknown>;
    await storage.updateRun(run.runId, { metadata: { ...metadata, [CLIENT_REPORT_PERIOD_KEY]: { ...period, definitionId: 'different' } } });
    const before = await listReports(TENANT, orgId, definitionId);
    await expect(compute(run.runId)).rejects.toMatchObject({ details: { reason: 'report_period_unbound' } });
    expect(await listReports(TENANT, orgId, definitionId)).toEqual(before);
  });

  it('strips a caller-supplied period decision at the reserved metadata boundary', () => {
    expect(stripReservedRunMetadata({ [CLIENT_REPORT_PERIOD_KEY]: { periodStart: '2099-01-01' }, ordinary: 'kept' })).toEqual({ ordinary: 'kept' });
  });
});

describe('ADR 0957 P1 — publishing needs THIS run\'s report.publish approval', () => {
  const computeIn = async (run: RunRecord) => {
    const s = buildCampaignOpsSurface({ tenantId: TENANT, orgScopeSubject: 'u-1', runId: run.runId });
    const c = await s.computeReportSnapshot!({ orgId, definitionId, definitionVersion });
    return { s, reportId: String(c.reportId), snapshotHash: String(c.snapshotHash) };
  };

  it('a client-bound run is frozen with the client policy; an approved gate publishes exactly the computed numbers', async () => {
    const run = await insertRun(orgId);
    expect((run.metadata as Record<string, unknown>)[AUTONOMY_STAMP_KEY]).toMatchObject({ orgId, source: 'client' });
    const { s, reportId, snapshotHash } = await computeIn(run);
    await gateInterrupt(run.runId, await gateNodeId(), 'report.publish', snapshotHash, { action: 'approve' });
    const out = await s.publishReport!({ orgId, reportId, snapshotHash });
    expect(out).toMatchObject({ reportId, status: 'published', approvedVia: 'approved' });
    expect((await getReport(TENANT, orgId, reportId))?.status).toBe('published');
  });

  const branchFixture = async (mutation = 'valid') => {
    const parent = await insertRun(orgId);
    const { reportId, snapshotHash } = await computeIn(parent);
    const definition = getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID)!;
    const nodeId = definition.nodes.find(node => node.typeId.replace(/@.*$/, '') === 'feature.campaign-ops.nodes.compute-snapshot')!.nodeId;
    const source = await getEventLog().append({ runId: parent.runId, nodeId, type: 'node.completed', payload: { outputs: { reportId, snapshotHash } } });
    const child = await insertRun(orgId, {
      metadata: structuredClone(parent.metadata),
      forkMode: mutation === 'replay' ? 'replay' : 'branch', parentRunId: parent.runId,
      parentSeq: mutation === 'outside checkpoint' ? 0 : source.sequence + 1,
    });
    const prefix = await storage.listEvents(parent.runId, { fromSeq: -1, limit: source.sequence + 1 });
    for (const event of prefix) {
      const target = event.eventId === source.eventId;
      if (target && mutation === 'no copied output') continue;
      await getEventLog().append({
        runId: child.runId, nodeId: target && mutation === 'wrong node' ? 'not-compute' : event.nodeId,
        type: event.type, causationId: target && mutation === 'wrong origin event' ? randomUUID() : event.eventId,
        payload: target && mutation === 'wrong hash' ? { outputs: { reportId, snapshotHash: 'a'.repeat(64) } }
          : target && mutation === 'changed payload' ? { outputs: { reportId, snapshotHash }, extra: 'not inherited' } : event.payload,
      });
    }
    const s = buildCampaignOpsSurface({ tenantId: TENANT, orgScopeSubject: 'u-1', runId: child.runId });
    return { parent, child, s, reportId, snapshotHash };
  };

  it('an inherited computation still needs the branch own approval, even when its parent is approved', async () => {
    const { parent, child, s, reportId, snapshotHash } = await branchFixture();
    await gateInterrupt(parent.runId, await gateNodeId(), 'report.publish', snapshotHash, { action: 'approve' });
    await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: 'report_publish_unapproved' } });
    await gateInterrupt(child.runId, await gateNodeId(), 'report.publish', snapshotHash, { action: 'approve' });
    expect(await s.publishReport!({ orgId, reportId, snapshotHash })).toMatchObject({ reportId, status: 'published', approvedVia: 'approved' });
  });

  it.each(['no copied output', 'wrong origin event', 'wrong hash', 'changed payload', 'wrong node', 'outside checkpoint', 'wrong client', 'replay'])(
    'a branch with %s cannot publish even with its own approval', async mutation => {
      const { child, s, reportId, snapshotHash } = await branchFixture(mutation);
      await gateInterrupt(child.runId, await gateNodeId(), 'report.publish', snapshotHash, { action: 'approve' });
      if (mutation === 'wrong client') await storage.updateRun(child.runId, { metadata: { ...child.metadata, [OPS]: { orgId: 'another-client' } } });
      await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: mutation === 'wrong client' ? 'wrong_client' : 'report_not_from_this_run' } });
      expect((await getReport(TENANT, orgId, reportId))?.status).toBe('in_review');
    },
  );

  it('an unresolved, rejected or wrong-class gate interrupt does not publish', async () => {
    for (const [cls, resolution] of [['report.publish', undefined], ['report.publish', { action: 'reject' }], ['report.publish', null], ['report.publish', { action: 'skip' }], ['report.publish', { action: 'approve', cancelled: true }], ['plan.approve', { action: 'approve' }]] as const) {
      const run = await insertRun(orgId);
      const { s, reportId, snapshotHash } = await computeIn(run);
      await gateInterrupt(run.runId, await gateNodeId(), cls, snapshotHash, resolution);
      await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: 'report_publish_unapproved' } });
      expect((await getReport(TENANT, orgId, reportId))?.status).toBe('in_review');
    }
  });

  it('an approval at a node that is not the chain\'s review gate does not count', async () => {
    const run = await insertRun(orgId);
    const { s, reportId, snapshotHash } = await computeIn(run);
    await gateInterrupt(run.runId, 'some-other-node', 'report.publish', snapshotHash, { action: 'approve' });
    await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: 'report_publish_unapproved' } });
  });

  it.each([
    ['skipped', { action: 'skip' }, false],
    ['empty', null, false],
    ['cancelled', { action: 'approve', cancelled: true }, false],
    ['cascaded', { action: 'approve', cascadedFromParent: true }, false],
    ['unrelated node', { action: 'approve' }, true],
  ] as const)('an earlier %s resolution cannot hide a later valid approval', async (_label, resolution, unrelated) => {
    const run = await insertRun(orgId);
    const { s, reportId, snapshotHash } = await computeIn(run);
    const reviewNode = await gateNodeId();
    await gateInterrupt(run.runId, unrelated ? 'some-other-node' : reviewNode, 'report.publish', snapshotHash, resolution);
    await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: 'report_publish_unapproved' } });
    expect((await getReport(TENANT, orgId, reportId))?.status).toBe('in_review');
    await gateInterrupt(run.runId, reviewNode, 'report.publish', snapshotHash, { action: 'approve' });
    await expect(s.publishReport!({ orgId, reportId, snapshotHash })).resolves.toMatchObject({ status: 'published', approvedVia: 'approved' });
    expect((await getReport(TENANT, orgId, reportId))?.status).toBe('published');
  });

  it('an approval for different figures leaves this report in review', async () => {
    const run = await insertRun(orgId);
    const { s, reportId, snapshotHash } = await computeIn(run);
    await gateInterrupt(run.runId, await gateNodeId(), 'report.publish', '0'.repeat(64), { action: 'approve' });
    await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: 'report_publish_unapproved' } });
    expect((await getReport(TENANT, orgId, reportId))?.status).toBe('in_review');
  });

  it('a matching snapshot approved under a different policy cannot publish', async () => {
    const run = await insertRun(orgId);
    const { s, reportId, snapshotHash } = await computeIn(run);
    await gateInterrupt(run.runId, await gateNodeId(), 'report.publish', snapshotHash, { action: 'approve' }, 'f'.repeat(64));
    await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: 'report_publish_unapproved' } });
    expect((await getReport(TENANT, orgId, reportId))?.status).toBe('in_review');
  });

  it.each(['missing', 'pruned'] as const)('a %s as-run revision never falls back to the current report chain', async (condition) => {
    const run = await insertRun(orgId);
    const { s, reportId, snapshotHash } = await computeIn(run);
    await gateInterrupt(run.runId, await gateNodeId(), 'report.publish', snapshotHash, { action: 'approve' });
    const gateId = await gateNodeId();
    const metadata = { ...run.metadata };
    if (condition === 'missing') delete metadata.definitionRevision;
    else metadata.definitionRevision = '0'.repeat(64);
    await storage.updateRun(run.runId, { metadata });
    expect(getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID)?.nodes.some((node) => node.nodeId === gateId)).toBe(true);
    await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: 'report_publish_unapproved' } });
    expect((await getReport(TENANT, orgId, reportId))?.status).toBe('in_review');
  });

  it.each(['preview', 'archived'] as const)('a client made %s after approval cannot publish', async (condition) => {
    const run = await insertRun(orgId);
    const { s, reportId, snapshotHash } = await computeIn(run);
    await gateInterrupt(run.runId, await gateNodeId(), 'report.publish', snapshotHash, { action: 'approve' });
    await updateClient(TENANT, orgId, condition === 'preview' ? { mode: 'preview' } : { status: 'archived' });
    try {
      await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: 'report_publish_ungated' } });
      expect((await getReport(TENANT, orgId, reportId))?.status).toBe('in_review');
    } finally { await updateClient(TENANT, orgId, { status: 'active', mode: 'live' }); }
  });

  it('a client paused after approval cannot publish', async () => {
    const run = await insertRun(orgId);
    const { s, reportId, snapshotHash } = await computeIn(run);
    await gateInterrupt(run.runId, await gateNodeId(), 'report.publish', snapshotHash, { action: 'approve' });
    await updateClient(TENANT, orgId, { status: 'paused' });
    try {
      await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toBeDefined();
      expect((await getReport(TENANT, orgId, reportId))?.status).toBe('in_review');
    } finally { await updateClient(TENANT, orgId, { status: 'active' }); }
  });

  it('an unstamped run (autonomy off at start) is ungated: never a legacy pass', async () => {
    await setToggle(AUTONOMY_TOGGLE, false);
    const run = await insertRun(orgId);
    expect((run.metadata as Record<string, unknown>)[AUTONOMY_STAMP_KEY]).toBeUndefined();
    const { s, reportId, snapshotHash } = await computeIn(run);
    await expect(s.publishReport!({ orgId, reportId, snapshotHash })).rejects.toMatchObject({ details: { reason: 'report_publish_ungated' } });
  });
});

describe('ADR 0957 P1 — scheduled slots carry the client stamp', () => {
  it('the job metadata binds the fired run to the client (and so freezes its policy)', async () => {
    const def = await createDefinition(TENANT, orgId, await parseDefinition(TENANT, orgId, { title: 'Weekly', sections: [{ kind: 'kpi' }], period: { kind: 'week', timezone: 'UTC' }, schedule: { cron: '0 9 * * 1' } }), 'u-1');
    await syncReportSchedule(def, 'u-1');
    const job = await getJob(reportJobId(TENANT, orgId, def.definitionId));
    expect(job?.workflowId).toBe(CLIENT_REPORT_CHAIN_ID);
    expect(job?.metadata?.[OPS]).toEqual({ orgId, definitionId: def.definitionId, definitionVersion: def.version });
  });
});
