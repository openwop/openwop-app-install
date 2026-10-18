/**
 * Sales Maps — projection unit tests (ADR 0282 §2). The equirectangular projection +
 * GeoJSON→SVG-path conversion are pure and must be exact (pins must land on regions).
 *
 * Every expected path below is HAND-COMPUTED, never derived from the functions under test:
 *   x = (lng + 180) / 360 · 1000,  y = (90 − lat) / 180 · 500,  each rounded to 1 dp
 *   lng 0→500, 1→502.8, 2→505.6, 5→513.9, 6→516.7, 10→527.8
 *   lat 0→250, 1→247.2, 2→244.4, 5→236.1, 6→233.3, 10→222.2
 *
 * Sabotage-witnessed (wave 52): flipping the y axis, dropping the 1-dp rounding `r1` (the
 * reason it exists: SVG geometry must not go through a locale formatter, and unrounded
 * floats bloat 176 paths), dropping the closing ` Z`, dropping a Polygon's or a
 * MultiPolygon member's hole rings, and dropping MultiPolygon members each turn a case red.
 */
import { describe, expect, it } from 'vitest';
import { project, ringToPath, geometryToPath, MAP_W, MAP_H, type GeoGeometry } from '../projection.js';

describe('sales-maps projection', () => {
  it('projects lng/lat corners + centre into the viewBox', () => {
    expect(project(0, 0)).toEqual([MAP_W / 2, MAP_H / 2]); // null island → centre
    expect(project(-180, 90)).toEqual([0, 0]); // top-left
    expect(project(180, -90)).toEqual([MAP_W, MAP_H]); // bottom-right
    const [x] = project(90, 0);
    expect(x).toBeCloseTo((3 / 4) * MAP_W);
  });

  it('builds a closed SVG path from a ring', () => {
    expect(ringToPath([[0, 0], [10, 0], [10, 10]])).toBe('M500,250 L527.8,250 L527.8,222.2 Z');
    expect(ringToPath([])).toBe('');
  });

  it('handles Polygon and MultiPolygon geometries', () => {
    // A Polygon's later rings are holes — they must reach the path too.
    const polygon: GeoGeometry = {
      type: 'Polygon',
      coordinates: [[[0, 0], [10, 0], [10, 10]], [[1, 1], [2, 1], [2, 2]]],
    };
    expect(geometryToPath(polygon)).toBe(
      'M500,250 L527.8,250 L527.8,222.2 Z M502.8,247.2 L505.6,247.2 L505.6,244.4 Z',
    );
    // Two members, the first with a hole: every member and every ring is drawn.
    const multi: GeoGeometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [10, 0], [10, 10]], [[1, 1], [2, 1], [2, 2]]],
        [[[5, 5], [6, 5], [6, 6]]],
      ],
    };
    expect(geometryToPath(multi)).toBe(
      'M500,250 L527.8,250 L527.8,222.2 Z M502.8,247.2 L505.6,247.2 L505.6,244.4 Z'
        + ' M513.9,236.1 L516.7,236.1 L516.7,233.3 Z',
    );
  });
});
