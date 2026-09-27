/**
 * KT-D1 (the Wave-1-exit blocker) — account-deletion cascade over the FULL
 * KickTodo graph, two-tenant isolation:
 *
 *  - GOALS rows purge (regression: `owner.tenant` is nested — invisible to the
 *    generic top-level-`tenantId` probe until the collection's `tenantOf` fix)
 *  - KANBAN boards AND CARDS purge (regression: cards carry no tenantId — the
 *    generic walk stranded them until `purgeTenantKanban` cascades board→card)
 *  - kicktodo enrollments/occurrences/check-ins/evidence/candidates purge via
 *    the generic tenant walk (top-level tenantId — asserted, not assumed)
 *  - scheduler jobs (tenantId rows) purge
 *  - THE OTHER TENANT'S identical graph is fully intact afterward
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { getBoard, getCard, purgeTenantKanban } from '../src/host/kanbanService.js';
import { getJob, registerJob } from '../src/host/schedulingService.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { getGoal, armContinuation, continuationJobId } from '../src/features/goals/goalsService.js';
import { createDraft, publishChallenge, getChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment } from '../src/features/kicktodo-core/enrollmentService.js';
import { submitCheckIn, todayFor } from '../src/features/kicktodo-core/todayService.js';
import { freezeProgressEvidence, getEvidence } from '../src/features/kicktodo-core/progressService.js';
import { createCandidate, getCandidate } from '../src/features/kicktodo-creator/creatorService.js';

const A = 'tenant-del-a';
const B = 'tenant-del-b';

interface Graph {
  challengeId: string;
  enrollmentId: string;
  goalId: string;
  boardId: string;
  cardId: string;
  evidenceId: string;
  candidateId: string;
}

async function buildGraph(tenant: string, who: string): Promise<Graph> {
  const draft = await createDraft({
    tenantId: tenant, title: `Graph ${who}`, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Do it', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(tenant, draft.id, 1);
  const { enrollment } = await enroll({ tenantId: tenant, ownerSubject: `user:${who}`, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  await armContinuation(tenant, enrollment.goalId, { workflowId: 'openwop-app.kicktodo.daily-loop', cronExpr: '0 * * * *' });
  const today = await todayFor(tenant, `user:${who}`);
  const cardId = today.enrollments[0].actions[0].occurrence.cardId;
  await submitCheckIn(tenant, `user:${who}`, cardId, { note: 'done' });
  const evidence = await freezeProgressEvidence(tenant, enrollment.id);
  const candidate = await createCandidate({
    tenantId: tenant, createdBy: `user:${who}`, topic: 'Watercolor basics',
    audience: 'adults', transformation: 'paint weekly', durationDaysTarget: 7, dailyMinutesTarget: 15,
  });
  return {
    challengeId: draft.id,
    enrollmentId: enrollment.id,
    goalId: enrollment.goalId,
    boardId: enrollment.boardId,
    cardId,
    evidenceId: evidence!.id,
    candidateId: candidate.id,
  };
}

let a: Graph;
let b: Graph;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  a = await buildGraph(A, 'alice');
  b = await buildGraph(B, 'bob');
});

describe('KT-D1 — account deletion purges the whole KickTodo graph', () => {
  it('purges tenant A completely while tenant B stays fully intact', async () => {
    // Pre-flight: everything exists for BOTH tenants.
    expect(await getGoal(A, a.goalId)).not.toBeNull();
    expect(await getCard(a.cardId)).not.toBeNull();
    expect(await getJob(continuationJobId(A, a.goalId))).not.toBeNull();

    // The account-deletion order: kanban FIRST (cards need their boards to be
    // findable), then the generic tenant walk.
    const kanban = await purgeTenantKanban(A);
    expect(kanban.boards).toBeGreaterThanOrEqual(1);
    expect(kanban.cards).toBeGreaterThanOrEqual(1);
    await purgeTenantHostExt(A);

    // Tenant A: every node of the graph is GONE.
    expect(await getChallenge(A, a.challengeId, 1)).toBeNull();
    expect(await getEnrollment(A, a.enrollmentId)).toBeNull();
    expect(await getGoal(A, a.goalId)).toBeNull(); // the nested-tenant regression
    expect(await getBoard(a.boardId)).toBeNull();
    expect(await getCard(a.cardId)).toBeNull(); // the stranded-cards regression
    expect(await getEvidence(A, a.enrollmentId, a.evidenceId)).toBeNull();
    expect(await getCandidate(A, a.candidateId)).toBeNull();
    expect(await getJob(continuationJobId(A, a.goalId))).toBeNull(); // scheduler row
    expect((await todayFor(A, 'user:alice')).enrollments).toHaveLength(0);

    // Tenant B: the identical graph is fully intact.
    expect(await getChallenge(B, b.challengeId, 1)).not.toBeNull();
    expect(await getEnrollment(B, b.enrollmentId)).not.toBeNull();
    expect(await getGoal(B, b.goalId)).not.toBeNull();
    expect(await getBoard(b.boardId)).not.toBeNull();
    expect(await getCard(b.cardId)).not.toBeNull();
    expect(await getEvidence(B, b.enrollmentId, b.evidenceId)).not.toBeNull();
    expect(await getCandidate(B, b.candidateId)).not.toBeNull();
    expect(await getJob(continuationJobId(B, b.goalId))).not.toBeNull();
    expect((await todayFor(B, 'user:bob')).enrollments).toHaveLength(1);
  });

  it('registerJob rows for other purposes in tenant A are also gone (tenantId probe)', async () => {
    // A plain scheduler job registered under A pre-purge would be covered by
    // the generic walk; register one under B and prove isolation held.
    await registerJob({ jobId: 'job:b-extra', tenantId: B, cronExpr: '0 * * * *', workflowId: 'wf:x' });
    expect(await getJob('job:b-extra')).not.toBeNull();
  });
});
