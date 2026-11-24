/**
 * ADR 0543 P5 — steering, and the line the ADR contradicted itself about.
 *
 * The P5 row said the goals TEXT was "the tie-break input the ADR 0534 ranking
 * already consumes". OQ-2 in the same ADR said the opposite, and OQ-2 is right:
 * `computePriority` takes `Record<string, number>` and nothing else. A semantic
 * tie-break would make selection irreproducible, voiding the ADR 0534 D3 stamp
 * whose whole job is explaining a past pick.
 *
 * So the headline test is a NEGATIVE one: prose cannot reach ranking.
 *
 * ADR 1036 D7 — steering is one row PER PERSON (`<tenantId>:<subjectId>`): a
 * colleague in the same workspace reads defaults, never my goals or policy, and
 * erasure DELETES the person's row (it used to redact a shared tenant row).
 *
 * Tracker TST-DHA-4 (wave 71, re-graded wave 118). Red when: the campaign pass — the
 * ONE place that reads steering into a score — folds the goals prose into its
 * profile (`w118g2-st-prose`); the ranking signature or the steering module's
 * imports change (`st-numbers`, `st-noimport`); the defaults are incomplete or
 * loosened (`st-defaults`, `st-conservative`); a velocity field is not clamped to
 * its exact cap (`st-clamp`); tier C or junk survives (`st-tiers`); the prose is
 * unbounded (`st-goalsmax`); unknown policy keys survive (`st-closed`); a partial
 * write resets the other half (`st-keeppolicy`, `st-keepgoals`); the row is not
 * tenant- or person-keyed (`st-tenant`, `st-person`); erasure leaves the person's
 * row (`st-erase`) or touches another person's (`st-eraseother`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSteering, putSteering, eraseSubjectSteering, DEFAULT_POLICY, MAX_GOALS_CHARS } from '../src/features/job-search/agent/steering.js';
import { runTenantCampaignPass } from '../src/features/job-search/autopilot/campaignRun.js';
import { registerBoardAdapter, getBoardAdapter, type BoardAdapter } from '../src/features/job-search/boards/adapters.js';
import { upsertListing } from '../src/features/job-search/boards/listing.js';
import { createApplyGrant } from '../src/host/applyGrant.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { stripComments } from './helpers/stripComments.js';

const TENANT = 'user:t-steer';

/** A Tier-A test board WITH a submit lane, so the campaign pass actually scores
 *  its listings (a lane-less board is skipped before scoring). Registered once. */
const STEER_BOARD = 'steer-board';
const steerBoard: BoardAdapter = {
  id: STEER_BOARD,
  displayName: 'Steering test board',
  origin: `${STEER_BOARD}.example.com`,
  auth: { kind: 'public' },
  tier: 'A',
  searchUrlTemplate: 'https://{company}.example.com',
  postingsPath: 'jobs',
  map: { title: 'title' },
  docsUrl: 'https://example.com/docs',
  submitLane: {
    async fetchQuestions() { return []; },
    async submit() { return { ok: true }; },
  },
};
if (!getBoardAdapter(STEER_BOARD)) registerBoardAdapter(steerBoard);

