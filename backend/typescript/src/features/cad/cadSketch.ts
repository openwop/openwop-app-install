/**
 * 2D sketch constraint solver (ADR 0388 P4). FE↔BE TWIN (frontend/react/src/
 * features/cad/cadSketch.ts is byte-identical, parity-pinned).
 *
 * THE determinism-critical module of the CAD program (matrix row 9): a
 * hand-rolled Gauss-Newton over constraint residuals with a FIXED iteration
 * cap, FIXED convergence tolerance, FIXED constraint order (array order),
 * FIXED-pivot Gaussian elimination, no wall-clock, no RNG — so replaying a
 * run that solved a sketch reproduces byte-identical coordinates. This is why
 * the solver is hand-rolled and why a WASM kernel (build-drifting numerics)
 * was rejected in the ADR.
 *
 * Scope (the ADR's firm boundary): 2D sketches on the DERIVED z=0
 * construction plane (open-question 2's resolution — a plane is not a doc
 * concept). Full 3D assembly constraints are deferred, not faked.
 *
 * Diagnostics come from the Jacobian: rank < unknowns ⇒ UNDER-constrained
 * (free DoF reported); a constraint whose residual cannot converge while the
 * rest do ⇒ OVER-constrained/conflicting (its index reported). Degenerate
 * input (non-convergence) is a typed error, never a silent bad answer.
 */

export const SKETCH_CONSTRAINT_KINDS = [
  'coincident', 'concentric', 'parallel', 'perpendicular', 'tangent', 'equal',
  'horizontal', 'vertical', 'fixed', 'distance', 'angle', 'symmetric',
] as const;
export type SketchConstraintKind = (typeof SKETCH_CONSTRAINT_KINDS)[number];

export const MAX_SKETCH_POINTS = 200;
export const MAX_SKETCH_SEGMENTS = 200;
export const MAX_SKETCH_CONSTRAINTS = 300;

export const SOLVER_MAX_ITERATIONS = 100;
export const SOLVER_TOLERANCE = 1e-9;

export interface SketchPoint { x: number; y: number }
export interface SketchSegment { kind: 'line' | 'arc'; a: number; b: number; r?: number }
export interface SketchConstraint {
  kind: SketchConstraintKind;
  /** Point indices (coincident/horizontal/vertical/fixed/distance/symmetric…). */
  points?: number[];
  /** Segment indices (parallel/perpendicular/equal/tangent/concentric/angle). */
  segments?: number[];
  /** distance (model units) / angle (degrees) targets; fixed's pinned coords. */
  value?: number;
  x?: number;
  y?: number;
}
export interface Sketch {
  points: SketchPoint[];
  segments: SketchSegment[];
  constraints: SketchConstraint[];
}

export class SketchError extends Error {
  constructor(
    public readonly code: 'invalid' | 'no_converge' | 'over_constrained',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SketchError';
  }
}

export interface SolveResult {
  points: SketchPoint[];
  iterations: number;
  residual: number;
  diagnostics: {
    status: 'well-constrained' | 'under-constrained' | 'over-constrained';
    /** under: how many free degrees of freedom remain. */
    freeDof?: number;
    /** over: the (first) conflicting/redundant constraint indices. */
    conflicting?: number[];
  };
}

const DEG = Math.PI / 180;
const r9 = (v: number): number => Math.round(v * 1e9) / 1e9;

