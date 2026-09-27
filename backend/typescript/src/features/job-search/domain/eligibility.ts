/**
 * ADR 0540 D5 — eligibility is a named, tested list, and what is NOT a skip
 * matters more than what is.
 *
 * The sharpest operational insight in the prior art: an over-eager skip filter
 * is invisible. A job that was never applied to produces no rejection, no
 * signal, and no way for the user to discover the filter was wrong — so a
 * false skip costs more than a false apply, and the asymmetry is deliberate.
 *
 * ## The never-skip list (encoded as the ABSENCE of a rule, enforced by tests)
 *
 *   - onsite / a different city        - a thin JD
 *   - 1099 / contract                  - defence or federal work with no stated bar
 *   - being over-qualified             - a JD SILENT on sponsorship
 *
 * None of these appears below, and `job-search-eligibility.test.ts` asserts each
 * one still returns eligible. That is the only structure that makes a
 * never-skip list real: a comment saying "we don't skip contract roles" is a
 * claim; a test that fails when someone adds the rule is a guarantee.
 *
 * ## What DOES disqualify
 *
 * Only a JD-STATED bar the applicant cannot clear. Every rule below therefore
 * needs two things to fire: the posting must state the bar, and the applicant
 * must fail it. A bar the posting never stated cannot disqualify, however
 * likely it seems.
 *
 * Pure: no I/O, no clock, no randomness (ADR 0540 P1).
 */
import type { JobDigest } from './digest.js';

/** What the applicant can clear. Deliberately minimal — every field here exists
 *  because a rule below reads it, so an unused constraint cannot creep in. */
export interface ApplicantConstraints {
  /** Does this applicant need the employer to sponsor a visa? */
  requiresSponsorship: boolean;
  /** Can the applicant satisfy a stated citizenship requirement? */
  meetsCitizenshipRequirement: boolean;
  /** Does the applicant hold (or can they obtain) a stated clearance? */
  holdsRequiredClearance: boolean;
}

export type EligibilityRuleId =
  | 'stated-no-sponsorship'
  | 'stated-citizenship-bar'
  | 'stated-clearance-bar';

export interface EligibilityVerdict {
  eligible: boolean;
  /** The rule that disqualified, or null when eligible. */
  ruleId: EligibilityRuleId | null;
  /** Human-readable reason. Empty when eligible. */
  reason: string;
  /** The posting's own words. D5 requires the reason to QUOTE the JD rather
   *  than paraphrase it — a paraphrase is where a skip becomes unfalsifiable,
   *  because the user cannot check it against the posting. */
  quote: string | null;
}

const ELIGIBLE: EligibilityVerdict = { eligible: true, ruleId: null, reason: '', quote: null };

interface Rule {
  id: EligibilityRuleId;
  /** Fires only when the JD STATES the bar AND the applicant cannot clear it. */
  disqualifies: (d: JobDigest, a: ApplicantConstraints) => boolean;
  /** The verbatim JD text backing the decision. */
  quoteOf: (d: JobDigest) => string | null;
  reason: string;
}

/**
 * The COMPLETE disqualifying set. Adding a rule here is a product decision that
 * makes the agent skip work; the test file pins this list by id so a new one
 * cannot arrive silently.
 */
export const ELIGIBILITY_RULES: readonly Rule[] = [
  {
    id: 'stated-no-sponsorship',
    // `silent` must NOT reach here — that is the never-skip case, and the
    // explicit `=== 'not-offered'` is what keeps silence from being a rejection.
    disqualifies: (d, a) => a.requiresSponsorship && d.sponsorship === 'not-offered',
    quoteOf: (d) => d.sponsorshipQuote,
    reason: 'The posting states it does not sponsor work visas, and this applicant requires sponsorship.',
  },
  {
    id: 'stated-citizenship-bar',
    disqualifies: (d, a) => d.citizenshipRequirementQuote !== null && !a.meetsCitizenshipRequirement,
    quoteOf: (d) => d.citizenshipRequirementQuote,
    reason: 'The posting states a citizenship requirement this applicant does not meet.',
  },
  {
    id: 'stated-clearance-bar',
    disqualifies: (d, a) => d.clearanceRequirementQuote !== null && !a.holdsRequiredClearance,
    quoteOf: (d) => d.clearanceRequirementQuote,
    reason: 'The posting states a security-clearance requirement this applicant does not hold.',
  },
];

/**
 * Decide whether to apply. Returns eligible unless a stated bar fires.
 *
 * Note the default: eligible. A digest this function does not understand — a
 * thin JD, an unparsed field, a new employment type — falls through to eligible
 * rather than being filtered out, which is the D5 asymmetry expressed in
 * control flow rather than in prose.
 */
export function checkEligibility(digest: JobDigest, applicant: ApplicantConstraints): EligibilityVerdict {
  for (const rule of ELIGIBILITY_RULES) {
    if (!rule.disqualifies(digest, applicant)) continue;
    return { eligible: false, ruleId: rule.id, reason: rule.reason, quote: rule.quoteOf(digest) };
  }
  return ELIGIBLE;
}
