/**
 * ADR 0434 — the graduation invariants, pinned so a revert is a LOUD failure.
 *
 * Mirrors `adr-0191-default-features-on.test.ts`, which pins the opposite
 * direction (a default-ON feature must not silently drop back to OFF).
 *
 * The motivating finding: `distributions/bundles.json` already classified these
 * five as `core` (non-excludable substrate) while their toggles still advertised
 * them as optional. The two catalogs must not drift apart again — and the
 * `gen-distribution` "always-on ⊆ core" gate only fires for features with NO
 * `toggleDefault`, so re-adding one here would quietly re-open the gap without
 * failing that gate.
 *
 * TST-BQR-1. Red when a graduated feature re-declares `toggleDefault` (or the
 * literal text, even commented out), declares the id through
 * `extraToggleDefaults`, drops out of `bundles.json` core / lands in a sellable
 * bundle, or leaves `RETIRED_TOGGLE_IDS`. The "runtime" cases read the
 * DECLARED toggle ids every feature contributes — exactly what
 * `registerBackendFeatures` registers — because `getToggleDefault` returns
 * null for every id in a file that never boots (it could not fail).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

/** The graduated features still registered as packages (core substrate). */
const GRADUATED = ['sharing', 'developer-keys'] as const;
/** ADR 0820 §8.3 — graduated in ADR 0434, then retired as REGISTRY entries too:
 *  each was a `registerRoutes: () => {}` shell kept only so `core` could name it. */
const RETIRED_ENTRIES = ['run-input-forms', 'models', 'context-economy'] as const;

const REPO_ROOT = join(import.meta.dirname, '../../..');

/** Every toggle id a backend feature registers at boot (`registerBackendFeatures`). */
const declaredToggleIds = (): string[] =>
  BACKEND_FEATURES.flatMap((f) => [
    ...(f.toggleDefault ? [f.toggleDefault.id] : []),
    ...(f.extraToggleDefaults ?? []).map((t) => t.id),
  ]);

describe('ADR 0434 — graduated substrate toggles', () => {
  it.each(GRADUATED)('%s declares no toggleDefault', (id) => {
    const feature = BACKEND_FEATURES.find((f) => f.id === id);
    expect(feature, `${id} must stay REGISTERED — gen-distribution requires every core id to resolve`).toBeTruthy();
    expect(feature!.toggleDefault, `${id} graduated in ADR 0434; re-adding a toggle needs a new ADR`).toBeUndefined();
  });

  it.each(GRADUATED)('%s resolves no toggle at runtime', (id) => {
    const ids = declaredToggleIds();
    expect(ids, 'positive control: a real toggle is declared').toContain('crm');
    expect(ids).not.toContain(id);
    expect(getToggleDefault(id)).toBeFalsy();
  });

  it.each(GRADUATED)('%s is in the distribution core tier (non-excludable substrate)', (id) => {
    const catalog = JSON.parse(readFileSync(join(REPO_ROOT, 'distributions/bundles.json'), 'utf8')) as {
      core: string[];
      bundles: Record<string, { features: string[] }>;
    };
    expect(catalog.core).toContain(id);
    // An always-on feature must never sit in a sellable bundle: `core ∩ bundle`
    // is a gen-distribution error, and ADR 0419's paywall UI (`useFeatureLocked`)
    // silently no-ops for a feature with no toggle entry.
    for (const [name, def] of Object.entries(catalog.bundles)) {
      expect(def.features, `${id} must not be sellable in bundle '${name}'`).not.toContain(id);
    }
  });

  it.each(GRADUATED)('%s has its stale per-tenant overrides retired at boot', (id) => {
    const src = readFileSync(join(import.meta.dirname, '../src/features/index.ts'), 'utf8');
    const list = /const RETIRED_TOGGLE_IDS = \[([\s\S]*?)\] as const;/.exec(src)?.[1] ?? '';
    expect(list, `${id} must be in RETIRED_TOGGLE_IDS or a stored override resurrects it as a ghost toggle`).toContain(`'${id}'`);
  });

  it.each(GRADUATED)('%s leaves no commented-out toggleDefault (the gen-distribution text-scan trap)', (id) => {
    const src = readFileSync(join(import.meta.dirname, `../src/features/${id}/feature.ts`), 'utf8');
    // `alwaysOnFeatureIds()` scans RAW TEXT for the `toggleDefault:` property, so a
    // commented-out block would make the feature invisible to the "always-on must
    // be core" check — passing CI while shipping excludable substrate.
    expect(/\btoggleDefault\s*:/.test(src), `${id}/feature.ts must not contain the literal 'toggleDefault:'`).toBe(false);
  });

  it.each(RETIRED_ENTRIES)('%s is no longer a registered backend feature, nor named by the catalog (ADR 0820 §8.3)', (id) => {
    expect(BACKEND_FEATURES.find((f) => f.id === id)).toBeUndefined();
    const catalog = JSON.parse(readFileSync(join(REPO_ROOT, 'distributions/bundles.json'), 'utf8')) as {
      core: string[];
      bundles: Record<string, { features: string[] }>;
    };
    expect(catalog.core).not.toContain(id);
    for (const def of Object.values(catalog.bundles)) expect(def.features).not.toContain(id);
  });

  it.each(RETIRED_ENTRIES)('%s still resolves no toggle, and its stale overrides are still retired at boot', (id) => {
    const ids = declaredToggleIds();
    expect(ids, 'positive control: a real toggle is declared').toContain('crm');
    expect(ids).not.toContain(id);
    expect(getToggleDefault(id)).toBeFalsy();
    const src = readFileSync(join(import.meta.dirname, '../src/features/index.ts'), 'utf8');
    const list = /const RETIRED_TOGGLE_IDS = \[([\s\S]*?)\] as const;/.exec(src)?.[1] ?? '';
    expect(list).toContain(`'${id}'`);
  });
});
