/**
 * ADR 0820 §8.6 (core-audit M3) — a toggled CORE feature's toggle id IS its
 * package id, or it is a listed alias.
 *
 * Distributions, the catalog and `gen-distribution` speak PACKAGE ids; the toggle
 * registry, the paywall and the FE gate speak TOGGLE ids. When the two spellings
 * differ silently, a gate keyed on one never sees the other — that is exactly how
 * the priced Agents bundle sold `twin` while the twin's toggle was `twin-recall`
 * (ADR 0820 §1). Core features are never sold, but a core feature is the next
 * candidate to leave core (§8), and the move is where a silent alias bites. So an
 * alias must be written down here, where the next move will read it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_FEATURES } from '../src/features/index.js';

const CATALOG = join(import.meta.dirname, '../../../distributions/bundles.json');

/** package id → its toggle id, where they deliberately differ. */
const TOGGLE_ID_ALIASES: Record<string, string> = {
  // The settings package's toggle gates the tabbed settings SHELL, not the
  // personal prefs it hosts (`settings/feature.ts`).
  settings: 'settings-shell',
};

describe('ADR 0820 §8.6 — a toggled core feature’s toggle id = its package id, or a listed alias', () => {
  const core = new Set((JSON.parse(readFileSync(CATALOG, 'utf8')) as { core: string[] }).core);
  const toggledCore = BACKEND_FEATURES.filter((f) => core.has(f.id) && f.toggleDefault);

  it('non-vacuity: several core features carry a toggle', () => {
    expect(toggledCore.length).toBeGreaterThan(5);
  });

  it('every toggled core feature’s toggle id equals its package id or its alias', () => {
    const offenders = toggledCore
      .filter((f) => f.toggleDefault!.id !== (TOGGLE_ID_ALIASES[f.id] ?? f.id))
      .map((f) => `${f.id} → toggle '${f.toggleDefault!.id}'`);
    expect(offenders, 'add the alias to TOGGLE_ID_ALIASES (with the reason), or rename the toggle').toEqual([]);
  });

  it('no stale alias: every listed alias names a core package whose toggle really differs', () => {
    for (const [pkg, toggle] of Object.entries(TOGGLE_ID_ALIASES)) {
      const f = BACKEND_FEATURES.find((x) => x.id === pkg);
      expect(f, `${pkg} is not a registered feature`).toBeTruthy();
      expect(core.has(pkg), `${pkg} is not core`).toBe(true);
      expect(f!.toggleDefault?.id).toBe(toggle);
      expect(toggle).not.toBe(pkg);
    }
  });
});
