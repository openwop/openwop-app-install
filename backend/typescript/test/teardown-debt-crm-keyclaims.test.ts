/**
 * Teardown-reachability RECORDED_DEBT drain (baseline 2→0): the CRM dedup-claim
 * rows `crm:companykeyclaim` / `crm:dealkeyclaim` (convertService.ts) key by
 * `claimId` and their row bodies (`{claimId, companyId}` / `{claimId, dealId}`)
 * carry NO top-level `tenantId`, so `purgeTenantRows` — which matches a row via
 * `tenantOf(row)` when supplied ELSE `jsonTenantId(parsed)` — skipped every row
 * (jsonTenantId undefined) and they orphaned on account deletion.
 *
 * The `claimId` EMBEDS the tenant: `${tenantId}::${orgId}::${key}` (tenant ids use
 * SINGLE colons; the separator is `::`), so the fix is a `tenantOf` 4th arg
 * `(c) => c.claimId.split('::')[0]` on BOTH collections — the walk then deletes
 * them, and the gate auto-detects the 4th-arg tenantOf as reachable (its two
 * RECORDED_DEBT entries are removed; baseline 2→0).
 *
 * This witness proves the PRODUCTION tenantOf does the reaching, not a test
 * artifact: it imports convertService (so the tenantOf'd production collections
 * register in HOSTEXT_COLLECTIONS) and SEEDS via a bare, tenantOf-LESS handle to
 * the same namespaces. Because the seed handle has no tenantOf, it can never do
 * the deleting — only the production collection's tenantOf reaches these rows.
 * Born-red: remove either production tenantOf and A's row survives the purge.
 * `org:cc` vs `org:cc2` proves `split('::')` recovers the tenant without a
 * sibling-prefix collision.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import {
  initHostExtPersistence,
  purgeTenantHostExt,
  hostExtStorage,
} from '../src/host/hostExtPersistence.js';
// Side-effect import: registers the tenantOf'd production crm:companykeyclaim /
// crm:dealkeyclaim collections — the code under test does the deleting.
import '../src/features/crm/convertService.js';
// ADR 0627 D6 — and the third claim collection, `crm:contactkeyclaim` (the
// primary-email uniqueness claim, contactsService.ts). Its row carries a
// top-level `tenantId` AND a `tenantOf`, so either purge path reaches it; the
// witness below seeds a row WITHOUT relying on the key shape.
import '../src/features/crm/contactsService.js';

const A = 'org:cc';
const B = 'org:cc2';
const ORG = 'org-unit';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

// Seed the raw rows directly (a `DurableCollection` handle would self-register and
// — registration is last-wins by namespace — REPLACE the production collection,
// so purge would run the test's tenantOf-less handle and never delete. Writing the
// row keys directly (`key(id) = hostext:${name}:${id}`) leaves the production
// tenantOf'd collection as the sole registered handle for each namespace.
async function seed(tenant: string): Promise<{ company: string; deal: string; contact: string }> {
  const company = `${tenant}::${ORG}::domain:acme.com`;
  const deal = `${tenant}::${ORG}::company:c1|contact:p1`;
  const contact = `${tenant}::email:someone@acme.test`;
  const s = hostExtStorage();
  await s.kvSet(`hostext:crm:companykeyclaim:${company}`, JSON.stringify({ claimId: company, companyId: 'c1' }));
  await s.kvSet(`hostext:crm:dealkeyclaim:${deal}`, JSON.stringify({ claimId: deal, dealId: 'd1' }));
  await s.kvSet(`hostext:crm:contactkeyclaim:${contact}`, JSON.stringify({ claimId: contact, tenantId: tenant, contactId: 'crm:p1' }));
  return { company, deal, contact };
}

async function rowExists(ns: string, claimId: string): Promise<boolean> {
  const rows = await hostExtStorage().kvList('hostext:');
  return rows.some(({ key }) => key.includes(ns) && key.includes(claimId));
}

describe('teardown-debt crm key-claims — reachable via the claimId tenantOf', () => {
  it('purges tenant A\'s company + deal claim rows; tenant B survives', async () => {
    const a = await seed(A);
    const b = await seed(B);
    expect(await rowExists('crm:companykeyclaim', a.company)).toBe(true);
    expect(await rowExists('crm:dealkeyclaim', a.deal)).toBe(true);
    expect(await rowExists('crm:companykeyclaim', b.company)).toBe(true);
    expect(await rowExists('crm:dealkeyclaim', b.deal)).toBe(true);
    expect(await rowExists('crm:contactkeyclaim', a.contact)).toBe(true);
    expect(await rowExists('crm:contactkeyclaim', b.contact)).toBe(true);

    await purgeTenantHostExt(A);

    // A's claim rows are GONE — the production tenantOf reached them (born-red
    // without it: jsonTenantId is undefined on these bodies, so the walk skips).
    expect(await rowExists('crm:companykeyclaim', a.company)).toBe(false);
    expect(await rowExists('crm:dealkeyclaim', a.deal)).toBe(false);
    expect(await rowExists('crm:contactkeyclaim', a.contact), 'ADR 0627 D6 — the email claim is teardown-reachable').toBe(false);
    // B (`org:cc2`, a prefix-extension of `org:cc`) is untouched — split('::')[0]
    // recovers `org:cc2` ≠ `org:cc`, no sibling collision.
    expect(await rowExists('crm:companykeyclaim', b.company)).toBe(true);
    expect(await rowExists('crm:dealkeyclaim', b.deal)).toBe(true);
    expect(await rowExists('crm:contactkeyclaim', b.contact)).toBe(true);
  });
});
