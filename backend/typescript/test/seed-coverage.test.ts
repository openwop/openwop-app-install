/**
 * DG-SEED-5 — feature ↔ demo-seed coverage gate.
 *
 * Every toggled feature must be either seeded by the demo program
 * (`DEMO_FEATURE_TOGGLE_IDS`) or explicitly acknowledged as demo-data-free
 * (`ACKNOWLEDGED_UNSEEDED`). A new toggled feature with no seeder trips this test
 * until someone makes the call — the whole point of the projection.
 *
 * PROTECTED (coverage gate). Sabotage witnesses (grade-tests 8f w2):
 * cv-ack-drop, cv-both. Not claimed: a ghost check (an ACKNOWLEDGED_UNSEEDED key
 * whose feature is gone stays forever) — grade-code lead SEEDCOV-GHOST-1.
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
    // Floor = the MEASURED toggled-feature count, 91 on 2404797bf (2026-10-22:
    // 30 seeded + 61 acknowledged). A floor far below the truth would let the
    // projection silently lose most of its rows.
    expect(rows.length).toBeGreaterThanOrEqual(91);
    for (const r of rows) {
      // seeded and acknowledged are mutually exclusive intents; never both.
      expect(r.seeded && r.acknowledged).toBe(false);
    }
    const ids = rows.map((r) => r.toggleId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate toggle ids
  });
});
