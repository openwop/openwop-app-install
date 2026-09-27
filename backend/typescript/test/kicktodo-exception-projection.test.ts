/**
 * ADR 0460 Phase 2 — the host EXCEPTION-PROJECTION seam contract.
 *
 * Pins the two idioms the projection combines + the honesty invariants:
 *   - keyed registry, repeat-boot overwrite (rosterLifecycle idiom);
 *   - per-source degradation — a THROWING source is reported ok:false AND a
 *     synthetic `degraded` row is injected, while healthy sources still compose
 *     (never a silent gap that reads as "all clear" — the OQ2 discipline);
 *   - fail-closed on a blank tenant;
 *   - per-source cap + `truncated` flag (a capped list is never "everything").
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerExceptionSource,
  listExceptions,
  __resetExceptionSources,
  SOURCE_ROW_CAP,
  type ExceptionRow,
} from '../src/host/exceptionProjection.js';

const row = (id: string): ExceptionRow => ({
  id,
  source: 's',
  severity: 'attention',
  label: id,
  owner: { kind: 'system', ref: 'system', label: 'system' },
  action: { labelKey: 'x', href: '/admin/kicktodo' },
  audit: { detectedAt: '2026-07-21T00:00:00.000Z', tenantId: 'T' },
});

afterEach(() => { __resetExceptionSources(); });

describe('exceptionProjection seam', () => {
  it('composes every registered source for the tenant', async () => {
    registerExceptionSource('a', async () => [row('a:1')]);
    registerExceptionSource('b', async () => [row('b:1'), row('b:2')]);
    const res = await listExceptions('T');
    expect(res.rows.map((r) => r.id).sort()).toEqual(['a:1', 'b:1', 'b:2']);
    expect(res.sources.every((s) => s.ok)).toBe(true);
  });

  it('reports a THROWING source degraded (ok:false + a degraded row) while healthy sources still compose', async () => {
    registerExceptionSource('good', async () => [row('good:1')]);
    registerExceptionSource('boom', async () => { throw new Error('feed down'); });
    const res = await listExceptions('T');
    // the healthy source is unaffected
    expect(res.rows.find((r) => r.id === 'good:1')).toBeDefined();
    // the failure is VISIBLE, not silent
    const boom = res.sources.find((s) => s.key === 'boom')!;
    expect(boom.ok).toBe(false);
    expect(boom.error).toBe('feed down');
    const degradedRow = res.rows.find((r) => r.source === 'boom');
    expect(degradedRow?.severity).toBe('degraded');
    expect(degradedRow?.audit.detectedAt).toBeTruthy(); // a real timestamp, not empty
  });

  it('repeat registration with the same key OVERWRITES (double-boot safe)', async () => {
    registerExceptionSource('k', async () => [row('old')]);
    registerExceptionSource('k', async () => [row('new')]);
    const res = await listExceptions('T');
    expect(res.rows.map((r) => r.id)).toEqual(['new']);
    expect(res.sources.filter((s) => s.key === 'k')).toHaveLength(1);
  });

  it('is fail-closed on a blank tenant (never a cross-tenant read)', async () => {
    registerExceptionSource('a', async () => [row('a:1')]);
    expect(await listExceptions('')).toEqual({ rows: [], sources: [] });
  });

  it('caps a source at SOURCE_ROW_CAP and flags it truncated', async () => {
    registerExceptionSource('big', async () => Array.from({ length: SOURCE_ROW_CAP + 50 }, (_, i) => row(`big:${i}`)));
    const res = await listExceptions('T');
    expect(res.rows).toHaveLength(SOURCE_ROW_CAP);
    const big = res.sources.find((s) => s.key === 'big')!;
    expect(big.truncated).toBe(true);
    expect(big.count).toBe(SOURCE_ROW_CAP);
  });
});