/** Structural validation (typed; closed world). Exported for the validator. */
export function validateSketch(sk: Sketch): void {
  if (!Array.isArray(sk.points) || sk.points.length === 0 || sk.points.length > MAX_SKETCH_POINTS) {
    throw new SketchError('invalid', `A sketch needs 1..${MAX_SKETCH_POINTS} points.`);
  }
  for (const p of sk.points) {
    if (!p || typeof p.x !== 'number' || !Number.isFinite(p.x) || typeof p.y !== 'number' || !Number.isFinite(p.y)) {
      throw new SketchError('invalid', 'Every sketch point needs finite x/y.');
    }
  }
  if (!Array.isArray(sk.segments) || sk.segments.length > MAX_SKETCH_SEGMENTS) {
    throw new SketchError('invalid', `A sketch holds at most ${MAX_SKETCH_SEGMENTS} segments.`);
  }
  for (const s of sk.segments) {
    if (!s || (s.kind !== 'line' && s.kind !== 'arc')) throw new SketchError('invalid', 'Segment kind must be line|arc.');
    for (const idx of [s.a, s.b]) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= sk.points.length) {
        throw new SketchError('invalid', 'Segment endpoints must reference existing points.');
      }
    }
    if (s.kind === 'arc' && (typeof s.r !== 'number' || !Number.isFinite(s.r) || s.r <= 0)) {
      throw new SketchError('invalid', 'An arc segment needs a radius > 0.');
    }
  }
  if (!Array.isArray(sk.constraints) || sk.constraints.length > MAX_SKETCH_CONSTRAINTS) {
    throw new SketchError('invalid', `A sketch holds at most ${MAX_SKETCH_CONSTRAINTS} constraints.`);
  }
  sk.constraints.forEach((c, i) => {
    if (!c || !(SKETCH_CONSTRAINT_KINDS as readonly string[]).includes(c.kind)) {
      throw new SketchError('invalid', `Constraint ${i}: unknown kind '${String(c?.kind)}'.`);
    }
    for (const p of c.points ?? []) {
      if (!Number.isInteger(p) || p < 0 || p >= sk.points.length) {
        throw new SketchError('invalid', `Constraint ${i}: point reference out of range.`);
      }
    }
    for (const s of c.segments ?? []) {
      if (!Number.isInteger(s) || s < 0 || s >= sk.segments.length) {
        throw new SketchError('invalid', `Constraint ${i}: segment reference out of range.`);
      }
    }
    // Grade-pass (CAD-C9/DATA-4): non-finite numeric targets (NaN/Infinity —
    // JSON.parse('1e400') yields Infinity and passes typeof checks) would
    // NaN-poison every residual and the NaN comparisons below would then
    // report SUCCESS with NaN coordinates. Typed-reject them here.
    for (const [field, raw] of [['value', c.value], ['x', c.x], ['y', c.y]] as const) {
      if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw))) {
        throw new SketchError('invalid', `Constraint ${i}: '${field}' must be a finite number.`);
      }
    }
  });
}

interface Residual {
  /** The constraint index this residual row belongs to (diagnostics). */
  ci: number;
  f: (v: Float64Array) => number;
  /** Analytic partials: [pointIndex*2 (+1 for y), dValue][] — sparse. */
  grad: (v: Float64Array) => Array<[number, number]>;
}

const px = (v: Float64Array, i: number): number => v[i * 2] ?? 0;
const py = (v: Float64Array, i: number): number => v[i * 2 + 1] ?? 0;

/** Compile constraints → residual rows (fixed order: array order; multi-row
 *  constraints emit rows in a fixed internal order). */
