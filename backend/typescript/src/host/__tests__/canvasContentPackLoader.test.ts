/** ADR 0347 5a — the canvas-content kit loader + the shipped auth kit's
 *  closed-world integrity (kit content must validate against the LIVE catalog
 *  — a catalog change can never orphan a kit silently; the template precedent).
 *  The loader's own refusals (an unsafe template-variable name, a kitId another
 *  pack already owns) are driven with temp-dir packs, each valid except for the
 *  one property under test. */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCanvasContentPacks, kitsForCanvasType, _resetCanvasContentRegistryForTest, type CanvasContentLoadOutcome } from '../canvasContentPackLoader.js';
import { validateComponentTree } from '../canvasComponentCatalog.js';
import { registerAppBuilderComponents, APP_BUILDER_CANVAS_TYPE } from '../../features/app-builder/componentCatalog.js';
import { locateRepoDir } from '../_repoPath.js';

const packsRoot = (): string => locateRepoDir(new URL('.', import.meta.url).pathname, 'packs', 'vendor.openwop.app-builder.kits/pack.json');

let boot: CanvasContentLoadOutcome;
beforeAll(() => {
  registerAppBuilderComponents();
  _resetCanvasContentRegistryForTest();
  // Asserted in a CASE, not here: a failing hook skips the cases instead of failing them.
  boot = loadCanvasContentPacks({ roots: [packsRoot()] });
});

/** A root holding ONE canvas-content pack with ONE kit; `kit` overrides a valid base. */
function packRoot(packName: string, kit: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'owp-kits-'));
  mkdirSync(join(root, packName));
  writeFileSync(join(root, packName, 'pack.json'), JSON.stringify({
    name: packName, version: '1.0.0', kind: 'canvas-content',
    kits: [{ kitId: `${packName}.kit`, version: '1.0.0', label: 'Kit', canvasTypeId: APP_BUILDER_CANVAS_TYPE, screens: [{ id: 's1', name: 'S1' }], variables: [{ name: 'appName', type: 'string' }], ...kit }],
  }));
  return root;
}

describe('canvas-content kits', () => {
  it('registers the auth kit for canvas.app-builder', () => {
    expect(boot.errors).toEqual([]);
    expect(boot.installed).toEqual([{ packName: 'vendor.openwop.app-builder.kits', packVersion: '1.1.0', kitIds: ['app-builder.auth-flow'] }]);
    const kits = kitsForCanvasType(APP_BUILDER_CANVAS_TYPE);
    expect(kits.map((k) => k.kitId)).toContain('app-builder.auth-flow');
    const kit = kits.find((k) => k.kitId === 'app-builder.auth-flow')!;
    expect(kit.screens).toHaveLength(3);
    expect(kit.variables?.map((v) => v.name)).toEqual(['appName', 'accentColor']);
  });
  it('every kit screen validates CLOSED-WORLD against the live catalog (after variable substitution)', () => {
    const kit = kitsForCanvasType(APP_BUILDER_CANVAS_TYPE).find((k) => k.kitId === 'app-builder.auth-flow')!;
    // Substitute defaults the way the editor does at instantiation. The catalog's
    // `color` prop is a free string, so this checks component types, props and
    // children — not colour syntax.
    const values: Record<string, string> = Object.fromEntries((kit.variables ?? []).map((v) => [v.name, v.default ?? '']));
    const substituted = JSON.parse(JSON.stringify(kit.screens).replace(/\{\{(\w+)\}\}/g, (_, n: string) => values[n] ?? '')) as { components?: unknown }[];
    for (const screen of substituted) {
      expect(validateComponentTree(APP_BUILDER_CANVAS_TYPE, screen.components)).toEqual([]);
    }
    // Declared catalog dependencies actually exist in the catalog.
    for (const dep of kit.catalogDependencies ?? []) {
      expect(validateComponentTree(APP_BUILDER_CANVAS_TYPE, [{ type: dep }]).filter((e) => e.code === 'unknown_component_type')).toEqual([]);
    }
  });
  it('rejects an unsafe variable name, refuses a cross-pack kitId squat, and reloads its own pack cleanly', () => {
    // (a) valid except the variable name.
    const badVar = loadCanvasContentPacks({ roots: [packRoot('test.kits.badvar', { variables: [{ name: 'bad-name', type: 'string' }] })] });
    expect(badVar.errors).toEqual([{ pack: 'test.kits.badvar', code: 'canvas_content_pack_invalid', message: 'test.kits.badvar.kit: variable names must match /^[A-Za-z][A-Za-z0-9_]{0,59}$/' }]);
    expect(badVar.installed).toEqual([]);
    expect(kitsForCanvasType(APP_BUILDER_CANVAS_TYPE).map((k) => k.kitId)).not.toContain('test.kits.badvar.kit');
    // (b) valid except that another pack already owns the kitId.
    const squat = loadCanvasContentPacks({ roots: [packRoot('test.kits.squat', { kitId: 'app-builder.auth-flow' })] });
    expect(squat.errors).toEqual([{ pack: 'test.kits.squat', code: 'canvas_content_kit_conflict', message: "kit 'app-builder.auth-flow' already registered by vendor.openwop.app-builder.kits" }]);
    expect(kitsForCanvasType(APP_BUILDER_CANVAS_TYPE).find((k) => k.kitId === 'app-builder.auth-flow')!.screens).toHaveLength(3);
    // (c) positive control: the owning pack reloads with no conflict.
    const out = loadCanvasContentPacks({ roots: [packsRoot()] });
    expect(out.errors).toEqual([]);
  });
  it('kits for an unknown canvas type are empty', () => {
    expect(kitsForCanvasType('canvas.ghost')).toEqual([]);
  });
});
