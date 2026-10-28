/**
 * `buildSchemaResponse` — the `kind: "node"` answer of `openwop:schema.lookup`
 * (and of the Claude Code MCP `claude-code-schema-lookup`, which shares
 * `host/schemaLookup.ts`). CLAUDE.md "AI↔app information exchange": schema text
 * reaching a model is generated from its SSoT, so a node's answer must carry the
 * config / input / output schemas its pack manifest declares.
 *
 * SCHRESP-PORTS-1 (2026-10-18): the responder read `getNodeRegistry()` and pulled
 * `inputs` / `outputs` / `configSchema` off the registered NodeModule, which
 * carries none of them — so EVERY answer was `inputs: [], outputs: []` with no
 * `configSchema`, and a pack node the registry had not resolved came back
 * `notFound`. This file's old port case asserted only "is an array" inside an
 * `if (inputs.length > 0)`, so it passed on the empty answer. The cases below
 * read the EXPECTED schemas from the pack manifest on disk (never through the
 * catalog the responder reads). MEASURED with 991a62253's registry-sourced
 * responder restored: 6 of 8 red — the manifest-schema, field-descriptor,
 * unresolved-pack-node and tool-lane cases witness the defect; the
 * missingHostSurfaces and bundleVersion cases red only because the old function
 * took no injected catalog. The two name-resolution cases stay green.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { ensureLocalPacksMounted } from '../src/bootstrap/mountLocalPacks.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { buildSchemaResponse } from '../src/host/schemaResponder.js';
import { lookupAppSchemas } from '../src/host/schemaLookup.js';
import type { CatalogNode } from '../src/host/nodeCatalogBuilder.js';

const REPO_PACKS = join(dirname(fileURLToPath(import.meta.url)), '../../../packs');

interface ManifestNode { typeId: string; configSchemaRef?: string; inputSchemaRef?: string; outputSchemaRef?: string }

/** A node's schemas read straight from the repo's pack manifest. */
function manifestSchemas(pack: string, typeId: string): { config: unknown; input: unknown; output: unknown } {
  const m = JSON.parse(readFileSync(join(REPO_PACKS, pack, 'pack.json'), 'utf-8')) as { nodes: ManifestNode[] };
  const n = m.nodes.find((x) => x.typeId === typeId);
  if (!n) throw new Error(`${typeId} not in ${pack}`);
  const read = (ref?: string): unknown => (ref ? JSON.parse(readFileSync(join(REPO_PACKS, pack, ref), 'utf-8')) : undefined);
  return { config: read(n.configSchemaRef), input: read(n.inputSchemaRef), output: read(n.outputSchemaRef) };
}