function compile(sk: Sketch): Residual[] {
  const rows: Residual[] = [];
  const seg = (i: number): SketchSegment => sk.segments[i]!;
  sk.constraints.forEach((c, ci) => {
    const P = c.points ?? [];
    const S = c.segments ?? [];
    const push = (f: Residual['f'], grad: Residual['grad']): void => { rows.push({ ci, f, grad }); };
    if (c.kind === 'coincident' && P.length >= 2) {
      const [a, b] = [P[0]!, P[1]!];
      push((v) => px(v, a) - px(v, b), () => [[a * 2, 1], [b * 2, -1]]);
      push((v) => py(v, a) - py(v, b), () => [[a * 2 + 1, 1], [b * 2 + 1, -1]]);
    } else if (c.kind === 'horizontal' && P.length >= 2) {
      const [a, b] = [P[0]!, P[1]!];
      push((v) => py(v, a) - py(v, b), () => [[a * 2 + 1, 1], [b * 2 + 1, -1]]);
    } else if (c.kind === 'vertical' && P.length >= 2) {
      const [a, b] = [P[0]!, P[1]!];
      push((v) => px(v, a) - px(v, b), () => [[a * 2, 1], [b * 2, -1]]);
    } else if (c.kind === 'fixed' && P.length >= 1) {
      const a = P[0]!;
      const tx = c.x ?? sk.points[a]!.x;
      const ty = c.y ?? sk.points[a]!.y;
      push((v) => px(v, a) - tx, () => [[a * 2, 1]]);
      push((v) => py(v, a) - ty, () => [[a * 2 + 1, 1]]);
    } else if (c.kind === 'distance' && P.length >= 2 && typeof c.value === 'number') {
      const [a, b] = [P[0]!, P[1]!];
      const d = c.value;
      push(
        (v) => {
          const dx = px(v, a) - px(v, b); const dy = py(v, a) - py(v, b);
          return dx * dx + dy * dy - d * d;
        },
        (v) => {
          const dx = px(v, a) - px(v, b); const dy = py(v, a) - py(v, b);
          return [[a * 2, 2 * dx], [a * 2 + 1, 2 * dy], [b * 2, -2 * dx], [b * 2 + 1, -2 * dy]];
        },
      );
    } else if (c.kind === 'symmetric' && P.length >= 3) {
      // P2 is the midline point: P0/P1 symmetric about the vertical line x=P2.x.
      const [a, b, m] = [P[0]!, P[1]!, P[2]!];
      push((v) => px(v, a) + px(v, b) - 2 * px(v, m), () => [[a * 2, 1], [b * 2, 1], [m * 2, -2]]);
      push((v) => py(v, a) - py(v, b), () => [[a * 2 + 1, 1], [b * 2 + 1, -1]]);
    } else if ((c.kind === 'parallel' || c.kind === 'perpendicular') && S.length >= 2) {
      const s1 = seg(S[0]!); const s2 = seg(S[1]!);
      const [a1, b1, a2, b2] = [s1.a, s1.b, s2.a, s2.b];
      if (c.kind === 'parallel') {
        // cross(d1, d2) = 0
        push(
          (v) => (px(v, b1) - px(v, a1)) * (py(v, b2) - py(v, a2)) - (py(v, b1) - py(v, a1)) * (px(v, b2) - px(v, a2)),
          (v) => {
            const d1x = px(v, b1) - px(v, a1); const d1y = py(v, b1) - py(v, a1);
            const d2x = px(v, b2) - px(v, a2); const d2y = py(v, b2) - py(v, a2);
            return [
              [b1 * 2, d2y], [a1 * 2, -d2y], [b1 * 2 + 1, -d2x], [a1 * 2 + 1, d2x],
              [b2 * 2 + 1, d1x], [a2 * 2 + 1, -d1x], [b2 * 2, -d1y], [a2 * 2, d1y],
            ];
          },
        );
      } else {
        // dot(d1, d2) = 0
        push(
          (v) => (px(v, b1) - px(v, a1)) * (px(v, b2) - px(v, a2)) + (py(v, b1) - py(v, a1)) * (py(v, b2) - py(v, a2)),
          (v) => {
            const d1x = px(v, b1) - px(v, a1); const d1y = py(v, b1) - py(v, a1);
            const d2x = px(v, b2) - px(v, a2); const d2y = py(v, b2) - py(v, a2);
            return [
              [b1 * 2, d2x], [a1 * 2, -d2x], [b1 * 2 + 1, d2y], [a1 * 2 + 1, -d2y],
              [b2 * 2, d1x], [a2 * 2, -d1x], [b2 * 2 + 1, d1y], [a2 * 2 + 1, -d1y],
            ];
          },
        );
      }
    } else if (c.kind === 'equal' && S.length >= 2) {
      const s1 = seg(S[0]!); const s2 = seg(S[1]!);
      const [a1, b1, a2, b2] = [s1.a, s1.b, s2.a, s2.b];
      push(
        (v) => {
          const l1 = (px(v, b1) - px(v, a1)) ** 2 + (py(v, b1) - py(v, a1)) ** 2;
          const l2 = (px(v, b2) - px(v, a2)) ** 2 + (py(v, b2) - py(v, a2)) ** 2;
          return l1 - l2;
        },
        (v) => {
          const d1x = px(v, b1) - px(v, a1); const d1y = py(v, b1) - py(v, a1);
          const d2x = px(v, b2) - px(v, a2); const d2y = py(v, b2) - py(v, a2);
          return [
            [b1 * 2, 2 * d1x], [a1 * 2, -2 * d1x], [b1 * 2 + 1, 2 * d1y], [a1 * 2 + 1, -2 * d1y],
            [b2 * 2, -2 * d2x], [a2 * 2, 2 * d2x], [b2 * 2 + 1, -2 * d2y], [a2 * 2 + 1, 2 * d2y],
          ];
        },
      );
    } else if (c.kind === 'angle' && S.length >= 2 && typeof c.value === 'number') {
      const s1 = seg(S[0]!); const s2 = seg(S[1]!);
      const [a1, b1, a2, b2] = [s1.a, s1.b, s2.a, s2.b];
      const target = c.value * DEG;
      // cross - tan-free form: cross(d1,d2)·cos(t) - dot(d1,d2)·sin(t) = 0
      const cos = Math.cos(target); const sin = Math.sin(target);
      push(
        (v) => {
          const d1x = px(v, b1) - px(v, a1); const d1y = py(v, b1) - py(v, a1);
          const d2x = px(v, b2) - px(v, a2); const d2y = py(v, b2) - py(v, a2);
          return (d1x * d2y - d1y * d2x) * cos - (d1x * d2x + d1y * d2y) * sin;
        },
        (v) => {
          const d1x = px(v, b1) - px(v, a1); const d1y = py(v, b1) - py(v, a1);
          const d2x = px(v, b2) - px(v, a2); const d2y = py(v, b2) - py(v, a2);
          return [
            [b1 * 2, d2y * cos - d2x * sin], [a1 * 2, -(d2y * cos - d2x * sin)],
            [b1 * 2 + 1, -d2x * cos - d2y * sin], [a1 * 2 + 1, d2x * cos + d2y * sin],
            [b2 * 2, -d1y * cos - d1x * sin], [a2 * 2, d1y * cos + d1x * sin],
            [b2 * 2 + 1, d1x * cos - d1y * sin], [a2 * 2 + 1, -(d1x * cos - d1y * sin)],
          ];
        },
      );
    } else if (c.kind === 'concentric' && S.length >= 2) {
      // Both segments' MIDPOINTS coincide (arc centres approximated by the
      // chord midpoint in this closed v1 model — honest scope).
      const s1 = seg(S[0]!); const s2 = seg(S[1]!);
      const [a1, b1, a2, b2] = [s1.a, s1.b, s2.a, s2.b];
      push(
        (v) => (px(v, a1) + px(v, b1)) / 2 - (px(v, a2) + px(v, b2)) / 2,
        () => [[a1 * 2, 0.5], [b1 * 2, 0.5], [a2 * 2, -0.5], [b2 * 2, -0.5]],
      );
      push(
        (v) => (py(v, a1) + py(v, b1)) / 2 - (py(v, a2) + py(v, b2)) / 2,
        () => [[a1 * 2 + 1, 0.5], [b1 * 2 + 1, 0.5], [a2 * 2 + 1, -0.5], [b2 * 2 + 1, -0.5]],
      );
    } else if (c.kind === 'tangent' && S.length >= 2) {
      // line tangent to arc: distance(chord-midpoint centre, line) = r. v1
      // closed model: residual dist² − r².
      const arcIdx = seg(S[0]!).kind === 'arc' ? S[0]! : S[1]!;
      const lineIdx = arcIdx === S[0]! ? S[1]! : S[0]!;
      const arc = seg(arcIdx); const line = seg(lineIdx);
      if (arc.kind !== 'arc' || line.kind !== 'line') return; // structurally unmatchable — validator warns
      const r = arc.r ?? 1;
      const [la, lb] = [line.a, line.b];
      const [aa, ab] = [arc.a, arc.b];
      push(
        (v) => {
          const cxm = (px(v, aa) + px(v, ab)) / 2; const cym = (py(v, aa) + py(v, ab)) / 2;
          const x1 = px(v, la); const y1 = py(v, la); const x2 = px(v, lb); const y2 = py(v, lb);
          const dx = x2 - x1; const dy = y2 - y1;
          const len2 = dx * dx + dy * dy;
          if (len2 < 1e-12) return r * r; // degenerate line — cannot be tangent
          const cross = dx * (cym - y1) - dy * (cxm - x1);
          return (cross * cross) / len2 - r * r;
        },
        (v) => {
          // Numeric gradient for this one row (central difference, FIXED h) —
          // deterministic; the analytic form is unwieldy and the row count tiny.
          const h = 1e-6;
          const f = rows[rows.length]?.f; // placeholder — replaced below
          void f;
          const idxs = [la * 2, la * 2 + 1, lb * 2, lb * 2 + 1, aa * 2, aa * 2 + 1, ab * 2, ab * 2 + 1];
          const self = (vv: Float64Array): number => {
            const cxm = (px(vv, aa) + px(vv, ab)) / 2; const cym = (py(vv, aa) + py(vv, ab)) / 2;
            const x1 = px(vv, la); const y1 = py(vv, la); const x2 = px(vv, lb); const y2 = py(vv, lb);
            const dx = x2 - x1; const dy = y2 - y1;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-12) return r * r;
            const cross = dx * (cym - y1) - dy * (cxm - x1);
            return (cross * cross) / len2 - r * r;
          };
          const out: Array<[number, number]> = [];
          for (const idx of idxs) {
            const w = new Float64Array(v);
            w[idx] = (w[idx] ?? 0) + h;
            const up = self(w);
            w[idx] = (w[idx] ?? 0) - 2 * h;
            const dn = self(w);
            out.push([idx, (up - dn) / (2 * h)]);
          }
          return out;
        },
      );
    }
  });
  return rows;
}

