/**
 * ADR 0459 P2 — coach plan-proposals become participant-decided approval cards.
 *
 * Invariants pinned here:
 *  - proposing raises a `kicktodo-plan-proposal` approval with the right kind,
 *    payload, conversationId (the circle's) and approverRefs (the participant);
 *  - the PARTICIPANT claims through claimApproval WITHOUT the approvals:respond
 *    scope, and the enrollment re-materializes (planRevision bumps);
 *  - a FOREIGN subject (including the coach) cannot claim — the enrollment-owner
 *    check in resolveProposal is the authority (uniform 404);
 *  - reject dismisses the proposal + records the approval;
 *  - double-resolution across the retained per-enrollment route and the card is a
 *    no-op success in BOTH orders (resolveProposal is idempotent);
 *  - reviewProjection surfaces the card under the circle conversationId filter,
 *    and ONLY to the participant (the coach's note is PII).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import {
  createCircle,
  inviteToCircle,
  acceptGrant,
} from '../src/features/kicktodo-accountability/circleService.js';
import {
  proposePlanChange,
  resolveProposal,
  reconcileProposalCard,
  listProposalsFor,
} from '../src/features/kicktodo-accountability/cohortService.js';
import { registerKicktodoAccountabilityApprovalHandler } from '../src/features/kicktodo-accountability/planProposalApproval.js';
import { listApprovals, getApproval, type PendingApproval } from '../src/host/approvalService.js';
import { claimApproval, rejectApproval } from '../src/host/approvalDecision.js';
import { listReviews } from '../src/host/reviewProjection.js';

const storage = await openStorage('memory://');
initHostExtPersistence(storage);
const hostSuite = createHostAdapterSuite({ storage });
const deps = { storage, hostSuite };

const TENANT = 'tenant-plan-proposal';
let challengeId = '';
let seq = 0;

beforeAll(async () => {
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  registerKicktodoAccountabilityApprovalHandler(); // boot registration (feature isn't composed in a unit test)
  __clearEnrollGuards();
  const draft = await createDraft({
    tenantId: TENANT, title: 'Focus', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(TENANT, draft.id, 1);
  challengeId = draft.id;
});

/** A fresh participant-owned circle with an accepted coach who holds the
 *  coach-plan-proposal scope, plus a proposal + its raised approval. */
async function scenario() {
  seq += 1;
  const participant = `user:participant-${seq}`;
  const coach = `user:coach-${seq}`;
  const { enrollment } = await enroll({ tenantId: TENANT, ownerSubject: participant, challengeId, challengeVersion: 1 });
  const circle = await createCircle({ tenantId: TENANT, type: 'coach', enrollmentId: enrollment.id, ownerSubject: participant, name: `Circle ${seq}` });
  await inviteToCircle(TENANT, circle.id, participant, coach, ['coach-plan-proposal']);
  await acceptGrant(circle.id, coach);
  // ADR 0501 — a coach proposal carries the EXECUTABLE change. This fixture used to
  // pass prose only (commands did not exist), which made every test below assert a
  // `planRevision` bump produced by the blunt re-materialization path rather than the
  // coach's actual ask. `advice()` below keeps the prose-only shape on purpose.
  const proposal = await proposePlanChange(circle.id, coach, 'Move your sessions to the morning.', [
    { lane: 'schedule', daypart: 'morning' },
  ]);
  const approval = (await listApprovals(TENANT, 'pending')).find(
    (a) => a.kind === 'kicktodo-plan-proposal' && a.planProposal?.proposalId === proposal.id,
  );
  return { participant, coach, enrollmentId: enrollment.id, circle, proposal, approval: approval as PendingApproval };
}

/** The pre-ADR-0501 shape: prose, no commands. Advice, and never applyable. */
async function advice() {
  seq += 1;
  const participant = `user:advice-participant-${seq}`;
  const coach = `user:advice-coach-${seq}`;
  const { enrollment } = await enroll({ tenantId: TENANT, ownerSubject: participant, challengeId, challengeVersion: 1 });
  const circle = await createCircle({ tenantId: TENANT, type: 'coach', enrollmentId: enrollment.id, ownerSubject: participant, name: `Advice ${seq}` });
  await inviteToCircle(TENANT, circle.id, participant, coach, ['coach-plan-proposal']);
  await acceptGrant(circle.id, coach);
  const proposal = await proposePlanChange(circle.id, coach, 'Try to get more sleep.');
  const approval = (await listApprovals(TENANT, 'pending')).find(
    (a) => a.kind === 'kicktodo-plan-proposal' && a.planProposal?.proposalId === proposal.id,
  );
  return { participant, enrollmentId: enrollment.id, proposal, approval: approval as PendingApproval };
}

