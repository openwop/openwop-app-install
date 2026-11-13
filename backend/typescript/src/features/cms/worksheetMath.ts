/**
 * ADR 1105 D7 — the worksheets' fixed arithmetic. Pure and deterministic.
 *
 * The frontend renderer recomputes as the reader types, and the prerender shows
 * the worked answer for the authored figures, so the same functions live on both
 * halves: this file and `frontend/react/src/features/cms/worksheetMath.ts`.
 * `test/adr1105-worksheets.test.ts` runs both over one case table, so the copies
 * cannot drift.
 *
 * A missing input gives a missing result, never a guess: the caller shows
 * "No figure".
 */

export interface MarginInput { cost?: number | undefined; markup?: number | undefined; target?: number | undefined }
export interface MarginResult {
  /** cost × (1 + markup / 100). */
  price?: number;
  /** Gross margin on price, in percent: (price − cost) / price × 100. */
  margin?: number;
  /** The markup, in percent, that gives the target margin: target / (100 − target) × 100. */
  markupForTarget?: number;
}

const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function computeMargin({ cost, markup, target }: MarginInput): MarginResult {
  const price = finite(cost) && finite(markup) ? cost * (1 + markup / 100) : undefined;
  const margin = finite(cost) && finite(price) && price > 0 ? ((price - cost) / price) * 100 : undefined;
  const markupForTarget = finite(target) && target >= 0 && target < 100 ? (target / (100 - target)) * 100 : undefined;
  return {
    ...(price !== undefined ? { price } : {}),
    ...(margin !== undefined ? { margin } : {}),
    ...(markupForTarget !== undefined ? { markupForTarget } : {}),
  };
}

export interface GapLine { name: string; allowance?: number | undefined; specified?: number | undefined }
export interface GapRow extends GapLine {
  /** specified − allowance when above zero, 0 when within; absent when a figure is missing. */
  over?: number;
}
export interface GapResult {
  rows: GapRow[];
  /** The sum of the overruns only: a line under its allowance is never netted against one over. */
  totalOver: number;
  linesOver: number;
  /** Lines left out of the total because a figure is missing. */
  linesMissing: number;
}

export function computeGaps(lines: readonly GapLine[]): GapResult {
  let totalOver = 0;
  let linesOver = 0;
  let linesMissing = 0;
  const rows = lines.map((l): GapRow => {
    if (!finite(l.allowance) || !finite(l.specified)) {
      linesMissing += 1;
      return { ...l };
    }
    const over = Math.max(0, l.specified - l.allowance);
    if (over > 0) { totalOver += over; linesOver += 1; }
    return { ...l, over };
  });
  return { rows, totalOver, linesOver, linesMissing };
}
