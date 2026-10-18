/**
 * ADR 0889 grade remediation EVD-2 — a run's captured tool calls retire WITH the run.
 *
 * Why this exists: D9 / A8 said a capture is "erased with its run", and it was not.
 * `deleteRun` and `pruneTerminalRuns` hand-list the run-keyed rows, and the
 * tool-boundary rows (PII-bearing tool inputs and results) plus the capture index
 * were missing, so a deleted run's calls survived up to 30 days and were still
 * listed as promotable. This drives the REAL capture wrapper (so the key shapes
 * restated in `storage/runKvKeys.ts` are pinned to what the wrapper writes) on
 * both adapters, then deletes through both delete paths.
 *
 * Sabotage-witnessed: removing the `toolBoundaryKeyPatterns` loop from either
 * adapter's `deleteRun` (or `pruneTerminalRuns`) reds the matching case.
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
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { listCapturedRuns, listRunBoundary, maybeCaptureExecuteTool, setCaptureSetting } from '../src/host/evals/toolBoundary.js';

const AGENT = 'eval.cascade-agent';
const OLD = '2026-01-01T00:00:00.000Z';

function mkRun(runId: string, tenantId: string): RunRecord {
  return { runId, workflowId: 'wf.cascade', tenantId, status: 'completed', inputs: {}, metadata: {}, configurable: {}, createdAt: OLD, updatedAt: OLD };
}

const backends = ['sqlite', 'postgres'] as const;
const storages = new Map<(typeof backends)[number], Storage>();
/** The exact host_ext_kv rows the production wrapper writes, per (tenant, run). */
const written = new Map<string, Array<{ key: string; value: string }>>();

/**
 * Capture two calls through the REAL wrapper on a scratch sqlite store and keep
 * the rows it wrote. pg-mem cannot parse the `LIKE … ESCAPE` prefix read that
 * `listByPrefix` (and so the wrapper) uses, so the postgres arm replays these
 * exact rows with `kvSet`: both arms then delete what production writes.
 */
async function recordCapture(tenantId: string, runId: string): Promise<void> {
  const scratch = await openSqliteStorage(':memory:');
  initHostExtPersistence(scratch);
  await setCaptureSetting(tenantId, AGENT, true);
  const exec = await maybeCaptureExecuteTool(async () => ({ content: '{"ok":true}' }), { tenantId, runId, agentId: AGENT });
  await exec({ name: 'crm:lookup', input: { email: 'pat@example.com' } } as Parameters<typeof exec>[0]);
  await exec({ name: 'crm:update', input: { id: 'c-1' } } as Parameters<typeof exec>[0]);
  // Non-vacuous: the wrapper wrote both calls, the per-run counter and the index.
  expect((await listRunBoundary(tenantId, runId)).map((r) => r.tool)).toEqual(['crm:lookup', 'crm:update']);
  expect((await listCapturedRuns(tenantId, AGENT)).map((r) => r.runId)).toEqual([runId]);
  const rows = [
    ...(await scratch.kvList(`hostext:agent:tool-boundary:${tenantId}:${runId}:`)),
    ...(await scratch.kvList(`hostext:agent:tool-boundary-run:${tenantId}:`)).filter((r) => r.key.endsWith(`:${runId}`)),
  ];
  expect(rows.some((r) => r.key.endsWith(':#cap'))).toBe(true);
  expect(rows).toHaveLength(4); // two calls + counter + index
  written.set(`${tenantId}|${runId}`, rows.map((r) => ({ key: r.key, value: r.value })));
  __resetHostExtPersistence();
  await scratch.close();
}

beforeAll(async () => {
  for (const name of backends) {
    for (const [t, r] of [[`t-${name}`, `r-${name}-1`], [`t-${name}`, `r-${name}-2`], ['t-other', `r-${name}-1`], [`t-${name}`, `r-${name}-p`]] as const) {
      await recordCapture(t, r);
    }
  }
  storages.set('sqlite', await openSqliteStorage(':memory:'));
  storages.set('postgres', await openPostgresStorage('postgres://test/test'));
});
afterAll(async () => {
  for (const s of storages.values()) await s.close().catch(() => undefined);
});

async function seed(s: Storage, tenantId: string, runId: string): Promise<string[]> {
  const rows = written.get(`${tenantId}|${runId}`)!;
  for (const r of rows) await s.kvSet(r.key, r.value);
  return rows.map((r) => r.key);
}
async function present(s: Storage, keys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const k of keys) if ((await s.kvGet(k)) !== null) out.push(k);
  return out;
}

describe.each(backends)('EVD-2 — %s: deleting a run deletes its captured tool calls', (name) => {
  it('deleteRun removes the run\'s calls, counter and capture index; other runs (and the same id in another tenant) survive', async () => {
    const s = storages.get(name)!;
    const tenant = `t-${name}`;
    const doomed = `r-${name}-1`;
    const kept = `r-${name}-2`;
    await s.insertRun(mkRun(doomed, tenant));
    await s.insertRun(mkRun(kept, tenant));
    const doomedKeys = await seed(s, tenant, doomed);
    const keptKeys = await seed(s, tenant, kept);
    // The same run id captured under another tenant: the cascade is tenant-keyed.
    const otherKeys = await seed(s, 't-other', doomed);

    expect(await s.deleteRun(doomed)).toBe(true);

    expect(await present(s, doomedKeys)).toEqual([]);
    expect(await present(s, keptKeys)).toEqual(keptKeys);
    expect(await present(s, otherKeys)).toEqual(otherKeys);
  });

  it('pruneTerminalRuns (the retention sweep) removes them too', async () => {
    const s = storages.get(name)!;
    const tenant = `t-${name}`;
    const runId = `r-${name}-p`;
    await s.insertRun(mkRun(runId, tenant));
    const keys = await seed(s, tenant, runId);
    expect(await present(s, keys)).toEqual(keys);

    const res = await s.pruneTerminalRuns('2026-06-01T00:00:00.000Z', 100);
    // The per-run LIKE deletes (the behaviour under test) are asserted on BOTH
    // backends. pg-mem silently no-ops `DELETE … = ANY($1)`, so the run row itself
    // is asserted on sqlite only (the storage-adapter-parity precedent).
    expect(res.childRows).toBeGreaterThanOrEqual(keys.length);
    expect(await present(s, keys)).toEqual([]);
    if (name === 'sqlite') expect(await s.getRun(runId)).toBeNull();
  });
});
