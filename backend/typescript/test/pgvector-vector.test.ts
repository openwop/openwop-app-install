/**
 * ADR 0867 / KB-2 — the pgvector vector adapter, in the default gate.
 *
 * The live path (`pgvector-live.test.ts`) runs only under `npm run ci:full`, so
 * this file PINS THE LIVE SQL as exact literals — the tenant predicate above all.
 * The fake runner below filters by its params and never reads the SQL, so the
 * orchestration cases cannot see a dropped `WHERE tenant = …`; only the literal
 * pins can (a cross-tenant read/delete through one shared table otherwise).
 *
 * Sabotages each case is red against (probed, /grade-tests 8f w1): the tenant
 * predicate dropped from nearest / delete; the upsert no longer updating the
 * embedding + metadata; the score reported as distance; the tenant param
 * replaced; the dimension check loosened; the identifier guard widened.
 */
import { describe, expect, it } from 'vitest';
import type { VectorSurface } from '../src/host/inMemorySurfaces.js';
import {
  createPgVectorVector, toVectorLiteral, createTableSql, upsertSql, nearestSql, deleteSql, type SqlRunner,
} from '../src/host/vector/pgVectorVector.js';

describe('pgvector SQL builders (pins the live SQL — the unrunnable path)', () => {
  it('vector literal', () => { expect(toVectorLiteral([1, 0.5, -2])).toBe('[1,0.5,-2]'); });
  it('create table with fixed dimension', () => {
    expect(createTableSql('host_vectors', 3)).toContain('embedding vector(3) NOT NULL');
    expect(createTableSql('host_vectors', 3)).toContain('PRIMARY KEY (tenant, namespace, id)');
  });
  it('upsert uses ON CONFLICT', () => {
    expect(upsertSql('host_vectors')).toBe(
      'INSERT INTO host_vectors (tenant, namespace, id, embedding, metadata) VALUES ($1, $2, $3, $4::vector, $5::jsonb) '
      + 'ON CONFLICT (tenant, namespace, id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata',
    );
  });
  it('nearest uses the cosine distance operator, similarity score, ordered', () => {
    // exact: the tenant + namespace predicate is part of the pin
    expect(nearestSql('host_vectors')).toBe(
      'SELECT id, metadata, 1 - (embedding <=> $1::vector) AS score FROM host_vectors '
      + 'WHERE tenant = $2 AND namespace = $3 ORDER BY embedding <=> $1::vector LIMIT $4',
    );
  });
  it('delete by id array', () => {
    expect(deleteSql('host_vectors')).toBe('DELETE FROM host_vectors WHERE tenant = $1 AND namespace = $2 AND id = ANY($3)');
  });
  it('rejects unsafe table identifiers', () => { expect(() => createTableSql('a; DROP TABLE x', 3)).toThrow(/unsafe/); });
});

// Adapter orchestration via a fake runner backed by a JS vector store.
function makeFakeRunner() {
  const store = new Map<string, { vector: number[]; metadata: unknown }>();
  const parseVec = (lit: string) => lit.slice(1, -1).split(',').map(Number);
  const cosine = (a: number[], b: number[]) => {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
    return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };
  const run: SqlRunner = async (sql, params) => {
    if (sql.startsWith('INSERT')) {
      const [tenant, ns, id, vecLit, metaJson] = params as [string, string, string, string, string];
      store.set(`${tenant}|${ns}|${id}`, { vector: parseVec(vecLit), metadata: JSON.parse(metaJson) });
      return { rows: [] };
    }
    if (sql.startsWith('SELECT')) {
      const [vecLit, tenant, ns, k] = params as [string, string, string, number];
      const q = parseVec(vecLit);
      const rows = [...store.entries()]
        .filter(([key]) => key.startsWith(`${tenant}|${ns}|`))
        .map(([key, v]) => ({ id: key.split('|')[2], metadata: v.metadata, score: cosine(q, v.vector) }))
        .sort((a, b) => b.score - a.score).slice(0, k);
      return { rows };
    }
    if (sql.startsWith('DELETE')) {
      const [tenant, ns, ids] = params as [string, string, string[]];
      const deleted: Array<{ id: string }> = [];
      for (const id of ids) if (store.delete(`${tenant}|${ns}|${id}`)) deleted.push({ id });
      return { rows: deleted };
    }
    return { rows: [] };
  };
  return { store, run };
}

const vecFor = (tenantId: string, run: SqlRunner): VectorSurface =>
  createPgVectorVector({ tenantId }, { run, dim: 3 });

describe('pgvector vector adapter (orchestration via fake runner)', () => {
  it('upsert + nearest-neighbour query + delete', async () => {
    const { run } = makeFakeRunner();
    const v = vecFor('t1', run);
    expect(await v.upsert({ namespace: 'n', items: [
      { id: 'a', vector: [1, 0, 0], metadata: { tag: 'x' } },
      { id: 'b', vector: [0, 1, 0] },
      { id: 'c', vector: [0.9, 0.1, 0] },
    ] })).toEqual({ upserted: 3 });
    const res = await v.query({ namespace: 'n', vector: [1, 0, 0], topK: 2 }) as { matches: Array<{ id: string; metadata?: unknown }> };
    expect(res.matches.map((m) => m.id)).toEqual(['a', 'c']);
    expect(res.matches[0].metadata).toEqual({ tag: 'x' });
    expect(await v.delete({ namespace: 'n', ids: ['a'] })).toEqual({ deleted: 1 });
  });

  it('enforces the configured embedding dimension', async () => {
    const { run } = makeFakeRunner();
    await expect(vecFor('t1', run).upsert({ namespace: 'n', items: [{ id: 'a', vector: [1, 2] }] }))
      .rejects.toThrow(/dim 2 != configured 3/);
  });

  it('isolates tenants', async () => {
    const { run } = makeFakeRunner();
    await vecFor('tenant-a', run).upsert({ namespace: 'n', items: [{ id: 'a', vector: [1, 0, 0] }] });
    expect((await vecFor('tenant-b', run).query({ namespace: 'n', vector: [1, 0, 0] }) as { matches: unknown[] }).matches).toEqual([]);
  });
});
