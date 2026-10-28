/**
 * ADR 0858 P3 storage follow-up — `core.conformance.storage-probe` drives the
 * host's OWN storage surfaces for the run's tenant.
 *
 * The end-to-end witness is the conformance lane (`v2-storage-cross-tenant-isolation`
 * runs in `npm run ci`; sabotage-witnessed: keying kv by a constant tenant reds
 * the kvStorage and cache legs). This file pins what that lane cannot reach on
 * the memory backend: each family's write → read round-trip and the other
 * tenant's empty read at node level, the postgres placeholder spelling, the
 * pgvector-sized embedding, and refusal pass-through.
 *
 * Tracker TST-BFA-11. Red when: the sql placeholder ignores the postgres
 * backend; the pgvector dimension is ignored; a surface's error code is
 * replaced; the kv delete does not delete; the family allowlist is removed
 * (the nosql case asserts the allowlist's own message, because the surface
 * lookup behind it refuses with the same code).
 */
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeContext } from '../src/executor/types.js';
import { buildHostSurfaceBundle, initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { PROBED_STORAGE_FAMILIES, probeEmbedding, storageProbeNode } from '../src/bootstrap/conformanceStorageProbe.js';

beforeAll(() => { initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'storage-probe-')) }); });

const ENV = ['OPENWOP_SURFACE_SQL', 'OPENWOP_SURFACE_VECTOR', 'OPENWOP_VECTOR_PG_DIM'] as const;
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
afterEach(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

type Surfaces = Pick<NodeContext, 'storage' | 'db'>;
function ctxFor(tenantId: string, vars: Record<string, string>, override?: Surfaces): NodeContext {
  const variables = { get: (n: string) => vars[n], set: () => undefined };
  const emit = async () => ({ eventId: 'ev-probe', sequence: 1 });
  const base = { runId: 'run-probe', nodeId: 'probe', tenantId, attempt: 1, secrets: {}, configurable: {}, inputs: {}, variables, emit };
  if (override) return { ...base, ...override }; // stubbed surfaces: no real bundle
  const b = buildHostSurfaceBundle({ tenantId });
  return { ...base, storage: b.storage, db: b.db };
}

async function run(tenant: string, vars: Record<string, string>, override?: Surfaces) {
  return storageProbeNode.execute(ctxFor(tenant, vars, override));
}
const result = (o: Awaited<ReturnType<typeof run>>): Record<string, unknown> => {
  expect(o.status, JSON.stringify(o)).toBe('success');
  return (o as { outputs: { result: Record<string, unknown> } }).outputs.result;
};

describe('storage probe — every probed family, two tenants, one key', () => {
  for (const family of PROBED_STORAGE_FAMILIES) {
    it(`${family}: A reads back what it wrote; B reads nothing under the same key; delete removes it`, async () => {
      const key = `k-${family}-${Math.random().toString(36).slice(2)}`;
      const value = `v-${key}`;
      const w = result(await run('tenant-a', { family, action: 'write', key, value }));
      expect(w['written']).toBe(true);
      const ref = typeof w['ref'] === 'string' ? w['ref'] : undefined;
      const read = { family, action: 'read', key, ...(ref ? { ref } : {}) };
      const a = result(await run('tenant-a', read));
      expect(a['values']).toContain(value); // positive control
      const b = result(await run('tenant-b', read));
      expect(b['values']).not.toContain(value);
      expect(b['keys']).not.toContain(key);
      expect(result(await run('tenant-a', { family, action: 'delete', key, ...(ref ? { ref } : {}) }))['deleted']).toBe(true);
      if (family !== 'vectorStore') expect(result(await run('tenant-a', read))['values']).not.toContain(value);
    });
  }
});

describe('storage probe — backend-dependent spelling', () => {
  it('sql uses $n placeholders on postgres and ? on the sqlite backends', async () => {
    const seen: string[] = [];
    const sql = { execute: async (a: Record<string, unknown>) => { seen.push(String(a['sql'])); return {}; }, query: async () => ({ rows: [] }) };
    process.env.OPENWOP_SURFACE_SQL = 'postgres';
    await run('t', { family: 'sql', action: 'write', key: 'k', value: 'v' }, { db: { sql } });
    expect(seen.at(-1)).toContain('VALUES ($1, $2)');
    delete process.env.OPENWOP_SURFACE_SQL;
    await run('t', { family: 'sql', action: 'write', key: 'k', value: 'v' }, { db: { sql } });
    expect(seen.at(-1)).toContain('VALUES (?, ?)');
  });

  it('E(key) is deterministic, unit-length, and sized to the pgvector column when pgvector is selected', async () => {
    expect(probeEmbedding('x', 16)).toEqual(probeEmbedding('x', 16));
    expect(Math.hypot(...probeEmbedding('x', 40))).toBeCloseTo(1, 9);
    let dim = 0;
    const vector = {
      upsert: async (a: Record<string, unknown>) => {
        const items = a['items'];
        if (!Array.isArray(items) || !Array.isArray(items[0]?.vector)) throw new Error('upsert carried no vector');
        dim = items[0].vector.length;
        return {};
      },
    };
    process.env.OPENWOP_SURFACE_VECTOR = 'pgvector';
    process.env.OPENWOP_VECTOR_PG_DIM = '1536';
    await run('t', { family: 'vectorStore', action: 'write', key: 'k', value: 'v' }, { db: { vector } });
    expect(dim).toBe(1536);
  });
});

describe('storage probe — refusals pass through, nothing is invented', () => {
  it('a surface rejection fails the node with its code unchanged', async () => {
    const kv = { set: async () => { throw Object.assign(new Error('nope'), { code: 'storage_limit_exceeded' }); } };
    const o = await run('t', { family: 'kvStorage', action: 'write', key: 'k', value: 'v' }, { storage: { kv } });
    expect(o).toMatchObject({ status: 'failure', error: { code: 'storage_limit_exceeded' } });
  });

  it('an unprobed family (nosql) is a typed failure, never a vacuous success', async () => {
    const o = await run('t', { family: 'nosql', action: 'read', key: 'k' });
    expect(o).toMatchObject({ status: 'failure', error: { code: 'host_capability_missing', message: "storage-probe does not implement family 'nosql'" } });
  });
});
