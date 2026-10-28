/**
 * ADR 0956 D2 — rule-based multi-touch attribution models. PURE (no I/O, no
 * clock): the same path always yields the same credits.
 *
 * Credit is integer arithmetic end to end. Each model produces INTEGER weights,
 * and `allocate` splits an integer total by them with BigInt, flooring every
 * share and giving the remainder to the LAST touch (ADR 0956 D2). So the credits
 * of one path always sum exactly to its total. Float weights would not: a share
 * computed a hair above an integer floors up, and the remainder goes negative.
 *
 * These models run beside last-click, never instead of it, and their credit is
 * never added to platform-reported conversions.
 */

export const ATTRIBUTION_MODELS = ['last_click', 'first_touch', 'linear', 'time_decay', 'position_based'] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export function isAttributionModel(v: unknown): v is AttributionModel {
  return typeof v === 'string' && (ATTRIBUTION_MODELS as readonly string[]).includes(v);
}

/** One conversion counts as this many credit units, so a path of three touches
 *  splits a conversion into exact integers (333_334 + 333_333 + 333_333). */
export const CONVERSION_UNITS = 1_000_000;

const DAY_MS = 86_400_000;
/** time_decay weights are scaled to integers at this resolution. */
const DECAY_SCALE = 1_000_000;

/**
 * Split `total` (a non-negative integer) by integer `weights`. Every share is
 * floored; the remainder goes to the last touch. Returns integers summing
 * exactly to `total`. All-zero weights put everything on the last touch.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('allocate: total must be a non-negative safe integer');
  if (weights.length === 0) return [];
  if (!weights.every((w) => Number.isSafeInteger(w) && w >= 0)) throw new RangeError('allocate: weights must be non-negative safe integers');
  const sum = weights.reduce((s, w) => s + BigInt(w), 0n);
  const out = weights.map(() => 0);
  if (sum === 0n) {
    out[out.length - 1] = total;
    return out;
  }
  const t = BigInt(total);
  let given = 0n;
  for (let i = 0; i < weights.length; i++) {
    const share = (t * BigInt(weights[i]!)) / sum; // BigInt division floors
    out[i] = Number(share);
    given += share;
  }
  out[out.length - 1]! += Number(t - given);
  return out;
}

export interface ModelOptions {
  /** time_decay half-life in days (> 0). */
  halfLifeDays: number;
}

/**
 * Integer weights for a path's touches under a model. `touchTimes` and
 * `conversionAt` are epoch milliseconds; touches are in time order.
 */
export function modelWeights(model: AttributionModel, touchTimes: readonly number[], conversionAt: number, opts: ModelOptions): number[] {
  const n = touchTimes.length;
  if (n === 0) return [];
  switch (model) {
    case 'last_click':
      return touchTimes.map((_, i) => (i === n - 1 ? 1 : 0));
    case 'first_touch':
      return touchTimes.map((_, i) => (i === 0 ? 1 : 0));
    case 'linear':
      return touchTimes.map(() => 1);
    case 'time_decay': {
      const halfLifeMs = Math.max(opts.halfLifeDays, Number.EPSILON) * DAY_MS;
      // At least 1, so a very old touch keeps a non-zero (if tiny) share.
      return touchTimes.map((t) => Math.max(1, Math.round(DECAY_SCALE * 2 ** (-Math.max(0, conversionAt - t) / halfLifeMs))));
    }
    case 'position_based': {
      // 40/20/40: first and last 40% each, the middle touches share 20%.
      if (n === 1) return [1];
      if (n === 2) return [1, 1];
      const middle = n - 2;
      // Integer weights with the 40:20:40 ratio: ends get 2·middle, each middle touch gets 1.
      return touchTimes.map((_, i) => (i === 0 || i === n - 1 ? 2 * middle : 1));
    }
  }
}

/** Credit one path: per-touch integer credits summing exactly to `total`. */
export function creditPath(model: AttributionModel, touchTimes: readonly number[], conversionAt: number, total: number, opts: ModelOptions): number[] {
  return allocate(total, modelWeights(model, touchTimes, conversionAt, opts));
}
