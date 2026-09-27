/**
 * `PROBE-KT445-2`, migrated from a prose census to an executable assertion.
 *
 * The probe read: "duplicate probe: no two accrual rows share `(orderId,
 * productId)`; no reversal without its accrual sibling". Both halves are
 * money-truth properties — the first is a double-pay guard, the second stops a
 * clawback against nothing.
 *
 * I left this row OPEN in #2994 rather than tick it on the strength of two test
 * TITLES containing "idempotent under replay", because the assertion I could see
 * (`deriveShares(order,'accrue') === 1`) was ambiguous: `deriveShares` counts
 * ROWS WRITTEN, so a `1` after an already-accrued order would have meant a
 * duplicate. Reading `accrue` settled it — `if (await rows.get(key)) return
 * false` is an explicit first-write-wins guard. Rather than keep inferring from
 * a caller two layers up, this asserts BOTH halves directly at the ledger, where
 * the invariant actually lives.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createObligationLedger } from '../src/host/obligationLedger.js';

const T = 'tenant-obl';
const ledger = createObligationLedger({
  ns: 'test-obligation-dedup', runsNs: 'test-obligation-dedup-runs', logComponent: 'test.obligation',
});
const accrual = (sourceId: string, lineId: string) => ({
  tenantId: T, sourceId, lineId, payeeSubject: 'user:payee', currency: 'usd',
  basisMinor: 2900, rateStamp: 2000, amountMinor: 580, policyVersion: 1,
  sourceCreatedAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('PROBE-KT445-2 (executable) — accrual dedup + reversal has an accrual sibling', () => {
  it('no two accrual rows share (sourceId, lineId) — a replay writes nothing', async () => {
    expect(await ledger.accrue(accrual('ord-1', 'prod-a')), 'the first accrual did not write — the rest is vacuous').toBe(true);
    expect(await ledger.accrue(accrual('ord-1', 'prod-a')), 'a replay wrote a SECOND accrual — double-pay').toBe(false);

    const rows = (await ledger.listForTenant(T)).filter((r) => r.kind === 'accrual');
    expect(rows).toHaveLength(1);
    const pairs = rows.map((r) => `${r.sourceId}::${r.lineId}`);
    expect(new Set(pairs).size, 'duplicate (sourceId, lineId) accruals — exactly what PROBE-KT445-2 counts').toBe(pairs.length);
  });

  it('distinct lines of the same order each accrue — dedup is per LINE, not per order', async () => {
    // The other polarity: a key that dropped `lineId` would pass the test above
    // while silently under-paying a multi-line order.
    await ledger.accrue(accrual('ord-2', 'prod-a'));
    await ledger.accrue(accrual('ord-2', 'prod-b'));
    const rows = (await ledger.listForTenant(T)).filter((r) => r.kind === 'accrual' && r.sourceId === 'ord-2');
    expect(rows, 'a second LINE of the same order was swallowed as a duplicate').toHaveLength(2);
  });

  it('every reversal mirrors an accrual sibling, and reversing twice adds nothing', async () => {
    await ledger.accrue(accrual('ord-3', 'prod-a'));
    expect(await ledger.reverseSource(T, 'ord-3'), 'the reversal did not write').toBe(1);
    expect(await ledger.reverseSource(T, 'ord-3'), 'a second reversal double-clawed').toBe(0);

    const rows = await ledger.listForTenant(T);
    const acc = rows.filter((r) => r.kind === 'accrual' && r.sourceId === 'ord-3');
    const rev = rows.filter((r) => r.kind === 'reversal' && r.sourceId === 'ord-3');
    expect(rev).toHaveLength(1);
    // The probe's second half: no reversal without its accrual sibling.
    for (const r of rev) {
      expect(
        acc.some((a) => a.lineId === r.lineId),
        `reversal for line ${r.lineId} has no accrual sibling — a clawback against nothing`,
      ).toBe(true);
    }
    expect(rev[0].amountMinor, 'the reversal did not mirror-negate its accrual').toBe(-acc[0].amountMinor);
  });

  it('reverses NOTHING for a source that never accrued', async () => {
    expect(await ledger.reverseSource(T, 'ord-never'), 'invented a reversal with no accrual').toBe(0);
    expect((await ledger.listForTenant(T)).filter((r) => r.sourceId === 'ord-never')).toHaveLength(0);
  });
});
