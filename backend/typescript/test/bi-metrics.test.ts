/**
 * ADR 0417 P1 — the semantic metric catalog + evaluator.
 *  - closed-world validation: unknown type/field/op and non-numeric aggregate
 *    fields are typed 422s at WRITE time (never stored-then-failing);
 *  - system metrics are in-code, merged into reads, read-only;
 *  - runMetric evaluates over BOTH row paths (kernel system rows via the
 *    service layer; user-type rows via queryEntities), applies stored filters +
 *    bounded caller params only, groups, buckets, and stays tenant-isolated.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createEntityType, createEntity } from '../src/features/entities/entitiesService.js';
import { createDeal } from '../src/features/crm/entities/deals.js';
import { listMetrics, getMetric, createMetric, updateMetric, deleteMetric, runMetric } from '../src/features/bi/biService.js';

let server: http.Server;
const T1 = 'tenant-bi-1';
const T2 = 'tenant-bi-2';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });

  // Kernel rows: two deals in T1 (mints crm.deal for the tenant), one in T2.
  const validateCompany = async (): Promise<boolean> => true;
  const validateContact = async (): Promise<boolean> => true;
  await createDeal({ tenantId: T1, orgId: 'org-1', title: 'Alpha', amount: 1000, closeDate: '2026-07-01', createdBy: 'u1', validateCompany, validateContact });
  await createDeal({ tenantId: T1, orgId: 'org-1', title: 'Beta', amount: 3000, closeDate: '2026-07-15', createdBy: 'u1', validateCompany, validateContact });
  await createDeal({ tenantId: T2, orgId: 'org-x', title: 'Foreign', amount: 999_999, closeDate: '2026-07-02', createdBy: 'u2', validateCompany, validateContact });

  // A user type + rows in T1 for the queryEntities path.
  await createEntityType({
    tenantId: T1, name: 'ticket', displayName: 'Ticket', createdBy: 'u1',
    fields: [
      { key: 'subject', label: 'Subject', type: 'string', required: true },
      { key: 'hours', label: 'Hours', type: 'number', required: false },
      { key: 'severity', label: 'Severity', type: 'enum', required: false, options: ['low', 'high'] },
    ],
  });
  for (const [subject, hours, severity] of [['a', 2, 'low'], ['b', 4, 'high'], ['c', 6, 'high']] as const) {
    await createEntity({ tenantId: T1, typeName: 'ticket', values: { subject, hours, severity }, createdBy: 'u1' });
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('closed-world validation (write time)', () => {
  it('rejects an unknown entity type', async () => {
    await expect(createMetric(T1, 'u1', 'bad-type', { title: 'X', entityType: 'nope', aggregate: 'count' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
  it('rejects a non-allowlisted system type', async () => {
    await expect(createMetric(T1, 'u1', 'bad-sys', { title: 'X', entityType: 'crm.activity', aggregate: 'count' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
  it('rejects sum over a non-number field and unknown fields/ops', async () => {
    await expect(createMetric(T1, 'u1', 'bad-field', { title: 'X', entityType: 'ticket', aggregate: 'sum', field: 'subject' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(createMetric(T1, 'u1', 'bad-gb', { title: 'X', entityType: 'ticket', aggregate: 'count', groupBy: 'ghost' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(createMetric(T1, 'u1', 'bad-op', { title: 'X', entityType: 'ticket', aggregate: 'count', filters: [{ key: 'severity', op: 'like', value: 'x' }] }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('catalog CRUD + system metrics', () => {
  it('merges in-code system metrics into reads; they are read-only', async () => {
    const all = await listMetrics(T1);
    expect(all.some((m) => m.metricId === 'sys-pipeline-value' && m.system)).toBe(true);
    await expect(updateMetric(T1, 'sys-pipeline-value', { title: 'X', entityType: 'crm.deal', aggregate: 'count' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteMetric(T1, 'sys-pipeline-value')).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('creates, updates, and deletes a tenant metric; duplicate id conflicts', async () => {
    const m = await createMetric(T1, 'u1', 'ticket-hours', {
      title: 'Ticket hours', entityType: 'ticket', aggregate: 'sum', field: 'hours',
      filters: [{ key: 'severity', op: 'eq', value: 'high' }], groupBy: 'severity',
    });
    expect(m.metricId).toBe('ticket-hours');
    await expect(createMetric(T1, 'u1', 'ticket-hours', { title: 'Dup', entityType: 'ticket', aggregate: 'count' }))
      .rejects.toMatchObject({ code: 'conflict' });
    const upd = await updateMetric(T1, 'ticket-hours', { title: 'Hours (high)', entityType: 'ticket', aggregate: 'sum', field: 'hours' });
    expect(upd.title).toBe('Hours (high)');
    expect(upd.filters).toBeUndefined(); // update replaces the definition
    expect(await getMetric(T1, 'ticket-hours')).toMatchObject({ title: 'Hours (high)' });
    await deleteMetric(T1, 'ticket-hours');
    expect(await getMetric(T1, 'ticket-hours')).toBeNull();
  });
});

describe('runMetric — evaluation', () => {
  it('sums kernel deal amounts, org-scoped and tenant-isolated', async () => {
    const r = await runMetric(T1, 'sys-pipeline-value', { orgId: 'org-1' });
    expect(r.points.length).toBeGreaterThanOrEqual(1);
    const total = r.points.reduce((s, p) => s + p.value, 0);
    expect(total).toBe(4000); // 1000 + 3000 — never the foreign tenant's 999999
  });
  it('an org with no rows aggregates to nothing', async () => {
    const r = await runMetric(T1, 'sys-pipeline-value', { orgId: 'org-empty' });
    expect(r.points).toEqual([]);
  });
  it('buckets by month over the timeField', async () => {
    const r = await runMetric(T1, 'sys-pipeline-value', { orgId: 'org-1', bucket: 'month' });
    expect(r.bucket).toBe('month');
    expect(r.points).toEqual([{ key: '2026-07', value: 4000, n: 2 }]);
  });
  it('range params filter via the timeField', async () => {
    const r = await runMetric(T1, 'sys-pipeline-value', { orgId: 'org-1', since: '2026-07-10' });
    expect(r.points.reduce((s, p) => s + p.value, 0)).toBe(3000); // Beta only
  });
  it('evaluates user-type metrics with stored filters + groupBy over queryEntities', async () => {
    await createMetric(T1, 'u1', 'high-ticket-hours', {
      title: 'High ticket hours', entityType: 'ticket', aggregate: 'sum', field: 'hours',
      filters: [{ key: 'severity', op: 'eq', value: 'high' }], groupBy: 'severity',
    });
    const r = await runMetric(T1, 'high-ticket-hours', { orgId: 'org-1' });
    expect(r.points).toEqual([{ key: 'high', value: 10, n: 2 }]); // 4 + 6, ticket 'a' filtered out
  });
  it('rejects range/bucket runs on a metric without a timeField, and groupBy+bucket together', async () => {
    await expect(runMetric(T1, 'sys-company-count', { orgId: 'org-1', bucket: 'month' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(runMetric(T1, 'sys-pipeline-value', { orgId: 'org-1', bucket: 'month', groupBy: 'stage_id' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
  it('a kernel type never minted for the tenant returns an honest empty result', async () => {
    const r = await runMetric('tenant-bi-fresh', 'sys-product-count', { orgId: 'org-1' });
    expect(r.points).toEqual([]);
    expect(r.totalRows).toBe(0);
  });
});

describe('ADR 0417 P2 — chat tools (toggle-gated, fail-empty)', () => {
  const exec = async (name: string, input: Record<string, unknown>, scope: { tenantId: string; actingUserId?: string }) => {
    const { createAgentToolProvider, builtinAgentToolIds } = await import('../src/host/agentToolProvider.js');
    expect(builtinAgentToolIds()).toContain(name);
    return createAgentToolProvider({ tenantId: scope.tenantId, runId: 'run-bi', ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}) }).executeTool({ name, input });
  };

  it('list/run tools fail EMPTY when the toggle is off or no acting user', async () => {
    // Toggle is OFF by default → empty note, never data.
    const offRes = await exec('openwop:bi.list-metrics', {}, { tenantId: T1, actingUserId: 'u1' });
    expect(JSON.parse(offRes.content).metrics).toEqual([]);
    // No acting user (system run) → empty even with the toggle on later.
    const anonRes = await exec('openwop:bi.run-metric', { metricId: 'sys-deal-count', orgId: 'org-1' }, { tenantId: T1 });
    expect(JSON.parse(anonRes.content).result).toBeNull();
  });

  it('with the toggle on + acting user, run-metric returns governed numbers; bad params are typed errors', async () => {
    const { saveConfig } = await import('../src/host/featureToggles/service.js');
    const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
    const d = getToggleDefault('bi');
    expect(d).toBeTruthy();
    await saveConfig({ ...d!, status: 'on' }, 'test');
    const ok = await exec('openwop:bi.run-metric', { metricId: 'sys-pipeline-value', orgId: 'org-1' }, { tenantId: T1, actingUserId: 'u1' });
    const parsed = JSON.parse(ok.content) as { result: { points: Array<{ value: number }> } };
    expect(parsed.result.points.reduce((s, p) => s + p.value, 0)).toBe(4000);
    const bad = await exec('openwop:bi.run-metric', { metricId: 'sys-company-count', orgId: 'org-1', bucket: 'month' }, { tenantId: T1, actingUserId: 'u1' });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content).error.code).toBe('validation_error');
  });
});

describe('ADR 0417 P3 — feature.bi.nodes', () => {
  it('run-metric wraps the surface and emits an interactive.chart artifact envelope', async () => {
    // @ts-expect-error — .mjs pack module has no type declarations (pure-JS node pack).
    const { nodes } = await import('../../../packs/feature.bi.nodes/index.mjs');
    const ctx = {
      inputs: { metricId: 'sys-pipeline-value', orgId: 'org-1', bucket: 'month' },
      features: { bi: (await import('../src/features/bi/surface.js')).buildBiSurface({ tenantId: T1 }) },
    };
    const out = await nodes['feature.bi.nodes.run-metric'](ctx);
    expect(out.status).toBe('success');
    expect(out.outputs.result.points.length).toBeGreaterThan(0);
    expect(out.outputs.artifact.artifactTypeId).toBe('interactive.chart');
    expect(out.outputs.artifact.payload.chartType).toBe('line'); // bucketed → line
    expect(out.outputs.artifact.payload.data.labels).toContain('2026-07');
    // Honest-off: without the surface the node fails with host_capability_missing.
    await expect(nodes['feature.bi.nodes.run-metric']({ inputs: {}, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});
