/**
 * `PROBE-AB-2`, migrated from a prose census to an executable assertion.
 *
 * The probe read: "Lineage rows per canvas ≤ 100 (the `MAX_ENTRIES` cap) —
 * expect true". It had no coverage: nothing exercised `appendExportLineage`
 * past the cap, so the bound was asserted only by reading the `.slice()`.
 *
 * A census of "≤ 100" is ALSO satisfiable by a bug that drops everything — an
 * empty row is ≤ 100. So the cap is only half the property; the other half is
 * that the retained entries are the MOST RECENT ones. Both are asserted, plus
 * the tenant scoping the row's `tenantOf` index depends on.
 *
 * Sabotage witnesses (grade-tests w36): no slice (uncapped), slice keeping the
 * OLDEST window, and a key that ignores the tenant — each reds its case. Each
 * case seeds its own rows, so the file passes in any order (shuffle-verified).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { appendExportLineage, listExportLineage, type ExportLineageEntry } from '../export/lineage.js';

const T = 'tenant-lineage';
const CANVAS = 'canvas-1';
const entry = (n: number): ExportLineageEntry => ({
  canvasVersion: n, target: 'zip', fileCount: 1, sizeBytes: 100 + n, hash: `sha256:h${n}`,
  assetToken: `t${n}`, exportedAt: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, warningCount: 0,
});

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('PROBE-AB-2 (executable) — export lineage is capped at MAX_ENTRIES', () => {
  it('caps at 100 AND keeps the most recent — "≤ 100" alone is satisfied by dropping everything', async () => {
    for (let i = 1; i <= 130; i++) await appendExportLineage(T, CANVAS, entry(i));

    const got = await listExportLineage(T, CANVAS);
    expect(got.length, 'the cap did not hold').toBeLessThanOrEqual(100);
    // PRECONDITION against the vacuous reading: an EMPTY row is also "≤ 100".
    expect(got.length, 'the row was emptied — "≤ 100" passed for the wrong reason').toBe(100);
    expect(got[got.length - 1].canvasVersion, 'the newest export was not retained').toBe(130);
    expect(got[0].canvasVersion, 'the retained window is not the most recent 100').toBe(31);
  });

  it('is scoped per canvas and per tenant', async () => {
    // Own tenant + canvases: nothing here depends on the cap case's rows.
    const T2 = 'tenant-lineage-scope';
    for (let i = 1; i <= 3; i++) await appendExportLineage(T2, 'canvas-a', entry(i));
    await appendExportLineage(T2, 'canvas-b', entry(1));
    await appendExportLineage('other-tenant-scope', 'canvas-a', entry(1));

    expect((await listExportLineage(T2, 'canvas-b')).length, 'a sibling canvas shared the row').toBe(1);
    expect((await listExportLineage('other-tenant-scope', 'canvas-a')).length, 'another tenant shared this canvas row').toBe(1);
    expect((await listExportLineage(T2, 'canvas-a')).map((e) => e.canvasVersion), 'the original row was disturbed').toEqual([1, 2, 3]);
  });
});
