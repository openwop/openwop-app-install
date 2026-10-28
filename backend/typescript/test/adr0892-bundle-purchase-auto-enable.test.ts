/**
 * ADR 0892 Phase B D7 — a verified bundle purchase turns the bundle ON for the
 * workspace, best-effort.
 *
 * The grant's `grant-started` transition (billingService `mutateBundleGrant`) calls
 * the same `enableBundleForTenant` the store button uses. The money-truth rule
 * (CLAUDE.md, Stripe section) means the webhook outcome must not depend on it: a
 * refusal or a thrown fault is logged and the event still applies with the grant
 * durable. A lapse leaves the override; the plan gate then reads the feature locked.
 *
 * (TST-BPC) Red when (each sabotage-witnessed, wave 65): the `activatePurchasedBundle`
 * call is skipped ⇒ "a bundle subscription turns the bundle on" (and the redelivery and
 * throw cases, which count its calls); its try/catch rethrows ⇒ "a helper that throws
 * does not fail the webhook"; it runs on every grant write, not only `grant-started` ⇒
 * "a redelivered event…"; the grant is audited under another actor ⇒ "…audited as billing".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore, resolveOne, resolveToggle, saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listToggleChanges } from '../src/host/featureToggles/audit.js';
import { bundleClosure } from '../src/host/featureBundleActivation.js';
import { __resetBilling, activeBundleIds, processStripeEvent } from '../src/features/billing/billingService.js';

const h = vi.hoisted(() => ({ throwNext: false, calls: 0 }));
vi.mock('../src/host/featureBundleActivation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/featureBundleActivation.js')>();
  return {
    ...actual,
    enableBundleForTenant: async (...args: Parameters<typeof actual.enableBundleForTenant>) => {
      h.calls += 1;
      if (h.throwNext) { h.throwNext = false; throw new Error('activation store down'); }
      return actual.enableBundleForTenant(...args);
    },
  };
});

const T = 't-bundle-buyer';

async function setGlobal(id: string, status: 'on' | 'off', extra: { killed?: boolean } = {}): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status, ...extra }, 'test');
}
const subEvent = (id: string, type: string, status = 'active') => ({
  id, type,
  data: { object: { id: 'sub_crm_1', status, metadata: { tenantId: T, bundleId: 'crm' }, items: { data: [{ price: { id: 'price_crm' } }] } } },
});

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_crm: 'crm' });
  // Narrowed: crm is NOT in the plan, so only the purchase entitles it.
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});
afterAll(() => {
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
});
beforeEach(async () => {
  await __resetBilling();
  await __clearToggleStore();
  h.throwNext = false;
  h.calls = 0;
  await setGlobal('billing', 'on');
  for (const id of bundleClosure('crm')) await setGlobal(id, 'off');
});

const crmOn = async (): Promise<boolean> => Boolean((await resolveToggle('crm', { tenantId: T }))?.enabled);

describe('ADR 0892 D7 — purchase auto-enable', () => {
  it('a bundle subscription turns the bundle on for the buyer, audited as billing', async () => {
    const r = await processStripeEvent(T, subEvent('evt_ae_1', 'customer.subscription.created'));
    expect(r.status).toBe('applied');
    expect(await activeBundleIds(T)).toEqual(['crm']);
    expect(await crmOn()).toBe(true);
    expect((await resolveOne('crm', { tenantId: T }))?.enabled).toBe(true); // toggle AND plan
    const rows = await listToggleChanges('crm');
    expect(rows[0]).toMatchObject({ action: 'feature-toggle.tenant-enabled', principalId: 'billing:bundle-grant' });
  });

  it('a redelivered event is no new transition and calls nothing', async () => {
    await processStripeEvent(T, subEvent('evt_ae_2', 'customer.subscription.created'));
    expect(h.calls).toBe(1);
    await processStripeEvent(T, subEvent('evt_ae_3', 'customer.subscription.updated'));
    expect(h.calls).toBe(1);
  });

  it('a refusal (a killed feature) is logged; the webhook still applies and the grant is durable', async () => {
    await setGlobal('csm', 'off', { killed: true });
    const r = await processStripeEvent(T, subEvent('evt_ae_4', 'customer.subscription.created'));
    expect(r.status).toBe('applied');
    expect(await activeBundleIds(T)).toEqual(['crm']);
    expect(await crmOn()).toBe(false);
  });

  it('a helper that throws does not fail the webhook', async () => {
    h.throwNext = true;
    const r = await processStripeEvent(T, subEvent('evt_ae_5', 'customer.subscription.created'));
    expect(r.status).toBe('applied');
    expect(h.calls).toBe(1);
    expect(await activeBundleIds(T)).toEqual(['crm']);
  });

  it('a lapse leaves the override in place; the plan gate reads the feature locked', async () => {
    await processStripeEvent(T, subEvent('evt_ae_6', 'customer.subscription.created'));
    await processStripeEvent(T, subEvent('evt_ae_7', 'customer.subscription.deleted', 'canceled'));
    expect(await activeBundleIds(T)).toEqual([]);
    expect(await crmOn()).toBe(true);
    expect((await resolveOne('crm', { tenantId: T }))?.blockedBy).toBe('plan');
  });
});
