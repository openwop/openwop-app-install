/**
 * `PROBE-KTX4` and `PROBE-KTX4b` (KT-EXP-8 / KT-EXP-8b), migrated.
 *
 * KTX4 asks: after a `:fork` of an authoring run through `decompose` for one
 * candidate, exactly ONE `chal:ktc-%::v1` row exists. KTX4b asks: a re-decompose
 * racing a publish must not clobber the published status.
 *
 * SCOPE, STATED PLAINLY: these assert the MECHANISM the probes name — the
 * deterministic candidate draft id (`planService.ts:28`) and the published-row
 * immutability that together make a re-decompose idempotent — by driving
 * `draftFromPlan` directly. They do NOT drive a real `:fork` of an authoring
 * run; that wiring is a separate harness and remains unasserted. This is the
 * same mechanism-vs-wiring split recorded for the show-delete cascade, and it is
 * named here so nobody reads these as fork coverage.
 *
 * The deterministic id is the whole defence: without it a fork mints a fresh
 * `chal:<uuid>` per replay, orphaning the previous draft and leaving the
 * candidate pointing at one of N.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { draftFromPlan } from '../src/features/kicktodo-creator/planService.js';
import type { ChallengePlan } from '../src/features/kicktodo-creator/planService.js';
import { publishChallenge, getChallenge } from '../src/features/kicktodo-core/challengeService.js';

const T = 'tenant-ktx4';
const AUTHOR = 'user:ktx4-author';
const CANDIDATE = 'cand-1';

const PLAN: ChallengePlan = {
  title: 'Two-Week Focus Reset',
  promise: 'Reliable daily focus blocks without burnout',
  audience: 'busy professionals',
  durationDays: 7,
  dailyMinutesBudget: 20,
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Five 25-minute focus blocks completed per week', method: 'completed check-ins' }],
  achievements: [{ achievementId: 'a1', observableEvidence: 'A completed 25-minute block with a note', outcomeIds: ['o1'] }],
  days: [
    { day: 1, stableActivityId: 'd1', title: 'One small block', actionInstruction: 'Run one 10-minute focus block.', userFacingWhy: 'A small win proves the system.', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'attestation' },
    { day: 7, stableActivityId: 'd7', title: 'Review the week', actionInstruction: 'Review which blocks worked.', userFacingWhy: 'Consolidation locks the habit.', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'note', isRecovery: true },
  ],
};

/** The probe's own predicate: how many `chal:ktc-%` v1 rows exist for the tenant. */
async function ktcRowCount(): Promise<number> {
  const rows = await hostExtStorage().kvList('hostext:kicktodo-challenges:');
  return rows.filter((r) => r.key.includes(`${T}::chal:ktc-`) && r.key.endsWith('::v1')).length;
}

beforeEach(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('PROBE-KTX4 (executable) — a re-decompose is idempotent, not orphaning', () => {
  it('two decomposes of ONE candidate leave exactly one ktc- draft', async () => {
    const first = await draftFromPlan(T, AUTHOR, PLAN, CANDIDATE);
    expect(await ktcRowCount(), 'precondition: the first decompose wrote a ktc- row').toBe(1);

    const second = await draftFromPlan(T, AUTHOR, PLAN, CANDIDATE);

    expect(second.id, 'a re-decompose minted a NEW id — the previous draft is orphaned').toBe(first.id);
    expect(await ktcRowCount(), 'PROBE-KTX4: expected EXACTLY 1 ktc- v1 row').toBe(1);
  });

  it('two DIFFERENT candidates get different drafts — the id is not a constant', async () => {
    // The other polarity: an id that ignored candidateId would pass the test
    // above by collapsing every candidate onto one draft.
    await draftFromPlan(T, AUTHOR, PLAN, 'cand-A');
    await draftFromPlan(T, AUTHOR, PLAN, 'cand-B');
    expect(await ktcRowCount(), 'two candidates collapsed onto one draft').toBe(2);
  });
});

describe('PROBE-KTX4b (executable) — a re-decompose cannot clobber a published draft', () => {
  it('returns the FROZEN row untouched instead of reverting it to draft', async () => {
    // My first version of this case expected a THROW. That was wrong, and the
    // code says so: `createDraft` does `if (existing && existing.status !==
    // 'draft') return existing; // frozen — never touch` (challengeService.ts:176).
    // Returning the frozen row IS the KT-EXP-8b contract — a racing decompose
    // must be a no-op, not an error, so a fork replay does not fail a run. The
    // property that matters is that the STORED row is unchanged.
    const draft = await draftFromPlan(T, AUTHOR, PLAN, CANDIDATE);
    await publishChallenge(T, draft.id, 1);
    const before = await getChallenge(T, draft.id, 1);
    expect(before?.status, 'precondition: the draft was not published').toBe('published');
    expect(before?.contentHash, 'precondition: no frozen content hash to compare').toMatch(/^sha256:/);

    const raced = await draftFromPlan(T, AUTHOR, PLAN, CANDIDATE);

    expect(raced.status, 'the re-decompose handed back a DRAFT over a published challenge').toBe('published');
    const after = await getChallenge(T, draft.id, 1);
    expect(after?.status, 'the published status was clobbered back to draft').toBe('published');
    expect(
      after?.contentHash,
      'the frozen content was rewritten — participants enrolled on this version would silently change plan',
    ).toBe(before?.contentHash);
    expect(await ktcRowCount()).toBe(1);
  });
});
