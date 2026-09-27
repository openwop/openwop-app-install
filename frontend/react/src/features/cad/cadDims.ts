/**
 * CAD dimension system (ADR 0388 P3) — typed annotated dimensions over the
 * closed solid world. FE↔BE TWIN (frontend/react/src/features/cad/cadDims.ts
 * is byte-identical, pinned by a parity test — the meshCodec discipline).
 *
 * Architect rulings (recorded in the ADR phase table):
 * - Dimension VALUES are DERIVED from geometry at read time, never stored —
 *   an annotation names WHAT to measure (solid + kind + axis); the number can
 *   therefore never drift from the model.
 * - Tolerances are FLAT closed-world fields (`tolType` + `tolA`/`tolB`), not a
 *   nested object — `symmetric` (±tolA) | `asymmetric` (+tolA/−tolB) |
 *   `limit` (upper tolA / lower tolB).
 * - A dimension's `unit` MUST equal the document unit (open-question 3's
 *   recorded "simplest closed world" assumption; conversion is future work).
 * - Solids are referenced BY INDEX (the doc's positional element model); an
 *   out-of-range reference is validator-rejected at save and tolerantly
 *   hidden at render.
 */

export const CAD_DIMENSION_KINDS = ['linear', 'angular', 'radial', 'diameter', 'arc', 'ordinate'] as const;
export type CadDimensionKind = (typeof CAD_DIMENSION_KINDS)[number];

export const CAD_TOLERANCE_TYPES = ['symmetric', 'asymmetric', 'limit'] as const;
export type CadToleranceType = (typeof CAD_TOLERANCE_TYPES)[number];

export const MAX_DIMENSIONS = 100;

export interface CadDimension {
  kind: CadDimensionKind;
  /** Index into `solids` (positional model). */
  solid: number;
  /** linear/ordinate only — the measured axis. */
  axis?: 'x' | 'y' | 'z';
  /** MUST equal the doc unit (validator-enforced). */
  unit?: string;
  tolType?: CadToleranceType;
  tolA?: number;
  tolB?: number;
  label?: string;
}

interface SolidRead {
  kind?: unknown;
  width?: unknown; height?: unknown; depth?: unknown;
  radius?: unknown; length?: unknown; rotation?: unknown; scale?: unknown;
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Derive a dimension's VALUE from its target solid (doc units; degrees for
 * angular). Returns null when the combination is not measurable on that kind
 * (e.g. radial on a box) — the caller renders it as unresolved, never a fake
 * number. Mesh extents need the asset bbox, injected via `meshExtent`.
 */
export function deriveDimensionValue(
  solid: SolidRead | undefined,
  dim: CadDimension,
  meshExtent?: (axis: 'x' | 'y' | 'z') => number | null,
): number | null {
  if (!solid || typeof solid !== 'object') return null;
  const kind = solid.kind;
  if (dim.kind === 'angular') return num(solid.rotation, 0);
  if (dim.kind === 'radial' || dim.kind === 'diameter' || dim.kind === 'arc') {
    if (kind !== 'cylinder' && kind !== 'cone' && kind !== 'sphere') return null;
    const r = num(solid.radius, kind === 'sphere' ? 20 : 15);
    if (dim.kind === 'radial') return r;
    if (dim.kind === 'diameter') return 2 * r;
    return Math.round(2 * Math.PI * r * 1e6) / 1e6; // arc = full circumference (v1 closed world)
  }
  // linear / ordinate — an axis extent.
  const axis = dim.axis ?? 'x';
  if (kind === 'box') {
    return axis === 'x' ? num(solid.width, 40) : axis === 'y' ? num(solid.height, 30) : num(solid.depth, num(solid.width, 40));
  }
  if (kind === 'cylinder' || kind === 'cone') {
    const r = num(solid.radius, 15);
    return axis === 'z' ? num(solid.length, kind === 'cone' ? 35 : 40) : 2 * r;
  }
  if (kind === 'sphere') return 2 * num(solid.radius, 20);
  if (kind === 'mesh') {
    const ext = meshExtent?.(axis);
    return ext === null || ext === undefined ? null : ext * (num(solid.scale, 1) || 1);
  }
  return null;
}

/**
 * Decimal places for a NOMINAL, by unit.
 *
 * UX_UPGRADE-cad R2 (CAD2-B2) — this used to be a hard-coded
 * `Math.round(value * 100) / 100` for every unit, which puts the displayed
 * nominal OUTSIDE its own stated tolerance in `in` and `m`:
 *
 *   1.4375 in ±0.001  rendered `1.44 in ±0.001`   → off by 0.0025 (2.5× the tol)
 *   0.04052 m ±0.0002 rendered `0.04 m ±0.0002`   → off by 0.00052 (2.6×)
 *
 * Both are valid doc units, and a toleranced GD&T annotation is a manufacturing
 * instruction — the one place a rounded display is not cosmetic. The tolerances
 * on the same line were already printed unrounded, so the label contradicted
 * itself. The module header's claim that the derived value "can never drift
 * from the model" was true of the DERIVATION and false of the DISPLAY.
 */
