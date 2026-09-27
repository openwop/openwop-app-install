/**
 * CDP-D — warehouse-write provider substrate (ADR 0266). A SEPARATE `bigquery-write`
 * provider carries the write scope for reverse-ETL loads, while the `bigquery`
 * provider stays read-only (ADR 0076 invariant intact — not loosened).
 */
import { describe, expect, it } from 'vitest';
import { getProvider, assertReadOnlyConsistent } from '../src/features/connections/providerRegistry.js';

describe('CDP-D bigquery-write provider', () => {
  it('bigquery-write has a write scope group and is not read-only', () => {
    const p = getProvider('bigquery-write');
    expect(p).toBeTruthy();
    expect(p!.readOnly).not.toBe(true);
    expect(p!.scopes.write?.some((g) => g.scopes.some((s) => s.includes('bigquery.insertdata')))).toBe(true);
    expect(p!.apiHosts).toContain('bigquery.googleapis.com');
    expect(() => assertReadOnlyConsistent(p!)).not.toThrow();
  });

  it('bigquery stays read-only (ADR 0076 invariant NOT loosened)', () => {
    const p = getProvider('bigquery');
    expect(p!.readOnly).toBe(true);
    expect(p!.scopes.write).toBeUndefined();
    expect(() => assertReadOnlyConsistent(p!)).not.toThrow();
  });
});
