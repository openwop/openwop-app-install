/**
 * KickTodo wave 4B (slice A) — kicktodo-creator.
 *
 *  - KTFAC-1: the `createCandidate` surface op (the `create-candidate` workflow
 *    node's only path in) used to mint `cand:<uuid>` on every execution, so a
 *    node retry made a second candidate. Inside a run it now keys the create on
 *    the run id + node id + intake and creates by CAS. Breaks if the surface stops
 *    passing the key (two candidates). A blind put under a derived id would
 *    still leave one ROW, so the CAS half is pinned separately: a replay must
 *    get the STORED row back, not overwrite it with its own payload.
 *  - KTFAC-2: withdrawing a candidate retires its UNPUBLISHED `chal:ktc-*` draft,
 *    and leaves a PUBLISHED one alone. Breaks if the `unpublished-draft` death
 *    subscriber is removed (draft stays `draft`) or switched to the unconditional
 *    `retireChallenge` (the published version is retired).
 *
 * TST-DJE-2 (grade-tests wave 71):
 *  - The parallel-issued replay in case 1 is NOT a forced race (two calls on one
 *    in-memory store run back to back); the CAS half is what case 3 witnesses.
 *  - DOUBLE GUARD (two files): "leaves a PUBLISHED version alone" is held by the
 *    subscriber's `status !== 'draft'` skip (candidateDeathSubscribers.ts) AND by
 *    `retireDraft`'s own `row.status !== 'draft'` refusal (challengeService.ts), so
 *    removing either alone stays green (measured). Only a switch to the unconditional
 *    `retireChallenge` reds it.
 * Red when (re-probed): the surface stops passing the run key, the key drops the node
 * id, the keyed create is a blind put, or the subscriber stops retiring the draft.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createCandidate, listCandidates, __setCandidateWithdrawn, deriveAndBindCandidateDraft } from '../src/features/kicktodo-creator/creatorService.js';
import { buildKicktodoCreatorSurface } from '../src/features/kicktodo-creator/surface.js';
import { candidateDraftId, type ChallengePlan } from '../src/features/kicktodo-creator/planService.js';
import { registerCandidateDeathSubscribers } from '../src/features/kicktodo-creator/candidateDeathSubscribers.js';
import { __resetCandidateLifecycleHooks } from '../src/features/kicktodo-creator/candidateLifecycle.js';
import { getLatest, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';

const T = 'tenant-kt4b-creator';
const AUTHOR = 'user:kt4b-author';

const PLAN: ChallengePlan = {
  title: 'Two-Week Focus Reset',
  promise: 'Reliable daily focus blocks without burnout',
  audience: 'busy professionals',
  durationDays: 7,
  dailyMinutesBudget: 20,
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Five 25-minute focus blocks completed per week', method: 'completed check-ins' }],
  achievements: [{ achievementId: 'a1', observableEvidence: 'A completed 25-minute block with a note', outcomeIds: ['o1'] }],
  days: [
    { day: 1, stableActivityId: 'd1-first-block', title: 'One small block', actionInstruction: 'Run one 10-minute focus block.', userFacingWhy: 'A small win proves the system.', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'attestation' },
    { day: 2, stableActivityId: 'd2-full-block', title: 'One full block', actionInstruction: 'Run one 25-minute block.', userFacingWhy: 'Full length builds the muscle.', estimatedMinutes: 20, achievementIds: ['a1'], evidencePolicy: 'note' },
    { day: 7, stableActivityId: 'd7-review', title: 'Review the week', actionInstruction: 'Review which blocks worked.', userFacingWhy: 'Consolidation locks in the habit.', estimatedMinutes: 10, achievementIds: ['a1'], evidencePolicy: 'note', isRecovery: true },
  ],
};

/** The candidate id a surface `createCandidate` call returned (fails loudly on another shape). */
function candidateIdOf(v: Record<string, unknown>): string {
  const c = v.candidate;
  if (typeof c !== 'object' || c === null || !('id' in c) || typeof c.id !== 'string') throw new Error(`no candidate id in ${JSON.stringify(v)}`);
  return c.id;
}

const intake = { createdBy: AUTHOR, topic: 'focus practice', audience: 'busy pros', transformation: 'a habit', durationDaysTarget: 7, dailyMinutesTarget: 15 };

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __resetCandidateLifecycleHooks();
  registerCandidateDeathSubscribers();
});

describe('KTFAC-1 — a retried create-candidate node makes ONE candidate', () => {
  it('same run + node: sequential and parallel-issued replays converge on one candidate', async () => {
    const surface = buildKicktodoCreatorSurface({ tenantId: T, runId: 'run-kt4b-a' });
    const args = { ...intake, nodeId: 'create-candidate' };
    const first = candidateIdOf(await surface.createCandidate!(args));
    const [a, b] = await Promise.all([surface.createCandidate!(args), surface.createCandidate!(args)]);
    expect(candidateIdOf(a)).toBe(first);
    expect(candidateIdOf(b)).toBe(first);
    expect(await listCandidates(T)).toHaveLength(1);
    expect(first).toMatch(/^cand:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('a different run, a different node, or different intake is a different candidate; runless keeps fresh ids', async () => {
    const args = { ...intake, nodeId: 'create-candidate' };
    await buildKicktodoCreatorSurface({ tenantId: T, runId: 'run-1' }).createCandidate!(args);
    await buildKicktodoCreatorSurface({ tenantId: T, runId: 'run-2' }).createCandidate!(args);
    await buildKicktodoCreatorSurface({ tenantId: T, runId: 'run-1' }).createCandidate!({ ...args, nodeId: 'other-node' });
    await buildKicktodoCreatorSurface({ tenantId: T, runId: 'run-1' }).createCandidate!({ ...args, topic: 'another topic' });
    expect(await listCandidates(T)).toHaveLength(4);
    const runless = buildKicktodoCreatorSurface({ tenantId: T });
    await runless.createCandidate!(args);
    await runless.createCandidate!(args);
    expect(await listCandidates(T)).toHaveLength(6);
  });

  it('a lost create CAS returns the winner\'s row unchanged (never overwrites it)', async () => {
    const key = 'k-overwrite';
    const winner = await createCandidate({ tenantId: T, ...intake, idempotencyKey: key });
    const replay = await createCandidate({ tenantId: T, ...intake, transformation: 'changed on replay', idempotencyKey: key });
    expect(replay).toEqual(winner); // the stored row, not the replay's payload
  });
});

describe('KTFAC-2 — a withdrawn candidate takes its unpublished draft with it', () => {
  it('retires the bound `chal:ktc-*` draft on withdraw', async () => {
    const c = await createCandidate({ tenantId: T, ...intake });
    const { challenge } = await deriveAndBindCandidateDraft(T, AUTHOR, c.id, PLAN);
    expect(challenge.id).toBe(candidateDraftId(T, c.id));
    expect(challenge.status).toBe('draft');
    await __setCandidateWithdrawn(T, c.id, 'test', AUTHOR);
    expect((await getLatest(T, challenge.id))?.status).toBe('retired');
  });

  it('leaves a PUBLISHED version alone (that is the kill switch\'s call)', async () => {
    const c = await createCandidate({ tenantId: T, ...intake });
    const { challenge } = await deriveAndBindCandidateDraft(T, AUTHOR, c.id, PLAN);
    await publishChallenge(T, challenge.id, challenge.version);
    await __setCandidateWithdrawn(T, c.id, 'test', AUTHOR);
    expect((await getLatest(T, challenge.id))?.status).toBe('published');
  });
});