/** Fixed-pivot Gaussian elimination for the normal equations JᵀJ x = Jᵀr.
 *  Deterministic: partial pivoting picks the FIRST max-magnitude row. */
function solveNormal(ata: Float64Array, atb: Float64Array, n: number): Float64Array | null {
  const a = new Float64Array(ata);
  const b = new Float64Array(atb);
  // Levenberg damping for singular systems — fixed, not adaptive (determinism).
  for (let i = 0; i < n; i += 1) a[i * n + i] = (a[i * n + i] ?? 0) + 1e-10;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let best = Math.abs(a[col * n + col] ?? 0);
    for (let row = col + 1; row < n; row += 1) {
      const mag = Math.abs(a[row * n + col] ?? 0);
      if (mag > best) { best = mag; pivot = row; }
    }
    if (best < 1e-14) return null;
    if (pivot !== col) {
      for (let k = col; k < n; k += 1) { const t = a[col * n + k]!; a[col * n + k] = a[pivot * n + k]!; a[pivot * n + k] = t; }
      const t = b[col]!; b[col] = b[pivot]!; b[pivot] = t;
    }
    const d = a[col * n + col]!;
    for (let row = col + 1; row < n; row += 1) {
      const factor = (a[row * n + col] ?? 0) / d;
      if (factor === 0) continue;
      for (let k = col; k < n; k += 1) a[row * n + k] = (a[row * n + k] ?? 0) - factor * (a[col * n + k] ?? 0);
      b[row] = (b[row] ?? 0) - factor * (b[col] ?? 0);
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row] ?? 0;
    for (let k = row + 1; k < n; k += 1) sum -= (a[row * n + k] ?? 0) * (x[k] ?? 0);
    x[row] = sum / (a[row * n + row] ?? 1);
  }
  return x;
}

