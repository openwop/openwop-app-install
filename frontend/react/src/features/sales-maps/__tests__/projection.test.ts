/**
 * Sales Maps — projection unit tests (ADR 0282). The equirectangular projection +
 * GeoJSON→SVG-path conversion are pure and must be exact (pins must land on regions).
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
    const d = ringToPath([[0, 0], [10, 0], [10, 10]]);
    expect(d.startsWith('M500,250')).toBe(true);
    expect(d.includes(' L')).toBe(true);
    expect(d.endsWith(' Z')).toBe(true);
    expect(ringToPath([])).toBe('');
  });

  it('handles Polygon and MultiPolygon geometries', () => {
    const polygon: GeoGeometry = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10]]] };
    expect(geometryToPath(polygon).endsWith('Z')).toBe(true);
    const multi: GeoGeometry = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1]]], [[[5, 5], [6, 5], [6, 6]]]] };
    // two rings → two Z's
    expect((geometryToPath(multi).match(/Z/g) ?? []).length).toBe(2);
  });
});
