/**
 * Sales Maps — equirectangular projection (ADR 0282).
 *
 * A self-contained lng/lat → SVG-coordinate projection: no d3-geo dependency (kept
 * out to stay bundle-light + dependency-free; d3-geo is the recorded upgrade path
 * for advanced projections). Equirectangular (plate carrée) is the natural fit for
 * a whole-world REGION choropleth — territories are region-level, not street-level.
 *
 * The viewBox is a 2:1 world (MAP_W × MAP_H); every geometry + pin projects through
 * the same transform so pins land on their region. Pure functions — unit-tested.
 *
 * @see docs/adr/0282-dynamic-sales-maps.md §2
 */

export const MAP_W = 1000;
export const MAP_H = 500;

/** lng∈[-180,180], lat∈[-90,90] → [x,y] in the MAP_W×MAP_H viewBox. */
export function project(lng: number, lat: number): [number, number] {
  const x = ((lng + 180) / 360) * MAP_W;
  const y = ((90 - lat) / 180) * MAP_H;
  return [x, y];
}

/** Round to 1 decimal WITHOUT `toFixed` — this is SVG-path geometry, so it must NOT
 *  go through the locale formatter (a thousands separator would corrupt the path). */
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** A GeoJSON ring ([[lng,lat],…]) → an SVG path substring (M…L…Z). */
export function ringToPath(ring: ReadonlyArray<readonly [number, number]>): string {
  if (ring.length === 0) return '';
  const parts = ring.map(([lng, lat], i) => {
    const [x, y] = project(lng, lat);
    return `${i === 0 ? 'M' : 'L'}${r1(x)},${r1(y)}`;
  });
  return `${parts.join(' ')} Z`;
}

export type GeoGeometry =
  | { type: 'Polygon'; coordinates: ReadonlyArray<ReadonlyArray<readonly [number, number]>> }
  | { type: 'MultiPolygon'; coordinates: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly [number, number]>>> };

/** A GeoJSON Polygon/MultiPolygon → a single SVG path `d` (all rings concatenated). */
export function geometryToPath(geom: GeoGeometry): string {
  if (geom.type === 'Polygon') return geom.coordinates.map(ringToPath).join(' ');
  return geom.coordinates.flatMap((poly) => poly.map(ringToPath)).join(' ');
}