/** Jacobian rank via deterministic row-echelon (for diagnostics). */
function jacobianRank(rows: Residual[], v: Float64Array, n: number): number {
  const m = rows.length;
  const J: number[][] = rows.map((row) => {
    const dense = new Array<number>(n).fill(0);
    for (const [idx, g] of row.grad(v)) dense[idx] = (dense[idx] ?? 0) + g;
    return dense;
  });
  let rank = 0;
  let col = 0;
  const used = new Array<boolean>(m).fill(false);
  while (col < n && rank < m) {
    let pivot = -1;
    let best = 1e-9;
    for (let r = 0; r < m; r += 1) {
      if (used[r]) continue;
      const mag = Math.abs(J[r]![col] ?? 0);
      if (mag > best) { best = mag; pivot = r; }
    }
    if (pivot >= 0) {
      used[pivot] = true;
      rank += 1;
      const prow = J[pivot]!;
      const pv = prow[col]!;
      for (let r = 0; r < m; r += 1) {
        if (used[r] || r === pivot) continue;
        const factor = (J[r]![col] ?? 0) / pv;
        if (factor === 0) continue;
        for (let k = col; k < n; k += 1) J[r]![k] = (J[r]![k] ?? 0) - factor * (prow[k] ?? 0);
      }
    }
    col += 1;
  }
  return rank;
}

