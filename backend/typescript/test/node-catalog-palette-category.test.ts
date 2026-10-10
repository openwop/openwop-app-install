/**
 * grade-code C-8 / ADR 0767 D4 — the catalog serves `x-paletteCategory` AHEAD of
 * the spec `category`, so a v2-honest manifest (`category: "control"`) keeps its
 * palette group (`flow`). Without this the P4c migration would have silently
 * collapsed the palette's Flow and AI groups into Control.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNodeCatalog } from '../src/host/nodeCatalogBuilder.js';
import { resolveDefaultPackDir } from '../src/packs/registryInstaller.js';

const PACK = 'vendor.test.palette-category';
let dir = '';

beforeAll(() => {
  dir = join(resolveDefaultPackDir(), PACK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: PACK, version: '1.0.0', kind: 'node',
    nodes: [
      { typeId: 'vendor.test.pc.hinted', version: '1.0.0', label: 'Hinted', category: 'control', 'x-paletteCategory': 'flow' },
      { typeId: 'vendor.test.pc.plain', version: '1.0.0', label: 'Plain', category: 'data' },
      { typeId: 'vendor.test.pc.none', version: '1.0.0', label: 'None' },
    ],
  }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('buildNodeCatalog — palette category (ADR 0767 D4)', () => {
  const categoryOf = (typeId: string) => buildNodeCatalog().find((n) => n.typeId === typeId)?.category;

  it('serves x-paletteCategory ahead of category', () => {
    expect(categoryOf('vendor.test.pc.hinted')).toBe('flow');
  });
  it('falls back to the spec category, then to flow', () => {
    expect(categoryOf('vendor.test.pc.plain')).toBe('data');
    expect(categoryOf('vendor.test.pc.none')).toBe('flow');
  });
});

describe('ADR 0782 D4 — the agent-orchestration nodes group under AI', () => {
  it('every node in vendor.myndhyve.agent-orchestration declares x-paletteCategory "ai"', async () => {
    const { readFileSync } = await import('node:fs');
    const m = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'packs', 'vendor.myndhyve.agent-orchestration', 'pack.json'), 'utf8')) as { nodes: Array<{ typeId: string; 'x-paletteCategory'?: string }> };
    expect(m.nodes.length).toBe(12);
    for (const n of m.nodes) expect(n['x-paletteCategory'], n.typeId).toBe('ai');
  });
});
