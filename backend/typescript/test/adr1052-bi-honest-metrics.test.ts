/**
 * ADR 1052 — BI honest metrics. A wrong number is a typed failure, a partial one says
 * so, and the catalog belongs to one org. Every case drives an EXIT (the HTTP route,
 * the chat tool, the run surface), never a helper, and every case was RED on
 * `origin/main` `46301fb8f` before the fix.
 *
 * Red when: an org's catalog shows or lets another org's admin edit its metrics
 * (route, tool, run surface: D0); the list omits `viewer.canManage` (D11); a metric
 * over a removed field, a removed enum option or a deleted type answers with a number
 * instead of `metric_stale` (D1), or the catalog does not flag it; a user type is
 * org-scoped by a field that happens to be named `org_id` (D2); the group cap is silent
 * or keeps the wrong groups (D3); a free-text `since` runs, a date-only `until` drops
 * that day's datetimes, undated rows form a bucket, or a bounded series is not
 * zero-filled (D4); the evaluator reads an empty org as every org (D6); a filter value
 * of the wrong kind is stored (D7); a stale `expectedUpdatedAt` saves (D8); the run
 * surface lists `createdBy` (D9); the tool hides the stale field (D10); an erased
 * author stays on a metric (D13); "Open deals" counts won or lost deals (D14).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createEntityType, createEntity, updateEntityType, deleteEntityType } from '../src/features/entities/entitiesService.js';
import { createDeal } from '../src/features/crm/entities/deals.js';
import { runMetric, deleteMetric } from '../src/features/bi/biService.js';
import { metrics as metricRows, __metricsForErasure } from '../src/features/bi/metricStore.js';
import { deleteOrg } from '../src/host/accessControlService.js';
import { buildBiSurface } from '../src/features/bi/surface.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { BI_LIST_METRICS_TOOL_ID, BI_RUN_METRIC_TOOL_ID } from '../src/features/bi/agentTools.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'bi', 'entities']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = unknown> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const text = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T = unknown>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: <T = unknown>(p: string) => call<T>('DELETE', p),
  };
}
type Login = { user: { userId: string } };
interface Metric { metricId: string; createdBy?: string; updatedAt?: string; stale?: { field: string }; system?: boolean }
interface Point { key: string; value: number; n: number }
interface RunResult { points: Point[]; totalRows: number; scope?: string; groupsTruncated?: boolean; droppedGroups?: number; undatedRows?: number; truncated?: boolean }
interface ErrBody { error: string; details?: { reason?: string; field?: string; metricId?: string } }

const bi = (orgId: string): string => `/host/openwop-app/bi/orgs/${encodeURIComponent(orgId)}`;
let n = 0;
const ok = async (): Promise<boolean> => true;

/** One tenant, two orgs. The owner holds both; `adminA` administers org A only; `viewerA`
 *  only reads org A. */
