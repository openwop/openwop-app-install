/**
 * Sales Maps — the vendored boundary set + territory-name matching (ADR 0282 §2/§8).
 *
 * The boundary DATA is real geography: Natural Earth 1:110m admin-0 countries
 * (public domain), vendored into `worldBoundaries.ts` by
 * `scripts/vendor-boundaries.mjs` — CSP-clean (no external fetch) and loaded only
 * in the lazy sales-maps chunk. This replaced the original hand-drawn 6-region
 * low-resolution seed (the §8 vendoring follow-up, now shipped).
 *
 * Territories are matched to regions by NAME (case-insensitive), including each
 * region's aliases (NAME_LONG / ISO codes), so "United States", "USA" and
 * "United States of America" all colour the same country. A territory→region
 * mapping field remains the recorded production follow-up for ambiguous names.
 */
import { WORLD_REGIONS, type WorldRegion } from './worldBoundaries.js';

export { WORLD_REGIONS };
export type BoundaryRegion = WorldRegion;

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Build a regionId→value lookup from named values (e.g. territory attainment),
 * matching each region's canonical name first, then its aliases.
 */
export function matchValuesToRegions(values: ReadonlyArray<{ name: string; value: number }>): Map<string, number> {
  const out = new Map<string, number>();
  // Iterate the VALUES (not the regions) so `resolveRegionId` is the single answer to
  // "where does this land?" — a caller asking whether something is placed now runs the
  // same code that places it. Later values still win on a collision, as before.
  for (const v of values) {
    const id = resolveRegionId({ name: v.name });
    if (id !== undefined) out.set(id, v.value);
  }
  // Second pass preserves the pre-existing precedence: a CANONICAL-name match outranks
  // an alias match landing on the same region (the old region-major loop got that for
  // free by checking `region.name` before `region.aliases`).
  for (const v of values) {
    const canonical = WORLD_REGIONS.find((r) => norm(r.name) === norm(v.name));
    if (canonical) out.set(canonical.id, v.value);
  }
  return out;
}

/**
 * R2 SM2-B3 — the ONE place that answers "which region does this land on?", so a caller
 * asking whether something was placed cannot drift from what actually places it. The
 * page's own re-implementation checked the canonical name only, without trimming, and
 * therefore reported a territory named "USA" — the exact example the page's copy tells
 * the user to use — as both shaded AND "not shown".
 */
export function resolveRegionId(v: { name: string; regionId?: string }): string | undefined {
  if (v.regionId) return WORLD_REGIONS.some((r) => r.id === v.regionId) ? v.regionId : undefined;
  const key = norm(v.name);
  return WORLD_REGIONS.find((r) => norm(r.name) === key || r.aliases.some((a) => norm(a) === key))?.id;
}

/**
 * The full matching ladder (ADR 0282 §8): an EXPLICIT `regionId` mapping wins;
 * values without one fall back to name/alias matching. An explicit mapping also
 * beats a name-match from a different value landing on the same region.
 */
export function regionValues(values: ReadonlyArray<{ name: string; regionId?: string; value: number }>): Map<string, number> {
  const out = matchValuesToRegions(values.filter((v) => !v.regionId));
  for (const v of values) {
    if (!v.regionId) continue;
    const id = resolveRegionId(v);
    if (id !== undefined) out.set(id, v.value);
  }
  return out;
}

/** A rough centroid (vertex mean) for placing a region label / matching by proximity. */
export function regionCentroid(region: BoundaryRegion): [number, number] {
  const rings = region.geometry.type === 'Polygon' ? region.geometry.coordinates : region.geometry.coordinates.flat();
  const pts = rings.flat();
  const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [lng, lat];
}
