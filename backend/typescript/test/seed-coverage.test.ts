/**
 * DG-SEED-5 — feature ↔ demo-seed coverage gate.
 *
 * Every toggled feature must be either seeded by the demo program
 * (`DEMO_FEATURE_TOGGLE_IDS`) or explicitly acknowledged as demo-data-free
 * (`ACKNOWLEDGED_UNSEEDED`). A new toggled feature with no seeder trips this test
 * until someone makes the call — the whole point of the projection.
 */
import { describe, expect, it } from 'vitest';
import { buildSeedCoverage, uncoveredFeatureToggles } from '../src/host/seedCoverage.js';

describe('DG-SEED-5 — demo-seed coverage', () => {
  it('every toggled feature is seeded or acknowledged demo-data-free', () => {
    const uncovered = uncoveredFeatureToggles();
    // If this fails, the printed ids are new toggled features with no demo data:
    // add a `demo-*` seeder (+ the toggle to DEMO_FEATURE_TOGGLE_IDS) or record
    // WHY none is needed in ACKNOWLEDGED_UNSEEDED (host/seedCoverage.ts).
    expect(uncovered).toEqual([]);
  });

  it('the projection classifies every toggled feature exactly once', () => {
    const rows = buildSeedCoverage();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // seeded and acknowledged are mutually exclusive intents; never both.
      expect(r.seeded && r.acknowledged).toBe(false);
    }
    const ids = rows.map((r) => r.toggleId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate toggle ids
  });
});