async function world() {
  const tenantId = `org:a1052-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post<Login>('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
  const adminA = client();
  const adminAId = (await adminA.post<Login>('/host/openwop-app/test/login', { email: `a-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
  const viewerA = client();
  const viewerAId = (await viewerA.post<Login>('/host/openwop-app/test/login', { email: `v-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgA = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'A' })).body.orgId;
  const orgB = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'B' })).body.orgId;
  expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'Admin A', subject: adminAId, roles: ['admin'] })).status).toBeLessThan(300);
  expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'Viewer A', subject: viewerAId, roles: ['viewer'] })).status).toBeLessThan(300);
  // Mints the kernel `crm.deal` type for the tenant (metrics over it validate against it).
  await createDeal({ tenantId, orgId: orgB, title: 'seed', amount: 1, status: 'won', createdBy: ownerId, validateCompany: ok, validateContact: ok });
  return { tenantId, owner, ownerId, adminA, adminAId, viewerA, orgA, orgB };
}

const scopeFor = (tenantId: string, actingUserId: string): BundleScope => ({ tenantId, actingUserId });

describe('D0 — the catalog belongs to one org', () => {
  it('an org-A admin cannot see, edit or delete an org-B metric, on any lane', async () => {
    const w = await world();
    expect((await w.owner.post(`${bi(w.orgB)}/metrics`, { metricId: 'b-only', title: 'B only', entityType: 'crm.deal', aggregate: 'count' })).status).toBe(201);

    const listA = await w.adminA.get<{ metrics: Metric[] }>(`${bi(w.orgA)}/metrics`);
    expect(listA.status).toBe(200);
    expect(listA.body.metrics.map((m) => m.metricId)).not.toContain('b-only');
    expect((await w.adminA.patch(`${bi(w.orgA)}/metrics/b-only`, { title: 'hijacked', entityType: 'crm.deal', aggregate: 'count' })).status).toBe(404);
    expect((await w.adminA.del(`${bi(w.orgA)}/metrics/b-only`)).status).toBe(404);
    expect((await w.adminA.post(`${bi(w.orgA)}/metrics/b-only/run`, {})).status).toBe(404);
    // An org-A metric of the SAME id is its own row, not a conflict with org B's.
    expect((await w.adminA.post(`${bi(w.orgA)}/metrics`, { metricId: 'b-only', title: 'A copy', entityType: 'crm.deal', aggregate: 'count' })).status).toBe(201);
    const listB = await w.owner.get<{ metrics: Array<Metric & { title: string }> }>(`${bi(w.orgB)}/metrics`);
    expect(listB.body.metrics.find((m) => m.metricId === 'b-only')?.title).toBe('B only');

    // The chat tool and the run surface list the named org's catalog only.
    const tool = builtinAgentTool(BI_LIST_METRICS_TOOL_ID)!;
    const viaTool = JSON.parse((await tool.run({ orgId: w.orgA }, scopeFor(w.tenantId, w.ownerId))).content as string) as { metrics: Metric[] };
    expect(viaTool.metrics.filter((m) => m.metricId === 'b-only')).toHaveLength(1);
    const viaToolB = JSON.parse((await tool.run({ orgId: w.orgB }, scopeFor(w.tenantId, w.ownerId))).content as string) as { metrics: Array<Metric & { title: string }> };
    expect(viaToolB.metrics.find((m) => m.metricId === 'b-only')?.title).toBe('B only');
    const surface = buildBiSurface(scopeFor(w.tenantId, w.adminAId));
    const viaSurface = (await surface.listMetrics!({ orgId: w.orgA })) as { metrics: Array<Metric & { title: string }> };
    expect(viaSurface.metrics.find((m) => m.metricId === 'b-only')?.title).toBe('A copy');
    // adminA is not a member of org B: the run lane refuses it.
    await expect(surface.listMetrics!({ orgId: w.orgB })).rejects.toMatchObject({ httpStatus: 403 });
    // RI-7: an org still holding metrics is not deleted out from under them.
    expect((await deleteOrg(w.orgA)).blocked?.rows).toBeGreaterThanOrEqual(1);
  });
});

describe('D11 — the list says what the caller may do', () => {
  it('a manager gets canManage:true, a viewer canManage:false', async () => {
    const w = await world();
    const asOwner = await w.owner.get<{ viewer?: { canManage: boolean } }>(`${bi(w.orgA)}/metrics`);
    const asViewer = await w.viewerA.get<{ viewer?: { canManage: boolean } }>(`${bi(w.orgA)}/metrics`);
    expect(asOwner.body.viewer).toEqual({ canManage: true });
    expect(asViewer.body.viewer).toEqual({ canManage: false });
  });
});

describe('D1 — a stale definition is a typed failure, never a number', () => {
  it('removed field, removed enum option, deleted type → metric_stale on the route, the catalog and the tool', async () => {
    const w = await world();
    const fields = [
      { key: 'subject', label: 'Subject', type: 'string', required: true },
      { key: 'hours', label: 'Hours', type: 'number', required: false },
      { key: 'state', label: 'State', type: 'enum', required: false, options: ['open', 'closed'] },
    ];
    await createEntityType({ tenantId: w.tenantId, name: 'job', displayName: 'Job', fields, createdBy: w.ownerId });
    for (const [subject, hours, state] of [['a', 2, 'open'], ['b', 4, 'closed'], ['c', 6, 'open']] as const) {
      await createEntity({ tenantId: w.tenantId, typeName: 'job', values: { subject, hours, state }, createdBy: w.ownerId });
    }
    expect((await w.owner.post(`${bi(w.orgA)}/metrics`, { metricId: 'open-hours', title: 'Open hours', entityType: 'job', aggregate: 'sum', field: 'hours', filters: [{ key: 'state', op: 'neq', value: 'closed' }] })).status).toBe(201);
    const fresh = await w.owner.post<{ result: RunResult }>(`${bi(w.orgA)}/metrics/open-hours/run`, {});
    expect(fresh.body.result.points).toEqual([{ key: 'all', value: 8, n: 2 }]);

    // The option the filter names is removed: `neq 'closed'` would now match EVERY row.
    await updateEntityType({ tenantId: w.tenantId, name: 'job', patch: { fields: [fields[0], fields[1], { ...fields[2], options: ['open', 'done'] }] }, actor: w.ownerId });
    const staleOpt = await w.owner.post<ErrBody>(`${bi(w.orgA)}/metrics/open-hours/run`, {});
    expect(staleOpt.status).toBe(422);
    expect(staleOpt.body.details).toMatchObject({ reason: 'metric_stale', field: 'state', metricId: 'open-hours' });
    // A filtered field that changes KIND is stale too: `neq 'closed'` on a number field
    // would match every row (grade-code H1).
    await updateEntityType({ tenantId: w.tenantId, name: 'job', patch: { fields: [fields[0], fields[1], { key: 'state', label: 'State', type: 'number', required: false }] }, actor: w.ownerId });
    const kindList = await w.owner.get<{ metrics: Metric[] }>(`${bi(w.orgA)}/metrics`);
    expect(kindList.body.metrics.find((m) => m.metricId === 'open-hours')?.stale).toEqual({ field: 'state' });

    // The aggregated field changes kind: `sum` over a string is stale, not 0.
    await updateEntityType({ tenantId: w.tenantId, name: 'job', patch: { fields: [fields[0], { ...fields[1], type: 'string' }, fields[2]] }, actor: w.ownerId });
    const retyped = await w.owner.post<ErrBody>(`${bi(w.orgA)}/metrics/open-hours/run`, {});
    expect(retyped.status).toBe(422);
    expect(retyped.body.details).toMatchObject({ reason: 'metric_stale', field: 'hours' });

    // The aggregated field is removed.
    await updateEntityType({ tenantId: w.tenantId, name: 'job', patch: { fields: [fields[0], fields[2]] }, actor: w.ownerId });
    const staleField = await w.owner.post<ErrBody>(`${bi(w.orgA)}/metrics/open-hours/run`, {});
    expect(staleField.status).toBe(422);
    expect(staleField.body.details).toMatchObject({ reason: 'metric_stale', field: 'hours' });
    const listed = await w.owner.get<{ metrics: Metric[] }>(`${bi(w.orgA)}/metrics`);
    expect(listed.body.metrics.find((m) => m.metricId === 'open-hours')?.stale).toEqual({ field: 'hours' });
    const toolOut = JSON.parse((await builtinAgentTool(BI_RUN_METRIC_TOOL_ID)!.run({ metricId: 'open-hours', orgId: w.orgA }, scopeFor(w.tenantId, w.ownerId))).content as string) as { error?: { details?: { reason?: string; field?: string } } };
    expect(toolOut.error?.details).toMatchObject({ reason: 'metric_stale', field: 'hours' });

    // The type is deleted: never an "honest empty" zero.
    // (A type with rows cannot be deleted, so the deleted type is an empty one.)
    await createEntityType({ tenantId: w.tenantId, name: 'gone', displayName: 'Gone', fields: [fields[0]], createdBy: w.ownerId });
    expect((await w.owner.post(`${bi(w.orgA)}/metrics`, { metricId: 'job-count', title: 'Jobs', entityType: 'gone', aggregate: 'count' })).status).toBe(201);
    await deleteEntityType({ tenantId: w.tenantId, name: 'gone' });
    const gone = await w.owner.post<ErrBody>(`${bi(w.orgA)}/metrics/job-count/run`, {});
    expect(gone.status).toBe(422);
    expect(gone.body.details).toMatchObject({ reason: 'metric_stale', field: 'entityType' });
  });
});

describe('D2/D3/D4 — scope, caps and dates are stated, never silent', () => {
  it('a user type is tenant-scoped even when it has a field named org_id', async () => {
    const w = await world();
    await createEntityType({ tenantId: w.tenantId, name: 'visit', displayName: 'Visit', createdBy: w.ownerId, fields: [
      { key: 'org_id', label: 'Org', type: 'string', required: false },
      { key: 'at', label: 'At', type: 'string', required: false },
      { key: 'k', label: 'K', type: 'string', required: false },
    ] });
    await createEntity({ tenantId: w.tenantId, typeName: 'visit', values: { org_id: 'elsewhere', at: '2026-07-15T10:00:00Z' }, createdBy: w.ownerId });
    await createEntity({ tenantId: w.tenantId, typeName: 'visit', values: { at: '2026-05-03' }, createdBy: w.ownerId });
    await createEntity({ tenantId: w.tenantId, typeName: 'visit', values: { at: 'soon' }, createdBy: w.ownerId });
    expect((await w.owner.post(`${bi(w.orgA)}/metrics`, { metricId: 'visits', title: 'Visits', entityType: 'visit', aggregate: 'count', timeField: 'at' })).status).toBe(201);
    const all = await w.owner.post<{ result: RunResult }>(`${bi(w.orgA)}/metrics/visits/run`, {});
    expect(all.body.result).toMatchObject({ scope: 'tenant', totalRows: 3, points: [{ key: 'all', value: 3, n: 3 }] });

    // D4: a date-only `until` covers the whole day; free text is refused.
    const upTo = await w.owner.post<{ result: RunResult }>(`${bi(w.orgA)}/metrics/visits/run`, { since: '2026-07-15', until: '2026-07-15' });
    expect(upTo.body.result.points).toEqual([{ key: 'all', value: 1, n: 1 }]);
    expect((await w.owner.post<ErrBody>(`${bi(w.orgA)}/metrics/visits/run`, { since: 'last month' })).status).toBe(422);

    // D4: undated rows are counted, not bucketed; a bounded count series is zero-filled.
    const monthly = await w.owner.post<{ result: RunResult }>(`${bi(w.orgA)}/metrics/visits/run`, { bucket: 'month', since: '2026-05-01', until: '2026-07-31' });
    expect(monthly.body.result.points).toEqual([
      { key: '2026-05', value: 1, n: 1 }, { key: '2026-06', value: 0, n: 0 }, { key: '2026-07', value: 1, n: 1 },
    ]);
    const unbounded = await w.owner.post<{ result: RunResult }>(`${bi(w.orgA)}/metrics/visits/run`, { bucket: 'month' });
    expect(unbounded.body.result.undatedRows).toBe(1);
    expect(unbounded.body.result.points.map((p) => p.key)).toEqual(['2026-05', '2026-07']);

    // A series too long to zero-fill is refused, not silently cut short (grade-code M4);
    // and only groups that held rows count as dropped (L5).
    expect((await w.owner.post(`${bi(w.orgA)}/metrics/visits/run`, { bucket: 'day', since: '1990-01-01', until: '2030-01-01' })).status).toBe(422);
    const long = await w.owner.post<{ result: RunResult }>(`${bi(w.orgA)}/metrics/visits/run`, { bucket: 'day', since: '2026-01-01', until: '2026-09-30' });
    expect(long.body.result).toMatchObject({ groupsTruncated: true, droppedGroups: 1 }); // the May visit; the rest were empty days
    expect(long.body.result.points.at(-1)?.key).toBe('2026-09-30');
    expect(long.body.result.points.find((p) => p.key === '2026-07-15')).toEqual({ key: '2026-07-15', value: 1, n: 1 });
  });

  it('more than 100 groups: flagged, and the groups with the most rows are the ones kept', async () => {
    const w = await world();
    await createEntityType({ tenantId: w.tenantId, name: 'tag', displayName: 'Tag', createdBy: w.ownerId, fields: [{ key: 'k', label: 'K', type: 'string', required: false }] });
    for (let i = 0; i < 101; i += 1) await createEntity({ tenantId: w.tenantId, typeName: 'tag', values: { k: `a${String(i).padStart(3, '0')}` }, createdBy: w.ownerId });
    // `zzz` sorts last by key; with three rows it must survive the cut.
    for (let i = 0; i < 3; i += 1) await createEntity({ tenantId: w.tenantId, typeName: 'tag', values: { k: 'zzz' }, createdBy: w.ownerId });
    expect((await w.owner.post(`${bi(w.orgA)}/metrics`, { metricId: 'tags', title: 'Tags', entityType: 'tag', aggregate: 'count', groupBy: 'k' })).status).toBe(201);
    const r = (await w.owner.post<{ result: RunResult }>(`${bi(w.orgA)}/metrics/tags/run`, {})).body.result;
    expect(r.points).toHaveLength(100);
    expect(r).toMatchObject({ groupsTruncated: true, droppedGroups: 2 });
    expect(r.points.find((p) => p.key === 'zzz')).toEqual({ key: 'zzz', value: 3, n: 3 });
  });

  it('the evaluator refuses an empty org rather than reading every org', async () => {
    const w = await world();
    await createDeal({ tenantId: w.tenantId, orgId: w.orgA, title: 'x', amount: 5, createdBy: w.ownerId, validateCompany: ok, validateContact: ok });
    await expect(runMetric(w.tenantId, 'sys-pipeline-value', { orgId: '' }, undefined)).rejects.toMatchObject({ httpStatus: 422 });
  });
});

describe('D7/D8 — closed-world writes, versioned', () => {
  it('a filter value of the wrong kind or a non-option enum value is refused at write', async () => {
    const w = await world();
    await createEntityType({ tenantId: w.tenantId, name: 'lead', displayName: 'Lead', createdBy: w.ownerId, fields: [
      { key: 'score', label: 'Score', type: 'number', required: false },
      { key: 'tier', label: 'Tier', type: 'enum', required: false, options: ['gold', 'silver'] },
    ] });
    const gt = await w.owner.post<ErrBody>(`${bi(w.orgA)}/metrics`, { metricId: 'hot', title: 'Hot', entityType: 'lead', aggregate: 'count', filters: [{ key: 'score', op: 'gt', value: '100' }] });
    expect(gt.status).toBe(422);
    const opt = await w.owner.post<ErrBody>(`${bi(w.orgA)}/metrics`, { metricId: 'bronze', title: 'Bronze', entityType: 'lead', aggregate: 'count', filters: [{ key: 'tier', op: 'eq', value: 'bronze' }] });
    expect(opt.status).toBe(422);
    // grade-code H1 — EVERY op compares like with like: `neq '0'` on a number field
    // matched every row (a 0 is not the string '0'), `eq 2` on a text field matched none.
    const neq = await w.owner.post<ErrBody & { details?: { index?: number } }>(`${bi(w.orgA)}/metrics`, { metricId: 'nonzero', title: 'Non-zero', entityType: 'lead', aggregate: 'count', filters: [{ key: 'tier', op: 'eq', value: 'gold' }, { key: 'score', op: 'neq', value: '0' }] });
    expect(neq.status).toBe(422);
    expect(neq.body.details).toMatchObject({ field: 'filters', index: 1 });
    expect((await w.owner.post(`${bi(w.orgA)}/metrics`, { metricId: 'tier-two', title: 'Tier 2', entityType: 'lead', aggregate: 'count', filters: [{ key: 'tier', op: 'eq', value: 2 }] })).status).toBe(422);
  });

  it('a delete whose row changed after it was read is a 409, never a removal of the newer row', async () => {
    const w = await world();
    expect((await w.owner.post(`${bi(w.orgA)}/metrics`, { metricId: 'racy', title: 'Racy', entityType: 'crm.deal', aggregate: 'count' })).status).toBe(201);
    const [current] = (await __metricsForErasure(w.tenantId)).filter((m) => m.metricId === 'racy');
    // The delete reads an OLDER copy than what is stored (a concurrent edit landed between).
    const spy = vi.spyOn(metricRows, 'get').mockResolvedValueOnce({ ...current!, title: 'Racy (old)' });
    try {
      await expect(deleteMetric(w.tenantId, w.orgA, 'racy')).rejects.toMatchObject({ httpStatus: 409 });
    } finally { spy.mockRestore(); }
    expect((await w.owner.get(`${bi(w.orgA)}/metrics/racy`)).status).toBe(200);
  });

  it('a PATCH carrying a stale expectedUpdatedAt is a 409, and the newer edit survives', async () => {
    const w = await world();
    const created = await w.owner.post<{ metric: Metric }>(`${bi(w.orgA)}/metrics`, { metricId: 'deals', title: 'Deals', entityType: 'crm.deal', aggregate: 'count' });
    const v0 = created.body.metric.updatedAt!;
    await new Promise((r) => setTimeout(r, 5));
    expect((await w.owner.patch(`${bi(w.orgA)}/metrics/deals`, { title: 'Deals (first)', entityType: 'crm.deal', aggregate: 'count', expectedUpdatedAt: v0 })).status).toBe(200);
    const late = await w.owner.patch<ErrBody>(`${bi(w.orgA)}/metrics/deals`, { title: 'Deals (late)', entityType: 'crm.deal', aggregate: 'count', expectedUpdatedAt: v0 });
    expect(late.status).toBe(409);
    const after = await w.owner.get<{ metric: { title: string } }>(`${bi(w.orgA)}/metrics/deals`);
    expect(after.body.metric.title).toBe('Deals (first)');
  });
});

describe('D9/D14 — the run surface projection; system deal metrics mean what they say', () => {
  it('"Open deals" and "Pipeline value" exclude won and lost deals; the surface lists no createdBy', async () => {
    const w = await world();
    const mk = (title: string, amount: number, status?: string) =>
      createDeal({ tenantId: w.tenantId, orgId: w.orgA, title, amount, ...(status ? { status } : {}), createdBy: w.ownerId, validateCompany: ok, validateContact: ok });
    await mk('open', 100);
    await mk('won', 1000, 'won');
    await mk('lost', 10000, 'lost');
    await mk('open2', 1, 'open');
    const count = await w.owner.post<{ result: RunResult }>(`${bi(w.orgA)}/metrics/sys-deal-count/run`, { groupBy: 'org_id' });
    expect(count.body.result.points.reduce((a, p) => a + p.value, 0)).toBe(2);
    const value = await w.owner.post<{ result: RunResult }>(`${bi(w.orgA)}/metrics/sys-pipeline-value/run`, { groupBy: 'org_id' });
    expect(value.body.result.points.reduce((a, p) => a + p.value, 0)).toBe(101);

    // D1 build pin: every in-code deal metric validates against the minted kernel schema.
    const catalog = await w.owner.get<{ metrics: Metric[] }>(`${bi(w.orgA)}/metrics`);
    for (const id of ['sys-deal-count', 'sys-pipeline-value', 'sys-avg-deal-size']) {
      expect(catalog.body.metrics.find((m) => m.metricId === id)).toMatchObject({ system: true });
      expect(catalog.body.metrics.find((m) => m.metricId === id)?.stale).toBeUndefined();
    }

    expect((await w.owner.post(`${bi(w.orgA)}/metrics`, { metricId: 'mine', title: 'Mine', entityType: 'crm.deal', aggregate: 'count' })).status).toBe(201);
    const listed = (await buildBiSurface(scopeFor(w.tenantId, w.ownerId)).listMetrics!({ orgId: w.orgA })) as { metrics: Array<Record<string, unknown>> };
    const mine = listed.metrics.find((m) => m.metricId === 'mine')!;
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty('createdBy');
    expect(mine).not.toHaveProperty('tenantId');
  });
});

describe('D13 — DSAR re-attributes the author', () => {
  it("an erased member's createdBy becomes the sentinel; the metric survives", async () => {
    const w = await world();
    expect((await w.adminA.post(`${bi(w.orgA)}/metrics`, { metricId: 'by-a', title: 'By A', entityType: 'crm.deal', aggregate: 'count' })).status).toBe(201);
    const mod = await import('../src/features/bi/erasure.js');
    await mod.eraseSubjectBiMetrics(w.tenantId, w.adminAId);
    const after = await w.owner.get<{ metric: Metric }>(`${bi(w.orgA)}/metrics/by-a`);
    expect(after.status).toBe(200);
    // The route never shows the author (D9); the stored row is what the eraser changed.
    expect(after.body.metric).not.toHaveProperty('createdBy');
    const row = (await __metricsForErasure(w.tenantId)).find((m) => m.metricId === 'by-a');
    expect(row?.createdBy).toBe('[erased]');
  });
});

describe('D2 pin — every kernel metric type declares the org column the evaluator scopes on', () => {
  it('each KERNEL_METRIC_TYPES owner declares an org_id scalar', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { KERNEL_METRIC_TYPES } = await import('../src/features/bi/metricTypes.js');
    const owners: Record<string, string> = {
      'crm.deal': 'crm/entities/deals.ts', 'crm.company': 'crm/entities/companies.ts',
      'commerce.product': 'commerce/commerceService.ts', 'cms.page': 'cms/cmsService.ts', 'servicedesk.ticket': 'service-desk/tickets.ts',
    };
    expect(Object.keys(owners).sort()).toEqual([...KERNEL_METRIC_TYPES].sort());
    for (const file of Object.values(owners)) {
      expect(readFileSync(join(__dirname, '..', 'src', 'features', file), 'utf8')).toMatch(/\{\s*key:\s*'org_id'/);
    }
  });
});

describe('BI84WF-12 — a pre-1052 tenant-wide metric does not vanish on upgrade', () => {
  it('is listed read-only and runnable in every org, refuses edits, and a manager adopts it into one org', async () => {
    const w = await world();
    const now = new Date().toISOString();
    // A row exactly as ADR 0417 wrote it: tenant-wide, no org, keyed `tenant:metricId`.
    await metricRows.put({ metricId: 'old-deals', tenantId: w.tenantId, title: 'Old deals', entityType: 'crm.deal', aggregate: 'count', createdBy: w.ownerId, createdAt: now, updatedAt: now });
    for (const org of [w.orgA, w.orgB]) {
      const list = await w.owner.get<{ metrics: Array<Metric & { legacy?: boolean }> }>(`${bi(org)}/metrics`);
      expect(list.body.metrics.find((m) => m.metricId === 'old-deals')).toMatchObject({ legacy: true });
    }
    expect((await w.owner.post(`${bi(w.orgB)}/metrics/old-deals/run`, {})).status).toBe(200);
    const edit = await w.adminA.patch<ErrBody>(`${bi(w.orgA)}/metrics/old-deals`, { title: 'x', entityType: 'crm.deal', aggregate: 'count' });
    expect(edit.status).toBe(409);
    expect(edit.body.details).toMatchObject({ reason: 'metric_legacy' });
    expect((await w.adminA.del<ErrBody>(`${bi(w.orgA)}/metrics/old-deals`)).status).toBe(409);
    // Adopting needs the manage scope in that org (the viewer cannot).
    expect((await w.viewerA.post(`${bi(w.orgA)}/metrics/old-deals/adopt`, {})).status).toBe(403);
    expect((await w.adminA.post(`${bi(w.orgA)}/metrics/old-deals/adopt`, {})).status).toBe(200);
    const inA = await w.owner.get<{ metrics: Array<Metric & { legacy?: boolean }> }>(`${bi(w.orgA)}/metrics`);
    expect(inA.body.metrics.find((m) => m.metricId === 'old-deals')?.legacy).toBeUndefined();
    const inB = await w.owner.get<{ metrics: Metric[] }>(`${bi(w.orgB)}/metrics`);
    expect(inB.body.metrics.map((m) => m.metricId)).not.toContain('old-deals');
    // Now an ordinary org-A metric: editable there.
    expect((await w.adminA.patch(`${bi(w.orgA)}/metrics/old-deals`, { title: 'Deals (A)', entityType: 'crm.deal', aggregate: 'count' })).status).toBe(200);
  });
});

describe('re-grade L2 — the eraser finishes the tenant before it reports a failure', () => {
  it('a metric that keeps changing does not stop the others being re-attributed', async () => {
    const w = await world();
    for (const id of ['aa-first', 'zz-second']) {
      expect((await w.adminA.post(`${bi(w.orgA)}/metrics`, { metricId: id, title: id, entityType: 'crm.deal', aggregate: 'count' })).status).toBe(201);
    }
    const orig = metricRows.compareAndSwap.bind(metricRows);
    const spy = vi.spyOn(metricRows, 'compareAndSwap').mockImplementation(async (expected, next) => (expected?.metricId === 'aa-first' ? false : orig(expected, next)));
    const mod = await import('../src/features/bi/erasure.js');
    try {
      await expect(mod.eraseSubjectBiMetrics(w.tenantId, w.adminAId)).rejects.toThrow(/aa-first/);
    } finally { spy.mockRestore(); }
    const rows = await __metricsForErasure(w.tenantId);
    expect(rows.find((m) => m.metricId === 'zz-second')?.createdBy).toBe('[erased]');
  });
});

