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
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSteering, putSteering, eraseSubjectSteering, DEFAULT_POLICY, MAX_GOALS_CHARS } from '../src/features/job-search/agent/steering.js';
import { computePriority } from '../src/host/weightedScoring.js';
import { JOB_FIT_CRITERIA, projectFitScores } from '../src/features/job-search/domain/fitScoring.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const TENANT = 'user:t-steer';

describe('ADR 0543 P5 / OQ-2 — the PROSE never reaches ranking', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('the ranking engine accepts NUMBERS only — there is nowhere for prose to go', () => {
    // Structural, and the reason the ADR's P5 row was wrong: the scores argument
    // is `Record<string, number>`. Feeding goals text in would require inventing
    // a semantic scorer, whose output cannot be reproduced on replay.
    const src = readFileSync(join(process.cwd(), 'src', 'host', 'weightedScoring.ts'), 'utf8');
    expect(src).toContain('scores: Record<string, number>');
  });

  it('changing the goals PROSE does not change a single score', async () => {
    const digest = { title: 'Backend Engineer', companyName: 'Acme', location: null, remote: null,
      skills: ['typescript'], requirements: [], responsibilities: [], descriptionExcerpt: '',
      employmentType: 'w2' as const, sponsorship: 'silent' as const, citizenshipRequirementQuote: null,
      clearanceRequirementQuote: null, sponsorshipQuote: null, salaryMin: null, salaryMax: null,
      currency: null, sourceUrl: null, capturedAt: '', dealId: 'd', tenantId: TENANT, version: 1 };
    const profile = { skills: ['TypeScript'], targetTitles: ['Backend Engineer'], salaryFloor: null, wantsRemote: null };
    const before = computePriority(JOB_FIT_CRITERIA, projectFitScores(digest, profile));

    await putSteering(TENANT, { goals: 'I really want to move into platform work and avoid agencies.' }, 'user-1');
    const after = computePriority(JOB_FIT_CRITERIA, projectFitScores(digest, profile));

    expect(after, 'prose changed a score — selection is no longer reproducible').toBe(before);
  });

  it('the steering module does not import the ranking engine at all', () => {
    // CODE only. The module header EXPLAINS why prose cannot reach ranking and
    // names `computePriority` doing so — the third time this session a source
    // scan of mine flagged the documentation written to prevent the mistake.
    const code = readFileSync(join(process.cwd(), 'src', 'features', 'job-search', 'agent', 'steering.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('weightedScoring');
    expect(code).not.toContain('computePriority');
  });
});

describe('ADR 0543 P5 — the POLICY is what governs, and it is bounded', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('a tenant that never steered reads complete DEFAULTS, not null', async () => {
    // Every caller then reads a full policy, and none has to invent one locally.
    const s = await getSteering(TENANT);
    expect(s.policy).toEqual(DEFAULT_POLICY);
    expect(s.goals).toBe('');
  });

  it('defaults are conservative — tier A only, modest pace', async () => {
    const s = await getSteering(TENANT);
    expect(s.policy.tiers).toEqual(['A']);
    expect(s.policy.ratePerHour).toBeLessThanOrEqual(6);
  });

  it('CLAMPS the velocity fields rather than obliging a harmful number', async () => {
    // High velocity is what the evidence ties to auto-rejection, so an unbounded
    // value here would be the product helping a user damage their own search.
    const s = await putSteering(TENANT, { policy: { dailyCap: 100_000, ratePerHour: 5_000 } }, 'user-1');
    expect(s.policy.dailyCap).toBeLessThanOrEqual(200);
    expect(s.policy.ratePerHour).toBeLessThanOrEqual(60);
  });

  it('rejects tier C by construction — it is never grantable', async () => {
    const s = await putSteering(TENANT, { policy: { tiers: ['A', 'C', 'Z'] } as never }, 'user-1');
    expect(s.policy.tiers).toEqual(['A']);
  });

  it('bounds the prose — it is user text destined for a model context', async () => {
    const s = await putSteering(TENANT, { goals: 'x'.repeat(50_000) }, 'user-1');
    expect(s.goals.length).toBe(MAX_GOALS_CHARS);
  });

  it('drops unknown policy keys — closed world', async () => {
    const s = await putSteering(TENANT, { policy: { roles: ['Backend'], sneaky: 'x' } as never }, 'user-1');
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
  });

  it('is tenant-isolated', async () => {
    await putSteering(TENANT, { goals: 'mine' }, 'user-1');
    expect((await getSteering('user:t-other')).goals).toBe('');
  });
});

describe('ADR 0464 — erasing the author does not reset the workspace', () => {
  beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(openSqliteStorage(':memory:')); });

  it('redacts the person, KEEPS the policy', async () => {
    // Steering is TENANT-scoped: one row governs the whole workspace. Deleting
    // it because one member was erased would silently reset the campaign policy
    // for everyone else — so the person goes and the configuration stays.
    await putSteering(TENANT, { goals: 'I want to move into platform work', policy: { roles: ['Platform'], dailyCap: 7 } }, 'user-erased');
    await eraseSubjectSteering(TENANT, 'user-erased');

    const after = await getSteering(TENANT);
    expect(after.goals, 'the prose is theirs and describes their own search').toBe('');
    expect(after.updatedBy).toBe('[erased]');
    expect(after.policy.roles, 'the workspace policy must survive').toEqual(['Platform']);
    expect(after.policy.dailyCap).toBe(7);
  });

  it('leaves another author’s steering untouched', async () => {
    await putSteering(TENANT, { goals: 'mine' }, 'user-keep');
    await eraseSubjectSteering(TENANT, 'user-other');
    expect((await getSteering(TENANT)).goals).toBe('mine');
  });
});
