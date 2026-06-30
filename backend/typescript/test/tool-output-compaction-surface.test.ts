/**
 * ADR 0099 Phase 3 — the ctx.features['tool-output-compaction'].compact surface
 * (explicit mid-graph compaction) + its toggle gating.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildToolOutputCompactionSurface } from '../src/features/tool-output-compaction/surface.js';
import { toolOutputCompactionFeature } from '../src/features/tool-output-compaction/feature.js';
import { registerFeatureSurface, buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';

const TENANT = 'tenant-s';
const ID = 'tool-output-compaction';
const storage = openSqliteStorage(':memory:');
const sparse = JSON.stringify({ items: [{ id: 1, tags: [], note: null }, { id: 2, tags: [], note: '' }] }, null, 2);

interface CompactOut { output: string; mode: string; originalChars: number; compactedChars: number }
const callCompact = (fn: (a: Record<string, unknown>) => Promise<unknown>, args: Record<string, unknown>) =>
  fn(args) as Promise<CompactOut>;

beforeAll(() => initHostExtPersistence(storage));
afterAll(async () => storage.close());
beforeEach(async () => {
  initHostExtPersistence(storage);
  await __clearToggleStore();
  registerToggleDefault(toolOutputCompactionFeature.toggleDefault!);
});

describe('buildToolOutputCompactionSurface().compact', () => {
  const surface = buildToolOutputCompactionSurface({ tenantId: TENANT });

  it('lossless by default — minifies + drops empty, with char counts', async () => {
    const out = await callCompact(surface.compact, { input: sparse });
    expect(out.mode).toBe('lossless');
    expect(out.compactedChars).toBeLessThan(out.originalChars);
    expect(out.output).not.toContain('tags');
  });

  it('lossy elides long arrays', async () => {
    const big = JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i })) });
    const out = await callCompact(surface.compact, { input: big, mode: 'lossy', head: 2, tail: 1 });
    expect(out.mode).toBe('lossy');
    expect((JSON.parse(out.output) as { items: unknown[] }).items).toHaveLength(4); // 2 + marker + 1
  });

  it('non-JSON passes through untouched', async () => {
    const out = await callCompact(surface.compact, { input: 'connection refused' });
    expect(out.output).toBe('connection refused');
  });

  it('defaults to lossless for an unknown mode', async () => {
    const out = await callCompact(surface.compact, { input: sparse, mode: 'bogus' });
    expect(out.mode).toBe('lossless');
  });
});

describe('toggle gating (ctx.features gate)', () => {
  beforeEach(() => {
    registerFeatureSurface(ID, buildToolOutputCompactionSurface);
  });

  it('throws host_capability_disabled when the tenant toggle is OFF', async () => {
    await saveConfig({ ...toolOutputCompactionFeature.toggleDefault!, status: 'off' }, 'test');
    const surfaces = buildFeatureSurfaces({ tenantId: TENANT });
    await expect(callCompact(surfaces[ID].compact, { input: sparse })).rejects.toMatchObject({
      code: 'host_capability_disabled',
    });
  });

  it('works when the tenant toggle is ON', async () => {
    await saveConfig({ ...toolOutputCompactionFeature.toggleDefault!, status: 'on' }, 'test');
    const surfaces = buildFeatureSurfaces({ tenantId: TENANT });
    const out = await callCompact(surfaces[ID].compact, { input: sparse });
    expect(out.compactedChars).toBeLessThan(out.originalChars);
  });
});

describe('feature wiring', () => {
  it('the feature registers the surface + the node pack', () => {
    expect(toolOutputCompactionFeature.surface?.id).toBe(ID);
    expect(toolOutputCompactionFeature.requiredPacks).toEqual([
      { name: 'feature.tool-output-compaction.nodes', version: '1.0.0' },
    ]);
  });
});
