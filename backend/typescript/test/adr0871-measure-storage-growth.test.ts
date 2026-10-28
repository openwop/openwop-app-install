/**
 * ADR 0871 — the verdicts of `scripts/measure-storage-growth.mjs`.
 *
 * The script is the standing re-check for three deferred decisions, so its one
 * job is to say CLEAR only when it measured something: no gauge line is
 * UNMEASURED, never CLEAR. *
 * Tracker TST-BFC-4. Red when: no gauge line reads CLEAR; the earliest total
 * is overwritten; versions compare as strings; T2 fires only above (not at) its
 * threshold; `t3.measured` is true with no vector gauge.
 */
import { describe, expect, it } from 'vitest';
import { evaluate, versionAtLeast, TRIGGERS } from '../../../scripts/measure-storage-growth.mjs';

const gauge = (family: string, maxTenantRows: number, totalRows: number) =>
  ({ msg: 'surface_rows_gauge', family, maxTenantRows, totalRows });
const heavy = (op: string, family: string) => ({ msg: 'surface_scan_heavy', op, family });

describe('measure-storage-growth evaluate()', () => {
  it('is UNMEASURED, not CLEAR, when there is no gauge line', () => {
    expect(evaluate([], 7).status).toBe('UNMEASURED');
    expect(evaluate([{ msg: 'surface_scan_heavy', op: 'scan', family: 'kv' }], 7).status).toBe('UNMEASURED');
  });

  it('is CLEAR on small gauges and no events, and reports the trend', () => {
    const r = evaluate([gauge('kv', 10, 100), gauge('kv', 12, 140)], 7);
    expect(r.status).toBe('CLEAR');
    expect(r.families.kv).toMatchObject({ maxTenantRows: 12, earliestTotalRows: 100, latestTotalRows: 140 });
    expect(r.t3.measured).toBe(false);
  });

  it('T1 triggers on one tenant at the row threshold', () => {
    const r = evaluate([gauge('table', TRIGGERS.t1TenantRows, TRIGGERS.t1TenantRows)], 7);
    expect(r.t1).toEqual({ triggered: true, families: ['table'] });
    expect(r.status).toBe('TRIGGERED');
  });

  it('T1 triggers on heavy scans per day in one family; T2 on table.query heavy scans per day', () => {
    const n = TRIGGERS.t2TableQueryHeavyPerDay * 2;
    const r = evaluate([gauge('table', 1, 1), ...Array.from({ length: n }, () => heavy('table.query', 'table'))], 2);
    expect(r.t1.triggered).toBe(true);
    expect(r.t2.triggered).toBe(true);
    const under = evaluate([gauge('table', 1, 1), ...Array.from({ length: n - 1 }, () => heavy('table.query', 'table'))], 2);
    expect(under.t2.triggered).toBe(false);
  });

  it('T3 triggers on namespace size or slow queries, and reads the pgvector version', () => {
    const vec = (maxNamespaceRows: number, pgvector: string) => ({ msg: 'vector_rows_gauge', maxNamespaceRows, pgvector });
    const big = evaluate([gauge('kv', 1, 1), vec(TRIGGERS.t3NamespaceRows, '0.7.4')], 7);
    expect(big.t3).toMatchObject({ triggered: true, measured: true, pgvector: '0.7.4', iterativeScanAvailable: false });
    const slow = evaluate([gauge('kv', 1, 1), vec(10, '0.8.0'),
      ...Array.from({ length: TRIGGERS.t3SlowQueriesPerDay }, () => ({ msg: 'vector_query_slow' }))], 1);
    expect(slow.t3).toMatchObject({ triggered: true, iterativeScanAvailable: true });
  });

  it('versionAtLeast compares numerically, not as strings', () => {
    expect(versionAtLeast('0.10.0', 0, 8)).toBe(true);
    expect(versionAtLeast('0.7.4', 0, 8)).toBe(false);
    expect(versionAtLeast('1.0', 0, 8)).toBe(true);
  });
});
