/**
 * ADR 0488 DATA-T1 — the tutorials seeder must be REGISTERED.
 *
 * `seedTutorials()` shipped in P1 and was never invoked, so for seven increments
 * the kernel lane — the architectural centrepiece — carried no data in any
 * workspace. It degraded correctly (every read served the seed floor), which is
 * exactly why nothing surfaced it. This pins the wiring so it cannot regress to
 * "built but unreachable" again.
 */
import { describe, it, expect } from 'vitest';
import { EXAMPLE_DATA_SEEDERS } from '../src/host/exampleDataSeeders.js';

describe('ADR 0488 — the tutorials example-data seeder', () => {
  const seeder = EXAMPLE_DATA_SEEDERS.find((s) => s.id === 'tutorials');

  it('is registered (the DATA-T1 regression: defined but never invoked)', () => {
    expect(seeder, 'no seeder with id "tutorials" is registered').toBeDefined();
    expect(typeof seeder!.seed).toBe('function');
    expect(typeof seeder!.count).toBe('function');
    expect(typeof seeder!.clear).toBe('function');
  });

  it('its copy tells the operator that CLEAR reverts rather than removes', () => {
    // This seeder is unlike its siblings: the artifact exists with or without it,
    // so a careless "clear" would otherwise read as "delete my tutorials".
    const d = seeder!.description.toLowerCase();
    expect(d).toMatch(/revert/);
    expect(d).toMatch(/does not remove|not remove the tutorials/);
  });

  /**
   * §Correction (grade trio 2026-07-26). This used to assert the copy named
   * "the Entities feature" as a dependency — pinning a claim that was FALSE.
   * `entitiesService` gates at the route layer, not the service, so seeding
   * succeeds with the `entities` toggle off; the seeder's matching catch-message
   * ("the Entities feature is not enabled") was a fabricated diagnosis that hid a
   * real schema defect for the program's whole lifetime. A test that pins a false
   * claim actively defends it, so the assertion now pins what the copy must
   * genuinely do: be honest about what seeding gives you, and NOT promise the
   * editing/translation lane that has not shipped.
   */
  it('its copy does not promise the unshipped edit/translate lane', () => {
    const d = seeder!.description.toLowerCase();
    expect(d).toMatch(/not available yet|coming|not shipped/);
    expect(d).not.toMatch(/rewrite them for your team/);
    expect(d).not.toMatch(/translate them into your locales/);
  });

  it('its copy says what seeding actually gives the workspace', () => {
    expect(seeder!.description.toLowerCase()).toMatch(/ownership|your own content rows/);
  });

  it('ids are unique across every seeder (a duplicate would shadow one silently)', () => {
    const ids = EXAMPLE_DATA_SEEDERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
