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
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

/** The four graduated features + the one retired inert switch. */
const GRADUATED = ['run-input-forms', 'sharing', 'developer-keys', 'models', 'context-economy'] as const;

const REPO_ROOT = join(import.meta.dirname, '../../..');

describe('ADR 0434 — graduated substrate toggles', () => {
  it.each(GRADUATED)('%s declares no toggleDefault', (id) => {
    const feature = BACKEND_FEATURES.find((f) => f.id === id);
    expect(feature, `${id} must stay REGISTERED — gen-distribution requires every core id to resolve`).toBeTruthy();
    expect(feature!.toggleDefault, `${id} graduated in ADR 0434; re-adding a toggle needs a new ADR`).toBeUndefined();
  });

  it.each(GRADUATED)('%s resolves no toggle at runtime', (id) => {
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
});
