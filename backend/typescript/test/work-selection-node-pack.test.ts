/**
 * ADR 0534 P4 (WSL-1) — the node pack's RUNTIME behaviour.
 *
 * `pack-manifest-impl-parity` proves the manifest and the module agree on which
 * node ids exist. It does not execute anything, so a node could satisfy parity
 * and still throw, mis-shape its output, or silently swallow a host that lacks
 * the surface. This runs the real module against a real `ctx`.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const PACK = require_.resolve('../../../packs/feature.work-selection.nodes/index.mjs');

const load = async (): Promise<Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>>> => {
  const mod = (await import(PACK)) as { nodes: Record<string, never> };
  return mod.nodes as never;
};

const ranked = [
  { cardId: 'c1', title: 'high', rank: 1, score: 8, why: [{ criterionId: 'ws.priority', criterion: 'Stated priority', value: 10 }] },
  { cardId: 'c2', title: 'low', rank: 2, score: 3, why: [] },
];

describe('feature.work-selection.nodes — runtime', () => {
  it('preview forwards to the surface and reports a count', async () => {
    const nodes = await load();
    const calls: unknown[] = [];
    const out = await nodes['feature.work-selection.nodes.preview']!({
      inputs: { boardId: 'b1' },
      features: { 'work-selection': { preview: async (a: unknown) => { calls.push(a); return { ranked }; } } },
    });

    expect(out.status).toBe('success');
    expect(out.outputs).toEqual({ ranked, count: 2 });
    expect(calls, 'the boardId must reach the surface').toEqual([{ boardId: 'b1' }]);
  });

  it('a missing boardId becomes an empty string, never `undefined` on the wire', async () => {
    const nodes = await load();
    const calls: unknown[] = [];
    await nodes['feature.work-selection.nodes.preview']!({
      inputs: {},
      features: { 'work-selection': { preview: async (a: unknown) => { calls.push(a); return { ranked: [] } } } },
    });
    expect(calls).toEqual([{ boardId: '' }]);
  });

  it('a non-array `ranked` degrades to [] rather than propagating garbage', async () => {
    const nodes = await load();
    const out = await nodes['feature.work-selection.nodes.preview']!({
      inputs: { boardId: 'b1' },
      features: { 'work-selection': { preview: async () => ({ ranked: null }) } },
    });
    expect(out.outputs).toEqual({ ranked: [], count: 0 });
  });

  it('fails TYPED when the host does not expose the surface', async () => {
    // The honest failure: a host without the feature enabled must get a named
    // capability error, not a TypeError from calling undefined.
    const nodes = await load();
    await expect(
      nodes['feature.work-selection.nodes.preview']!({ inputs: { boardId: 'b1' }, features: {} }),
    ).rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.sample.work-selection' });
  });
});
