/**
 * ADR 0540 D5 — fit scoring composes `host/weightedScoring.ts`. No second
 * scoring engine.
 *
 * This module contributes exactly what `work-selection` contributes (ADR 0534
 * D1): a criteria set (what matters, and how much) and a projector (how a
 * digest's fields map onto the engine's 1..10 band). The ranking arithmetic
 * stays in the shared engine, so a change to how priority is aggregated lands
 * for every consumer at once.
 *
 * ## The 0-means-unscored trap (inherited, and it bites harder here)
 *
 * `computePriority` treats a criterion scored 0 as UNSCORED and drags the item
 * to the bottom. Every projection below therefore returns >= 1: "this posting
 * does not state a salary" must read as *weak evidence*, never as *no data*.
 * Getting this wrong would sink every posting with an unstated salary below
 * every posting that states one — and unstated salary is the common case on
 * most boards, so the ranking would inverse itself on the majority of the feed.
 *
 * Pure: no I/O, no clock, no randomness (ADR 0540 P1).
 */
import type { CriteriaSet } from '../../../host/weightedScoring.js';
import type { JobDigest } from './digest.js';

/** What the applicant is looking for. Compared against the digest to score fit. */
export interface FitProfile {
  /** Skills the applicant actually has, lowercased on the way in by `normalise`. */
  skills: string[];
  /** Titles/roles the applicant is targeting. */
  targetTitles: string[];
  /** Minimum acceptable salary, in the same units as the digest. Null ⇒ no floor. */
  salaryFloor: number | null;
  /** Does the applicant want remote? Null ⇒ no preference. */
  wantsRemote: boolean | null;
}

/**
 * The criteria set. Weights are relative importance on the engine's 1..10 scale.
 *
 * Skill overlap dominates deliberately: it is the only signal here that
 * correlates with actually getting an interview, and the others are preference
 * filters. Salary is weighted BELOW skills because a posting that fits the
 * applicant's skills but pays slightly under is still worth an application,
 * whereas the reverse rarely is.
 */
export const JOB_FIT_CRITERIA: CriteriaSet = {
  aggregation: 'weighted-sum',
  criteria: [
    {
      id: 'skill-overlap',
      name: 'Skill overlap',
      description: 'How much of the posting’s required skill set the applicant already has.',
      weight: 10,
      direction: 'benefit',
      scaleHint: '10 = every listed skill matches; 1 = almost none',
    },
    {
      id: 'title-match',
      name: 'Title match',
      description: 'How close the posting’s title is to what the applicant is targeting.',
      weight: 7,
      direction: 'benefit',
      scaleHint: '10 = a targeted title; 1 = unrelated',
    },
    {
      id: 'salary-fit',
      name: 'Salary fit',
      description: 'Whether the stated range clears the applicant’s floor.',
      weight: 5,
      direction: 'benefit',
      scaleHint: '10 = comfortably above the floor; 1 = well below. Unstated = 5 (unknown, not bad)',
    },
    {
      id: 'location-fit',
      name: 'Location fit',
      description: 'Remote/onsite against the applicant’s preference.',
      weight: 4,
      direction: 'benefit',
      scaleHint: '10 = matches the preference; 1 = contradicts it',
    },
  ],
};

const clamp1to10 = (n: number): number => (n < 1 ? 1 : n > 10 ? 10 : Math.round(n));
const normalise = (s: string): string => s.trim().toLowerCase();

/** Band an overlap ratio (0..1) into 1..10, never 0 (see the header). */
const bandRatio = (ratio: number): number => clamp1to10(1 + ratio * 9);

/**
 * Project one digest onto the criteria above.
 *
 * Every branch returns >= 1. The `?? 5` defaults are the load-bearing part:
 * MISSING data scores NEUTRAL, not worst. A posting that omits salary is not a
 * bad posting, and treating absence as a negative would systematically rank
 * transparent employers below opaque ones — the opposite of what the user wants.
 */
export function projectFitScores(digest: JobDigest, profile: FitProfile): Record<string, number> {
  const have = new Set(profile.skills.map(normalise));
  const want = digest.skills.map(normalise).filter((s) => s.length > 0);
  // No listed skills is UNKNOWN (neutral), not zero overlap — a thin JD must not
  // be pushed to the bottom of the ranking (the D5 never-skip spirit, applied to
  // ordering rather than filtering).
  const skillOverlap = want.length === 0
    ? 5
    : bandRatio(want.filter((s) => have.has(s)).length / want.length);

  const title = normalise(digest.title);
  const titleMatch = profile.targetTitles.length === 0
    ? 5
    : profile.targetTitles.some((t) => {
        const n = normalise(t);
        return n.length > 0 && (title.includes(n) || n.includes(title));
      })
      ? 10
      : 3; // unrelated, but NOT 1 — a title mismatch is weak evidence, not a veto

  let salaryFit = 5; // unstated range, or no floor: unknown
  if (profile.salaryFloor !== null) {
    // Compare against the TOP of the range: a posting listing 120k–180k against a
    // 150k floor is worth applying to, because the range is what is negotiable.
    const top = digest.salaryMax ?? digest.salaryMin;
    if (top !== null && top !== undefined && profile.salaryFloor > 0) {
      salaryFit = clamp1to10(1 + (top / profile.salaryFloor) * 5);
    }
  }

  let locationFit = 5; // no preference, or the posting does not say
  if (profile.wantsRemote !== null && digest.remote !== null) {
    locationFit = digest.remote === profile.wantsRemote ? 10 : 3;
  }

  return {
    'skill-overlap': skillOverlap,
    'title-match': titleMatch,
    'salary-fit': salaryFit,
    'location-fit': locationFit,
  };
}
