/**
 * ADR 0892 Phase B — `host/featureBundleActivation.ts`, the ONE helper that turns
 * a feature bundle on/off for a workspace (the store routes and billing's
 * grant-started both call it).
 *
 * Every case starts from an explicit state: the bundle closures are saved OFF
 * globally, so nothing here leans on a compiled default (Phase A flips `crm`'s).
 * Entitlement is the real billing seam (`createApp` registers it), narrowed with
 * `OPENWOP_BILLING_PLAN_FEATURES`.
 *
 * Sabotage witnesses (run by hand, 2026-10-14): dropping the `unentitled` check
 * from `enableBundleForTenant` reds "refuses a bundle the plan does not cover";
 * dropping the `!leaving.has(...)` exclusion in `tenantDisableBlockers` reds
 * "turns the crm bundle off".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  __clearToggleStore, enableTenantOverride, getStoredConfig, resolveToggle, saveConfig,
} from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listToggleChanges } from '../src/host/featureToggles/audit.js';
import {
  bundleActivationState, bundleClosure, disableBundleForTenant, enableBundleForTenant,
} from '../src/host/featureBundleActivation.js';
import { bundleFeatureIds } from '../src/host/featureBundles.js';

const T = 't-bundle-act';
const OTHER = 't-bundle-other';
const TOUCHED = () => [...new Set([...bundleClosure('commerce'), ...bundleClosure('crm')])];

async function setGlobal(id: string, status: 'on' | 'off', extra: { killed?: boolean } = {}): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status, ...extra }, 'test');
}
async function onFor(id: string, tenantId = T): Promise<boolean> {
  return Boolean((await resolveToggle(id, { tenantId }))?.enabled);
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});
afterAll(() => { delete process.env.OPENWOP_BILLING_PLAN_FEATURES; });
beforeEach(async () => {
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  await __clearToggleStore();
  await setGlobal('billing', 'on');
  for (const id of TOUCHED()) await setGlobal(id, 'off');
});

describe('closure (D4)', () => {
  it('enabling commerce brings crm along, dependencies first', () => {
    const c = bundleClosure('commerce');
    expect(c).toContain('crm');
    expect(c.indexOf('crm')).toBeLessThan(c.indexOf('commerce'));
  });
});

describe('enableBundleForTenant', () => {
  it('turns the closure on for THIS tenant only, with one audit row per id', async () => {
    const r = await enableBundleForTenant('commerce', T, 'user:alice');
    expect(r.refused).toBeUndefined();
    expect(r.enabled).toEqual(expect.arrayContaining(['commerce', 'crm']));
    expect(await onFor('commerce')).toBe(true);
    expect(await onFor('crm')).toBe(true);
    expect(await onFor('commerce', OTHER)).toBe(false); // never the global default
    const rows = await listToggleChanges('crm');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'feature-toggle.tenant-enabled', principalId: 'user:alice' });
    expect((rows[0]!.payload as { reason?: string }).reason).toBe('bundle:commerce');
  });

  it('is idempotent: a second enable writes nothing and audits nothing', async () => {
    await enableBundleForTenant('crm', T, 'user:alice');
    const r = await enableBundleForTenant('crm', T, 'user:alice');
    expect(r.enabled).toEqual([]);
    expect(r.alreadyOn).toEqual(expect.arrayContaining(bundleFeatureIds('crm').filter((id) => getToggleDefault(id))));
    expect(await listToggleChanges('csm')).toHaveLength(1);
  });

  it('refuses a bundle the plan does not cover (402 shape), writing nothing', async () => {
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
    const r = await enableBundleForTenant('commerce', T, 'user:alice');
    expect(r.refused).toMatchObject({ reason: 'bundle_not_entitled' });
    const refused = r.refused as { missing: string[]; bundles: string[] };
    expect(refused.missing).toEqual(expect.arrayContaining(['commerce', 'crm']));
    expect(refused.bundles).toEqual(expect.arrayContaining(['commerce', 'crm']));
    expect(r.enabled).toEqual([]);
    expect(await onFor('crm')).toBe(false);
    expect(await getStoredConfig('crm')).toMatchObject({ status: 'off' });
    expect((await getStoredConfig('crm'))?.tenantOverrides?.[T]).toBeUndefined();
  });

  it('a dependency the plan does not cover refuses the whole bundle (commerce owned, crm not)', async () => {
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing', 'bundle:commerce'] });
    const r = await enableBundleForTenant('commerce', T, 'user:alice');
    expect(r.refused).toMatchObject({ reason: 'bundle_not_entitled', bundles: ['crm'] });
    expect(await onFor('commerce')).toBe(false);
  });

  it('enables once the plan covers the whole closure', async () => {
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing', 'bundle:commerce', 'bundle:crm'] });
    const r = await enableBundleForTenant('commerce', T, 'user:alice');
    expect(r.refused).toBeUndefined();
    expect(await onFor('commerce')).toBe(true);
  });

  it('a killed feature in the closure refuses the enable, and no override is written over the kill (D3)', async () => {
    await setGlobal('crm', 'off', { killed: true });
    const r = await enableBundleForTenant('commerce', T, 'user:alice');
    expect(r.refused).toEqual({ reason: 'feature_killed', ids: ['crm'] });
    expect(r.enabled).toEqual([]);
    expect((await getStoredConfig('commerce'))?.tenantOverrides?.[T]).toBeUndefined();
  });

  it('an unknown bundle is a typed refusal, not an empty success', async () => {
    expect((await enableBundleForTenant('no-such-bundle', T, 'user:alice')).refused).toEqual({ reason: 'unknown_bundle' });
  });
});

describe('disableBundleForTenant (D5)', () => {
  it('turns the crm bundle off here — its own members (csm needs crm) do not block it', async () => {
    await enableBundleForTenant('crm', T, 'user:alice');
    const r = await disableBundleForTenant('crm', T, 'user:alice');
    expect(r.refused).toBeUndefined();
    expect(r.disabled).toEqual(expect.arrayContaining(['crm', 'csm']));
    expect(await onFor('crm')).toBe(false);
    const rows = await listToggleChanges('crm');
    expect(rows[0]).toMatchObject({ action: 'feature-toggle.tenant-disabled', principalId: 'user:alice' });
  });

  it('refuses while a feature OUTSIDE the bundle still needs it in this tenant', async () => {
    await enableBundleForTenant('commerce', T, 'user:alice');
    const r = await disableBundleForTenant('crm', T, 'user:alice');
    expect(r.refused).toMatchObject({ reason: 'disable_blocked' });
    expect((r.refused as { dependents: string[] }).dependents).toContain('commerce');
    expect(await onFor('crm')).toBe(true);
  });

  it('the lock is per tenant: another tenant using commerce does not block this one', async () => {
    await enableBundleForTenant('commerce', OTHER, 'user:bob');
    await enableBundleForTenant('crm', T, 'user:alice');
    expect((await disableBundleForTenant('crm', T, 'user:alice')).refused).toBeUndefined();
    expect(await onFor('crm', OTHER)).toBe(true);
  });

  it('disabling commerce leaves its dependency crm on', async () => {
    await enableBundleForTenant('commerce', T, 'user:alice');
    await disableBundleForTenant('commerce', T, 'user:alice');
    expect(await onFor('commerce')).toBe(false);
    expect(await onFor('crm')).toBe(true);
  });
});

describe('bundleActivationState (D9)', () => {
  it('available → enabled → available, and locked when not entitled or killed', async () => {
    expect(await bundleActivationState('crm', T)).toEqual({ status: 'available' });
    await enableBundleForTenant('crm', T, 'user:alice');
    expect(await bundleActivationState('crm', T)).toEqual({ status: 'enabled' });
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
    expect(await bundleActivationState('crm', T)).toMatchObject({ status: 'locked', missing: expect.arrayContaining(['crm']) });
    delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
    await enableTenantOverride('crm', T, 'test'); // no-op (already on); the kill below wins anyway
    await setGlobal('csm', 'off', { killed: true });
    expect(await bundleActivationState('crm', T)).toMatchObject({ status: 'locked', killed: ['csm'] });
  });
});
