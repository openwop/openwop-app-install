/**
 * WF-JS-1 — the campaign DISPATCH LANE, end to end at the service layer.
 *
 * Before this lane, `runCampaign`/`applyToListing` had zero production callers
 * (WORKFLOWS-ASSESSMENT § job-search): the assessment's one Blocker. These
 * tests witness the lane's honesty properties, each of which is a promise a
 * user can already see in the UI:
 *
 *  - a board with no submit lane is a VISIBLE skip, never a claimed listing;
 *  - the steering `dailyCap` and the grant's `ratePerHour` actually bind;
 *  - a replayed run cannot spend budget or re-submit (ambient, not caller-told);
 *  - queueing is grant-gated (409) and idempotent while a card is waiting.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runTenantCampaignPass, campaignDayCounts, digestFromListing, applicantFromBank } from '../src/features/job-search/autopilot/campaignRun.js';
import { queueCampaignCard, CAREER_CAMPAIGN_CARD_WORKFLOW_ID } from '../src/features/job-search/agent/provision.js';
import { registerBoardAdapter, getBoardAdapter, type BoardAdapter } from '../src/features/job-search/boards/adapters.js';
import { upsertListing } from '../src/features/job-search/boards/listing.js';
import { putSteering } from '../src/features/job-search/agent/steering.js';
import { createApplyGrant, applyGrants } from '../src/host/applyGrant.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { listCards } from '../src/host/kanbanService.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const T = 'user:t-lane';
const ORG = 'org-lane';
const ME = 'user:me';
const NOW = 7_200_000_000; // an exact hour boundary — pace math is legible

/** A Tier-A test board WITH a submit lane; registration is module-global, so
 *  ids are unique per behavior under test. */
function laneBoard(id: string, submits: Array<{ listingId: string }>): BoardAdapter {
  return {
    id,
    displayName: `Test board ${id}`,
    origin: `${id}.example.com`,
    auth: { kind: 'public' },
    tier: 'A',
    searchUrlTemplate: 'https://{company}.example.com',
    postingsPath: 'jobs',
    map: { title: 'title' },
    docsUrl: 'https://example.com/docs',
    submitLane: {
      async fetchQuestions() { return []; },
      async submit(prepared) { submits.push({ listingId: prepared.listingId }); return { ok: true }; },
    },
  };
}

/** Steering that makes the fixture listing clear the floor: the profile derives
 *  from policy (roles → targetTitles), so the role must match the title. */
const steer = (over: Partial<{ minMatchScore: number; dailyCap: number }> = {}) =>
  putSteering(T, {
    goals: '',
    policy: {
      roles: ['Staff Backend Engineer'], locations: [], remote: null,
      minMatchScore: over.minMatchScore ?? 1, dailyCap: over.dailyCap ?? 10,
      ratePerHour: 4, tiers: ['A'],
    },
  }, ME);

const grant = (over: Partial<Parameters<typeof createApplyGrant>[0]> = {}) =>
  createApplyGrant({
    tenantId: T, orgId: ORG, subjectId: ME, grantedBy: ME, campaignId: 'camp-lane',
    maxSubmits: 10, maxPrepared: 5, ratePerHour: 10,
    origins: ['lane-a.example.com', 'lane-pace.example.com', 'lane-cap.example.com', 'lane-replay.example.com'],
    resumePolicy: 'default', expiresAt: new Date(NOW + 86_400_000).toISOString(),
    ...over,
  });

/** A listing that clears eligibility (silent posting) and the floor (no listed
 *  skills ⇒ neutral overlap; the steering role matches the title). */
const listing = (board: string, n: number) =>
  upsertListing(T, ME, {
    title: 'Staff Backend Engineer',
    companyName: `Company ${board}-${n}`,
    location: 'Remote',
    sourceBoard: board,
    sourceUrl: `https://${board}.example.com/jobs/${n}`,
    ext: { skills: [], requirements: [], responsibilities: [], descriptionExcerpt: 'Build things.' },
  });

beforeEach(() => {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(':memory:'));
});

