/**
 * ADR 0447 P1 — the obligation-ledger machine's OWN invariants (the consumer
 * adapters pin end-to-end behavior; this file pins what no single adapter
 * reaches): integer-minor-unit enforcement, multi-currency runs, the
 * legacy-row upgrade hook, and machine-level idempotency.
 *
 * Sabotage witnessed (grade-tests w74, TST-DVA-7): the integer guard (either
 * half), first-write-wins, `lineId` in the row key, reversal negation / meta /
 * insert-once, the per-currency entry key, the confirm row flip, both bad-state
 * guards, cancel's row release, the `paid` split, and the csvEscape prefix +
 * quote rules — each reds its case. The upgradeRow case seeds a REAL
 * legacy-shaped blob, so a decode that ignored the hook reds it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createObligationLedger,
  summarizeObligations,
  csvEscape,
  ObligationRunError,
  type ObligationRow,
} from '../src/host/obligationLedger.js';

const T = 'tenant-obl';

const ledger = createObligationLedger({ ns: 'test-obl-rows', runsNs: 'test-obl-runs', logComponent: 'test.obl' });

const accrual = (over: Partial<Parameters<typeof ledger.accrue>[0]> = {}) => ({
  tenantId: T, sourceId: 'src-1', lineId: 'line-1', payeeSubject: 'user:payee-a',
  currency: 'USD', basisMinor: 5000, rateStamp: 2000, amountMinor: 1000,
  policyVersion: 1, sourceCreatedAt: '2026-07-20T00:00:00.000Z', ...over,
});

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('rows', () => {
  it('accrue is first-write-wins; non-integer amounts are refused', async () => {
    expect(await ledger.accrue(accrual())).toBe(true);
    expect(await ledger.accrue(accrual({ amountMinor: 999 }))).toBe(false); // replay: no rewrite
    const stored = (await ledger.listForTenant(T)).filter((r) => r.sourceId === 'src-1' && r.lineId === 'line-1');
    expect(stored.map((r) => r.amountMinor), 'the replay rewrote the accrual').toEqual([1000]);
    await expect(ledger.accrue(accrual({ sourceId: 'src-float', amountMinor: 10.5 }))).rejects.toThrow(/integer minor units/);
    await expect(ledger.accrue(accrual({ sourceId: 'src-float2', basisMinor: 0.1, amountMinor: 1 }))).rejects.toThrow(/integer minor units/);
  });

  it('reverseSource mirrors accruals negated, idempotently, preserving meta + policy stamps', async () => {
    await ledger.accrue(accrual({ sourceId: 'src-rev', lineId: 'l1', amountMinor: 700, meta: { challengeId: 'chal-x' } }));
    await ledger.accrue(accrual({ sourceId: 'src-rev', lineId: 'l2', amountMinor: 300 }));
    expect(await ledger.reverseSource(T, 'src-rev')).toBe(2);
    expect(await ledger.reverseSource(T, 'src-rev')).toBe(0); // idempotent
    const rows = (await ledger.listForTenant(T)).filter((r) => r.sourceId === 'src-rev');
    const reversals = rows.filter((r) => r.kind === 'reversal');
    expect(reversals.map((r) => r.amountMinor).sort()).toEqual([-700, -300].sort());
    expect(reversals.map((r) => r.basisMinor)).toEqual([-5000, -5000]);
    expect(reversals.find((r) => r.lineId === 'l1')?.meta?.challengeId).toBe('chal-x');
    expect(reversals.every((r) => r.policyVersion === 1 && r.rateStamp === 2000)).toBe(true);
  });
});

describe('runs', () => {
  it('a run keeps per-currency entries separate for one payee (multi-currency never nets across currencies)', async () => {
    const T2 = 'tenant-obl-multicur';
    await ledger.accrue(accrual({ tenantId: T2, sourceId: 's-usd', amountMinor: 800, currency: 'USD' }));
    await ledger.accrue(accrual({ tenantId: T2, sourceId: 's-jpy', amountMinor: 500, currency: 'JPY' }));
    const run = await ledger.createRun(T2, 'user:op');
    expect(run.entries).toHaveLength(2);
    expect(run.entries.map((e) => `${e.currency}:${e.totalMinor}`).sort()).toEqual(['JPY:500', 'USD:800']);
    // A net-negative currency group would never have entered; confirm flips both.
    const confirmed = await ledger.confirmRun(T2, run.runId, 'user:op', 'evidence-1');
    expect(confirmed.state).toBe('confirmed');
    const after = await ledger.listForTenant(T2);
    expect(after).toHaveLength(2);
    expect(after.every((r) => r.state === 'paid')).toBe(true);
  });

  it('confirm of a canceled run (and vice versa) is a typed bad-state refusal', async () => {
    const T3 = 'tenant-obl-states';
    await ledger.accrue(accrual({ tenantId: T3, sourceId: 's1', amountMinor: 100 }));
    const run = await ledger.createRun(T3, 'user:op');
    await ledger.cancelRun(T3, run.runId);
    // Exact code AND message: the CAS-loss path throws the same class + code with a different message.
    await expect(ledger.confirmRun(T3, run.runId, 'user:op', 'x')).rejects.toBeInstanceOf(ObligationRunError);
    await expect(ledger.confirmRun(T3, run.runId, 'user:op', 'x')).rejects.toMatchObject({ code: 'bad-state', message: 'Only an open run can be confirmed.' });
    // cancel released the row ⇒ a fresh run can claim it again
    const rerun = await ledger.createRun(T3, 'user:op');
    expect(rerun.entries[0]?.totalMinor).toBe(100);
    await ledger.confirmRun(T3, rerun.runId, 'user:op', 'ok');
    await expect(ledger.cancelRun(T3, rerun.runId)).rejects.toBeInstanceOf(ObligationRunError);
    await expect(ledger.cancelRun(T3, rerun.runId)).rejects.toMatchObject({ code: 'bad-state', message: 'Only an open run can be canceled.' });
  });
});

describe('upgradeRow (legacy read-tolerance)', () => {
  it('a legacy-shaped stored row is upgraded on read instead of dropped', async () => {
    const field = (p: Record<string, unknown>, k: string): string => String(p[k] ?? '');
    const num = (p: Record<string, unknown>, k: string): number => Number(p[k]);
    const upgrading = createObligationLedger({
      ns: 'test-obl-legacy', runsNs: 'test-obl-legacy-runs', logComponent: 'test.obl.legacy',
      upgradeRow: (parsed): ObligationRow | null => {
        if (typeof parsed !== 'object' || parsed === null) return null;
        const p = parsed as Record<string, unknown>;
        const canonical = typeof p.sourceId === 'string';
        if (!canonical && typeof p.orderId !== 'string') return null;
        return {
          tenantId: field(p, 'tenantId'),
          sourceId: field(p, canonical ? 'sourceId' : 'orderId'),
          lineId: field(p, canonical ? 'lineId' : 'productId'),
          kind: p.kind === 'reversal' ? 'reversal' : 'accrual',
          payeeSubject: field(p, canonical ? 'payeeSubject' : 'authorSubject'),
          currency: field(p, 'currency'),
          basisMinor: num(p, canonical ? 'basisMinor' : 'grossMinor'),
          rateStamp: num(p, canonical ? 'rateStamp' : 'shareBps'),
          amountMinor: num(p, canonical ? 'amountMinor' : 'shareMinor'),
          policyVersion: num(p, 'policyVersion'),
          state: p.state === 'paid' ? 'paid' : 'accrued',
          sourceCreatedAt: field(p, canonical ? 'sourceCreatedAt' : 'orderCreatedAt'),
          createdAt: field(p, 'createdAt'),
        };
      },
    });
    // A pre-extraction (ADR 0445) row, written straight into the ledger's namespace
    // under the key the machine lists by — the shape the hook exists to upgrade.
    interface LegacyShareRow {
      tenantId: string; orderId: string; productId: string; kind: 'accrual'; authorSubject: string;
      currency: string; grossMinor: number; shareBps: number; shareMinor: number; policyVersion: number;
      state: 'accrued'; orderCreatedAt: string; createdAt: string;
    }
    const legacy = new DurableCollection<LegacyShareRow>('test-obl-legacy', (r) => `${r.tenantId}::${r.orderId}::${r.productId}`);
    await legacy.put({
      tenantId: 'tenant-obl-up', orderId: 'ord-L', productId: 'p-1', kind: 'accrual', authorSubject: 'user:author',
      currency: 'USD', grossMinor: 2185, shareBps: 2000, shareMinor: 437, policyVersion: 1, state: 'accrued',
      orderCreatedAt: '2026-07-01T00:00:00.000Z', createdAt: '2026-07-01T00:00:01.000Z',
    });
    // …and a canonical row beside it (the passthrough half).
    await upgrading.accrue(accrual({ tenantId: 'tenant-obl-up', sourceId: 'up-1' }));

    const listed = await upgrading.listForTenant('tenant-obl-up');
    expect(listed.map((r) => r.sourceId).sort()).toEqual(['ord-L', 'up-1']);
    expect(listed.find((r) => r.sourceId === 'ord-L')).toEqual({
      tenantId: 'tenant-obl-up', sourceId: 'ord-L', lineId: 'p-1', kind: 'accrual', payeeSubject: 'user:author',
      currency: 'USD', basisMinor: 2185, rateStamp: 2000, amountMinor: 437, policyVersion: 1, state: 'accrued',
      sourceCreatedAt: '2026-07-01T00:00:00.000Z', createdAt: '2026-07-01T00:00:01.000Z',
    });
  });
});

describe('helpers', () => {
  it('summarizeObligations nets reversals into accrued and splits paid', () => {
    const rows = [
      { currency: 'USD', state: 'accrued', amountMinor: 1000 },
      { currency: 'USD', state: 'accrued', amountMinor: -400 },
      { currency: 'USD', state: 'paid', amountMinor: 250 },
      { currency: 'EUR', state: 'paid', amountMinor: 99 },
    ] as const;
    // Per currency, never summed across, and sorted by currency (EUR listed last on input).
    expect(summarizeObligations([...rows])).toEqual([
      { currency: 'EUR', accruedMinor: 0, paidMinor: 99 },
      { currency: 'USD', accruedMinor: 600, paidMinor: 250 },
    ]);
  });

  it('csvEscape quotes, doubles quotes, and neutralizes formula prefixes', () => {
    expect(csvEscape('plain')).toBe('"plain"');
    expect(csvEscape('a "b"')).toBe('"a ""b"""');
    expect(csvEscape('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(csvEscape('@cmd')).toBe('"\'@cmd"');
    expect(csvEscape('+1')).toBe('"\'+1"');
    expect(csvEscape('-2')).toBe('"\'-2"');
  });
});
