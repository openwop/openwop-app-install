/**
 * ADR 0819 §1 — on a host that narrows NO plan (the reference host, and every
 * white-label deploy that never set OPENWOP_BILLING_PLAN_FEATURES), the access
 * resolver must be byte-identical to the pure toggle read: same object for every
 * toggle and subject, sellable or not. The paywall exists only where an operator
 * turned it on.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { resolveOne, resolveToggle, saveConfig, enableTenantOverride } from '../src/host/featureToggles/service.js';
import { listToggleDefaults } from '../src/host/featureToggles/registry.js';
import { isSellableBundleFeature } from '../src/host/featureBundles.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  // Bundles priced, plan NOT narrowed: the configuration that must stay unrestricted.
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_mktg: 'marketing' });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // Every state a toggle can be in: on, beta, off-with-a-tenant-on override.
  const defs = listToggleDefaults();
  for (const [i, d] of defs.entries()) {
    const status = (['on', 'beta', 'off'] as const)[i % 3]!;
    await saveConfig({ ...d, status }, 'test');
    if (status === 'off') await enableTenantOverride(d.id, 'user:unnarrowed-1', 'test');
  }
});
afterAll(async () => {
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0819 §1 — no narrowed plan ⇒ resolveOne ≡ resolveToggle', () => {
  it('every toggle, for tenant-only, user-carrying and overridden subjects', async () => {
    const defs = listToggleDefaults();
    // Floor: the comparison must cover sellable features, or it proves nothing.
    expect(defs.filter((d) => isSellableBundleFeature(d.id)).length).toBeGreaterThan(10);
    const subjects = [{ tenantId: 'user:unnarrowed-1' }, { tenantId: 'user:unnarrowed-2', userId: 'oidc:someone' }, { tenantId: 'ws:abc' }];
    for (const d of defs) {
      for (const subject of subjects) {
        expect(await resolveOne(d.id, subject), `${d.id} for ${JSON.stringify(subject)}`).toEqual(await resolveToggle(d.id, subject));
      }
    }
  });
});