describe('ADR 0459 P2 — plan-proposal approval cards', () => {
  it('proposing raises an approval with the right kind, payload, conversationId and participant approverRef', async () => {
    const s = await scenario();
    expect(s.approval).toBeTruthy();
    expect(s.approval.kind).toBe('kicktodo-plan-proposal');
    expect(s.approval.conversationId).toBe(s.circle.conversationId);
    expect(s.approval.planProposal).toMatchObject({
      circleId: s.circle.id,
      enrollmentId: s.enrollmentId,
      proposalId: s.proposal.id,
      coachSubject: s.coach,
      // Assert the card COPIES the proposal's note, not a literal duplicated from the
      // fixture. The hardcoded string here broke when the fixture's note changed, which
      // is the same copy-coupling brittleness that made `getByRole({ name: /apply/i })`
      // fail on a truthful re-word: the property is "the note is carried through".
      note: s.proposal.note,
    });
    expect(s.approval.policy).toMatchObject({ requiredApprovals: 1, approverRefs: [s.participant] });
    // No agent, no run.
    expect(s.approval.rosterId).toBe('');
    expect(s.approval.workflowId).toBe('');
  });

  it('the PARTICIPANT claims (no approvals:respond scope) and the enrollment re-materializes', async () => {
    const s = await scenario();
    const before = await getEnrollment(TENANT, s.enrollmentId);
    const result = await claimApproval(deps, { tenantId: TENANT, decidedBy: s.participant }, s.approval.approvalId);
    expect(result.status).toBe('approved');
    // ADR 0501 — assert the coach's SPECIFIC ask is now true of the enrollment. The
    // previous assertion was the `planRevision` bump alone, which the pre-0501 blunt
    // path produced whether or not the coach's change was executed — so it could not
    // distinguish a working accept from KT-HONESTY-1.
    const after = await getEnrollment(TENANT, s.enrollmentId);
    expect(after?.schedulePreference?.daypart).toBe('morning');
    expect(after?.planRevision).toBe((before?.planRevision ?? 0) + 1);
    // The proposal + approval both record the resolution.
    expect((await listProposalsFor(TENANT, s.enrollmentId))[0]?.state).toBe('applied');
    expect((await getApproval(s.approval.approvalId))?.status).toBe('approved');
  });

  it('an ADVICE-ONLY card (no commands) is REFUSED, not silently approved (#2688 guard)', async () => {
    const a = await advice();
    const before = await getEnrollment(TENANT, a.enrollmentId);
    expect(a.proposal.commands).toBeUndefined();
    // The refusal must reach the caller. A silent no-op would still mark the approval
    // approved and the proposal 'applied' — the durable lie KT-HONESTY-1 was about.
    await expect(
      claimApproval(deps, { tenantId: TENANT, decidedBy: a.participant }, a.approval.approvalId),
    ).rejects.toBeTruthy();
    expect((await getEnrollment(TENANT, a.enrollmentId))?.planRevision).toBe(before?.planRevision ?? 0);
    expect((await listProposalsFor(TENANT, a.enrollmentId))[0]?.state).toBe('proposed');
    expect((await getApproval(a.approval.approvalId))?.status).toBe('pending');
  });

  it('a FOREIGN subject (including the coach) cannot claim — 404, approval untouched, no revision', async () => {
    const s = await scenario();
    const before = await getEnrollment(TENANT, s.enrollmentId);
    for (const foreigner of [s.coach, 'user:stranger']) {
      await expect(
        claimApproval(deps, { tenantId: TENANT, decidedBy: foreigner }, s.approval.approvalId),
      ).rejects.toMatchObject({ httpStatus: 404 });
    }
    // The approval stays pending and the plan was never revised.
    expect((await getApproval(s.approval.approvalId))?.status).toBe('pending');
    expect((await getEnrollment(TENANT, s.enrollmentId))?.planRevision).toBe(before?.planRevision ?? 0);
    // A participant can still resolve afterwards (the foreign attempt did not consume it).
    const ok = await claimApproval(deps, { tenantId: TENANT, decidedBy: s.participant }, s.approval.approvalId);
    expect(ok.status).toBe('approved');
  });

  it('a FOREIGN subject cannot REJECT either — 404, approval pending, proposal not dismissed', async () => {
    const s = await scenario();
    for (const foreigner of [s.coach, 'user:stranger']) {
      await expect(
        rejectApproval(deps, { tenantId: TENANT, decidedBy: foreigner }, s.approval.approvalId),
      ).rejects.toMatchObject({ httpStatus: 404 });
    }
    // The approval stays pending and the proposal was never dismissed.
    expect((await getApproval(s.approval.approvalId))?.status).toBe('pending');
    expect((await listProposalsFor(TENANT, s.enrollmentId))[0]?.state).toBe('proposed');
    // The participant can still decline afterwards (the foreign attempt did not consume it).
    const ok = await rejectApproval(deps, { tenantId: TENANT, decidedBy: s.participant }, s.approval.approvalId);
    expect(ok.status).toBe('rejected');
  });

  it('reject dismisses the proposal, records the approval, and never revises the plan', async () => {
    const s = await scenario();
    const before = await getEnrollment(TENANT, s.enrollmentId);
    const result = await rejectApproval(deps, { tenantId: TENANT, decidedBy: s.participant, note: 'not now' }, s.approval.approvalId);
    expect(result.status).toBe('rejected');
    expect((await listProposalsFor(TENANT, s.enrollmentId))[0]?.state).toBe('dismissed');
    expect((await getApproval(s.approval.approvalId))?.status).toBe('rejected');
    expect((await getEnrollment(TENANT, s.enrollmentId))?.planRevision).toBe(before?.planRevision ?? 0);
  });

  it('the retained route path RESOLVES the linked card (no stranded pending), and re-resolution is a no-op in BOTH orders', async () => {
    // Order A: resolve via the retained per-enrollment route (resolveProposal +
    // reconcileProposalCard — exactly what routes.ts runs). The card must ACTUALLY
    // resolve via this path, not stay pending waiting on a card claim.
    const a = await scenario();
    const routeResolved = await resolveProposal(TENANT, a.enrollmentId, a.proposal.id, a.participant, 'apply');
    await reconcileProposalCard(routeResolved, 'apply');
    const revAfterRoute = (await getEnrollment(TENANT, a.enrollmentId))?.planRevision ?? 0;
    // The card is now approved — the route reconciled it (the anti-strand pin).
    expect((await getApproval(a.approval.approvalId))?.status).toBe('approved');
    // A late claim on the now-resolved card is a no-op conflict (409) and never re-applies.
    await expect(
      claimApproval(deps, { tenantId: TENANT, decidedBy: a.participant }, a.approval.approvalId),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect((await getEnrollment(TENANT, a.enrollmentId))?.planRevision).toBe(revAfterRoute); // no SECOND apply

    // Order B: claim the card, THEN resolve via the route — an idempotent no-op both
    // on the proposal AND (via reconcile) on the already-approved card.
    const b = await scenario();
    await claimApproval(deps, { tenantId: TENANT, decidedBy: b.participant }, b.approval.approvalId);
    const revAfterCard = (await getEnrollment(TENANT, b.enrollmentId))?.planRevision ?? 0;
    const routeAfter = await resolveProposal(TENANT, b.enrollmentId, b.proposal.id, b.participant, 'apply');
    await reconcileProposalCard(routeAfter, 'apply');
    expect(routeAfter.state).toBe('applied'); // idempotent no-op
    expect((await getApproval(b.approval.approvalId))?.status).toBe('approved'); // still approved, unchanged
    expect((await getEnrollment(TENANT, b.enrollmentId))?.planRevision).toBe(revAfterCard); // no SECOND apply
  });

  it('reviewProjection surfaces the card under the circle conversationId filter — participant only', async () => {
    const s = await scenario();
    // The participant sees it, scoped to the circle conversation.
    const forParticipant = await listReviews(storage, { tenantId: TENANT, subjectRef: s.participant }, { conversationId: s.circle.conversationId });
    const card = forParticipant.find((r) => r.approvalId === s.approval.approvalId);
    expect(card).toBeTruthy();
    expect(card?.conversationId).toBe(s.circle.conversationId);
    expect(card?.kind).toBe('kicktodo-plan-proposal');
    // The coach (who authored the note) does NOT see the decision card in their rail.
    const forCoach = await listReviews(storage, { tenantId: TENANT, subjectRef: s.coach });
    expect(forCoach.some((r) => r.approvalId === s.approval.approvalId)).toBe(false);
  });

  it('ADR 0501 step 4 — the card carries the two ids to FETCH a preview, and no PII', async () => {
    const s = await scenario();
    const forParticipant = await listReviews(storage, { tenantId: TENANT, subjectRef: s.participant }, { conversationId: s.circle.conversationId });
    const card = forParticipant.find((r) => r.approvalId === s.approval.approvalId);

    // Enough to call GET …/enrollments/:id/proposals/:id/preview at RENDER time. The
    // preview is deliberately NOT projected: a stored diff is a snapshot that goes stale
    // between the coach's proposal and the participant's decision.
    expect(card?.planProposal).toEqual({ enrollmentId: s.enrollmentId, proposalId: s.proposal.id });

    // …and NOTHING else. The approval row also holds `note` (declared PII) and
    // `coachSubject`; copying either here would give a PII field a second exposure path
    // on a differently-gated projection. Asserted as an exact-shape check so a later
    // spread of the whole `a.planProposal` object fails loudly instead of leaking.
    expect(Object.keys(card?.planProposal ?? {}).sort()).toEqual(['enrollmentId', 'proposalId']);
    expect(JSON.stringify(card?.planProposal)).not.toContain(s.coach);
  });
});
