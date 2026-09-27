/**
 * BOM / cutlist (ADR 0388 P2) — a DETERMINISTIC, zero-AI projection of a
 * `canvas.cad` model into a bill of materials: identical parts (same kind +
 * dimensions + material identity) roll up into one row with a quantity;
 * volume/area derive from exact closed-form formulas for the parametric kinds
 * and from the triangle soup for meshes (area exact; volume by signed
 * tetrahedron sum — only exact for a CLOSED mesh, so it is FLAGGED
 * `volumeApprox`, never silently pretended). Same model ⇒ byte-identical BOM
 * (fixed row ordering: first appearance in doc order; numbers rounded to 6dp).
 *
 * The BOM is computed, never model-authored (closed-world honesty — the agent
 * can REQUEST one; it cannot write one).
 */
import { OpenwopError } from '../../types.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { parseStl, type TessellatableSolid } from './meshCodec.js';
import { getMeshAsset, codecErrorToHttp } from './meshAssets.js';
import { CAD_SOLID_KINDS } from './validateCadDoc.js';

export const CAD_BOM_TYPE_ID = 'canvas.cad.bom';

export interface BomRow {
  label: string;
  kind: string;
  quantity: number;
  /** The kind's defining dimensions (doc units). */
  dimensions: Record<string, number>;
  material?: string;
  /** Total volume for the row (quantity × unit volume), doc units³. */
  volume: number;
  /** Total surface area for the row, doc units². */
  area: number;
  /** Mesh rows only: volume is the signed-tetrahedron sum — exact ONLY for a
   *  closed mesh (disclosed, never silent). */
  volumeApprox?: boolean;
}

export interface BomDoc {
  modelName?: string;
  units: string;
  rows: BomRow[];
  totals: {
    parts: number;
    volume: number;
    area: number;
    /** UX_UPGRADE-cad R2 (CAD2-B3) — TRUE when any row's volume is approximate,
     *  so the TOTAL inherits the disclosure its parts carry. Per-row
     *  `volumeApprox` existed ("exact ONLY for a closed mesh — disclosed, never
     *  silent"); the total summed approximate and exact volumes together and
     *  the CSV wrote an EMPTY string in the approx column for it — an
     *  affirmative claim of exactness on the number a quoting spreadsheet
     *  actually consumes. A per-row flag without a total-level one is the same
     *  shape as a per-line quantiser with unrounded totals. */
    volumeApprox?: boolean;
  };
}

