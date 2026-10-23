/**
 * PROPC-ERASURE-TEARDOWN — tenant teardown must purge the `proposals` collection.
 *
 * A proposals row keys `${owner.tenant}::${id}` and carries the tenant NESTED at
 * `owner.tenant` — there is NO top-level `tenantId`. The `proposals`
 * DurableCollection was built with no `tenantOf` resolver, so the generic
 * `purgeTenantHostExt` walk fell back to the top-level `jsonTenantId` probe →
 * `undefined` → every proposals row was SKIPPED and SURVIVED account deletion,
 * leaking subject PII (`owner.principal` userId, the AI-authored `artifact`, and
 * `provenance.sourceRunIds`). The one-arg fix — a `(p) => p.owner.tenant`
 * `tenantOf` — makes the teardown reach the rows.
 *
 * Born-red: with the pre-fix construction (no `tenantOf`), the purge leaves the
 * row and the first assertion fails. Discriminator (a prescribed fix can be an
 * attack): a SECOND tenant's proposal must survive the first tenant's purge.
 *
 * Contracts: RFC 0096 (proposals are tenant-owned records) and ADR 0284 (tenant
 * teardown purges every hostext collection). Sabotage-witnessed (/grade-tests 8f
 * wave 1): dropping the `tenantOf` resolver reds both cases
 * (8fw1g3-propc-tenantof-r2); removing the per-row tenant check in the purge
 * fan-out reds the second-tenant discriminators (8fw1g3-propc-fanout-r2).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, purgeTenantHostExt, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { putProposal, getProposal, listProposals } from '../src/features/proposals/proposalsService.js';
import type { Proposal } from '../src/features/proposals/types.js';

let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

const TENANT_A = 'org:proposals-erase-a';
const TENANT_B = 'org:proposals-erase-b';

const mkProposal = (tenant: string, id: string): Proposal => ({
  id,
  kind: 'workflow-chain-pack',
  state: 'draft',
  title: 'Mined pattern',
  artifact: { chain: { nodes: [], edges: [] } },
  provenance: { sourceRunIds: ['run-pii-1'] },
  owner: { tenant, principal: 'user:alice-pii-0badc0de' },
  createdAt: '2026-01-01T00:00:00Z',
});

describe('PROPC-ERASURE-TEARDOWN — purgeTenantHostExt reaches the proposals collection', () => {
  it('purges the torn-down tenant\'s proposal (PII does not survive) — and the second tenant is untouched', async () => {
    await putProposal(mkProposal(TENANT_A, 'p-a1'));
    await putProposal(mkProposal(TENANT_B, 'p-b1'));

    // Pre-flight — the seed really wrote both rows (a witness over nothing proves nothing).
    expect(await listProposals(TENANT_A)).toHaveLength(1);
    expect(await listProposals(TENANT_B)).toHaveLength(1);

    await purgeTenantHostExt(TENANT_A);

    // Tenant A's proposal (and its PII) is GONE — the whole point of the fix.
    expect(await getProposal(TENANT_A, 'p-a1')).toBeNull();
    expect(await listProposals(TENANT_A)).toEqual([]);
    // Belt: no residual `hostext:…proposals…` key anywhere still names tenant A.
    const residual = (await hostExtStorage().kvList('hostext:'))
      .filter(({ key, value }) => key.includes('proposals') && (key.includes(TENANT_A) || value.includes(TENANT_A)));
    expect(residual.map((r) => r.key)).toEqual([]);

    // Discriminator — tenant B's proposal survives A's purge, PII intact (a purge
    // that fanned out beyond its tenant would be a cross-tenant destructive write).
    const bRows = await listProposals(TENANT_B);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].owner.principal).toBe('user:alice-pii-0badc0de');
  });

  it('is idempotent: a second purge finds nothing and does not throw', async () => {
    // Its own tenant pair, so the counts below do not depend on case order.
    const tenantC = 'org:proposals-erase-c';
    const tenantD = 'org:proposals-erase-d';
    await putProposal(mkProposal(tenantC, 'p-c1'));
    await putProposal(mkProposal(tenantD, 'p-d1'));
    const first = await purgeTenantHostExt(tenantC);
    expect(first).toEqual({ deleted: 1, ghostRows: 0, collections: 1 }); // exactly C's one row
    const second = await purgeTenantHostExt(tenantC);
    expect(second).toEqual({ deleted: 0, ghostRows: 0, collections: 0 }); // nothing left to find
    expect(await listProposals(tenantC)).toEqual([]);
    // The neighbour survives both purges.
    expect((await listProposals(tenantD)).map((p) => p.id)).toEqual(['p-d1']);
  });
});
