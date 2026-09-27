/**
 * ADR 0540 D5/P1 — eligibility, headed by the never-skip list.
 *
 * An over-eager skip filter is INVISIBLE: a job never applied to produces no
 * rejection, no signal, and no way for the user to find out the filter was
 * wrong. A false skip therefore costs more than a false apply, and these tests
 * encode that asymmetry.
 *
 * The never-skip cases are the point of the file. Each is a rule someone will
 * eventually be tempted to add ("why are we applying to onsite roles in another
 * city?"), and each test fails the moment they do.
 */
import { describe, expect, it } from 'vitest';
import { checkEligibility, ELIGIBILITY_RULES } from '../src/features/job-search/domain/eligibility.js';
import type { ApplicantConstraints } from '../src/features/job-search/domain/eligibility.js';
import { projectFitScores, JOB_FIT_CRITERIA } from '../src/features/job-search/domain/fitScoring.js';
import { computePriority } from '../src/host/weightedScoring.js';
import type { JobDigest } from '../src/features/job-search/domain/digest.js';

const digest = (over: Partial<JobDigest> = {}): JobDigest => ({
  dealId: 'deal:1', tenantId: 'user:t', version: 1,
  title: 'Staff Backend Engineer', companyName: 'Acme', location: 'Austin, TX', remote: false,
  skills: ['typescript', 'postgres'], requirements: [], responsibilities: [],
  descriptionExcerpt: '', employmentType: 'w2', sponsorship: 'silent',
  citizenshipRequirementQuote: null, clearanceRequirementQuote: null, sponsorshipQuote: null,
  salaryMin: null, salaryMax: null, currency: null, sourceUrl: null, capturedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** An applicant who fails everything they could fail — so any test that comes
 *  back eligible proves the RULE declined to fire, not that the applicant was
 *  simply unblockable. */
const worstCase: ApplicantConstraints = {
  requiresSponsorship: true,
  meetsCitizenshipRequirement: false,
  holdsRequiredClearance: false,
};

describe('ADR 0540 D5 — the never-skip list', () => {
  it.each([
    ['onsite in another city', digest({ remote: false, location: 'Fargo, ND' })],
    ['a thin JD', digest({ skills: [], requirements: [], responsibilities: [], descriptionExcerpt: '' })],
    ['1099 / contract', digest({ employmentType: '1099' })],
    ['a contract role', digest({ employmentType: 'contract' })],
    ['defence/federal work with NO stated bar', digest({ companyName: 'Federal Defense Systems', descriptionExcerpt: 'Supporting DoD programs.' })],
    ['over-qualified (a junior title)', digest({ title: 'Junior Developer' })],
    ['a JD SILENT on sponsorship', digest({ sponsorship: 'silent', sponsorshipQuote: null })],
  ])('%s is NOT a skip — even for an applicant who clears nothing', (_label, d) => {
    const v = checkEligibility(d, worstCase);
    expect(v.eligible, `${_label} must not disqualify — see ADR 0540 D5`).toBe(true);
    expect(v.ruleId).toBeNull();
  });

  it('the disqualifying rule set is PINNED — a new skip cannot arrive silently', () => {
    // A rule added here makes the agent stop applying to a class of jobs. That is
    // a product decision, and it must fail this test until someone changes the
    // list deliberately.
    expect(ELIGIBILITY_RULES.map((r) => r.id).sort()).toEqual([
      'stated-citizenship-bar',
      'stated-clearance-bar',
      'stated-no-sponsorship',
    ]);
  });
});

describe('ADR 0540 D5 — only a STATED bar the applicant cannot clear disqualifies', () => {
  it('no-sponsorship stated + applicant needs sponsorship ⇒ skip, quoting the posting', () => {
    const quote = 'We are unable to sponsor or take over sponsorship of an employment visa at this time.';
    const v = checkEligibility(digest({ sponsorship: 'not-offered', sponsorshipQuote: quote }), worstCase);
    expect(v.eligible).toBe(false);
    expect(v.ruleId).toBe('stated-no-sponsorship');
    // The quote is what makes the skip falsifiable: the user can check it
    // against the posting. A paraphrase cannot be checked.
    expect(v.quote).toBe(quote);
  });

  it('no-sponsorship stated but applicant does NOT need it ⇒ apply', () => {
    const v = checkEligibility(
      digest({ sponsorship: 'not-offered', sponsorshipQuote: 'No sponsorship available.' }),
      { ...worstCase, requiresSponsorship: false },
    );
    expect(v.eligible).toBe(true);
  });

  it('a citizenship bar disqualifies only when stated', () => {
    const stated = digest({ citizenshipRequirementQuote: 'Must be a U.S. citizen.' });
    expect(checkEligibility(stated, worstCase).ruleId).toBe('stated-citizenship-bar');
    // Same applicant, bar never stated ⇒ eligible. This is the pair that proves
    // the rule keys on the POSTING, not on a guess about the employer.
    expect(checkEligibility(digest(), worstCase).eligible).toBe(true);
  });

  it('a clearance bar disqualifies only when stated, and only if unmet', () => {
    const stated = digest({ clearanceRequirementQuote: 'Active TS/SCI clearance required.' });
    expect(checkEligibility(stated, worstCase).ruleId).toBe('stated-clearance-bar');
    expect(checkEligibility(stated, { ...worstCase, holdsRequiredClearance: true }).eligible).toBe(true);
  });
});

describe('ADR 0540 D5 — fit scoring composes the shared engine', () => {
  const profile = { skills: ['TypeScript', 'Postgres'], targetTitles: ['Backend Engineer'], salaryFloor: 150_000, wantsRemote: true };

  it('NEVER projects 0 — missing data is neutral, not worst', () => {
    // `computePriority` treats 0 as UNSCORED and sinks the item. Unstated salary
    // is the COMMON case on most boards, so a 0 here would invert the ranking
    // over the majority of the feed.
    const sparse = projectFitScores(digest({ skills: [], salaryMin: null, salaryMax: null, remote: null }), profile);
    for (const [k, v] of Object.entries(sparse)) {
      expect(v, `${k} projected ${v} — 0 reads as UNSCORED, not "low"`).toBeGreaterThanOrEqual(1);
    }
    // …and specifically NEUTRAL, so a transparent employer is not ranked below
    // an opaque one purely for stating a salary.
    expect(sparse['salary-fit']).toBe(5);
    expect(sparse['skill-overlap']).toBe(5);
  });

  it('ranks a strong match above a weak one through the shared engine', () => {
    const strong = computePriority(JOB_FIT_CRITERIA, projectFitScores(
      digest({ skills: ['typescript', 'postgres'], title: 'Backend Engineer', salaryMax: 200_000, remote: true }), profile));
    const weak = computePriority(JOB_FIT_CRITERIA, projectFitScores(
      digest({ skills: ['cobol', 'fortran'], title: 'Warehouse Associate', salaryMax: 60_000, remote: false }), profile));
    expect(strong).toBeGreaterThan(weak);
  });

  it('scores the TOP of a salary range — a range is what is negotiable', () => {
    const wide = projectFitScores(digest({ salaryMin: 120_000, salaryMax: 180_000 }), profile);
    const low = projectFitScores(digest({ salaryMin: 90_000, salaryMax: 100_000 }), profile);
    expect(wide['salary-fit']!).toBeGreaterThan(low['salary-fit']!);
  });
});