describe('ADR 0543 P5 / OQ-2 — the PROSE never reaches ranking', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('the ranking engine accepts NUMBERS only — there is nowhere for prose to go', () => {
    // Structural, and the reason the ADR's P5 row was wrong: the scores argument
    // is `Record<string, number>`. Feeding goals text in would require inventing
    // a semantic scorer, whose output cannot be reproduced on replay.
    // Anchored to `computePriority` itself: `scoreCompleteness` carries the same
    // parameter text, so an unanchored `toContain` stayed green with the ranking
    // function's signature widened.
    const src = readFileSync(join(process.cwd(), 'src', 'host', 'weightedScoring.ts'), 'utf8');
    expect(src).toMatch(/export function computePriority\(set: CriteriaSet, scores: Record<string, number>\): number \{/);
  });

  it('changing the goals PROSE does not change a single score', async () => {
    // TST-OAL-2 (user decision 2026-11-22): this case used to open with a
    // `computePriority` before/after `putSteering`. That half called a pure
    // function steering never enters, so it could not fail, and was dropped.
    // The campaign pass is the one place steering reaches a score:
    // this is where prose COULD reach one. The goals name the listing's title
    // exactly; folded into the profile, the title match would rise and the
    // below-floor detail ("scored N, floor 10") would change.
    const NOW = Date.now();
    await putSteering(TENANT, {
      goals: 'Anything at all.',
      policy: { roles: ['Staff Backend Engineer'], minMatchScore: 10, dailyCap: 10, ratePerHour: 4, tiers: ['A'] },
    }, 'user-1');
    await createApplyGrant({
      tenantId: TENANT, orgId: 'org-steer', subjectId: 'user-1', grantedBy: 'user-1', campaignId: 'camp-steer',
      maxSubmits: 5, maxPrepared: 5, ratePerHour: 4, origins: [`${STEER_BOARD}.example.com`],
      resumePolicy: 'default', expiresAt: new Date(NOW + 86_400_000).toISOString(),
    });
    const listing = await upsertListing(TENANT, 'user-1', {
      title: 'Platform Engineer', companyName: 'Acme', location: 'Remote', sourceBoard: STEER_BOARD,
      sourceUrl: `https://${STEER_BOARD}.example.com/jobs/1`,
      ext: { skills: [], requirements: [], responsibilities: [], descriptionExcerpt: 'Run the platform.' },
    });
    const passBefore = await runTenantCampaignPass(TENANT, 'user-1', NOW);
    expect(passBefore.results[0]!.digest.skipped).toEqual([
      { listingId: listing.listingId, reason: 'below-floor', detail: expect.stringMatching(/^scored \S+, floor 10$/) },
    ]);

    await putSteering(TENANT, { goals: 'Platform Engineer roles are exactly what I want.' }, 'user-1');
    const passAfter = await runTenantCampaignPass(TENANT, 'user-1', NOW);
    expect(passAfter.results[0]!.digest.skipped, 'the goals prose moved a score').toEqual(passBefore.results[0]!.digest.skipped);
  });

  it('the steering module does not import the ranking engine at all', () => {
    // CODE only. The module header EXPLAINS why prose cannot reach ranking and
    // names `computePriority` doing so — the third time this session a source
    // scan of mine flagged the documentation written to prevent the mistake.
    const code = stripComments(readFileSync(join(process.cwd(), 'src', 'features', 'job-search', 'agent', 'steering.ts'), 'utf8'));
    expect(code).not.toContain('weightedScoring');
    expect(code).not.toContain('computePriority');
  });
});

