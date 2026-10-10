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
import { useMonetizationHarness, FREE_TENANT, OPERATOR_TENANT } from './monetizationGateHarness.js';

useMonetizationHarness();

describe('G2 — the commissions node surface is gated on the sales-commissions toggle + plan', () => {
  it('the node pack is refused for an unentitled tenant and served for the operator', async () => {
    const pack = await import(pathToFileURL(join(__dirname, '..', '..', '..', 'packs', 'feature.sales-commissions.nodes', 'index.mjs')).href);
    const ctxFor = (tenantId: string) => ({ features: buildFeatureSurfaces({ tenantId } as Parameters<typeof buildFeatureSurfaces>[0]), inputs: { orgId: 'org-x' }, config: {} });
    await expect(pack.listPlans(ctxFor(FREE_TENANT))).rejects.toMatchObject({ code: 'host_capability_disabled' });
    // Positive control: the same node, the same surface, an entitled tenant.
    const served = await pack.listPlans(ctxFor(OPERATOR_TENANT)).then(() => 'served', (e: { code?: string }) => e.code ?? 'error');
    expect(served).not.toBe('host_capability_disabled');
    expect(served).not.toBe('host_capability_missing');
  });
});
