/**
 * ADR 0782 — the catalog serves a node entry's `x-ports: "single"` hint as
 * `ports: 'single'`, and ONLY that recognised value. The builder uses it to keep
 * one input port for a node whose input schema declares several `required`
 * fields (the kicktodo 17), so restoring `required` does not re-route saved edges.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNodeCatalog } from '../src/host/nodeCatalogBuilder.js';
import { resolveDefaultPackDir } from '../src/packs/registryInstaller.js';

const PACK = 'vendor.test.ports-hint';
let dir = '';

beforeAll(() => {
  dir = join(resolveDefaultPackDir(), PACK);
  mkdirSync(join(dir, 'schemas'), { recursive: true });
  writeFileSync(join(dir, 'schemas', 'multi.input.json'), JSON.stringify({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] }));
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: PACK, version: '1.0.0', kind: 'node',
    nodes: [
      { typeId: 'vendor.test.ph.single', version: '1.0.0', label: 'S', inputSchemaRef: 'schemas/multi.input.json', 'x-ports': 'single' },
      { typeId: 'vendor.test.ph.default', version: '1.0.0', label: 'D', inputSchemaRef: 'schemas/multi.input.json' },
      { typeId: 'vendor.test.ph.unknown', version: '1.0.0', label: 'U', inputSchemaRef: 'schemas/multi.input.json', 'x-ports': 'bogus' },
    ],
  }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('buildNodeCatalog — x-ports hint (ADR 0782)', () => {
  const node = (t: string) => buildNodeCatalog().find((n) => n.typeId === t);

  it('serves ports:"single" and still serves the schema with its required fields', () => {
    const n = node('vendor.test.ph.single');
    expect(n?.ports).toBe('single');
    expect((n?.inputSchema as { required?: string[] }).required).toEqual(['a', 'b']);
  });
  it('serves nothing for an absent or unrecognised hint', () => {
    expect(node('vendor.test.ph.default')).not.toHaveProperty('ports');
    expect(node('vendor.test.ph.unknown')).not.toHaveProperty('ports');
  });
});

describe('the 17 restored kicktodo schemas (ADR 0782)', () => {
  it('in this pack, a node declares `required` IF AND ONLY IF it carries the hint (both directions)', () => {
    const root = join(__dirname, '..', '..', '..', 'packs', 'feature.kicktodo.nodes');
    const m = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8')) as { nodes: Array<{ typeId: string; inputSchemaRef?: string; 'x-ports'?: string }> };
    const hinted = m.nodes.filter((n) => n['x-ports'] === 'single');
    expect(hinted.length, 'the D-5 restoration covers 17 nodes').toBe(17);
    for (const n of m.nodes) {
      if (!n.inputSchemaRef) continue;
      const s = JSON.parse(readFileSync(join(root, n.inputSchemaRef), 'utf8')) as { required?: string[] };
      const declares = (s.required?.length ?? 0) > 0;
      // An UNHINTED node gaining `required` would split its `in` port and re-route
      // its saved edges — the exact hazard ADR 0782 exists to prevent.
      expect(declares, `${n.typeId}: required ⇔ x-ports:"single"`).toBe(n['x-ports'] === 'single');
    }
  });
});
