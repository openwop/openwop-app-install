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
 * (TST-BPC) Red when (each sabotage-witnessed, wave 65): the `unentitled` check is
 * dropped ⇒ both "…plan does not cover" cases; the audit row names someone other than
 * the actor ⇒ "turns the closure on…"; the disable-lock refusal is dropped ⇒ "refuses
 * while a feature OUTSIDE…"; the closure lists a feature before its dependency ⇒
 * "enabling commerce…"; the activation state skips its per-feature check ⇒
 * "available → enabled…"; disable turns off the closure, not just the bundle's own
 * features ⇒ "disabling commerce…"; `tenantDisableBlockers` drops its tenant filter ⇒
 * "the lock is per tenant" (an orphan another tenant already has must not block this
 * one) or its `!leaving.has(...)` exclusion ⇒ "turns the crm bundle off".
 *
 * DOUBLE GUARD (recorded): a killed feature is refused twice, by the precheck in
 * `host/featureBundleActivation.ts` and by `enableTenantOverride`'s kill outcome in
 * `host/featureToggles/service.ts`, which the in-loop branch maps to the same
 * `{reason:'feature_killed', ids:[id]}`. Dropping either one alone stays green.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  __clearToggleStore, disableTenantOverride, enableTenantOverride, getStoredConfig, resolveToggle, saveConfig,
} from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listToggleChanges } from '../src/host/featureToggles/audit.js';
import {
  bundleActivationState, bundleClosure, disableBundleForTenant, enableBundleForTenant,
} from '../src/host/featureBundleActivation.js';

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
    // The audit log is not reset between cases, so this case's rows are its actor's.
    const actor = 'user:alice-closure';
    const r = await enableBundleForTenant('commerce', T, actor);
    expect(r.refused).toBeUndefined();
    expect(r.enabled).toEqual(expect.arrayContaining(['commerce', 'crm']));
    expect(await onFor('commerce')).toBe(true);
    expect(await onFor('crm')).toBe(true);
    expect(await onFor('commerce', OTHER)).toBe(false); // never the global default
    const rows = (await listToggleChanges('crm')).filter((x) => x.principalId === actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'feature-toggle.tenant-enabled', principalId: actor });
    expect((rows[0]!.payload as { reason?: string }).reason).toBe('bundle:commerce');
    expect((await listToggleChanges('commerce')).filter((x) => x.principalId === actor)).toHaveLength(1);
  });

  it('is idempotent: a second enable writes nothing and audits nothing', async () => {
    const actor = 'user:alice-idempotent';
    const first = await enableBundleForTenant('crm', T, actor);
    expect(first.enabled).toEqual(expect.arrayContaining(['crm', 'csm']));
    const r = await enableBundleForTenant('crm', T, actor);
    expect(r.enabled).toEqual([]);
    // Everything the first call turned on is now reported already on — nothing else.
    expect([...r.alreadyOn].sort()).toEqual([...first.enabled].sort());
    expect((await listToggleChanges('csm')).filter((x) => x.principalId === actor)).toHaveLength(1);
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
    // Enable and disable land in the same millisecond, so "newest row first" is not an
    // order this case can rely on; the disabler is its own actor and its row is found by that.
    await enableBundleForTenant('crm', T, 'user:alice-enabler');
    const r = await disableBundleForTenant('crm', T, 'user:alice-disabler');
    expect(r.refused).toBeUndefined();
    expect(r.disabled).toEqual(expect.arrayContaining(['crm', 'csm']));
    expect(await onFor('crm')).toBe(false);
    const rows = (await listToggleChanges('crm')).filter((x) => x.principalId === 'user:alice-disabler');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'feature-toggle.tenant-disabled', principalId: 'user:alice-disabler' });
    expect((rows[0]!.payload as { reason?: string }).reason).toBe('bundle:crm');
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
    // Even an orphan OTHER already has (commerce on, crm off there) is OTHER's scope,
    // so it does not block this tenant: only the tenant filter keeps it out.
    expect(await disableTenantOverride('crm', OTHER, 'test')).toBe('disabled');
    expect(await onFor('commerce', OTHER)).toBe(true);
    await enableBundleForTenant('crm', T, 'user:alice');
    const again = await disableBundleForTenant('crm', T, 'user:alice');
    expect(again.refused).toBeUndefined();
    expect(again.disabled).toEqual(expect.arrayContaining(['crm']));
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