describe('schemaResponder.buildSchemaResponse', () => {
  beforeAll(() => {
    ensureNodesRegistered();   // in-process modules (core.noop, local.openwop-app.mock-ai, …)
    ensureLocalPacksMounted(); // pack-declared nodes (this worker's isolated pack dir)
  });

  it('serves a pack node\'s config / input / output schemas verbatim from its manifest', () => {
    const want = manifestSchemas('core.openwop.flow', 'core.flow.wait');
    const res = buildSchemaResponse({ names: ['core.flow.wait'] });
    expect(res.notFound).toEqual([]);
    const s = res.schemas[0];
    expect(s?.typeId).toBe('core.flow.wait');
    expect(s?.configSchema).toEqual(want.config);
    expect(s?.inputSchema).toEqual(want.input);
    expect(s?.outputSchema).toEqual(want.output);
  });

  it('derives one { name, type } field descriptor per input / output schema property', () => {
    const want = manifestSchemas('core.openwop.flow', 'core.flow.wait');
    const props = (want.output as { properties: Record<string, { type?: string }> }).properties;
    const res = buildSchemaResponse({ names: ['core.flow.wait'] });
    expect(res.schemas[0]?.outputs).toEqual(
      Object.entries(props).map(([name, p]) => ({ name, type: typeof p.type === 'string' ? p.type : 'any' })),
    );
    const inputs = (want.input as { properties: Record<string, { type?: string }> }).properties;
    expect(inputs.timestamp?.type).toBe('string');
    expect(res.schemas[0]?.inputs).toEqual(
      Object.entries(inputs).map(([name, p]) => ({ name, type: typeof p.type === 'string' ? p.type : 'any' })),
    );
  });

  it('resolves a pack node the in-process registry has NOT resolved (not notFound)', () => {
    // Pick, from the repo manifests, a node that declares a config schema and
    // that the registry does not list — the case the registry source got wrong.
    const reg = new Set(getNodeRegistry().listTypeIds());
    let pick: { pack: string; typeId: string } | null = null;
    for (const pack of readdirSync(REPO_PACKS)) {
      const p = join(REPO_PACKS, pack, 'pack.json');
      if (!existsSync(p)) continue;
      const m = JSON.parse(readFileSync(p, 'utf-8')) as { nodes?: ManifestNode[] };
      const n = (m.nodes ?? []).find((x) => x.configSchemaRef && !reg.has(x.typeId));
      if (n) { pick = { pack, typeId: n.typeId }; break; }
    }
    expect(pick, 'the repo must hold a configured pack node outside the registry').not.toBeNull();
    const res = buildSchemaResponse({ names: [pick!.typeId] });
    expect(res.notFound).toEqual([]);
    expect(res.schemas[0]?.configSchema).toEqual(manifestSchemas(pick!.pack, pick!.typeId).config);
  });

  it('the chat tool lane (lookupAppSchemas kind "node") carries the manifest config schema', async () => {
    const r = await lookupAppSchemas({ kind: 'node', names: ['core.flow.wait'] });
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: { schemas: Array<{ configSchema?: unknown }> } }).value;
    expect(v.schemas[0]?.configSchema).toEqual(manifestSchemas('core.openwop.flow', 'core.flow.wait').config);
  });

  it('resolves an exact typeId, a trailing segment, and case / separator variants', () => {
    expect(buildSchemaResponse({ names: ['core.noop'] }).schemas.map((s) => s.typeId)).toEqual(['core.noop']);
    const seg = buildSchemaResponse({ names: ['noop'] }).schemas;
    expect(seg).toHaveLength(1);
    expect(seg[0]?.kind).toBe('noop');
    for (const v of ['mock-ai', 'MockAi', 'mock_ai', 'MOCK-AI']) {
      const res = buildSchemaResponse({ names: [v] });
      expect(res.schemas.map((s) => s.kind), `variant=${v}`).toEqual(['mock-ai']);
    }
  });

  it('reports unknown names as notFound, skips empty names, and splits a mixed batch', () => {
    const res = buildSchemaResponse({ names: ['', 'core.noop', 'definitely-not-a-real-node-kind'] });
    expect(res.schemas.map((s) => s.typeId)).toEqual(['core.noop']);
    expect(res.notFound).toEqual(['definitely-not-a-real-node-kind']);
  });

  it('marks a node this host cannot run with its missing host surfaces', () => {
    const node: CatalogNode = {
      typeId: 'vendor.x.needs-a-surface', label: 'x', description: '', category: 'flow', source: 'pack',
      requiresHostSurfaces: ['host.example'], missingHostSurfaces: ['host.example'],
    };
    const res = buildSchemaResponse({ names: ['vendor.x.needs-a-surface'] }, [node]);
    expect(res.schemas[0]?.missingHostSurfaces).toEqual(['host.example']);
    expect(buildSchemaResponse({ names: ['core.noop'] }).schemas[0]).not.toHaveProperty('missingHostSurfaces');
  });

  it('bundleVersion is a hash of the node inventory: stable, and distinct per inventory', () => {
    const base: CatalogNode = { typeId: 'a.b.c', label: '', description: '', category: 'flow', source: 'pack', requiresHostSurfaces: [], missingHostSurfaces: [] };
    const one = buildSchemaResponse({ names: [] }, [base]).bundleVersion;
    expect(buildSchemaResponse({ names: [] }, [base]).bundleVersion).toBe(one);
    expect(buildSchemaResponse({ names: [] }, [base, { ...base, typeId: 'a.b.d' }]).bundleVersion).not.toBe(one);
    expect(one).toMatch(/^registry-[0-9a-f]{12}$/);
  });
});
