#!/usr/bin/env node
/**
 * Vendor the Sales Maps world boundaries (ADR 0282 §8) — fetches Natural Earth
 * 1:110m admin-0 countries (public domain, naturalearthdata.com) and writes the
 * bundled src/features/sales-maps/worldBoundaries.ts module.
 *
 * Conversion keeps the bundle small while staying below the source resolution:
 * coordinates rounded to 2 decimals (~1.1 km; the 110m source is ~10 km),
 * consecutive duplicate points deduped, degenerate rings dropped, Antarctica
 * excluded (noise on a sales map). `aliases` carry NAME_LONG / NAME_EN / ISO
 * codes so a territory named "United States" matches "United States of America".
 *
 * Run manually when refreshing the data: node scripts/vendor-boundaries.mjs
 * (needs network — the output is committed, so builds never fetch).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const SOURCE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/features/sales-maps/worldBoundaries.ts');

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`fetch ${SOURCE} → ${res.status}`);
const src = await res.json();

const R = 100; // 2 decimals ≈ 1.1 km
const round = (n) => Math.round(n * R) / R;

const cleanRing = (ring) => {
  const out = [];
  for (const [lng, lat] of ring) {
    const p = [round(lng), round(lat)];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  if (out.length > 1) {
    const [f, l] = [out[0], out[out.length - 1]];
    if (f[0] === l[0] && f[1] === l[1]) out.pop(); // SVG 'Z' closes the ring
  }
  return out.length >= 3 ? out : null;
};

const cleanPoly = (poly) => {
  const rings = poly.map(cleanRing).filter(Boolean);
  return rings.length > 0 ? rings : null;
};

const regions = [];
for (const f of src.features) {
  const p = f.properties;
  const id = String(p.ADM0_A3 || p.ISO_A3 || p.NAME).toLowerCase();
  if (id === 'ata') continue; // Antarctica
  const name = p.NAME_EN || p.NAME;
  const aliasSet = new Set(
    [p.NAME, p.NAME_LONG, p.NAME_EN, p.ISO_A3, p.ISO_A2, p.ADM0_A3].filter((a) => a && a !== '-99' && a !== name),
  );
  const g = f.geometry;
  let polys;
  if (g.type === 'Polygon') {
    const poly = cleanPoly(g.coordinates);
    polys = poly ? [poly] : [];
  } else if (g.type === 'MultiPolygon') {
    polys = g.coordinates.map(cleanPoly).filter(Boolean);
  } else continue;
  if (polys.length === 0) continue;
  const geometry = polys.length === 1
    ? { type: 'Polygon', coordinates: polys[0] }
    : { type: 'MultiPolygon', coordinates: polys };
  regions.push({ id, name, aliases: [...aliasSet], geometry });
}

regions.sort((a, b) => a.id.localeCompare(b.id));

const ts = `/**
 * Sales Maps — vendored world boundary data (ADR 0282 §8 production follow-up).
 *
 * Natural Earth 1:110m admin-0 countries (public domain, naturalearthdata.com),
 * converted by scripts/vendor-boundaries.mjs: coordinates rounded to 2 decimals
 * (~1.1 km, below the 110m source resolution), consecutive duplicates deduped,
 * Antarctica dropped. ${regions.length} countries. CSP-clean (bundled, no external
 * fetch) and loaded only inside the lazy sales-maps chunk — never entry-resident.
 *
 * GENERATED FILE — do not hand-edit; re-run scripts/vendor-boundaries.mjs.
 * Coordinates are [lng, lat]. \`aliases\` carry alternate names (NAME_LONG, ISO
 * codes) so a territory named "United States" matches "United States of America".
 */
import type { GeoGeometry } from './projection.js';

export interface WorldRegion {
  id: string;
  name: string;
  aliases: string[];
  geometry: GeoGeometry;
}

export const WORLD_REGIONS: readonly WorldRegion[] = [
${regions.map((r) => `  ${JSON.stringify(r)},`).join('\n')}
];
`;
writeFileSync(OUT, ts);
console.log(`✓ vendor-boundaries: ${regions.length} regions → ${OUT} (${(ts.length / 1024).toFixed(0)} kB raw)`);

// The lightweight id+name catalog — for pickers OUTSIDE the sales-maps chunk
// (e.g. the Territories page's map-region field, ADR 0282 §8). Kept as a
// SEPARATE module so consumers never pull the ~155 kB geometry into their chunk.
const CATALOG_OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/features/sales-maps/regionCatalog.ts');
const catalog = `/**
 * Sales Maps — region CATALOG (id + display name only; ADR 0282 §8).
 *
 * The picker-sized companion to worldBoundaries.ts: same ${regions.length} Natural Earth
 * countries, NO geometry — safe to import from other lazy chunks (the
 * Territories page's map-region field) without dragging the boundary data in.
 *
 * GENERATED FILE — do not hand-edit; re-run scripts/vendor-boundaries.mjs.
 */
export interface RegionCatalogEntry { id: string; name: string }

export const REGION_CATALOG: readonly RegionCatalogEntry[] = [
${regions.map((r) => `  ${JSON.stringify({ id: r.id, name: r.name })},`).join('\n')}
];
`;
writeFileSync(CATALOG_OUT, catalog);
console.log(`✓ vendor-boundaries: catalog → ${CATALOG_OUT} (${(catalog.length / 1024).toFixed(0)} kB raw)`);
