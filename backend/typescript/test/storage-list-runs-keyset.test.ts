import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

/**
 * ADR 0658 / RFC 0182 — `listRuns` keyset pagination. The order is total
 * (`created_at DESC, run_id DESC`), so a page boundary given as the last
 * item's (createdAt, runId) yields pages that are disjoint and complete even
 * when several runs share a createdAt. Exercised on the sqlite adapter
 * (memory://); the Postgres query carries the same predicate with a
 * timestamptz cast and is covered by the live-adapter lane.
 */
let storage: Storage;
const TENANT = 'keyset-tenant';
const OTHER = 'other-tenant';

function run(id: string, createdAt: string, tenantId = TENANT): RunRecord {
  return {
    runId: id, workflowId: 'wf', status: 'completed', tenantId, createdAt, updatedAt: createdAt,
  } as RunRecord;
}

beforeAll(async () => {
  storage = await openStorage('memory://');
  // Two runs share 10:00:02 to exercise the run_id tie-break.
  for (const r of [
    run('r-a', '2026-09-11T10:00:01.000Z'),
    run('r-b', '2026-09-11T10:00:02.000Z'),
    run('r-c', '2026-09-11T10:00:02.000Z'),
    run('r-d', '2026-09-11T10:00:03.000Z'),
    run('r-e', '2026-09-11T10:00:04.000Z'),
    run('x-1', '2026-09-11T10:00:05.000Z', OTHER),
  ]) await storage.insertRun(r);
});

describe('storage.listRuns — keyset `before` cursor', () => {
  it('pages newest-first with a total order, disjoint and complete, tenant-scoped', async () => {
    const seen: string[] = [];
    let before: { createdAt: string; runId: string } | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await storage.listRuns({ tenantId: TENANT, limit: 2, ...(before ? { before } : {}) });
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.runId));
      const last = rows[rows.length - 1]!;
      before = { createdAt: last.createdAt, runId: last.runId };
    }
    expect(seen).toEqual(['r-e', 'r-d', 'r-c', 'r-b', 'r-a']); // total order; the tie broke on run_id DESC
    expect(seen).not.toContain('x-1'); // never another tenant's run
  });

  it('a cursor at the oldest run yields an empty page (the end is honest, not a repeat)', async () => {
    const rows = await storage.listRuns({ tenantId: TENANT, limit: 2, before: { createdAt: '2026-09-11T10:00:01.000Z', runId: 'r-a' } });
    expect(rows).toEqual([]);
  });

  it('without `before` the first page is unchanged (the old contract still holds for every existing caller)', async () => {
    const rows = await storage.listRuns({ tenantId: TENANT, limit: 3 });
    expect(rows.map((r) => r.runId)).toEqual(['r-e', 'r-d', 'r-c']);
  });
});
