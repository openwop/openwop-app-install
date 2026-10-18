/**
 * ADR 0099 Phase 3 — the ctx.features['tool-output-compaction'].compact surface
 * (explicit mid-graph compaction) + its toggle gating, and ADR 0680 D1 (mode and
 * count args are REFUSED, never defaulted; the pack publishes the enum).
 *
 * Sabotages that turn it red (w22 probes): default the mode to `lossy`; drop the
 * head pass-through; default an unknown mode; skip trim/lowercase; drop a mode
 * from MODES; accept non-integer counts or floor them at 1; disable the
 * featureSurfaces toggle gate either way; register the surface under another
 * id; drop a mode from the pack's input-schema enum.
 *
 * Kernel behaviour the surface only forwards (non-JSON pass-through) lives in
 * `tool-output-compaction-kernel.test.ts`; the requiredPacks version pin lives in
 * `tool-output-compaction-node-catalog-parity.test.ts` ("the four version legs
 * move together"), which derives it from the manifest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildToolOutputCompactionSurface } from '../src/features/tool-output-compaction/surface.js';
import { toolOutputCompactionFeature } from '../src/features/tool-output-compaction/feature.js';
import { registerFeatureSurface, buildFeatureSurfaces, __clearFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';

// ADR 0734: registerFeatureSurface() mutates a module-level registry this file
// dirtied and never cleaned up. Hygiene — leave the registry as we found it.
// NOT a cross-file fix: vitest forks a fresh process per test file (measured),
// so this residue could never have reached another file. See the ADR's
// correction note before citing this as protection.
afterAll(() => { __clearFeatureSurfaces(); });

const TENANT = 'tenant-s';
const ID = 'tool-output-compaction';
const storage = openSqliteStorage(':memory:');
const sparse = JSON.stringify({ items: [{ id: 1, tags: [], note: null }, { id: 2, tags: [], note: '' }] }, null, 2);

interface CompactOut { output: string; mode: string; originalChars: number; compactedChars: number }
function isCompactOut(v: unknown): v is CompactOut {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.output === 'string' && typeof o.mode === 'string'
    && typeof o.originalChars === 'number' && typeof o.compactedChars === 'number';
}
async function callCompact(fn: (a: Record<string, unknown>) => Promise<unknown>, args: Record<string, unknown>): Promise<CompactOut> {
  const out = await fn(args);
  if (!isCompactOut(out)) throw new Error(`compact returned a non-CompactOut shape: ${JSON.stringify(out)}`);
  return out;
}

beforeAll(() => initHostExtPersistence(storage));
afterAll(async () => storage.close());
beforeEach(async () => {
  initHostExtPersistence(storage);
  await __clearToggleStore();
  registerToggleDefault(toolOutputCompactionFeature.toggleDefault!);
});

describe('buildToolOutputCompactionSurface().compact', () => {
  const surface = buildToolOutputCompactionSurface({ tenantId: TENANT });

  /**
   * ADR 0604 review H2 — THIS TEST WAS RED ON THE BRANCH AND PINNED THE DEFECT.
   *
   * It was named "minifies + drops empty" and asserted `not.toContain('tags')`,
   * i.e. it required the mode named LOSSLESS to delete an empty array. TOCC-3
   * removed that behaviour and rewrote the KERNEL test, but this surface test
   * was never revisited — so the branch shipped a red suite whose failure
   * message ("expected … not to contain 'tags'") reads like a regression when
   * it is the fix landing.
   *
   * The surface takes a CALLER-SUPPLIED string (a workflow node's input), which
   * is one of the two lanes where the byte-level guarantee actually bites, so
   * the replacement asserts that guarantee rather than a character count.
   */
  it('lossless by default — deletes whitespace and NOTHING else, with char counts', async () => {
    const out = await callCompact(surface.compact, { input: sparse });
    expect(out.mode).toBe('lossless');
    expect(out.compactedChars).toBeLessThan(out.originalChars); // the fixture is indented
    expect(out.output).toContain('tags'); // an honest empty SURVIVES (was: not.toContain)
    expect(JSON.parse(out.output)).toEqual(JSON.parse(sparse));
    expect(out.output).not.toContain('\n');
  });

  it('lossy elides long arrays', async () => {
    const big = JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i })) });
    const out = await callCompact(surface.compact, { input: big, mode: 'lossy', head: 2, tail: 1 });
    expect(out.mode).toBe('lossy');
    expect((JSON.parse(out.output) as { items: unknown[] }).items).toHaveLength(4); // 2 + marker + 1
  });

  // INVERTED by ADR 0680 D1a — this test PINNED THE DEFECT. It asserted that an unrecognised
  // mode silently becomes `lossless`, which is exactly the behaviour that turned a failed `off`
  // into a rewrite of bytes the caller asked to keep. Inverted rather than deleted, so the
  // record shows the assertion changed hands rather than quietly vanishing.
  it('REFUSES an unknown mode instead of defaulting to lossless', async () => {
    await expect(callCompact(surface.compact, { input: sparse, mode: 'bogus' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('case/whitespace slips of `off` resolve to off — never upgraded to lossless (the direction the filed row never probed)', async () => {
    // `off` on this lane means "do not touch my bytes" (a caller hashing/signing/diffing a
    // payload). Case and whitespace slips are exactly what a hand-authored config produces.
    for (const m of ['Off', 'OFF', ' off ']) {
      const out = await callCompact(surface.compact, { input: sparse, mode: m });
      expect(out.mode, `${JSON.stringify(m)} must resolve to off, never lossless`).toBe('off');
      expect(out.output, `${JSON.stringify(m)}: off means the bytes are untouched`).toBe(sparse);
    }
  });

  it('the three canonical spellings still pass', async () => {
    for (const m of ['off', 'lossless', 'lossy']) {
      const out = await callCompact(surface.compact, { input: sparse, mode: m });
      expect(out.mode).toBe(m);
    }
  });

  it('a wrong-typed count is REFUSED, not silently replaced by a default elision (D1c)', async () => {
    for (const bad of [{ head: '20' }, { head: 3.5 }, { tail: -1 }]) {
      await expect(callCompact(surface.compact, { input: sparse, mode: 'lossy', ...bad }))
        .rejects.toMatchObject({ code: 'validation_error' });
    }
    // …but 0 stays LEGAL: `head:0` is tail-only elision. This is why the shared
    // `surfaceOptCount` (which floors at 1) could not be used verbatim.
    await expect(callCompact(surface.compact, { input: sparse, mode: 'lossy', head: 0 })).resolves.toMatchObject({ mode: 'lossy' });
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
  it('the feature registers the surface under its toggle id', () => {
    // The surface id IS the toggle id the featureSurfaces gate resolves.
    expect(toolOutputCompactionFeature.surface?.id).toBe(ID);
    expect(toolOutputCompactionFeature.toggleDefault?.id).toBe(ID);
  });
});

/**
 * ADR 0680 D1b — the closed world an authoring model reads must name the legal modes, and it
 * must land WITH the refusal, not after it.
 *
 * The Workflow Architect builds its catalog from this node's manifest
 * (`workflowAuthorService.ts` → `buildNodeCatalog`), and nothing validates node config on the
 * authoring path (`nodeCatalogBuilder.findUnknownTypeIds` checks typeIds only). So refusing an
 * unrecognised mode without publishing the enum would fail a model that had no way to know the
 * legal values — this repo's own non-negotiable read backwards.
 */
describe('ADR 0680 D1b — the enum exists before the refusal does', () => {
  it('the pack declares an inputSchema enumerating exactly the three legal modes', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const packDir = join(repo, 'packs', 'feature.tool-output-compaction.nodes');
    const pack = JSON.parse(readFileSync(join(packDir, 'pack.json'), 'utf8')) as {
      nodes: { typeId: string; inputSchemaRef?: string }[];
    };
    const node = pack.nodes.find((n) => n.typeId.endsWith('.compact'));
    expect(node?.inputSchemaRef, 'the node must declare an inputSchemaRef').toBeTruthy();
    const schema = JSON.parse(readFileSync(join(packDir, node!.inputSchemaRef!), 'utf8')) as {
      properties: { mode?: { enum?: string[] }; head?: { minimum?: number } };
      required?: string[];
    };
    expect(schema.properties.mode?.enum, 'the enum the authoring model reads').toEqual(['off', 'lossless', 'lossy']);
    // `required: ['input']` is the third instance of the same class — `str(args.input)` used to
    // coerce a missing input to '' and report `originalChars: 0` as a success.
    expect(schema.required).toContain('input');
    // The published floor must match the parser's: `head: 0` is legal (tail-only elision).
    expect(schema.properties.head?.minimum).toBe(0);
  });
});
