/**
 * ADR 0545 P3 — Tier-A submission end to end.
 *
 * The phase's verification is idempotency: "a retry, re-dispatch and fork each
 * produce exactly one application". Those are three different mechanisms and
 * they are asserted separately, because a test that only proved "one deal
 * exists" could pass while a replay had already burned a submit unit — and the
 * burnt unit is the half that reaches an employer.
 *
 * The board call is injected, so every assertion below is about the REAL
 * ordering rather than a mocked pipeline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyToListing, prepareAnswers, type PipelineInput, type PreparedSubmission,
} from '../src/features/job-search/autopilot/pipeline.js';
import { recordAnswer } from '../src/features/job-search/autopilot/answerBank.js';
import { createApplyGrant, applyGrants } from '../src/host/applyGrant.js';
import { listChain } from '../src/host/auditChainService.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const T = 'user:t-pipe';
const ORG = 'org-1';
const ME = 'user:me';
const CAMPAIGN = 'camp-pipe';

// REAL shapes, read from the modules rather than guessed. The first version of
// this file hand-cast plausible-looking fixtures (`needsSponsorship`,
// `descriptionText`, `titles`) and every test failed as `ineligible` — a fixture
// that does not typecheck against the domain is testing a different program.
const DIGEST: PipelineInput['digest'] = {
  dealId: 'deal:listing-1', tenantId: T, version: 1,
  title: 'Staff Backend Engineer', companyName: 'Northwind',
  location: 'Austin, TX', remote: true,
  skills: ['go', 'typescript'], requirements: [], responsibilities: [],
  descriptionExcerpt: 'Build services in Go and TypeScript.',
  employmentType: 'w2',
  sponsorship: 'silent',
  citizenshipRequirementQuote: null,
  clearanceRequirementQuote: null,
  sponsorshipQuote: null,
  salaryMin: 170_000, salaryMax: 210_000, currency: 'USD',
  sourceUrl: 'https://boards.greenhouse.io/northwind/jobs/1',
  capturedAt: new Date().toISOString(),
};

const PROFILE: PipelineInput['profile'] = {
  skills: ['go', 'typescript'], targetTitles: ['Backend Engineer'],
  salaryFloor: 150_000, wantsRemote: true,
};

/** Clears every disqualifying rule — none of them fires on a silent posting. */
const APPLICANT: PipelineInput['applicant'] = {
  requiresSponsorship: false, meetsCitizenshipRequirement: true, holdsRequiredClearance: true,
};

const QUESTIONS = [
  { text: 'What are your salary expectations?', required: true },
  { text: 'Are you legally authorized to work in the United States?', required: true },
  { text: 'Voluntary Self-Identification of Disability', required: true },
  { text: 'Link to your portfolio', required: false },
];

async function seedAnswers() {
  await recordAnswer({ tenantId: T, subjectId: ME, questionText: 'What are your salary expectations?', value: '$180,000', source: 'user', confirmed: true, now: Date.now() });
  await recordAnswer({ tenantId: T, subjectId: ME, questionText: 'Are you legally authorized to work in the United States?', value: 'Yes', source: 'user', confirmed: true, now: Date.now() });
}

