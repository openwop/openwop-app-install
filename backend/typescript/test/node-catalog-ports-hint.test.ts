/**
 * ADR 0782 — the catalog serves a node entry's `x-ports: "single"` hint as
 * `ports: 'single'`, and ONLY that recognised value. The builder uses it to keep
 * one input port for a node whose input schema declares several `required`
 * fields, so restoring `required` does not re-route saved edges.
 * (A real pack's both-directions check is in its owner's tests.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
