/**
 * ADR 1001 D3.1 — clarification checkpoints retire WITH their run, on both
 * adapters and both run-delete paths.
 *
 * Why it exists: a checkpoint is the transcript tail of a paused agent turn,
 * tool output included. `deleteRun` and `pruneTerminalRuns` hand-list the
 * run-keyed rows, so a new run-keyed row that is not added to all four lists
 * outlives its run where nobody can reach or erase it (the ADR 0889 EVD-2
 * defect class). Keys are written through the REAL key builder, so the pattern
 * restated in `storage/runKvKeys.ts` is pinned to what the host writes. A
 * neighbouring run whose id differs only by a LIKE metacharacter survives.
 *
 * Sabotage-witnessed: removing the checkpoint delete from either adapter's
 * `deleteRun` or `pruneTerminalRuns` reds the matching case; dropping the
 * LIKE escape in `clarificationCheckpointKeyPattern` reds the neighbour leg.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { pgMemAdapters } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { newDb } = require('pg-mem') as typeof import('pg-mem');
  return { pgMemAdapters: newDb().adapters.createPg() };
});
vi.mock('pg', () => ({ default: pgMemAdapters, ...pgMemAdapters }));

import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { clarificationCheckpointKey } from '../src/host/clarificationCheckpoint.js';

const OLD = '2026-01-01T00:00:00.000Z';
const backends = ['sqlite', 'postgres'] as const;
const storages = new Map<(typeof backends)[number], Storage>();

function mkRun(runId: string): RunRecord {
  return { runId, workflowId: 'wf.clarify', tenantId: 't1', status: 'completed', inputs: {}, metadata: {}, configurable: {}, createdAt: OLD, updatedAt: OLD };
}
async function seed(s: Storage, runId: string): Promise<string[]> {
  const keys = [clarificationCheckpointKey(runId, 'agent:1', 1), clarificationCheckpointKey(runId, 'agent:1', 2), clarificationCheckpointKey(runId, 'other', 1)];
  for (const k of keys) await s.kvSet(k, '{"v":1}');
  return keys;
}
async function present(s: Storage, keys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const k of keys) if ((await s.kvGet(k)) !== null) out.push(k);
  return out;
}

beforeAll(async () => {
  storages.set('sqlite', await openSqliteStorage(':memory:'));
  storages.set('postgres', await openPostgresStorage('postgres://test/test'));
});
afterAll(async () => {
  for (const s of storages.values()) await s.close().catch(() => undefined);
});

describe.each(backends)('ADR 1001 D3.1 — %s: checkpoints retire with their run', (name) => {
  it('deleteRun removes the run\'s checkpoints; a neighbour run id differing by a LIKE wildcard keeps its own', async () => {
    const s = storages.get(name)!;
    // The LIKE-wildcard leg runs on sqlite only: pg-mem does not honour the
    // backslash escape Postgres applies by default (the adr0889 precedent), so
    // an escaped `_` matches nothing there. Real Postgres is the testcontainers
    // adapter-parity lane.
    const doomed = name === 'sqlite' ? 'r_sqlite' : 'r-postgres';
    const neighbour = name === 'sqlite' ? 'rxsqlite' : 'r-postgres-n'; // `_` in `doomed` would match `x` unescaped
    await s.insertRun(mkRun(doomed));
    await s.insertRun(mkRun(neighbour));
    const doomedKeys = await seed(s, doomed);
    const keptKeys = await seed(s, neighbour);
    expect(await s.deleteRun(doomed)).toBe(true);
    expect(await present(s, doomedKeys)).toEqual([]);
    expect(await present(s, keptKeys)).toEqual(keptKeys);
  });

  it('pruneTerminalRuns removes a pruned run\'s checkpoints', async () => {
    const s = storages.get(name)!;
    const pruned = `p-${name}`;
    await s.insertRun(mkRun(pruned));
    const keys = await seed(s, pruned);
    const res = await s.pruneTerminalRuns('2026-06-01T00:00:00.000Z', 1000);
    expect(res.childRows).toBeGreaterThanOrEqual(keys.length);
    expect(await present(s, keys)).toEqual([]);
    // pg-mem silently no-ops `DELETE … = ANY($1)`, so the run row is asserted on
    // sqlite only (the adr0889 / storage-adapter-parity precedent).
    if (name === 'sqlite') expect(await s.getRun(pruned)).toBeNull();
  });
});