async function seedGrant(maxSubmits = 10) {
  return createApplyGrant({
    tenantId: T, orgId: ORG, subjectId: ME, grantedBy: ME, campaignId: CAMPAIGN,
    maxSubmits, maxPrepared: 5, ratePerHour: 100, origins: ['boards.greenhouse.io'],
    resumePolicy: 'default', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

const input = (over: Partial<PipelineInput> = {}): PipelineInput => ({
  tenantId: T, orgId: ORG, subjectId: ME, listingId: 'listing-1',
  digest: DIGEST, profile: PROFILE, applicant: APPLICANT,
  questions: QUESTIONS, minMatchScore: 0, campaignId: CAMPAIGN,
  origin: 'boards.greenhouse.io', isReplay: false, now: Date.now(),
  ...over,
});

beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

describe('ADR 0545 P3 — the happy path', () => {
  it('applies once, answering from the bank', async () => {
    await seedAnswers();
    await seedGrant();
    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));
    const out = await applyToListing(input(), submit);

    expect(out.kind).toBe('applied');
    expect(submit).toHaveBeenCalledTimes(1);
    // The optional unanswered question is SKIPPED, the special category is
    // ANSWERED by declining, and neither parks the application.
    const prepared = submit.mock.calls[0]![0];
    expect(prepared.answers['Voluntary Self-Identification of Disability']).toBe('Decline to self-identify');
    expect(prepared.answers['Link to your portfolio']).toBeUndefined();
  });

  it('spends exactly one submit unit, and only after a successful send', async () => {
    await seedAnswers();
    const g = await seedGrant();
    await applyToListing(input(), async () => ({ ok: true }));
    expect((await applyGrants.get(`${T}:${g.grantId}`))!.submitsUsed).toBe(1);
  });

  it('records the audit row the attestation reads', async () => {
    await seedAnswers();
    await seedGrant();
    await applyToListing(input(), async () => ({ ok: true }));
    const chain = await listChain(T);
    const consumed = chain.filter((e) => e.kind === 'job-search.grant.consumed');
    expect(consumed).toHaveLength(1);
    expect((consumed[0]!.payload as { dealId?: string }).dealId).toBeTruthy();
  });
});

describe('grade-trio finding 1 — a rejected send is RETRYABLE, never silently already-applied', () => {
  it('a board rejection releases the claim; the next pass applies for real', async () => {
    await seedAnswers();
    const g = await seedGrant();
    const failing = vi.fn(async (_p: PreparedSubmission) => ({ ok: false }));
    const first = await applyToListing(input(), failing);
    expect(first.kind).toBe('refused');

    // Under the pre-fix code the held claim made this 'already-applied' —
    // the applicant was permanently, silently never applied to this job.
    const succeeding = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));
    const second = await applyToListing(input(), succeeding);
    expect(second.kind, 'a never-sent listing must stay retryable').toBe('applied');
    expect((await applyGrants.get(`${T}:${g.grantId}`))!.submitsUsed).toBe(1); // only the real send spent
  });
});

describe('ADR 0545 P3 — idempotency, three mechanisms', () => {
  it('a RETRY of the same listing produces exactly one application', async () => {
    await seedAnswers();
    const g = await seedGrant();
    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));

    const first = await applyToListing(input(), submit);
    const second = await applyToListing(input(), submit);

    expect(first.kind).toBe('applied');
    expect(second.kind, 'the retry must be a no-op, not a second application').toBe('already-applied');
    expect(submit, 'the board must be called once').toHaveBeenCalledTimes(1);
    expect((await applyGrants.get(`${T}:${g.grantId}`))!.submitsUsed).toBe(1);
  });

  it('CONCURRENT re-dispatch resolves to exactly one winner', async () => {
    // The TOCTOU a retry storm produces. A read-then-write claim passes the
    // sequential test above and fails this one.
    await seedAnswers();
    const g = await seedGrant();
    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));

    const results = await Promise.all([
      applyToListing(input(), submit),
      applyToListing(input(), submit),
      applyToListing(input(), submit),
    ]);

    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'already-applied')).toHaveLength(2);
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await applyGrants.get(`${T}:${g.grantId}`))!.submitsUsed).toBe(1);
  });

  it('a FORK never submits and never spends budget', async () => {
    await seedAnswers();
    const g = await seedGrant();
    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));

    const out = await applyToListing(input({ isReplay: true }), submit);

    expect(out.kind).toBe('refused');
    expect(submit, 'a replay must not reach the board').not.toHaveBeenCalled();
    // The part a claim-only defence would miss: the unit must be UNSPENT.
    expect((await applyGrants.get(`${T}:${g.grantId}`))!.submitsUsed).toBe(0);
    // …and no claim was taken either, so the real run can still apply.
    const real = await applyToListing(input(), submit);
    expect(real.kind, 'a replay must not lock out the genuine attempt').toBe('applied');
  });
});

