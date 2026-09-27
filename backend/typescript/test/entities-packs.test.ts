/**
 * feature.entities.nodes pack pins (ADR 0386 Phase 6) — manifest↔impl↔feature
 * lockstep: version pin, node typeIds, executor behavior over a fake
 * ctx.features.entities, and the deterministic-id (ADR 0162) convention.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, '..', '..', '..', 'packs', 'feature.entities.nodes');
const manifest = JSON.parse(readFileSync(join(packDir, 'pack.json'), 'utf8')) as {
  name: string;
  version: string;
  nodes: Array<{ typeId: string; role: string }>;
};

const EXPECTED_TYPE_IDS = [
  'feature.entities.nodes.types-read',
  'feature.entities.nodes.query',
  'feature.entities.nodes.get',
  'feature.entities.nodes.create',
  'feature.entities.nodes.update',
  'feature.entities.nodes.delete',
];

describe('feature.entities.nodes pack', () => {
  it('manifest pins name/version and exactly the six node typeIds', () => {
    expect(manifest.name).toBe('feature.entities.nodes');
    expect(manifest.version).toBe('1.1.0');
    expect(manifest.nodes.map((n) => n.typeId).sort()).toEqual([...EXPECTED_TYPE_IDS].sort());
    for (const n of manifest.nodes) expect(n.role).toBe('action');
  });

  it('feature.ts pins the same pack version (bump both together)', () => {
    const featureSrc = readFileSync(
      join(here, '..', 'src', 'features', 'entities', 'feature.ts'),
      'utf8',
    );
    expect(featureSrc).toContain("{ name: 'feature.entities.nodes', version: '1.1.0' }");
  });

  it('impl exports exactly the manifest nodes; executors drive the surface; create uses the ADR 0162 id', async () => {
    const mod = (await import(pathToFileURL(join(packDir, 'index.mjs')).href)) as {
      nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown> }>>;
    };
    expect(Object.keys(mod.nodes).sort()).toEqual([...EXPECTED_TYPE_IDS].sort());

    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const fakeSurface = {
      listTypes: async (args: Record<string, unknown>) => {
        calls.push({ op: 'listTypes', args });
        return { types: [{ name: 'recipe' }] };
      },
      getType: async (args: Record<string, unknown>) => {
        calls.push({ op: 'getType', args });
        return { type: { name: String(args.typeName) } };
      },
      query: async (args: Record<string, unknown>) => {
        calls.push({ op: 'query', args });
        return { entities: [], total: 0 };
      },
      get: async (args: Record<string, unknown>) => {
        calls.push({ op: 'get', args });
        return { entity: null };
      },
      create: async (args: Record<string, unknown>) => {
        calls.push({ op: 'create', args });
        return { entity: { entityId: args.entityId } };
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ op: 'update', args });
        return { entity: { entityId: args.entityId } };
      },
      delete: async (args: Record<string, unknown>) => {
        calls.push({ op: 'delete', args });
        return { deleted: true };
      },
    };
    const ctx = (config: Record<string, unknown>, inputs: Record<string, unknown> = {}): Record<string, unknown> => ({
      config,
      inputs,
      runId: 'runX',
      nodeId: 'nodeY',
      features: { entities: fakeSurface },
    });

    const listOut = await mod.nodes['feature.entities.nodes.types-read']?.(ctx({}));
    expect(listOut?.outputs.types).toEqual([{ name: 'recipe' }]);

    // create without an explicit id → deterministic entity:<runId>:<nodeId>
    const created = await mod.nodes['feature.entities.nodes.create']?.(
      ctx({ typeName: 'recipe', values: { title: 'X' } }),
    );
    expect((created?.outputs.entity as { entityId: string }).entityId).toBe('entity:runX:nodeY');
    // explicit id wins
    const created2 = await mod.nodes['feature.entities.nodes.create']?.(
      ctx({ typeName: 'recipe', values: { title: 'X' }, entityId: 'mine' }),
    );
    expect((created2?.outputs.entity as { entityId: string }).entityId).toBe('mine');

    // inputs win over config (the merge idiom)
    await mod.nodes['feature.entities.nodes.get']?.(ctx({ typeName: 'a', entityId: 'c1' }, { entityId: 'c2' }));
    const lastGet = calls.filter((c) => c.op === 'get').pop();
    expect(lastGet?.args.entityId).toBe('c2');

    // capability error when the surface is absent
    await expect(
      mod.nodes['feature.entities.nodes.query']?.({ config: { typeName: 'x' }, inputs: {}, features: {} }),
    ).rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.openwop-app.entities' });
  });
});
