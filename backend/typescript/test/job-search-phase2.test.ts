/**
 * Job-search phase-2 batch (CODEBASE/UX-ASSESSMENT closures):
 *
 *  - JS-LIFE-2 — funnel semantics ride stage POSITION via the stable
 *    `toStageId`, so renaming every stage in CRM changes NOTHING in the
 *    report (the old name matching silently counted renamed stages as
 *    `silent`). Both polarities: the renamed pipeline reports identically,
 *    and an unknown stageId still contributes nothing.
 *  - JS-LANE-1 — `candidateGrantIds` hoists ONLY the discovery scan: consult
 *    re-reads rows fresh (a revocation AFTER prefetch is still seen), and a
 *    wrong-subject id cannot cross subjects.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildFunnelReport } from '../src/features/job-search/lifecycle/funnel.js';
import { createApplication, advanceApplication, ensureApplicationPipeline, APPLICATION_PIPELINE_NAME } from '../src/features/job-search/domain/applications.js';
import { listPipelines, updatePipeline } from '../src/features/crm/crmEntitiesService.js';
import { createApplyGrant, consultApplyGrant, revokeApplyGrant, claimSubmission, releaseSubmission } from '../src/host/applyGrant.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const T = 'user:t-p2';
const ORG = 'org-1';

const digest = (id: string) => ({
  title: 'Staff Backend Engineer', companyName: `Co-${id}`,
  location: 'Austin, TX', remote: true,
  skills: ['go'], requirements: [], responsibilities: [],
  descriptionExcerpt: 'x', employmentType: 'w2' as const,
  sponsorship: 'silent' as const, citizenshipRequirementQuote: null,
  clearanceRequirementQuote: null, sponsorshipQuote: null,
  salaryMin: 170_000, salaryMax: 210_000, currency: 'USD',
  sourceUrl: `https://boards.greenhouse.io/${id}`, capturedAt: new Date().toISOString(),
});
const PROFILE = { skills: ['go'], targetTitles: ['Backend Engineer'], salaryFloor: 150_000, wantsRemote: true };
const APPLICANT = { requiresSponsorship: false, meetsCitizenshipRequirement: true, holdsRequiredClearance: true };

async function apply(id: string) {
  const r = await createApplication({
    tenantId: T, orgId: ORG, actor: 'user:me', dealId: `deal:${id}`,
    digest: digest(id), profile: PROFILE, applicant: APPLICANT, board: 'greenhouse',
  });
  if (!r.deal) throw new Error('fixture failed: application was ineligible');
}

beforeEach(async () => {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(':memory:'));
  await ensureApplicationPipeline(T, ORG);
});

describe('JS-LIFE-2 — stage position, not stage name', () => {
  it('renaming EVERY stage changes nothing in the report', async () => {
    await apply('a');
    await advanceApplication(T, ORG, 'deal:a', 'Screening', 'user:me');
    await apply('b'); // stays at applied

    const before = await buildFunnelReport(T, ORG);
    expect(before.reachedStage.screening).toBe(1);
    expect(before.responseRate.numerator).toBe(1);

    // Rename all four stages to vocabulary the old matcher cannot recognise.
    const pipeline = (await listPipelines(T, ORG)).find((p) => p.name === APPLICATION_PIPELINE_NAME)!;
    await updatePipeline(T, ORG, pipeline.pipelineId, {
      stages: pipeline.stages.map((s, i) => ({ stageId: s.stageId, name: `Custom ${i}`, probability: s.probability })),
    });

    const after = await buildFunnelReport(T, ORG);
    // Position-keyed: identical numbers. Under name matching this deal became
    // `silent` and screening dropped to 0.
    expect(after.reachedStage.screening).toBe(1);
    expect(after.responseRate.numerator).toBe(1);
    expect(after.silent).toBe(before.silent);
  });

  it('a stage BEYOND the funnel vocabulary is a RESPONSE but never an offer (grade-trio finding 4)', async () => {
    // The earlier cap-at-offer scored an appended "Rejected" stage as an
    // OFFER and rolled both conversions to 100%.
    const pipeline = (await listPipelines(T, ORG)).find((p) => p.name === APPLICATION_PIPELINE_NAME)!;
    await updatePipeline(T, ORG, pipeline.pipelineId, {
      stages: [...pipeline.stages.map((s) => ({ stageId: s.stageId, name: s.name, probability: s.probability })),
        { name: 'Rejected', probability: 95 }],
    });
    const withRejected = (await listPipelines(T, ORG)).find((p) => p.name === APPLICATION_PIPELINE_NAME)!;
    const rejected = withRejected.stages[4]!;
    await apply('c');
    await advanceApplication(T, ORG, 'deal:c', rejected.name, 'user:me');
    const report = await buildFunnelReport(T, ORG);
    expect(report.reachedStage.offer).toBe(0);          // a rejection is NOT an offer
    expect(report.reachedStage.applied).toBe(1);        // still counted as an application
    expect(report.responseRate.numerator).toBe(1);      // and IS an employer response
  });

  it('a genuinely ABSENT pipeline reports pipelineFound: false — never a healthy empty funnel (finding 9)', async () => {
    // The rename simulation this test used to run is now survived BY DESIGN
    // (the ID binding — pinned in job-search-residuals.test.ts). Only a
    // tenant with no application pipeline at all reports not-found.
    const report = await buildFunnelReport('user:t-no-pipeline', 'org-none');
    expect(report.pipelineFound).toBe(false);
    const healthy = await buildFunnelReport(T, ORG); // beforeEach ensured T's
    expect(healthy.pipelineFound).toBe(true);
  });
});

describe('JS-LANE-1 — the hoisted discovery scan reads rows FRESH', () => {
  const grantInput = (subjectId: string) => ({
    tenantId: T, orgId: ORG, subjectId, grantedBy: 'user-auth',
    campaignId: 'camp-1', maxSubmits: 5, maxPrepared: 5, ratePerHour: 4,
    origins: ['boards.example.com'], resumePolicy: 'default' as const,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const consult = (subjectId: string, ids?: readonly string[]) => consultApplyGrant({
    tenantId: T, subjectId, campaignId: 'camp-1', commitClass: 'submit' as const,
    tier: 'A' as const, origin: 'boards.example.com', isReplay: false, now: Date.now(),
    ...(ids ? { candidateGrantIds: ids } : {}),
  });

  it('prefetched ids behave like the scan — and a revocation AFTER prefetch is still seen', async () => {
    const g = await createApplyGrant(grantInput('subj-1'));
    const ids = [g.grantId];
    expect((await consult('subj-1', ids)).allowed).toBe(true);
    await revokeApplyGrant(T, ORG, g.grantId, Date.now());
    // The ids are stale; the ROWS are not — consult re-reads at decision time.
    const after = await consult('subj-1', ids);
    expect(after.allowed).toBe(false);
    expect(after.refusal).toBe('revoked');
  });

  it('a wrong-subject id cannot cross subjects (re-filtered after the read)', async () => {
    const theirs = await createApplyGrant(grantInput('subj-2'));
    const mine = await consult('subj-1', [theirs.grantId]);
    expect(mine.allowed).toBe(false);
    expect(mine.refusal).toBe('no-grant');
  });
});

const mkGrant = (subjectId: string) => ({
  tenantId: T, orgId: ORG, subjectId, grantedBy: 'user-auth',
  campaignId: 'camp-1', maxSubmits: 5, maxPrepared: 5, ratePerHour: 4,
  origins: ['boards.example.com'], resumePolicy: 'default' as const,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

describe('grade-trio finding 1 — a claim never released is a job never retried', () => {
  it('releaseSubmission frees a claim so a later pass can retry; a wrong grantId cannot free it', async () => {
    const g = await createApplyGrant({
      tenantId: T, orgId: ORG, subjectId: 'subj-1', grantedBy: 'user-auth',
      campaignId: 'camp-1', maxSubmits: 5, maxPrepared: 5, ratePerHour: 4,
      origins: ['boards.example.com'], resumePolicy: 'default',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(await claimSubmission(T, 'subj-1', 'listing:x', g.grantId)).toBe(true);
    expect(await claimSubmission(T, 'subj-1', 'listing:x', g.grantId)).toBe(false); // held
    expect(await releaseSubmission(T, 'subj-1', 'listing:x', 'grant:not-mine')).toBe(false); // guarded
    expect(await claimSubmission(T, 'subj-1', 'listing:x', g.grantId)).toBe(false); // STILL held
    expect(await releaseSubmission(T, 'subj-1', 'listing:x', g.grantId)).toBe(true);
    expect(await claimSubmission(T, 'subj-1', 'listing:x', g.grantId)).toBe(true); // retryable again
  });
});

describe('grade-trio finding 2 — the discovery memo is per (tenant, subject, campaign) TRIPLE', () => {
  it('a mixed-subject batch finds EACH subject\'s grants (the items[0] hoist refused the second subject)', async () => {
    const gA = await createApplyGrant(mkGrant('subj-A'));
    const gB = await createApplyGrant(mkGrant('subj-B'));
    // Simulate what runCampaign's memo hands each item: per-triple ids.
    const a = await consultApplyGrant({
      tenantId: T, subjectId: 'subj-A', campaignId: 'camp-1', commitClass: 'submit',
      tier: 'A', origin: 'boards.example.com', isReplay: false, now: Date.now(),
      candidateGrantIds: [gA.grantId],
    });
    const b = await consultApplyGrant({
      tenantId: T, subjectId: 'subj-B', campaignId: 'camp-1', commitClass: 'submit',
      tier: 'A', origin: 'boards.example.com', isReplay: false, now: Date.now(),
      candidateGrantIds: [gB.grantId],
    });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});