const DP_BY_UNIT: Record<string, number> = { mm: 2, cm: 3, in: 4, m: 5 };

/** Render text for a dimension: value + unit + tolerance grammar. */
export function formatDimension(value: number, dim: CadDimension, docUnits: string): string {
  // Angular is always degrees; otherwise scale precision to the unit, and — when
  // a tolerance is stated — to the tolerance itself, so the nominal can never be
  // displayed further from the truth than the tolerance it claims.
  const unitKey = dim.kind === 'angular' ? 'mm' : (dim.unit ?? docUnits);
  let dp = DP_BY_UNIT[unitKey] ?? 2;
  // The full WIDTH of the band the nominal must land inside, per grammar:
  //   symmetric  ±a          → 2a
  //   asymmetric +a / −b     → a + b
  //   limit      (b … a)     → |a − b|   ← ABSOLUTE limits, not deltas
  //
  // CORRECTED TWICE (review CAD2-R1). The first cut used `Math.min(tolA, tolB)`,
  // which is a magnitude only for the first two grammars: for `limit` it read
  // `min(10.001, 10.002)` as a ±10.001 tolerance, left `dp` at 2, and rendered
  // `10.0015 mm (10.001…10.002)` as `10 mm (…)` — the nominal outside its own
  // window, i.e. the very Blocker this function was changed to fix, surviving in
  // the one grammar that had no test. The second cut fixed the band but required
  // only `0.5·10^-dp ≤ band`, which still let a 0.009-wide window round out
  // (39.9955 → `40`). The requirement is that a whole display STEP fit inside
  // the band, so rounding cannot cross it:  10^-dp ≤ band  ⇔  dp ≥ ⌈−log10(band)⌉.
  const band = dim.tolType === 'limit'
    ? (typeof dim.tolA === 'number' && typeof dim.tolB === 'number' ? Math.abs(dim.tolA - dim.tolB) : 0)
    : dim.tolType === 'asymmetric'
      ? (typeof dim.tolA === 'number' && typeof dim.tolB === 'number' ? dim.tolA + dim.tolB : 0)
      : (typeof dim.tolA === 'number' && dim.tolA > 0 ? dim.tolA * 2 : 0);
  if (band > 0) {
    const needed = Math.ceil(-Math.log10(band));
    if (Number.isFinite(needed) && needed > dp) dp = Math.min(needed, 8);
  }
  const f = 10 ** dp;
  const v = Math.round(value * f) / f;
  const unit = dim.kind === 'angular' ? '°' : ` ${dim.unit ?? docUnits}`;
  let tol = '';
  if (dim.tolType === 'symmetric' && typeof dim.tolA === 'number') tol = ` ±${dim.tolA}`;
  else if (dim.tolType === 'asymmetric' && typeof dim.tolA === 'number' && typeof dim.tolB === 'number') tol = ` +${dim.tolA}/−${dim.tolB}`;
  else if (dim.tolType === 'limit' && typeof dim.tolA === 'number' && typeof dim.tolB === 'number') tol = ` (${dim.tolB}…${dim.tolA})`;
  return `${v}${unit}${tol}`;
}

/**
 * DETERMINISTIC dimension proposals for un-dimensioned solids (the
 * `dimension.suggest` node's engine): per kind, the primary defining
 * dimensions, in fixed order. Pure — same model ⇒ identical proposals.
 */
export function suggestDimensions(
  solids: SolidRead[],
  existing: CadDimension[],
  docUnits: string,
): CadDimension[] {
  const covered = new Set(existing.map((d) => d.solid));
  // GRADE-PASS CAD-G5: suggestions must fit the doc's remaining headroom —
  // suggesting up to 100 on a doc that already holds 90 made it unsaveable.
  const headroom = Math.max(0, MAX_DIMENSIONS - existing.length);
  const out: CadDimension[] = [];
  for (let i = 0; i < solids.length; i += 1) {
    if (covered.has(i)) continue;
    const s = solids[i];
    if (!s || typeof s !== 'object') continue;
    const base = { solid: i, unit: docUnits };
    if (s.kind === 'box' || s.kind === 'mesh') {
      out.push({ kind: 'linear', axis: 'x', ...base }, { kind: 'linear', axis: 'y', ...base }, { kind: 'linear', axis: 'z', ...base });
    } else if (s.kind === 'cylinder' || s.kind === 'cone') {
      out.push({ kind: 'diameter', ...base }, { kind: 'linear', axis: 'z', ...base });
    } else if (s.kind === 'sphere') {
      out.push({ kind: 'diameter', ...base });
    }
    if (out.length >= headroom) break;
  }
  return out.slice(0, headroom);
}
