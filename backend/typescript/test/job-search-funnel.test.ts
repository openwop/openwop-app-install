/**
 * ADR 0546 D4/P1 — the scoreboard.
 *
 * P1's verification is two things: the numbers reconcile against the underlying
 * stage history, and a variant with zero responses is reported as ZERO rather
 * than hidden. The second is the integrity of the whole surface — a dashboard
 * that drops empty rows tells the user their approach works, because the
 * failures are precisely the rows that disappeared.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFunnelReport } from '../src/features/job-search/lifecycle/funnel.js';
import { createApplication, advanceApplication, ensureApplicationPipeline } from '../src/features/job-search/domain/applications.js';
import type { Deal } from '../src/features/crm/entities/deals.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const T = 'user:t-funnel';
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

async function apply(id: string, board = 'greenhouse') {
  const r = await createApplication({
    tenantId: T, orgId: ORG, actor: 'user:me', dealId: `deal:${id}`,
    digest: digest(id), profile: PROFILE, applicant: APPLICANT, board,
  });
  if (!r.deal) throw new Error('fixture failed: application was ineligible');
  return r.deal;
}

const advance = (id: string, stage: string) => advanceApplication(T, ORG, `deal:${id}`, stage, 'user:me');

beforeEach(async () => {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(':memory:'));
  await ensureApplicationPipeline(T, ORG);
});

describe('ADR 0546 P1 — the numbers reconcile', () => {
  it('counts each application at the furthest stage it reached', async () => {
    await apply('a'); await apply('b'); await apply('c'); await apply('d');
    await advance('b', 'Screening');
    await advance('c', 'Screening');
    await advance('c', 'Interviewing');

    const r = await buildFunnelReport(T, ORG);
    expect(r.reachedStage.applied, 'a and d never moved').toBe(2);
    expect(r.reachedStage.screening).toBe(1);
    expect(r.reachedStage.interviewing).toBe(1);
    expect(r.responseRate).toMatchObject({ numerator: 2, denominator: 4 });
    expect(r.responseRate.rate).toBeCloseTo(0.5);
  });

  it('every application lands in exactly one bucket', async () => {
    await apply('a'); await apply('b'); await apply('c');
    await advance('c', 'Screening');
    const r = await buildFunnelReport(T, ORG);
    const total = Object.values(r.reachedStage).reduce((n, x) => n + x, 0);
    expect(total, 'a stage bucket that loses an application is a silent number').toBe(3);
    expect(r.silent + r.responseRate.numerator).toBe(3);
  });

  it('conversion denominators are “reached at least”, not “sitting in”', async () => {
    // A fast mover who went applied→screening→interviewing must not read as a
    // LOSS from screening simply because they are no longer sitting there.
    await apply('a'); await apply('b');
    await advance('a', 'Screening');
    await advance('a', 'Interviewing');

    const r = await buildFunnelReport(T, ORG);
    const appliedToScreening = r.conversions.find((c) => c.from === 'applied')!;
    expect(appliedToScreening.rate).toMatchObject({ numerator: 1, denominator: 2 });
    const screeningToInterviewing = r.conversions.find((c) => c.from === 'screening')!;
    expect(screeningToInterviewing.rate, 'the mover still counts in screening’s denominator')
      .toMatchObject({ numerator: 1, denominator: 1 });
  });
});

describe('ADR 0546 P1 — zero is reported as zero, never hidden', () => {
  it('a source with NO responses still appears, with its denominator', async () => {
    // The most useful row on the page: a board that never replies.
    await apply('a', 'greenhouse');
    await apply('b', 'silent-board');
    await apply('c', 'silent-board');
    await advance('a', 'Screening');

    const r = await buildFunnelReport(T, ORG);
    const silent = r.bySource.find((s) => s.source === 'silent-board');
    expect(silent, 'a board with zero responses must not vanish from the report').toBeTruthy();
    expect(silent!.rate).toMatchObject({ numerator: 0, denominator: 2, rate: 0 });
  });

  it('distinguishes “nobody replied” from “you have not applied”', async () => {
    // The distinction the whole `Rate` shape exists for. Reporting 0% for both
    // would tell someone with no applications that their approach is failing.
    const empty = await buildFunnelReport(T, ORG);
    expect(empty.responseRate.rate, 'no applications ⇒ no rate to state').toBeNull();
    expect(empty.responseRate.denominator).toBe(0);

    await apply('a');
    const applied = await buildFunnelReport(T, ORG);
    expect(applied.responseRate.rate, 'applied with no reply ⇒ genuinely zero').toBe(0);
  });

  it('reports BOTH warm and cold arms even when one is empty', async () => {
    // An absent arm is how "we have no warm data yet" silently becomes "warm
    // does not help" — and warm-vs-cold is the dominant variable in the ADR.
    await apply('a'); await apply('b');
    const r = await buildFunnelReport(T, ORG, () => false);
    expect(r.warmVsCold.warm, 'the arm must be present with a zero denominator')
      .toMatchObject({ numerator: 0, denominator: 0, rate: null });
    expect(r.warmVsCold.cold.denominator).toBe(2);
  });

  it('attributes warm and cold separately when both exist', async () => {
    await apply('warm-1'); await apply('cold-1'); await apply('cold-2');
    await advance('warm-1', 'Screening');
    const isWarm = (d: Deal): boolean => d.dealId.includes('warm');

    const r = await buildFunnelReport(T, ORG, isWarm);
    expect(r.warmVsCold.warm).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(r.warmVsCold.cold).toMatchObject({ numerator: 0, denominator: 2, rate: 0 });
  });

  it('median time-to-first-response is null with no responses, not zero', async () => {
    await apply('a');
    const r = await buildFunnelReport(T, ORG);
    expect(r.medianHoursToFirstResponse, 'zero hours would claim an instant reply').toBeNull();
  });

  it('measures time to the FIRST employer action', async () => {
    await apply('a');
    await advance('a', 'Screening');
    await advance('a', 'Interviewing');
    const r = await buildFunnelReport(T, ORG);
    expect(r.medianHoursToFirstResponse).not.toBeNull();
    expect(r.medianHoursToFirstResponse!).toBeGreaterThanOrEqual(0);
  });
});


describe('ADR 0546 P1 — the report does not scan per deal', () => {
  it('reads stage history ONCE, not once per application', () => {
    // A STRUCTURAL pin, and honest about its limits: it proves the per-deal
    // reader is not imported, not that the report is fast. It exists because
    // the behavioural tests passed identically before and after the fix —
    // correctness tests cannot see a scaling defect.
    //
    // The defect it guards: `getStageHistory` scans the tenant's ENTIRE stage
    // history and filters, so calling it per deal cost 200 applications ×
    // 600 rows = 120,000 row visits on a page a user refreshes.
    const src = readFileSync(join(process.cwd(), 'src', 'features', 'job-search', 'lifecycle', 'funnel.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code.length).toBeGreaterThan(1000);
    expect(code, 'the per-deal reader scans the whole tenant').not.toMatch(/\bgetStageHistory\s*\(/);
    expect(code).toMatch(/listStageHistoryForPipeline\s*\(/);
  });
});
