/**
 * ADR 0292 — resilient example-data seeding.
 *
 * Covers the three seams that make a full demo seed survive prod delivery:
 *   1. `runExampleDataSeed` streams each step via `onStep` (drives NDJSON).
 *   2. the request-timeout resolver gives the seed routes the batch budget.
 *   3. `provisionDemoFeatures` enables the demo toggles PER-TENANT (never global),
 *      idempotently — the DG-SEED-7 fix that keeps seeders pure.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { registerToggleDefault, __resetToggleDefaults } from '../src/host/featureToggles/registry.js';
import { resolveOne, purgeTenantOverrides, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { runExampleDataSeed } from '../src/host/exampleDataSeeders.js';
import type { StepResult } from '../src/host/exampleDataSeeders.js';
import { provisionDemoFeatures } from '../src/host/demoProvision.js';
import {
  resolveTimeoutForRequest,
  isBatchSeedRoute,
  DEFAULT_BATCH_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
} from '../src/middleware/requestTimeout.js';

const asReq = (method: string, path: string): Request => ({ method, path } as Request);

describe('ADR 0292 — request-timeout budget for seed routes', () => {
  it('gives the example-data seed routes the batch budget', () => {
    for (const p of ['seed', 'run', 'clear', 'provision-demo']) {
      const req = asReq('POST', `/v1/host/openwop-app/example-data/${p}`);
      expect(isBatchSeedRoute(req)).toBe(true);
      expect(resolveTimeoutForRequest(req)).toBe(DEFAULT_BATCH_REQUEST_TIMEOUT_MS);
    }
  });

  it('keeps the tight default for ordinary routes and the LLM budget for interrupts', () => {
    expect(resolveTimeoutForRequest(asReq('GET', '/v1/host/openwop-app/example-data/status'))).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutForRequest(asReq('POST', '/v1/runs/r1/interrupts/n1'))).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(isBatchSeedRoute(asReq('POST', '/v1/runs'))).toBe(false);
  });
});

describe('ADR 0292 — runExampleDataSeed onStep emitter', () => {
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
  });

  it('emits one event per completed step, matching the aggregate results', async () => {
    const emitted: StepResult[] = [];
    const result = await runExampleDataSeed('adr0292-emit', await openStorage('memory://'), {
      steps: ['demo-people'],
      onStep: (r) => { emitted.push(r); },
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(emitted.map((e) => e.step)).toEqual(result.results.map((r) => r.step));
    expect(emitted).toEqual(result.results);
  });

  it('a throwing onStep never aborts the seed (client-disconnect safety)', async () => {
    const result = await runExampleDataSeed('adr0292-throw', await openStorage('memory://'), {
      steps: ['demo-people'],
      onStep: () => { throw new Error('client hung up'); },
    });
    expect(result.summary.total).toBeGreaterThan(0);
    expect(result.success).toBe(true);
  });
});

describe('ADR 0292 — provisionDemoFeatures (DG-SEED-7)', () => {
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    __resetToggleDefaults();
    await __clearToggleStore();
    // Two demo features default OFF; the rest of the demo set is unregistered.
    registerToggleDefault({ id: 'crm', status: 'off', bucketUnit: 'tenant', salt: 'crm' });
    registerToggleDefault({ id: 'commerce', status: 'off', bucketUnit: 'tenant', salt: 'commerce' });
  });

  it('enables demo features for the tenant only, idempotently, never globally', async () => {
    const first = await provisionDemoFeatures('demo-t1', 'test');
    expect(first.enabled).toEqual(expect.arrayContaining(['crm', 'commerce']));
    // unknown demo ids (not registered here) are reported, not crashed on.
    expect(first.unknown.length).toBeGreaterThan(0);

    // Enabled for THIS tenant…
    expect((await resolveOne('crm', { tenantId: 'demo-t1' }))?.enabled).toBe(true);
    expect((await resolveOne('commerce', { tenantId: 'demo-t1' }))?.enabled).toBe(true);
    // …but NOT for another tenant (per-tenant override, not global default).
    expect((await resolveOne('crm', { tenantId: 'other-t2' }))?.enabled).toBe(false);

    // Idempotent: a second run changes nothing.
    const second = await provisionDemoFeatures('demo-t1', 'test');
    expect(second.enabled).not.toContain('crm');
    expect(second.alreadyOn).toEqual(expect.arrayContaining(['crm', 'commerce']));
  });

  it('provisions concurrently without a lost update (SEED-RS-3 CAS)', async () => {
    // Two tenants enabled against the SAME shared toggle rows at once — the old
    // get→merge→save would clobber one; the CAS loop must land both.
    const [a, b] = await Promise.all([
      provisionDemoFeatures('race-a', 'test'),
      provisionDemoFeatures('race-b', 'test'),
    ]);
    expect(a.enabled).toEqual(expect.arrayContaining(['crm', 'commerce']));
    expect(b.enabled).toEqual(expect.arrayContaining(['crm', 'commerce']));
    // BOTH overrides survived (neither write was lost).
    expect((await resolveOne('crm', { tenantId: 'race-a' }))?.enabled).toBe(true);
    expect((await resolveOne('crm', { tenantId: 'race-b' }))?.enabled).toBe(true);
    expect((await resolveOne('commerce', { tenantId: 'race-a' }))?.enabled).toBe(true);
    expect((await resolveOne('commerce', { tenantId: 'race-b' }))?.enabled).toBe(true);
  });

  it('purgeTenantOverrides strips only the target tenant on teardown (lifecycle fix)', async () => {
    await provisionDemoFeatures('demo-t1', 'test');
    await provisionDemoFeatures('keep-t2', 'test');
    // Both tenants have crm enabled via override.
    expect((await resolveOne('crm', { tenantId: 'demo-t1' }))?.enabled).toBe(true);
    expect((await resolveOne('crm', { tenantId: 'keep-t2' }))?.enabled).toBe(true);

    const touched = await purgeTenantOverrides('demo-t1');
    expect(touched).toEqual(expect.arrayContaining(['crm', 'commerce']));

    // demo-t1 falls back to the global default (off); keep-t2 is untouched.
    expect((await resolveOne('crm', { tenantId: 'demo-t1' }))?.enabled).toBe(false);
    expect((await resolveOne('crm', { tenantId: 'keep-t2' }))?.enabled).toBe(true);
    // Idempotent: a second purge finds nothing.
    expect(await purgeTenantOverrides('demo-t1')).toEqual([]);
    // Fail-closed on a falsy tenant.
    expect(await purgeTenantOverrides('')).toEqual([]);
  });
});
