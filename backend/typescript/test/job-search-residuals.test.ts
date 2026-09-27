/**
 * Grade-trio residual closures (goal round 2, phase A):
 *
 *  - `toStagePosition` — history rows snapshot the stage's position at WRITE
 *    time, so inserting/reordering stages no longer re-scores past moves
 *    (both polarities: the snapshot wins after an insert; the funnel still
 *    reads legacy rows via the current-index fallback).
 *  - Pipeline BINDING — the vertical resolves its pipeline by ID: a rename
 *    no longer unbinds it (flips the old pin, deliberately); a genuinely
 *    absent pipeline still reports pipelineFound:false.
 *  - Orphan sweep — reference-absence re-prunes rows whose deal is gone
 *    (the cascade's crash backstop); grace-window and live-deal polarities.
 *  - campaign-day age-out — old counters purge under confidential-pii with
 *    a true cutoff; fresh rows and wrong-classification sweeps are no-ops.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildFunnelReport } from '../src/features/job-search/lifecycle/funnel.js';
import { createApplication, advanceApplication, ensureApplicationPipeline, resolveApplicationPipeline, APPLICATION_PIPELINE_NAME } from '../src/features/job-search/domain/applications.js';
import { listPipelines, updatePipeline, getStageHistory } from '../src/features/crm/crmEntitiesService.js';
import { sweepOrphanedJobSearchRows } from '../src/features/job-search/lifecycle/crmCascade.js';
import { followUps } from '../src/features/job-search/lifecycle/followUps.js';
import { jobDigests, type JobDigest } from '../src/features/job-search/domain/digest.js';
import { consumeDaySlot } from '../src/features/job-search/autopilot/campaignRun.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const T = 'user:t-resid';
const ORG = 'org-1';
const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * 86_400_000).toISOString();

const digest = (id: string) => ({
  title: 'Staff Backend Engineer', companyName: `Co-${id}`,
  location: 'Austin, TX', remote: true,
  skills: ['go'], requirements: [], responsibilities: [],
  descriptionExcerpt: 'x', employmentType: 'w2' as const,
  sponsorship: 'silent' as const, citizenshipRequirementQuote: null,
  clearanceRequirementQuote: null, sponsorshipQuote: null,
  salaryMin: 170_000, salaryMax: 210_000, currency: 'USD',
  sourceUrl: `https://boards.greenhouse.io/${id}`, capturedAt: NOW,
});
const PROFILE = { skills: ['go'], targetTitles: ['Backend Engineer'], salaryFloor: 150_000, wantsRemote: true };
const APPLICANT = { requiresSponsorship: false, meetsCitizenshipRequirement: true, holdsRequiredClearance: true };

async function apply(id: string) {
  const r = await createApplication({
    tenantId: T, orgId: ORG, actor: 'user:me', dealId: `deal:${id}`,
    digest: digest(id), profile: PROFILE, applicant: APPLICANT, board: 'greenhouse',
  });
  if (!r.deal) throw new Error('fixture failed: ineligible');
}

beforeEach(async () => {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(':memory:'));
  await ensureApplicationPipeline(T, ORG);
});

describe('toStagePosition — the write-time snapshot', () => {
  it('new history rows carry the snapshot, and an INSERTED stage no longer re-scores past moves', async () => {
    await apply('snap');
    await advanceApplication(T, ORG, 'deal:snap', 'Screening', 'user:me');
    const history = await getStageHistory(T, ORG, 'deal:snap');
    expect(history.every((h) => typeof h.toStagePosition === 'number')).toBe(true);
    const screeningRow = history.find((h) => h.toStagePosition === 1);
    expect(screeningRow).toBeTruthy();

    const before = await buildFunnelReport(T, ORG);
    expect(before.reachedStage.screening).toBe(1);

    // Insert "Phone screen" between Applied and Screening — Screening's
    // CURRENT index becomes 2 (interviewing). The snapshot must win.
    const pipeline = (await listPipelines(T, ORG)).find((p) => p.name === APPLICATION_PIPELINE_NAME)!;
    const [applied, ...rest] = pipeline.stages.map((s) => ({ stageId: s.stageId, name: s.name, probability: s.probability }));
    await updatePipeline(T, ORG, pipeline.pipelineId, {
      stages: [applied!, { name: 'Phone screen', probability: 20 }, ...rest],
    });

    const after = await buildFunnelReport(T, ORG);
    expect(after.reachedStage.screening).toBe(1);   // snapshot: still screening
    expect(after.reachedStage.interviewing).toBe(0); // NOT re-scored by today's index
  });
});

describe('pipeline binding — resolved by ID', () => {
  it('a RENAME no longer unbinds the vertical (flips the old pin, deliberately)', async () => {
    await apply('bind');
    const pipeline = (await listPipelines(T, ORG)).find((p) => p.name === APPLICATION_PIPELINE_NAME)!;
    await updatePipeline(T, ORG, pipeline.pipelineId, { name: '2026 search' });
    const report = await buildFunnelReport(T, ORG);
    expect(report.pipelineFound).toBe(true); // the ID binding survives the rename
    expect(report.reachedStage.applied).toBe(1);
    const resolved = await resolveApplicationPipeline(T, ORG);
    expect(resolved?.pipelineId).toBe(pipeline.pipelineId);
  });

  it('a tenant with NO pipeline at all still reports pipelineFound: false', async () => {
    const report = await buildFunnelReport('user:t-virgin', 'org-x');
    expect(report.pipelineFound).toBe(false);
  });

  it('ensureApplicationPipeline converges on ONE pipeline across repeated calls', async () => {
    const a = await ensureApplicationPipeline(T, ORG);
    const b = await ensureApplicationPipeline(T, ORG);
    expect(b.pipelineId).toBe(a.pipelineId);
  });

  it('CONCURRENT first-runs settle on one pipeline — the loser deletes its duplicate (the TOCTOU pin)', async () => {
    // A virgin tenant so both ensures genuinely race the first bind (the
    // sequential test above passes trivially — the re-grade called that out).
    const t2 = 'user:t-race';
    const [a, b] = await Promise.all([
      ensureApplicationPipeline(t2, ORG),
      ensureApplicationPipeline(t2, ORG),
    ]);
    expect(b.pipelineId).toBe(a.pipelineId); // both serve the binding winner
    const named = (await listPipelines(t2, ORG)).filter((p) => p.name === APPLICATION_PIPELINE_NAME);
    expect(named.length).toBe(1); // the loser's duplicate is GONE, not just unbound
  });
});

describe('orphan sweep — reference-absence re-prunes what a crashed cascade left', () => {
  it('removes rows whose deal is GONE and past grace; keeps live-deal rows and young orphans', async () => {
    await apply('alive');
    // Orphans: rows referencing a deal that never existed, past the grace.
    await followUps.put({ tenantId: T, dealId: 'deal:gone', stage: 'applied', subjectId: 'me', dueAt: OLD, createdAt: OLD });
    await jobDigests.put({ ...digest('gone'), dealId: 'deal:gone', tenantId: T, version: 1, capturedAt: OLD } as JobDigest);
    // A YOUNG orphan — inside the grace window, must survive.
    await followUps.put({ tenantId: T, dealId: 'deal:racing', stage: 'applied', subjectId: 'me', dueAt: NOW, createdAt: NOW });
    // A live-deal row, old — must survive (reference-presence).
    await followUps.put({ tenantId: T, dealId: 'deal:alive', stage: 'applied', subjectId: 'me', dueAt: OLD, createdAt: OLD });

    const removed = await sweepOrphanedJobSearchRows(T);
    expect(removed).toBe(2); // the old orphan follow-up + the old orphan digest
    const remaining = await followUps.listByPrefix(`${T}:`);
    expect(remaining.some((r) => r.dealId === 'deal:gone')).toBe(false);
    expect(remaining.some((r) => r.dealId === 'deal:racing')).toBe(true);
    expect(remaining.some((r) => r.dealId === 'deal:alive')).toBe(true);
  });

  it('fail-closed on a falsy tenant', async () => {
    expect(await sweepOrphanedJobSearchRows('')).toBe(0);
  });

  it('the backstop fires under the confidential-pii window too — a PII-only tenant is not left with manual recovery', async () => {
    // Old orphan, past grace. Cutoff is OLDER than the row so the age-based
    // followup purger (also on the pii lane) retains it — only the
    // reference-absence sweep can remove it, which isolates what this pins.
    await followUps.put({ tenantId: T, dealId: 'deal:pii-orphan', stage: 'applied', subjectId: 'me', dueAt: OLD, createdAt: OLD });
    await purgeRetained(T, 'confidential-pii', new Date(Date.now() - 60 * 86_400_000).toISOString());
    const remaining = await followUps.listByPrefix(`${T}:`);
    expect(remaining.some((r) => r.dealId === 'deal:pii-orphan')).toBe(false);
  });
});

describe('campaign-day age-out (JS-DATA-6)', () => {
  it('old counters purge under confidential-pii with a true cutoff; today\'s survive; wrong class is a no-op', async () => {
    const past = Date.now() - 400 * 86_400_000;
    // (tenantId, subjectId, now, cap)
    expect(await consumeDaySlot(T, 'me', past, 1)).toBe(true);       // year-old counter, cap 1 now FULL
    expect(await consumeDaySlot(T, 'me', Date.now(), 1)).toBe(true); // today's counter, cap 1 now FULL

    // Wrong classification: nothing purges — both counters still full.
    await purgeRetained(T, 'internal', new Date().toISOString());
    expect(await consumeDaySlot(T, 'me', past, 1)).toBe(false);
    expect(await consumeDaySlot(T, 'me', Date.now(), 1)).toBe(false);

    // A cutoff between the two days: the old day dies, today survives.
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await purgeRetained(T, 'confidential-pii', cutoff);
    expect(await consumeDaySlot(T, 'me', past, 1)).toBe(true);        // purged ⇒ cap 1 open again
    expect(await consumeDaySlot(T, 'me', Date.now(), 1)).toBe(false); // survived ⇒ still full
  });

  it('a cutoff of NOW (a 0-day window) does NOT reset today\'s counter — the live daily cap survives', async () => {
    // Today's counter is a SAFETY CONTROL: the daily cap on applications sent
    // on a subject's behalf. `retention.confidentialPiiDays = 0` produces a
    // cutoff of `now` (wall-clock time-of-day included); the day-granular
    // guard (`row.day < cutoff's day`) retains today regardless — under the
    // earlier midnight-instant mapping, `${today}T00:00:00.000Z < now` was
    // TRUE every afternoon and each sweep handed a capped subject a fresh
    // allowance (re-grade finding).
    expect(await consumeDaySlot(T, 'me2', Date.now(), 1)).toBe(true);
    await purgeRetained(T, 'confidential-pii', new Date().toISOString());
    expect(await consumeDaySlot(T, 'me2', Date.now(), 1)).toBe(false); // survived
  });
});
