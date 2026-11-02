/**
 * ADR 0820 G2 — the commissions node surface is gated on the `sales-commissions`
 * toggle AND plan. Its surface id was `commissions`, which no toggle carries, so
 * `featureSurfaces.gate` served it to every tenant. Observed RED on unmodified
 * source: the free tenant's `list-plans` node was served. Harness:
 * `monetizationGateHarness.ts`.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { useMonetizationHarness, FREE_TENANT, OPERATOR_TENANT } from './monetizationGateHarness.js';

useMonetizationHarness();

describe('G2 — the commissions node surface is gated on the sales-commissions toggle + plan', () => {
  it('the node pack is refused for an unentitled tenant and served for the operator', async () => {
    const pack = await import(pathToFileURL(join(__dirname, '..', '..', '..', 'packs', 'feature.sales-commissions.nodes', 'index.mjs')).href);
    const ctxFor = (tenantId: string) => {
      const scope: BundleScope = { tenantId };
      return { features: buildFeatureSurfaces(scope), inputs: { orgId: 'org-x' }, config: {} };
    };
    await expect(pack.listPlans(ctxFor(FREE_TENANT))).rejects.toMatchObject({ code: 'host_capability_disabled' });
    // Positive control: the same node, the same surface, an entitled tenant.
    const served = await pack.listPlans(ctxFor(OPERATOR_TENANT)).then(() => 'served', (e: { code?: string }) => e.code ?? 'error');
    // Served, exactly — not merely "some other error" (a broken surface that
    // threw anything else would have passed the old two negative checks).
    expect(served).toBe('served');
  });
});
