/**
 * Teardown-reachability RECORDED_DEBT shrink (baseline 9→7): two orphan-hygiene
 * stores flagged by `teardown-reachability-coverage.test.ts` now carry a `tenantOf`
 * so tenant teardown (`purgeTenantHostExt`) reaches them instead of orphaning:
 *
 *   - `crm:suppression-count` — the row key IS the tenantId (`{ key: tenantId, count }`),
 *     so the resolver is `(c) => c.key`.
 *   - `users:canonical` — `homeTenant` IS the tenant the canonical pointer belongs to,
 *     so the resolver is `(r) => r.homeTenant`.
 *
 * Both resolvers return the WHOLE tenant value (NO key-splitting) — deliberately, because
 * tenant ids contain the `:` delimiter (`org:foo`), so a `split(':')[0]` resolver would
 * return `org` and mis-attribute the row (the "my fix reintroduces the family" trap).
 * This witness seeds through the REAL service APIs and asserts the raw hostext rows are
 * gone after teardown, and a second tenant's rows survive (a purge that took the tenantOf
 * wrong would either leave tenant A's row — born-red — or delete tenant B's).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, purgeTenantHostExt, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { addSuppression } from '../src/features/crm/suppressionService.js';
import { resolveCanonicalUserForTenant } from '../src/features/users/usersService.js';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

// Tenant ids carry a colon — the exact shape that defeats a naive split() resolver.
const A = 'org:teardown-debt-a';
const B = 'org:teardown-debt-b';

async function seed(tenant: string): Promise<void> {
  // addSuppression → bumpCount → seeds the `crm:suppression-count` row keyed by tenant.
  await addSuppression(tenant, `contact@${tenant.replace(/[^a-z0-9]/gi, '')}.example`, 'manual', 'user:seed-actor');
  // resolveCanonicalUserForTenant → canonicalByTenant.put → seeds the `users:canonical` row.
  await resolveCanonicalUserForTenant({ homeTenant: tenant, principalId: `p-${tenant}`, source: 'oidc' });
}

function residual(rows: ReadonlyArray<{ key: string; value: string }>, ns: string, tenant: string) {
  return rows.filter(({ key, value }) => key.includes(ns) && (key.includes(tenant) || value.includes(tenant)));
}

describe('teardown-debt trivial tenantOf — crm:suppression-count + users:canonical are teardown-reachable', () => {
  it('purges tenant A\'s count + canonical rows; tenant B is untouched', async () => {
    await seed(A);
    await seed(B);

    let rows = await hostExtStorage().kvList('hostext:');
    // Pre-flight — the seed really wrote both rows for A (a witness over nothing proves nothing).
    expect(residual(rows, 'crm:suppression-count', A).length).toBeGreaterThan(0);
    expect(residual(rows, 'users:canonical', A).length).toBeGreaterThan(0);

    await purgeTenantHostExt(A);

    rows = await hostExtStorage().kvList('hostext:');
    // A's rows are GONE — the tenantOf made teardown reach them (born-red without it).
    expect(residual(rows, 'crm:suppression-count', A)).toEqual([]);
    expect(residual(rows, 'users:canonical', A)).toEqual([]);
    // Discriminator: B's rows survive A's purge (a wrong/over-broad tenantOf would delete them).
    expect(residual(rows, 'crm:suppression-count', B).length).toBeGreaterThan(0);
    expect(residual(rows, 'users:canonical', B).length).toBeGreaterThan(0);
  });
});
