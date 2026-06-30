/**
 * Priority-matrix quadrant placement (ADR 0058/0059 follow-on). Derives the two
 * axes of the classic 2×2 GENERICALLY from each criterion's `direction`:
 *   - Y axis "Impact / Value"  = weighted mean of the BENEFIT criteria scores
 *   - X axis "Effort / Cost"   = weighted mean of the COST criteria scores
 * So value-effort, RICE, and WSJF (all of which carry a cost criterion) all
 * render a matrix; ICE / all-benefit custom sets have no effort axis and fall
 * back to Grid/List (`matrixSupported` is false). No preset special-casing.
 */

import type { Criterion, CriteriaSet, RankedIdea } from './priorityMatrixClient.js';

export type QuadrantId = 'quick-wins' | 'big-bets' | 'fill-ins' | 'reconsider';

// Criterion scores are entered on a 1..10 scale (the score inputs), so 5.5 is
// the absolute midpoint — quadrant membership is meaningful, not just relative.
const SCALE_MID = 5.5;

/** Weighted mean of an idea's scores over `criteria`; null when the idea has no
 *  score on ANY of them (that axis is undefined for it → unscored). */
function axisValue(idea: RankedIdea, criteria: readonly Criterion[]): number | null {
  let weighted = 0;
  let weight = 0;
  for (const c of criteria) {
    const s = idea.scores[c.id];
    if (typeof s === 'number') {
      weighted += c.weight * s;
      weight += c.weight;
    }
  }
  return weight > 0 ? weighted / weight : null;
}

export interface QuadrantAxes { benefit: Criterion[]; cost: Criterion[] }

export function quadrantAxes(set: CriteriaSet): QuadrantAxes {
  return {
    benefit: set.criteria.filter((c) => c.direction === 'benefit'),
    cost: set.criteria.filter((c) => c.direction === 'cost'),
  };
}

/** A 2×2 needs a value (benefit) axis AND an effort (cost) axis. */
export function matrixSupported(set: CriteriaSet): boolean {
  const a = quadrantAxes(set);
  return a.benefit.length > 0 && a.cost.length > 0;
}

export interface MatrixPlacement {
  quadrants: Record<QuadrantId, RankedIdea[]>;
  /** Ideas missing a score on either axis — shown in a tray, not placed. */
  unscored: RankedIdea[];
}

export function placeIdeas(ideas: readonly RankedIdea[], set: CriteriaSet): MatrixPlacement {
  const { benefit, cost } = quadrantAxes(set);
  const quadrants: Record<QuadrantId, RankedIdea[]> = { 'quick-wins': [], 'big-bets': [], 'fill-ins': [], reconsider: [] };
  const unscored: RankedIdea[] = [];
  for (const idea of ideas) {
    const value = axisValue(idea, benefit);
    const effort = axisValue(idea, cost);
    if (value === null || effort === null) { unscored.push(idea); continue; }
    const hiValue = value >= SCALE_MID;
    const hiEffort = effort >= SCALE_MID;
    const q: QuadrantId = hiValue
      ? (hiEffort ? 'big-bets' : 'quick-wins')
      : (hiEffort ? 'reconsider' : 'fill-ins');
    quadrants[q].push(idea);
  }
  for (const k of Object.keys(quadrants) as QuadrantId[]) quadrants[k].sort((a, b) => a.rank - b.rank);
  return { quadrants, unscored };
}

/** Render order — top row = high value, left column = low effort. */
export const QUADRANT_ORDER: readonly QuadrantId[] = ['quick-wins', 'big-bets', 'fill-ins', 'reconsider'];
