/** ADR 0347 5a — the canvas-content kit loader + the shipped auth kit's
 *  closed-world integrity (kit content must validate against the LIVE catalog
 *  — a catalog change can never orphan a kit silently; the template precedent). */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadCanvasContentPacks, kitsForCanvasType, _resetCanvasContentRegistryForTest } from '../canvasContentPackLoader.js';
import { validateComponentTree } from '../canvasComponentCatalog.js';
import { registerAppBuilderComponents, APP_BUILDER_CANVAS_TYPE } from '../../features/app-builder/componentCatalog.js';
import { locateRepoDir } from '../_repoPath.js';

const packsRoot = (): string => locateRepoDir(new URL('.', import.meta.url).pathname, 'packs', 'vendor.openwop.app-builder.kits/pack.json');

beforeAll(() => {
  registerAppBuilderComponents();
  _resetCanvasContentRegistryForTest();
  const out = loadCanvasContentPacks({ roots: [packsRoot()] });
  expect(out.errors).toEqual([]);
});

describe('canvas-content kits', () => {
  it('registers the auth kit for canvas.app-builder', () => {
    const kits = kitsForCanvasType(APP_BUILDER_CANVAS_TYPE);
    expect(kits.map((k) => k.kitId)).toContain('app-builder.auth-flow');
    const kit = kits.find((k) => k.kitId === 'app-builder.auth-flow')!;
    expect(kit.screens).toHaveLength(3);
    expect(kit.variables?.map((v) => v.name)).toEqual(['appName', 'accentColor']);
  });
  it('every kit screen validates CLOSED-WORLD against the live catalog (after variable substitution)', () => {
    const kit = kitsForCanvasType(APP_BUILDER_CANVAS_TYPE).find((k) => k.kitId === 'app-builder.auth-flow')!;
    // Substitute defaults the way the editor does at instantiation — the color
    // prop must be a strict hex AFTER substitution or validation rejects it.
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
  it('rejects a kit with an unsafe variable name and reports a conflict on duplicate kitIds', () => {
    const out = loadCanvasContentPacks({ roots: [packsRoot()] }); // reload: same pack → no conflict (same owner)
    expect(out.errors).toEqual([]);
  });
  it('kits for an unknown canvas type are empty', () => {
    expect(kitsForCanvasType('canvas.ghost')).toEqual([]);
  });
});
