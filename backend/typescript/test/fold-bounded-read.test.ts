/**
 * ADR 0003 Phase 4c — the tenant fold reads only the host-ext rows that can mention
 * the source tenant, and rewrites EXACTLY what the old whole-table pass rewrote.
 *
 * `reassignTenant` used to `SELECT k, v FROM host_ext_kv` for the whole table and parse
 * every value on each adoption. It now pre-filters with `tenantFoldNeedles`. An
 * incomplete fold leaves orphans, so the claim here is equality: for every seeded shape,
 * the store after the bounded fold equals the store the old pass produces. The old pass
 * is computed purely: `planHostExtRekey` over EVERY non-scaffolding row, which is what
 * the full scan did.
 *
 * The filter is a plain substring test (`strpos` / `instr`), not `LIKE`: a `LIKE`
 * version selected NOTHING on pg-mem for an id with `_`, because pg-mem does not read
 * `\\` as a `LIKE` escape. That is the failure an escaped pattern invites.
 *
 * Shapes: tenant in the KEY only; in a top-level VALUE field only; NESTED deep in the
 * value (the old pass leaves it, so the new one must too); in a marker; JSON-escaped
 * in the value (a tenant id with a `"`); a different tenant that shares a prefix; not
 * at all; and the access-control scaffolding (never moved).
 *
 * Sabotage, measured by probe on both adapters (w87):
 *   - the key test made false: the key-only row stays behind, so both cases red. (The
 *     marker row is not the witness in case 1: its value holds the raw id, which IS
 *     needle 1 for an anon id, so the value test still selects it.)
 *   - the value test fed the raw id instead of the JSON-escaped one: only the escaped
 *     case reds (its value-only row is not rewritten);
 *   - `tenantFoldNeedles` returning `[from, from]`: the escaped case on both adapters
 *     and the needles case red;
 *   - the `hostext:access-orgs:` exclusion dropped: the scaffolding row moves, both cases.
 * Over-narrowing `run_budget` reds GEN-1c in reaper-fold-key-coverage.test.ts. Run
 * against sqlite and postgres (pg-mem with a `strpos` shim; real Postgres ships it, see
 * fold-bounded-read-postgres-live.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';

// pg-mem as `pg`, as in storage-adapter-parity.test.ts (one in-memory database for the file).
const { pgMemAdapters } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { newDb, DataType } = require('pg-mem') as typeof import('pg-mem');
  const db = newDb();
  // pg-mem has no `strpos`; real Postgres does. Same semantics: 1-based, 0 = absent.
  db.public.registerFunction({ name: 'strpos', args: [DataType.text, DataType.text], returns: DataType.integer, implementation: (s: string, sub: string) => s.indexOf(sub) + 1 });
  return { pgMemAdapters: db.adapters.createPg() };
});
vi.mock('pg', () => ({ default: pgMemAdapters, ...pgMemAdapters }));
import { openStorage } from '../src/storage/index.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import { tenantFoldNeedles } from '../src/storage/tenantMigration.js';
import type { Storage } from '../src/storage/storage.js';
import { foldAfter, foldOldPass, foldSeed, FOLD_TO as TO, type ReadAllKv } from './helpers/foldShapes.js';

/** One storage per adapter for the file: a second Postgres open on the same pg-mem
 *  database re-runs its schema setup, which pg-mem refuses. */
const once = (make: () => Promise<Storage>): (() => Promise<Storage>) => {
  let s: Promise<Storage> | null = null;
  return () => (s ??= make());
};
/** pg-mem cannot parse the `LIKE … ESCAPE` that `kvList` sends, so read the table raw. */
const readPgMem: ReadAllKv = async () => {
  const c = new pgMemAdapters.Client();
  await c.connect();
  try {
    const r = await c.query(`SELECT k, v FROM host_ext_kv`);
    return (r.rows as Array<{ k: string; v: string }>).map((x) => ({ key: x.k, value: x.v }));
  } finally { await c.end(); }
};
const adapters: Array<[string, () => Promise<Storage>, ReadAllKv | undefined]> = [
  ['sqlite', once(() => openStorage('memory://')), undefined],
  ['postgres', once(() => openPostgresStorage('postgres://test/test')), readPgMem],
];

describe.each(adapters)('bounded fold read (%s)', (_name, open, readAll) => {
  it.each([
    ['an anon sandbox id', 'anon:sidABC_1', 'nsA'],
    ['a tenant id JSON escapes', 'anon:a"b\\c', 'nsB'],
  ])('rewrites exactly what the whole-table pass rewrote: %s', async (_label, from, ns) => {
    const rows = foldSeed(from, ns);
    const expected = foldOldPass(rows, from);
    // The fixture must exercise every action, or equality proves little.
    expect(Object.keys(expected)).toContain(`hostext:wf:own:${TO}:id-${ns}`);
    expect(JSON.parse(expected[`hostext:crm:contact:c1-${ns}`] ?? '{}').tenantId).toBe(TO);
    expect(expected[`hostext:crm:deal:d1-${ns}`]).toBe(rows[`hostext:crm:deal:d1-${ns}`]);
    expect(await foldAfter(await open(), rows, from, ns, readAll)).toEqual(expected);
  });
});

describe('tenantFoldNeedles', () => {
  it('is the raw id and its JSON-escaped form', () => {
    expect(tenantFoldNeedles('anon:sid_1')).toEqual(['anon:sid_1', 'anon:sid_1']);
    expect(tenantFoldNeedles('anon:a"b')).toEqual(['anon:a"b', 'anon:a\\"b']);
  });
});
