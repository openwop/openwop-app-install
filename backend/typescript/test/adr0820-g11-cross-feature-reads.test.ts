/**
 * ADR 0820 §7 / strategy G11 — a feature that READS another feature's data gates
 * on the SOURCE feature (toggle + plan):
 *   - CMS page-experiment results read the analytics event store → `analytics`;
 *   - strategy KR metric sync reads crm / analytics / commerce → each source;
 *     a refused source contributes NOTHING (a skip, never a confirmed 0);
 *   - Production's vendor→company link reads crm → `crm`.
 * Each refusal has a positive control (an entitled tenant is served).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const listEventsForExperiment = vi.fn(async (_t: string, _o: string, _e: string) => []);
const summarize = vi.fn(async (_t: string, _o: string) => ({ total: 10, byType: { conversion: 3 } }));
vi.mock('../src/features/analytics/analyticsService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/analytics/analyticsService.js')>()),
  listEventsForExperiment: (t: string, o: string, e: string) => listEventsForExperiment(t, o, e),
  summarize: (t: string, o: string) => summarize(t, o),
}));

vi.mock('../src/features/cms/cmsService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/cms/cmsService.js')>()),
  getPage: async () => ({ pageId: 'p1' }),
}));

const listDeals = vi.fn(async (_t: string, _o: string) => [{ amount: 100 }, { amount: 50 }]);
const getCompany = vi.fn(async (_t: string, _o: string, id: string) => ({ companyId: id }));
vi.mock('../src/features/crm/crmEntitiesService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/crm/crmEntitiesService.js')>()),
  listDeals: (t: string, o: string) => listDeals(t, o),
  getCompany: (t: string, o: string, id: string) => getCompany(t, o, id),
}));

const strategyFor = (tenantId: string): unknown => ({
  id: `s-${tenantId}`, tenantId, scope: 'org', status: 'active',
  objectives: [{ id: 'o1', keyResults: [
    { id: 'kr-crm', measure: { source: { kind: 'crm-deal-total', orgId: 'org1' } } },
    { id: 'kr-anl', measure: { source: { kind: 'analytics-conversions', orgId: 'org1' } } },
  ] }],
});
vi.mock('../src/features/strategy/strategyService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/strategy/strategyService.js')>()),
  listStrategies: async (tenantId: string) => [strategyFor(tenantId)],
}));
const appendCheckIn = vi.fn(async (_input: unknown) => undefined);
vi.mock('../src/features/strategy/checkIns.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/strategy/checkIns.js')>()),
  appendCheckIn: (input: unknown) => appendCheckIn(input),
}));

import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerTenantEntitlementCheck } from '../src/host/entitlementSeam.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { OpenwopError } from '../src/types.js';
import { createExperiment, experimentResults } from '../src/features/cms/pageExperimentsService.js';
import { syncSourcedKrs } from '../src/features/strategy/metricSync.js';
import { resolveCompanyRef, type Ctx } from '../src/features/production/routes.js';

const FEATURES = ['analytics', 'crm', 'commerce'];
const storage = openSqliteStorage(':memory:');

beforeAll(() => {
  initHostExtPersistence(storage);
  for (const id of FEATURES) registerToggleDefault({ id, status: 'on', bucketUnit: 'tenant', salt: id });
});
afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
beforeEach(async () => {
  initHostExtPersistence(storage);
  await __clearToggleStore();
  for (const id of FEATURES) await saveConfig({ id, status: 'on', bucketUnit: 'tenant', salt: id }, 'test');
  // `lapsed*` tenants: the plan excludes ANALYTICS only (crm stays entitled), so
  // the metric-sync case can show one source refused and its sibling served.
  registerTenantEntitlementCheck(async (tenantId, featureId) => {
    if (tenantId.startsWith('lapsed') && featureId === 'analytics') throw new OpenwopError('forbidden', 'plan', 403, { feature: featureId });
    if (tenantId.startsWith('nocrm') && featureId === 'crm') throw new OpenwopError('forbidden', 'plan', 403, { feature: featureId });
  });
  vi.clearAllMocks();
});

async function experimentFor(tenantId: string): Promise<string> {
  const exp = await createExperiment({
    tenantId, orgId: 'org1', pageId: 'p1', name: 'x', createdBy: 'u',
    variants: [{ key: 'a', versionId: null, weight: 50 }, { key: 'b', versionId: null, weight: 50 }],
  });
  return exp.experimentId;
}

describe('G11 — CMS page-experiment results gate on analytics', () => {
  it('a tenant whose plan excludes analytics gets a typed 403 and the analytics store is never read', async () => {
    const id = await experimentFor('lapsed-cms');
    const err = await experimentResults('lapsed-cms', 'org1', 'p1', id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect((err as OpenwopError).httpStatus).toBe(403);
    expect((err as OpenwopError).details).toMatchObject({ feature: 'analytics', reason: 'not_entitled' });
    expect(listEventsForExperiment).not.toHaveBeenCalled();
  });

  it('POSITIVE: an entitled tenant gets results', async () => {
    const id = await experimentFor('acme-cms');
    const res = await experimentResults('acme-cms', 'org1', 'p1', id);
    expect(res?.experimentId).toBe(id);
    expect(listEventsForExperiment).toHaveBeenCalledTimes(1);
  });

  it('an unknown experiment is still a plain not-found (null) before any feature answer', async () => {
    expect(await experimentResults('lapsed-cms', 'org1', 'p1', 'pexp:missing')).toBeNull();
  });
});

describe('G11 — strategy KR metric sync gates each source feature', () => {
  it('a refused source contributes nothing (a skip, no check-in) while an entitled sibling syncs', async () => {
    const out = await syncSourcedKrs('lapsed-strat', 'u');
    expect(out.synced.map((s) => s.krId)).toEqual(['kr-crm']);
    expect(out.skipped.map((s) => s.krId)).toEqual(['kr-anl']);
    expect(out.skipped[0]!.reason).toMatch(/^source_feature_unavailable/);
    expect(summarize).not.toHaveBeenCalled();
    expect(appendCheckIn).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE: an entitled tenant syncs both sources', async () => {
    const out = await syncSourcedKrs('acme-strat', 'u');
    expect(out.synced.map((s) => s.krId).sort()).toEqual(['kr-anl', 'kr-crm']);
    expect(appendCheckIn).toHaveBeenCalledTimes(2);
  });
});

describe('G11 — Production vendor→company link gates on crm', () => {
  const ctx = (tenantId: string): Ctx => ({ tenantId, orgId: 'org1', user: { userId: 'u1' } } as unknown as Ctx);

  it('a tenant whose plan excludes crm cannot link a company (typed 403, no crm read)', async () => {
    const err = await resolveCompanyRef(ctx('nocrm-prod'), 'co-1').catch((e: unknown) => e);
    expect((err as OpenwopError).httpStatus).toBe(403);
    expect((err as OpenwopError).details).toMatchObject({ feature: 'crm', field: 'companyId' });
    expect(getCompany).not.toHaveBeenCalled();
  });

  it('POSITIVE: an entitled tenant links; clearing a link never needs crm', async () => {
    expect(await resolveCompanyRef(ctx('acme-prod'), 'co-1')).toBe('co-1');
    expect(await resolveCompanyRef(ctx('nocrm-prod'), undefined)).toBeUndefined();
  });
});
