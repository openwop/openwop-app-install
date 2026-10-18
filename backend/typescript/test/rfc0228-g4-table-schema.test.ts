/**
 * RFC 0228 G4 — `tableStorage` rows MUST conform to the table's DECLARED schema
 * (storage.md §tableStorage), and `core.conformance.table-schema-probe` lets the
 * suite witness it (conformance/fixtures.md §"The tableStorage schema probe
 * fixture").
 *
 * The defect: both table backends took a table's schema from its FIRST insert,
 * so a first row with a wrong type became the schema, and `update` checked
 * nothing. `createTable(table, columns)` now declares the schema, and insert,
 * update and upsert are checked against it, on the memory and durable backends
 * alike. The end-to-end witness is the conformance lane
 * (`v2-table-schema-enforcement`); these legs pin each backend directly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeContext } from '../src/executor/types.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import { createDurableTable } from '../src/host/durable/durableTable.js';
import { buildHostSurfaceBundle, initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { tableSchemaProbeNode } from '../src/bootstrap/conformanceTableSchemaProbe.js';

type Fn = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Table = Record<string, Fn>;

let base: Storage;
beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'table-schema-')) });
  base = await openStorage('memory://');
  setDurableStorage(base);
});
afterAll(() => { setDurableStorage(null); });

let n = 0;
const fresh = () => `t_${Date.now().toString(36)}_${n++}`;
const BACKENDS: ReadonlyArray<readonly [string, (tenantId: string) => Table]> = [
  ['memory', (tenantId) => buildHostSurfaceBundle({ tenantId }).storage.table as unknown as Table],
  ['durable', (tenantId) => createDurableTable({ tenantId }) as unknown as Table],
];
const DECL = { k: 'string', n: 'number' };

async function refusal(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; }
}

for (const [name, make] of BACKENDS) {
  describe(`${name} tableStorage — the declared schema governs every write`, () => {
    it('a well-typed insert completes and returns a minted rowId when the row carries none', async () => {
      const t = make('ten-a'); const table = fresh();
      expect(await t.createTable!({ table, columns: DECL })).toEqual({ ok: true, created: true });
      const r = await t.insert!({ table, row: { k: 'control', n: 1 } });
      expect(typeof r['id']).toBe('string');
      expect((r['id'] as string).length).toBeGreaterThan(0);
      const q = await t.query!({ table, filter: { k: 'control' } });
      expect((q['rows'] as unknown[]).length).toBe(1);
    });

    it('the FIRST insert cannot redefine a declared column (the defect: first insert was the schema)', async () => {
      const t = make('ten-a'); const table = fresh();
      await t.createTable!({ table, columns: DECL });
      expect(await refusal(t.insert!({ table, row: { k: 'mistyped', n: 'not-a-number' } }))).toBe('table_schema_violation');
      expect((await t.count!({ table }))['count']).toBe(0);
    });

    it('an update that changes a declared column type is refused, and the row is unchanged', async () => {
      const t = make('ten-a'); const table = fresh();
      await t.createTable!({ table, columns: DECL });
      const { id } = await t.insert!({ table, row: { k: 'to-update', n: 2 } }) as { id: string };
      expect(await refusal(t.update!({ table, id, patch: { n: 'not-a-number' } }))).toBe('table_schema_violation');
      const rows = (await t.query!({ table, filter: { id } }))['rows'] as Array<{ n: unknown }>;
      expect(rows[0]?.n).toBe(2);
      expect(await t.update!({ table, id, patch: { n: 3 } })).toEqual({ updated: 1 }); // control
    });

    it('upsert is held to the same schema', async () => {
      const t = make('ten-a'); const table = fresh();
      await t.createTable!({ table, columns: DECL });
      expect(await refusal(t.upsert!({ table, row: { id: 'u1', k: 'x', n: 'nope' } }))).toBe('table_schema_violation');
      expect(await t.upsert!({ table, row: { id: 'u1', k: 'x', n: 5 } })).toMatchObject({ upserted: 1 });
    });

    it('re-declaring the same schema is idempotent; a conflicting one is refused', async () => {
      const t = make('ten-a'); const table = fresh();
      await t.createTable!({ table, columns: DECL });
      expect(await t.createTable!({ table, columns: { n: 'number', k: 'string' } })).toEqual({ ok: true, created: false });
      expect(await refusal(t.createTable!({ table, columns: { k: 'string', n: 'string' } }))).toBe('table_schema_violation');
      expect(await refusal(t.createTable!({ table: fresh(), columns: { k: 'date' } }))).toBe('table_schema_violation');
    });

    it('a declaration is per tenant: another tenant may declare the same table name differently', async () => {
      const table = fresh();
      await make('ten-a').createTable!({ table, columns: DECL });
      expect(await make('ten-b').createTable!({ table, columns: { k: 'number' } })).toEqual({ ok: true, created: true });
    });

    it('without createTable the first insert still declares the schema (RFC 0016 §B point 2)', async () => {
      const t = make('ten-a'); const table = fresh();
      await t.insert!({ table, row: { id: 'a', k: 'x', n: 1 } });
      expect(await refusal(t.insert!({ table, row: { id: 'b', k: 'y', n: 'two' } }))).toBe('table_schema_violation');
    });
  });
}

function probeCtx(table: Table, vars: Record<string, string>): NodeContext {
  return { storage: { table }, variables: { get: (k: string) => vars[k], set: () => undefined } } as unknown as NodeContext;
}

for (const [name, make] of BACKENDS) {
  describe(`core.conformance.table-schema-probe — ${name} backend`, () => {
    it('control completes with { inserted: true, rowId }', async () => {
      const o = await tableSchemaProbeNode.execute(probeCtx(make('probe-t'), { action: 'control', table: fresh() }));
      expect(o.status, JSON.stringify(o)).toBe('success');
      const result = (o as { outputs: { result: Record<string, unknown> } }).outputs.result;
      expect(result['inserted']).toBe(true);
      expect(typeof result['rowId']).toBe('string');
    });

    for (const action of ['insert-mistyped', 'update-mistyped'] as const) {
      it(`${action} fails the node with the host's rejection code, unchanged`, async () => {
        const o = await tableSchemaProbeNode.execute(probeCtx(make('probe-t'), { action, table: fresh() }));
        expect(o.status, JSON.stringify(o)).toBe('failure');
        expect((o as { error: { code: string } }).error.code).toBe('table_schema_violation');
      });
    }
  });
}

describe('core.conformance.table-schema-probe — it does no checking of its own', () => {
  // A host that ACCEPTS a mistyped write must read executed-fail, not be rescued
  // by a probe that refused on its behalf.
  const lax: Table = {
    createTable: async () => ({ ok: true }),
    insert: async () => ({ id: 'r1' }),
    update: async () => ({ updated: 1 }),
  };
  it('insert-mistyped against a lax table completes and reports the accepted insert', async () => {
    const o = await tableSchemaProbeNode.execute(probeCtx(lax, { action: 'insert-mistyped', table: 't' }));
    expect(o).toMatchObject({ status: 'success', outputs: { result: { inserted: true, rowId: 'r1' } } });
  });
  it('update-mistyped against a lax table completes and reports the accepted update', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const spy: Table = { ...lax, update: async (a) => { calls.push(a); return { updated: 1 }; } };
    const o = await tableSchemaProbeNode.execute(probeCtx(spy, { action: 'update-mistyped', table: 't' }));
    expect(o).toMatchObject({ status: 'success', outputs: { result: { updated: true, rowId: 'r1' } } });
    expect(calls).toEqual([{ table: 't', id: 'r1', patch: { n: 'not-a-number' } }]);
  });
  it('every action declares { k: string, n: number } first', async () => {
    const seen: unknown[] = [];
    const spy: Table = { ...lax, createTable: async (a) => { seen.push(a); return { ok: true }; } };
    for (const action of ['control', 'insert-mistyped', 'update-mistyped']) {
      await tableSchemaProbeNode.execute(probeCtx(spy, { action, table: 'decl' }));
    }
    expect(seen).toEqual(Array(3).fill({ table: 'decl', columns: { k: 'string', n: 'number' } }));
  });
  it('a missing table input or an unknown action is refused before any write', async () => {
    expect(await tableSchemaProbeNode.execute(probeCtx(lax, { action: 'control' }))).toMatchObject({ status: 'failure', error: { code: 'validation_error' } });
    expect(await tableSchemaProbeNode.execute(probeCtx(lax, { action: 'drop', table: 't' }))).toMatchObject({ status: 'failure', error: { code: 'validation_error' } });
  });
});

describe('table-schema probe gate — its own switch, and only beside tableStorage', () => {
  const ENV = ['OPENWOP_ENABLE_CONFORMANCE_NODES', 'OPENWOP_CONFORMANCE_STORAGE_PROBE', 'OPENWOP_CONFORMANCE_TABLE_SCHEMA_PROBE'] as const;
  const saved = new Map(ENV.map((k) => [k, process.env[k]]));
  afterEach(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  async function bootLikeProd(env: Partial<Record<(typeof ENV)[number], string>>) {
    vi.resetModules();
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
    delete process.env.OPENWOP_CONFORMANCE_STORAGE_PROBE;
    delete process.env.OPENWOP_CONFORMANCE_TABLE_SCHEMA_PROBE;
    Object.assign(process.env, env);
    const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
    ensureNodesRegistered();
    const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
    const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
    return {
      resolves: getNodeRegistry().isResolvable('core.conformance.table-schema-probe'),
      mockAgentResolves: getNodeRegistry().isResolvable('core.conformance.mock-agent'),
      fixtures: listLoadedConformanceFixtures(),
    };
  }

  it('with conformance nodes OFF (the prod posture) the probe resolves and its fixture is advertised', async () => {
    const b = await bootLikeProd({});
    expect(b.mockAgentResolves, 'control: the posture really is nodes-off').toBe(false);
    expect(b.resolves).toBe(true);
    expect(b.fixtures).toContain('conformance-table-schema-probe');
  }, 60_000);

  it('OPENWOP_CONFORMANCE_TABLE_SCHEMA_PROBE=false withdraws the node and the fixture', async () => {
    const b = await bootLikeProd({ OPENWOP_CONFORMANCE_TABLE_SCHEMA_PROBE: 'false' });
    expect(b.resolves).toBe(false);
    expect(b.fixtures).not.toContain('conformance-table-schema-probe');
  }, 60_000);

  it('without tableStorage advertised (storage probe off) the fixture is withheld even though the node resolves', async () => {
    const b = await bootLikeProd({ OPENWOP_CONFORMANCE_STORAGE_PROBE: 'false' });
    expect(b.resolves).toBe(true);
    expect(b.fixtures).not.toContain('conformance-table-schema-probe');
  }, 60_000);
});
