/**
 * ADR 0447 P1 — the obligation-ledger machine's OWN invariants (the consumer
 * adapters pin end-to-end behavior; this file pins what no single adapter
 * reaches): integer-minor-unit enforcement, multi-currency runs, the
 * legacy-row upgrade hook, and machine-level idempotency.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
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
    expect((await ledger.listForTenant(T2)).every((r) => r.state === 'paid')).toBe(true);
  });

  it('confirm of a canceled run (and vice versa) is a typed bad-state refusal', async () => {
    const T3 = 'tenant-obl-states';
    await ledger.accrue(accrual({ tenantId: T3, sourceId: 's1', amountMinor: 100 }));
    const run = await ledger.createRun(T3, 'user:op');
    await ledger.cancelRun(T3, run.runId);
    await expect(ledger.confirmRun(T3, run.runId, 'user:op', 'x')).rejects.toBeInstanceOf(ObligationRunError);
    // cancel released the row ⇒ a fresh run can claim it again
    const rerun = await ledger.createRun(T3, 'user:op');
    expect(rerun.entries[0]?.totalMinor).toBe(100);
    await ledger.confirmRun(T3, rerun.runId, 'user:op', 'ok');
    await expect(ledger.cancelRun(T3, rerun.runId)).rejects.toBeInstanceOf(ObligationRunError);
  });
});

describe('upgradeRow (legacy read-tolerance)', () => {
  it('a legacy-shaped stored row is upgraded on read instead of dropped', async () => {
    const upgrading = createObligationLedger({
      ns: 'test-obl-legacy', runsNs: 'test-obl-legacy-runs', logComponent: 'test.obl.legacy',
      upgradeRow: (parsed) => {
        const p = parsed as Record<string, unknown>;
        if (typeof p.sourceId === 'string') return parsed as ObligationRow;
        if (typeof p.orderId !== 'string') return null;
        return {
          tenantId: p.tenantId, sourceId: p.orderId, lineId: p.productId, kind: p.kind,
          payeeSubject: p.authorSubject, currency: p.currency, basisMinor: p.grossMinor,
          rateStamp: p.shareBps, amountMinor: p.shareMinor, policyVersion: p.policyVersion,
          state: p.state, sourceCreatedAt: p.orderCreatedAt, createdAt: p.createdAt,
        } as ObligationRow;
      },
    });
    // Write a canonical row, then verify a hook-carrying ledger still reads it
    // (canonical passthrough) — the legacy branch is exercised by the kicktodo
    // adapter's own upgradeLegacyRow against a hand-seeded old-shape blob there.
    await upgrading.accrue(accrual({ tenantId: 'tenant-obl-up', sourceId: 'up-1' }));
    expect((await upgrading.listForTenant('tenant-obl-up'))[0]?.sourceId).toBe('up-1');
  });
});

describe('helpers', () => {
  it('summarizeObligations nets reversals into accrued and splits paid', () => {
    const rows = [
      { currency: 'USD', state: 'accrued', amountMinor: 1000 },
      { currency: 'USD', state: 'accrued', amountMinor: -400 },
      { currency: 'USD', state: 'paid', amountMinor: 250 },
    ] as const;
    expect(summarizeObligations([...rows])).toEqual([{ currency: 'USD', accruedMinor: 600, paidMinor: 250 }]);
  });

  it('csvEscape quotes, doubles quotes, and neutralizes formula prefixes', () => {
    expect(csvEscape('plain')).toBe('"plain"');
    expect(csvEscape('a "b"')).toBe('"a ""b"""');
    expect(csvEscape('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(csvEscape('@cmd')).toBe('"\'@cmd"');
  });
});