describe('ADR 0545 D3/D6 — refusals are decisions with evidence', () => {
  it('parks ONE application for an unanswerable REQUIRED question', async () => {
    // Nothing seeded: the two required questions cannot be answered.
    await seedGrant();
    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));
    const out = await applyToListing(input(), submit);

    expect(out.kind).toBe('parked');
    expect(submit).not.toHaveBeenCalled();
    if (out.kind === 'parked') {
      expect(out.gaps.map((g) => g.question)).toContain('What are your salary expectations?');
      // The special category is never a gap — it is answered by declining.
      expect(out.gaps.map((g) => g.question)).not.toContain('Voluntary Self-Identification of Disability');
    }
  });

  it('a parked application spends NO budget', async () => {
    // Parking is common by design; a campaign that burned a unit each time would
    // exhaust its ceiling without sending anything.
    const g = await seedGrant();
    await applyToListing(input(), async () => ({ ok: true }));
    expect((await applyGrants.get(`${T}:${g.grantId}`))!.submitsUsed).toBe(0);
  });

  it('an unconfirmed inference parks rather than being sent', async () => {
    // The OQ-2 guarantee, observed end to end rather than at the store.
    await seedGrant();
    await recordAnswer({ tenantId: T, subjectId: ME, questionText: 'Are you legally authorized to work in the United States?', value: 'Yes', source: 'user', confirmed: true, now: Date.now() });
    await recordAnswer({ tenantId: T, subjectId: ME, questionText: 'What are your salary expectations?', value: '$180,000', source: 'inferred', confirmed: false, now: Date.now() });

    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));
    const out = await applyToListing(input(), submit);
    expect(out.kind).toBe('parked');
    if (out.kind === 'parked') expect(out.gaps[0]!.reason).toBe('unconfirmed');
    expect(submit, 'a guess about someone must never reach an employer').not.toHaveBeenCalled();
  });

  it('an INELIGIBLE listing quotes the text that disqualified it', async () => {
    await seedAnswers();
    await seedGrant();
    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));
    const out = await applyToListing(input({
      // The rule fires only when the JD STATES the bar AND the applicant cannot
      // clear it — `silent` must never disqualify, which is why this sets both.
      digest: { ...DIGEST, sponsorship: 'not-offered', sponsorshipQuote: 'We are unable to provide visa sponsorship for this role.' },
      applicant: { ...APPLICANT, requiresSponsorship: true },
    }), submit);

    expect(out.kind).toBe('ineligible');
    if (out.kind === 'ineligible') expect(out.quote.length, 'a decision must carry its evidence').toBeGreaterThan(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it('an EXHAUSTED grant refuses without calling the board', async () => {
    await seedAnswers();
    await seedGrant(1);
    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));
    await applyToListing(input({ listingId: 'listing-1' }), submit);
    const out = await applyToListing(input({ listingId: 'listing-2' }), submit);
    expect(out.kind).toBe('refused');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('a board rejection does NOT spend a submit unit', async () => {
    await seedAnswers();
    const g = await seedGrant();
    const out = await applyToListing(input(), async () => ({ ok: false }));
    expect(out.kind).toBe('refused');
    expect((await applyGrants.get(`${T}:${g.grantId}`))!.submitsUsed, 'the ledger records units actually spent').toBe(0);
  });
});

describe('prepareAnswers', () => {
  it('skips optional misses and declines special categories', async () => {
    await seedAnswers();
    const p = await prepareAnswers(T, ME, 'l', QUESTIONS);
    expect(p.gaps).toHaveLength(0);
    expect(Object.keys(p.answers)).toHaveLength(3);
  });
});