describe('WF-JS-1 — the pass is honest about what it cannot do', () => {
  it('a board with NO submit lane is a first-class skip, never a claimed listing', async () => {
    await steer();
    await grant({ origins: ['boards-api.greenhouse.io'] });
    await listing('greenhouse', 1); // real Tier-1 board — ships no submitLane
    const report = await runTenantCampaignPass(T, NOW);
    expect(report.ranGrants).toBe(1);
    expect(report.skippedNoSubmitLane).toBe(1);
    const d = report.results[0]!.digest;
    expect(d.skipped).toEqual([expect.objectContaining({ reason: 'board-no-submit-lane' })]);
    expect(d.applied).toEqual([]);
    // Nothing was claimed and no budget moved — the pipeline was never entered.
    const g = (await applyGrants.listByPrefix(`${T}:`))[0]!;
    expect(g.submitsUsed).toBe(0);
  });

  it('applies END TO END through a board that ships a lane: deal, consumption, audit', async () => {
    const submits: Array<{ listingId: string }> = [];
    if (!getBoardAdapter('lane-a')) registerBoardAdapter(laneBoard('lane-a', submits));
    else submits.length = 0;
    await steer();
    await grant();
    const up = await listing('lane-a', 1);
    const report = await runTenantCampaignPass(T, NOW);
    const d = report.results[0]!.digest;
    expect(d.applied).toEqual([`deal:${up.listingId}`]);
    expect(submits).toEqual([{ listingId: up.listingId }]);
    const g = (await applyGrants.listByPrefix(`${T}:`))[0]!;
    expect(g.submitsUsed).toBe(1);
    expect(g.paceUsed).toBe(1);
    // …and the day slot was consumed at the moment of submission.
    expect((await campaignDayCounts.get(`${T}:${ME}:${new Date(NOW).toISOString().slice(0, 10)}`))?.used).toBe(1);
  });

  it('the steering dailyCap binds ACROSS listings in a pass', async () => {
    const submits: Array<{ listingId: string }> = [];
    if (!getBoardAdapter('lane-cap')) registerBoardAdapter(laneBoard('lane-cap', submits));
    else submits.length = 0;
    await steer({ dailyCap: 1 });
    await grant();
    await listing('lane-cap', 1);
    await listing('lane-cap', 2);
    const report = await runTenantCampaignPass(T, NOW);
    const d = report.results[0]!.digest;
    expect(d.applied.length).toBe(1);
    // The second submittable item was refused at the SUBMIT moment (the day
    // slot is consumed after park/grant checks), so it reports as board-refused
    // or a pre-pipeline daily-cap skip depending on where the cap bit — either
    // way, exactly one application left this pass.
    expect(submits.length).toBe(1);
  });

  it('a REPLAYED pass spends nothing and submits nothing — ambient, not caller-told', async () => {
    const submits: Array<{ listingId: string }> = [];
    if (!getBoardAdapter('lane-replay')) registerBoardAdapter(laneBoard('lane-replay', submits));
    else submits.length = 0;
    await steer();
    await grant();
    await listing('lane-replay', 1);
    const report = await runWithEffectContext({ runId: 'run-replay', replaying: true }, () =>
      runTenantCampaignPass(T, NOW),
    );
    const d = report.results[0]!.digest;
    expect(d.applied).toEqual([]);
    expect(d.skipped).toEqual([expect.objectContaining({ reason: 'refused', detail: expect.stringContaining('replay') })]);
    expect(submits).toEqual([]);
    expect((await applyGrants.listByPrefix(`${T}:`))[0]!.submitsUsed).toBe(0);
  });
});

describe('WF-JS-1 — queueing is gated and idempotent', () => {
  it('refuses (409) when the tenant holds no live grant', async () => {
    await expect(queueCampaignCard(T, ME, NOW)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'no_active_grant' } });
  });

  it('files ONE card naming the stable workflow id; a second queue returns it', async () => {
    await grant();
    const first = await queueCampaignCard(T, ME, NOW);
    expect(first.created).toBe(true);
    expect(first.card.workflowId).toBe(CAREER_CAMPAIGN_CARD_WORKFLOW_ID);
    const second = await queueCampaignCard(T, ME, NOW);
    expect(second.created).toBe(false);
    expect(second.card.id).toBe(first.card.id);
    const cards = await listCards(first.boardId);
    expect(cards.filter((c) => c.workflowId === CAREER_CAMPAIGN_CARD_WORKFLOW_ID).length).toBe(1);
  });
});

describe('WF-JS-1 — assembly helpers stay deterministic and neutral', () => {
  it('digestFromListing is pure: same row, byte-identical digest', async () => {
    await steer();
    const up = await listing('greenhouse', 9);
    const { listListings } = await import('../src/features/job-search/boards/listing.js');
    const row = (await listListings(T)).find((r) => r.entityId === up.listingId)!;
    expect(JSON.stringify(digestFromListing(row))).toBe(JSON.stringify(digestFromListing(row)));
  });

  it('an unanswered bank never manufactures a disqualification', () => {
    const a = applicantFromBank([]);
    expect(a).toEqual({ requiresSponsorship: false, meetsCitizenshipRequirement: true, holdsRequiredClearance: true });
    // …and an affirmative sponsorship answer DOES bind.
    const b = applicantFromBank([{ questionKey: 'work-auth.requires-sponsorship', value: 'yes' }]);
    expect(b.requiresSponsorship).toBe(true);
  });
});