export function cadBomSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['units', 'rows', 'totals'],
    properties: {
      modelName: { type: 'string', maxLength: 200 },
      units: { type: 'string', enum: ['mm', 'cm', 'm', 'in'] },
      rows: {
        type: 'array', maxItems: 200,
        items: {
          type: 'object',
          required: ['label', 'kind', 'quantity', 'dimensions', 'volume', 'area'],
          properties: {
            label: { type: 'string', maxLength: 80 },
            kind: { type: 'string', enum: [...CAD_SOLID_KINDS] },
            quantity: { type: 'integer', minimum: 1 },
            dimensions: { type: 'object', additionalProperties: { type: 'number' } },
            material: { type: 'string', maxLength: 80 },
            volume: { type: 'number', minimum: 0 },
            area: { type: 'number', minimum: 0 },
            volumeApprox: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      totals: {
        type: 'object',
        required: ['parts', 'volume', 'area'],
        properties: {
          parts: { type: 'integer', minimum: 0 },
          volume: { type: 'number', minimum: 0 },
          area: { type: 'number', minimum: 0 },
          // CAD2-B3 — `additionalProperties: false` meant the total could not
          // carry the disclosure its own rows carry, even if the code set it.
          volumeApprox: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Closed-form volume/area for the parametric kinds (doc units). */
function parametricMetrics(s: TessellatableSolid): { volume: number; area: number; dimensions: Record<string, number> } {
  if (s.kind === 'box') {
    const w = s.width ?? 40; const h = s.height ?? 30; const d = s.depth ?? s.width ?? 40;
    return { volume: w * h * d, area: 2 * (w * h + w * d + h * d), dimensions: { width: w, height: h, depth: d } };
  }
  if (s.kind === 'cylinder') {
    const r = s.radius ?? 15; const len = s.length ?? 40;
    return { volume: Math.PI * r * r * len, area: 2 * Math.PI * r * (r + len), dimensions: { radius: r, length: len } };
  }
  if (s.kind === 'cone') {
    const r = s.radius ?? 15; const len = s.length ?? 35;
    const slant = Math.sqrt(r * r + len * len);
    return { volume: (Math.PI * r * r * len) / 3, area: Math.PI * r * (r + slant), dimensions: { radius: r, length: len } };
  }
  // sphere
  const r = s.radius ?? 20;
  return { volume: (4 / 3) * Math.PI * r * r * r, area: 4 * Math.PI * r * r, dimensions: { radius: r } };
}

/** Triangle-soup metrics: area exact; volume by signed tetrahedra (closed-mesh
 *  exact, otherwise an approximation — the caller flags it). */
function meshMetrics(positions: Float32Array): { volume: number; area: number } {
  let area = 0;
  let vol6 = 0;
  for (let t = 0; t * 9 < positions.length; t += 1) {
    const p = t * 9;
    const ax = positions[p] ?? 0; const ay = positions[p + 1] ?? 0; const az = positions[p + 2] ?? 0;
    const bx = positions[p + 3] ?? 0; const by = positions[p + 4] ?? 0; const bz = positions[p + 5] ?? 0;
    const cx = positions[p + 6] ?? 0; const cy = positions[p + 7] ?? 0; const cz = positions[p + 8] ?? 0;
    const ux = bx - ax; const uy = by - ay; const uz = bz - az;
    const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
    const crx = uy * vz - uz * vy; const cry = uz * vx - ux * vz; const crz = ux * vy - uy * vx;
    area += Math.sqrt(crx * crx + cry * cry + crz * crz) / 2;
    vol6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return { volume: Math.abs(vol6) / 6, area };
}

/** The BOM's material label: the library id when set (human-meaningful), else
 *  the inline color, else nothing (grade-pass CAD-C7). */
function materialLabelOf(s: TessellatableSolid): string | undefined {
  if (typeof s.materialId === 'string' && s.materialId) return s.materialId;
  return typeof s.color === 'string' && s.color ? s.color : undefined;
}

/** The roll-up identity: kind + dimensions + material (+ mesh assetRef+scale).
 *  Canonical-JSON keyed so identical parts group deterministically. */
function identityOf(s: TessellatableSolid, dims: Record<string, number>): string {
  // Grade-pass (CAD-C7): a library materialId is part of a part's identity —
  // a steel and a gold bracket of identical dimensions are different rows.
  const material = materialLabelOf(s) ?? '';
  const parts: Record<string, unknown> = { kind: s.kind, material };
  for (const k of Object.keys(dims).sort()) parts[k] = dims[k];
  if (s.kind === 'mesh') {
    parts.assetRef = s.assetRef ?? '';
    parts.scale = s.scale ?? 1;
  }
  return JSON.stringify(parts);
}

/**
 * Generate the BOM for a `canvas.cad` state. Deterministic: rows appear in
 * first-appearance doc order; an unknown solid kind is a TYPED error (never a
 * silently skipped row).
 */
export async function generateBom(tenantId: string, state: Record<string, unknown>): Promise<BomDoc> {
  const solids = Array.isArray(state.solids) ? (state.solids as TessellatableSolid[]) : [];
  if (solids.length === 0) {
    throw new OpenwopError('validation_error', 'The model has no solids.', 422, {});
  }
  const rows = new Map<string, BomRow>();
  const order: string[] = [];
  for (let i = 0; i < solids.length; i += 1) {
    const s = solids[i];
    if (!s || typeof s !== 'object') continue;
    if (typeof s.kind !== 'string' || !(CAD_SOLID_KINDS as readonly string[]).includes(s.kind)) {
      throw new OpenwopError('validation_error', `Solid ${i + 1} has unknown kind '${String(s.kind)}'.`, 422, { solid: i });
    }
    let volume: number;
    let area: number;
    let dimensions: Record<string, number>;
    let volumeApprox = false;
    if (s.kind === 'mesh') {
      const asset = typeof s.assetRef === 'string' ? await getMeshAsset(tenantId, s.assetRef) : null;
      if (!asset) {
        throw new OpenwopError('validation_error', `Mesh solid ${i + 1} references a missing asset.`, 422, { solid: i });
      }
      const entry = await resolveMediaAsset(asset.serveToken);
      if (!entry || entry.tenantId !== tenantId) {
        throw new OpenwopError('validation_error', `Mesh solid ${i + 1}'s stored bytes are unavailable.`, 422, { solid: i });
      }
      const bytes = Buffer.from(entry.contentBase64, 'base64');
      let parsed;
      try {
        parsed = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      } catch (err) {
        codecErrorToHttp(err);
      }
      const scale = typeof s.scale === 'number' && s.scale > 0 ? s.scale : 1;
      const m = meshMetrics(parsed.positions);
      volume = m.volume * scale * scale * scale;
      area = m.area * scale * scale;
      volumeApprox = true; // exact only for a closed mesh — disclosed
      const ext = [0, 1, 2].map((a) => r6((parsed.bbox.max[a]! - parsed.bbox.min[a]!) * scale));
      dimensions = { sizeX: ext[0] ?? 0, sizeY: ext[1] ?? 0, sizeZ: ext[2] ?? 0 };
    } else {
      const m = parametricMetrics(s);
      volume = m.volume;
      area = m.area;
      dimensions = m.dimensions;
    }
    const id = identityOf(s, dimensions);
    const existing = rows.get(id);
    if (existing) {
      existing.quantity += 1;
      existing.volume = r6(existing.volume + volume);
      existing.area = r6(existing.area + area);
    } else {
      const label = (typeof s.label === 'string' && s.label.trim() ? s.label.trim() : `${s.kind}-${i + 1}`).slice(0, 80);
      const material = materialLabelOf(s);
      rows.set(id, {
        label,
        kind: s.kind,
        quantity: 1,
        dimensions: Object.fromEntries(Object.entries(dimensions).map(([k, v]) => [k, r6(v)])),
        ...(material ? { material } : {}),
        volume: r6(volume),
        area: r6(area),
        ...(volumeApprox ? { volumeApprox: true } : {}),
      });
      order.push(id);
    }
  }
  const outRows = order.map((id) => rows.get(id)!);
  const totals = outRows.reduce(
    (acc, row) => ({ parts: acc.parts + row.quantity, volume: r6(acc.volume + row.volume), area: r6(acc.area + row.area) }),
    { parts: 0, volume: 0, area: 0 },
  );
  // CAD2-B3 — the total is approximate if ANY part of it is.
  const anyApprox = outRows.some((row) => row.volumeApprox === true);
  return {
    ...(typeof state.name === 'string' && state.name ? { modelName: state.name } : {}),
    units: typeof state.units === 'string' ? state.units : 'mm',
    rows: outRows,
    totals: { ...totals, ...(anyApprox ? { volumeApprox: true } : {}) },
  };
}

/** The ONE CSV builder (deterministic; RFC-4180 quoting). */
export function bomCsv(bom: BomDoc): string {
  const esc = (v: string | number): string => {
    let s = String(v);
    // Grade-pass (CAD-C6): neutralize spreadsheet formula injection — a label
    // like `=HYPERLINK(...)` executes when the CSV opens in Excel/Sheets.
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    ['label', 'kind', 'quantity', 'dimensions', 'material', `volume (${bom.units}³)`, `area (${bom.units}²)`, 'volume approx'].map(esc).join(','),
  ];
  for (const row of bom.rows) {
    const dims = Object.entries(row.dimensions).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push([
      esc(row.label), esc(row.kind), esc(row.quantity), esc(dims), esc(row.material ?? ''),
      esc(row.volume), esc(row.area), esc(row.volumeApprox ? 'yes' : ''),
    ].join(','));
  }
  lines.push([
    'TOTAL', '', String(bom.totals.parts), '', '',
    String(bom.totals.volume), String(bom.totals.area),
    // CAD2-B3 — an empty cell here USED to assert the total was exact even when
    // it summed approximate mesh volumes.
    bom.totals.volumeApprox ? 'yes' : '',
  ].map(esc).join(','));
  return `${lines.join('\n')}\n`;
}
