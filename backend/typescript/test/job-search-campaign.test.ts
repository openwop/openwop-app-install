/**
 * ADR 0545 P4 — the campaign keeps going, and says what it did.
 *
 * The phase's verification is two properties: an unanswerable question parks ONE
 * item and the campaign continues, and skips are reported rather than silent.
 * Both are asserted against the real pipeline — a mocked loop would prove the
 * test's arithmetic, not the product's behaviour.
 *
 * Tracker TST-DHA-2 (wave 71). Red when: a parked item ends the loop
 * (`w71g3-ca-continue`); parking keys on raw text instead of the bank's
 * normalised key (`ca-parkkey`); a refused item lands in no bucket
 * (`ca-complete`) or in the wrong one; a below-floor or thrown skip loses its
 * reason (`ca-floordetail`, `ca-errdetail`); the claim CAS stops deduping a
 * re-run (`ca-rerun`); subject erasure stops filtering by subject
 * (`ca-erase-r2`, the second subject's chore must survive).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCampaign, listParked, digestIsComplete, eraseSubjectParked, type CampaignItem } from '../src/features/job-search/autopilot/campaign.js';
import { recordAnswer } from '../src/features/job-search/autopilot/answerBank.js';
import type { PipelineInput, PreparedSubmission } from '../src/features/job-search/autopilot/pipeline.js';
import { createApplyGrant } from '../src/host/applyGrant.js';
import { subjectDealTag } from '../src/features/job-search/domain/applications.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const T = 'user:t-camp';
const ORG = 'org-1';
const ME = 'user:me';
const CAMPAIGN = 'camp-1';

const digestFor = (id: string): PipelineInput['digest'] => ({
  dealId: `deal:${id}`, tenantId: T, version: 1,
  title: 'Staff Backend Engineer', companyName: `Co-${id}`,
  location: 'Austin, TX', remote: true,
  skills: ['go', 'typescript'], requirements: [], responsibilities: [],
  descriptionExcerpt: 'Build services.', employmentType: 'w2',
  sponsorship: 'silent', citizenshipRequirementQuote: null, clearanceRequirementQuote: null,
  sponsorshipQuote: null, salaryMin: 170_000, salaryMax: 210_000, currency: 'USD',
  sourceUrl: `https://boards.greenhouse.io/${id}`, capturedAt: new Date().toISOString(),
});

const PROFILE: PipelineInput['profile'] = { skills: ['go', 'typescript'], targetTitles: ['Backend Engineer'], salaryFloor: 150_000, wantsRemote: true };
const APPLICANT: PipelineInput['applicant'] = { requiresSponsorship: false, meetsCitizenshipRequirement: true, holdsRequiredClearance: true };

const SALARY_Q = { text: 'What are your salary expectations?', required: true };

const item = (id: string, over: Partial<PipelineInput> = {}): CampaignItem => ({
  listingId: id,
  input: {
    tenantId: T, orgId: ORG, subjectId: ME,
    digest: digestFor(id), profile: PROFILE, applicant: APPLICANT,
    questions: [SALARY_Q], minMatchScore: 0, campaignId: CAMPAIGN,
    origin: 'boards.greenhouse.io', isReplay: false, now: Date.now(),
    ...over,
  },
});

const seedGrant = (maxSubmits = 10) => createApplyGrant({
  tenantId: T, orgId: ORG, subjectId: ME, grantedBy: ME, campaignId: CAMPAIGN,
  maxSubmits, maxPrepared: 5, ratePerHour: 100, origins: ['boards.greenhouse.io'],
  resumePolicy: 'default', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

const answerSalary = () => recordAnswer({
  tenantId: T, subjectId: ME, questionText: 'What are your salary expectations?',
  value: '$180,000', source: 'user', confirmed: true, now: Date.now(),
});

beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

describe('ADR 0545 D3 — one unanswerable question parks ONE item', () => {
  it('the campaign continues past a parked listing', async () => {
    // The prior art's defect, stated as a test: a novel question stops the loop.
    // Here listing-2 asks something unanswerable and 1 and 3 still go out.
    await seedGrant();
    await answerSalary();
    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));

    const digest = await runCampaign([
      item('listing-1'),
      item('listing-2', { questions: [{ text: 'How many years of Kubernetes do you have?', required: true }] }),
      item('listing-3'),
    ], submit, Date.now());

    expect(digest.applied, 'the campaign must not stop at the parked item').toHaveLength(2);
    expect(digest.parked).toHaveLength(1);
    expect(digest.parked[0]!.listingId).toBe('listing-2');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('the SAME question blocking six applications is ONE thing to ask', async () => {
    // Recording per-application is how "3 questions, ~40 seconds" turns back
    // into eighteen interruptions.
    await seedGrant();
    const q = { text: 'How many years of Kubernetes do you have?', required: true };
    const digest = await runCampaign(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => item(id, { questions: [q] })),
      async () => ({ ok: true }),
      Date.now(),
    );

    expect(digest.parked).toHaveLength(6);
    const parked = await listParked(T, ME);
    expect(parked, 'six blocked applications, ONE question').toHaveLength(1);
    expect(parked[0]!.blockedListings.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('two PHRASINGS of one question are still one chore', async () => {
    await seedGrant();
    const digest = await runCampaign([
      item('a', { questions: [{ text: 'What are your salary expectations?', required: true }] }),
      item('b', { questions: [{ text: 'Desired compensation', required: true }] }),
    ], async () => ({ ok: true }), Date.now());

    expect(digest.parked).toHaveLength(2);
    expect(await listParked(T, ME), 'the bank normalises; so must the backlog').toHaveLength(1);
  });

  it('a novel question is recorded as ONE parked chore and the pass returns', async () => {
    // What this asserts is the RECORD, not "never awaits": `runCampaign` takes no
    // callback through which it could ask, so the no-await property is structural
    // and has no runtime witness here. Overlaps "the SAME question blocking six
    // applications is ONE thing to ask" (dedupe row TST-DHA-2b, kept: protected file).
    await seedGrant();
    const started = Date.now();
    await runCampaign([item('a', { questions: [{ text: 'Novel question?', required: true }] })], async () => ({ ok: true }), started);
    expect(await listParked(T, ME)).toHaveLength(1);
  });
});

describe('ADR 0545 D6 — every listing is accounted for', () => {
  it('accounts for every listing it was given', async () => {
    await seedGrant(1);
    await answerSalary();
    const digest = await runCampaign([
      item('applied-1'),
      item('exhausted-1'),
      item('parked-1', { questions: [{ text: 'Novel question?', required: true }] }),
      item('ineligible-1', {
        digest: { ...digestFor('ineligible-1'), sponsorship: 'not-offered', sponsorshipQuote: 'No visa sponsorship.' },
        applicant: { ...APPLICANT, requiresSponsorship: true },
      }),
      item('below-floor-1', { minMatchScore: 99 }),
    ], async () => ({ ok: true }), Date.now());

    expect(digest.considered).toBe(5);
    expect(digestIsComplete(digest), 'a listing that lands in no bucket is a silent skip').toBe(true);
    // …and each lands in the RIGHT bucket: a count that balances can still be wrong.
    // ADR 1036 D3 — the deal id is per PERSON: `deal:<subjectTag>:<listingId>`.
    expect(digest.applied).toEqual([`deal:${subjectDealTag(ME)}:applied-1`]);
    expect(digest.alreadyApplied).toBe(0);
    expect(digest.parked.map((p) => p.listingId)).toEqual(['parked-1']);
    expect(Object.fromEntries(digest.skipped.map((s) => [s.listingId, s.reason]))).toEqual({
      'exhausted-1': 'refused',
      'ineligible-1': 'ineligible',
      'below-floor-1': 'below-floor',
    });
    expect(digest.skipped.find((s) => s.listingId === 'exhausted-1')?.detail).toBe('exhausted');
  });

  it('a skip carries its REASON, never a bare count', async () => {
    await seedGrant();
    await answerSalary();
    const digest = await runCampaign([
      item('x', { minMatchScore: 99 }),
      item('y', {
        digest: { ...digestFor('y'), sponsorship: 'not-offered', sponsorshipQuote: 'We cannot sponsor visas for this role.' },
        applicant: { ...APPLICANT, requiresSponsorship: true },
      }),
    ], async () => ({ ok: true }), Date.now());

    const byReason = Object.fromEntries(digest.skipped.map((s) => [s.reason, s.detail]));
    expect(byReason['below-floor']).toMatch(/scored .*floor/);
    // The disqualification cites the posting rather than paraphrasing it.
    expect(byReason['ineligible']).toContain('cannot sponsor visas');
  });

  it('distinguishes “not allowed to apply” from “chose not to”', async () => {
    // Two different facts about someone's job search; one number for both would
    // tell them their filters are wrong when the employer excluded them.
    await seedGrant();
    await answerSalary();
    const digest = await runCampaign([
      item('a', { minMatchScore: 99 }),
      item('b', {
        digest: { ...digestFor('b'), sponsorship: 'not-offered', sponsorshipQuote: 'No sponsorship.' },
        applicant: { ...APPLICANT, requiresSponsorship: true },
      }),
    ], async () => ({ ok: true }), Date.now());

    expect(new Set(digest.skipped.map((s) => s.reason))).toEqual(new Set(['below-floor', 'ineligible']));
  });

  it('a THROWN adapter error skips one employer and is reported', async () => {
    // The failure nobody predicted. D6: a campaign degrades, never halts.
    await seedGrant();
    await answerSalary();
    let n = 0;
    const digest = await runCampaign(
      [item('a'), item('b'), item('c')],
      async () => { n += 1; if (n === 2) throw new Error('adapter exploded'); return { ok: true }; },
      Date.now(),
    );

    expect(digest.applied).toHaveLength(2);
    expect(digest.skipped).toHaveLength(1);
    expect(digest.skipped[0]!.reason).toBe('error');
    expect(digest.skipped[0]!.detail, 'swallowing the message makes the skip unexplainable').toContain('adapter exploded');
    expect(digestIsComplete(digest)).toBe(true);
  });

  it('a re-run of the same campaign applies to nothing twice', async () => {
    await seedGrant();
    await answerSalary();
    const items = [item('a'), item('b')];
    const submit = vi.fn(async (_p: PreparedSubmission) => ({ ok: true }));

    const first = await runCampaign(items, submit, Date.now());
    const second = await runCampaign(items, submit, Date.now());

    expect(first.applied).toHaveLength(2);
    expect(second.applied, 'a re-run must be a no-op').toHaveLength(0);
    expect(second.alreadyApplied).toBe(2);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe('ADR 0464 — the parked backlog is erasable', () => {
  it('deletes the subject’s parked questions', async () => {
    await seedGrant();
    const OTHER = 'user:other';
    await runCampaign([
      item('a', { questions: [{ text: 'Novel question?', required: true }] }),
      // A second subject's chore in the same tenant: it must SURVIVE the erasure
      // (without it an erase-everything sabotage stays green).
      item('b', { subjectId: OTHER, questions: [{ text: 'Novel question?', required: true }] }),
    ], async () => ({ ok: true }), Date.now());
    expect(await listParked(T, ME)).toHaveLength(1);
    expect(await listParked(T, OTHER)).toHaveLength(1);
    await eraseSubjectParked(T, ME);
    expect(await listParked(T, ME)).toHaveLength(0);
    expect(await listParked(T, OTHER), 'another subject’s chore is not theirs to erase').toHaveLength(1);
  });
});
