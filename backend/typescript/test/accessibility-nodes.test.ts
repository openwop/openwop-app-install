/**
 * ADR 0363 P3 — feature.accessibility.nodes pack execution. Runs each node
 * against a stub `ctx.features.accessibility` and asserts the honest
 * host_capability_missing when the surface is absent (spine-skip safety).
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packUrl = new URL('../../../packs/feature.accessibility.nodes/index.mjs', import.meta.url);

async function loadNodes() {
  return import(path.resolve(fileURLToPath(packUrl)));
}

describe('feature.accessibility.nodes', () => {
  it('check: forwards the model to ctx.features.accessibility.checkContent', async () => {
    const { check } = await loadNodes();
    const calls: unknown[] = [];
    const ctx = {
      inputs: { images: [{ alt: '' }], headings: [{ level: 1 }, { level: 3 }] },
      features: { accessibility: { checkContent: async (m: unknown) => { calls.push(m); return { issues: [{ kind: 'missing-alt' }, { kind: 'heading-skip' }] }; } } },
    };
    const r = await check(ctx);
    expect(r.status).toBe('success');
    expect(r.outputs.count).toBe(2);
    expect((calls[0] as { images: unknown[] }).images).toHaveLength(1);
  });

  it('alt-text-generate: forwards { orgId, assetId } to the surface', async () => {
    const { altTextGenerate } = await loadNodes();
    const ctx = {
      inputs: { orgId: 'org1', assetId: 'a1' },
      features: { accessibility: { checkContent: async () => ({ issues: [] }), generateAltText: async (a: { orgId: string; assetId: string }) => ({ assetId: a.assetId, altText: 'A red bike' }) } },
    };
    const r = await altTextGenerate(ctx);
    expect(r.outputs).toEqual({ assetId: 'a1', altText: 'A red bike' });
  });

  it('both nodes fail closed with host_capability_missing when the surface is absent', async () => {
    const { check, altTextGenerate } = await loadNodes();
    const ctx = { inputs: {}, features: {} };
    await expect(check(ctx)).rejects.toMatchObject({ code: 'host_capability_missing' });
    await expect(altTextGenerate(ctx)).rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});
