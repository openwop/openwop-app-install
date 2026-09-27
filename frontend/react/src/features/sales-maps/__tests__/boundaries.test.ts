/**
 * Sales Maps — vendored world-boundary data + name matching (ADR 0282 §8).
 * Guards the GENERATED worldBoundaries.ts (Natural Earth 110m): geometry sanity,
 * no Antarctica, and the alias matching that colours a country from a territory
 * named "United States" / "USA" as well as the canonical Natural Earth name.
 */
import { describe, expect, it } from 'vitest';
import { WORLD_REGIONS, matchValuesToRegions, regionValues, regionCentroid, resolveRegionId } from '../boundaries.js';

describe('sales-maps world boundaries', () => {
  it('is a real world set: 150+ countries, unique ids, no Antarctica', () => {
    expect(WORLD_REGIONS.length).toBeGreaterThan(150);
    expect(new Set(WORLD_REGIONS.map((r) => r.id)).size).toBe(WORLD_REGIONS.length);
    expect(WORLD_REGIONS.find((r) => r.id === 'ata')).toBeUndefined();
    expect(WORLD_REGIONS.some((r) => r.name.toLowerCase().includes('antarctica'))).toBe(false);
  });

  it('every geometry is valid lng/lat with closed-able rings', () => {
    for (const r of WORLD_REGIONS) {
      const polys = r.geometry.type === 'Polygon' ? [r.geometry.coordinates] : r.geometry.coordinates;
      expect(polys.length).toBeGreaterThan(0);
      for (const poly of polys) {
        for (const ring of poly) {
          expect(ring.length).toBeGreaterThanOrEqual(3);
          for (const [lng, lat] of ring) {
            expect(lng).toBeGreaterThanOrEqual(-180);
            expect(lng).toBeLessThanOrEqual(180);
            expect(lat).toBeGreaterThanOrEqual(-90);
            expect(lat).toBeLessThanOrEqual(90);
          }
        }
      }
    }
  });

  it('matches territories by canonical name AND aliases (case-insensitive)', () => {
    const byAlias = matchValuesToRegions([{ name: 'united states', value: 42 }]);
    expect(byAlias.get('usa')).toBe(42);
    const byIso = matchValuesToRegions([{ name: 'USA', value: 7 }]);
    expect(byIso.get('usa')).toBe(7);
    const byName = matchValuesToRegions([{ name: 'Brazil', value: 9 }]);
    expect(byName.get('bra')).toBe(9);
    expect(matchValuesToRegions([{ name: 'Atlantis', value: 1 }]).size).toBe(0);
  });

  it('canonical name wins over an alias when both are present', () => {
    const m = matchValuesToRegions([
      { name: 'United States of America', value: 10 },
      { name: 'USA', value: 99 },
    ]);
    expect(m.get('usa')).toBe(10);
  });

  it('regionValues: an explicit regionId mapping wins over name matching (ADR 0282 §8)', () => {
    // A territory NOT named after a country only colours via its mapping.
    const mapped = regionValues([{ name: 'EMEA North', regionId: 'deu', value: 5 }]);
    expect(mapped.get('deu')).toBe(5);
    // Explicit mapping beats a different territory's name-match on the same region.
    const collide = regionValues([
      { name: 'Germany', value: 1 },
      { name: 'Enterprise Accounts', regionId: 'deu', value: 9 },
    ]);
    expect(collide.get('deu')).toBe(9);
    // Unknown region ids are ignored; unmapped values still name-match.
    const mixed = regionValues([
      { name: 'Brazil', value: 3 },
      { name: 'Narnia Division', regionId: 'not-a-region', value: 8 },
    ]);
    expect(mixed.get('bra')).toBe(3);
    expect(mixed.size).toBe(1);
  });

  it('R2 review B3 — resolveRegionId is the ONE answer to "where does this land?"', () => {
    // The page had grown a SECOND, weaker matcher to decide whether a territory was
    // placed: canonical name only, no aliases, no trim. So a territory named "USA" —
    // the exact example the app's own copy suggests — rendered shaded on the map, with
    // its value in the table, AND was counted in "1 territory has no matching country".
    // Everything that answers this question now runs the same code.
    expect(resolveRegionId({ name: 'USA' })).toBe('usa');
    expect(resolveRegionId({ name: '  united states  ' })).toBe('usa');
    expect(resolveRegionId({ name: 'Brazil' })).toBe('bra');
    expect(resolveRegionId({ name: 'EMEA North' })).toBeUndefined();
    // An explicit mapping is honoured, and an unknown id is NOT — the same fail-closed
    // rule `regionValues` applies, so "mapped" and "placed" cannot disagree.
    expect(resolveRegionId({ name: 'EMEA North', regionId: 'deu' })).toBe('deu');
    expect(resolveRegionId({ name: 'Germany', regionId: 'not-a-region' })).toBeUndefined();
  });

  it('centroids land inside plausible bounds', () => {
    const usa = WORLD_REGIONS.find((r) => r.id === 'usa');
    expect(usa).toBeDefined();
    const [lng, lat] = regionCentroid(usa!);
    // vertex-mean centroid; Alaska + islands pull it west/north, so bounds are loose
    expect(lng).toBeLessThan(-60);
    expect(lat).toBeGreaterThan(20);
  });
});
