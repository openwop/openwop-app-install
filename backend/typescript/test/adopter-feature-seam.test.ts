/**
 * ADR 1031 P1 — the adopter feature seam, backend half.
 *
 * Why this exists: an adopter repo (KickTodo, Book AI) registers its own feature
 * packages from `src/adopter/features/<id>/`, a path openwop-app never writes.
 * Node has no glob import, so `scripts/gen-adopter-features.mjs` turns that
 * directory into a static module the registry appends. If the generator
 * silently skipped a feature, the adopter's routes, toggles and packs would
 * vanish from its build with nothing red; if the composer let a duplicate id
 * through, two features would fight over one toggle and one route prefix.
 *
 * Every fixture here is a TEMP directory: openwop-app must never commit a file
 * under `src/adopter/` (the white-label bundle build refuses one). The checks
 * that read the real registry assert properties that hold in openwop-app AND in
 * an adopter checkout (this file ships in the bundle), never "the list is empty".
 *
 * Sabotage-witnessed (2026-11-02): dropping the export-name check in
 * `scanAdopterBackendFeatures`, or the duplicate check in
 * `composeBackendFeatures`, reds the matching case below.
 *
 * Two cases read the REAL registry and are vacuous in openwop-app, where both
 * adopter lists are empty: "ends with exactly the generated adopter features"
 * (the order rule is carried here by "appends adopter features after the
 * first-party ones") and "no adopter pin re-pins an upstream pack" (the rule is
 * carried here by the fixture case after it). Both bite in an adopter checkout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adopterDependsOn,
  generateAdopterFeatures,
  scanAdopterBackendFeatures,
} from '../scripts/gen-adopter-features.mjs';
import { adopterClosureViolations } from '../../../scripts/gen-distribution.mjs';
import { composeBackendFeatures } from '../src/features/composeFeatures.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { ADOPTER_BACKEND_FEATURES } from '../src/features/adopterFeatures.generated.js';
import { adopterPackPinConflicts } from '../src/features/packPins.js';
import type { BackendFeature } from '../src/features/types.js';
import {
  clearFeatureDemoContributions,
  composeExampleDataSeeders,
  featureDemoToggleIds,
  registerFeatureDemo,
} from '../src/host/featureDemoContributions.js';
import type { ExampleDataSeeder } from '../src/host/exampleDataSeeders.js';

const temps: string[] = [];
function pkg(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'adopter-seam-'));
  temps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  clearFeatureDemoContributions();
});

const feature = (id: string): BackendFeature => ({ id, registerRoutes: () => {} });

describe('gen-adopter-features: directory → static module', () => {
  it('an absent src/adopter/ yields empty modules (openwop-app itself)', () => {
    const r = generateAdopterFeatures({ pkgRoot: pkg({}), write: false });
    expect(r.features).toEqual([]);
    expect(r.withPins).toBe(false);
    expect(r.featuresSource).toContain('export const ADOPTER_BACKEND_FEATURES: readonly BackendFeature[] = [];');
    expect(r.pinsSource).toContain('export const ADOPTER_PACK_PINS: Readonly<Record<string, string>> = {};');
  });

  it('imports each feature by the <camelId>Feature convention, sorted by id, with its dir alongside', () => {
    const root = pkg({
      'src/adopter/features/zeta-thing/feature.ts': 'export const zetaThingFeature = {};',
      'src/adopter/features/alpha/feature.ts': "export const alphaFeature = { dependsOn: ['crm', 'goals'] };",
      'src/adopter/packPins.ts': "export const ADOPTER_PACK_PINS = { 'feature.alpha.nodes': '1.0.0' } as const;",
    });
    const r = generateAdopterFeatures({ pkgRoot: root, write: false });
    expect(r.features).toEqual(['alpha', 'zeta-thing']);
    expect(r.featuresSource).toContain("import { alphaFeature } from '../adopter/features/alpha/feature.js';");
    expect(r.featuresSource).toContain("export const ADOPTER_FEATURE_DIRS: readonly string[] = ['alpha', 'zeta-thing'];");
    expect(r.featuresSource).toContain('= [alphaFeature, zetaThingFeature];');
    expect(r.pinsSource).toContain("from '../adopter/packPins.js'");
    expect(adopterDependsOn(root)).toEqual({ alpha: ['crm', 'goals'], 'zeta-thing': [] });
  });

  it('writes only when the content changed', () => {
    const root = pkg({ 'src/features/.keep': '', 'src/adopter/features/alpha/feature.ts': 'export const alphaFeature = {};' });
    expect(generateAdopterFeatures({ pkgRoot: root }).changed).toBe(true);
    expect(readFileSync(join(root, 'src/features/adopterFeatures.generated.ts'), 'utf8')).toContain('alphaFeature');
    expect(generateAdopterFeatures({ pkgRoot: root }).changed).toBe(false);
  });

  it.each([
    ['a non-kebab directory', { 'src/adopter/features/Bad_Name/feature.ts': '' }, /not a kebab-case feature id/],
    ['a directory without feature.ts', { 'src/adopter/features/alpha/routes.ts': '' }, /has no feature\.ts/],
    ['a feature.ts without the convention export', { 'src/adopter/features/alpha/feature.ts': 'export const somethingElse = {};' }, /must export `alphaFeature`/],
    ['a packPins.ts without ADOPTER_PACK_PINS', { 'src/adopter/packPins.ts': 'export const PINS = {};' }, /must export `ADOPTER_PACK_PINS`/],
  ])('fails loud on %s', (_name, files, message) => {
    expect(() => generateAdopterFeatures({ pkgRoot: pkg(files), write: false })).toThrow(message);
  });

  it('the scan ignores dot-dirs and __tests__', () => {
    const root = pkg({ 'src/adopter/features/.cache/x': '', 'src/adopter/features/__tests__/x.test.ts': '' });
    expect(scanAdopterBackendFeatures(root)).toEqual([]);
  });
});

describe('composeBackendFeatures: duplicate ids fail fast', () => {
  it('returns the first-party elements unchanged when there are no adopter features', () => {
    const fp = [feature('crm'), feature('goals')];
    const out = composeBackendFeatures(fp, [], []);
    expect(out).toEqual(fp);
    expect(out[0]).toBe(fp[0]);
  });

  it('appends adopter features after the first-party ones', () => {
    expect(composeBackendFeatures([feature('crm')], [feature('kick')], ['kick']).map((f) => f.id)).toEqual(['crm', 'kick']);
  });

  it('refuses an adopter feature that reuses a first-party id, naming both sides', () => {
    expect(() => composeBackendFeatures([feature('crm')], [feature('crm')], ['crm']))
      .toThrow(/duplicate feature id 'crm': first-party feature and adopter feature \(src\/adopter\/features\/crm\)/);
  });

  it('refuses an adopter feature whose id is not its directory', () => {
    expect(() => composeBackendFeatures([], [feature('other')], ['kick'])).toThrow(/src\/adopter\/features\/kick\/ declares id 'other'/);
  });

  it('refuses a generated module out of step with its directory list', () => {
    expect(() => composeBackendFeatures([], [feature('kick')], [])).toThrow(/out of step/);
  });
});

describe('the composed registry in this checkout', () => {
  it('has unique feature ids', () => {
    const ids = BACKEND_FEATURES.map((f) => f.id);
    expect(ids.length).toBeGreaterThan(100);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ends with exactly the generated adopter features', () => {
    expect(BACKEND_FEATURES.slice(BACKEND_FEATURES.length - ADOPTER_BACKEND_FEATURES.length)).toEqual([...ADOPTER_BACKEND_FEATURES]);
  });

  it('no adopter pin re-pins an upstream pack', () => {
    expect(adopterPackPinConflicts()).toEqual([]);
  });

  it('adopterPackPinConflicts names an adopter pin of an upstream pack, and only that one (fixture)', async () => {
    vi.resetModules();
    vi.doMock('../src/features/adopterPackPins.generated.js', () => ({
      ADOPTER_PACK_PINS: { 'vendor.acme.nodes': '1.0.0', 'feature.cms.nodes': '9.9.9' },
    }));
    try {
      const { adopterPackPinConflicts: conflicts } = await import('../src/features/packPins.js');
      expect(conflicts()).toEqual(['feature.cms.nodes']);
    } finally {
      vi.doUnmock('../src/features/adopterPackPins.generated.js');
      vi.resetModules();
    }
  });
});

describe('gen-distribution: adopter features join the dependsOn closure', () => {
  it('flags an adopter dep a manifest excludes, and nothing else', () => {
    const edges = { kick: ['crm', 'goals'], quiet: [] };
    expect(adopterClosureViolations(new Set(['crm']), edges)).toEqual([
      "adopter feature 'kick' (always included) hard-depends on 'crm' (excluded)",
    ]);
    expect(adopterClosureViolations(new Set(['territories']), edges)).toEqual([]);
  });
});

describe('BackendFeature.demo — feature contributions to the demo program', () => {
  const seeder = (id: string): ExampleDataSeeder => ({
    id, label: id, description: id,
    count: async () => 0, seed: async () => ({ created: 0 }), clear: async () => ({ cleared: 0 }),
  });

  it('appends contributed seeders after the host ones, and toggles deduplicated', () => {
    registerFeatureDemo('kick', { seeders: [seeder('demo-kick')], enableToggles: ['kick', 'kick'] });
    expect(composeExampleDataSeeders([seeder('demo-people')]).map((s) => s.id)).toEqual(['demo-people', 'demo-kick']);
    expect(featureDemoToggleIds()).toEqual(['kick']);
  });

  it('refuses a contributed seeder id that collides with a host seeder', () => {
    registerFeatureDemo('kick', { seeders: [seeder('demo-people')] });
    expect(() => composeExampleDataSeeders([seeder('demo-people')])).toThrow(/duplicate example-data seeder id 'demo-people'/);
  });
});
