/**
 * ADR 0604 review H3 — the node-pack description is MODEL-FACING TEXT, so it is
 * held to the CLAUDE.md non-negotiable: schema text reaching a model is
 * generated from its SSoT or test-pinned to it.
 *
 * WHAT WENT WRONG, AND WHY IT IS THE INTERESTING PART. TOCC-3 removed
 * drop-empty from the `lossless` mode and corrected the PACK-LEVEL description
 * at `pack.json:4`. The NODE-LEVEL description at `pack.json:14` — eleven lines
 * lower, in the same file — still said "minify + drop empty fields", and the
 * ADR's coherence row read as done. A targeted edit fixed the field it was
 * pointed at and missed its sibling, and nothing could see the difference.
 *
 * That field is not documentation. `host/nodeCatalogBuilder.ts` projects
 * `n.description` into the node catalog, and `routes/nodeCatalog.ts` calls that
 * catalog "the SINGLE source shared with the AI workflow-author feature … so
 * the authoring brain plans against the exact catalog the palette renders". So
 * the stale sentence was being handed to a model as the node's contract, for a
 * behaviour that no longer existed.
 *
 * THE INSTRUMENT IS BEHAVIOUR, NOT SPELLING. Every claim the description makes
 * about what each mode does is executed against the real kernel below, so the
 * text cannot drift from the transform without this file going red. The
 * marker names are compared to the kernel's EXPORTED CONSTANTS, not to
 * hand-typed strings. And the catalog leg reads the description back out of
 * `buildNodeCatalog()` after a real mount — the projection the model actually
 * receives — so correcting `pack.json` and forgetting the pack is not a pass.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactToolOutput, EMPTIED_MARKER, ELIDED_MARKER } from '../src/features/tool-output-compaction/compact.js';
import { toolOutputCompactionFeature } from '../src/features/tool-output-compaction/feature.js';

const PACK_DIR = join(process.cwd(), '../../packs/feature.tool-output-compaction.nodes');

interface PackManifest {
  name: string;
  version: string;
  description: string;
  nodes: Array<{ typeId: string; version: string; description: string }>;
}
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as PackManifest;
const node = manifest.nodes.find((n) => n.typeId === 'feature.tool-output-compaction.nodes.compact')!;

/** BOTH description fields. The H3 defect was one of two being corrected. */
const DESCRIPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['pack.description', manifest.description],
  ['node.description', node.description],
];

describe('ADR 0604 H3 — the pack description matches the kernel it describes', () => {
  it('anti-vacuity: both description fields exist and are substantial', () => {
    expect(DESCRIPTIONS).toHaveLength(2);
    for (const [label, text] of DESCRIPTIONS) {
      expect(text, `${label} is missing`).toBeTruthy();
      expect(text.length, `${label} is too short to be making claims`).toBeGreaterThan(80);
    }
  });

  /** "minify + drop", and "…lossless… drop…" with no intervening `lossy`. */
  const STALE_DEFAULT = /minif(?:y|ies)\s*(?:\+|and)\s*drop/i;
  const LOSSLESS_DROPS = /lossless(?:(?!lossy)[^.])*\bdrop/i;

  it('the two detectors DO fire on the shipped stale text (anti-vacuity)', () => {
    // The exact `pack.json:14` sentence this finding is about. Without this,
    // a typo in either pattern would make the assertion below unfailable.
    const SHIPPED_STALE =
      'Compacts a JSON string (minify + drop empty fields; optional lossy array-elision) to cut token '
      + 'spend before it reaches a model.';
    expect(STALE_DEFAULT.test(SHIPPED_STALE)).toBe(true);
    expect(LOSSLESS_DROPS.test('the lossless mode drops empty fields')).toBe(true);
    // …and it does NOT fire on an honest two-clause sentence naming both modes.
    expect(LOSSLESS_DROPS.test('lossless deletes whitespace; lossy drops empties')).toBe(false);
  });

  it('no description associates the DEFAULT/lossless mode with dropping fields', () => {
    for (const [label, text] of DESCRIPTIONS) {
      expect(text, `${label} still advertises the deleted drop-empty default`).not.toMatch(STALE_DEFAULT);
      expect(text, `${label} attaches "drop" to the lossless mode`).not.toMatch(LOSSLESS_DROPS);
    }
  });

  it("the description's claim about `lossless` is TRUE of the kernel", () => {
    // Claim: the default deletes whitespace only; no field added or removed.
    const input = JSON.stringify({ results: [], query: 'q', note: '', n: null }, null, 2);
    const out = compactToolOutput(input, { mode: 'lossless' });
    expect(JSON.parse(out)).toEqual(JSON.parse(input)); // nothing added or removed
    expect(out).not.toContain('\n'); // whitespace WAS deleted
    for (const [label, text] of DESCRIPTIONS) {
      expect(text.toLowerCase(), `${label} must name what the default actually does`).toMatch(/whitespace/);
    }
  });

  it("the description's claim about `lossy` is TRUE of the kernel, markers and all", () => {
    // Claim: lossy drops empty fields (disclosed) and elides long arrays (disclosed).
    const emptied = compactToolOutput(
      JSON.stringify({ a: '', b: '', c: '', d: '', e: '', f: '', g: '', h: '', keep: 1 }),
      { mode: 'lossy' },
    );
    expect(JSON.parse(emptied)).toHaveProperty(EMPTIED_MARKER);

    const elided = compactToolOutput(
      JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i })) }),
      { mode: 'lossy', head: 2, tail: 1 },
    );
    expect(elided).toContain(ELIDED_MARKER);

    // The node description names BOTH markers, and names the kernel's actual
    // exported constants — a rename in compact.ts reddens this, not the UI.
    expect(node.description, 'the node description must disclose the _emptied marker').toContain(EMPTIED_MARKER);
    expect(node.description, 'the node description must disclose the _elided marker').toContain(ELIDED_MARKER);
  });

  it('the four version legs move together (pack, node, requiredPacks, and they are not 1.0.0)', () => {
    // H3's other half: a SEMANTIC change shipped under an unchanged version.
    expect(node.version, 'node version drifted from the pack version').toBe(manifest.version);
    expect(toolOutputCompactionFeature.requiredPacks).toEqual([
      { name: manifest.name, version: manifest.version },
    ]);
    expect(manifest.version, 'the drop-empty removal is a behaviour change; 1.0.0 no longer describes it')
      .not.toBe('1.0.0');
  });
});

describe('ADR 0604 H3 — the projected CATALOG entry is the corrected text', () => {
  let projected: { description?: string; version?: string } | undefined;

  beforeAll(async () => {
    // The same reachability pattern `notifications-node-surface.test.ts` uses:
    // `buildNodeCatalog` scans the MOUNT dir, not this repo's `packs/`, so the
    // mount is what makes the assertion about the real projection.
    const { ensureLocalPacksMounted } = await import('../src/bootstrap/mountLocalPacks.js');
    const { buildNodeCatalog } = await import('../src/host/nodeCatalogBuilder.js');
    ensureLocalPacksMounted();
    projected = buildNodeCatalog().find((n) => n.typeId === 'feature.tool-output-compaction.nodes.compact');
  });

  it('the node is in the catalog at all (anti-vacuity — an absent node asserts nothing)', () => {
    expect(projected, 'not in the catalog ⇒ the description below would be vacuously fine').toBeTruthy();
  });

  it('what the model is handed is byte-identical to the manifest field', () => {
    expect(projected?.description).toBe(node.description);
    expect(projected?.version).toBe(node.version);
  });
});