describe('ADR 0543 P5 — the POLICY is what governs, and it is bounded', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('a tenant that never steered reads complete DEFAULTS, not null', async () => {
    // Every caller then reads a full policy, and none has to invent one locally.
    // Pinned as literals: comparing to the exported DEFAULT_POLICY would move with it.
    const s = await getSteering(TENANT, 'user-1');
    expect(s.policy).toEqual({ roles: [], locations: [], remote: null, minMatchScore: 5, dailyCap: 10, ratePerHour: 4, tiers: ['A'] });
    expect(s.goals).toBe('');
  });

  it('defaults are conservative — tier A only, modest pace', async () => {
    const s = await getSteering(TENANT, 'user-1');
    expect(s.policy.tiers).toEqual(['A']);
    expect(s.policy.ratePerHour).toBeLessThanOrEqual(6);
  });

  it('CLAMPS the velocity fields rather than obliging a harmful number', async () => {
    // High velocity is what the evidence ties to auto-rejection, so an unbounded
    // value here would be the product helping a user damage their own search.
    const s = await putSteering(TENANT, { policy: { dailyCap: 100_000, ratePerHour: 5_000 } }, 'user-1');
    // Exactly the caps: a fallback to the defaults (10 / 4) is not a clamp.
    expect(s.policy.dailyCap).toBe(200);
    expect(s.policy.ratePerHour).toBe(60);
  });

  it('rejects tier C by construction — it is never grantable', async () => {
    const s = await putSteering(TENANT, { policy: { tiers: ['A', 'C', 'Z'] } }, 'user-1');
    expect(s.policy.tiers).toEqual(['A']);
  });

  it('bounds the prose — it is user text destined for a model context', async () => {
    const s = await putSteering(TENANT, { goals: 'x'.repeat(50_000) }, 'user-1');
    expect(s.goals.length).toBe(MAX_GOALS_CHARS);
  });

  it('drops unknown policy keys — closed world', async () => {
    const s = await putSteering(TENANT, { policy: { roles: ['Backend'], sneaky: 'x' } }, 'user-1');
    expect(Object.keys(s.policy).sort()).toEqual(
      ['dailyCap', 'locations', 'minMatchScore', 'ratePerHour', 'remote', 'roles', 'tiers'],
    );
  });

  it('a goals-only write leaves the policy untouched, and vice versa', async () => {
    await putSteering(TENANT, { policy: { roles: ['Platform'], dailyCap: 7 } }, 'user-1');
    const afterProse = await putSteering(TENANT, { goals: 'avoid agencies' }, 'user-1');
    expect(afterProse.policy.roles).toEqual(['Platform']);
    expect(afterProse.policy.dailyCap).toBe(7);
    expect(afterProse.goals).toBe('avoid agencies');
    // …and vice versa: a policy-only write leaves the goals untouched.
    const afterPolicy = await putSteering(TENANT, { policy: { roles: ['Data'] } }, 'user-1');
    expect(afterPolicy.goals).toBe('avoid agencies');
    expect(afterPolicy.policy.roles).toEqual(['Data']);
  });

  it('is tenant-isolated', async () => {
    await putSteering(TENANT, { goals: 'mine' }, 'user-1');
    expect((await getSteering(TENANT, 'user-1')).goals, 'positive control: the write landed').toBe('mine');
    expect((await getSteering('user:t-other', 'user-1')).goals).toBe('');
  });

  it('ADR 1036 D7 — is PERSON-isolated: a colleague in the same workspace reads defaults, not my goals or policy', async () => {
    await putSteering(TENANT, { goals: 'leaving for platform work', policy: { roles: ['Platform'], dailyCap: 3 } }, 'user-1');
    const theirs = await getSteering(TENANT, 'user-2');
    expect(theirs.goals).toBe('');
    expect(theirs.policy).toEqual(DEFAULT_POLICY);
    // …and their write does not overwrite mine.
    await putSteering(TENANT, { policy: { dailyCap: 50 } }, 'user-2');
    expect((await getSteering(TENANT, 'user-1')).policy.dailyCap).toBe(3);
  });
});

describe('ADR 0464 / ADR 1036 D7 — erasure deletes the person\'s own steering', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('deletes the erased person\'s row: goals AND policy go, they were theirs', async () => {
    // Steering used to be one TENANT row, so erasure redacted it to keep the
    // workspace's policy alive. It is now one row per person (D7); nothing in
    // it outlives them.
    await putSteering(TENANT, { goals: 'I want to move into platform work', policy: { roles: ['Platform'], dailyCap: 7 } }, 'user-erased');
    expect((await getSteering(TENANT, 'user-erased')).policy.dailyCap, 'positive control: the row exists').toBe(7);
    await eraseSubjectSteering(TENANT, 'user-erased');

    const after = await getSteering(TENANT, 'user-erased');
    expect(after.goals).toBe('');
    expect(after.policy).toEqual(DEFAULT_POLICY);
    expect(after.updatedBy, 'a default, not a surviving row').toBe('');
  });

  it('leaves another person\'s steering untouched', async () => {
    await putSteering(TENANT, { goals: 'mine' }, 'user-keep');
    // The erased person HAS a row, so the erasure really runs and deletes something;
    // only theirs may go.
    await putSteering(TENANT, { goals: 'theirs' }, 'user-other');
    await eraseSubjectSteering(TENANT, 'user-other');
    expect((await getSteering(TENANT, 'user-other')).goals, 'the erasure ran').toBe('');
    expect((await getSteering(TENANT, 'user-keep')).goals).toBe('mine');
  });
});
