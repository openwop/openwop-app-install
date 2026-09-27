/**
 * Profile completeness (ADR 0005; ADR 0624 D4) — the ONE weights table, read by
 * `computeCompleteness` (the 0..100 meter) and `completenessMissing` (the
 * "what next" list the `/me` lane serves as `completenessMissing[]`). Weights
 * sum to 100 and are a product judgment (ADR 0005 open question — tune with
 * real usage). Derived on every read so the number can never drift from the row.
 *
 * `completenessMissing` is SELF-ONLY on the wire (`viewOwnProfile`): it is
 * guidance for the owner, and "Alice lacks a bio" is not a thing the `/team`
 * directory, `GET /:userId` or the workflow surface should carry. A chain that
 * needs the number reads `host.profiles.completeness.crossed`'s `to`.
 */
import type { Profile } from './profilesService.js';

export interface CompletenessWeight {
  /** The profile field (or field group) the weight rewards. */
  field: string;
  weight: number;
  /** Whether the profile satisfies this weight. */
  has: (p: Profile) => boolean;
}

/** The ONLY weights table. Order is the display order for ties; `completenessMissing` sorts by weight desc. */
export const COMPLETENESS_WEIGHTS: readonly CompletenessWeight[] = [
  { field: 'avatar', weight: 15, has: (p) => Boolean(p.avatarAssetToken) },
  { field: 'bio', weight: 15, has: (p) => Boolean(p.bio) },
  { field: 'skills', weight: 15, has: (p) => (p.skills?.length ?? 0) > 0 },
  { field: 'jobTitle', weight: 10, has: (p) => Boolean(p.jobTitle) },
  { field: 'department', weight: 10, has: (p) => Boolean(p.department) },
  { field: 'availability', weight: 10, has: (p) => Boolean(p.availability && (p.availability.status || p.availability.timezone || p.availability.hoursPerWeek !== undefined)) },
  { field: 'interests', weight: 10, has: (p) => (p.interests?.length ?? 0) > 0 },
  { field: 'portfolio', weight: 10, has: (p) => (p.portfolioAssetTokens?.length ?? 0) > 0 },
  { field: 'equipment', weight: 5, has: (p) => (p.equipment?.length ?? 0) > 0 },
];

/** Weighted completeness (sums to 100). */
export function computeCompleteness(p: Profile): number {
  let score = 0;
  for (const w of COMPLETENESS_WEIGHTS) if (w.has(p)) score += w.weight;
  return score;
}

/** The weights NOT yet earned, heaviest first (ties keep table order). */
export function completenessMissing(p: Profile): Array<{ field: string; weight: number }> {
  return COMPLETENESS_WEIGHTS.filter((w) => !w.has(p))
    .map((w) => ({ field: w.field, weight: w.weight }))
    .sort((a, b) => b.weight - a.weight);
}
