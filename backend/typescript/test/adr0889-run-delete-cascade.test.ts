/**
 * ADR 0889 grade remediation EVD-2 — a run's captured tool calls retire WITH the run (TST-BPA).
 *
 * Why this exists: D9 / A8 said a capture is "erased with its run", and it was not.
 * `deleteRun` and `pruneTerminalRuns` hand-list the run-keyed rows, and the
 * tool-boundary rows (PII-bearing tool inputs and results) plus the capture index
 * were missing, so a deleted run's calls survived up to 30 days and were still
 * listed as promotable. This drives the REAL capture wrapper (so the key shapes
 * restated in `storage/runKvKeys.ts` are pinned to what the wrapper writes) on
 * both adapters, then deletes through both delete paths.
 *
 * Red when (sabotage-witnessed, wave 65): the `toolBoundaryKeyPatterns` loop is removed
 * from either adapter's `deleteRun` or `pruneTerminalRuns` (the matching case), the
 * capture-index pattern is dropped, or the call pattern stops being tenant-keyed
 * ("deleteRun removes…"). The first case witnesses the fixture itself: the rows the
 * other cases delete are exactly what the real wrapper writes.
 *
 * ADR 0984 D7: the fixture also records two calls through the REAL exact recorder
 * (a live eval trial's as-executed record, its counter) and freezes one task's
 * a copy another eval run froze from it, all keyed `<tenant>:#x:<runId>:`, and a
 * copy the run itself froze from another source (`<tenant>:#x:<src>:#frozen:<runId>:`).
 * Dropping either pattern from `toolBoundaryKeyPatterns` reds both delete cases.
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
import { freezeRecordedFixtures, maybeCaptureExecuteTool, maybeRecordExactCalls, setCaptureSetting } from '../src/host/evals/toolBoundary.js';

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
  const record = (await maybeRecordExactCalls({ tenantId, runId, agentId: AGENT }))!(async () => ({ content: '{"ok":true}' }));
  await record({ name: 'crm:lookup', input: { email: 'pat@example.com' }, callId: 'c1' });
  await record({ name: 'crm:update', input: { id: 'c-1' }, callId: 'c2' });
  const entries = [{ tool: 'crm:lookup', args: { email: 'pat@example.com' }, argsMatch: 'exact' as const, response: '{"ok":true}' }];
  // A copy another eval run froze FROM this run (keyed under this source) …
  await freezeRecordedFixtures(tenantId, `eval-of-${runId}`, { t: { sourceRunId: runId, anchorAt: OLD, entries } });
  // … and a copy THIS run froze from another source (keyed under that source, deleted with this run).
  await freezeRecordedFixtures(tenantId, runId, { t: { sourceRunId: `src-of-${runId}`, anchorAt: OLD, entries } });
  // What the wrapper wrote is witnessed by the first case (a hook assertion would skip
  // the cases instead of failing one).
  const rows = [
    ...(await scratch.kvList(`hostext:agent:tool-boundary:${tenantId}:${runId}:`)),
    ...(await scratch.kvList(`hostext:agent:tool-boundary:${tenantId}:#x:${runId}:`)),
    ...(await scratch.kvList(`hostext:agent:tool-boundary:${tenantId}:#x:src-of-${runId}:#frozen:${runId}:`)),
    ...(await scratch.kvList(`hostext:agent:tool-boundary-run:${tenantId}:`)).filter((r) => r.key.endsWith(`:${runId}`)),
  ];
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

describe('EVD-2 — the fixture is what production writes', () => {
  it('the real wrappers wrote two calls, the run counter and the capture index (and D7: two exact calls, their counter, a frozen set) for every (tenant, run)', () => {
    expect(written.size).toBe(8);
    for (const [k, all] of written) {
      const d7 = all.filter((r) => r.key.includes(':#x:'));
      const rows = all.filter((r) => !r.key.includes(':#x:'));
      expect(rows.map((r) => r.key.split(':').slice(0, 3).join(':')).sort(), k).toEqual([
        'hostext:agent:tool-boundary', 'hostext:agent:tool-boundary', 'hostext:agent:tool-boundary', 'hostext:agent:tool-boundary-run',
      ]);
      expect(rows.filter((r) => r.key.endsWith(':#cap')), k).toHaveLength(1);
      // The two call rows carry the two tools, in call order.
      const tools = rows.filter((r) => !r.key.endsWith(':#cap') && r.key.startsWith('hostext:agent:tool-boundary:'))
        .sort((a, b) => a.key.localeCompare(b.key)).map((r) => (JSON.parse(r.value) as { tool: string }).tool);
      expect(tools, k).toEqual(['crm:lookup', 'crm:update']);
      expect(d7.map((r) => (JSON.parse(r.value) as { kind: string }).kind).sort(), k).toEqual(['exact', 'exact', 'exact-cap', 'frozen', 'frozen']);
    }
  });
});

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
