/**
 * ADR 0906 P0 / D5 — the live re-check takes a per-(hostname, slot) claimOnce
 * lease, so N instances check each row once per slot (it used to be N times).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  __resetCustomDomains, addDomain, listDomains, verifyDomain,
} from '../src/host/customDomains.js';
import { runCustomDomainRecheck } from '../src/host/customDomainSweep.js';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetCustomDomains();
});

describe('ADR 0906 D5 — the re-check is leased per (hostname, slot)', () => {
  it('two instances in one slot check each live row once; the next slot checks again', async () => {
    await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'a.example.com' });
    await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'b.example.com' });
    await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'pending.example.com' });
    const rows = await listDomains('t1', 'o1');
    const tokens = new Map(rows.map((r) => [r.hostname, r.verificationToken]));
    const resolver = vi.fn(async (name: string) => [[tokens.get(name.replace('_openwop-verify.', '')) ?? '']]);
    await verifyDomain('t1', 'o1', 'a.example.com', resolver);
    await verifyDomain('t1', 'o1', 'b.example.com', resolver);
    resolver.mockClear();

    const t0 = 1_800_000_000_000;
    const first = await runCustomDomainRecheck(resolver, t0);
    const second = await runCustomDomainRecheck(resolver, t0 + 1000); // another instance, same slot
    expect(first.sort()).toEqual(['a.example.com', 'b.example.com']); // pending rows are not re-checked
    expect(second).toEqual([]);
    expect(resolver).toHaveBeenCalledTimes(2);

    const nextSlot = await runCustomDomainRecheck(resolver, t0 + 6 * 60 * 60 * 1000);
    expect(nextSlot.sort()).toEqual(['a.example.com', 'b.example.com']);
  });
});