/**
 * Solve the sketch. Deterministic Gauss-Newton (see module header). Throws
 * `SketchError('no_converge')` on degenerate input; over-constraint is
 * DIAGNOSED (conflicting constraint indices) rather than silently averaged
 * when the residual cannot reach tolerance.
 */
export function solveSketch(sk: Sketch): SolveResult {
  validateSketch(sk);
  const n = sk.points.length * 2;
  const v = new Float64Array(n);
  sk.points.forEach((p, i) => { v[i * 2] = p.x; v[i * 2 + 1] = p.y; });
  const rows = compile(sk);
  if (rows.length === 0) {
    return {
      points: sk.points.map((p) => ({ x: r9(p.x), y: r9(p.y) })),
      iterations: 0,
      residual: 0,
      diagnostics: { status: 'under-constrained', freeDof: n },
    };
  }

  let iterations = 0;
  let residual = Infinity;
  // GRADE-PASS CAD-G2: a max-size non-converging sketch would burn seconds of
  // synchronous O(n³)-per-iteration CPU. Budget iterations by system size —
  // FIXED thresholds, so determinism holds (same sketch ⇒ same cap).
  const iterationCap = rows.length * n > 20_000 ? 25 : SOLVER_MAX_ITERATIONS;
  for (; iterations < iterationCap; iterations += 1) {
    const r = rows.map((row) => row.f(v));
    residual = Math.sqrt(r.reduce((acc, x) => acc + x * x, 0));
    if (residual < SOLVER_TOLERANCE) break;
    // Build JᵀJ + Jᵀr (dense — sketches are small by the caps).
    const ata = new Float64Array(n * n);
    const atb = new Float64Array(n);
    rows.forEach((row, ri) => {
      const g = row.grad(v);
      for (const [i1, gi] of g) {
        atb[i1] = (atb[i1] ?? 0) - gi * (r[ri] ?? 0);
        for (const [i2, gj] of g) ata[i1 * n + i2] = (ata[i1 * n + i2] ?? 0) + gi * gj;
      }
    });
    const step = solveNormal(ata, atb, n);
    if (!step) break;
    let stepNorm = 0;
    for (let i = 0; i < n; i += 1) { v[i] = (v[i] ?? 0) + (step[i] ?? 0); stepNorm += (step[i] ?? 0) ** 2; }
    if (Math.sqrt(stepNorm) < SOLVER_TOLERANCE) { iterations += 1; break; }
  }

  const finalR = rows.map((row) => row.f(v));
  residual = Math.sqrt(finalR.reduce((acc, x) => acc + x * x, 0));
  const rank = jacobianRank(rows, v, n);

  // Grade-pass (CAD-C9): a NaN residual fails BOTH comparisons below — it must
  // be a typed failure, never a silent NaN "solution".
  if (!Number.isFinite(residual)) {
    throw new SketchError('no_converge', 'Solver produced a non-finite residual — the sketch is numerically degenerate.');
  }

  if (residual > 1e-6) {
    // Could not satisfy everything — identify the worst offenders (over/conflict).
    const worst = finalR
      .map((val, i) => ({ ci: rows[i]!.ci, mag: Math.abs(val) }))
      .filter((x) => x.mag > 1e-6)
      .sort((a, b) => b.mag - a.mag || a.ci - b.ci);
    const conflicting = [...new Set(worst.map((w) => w.ci))].slice(0, 5);
    if (rows.length > rank) {
      return {
        points: sk.points.map((p) => ({ x: r9(p.x), y: r9(p.y) })), // original — never a half-solved lie
        iterations,
        residual: r9(residual),
        diagnostics: { status: 'over-constrained', conflicting },
      };
    }
    throw new SketchError('no_converge', `The sketch did not converge (residual ${residual.toExponential(2)}).`, { conflicting });
  }

  const status = rank < n ? 'under-constrained' : 'well-constrained';
  return {
    points: Array.from({ length: sk.points.length }, (_, i) => ({ x: r9(px(v, i)), y: r9(py(v, i)) })),
    iterations,
    residual: r9(residual),
    diagnostics: { status, ...(status === 'under-constrained' ? { freeDof: n - rank } : {}) },
  };
}
