/**
 * ADR 0292 — resilient example-data seeding.
 *
 * Covers the three seams that make a full demo seed survive prod delivery:
 *   1. `runExampleDataSeed` streams each step via `onStep` (drives NDJSON).
 *   2. the request-timeout resolver gives the seed routes the batch budget.
 *   3. `provisionDemoFeatures` enables the demo toggles PER-TENANT (never global),
 *      idempotently — the DG-SEED-7 fix that keeps seeders pure.
 *
 * Sabotages that red this file (8fw1g4 round 1 + 2): dropping `provision-demo`
 * from the batch-route pattern, rewriting or un-guarding the `onStep` emit, a
 * GLOBAL `status:'on'` write, an override write that replaces instead of merges,
 * a blind CAS against a re-read (the SEED-RS-3 race case FORCES the interleaving
 * that loses an update — an unforced `Promise.all` never interleaved, round-1
 * probe rs-cas-race was vacuous), a purge that wipes every tenant, and a purge
 * that runs for a falsy tenant.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Storage } from '../src/storage/storage.js';
import type { Request } from 'express';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { registerToggleDefault, __resetToggleDefaults } from '../src/host/featureToggles/registry.js';
import { resolveOne, purgeTenantOverrides, __clearToggleStore, enableTenantOverride, getStoredConfig } from '../src/host/featureToggles/service.js';
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
      const req = asReq('POST', `/host/openwop-app/example-data/${p}`);
      expect(isBatchSeedRoute(req)).toBe(true);
      expect(resolveTimeoutForRequest(req)).toBe(DEFAULT_BATCH_REQUEST_TIMEOUT_MS);
    }
  });

  // Twin: the interrupt leg (LLM budget) is also asserted by request-timeout.test.ts
  // "grants the LLM budget…" (probe rt-resolver reds both). Kept: protected file.
  it('keeps the tight default for ordinary routes and the LLM budget for interrupts', () => {
    expect(resolveTimeoutForRequest(asReq('GET', '/host/openwop-app/example-data/status'))).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(resolveTimeoutForRequest(asReq('POST', '/runs/r1/interrupts/n1'))).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(isBatchSeedRoute(asReq('POST', '/runs'))).toBe(false);
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
    // FORCED interleaving (a plain Promise.all never interleaved — round-1 probe
    // rs-cas-race was vacuous). Tenant A is held at its CAS CANDIDATE read of the
    // shared `crm` row (the 3rd read of that key: getStoredConfig, getEffectiveConfig,
    // then the `stored` read) until tenant B has fully enabled `crm`. A's CAS then
    // carries a stale `expected`; it must LOSE and retry, never overwrite B.
    const CRM_KEY = 'hostext:feature-toggle:crm';
    const base = await openStorage('memory://');
    let crmReads = 0;
    let crmSwaps = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let signalHeld: () => void = () => undefined;
    const held = new Promise<void>((r) => { signalHeld = r; });
    const fallback = (): Promise<void> => new Promise((r) => setTimeout(r, 2000));
    const storage = new Proxy<Storage>(base, {
      get(target, prop) {
        if (prop === 'kvGet') {
          return async (key: string): Promise<string | null> => {
            // Read FIRST, then hold: A must leave with the pre-B snapshot.
            const value = await target.kvGet(key);
            if (key === CRM_KEY && ++crmReads === 3) {
              signalHeld();
              await Promise.race([gate, fallback()]);
            }
            return value;
          };
        }
        if (prop === 'kvCompareAndSwap') {
          return (key: string, expected: string | null, next: string) => {
            if (key === CRM_KEY) crmSwaps += 1;
            return target.kvCompareAndSwap(key, expected, next);
          };
        }
        const v: unknown = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    initHostExtPersistence(storage);

    const pendingA = provisionDemoFeatures('race-a', 'test');
    await Promise.race([held, fallback()]);
    expect(crmReads, 'the hold never fired — A did not reach its candidate read').toBe(3);
    const b = await provisionDemoFeatures('race-b', 'test');
    release();
    const a = await pendingA;

    expect(a.enabled).toEqual(expect.arrayContaining(['crm', 'commerce']));
    expect(b.enabled).toEqual(expect.arrayContaining(['crm', 'commerce']));
    // B's CAS, A's stale CAS (lost), A's retry — proves the window really opened.
    expect(crmSwaps, "A's first CAS must lose to B's write and retry").toBe(3);
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
  });

  it('purgeTenantOverrides fails closed on a falsy tenant — an `\'\'` override survives', async () => {
    // A row that really carries a '' override, so removing the `!tenantId` guard
    // has something to strip (with none, the guard could never matter).
    expect(await enableTenantOverride('crm', '', 'test')).toBe('enabled');
    expect(Object.keys((await getStoredConfig('crm'))?.tenantOverrides ?? {})).toContain('');
    expect(await purgeTenantOverrides('')).toEqual([]);
    expect(Object.keys((await getStoredConfig('crm'))?.tenantOverrides ?? {}), 'the falsy-tenant purge stripped a row').toContain('');
  });
});
