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
    await appendExportLineage(T, 'canvas-2', entry(1));
    await appendExportLineage('other-tenant', CANVAS, entry(1));

    expect((await listExportLineage(T, 'canvas-2')).length, 'a sibling canvas shared the cap').toBe(1);
    expect((await listExportLineage('other-tenant', CANVAS)).length, 'another tenant shared this canvas row').toBe(1);
    expect((await listExportLineage(T, CANVAS)).length, 'the original row was disturbed').toBe(100);
  });
});
