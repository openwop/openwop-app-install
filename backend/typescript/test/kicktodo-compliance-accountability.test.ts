/**
 * ADR 0458 Phase 0 — kicktodo-accountability compliance seam + session scheduling
 * discipline.
 *
 * The package registers ONE subject-eraser (grants where the subject is grantor OR
 * grantee, coach-caseload pointers, seat occupancy + holds, coach proposals the subject
 * authored or that are about their enrollments, and sessions they created) and ONE
 * retention-purger (coach proposals, `confidential-pii`, aged on `createdAt`). Circle
 * PRODUCT resources are retained by design. Separately: scheduling a session must ARM a
 * scheduler job (the fire-at time is owned by the scheduling owner, not a poller).
 *
 * Rows are seeded through minimal DurableCollections over the REAL namespaces.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { eraseSubject, __resetSubjectErasers, __resetSubjectKeyResolvers } from '../src/host/subjectErasure.js';
import { purgeRetained, __resetRetentionPurgers } from '../src/host/retentionPurger.js';
import { getJob, resetScheduling } from '../src/host/schedulingService.js';
import { registerKicktodoAccountabilityCompliance } from '../src/features/kicktodo-accountability/compliance.js';
import { scheduleSession, sessionReminderJobId } from '../src/features/kicktodo-accountability/sessionService.js';
import {
  createKicktodoPlanProposalApproval,
  createContentApproval,
  getApproval,
  listApprovals,
  PLAN_PROPOSAL_ERASED_NOTE,
} from '../src/host/approvalService.js';

const DAY = 86_400_000;
const now = 1_900_000_000_000;
const cutoffIso = new Date(now - 365 * DAY).toISOString();
const OLD = new Date(now - 400 * DAY).toISOString();
const FRESH = new Date(now - 10 * DAY).toISOString();

const enrollCol = () => new DurableCollection<{ id: string; tenantId: string; ownerSubject: string; createdAt: string }>(
  'kicktodo-enrollments', (e) => `${e.tenantId}::${e.id}`);
const grantCol = () => new DurableCollection<{ tenantId: string; circleId: string; grantorSubject: string; granteeSubject: string }>(
  'kicktodo-grants', (g) => `${g.tenantId}::${g.circleId}::${g.granteeSubject}`);
const granteeIdxCol = () => new DurableCollection<{ granteeSubject: string; circleId: string; tenantId: string }>(
  'kicktodo-grantee-index', (r) => `${r.granteeSubject}::${r.circleId}`);
const seatCol = () => new DurableCollection<{ tenantId: string; circleId: string; subject: string; claimedAt: string }>(
  'kicktodo-cohort-seats', (x) => `${x.tenantId}::${x.circleId}::${x.subject}`);
const holdCol = () => new DurableCollection<{ tenantId: string; circleId: string; buyerSubject: string; heldAt: string; expiresAt: string }>(
  'kicktodo-seat-holds', (h) => `${h.tenantId}::${h.circleId}::${h.buyerSubject}`);
const proposalCol = () => new DurableCollection<{ id: string; tenantId: string; circleId: string; enrollmentId: string; coachSubject: string; note: string; state: string; createdAt: string }>(
  'kicktodo-plan-proposals', (p) => `${p.tenantId}::${p.enrollmentId}::${p.id}`);
const sessionCol = () => new DurableCollection<{ tenantId: string; circleId: string; atIso: string; title: string; createdBy: string; conversationId: string; createdAt: string }>(
  'kicktodo-cohort-sessions', (s) => `${s.tenantId}::${s.circleId}::${s.atIso}`);
const circleCol = () => new DurableCollection<{ id: string; tenantId: string; type: string; enrollmentId: string; ownerSubject: string; name: string; conversationId: string; createdAt: string }>(
  'kicktodo-circles', (c) => `${c.tenantId}::${c.id}`);

const T = 'tenant-kt-acct';
const T2 = 'tenant-kt-acct-other';
const A = 'user:alice';
const B = 'user:bob';
const C = 'user:carol';
const OWNER = 'user:owner';
const COACH = 'user:coach';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  __resetRetentionPurgers();
  await resetScheduling();
  registerKicktodoAccountabilityCompliance();
});

describe('kicktodo-accountability subject eraser', () => {
  it('erases A (as grantor OR grantee), pointers/seats/holds, coach + about-A proposals, and A-created sessions; leaves B + other tenant intact', async () => {
    // A's enrollment (so proposals ABOUT it are reachable), B's enrollment.
    await enrollCol().put({ id: 'enrA', tenantId: T, ownerSubject: A, createdAt: FRESH });
    await enrollCol().put({ id: 'enrB', tenantId: T, ownerSubject: B, createdAt: FRESH });
    // grants: A as grantee (circ1), B as grantee (circ1), A as grantor (circ2 → C)
    await grantCol().put({ tenantId: T, circleId: 'circ1', grantorSubject: OWNER, granteeSubject: A });
    await grantCol().put({ tenantId: T, circleId: 'circ1', grantorSubject: OWNER, granteeSubject: B });
    await grantCol().put({ tenantId: T, circleId: 'circ2', grantorSubject: A, granteeSubject: C });
    // grantee pointers
    await granteeIdxCol().put({ granteeSubject: A, circleId: 'circ1', tenantId: T });
    await granteeIdxCol().put({ granteeSubject: B, circleId: 'circ1', tenantId: T });
    // seats + holds
    await seatCol().put({ tenantId: T, circleId: 'circ1', subject: A, claimedAt: FRESH });
    await seatCol().put({ tenantId: T, circleId: 'circ1', subject: B, claimedAt: FRESH });
    await holdCol().put({ tenantId: T, circleId: 'circ1', buyerSubject: A, heldAt: FRESH, expiresAt: FRESH });
    // proposals: coach=A; coach=COACH about A's enrollment; coach=COACH about B's enrollment
    await proposalCol().put({ id: 'p1', tenantId: T, circleId: 'circ1', enrollmentId: 'enrX', coachSubject: A, note: 'n', state: 'proposed', createdAt: FRESH });
    await proposalCol().put({ id: 'p2', tenantId: T, circleId: 'circ1', enrollmentId: 'enrA', coachSubject: COACH, note: 'n', state: 'proposed', createdAt: FRESH });
    await proposalCol().put({ id: 'p3', tenantId: T, circleId: 'circ1', enrollmentId: 'enrB', coachSubject: COACH, note: 'n', state: 'proposed', createdAt: FRESH });
    // sessions: created by A, created by B
    await sessionCol().put({ tenantId: T, circleId: 'circ1', atIso: '2026-02-01T10:00:00.000Z', title: 't', createdBy: A, conversationId: 'cv', createdAt: FRESH });
    await sessionCol().put({ tenantId: T, circleId: 'circ1', atIso: '2026-02-02T10:00:00.000Z', title: 't', createdBy: B, conversationId: 'cv', createdAt: FRESH });
    // other tenant: A grantee grant — must survive
    await grantCol().put({ tenantId: T2, circleId: 'circ1', grantorSubject: OWNER, granteeSubject: A });

    const res = await eraseSubject(T, A);
    expect(res.failed).toBe(0);

    // A gone
    expect(await grantCol().get(`${T}::circ1::${A}`)).toBeNull();       // grantee=A
    expect(await grantCol().get(`${T}::circ2::${C}`)).toBeNull();       // grantor=A
    expect(await granteeIdxCol().get(`${A}::circ1`)).toBeNull();
    expect(await seatCol().get(`${T}::circ1::${A}`)).toBeNull();
    expect(await holdCol().get(`${T}::circ1::${A}`)).toBeNull();
    expect(await proposalCol().get(`${T}::enrX::p1`)).toBeNull();       // coach=A
    expect(await proposalCol().get(`${T}::enrA::p2`)).toBeNull();       // about A's enrollment
    expect(await sessionCol().get(`${T}::circ1::2026-02-01T10:00:00.000Z`)).toBeNull();

    // B + others intact
    expect(await grantCol().get(`${T}::circ1::${B}`)).not.toBeNull();
    expect(await granteeIdxCol().get(`${B}::circ1`)).not.toBeNull();
    expect(await seatCol().get(`${T}::circ1::${B}`)).not.toBeNull();
    expect(await proposalCol().get(`${T}::enrB::p3`)).not.toBeNull();
    expect(await sessionCol().get(`${T}::circ1::2026-02-02T10:00:00.000Z`)).not.toBeNull();
    // other tenant intact
    expect(await grantCol().get(`${T2}::circ1::${A}`)).not.toBeNull();
  });

  it('is idempotent', async () => {
    await grantCol().put({ tenantId: T, circleId: 'circ1', grantorSubject: OWNER, granteeSubject: A });
    await eraseSubject(T, A);
    const res = await eraseSubject(T, A);
    expect(res.failed).toBe(0);
    expect(await grantCol().get(`${T}::circ1::${A}`)).toBeNull();
  });
});

describe('kicktodo-accountability plan-proposal APPROVAL copies (ADR 0459 grade-fix)', () => {
  const mkCard = (over: { tenantId: string; circleId: string; enrollmentId: string; proposalId: string; coachSubject: string; participantSubject: string; note: string }) =>
    createKicktodoPlanProposalApproval({
      conversationId: 'cv',
      proposal: `Plan change proposed by your coach: ${over.note}`,
      ...over,
    });

  it('erasing the COACH redacts BOTH note copies on their cards; other coach + other tenant + other kinds untouched', async () => {
    const cardA = await mkCard({ tenantId: T, circleId: 'circ1', enrollmentId: 'enrP', proposalId: 'p1', coachSubject: COACH, participantSubject: A, note: 'move rest days' });
    const cardOther = await mkCard({ tenantId: T, circleId: 'circ2', enrollmentId: 'enrQ', proposalId: 'p2', coachSubject: 'user:othercoach', participantSubject: B, note: 'other note' });
    const cardT2 = await mkCard({ tenantId: T2, circleId: 'circ3', enrollmentId: 'enrR', proposalId: 'p3', coachSubject: COACH, participantSubject: A, note: 't2 note' });
    // A DIFFERENT-kind approval must never be touched by the kind-scoped op.
    const content = await createContentApproval({ tenantId: T, orgId: 'org1', pageId: 'pg1', pageTitle: 'P', proposal: 'publish P' });

    await eraseSubject(T, COACH);

    // The coach's card: BOTH copies redacted, status left decidable (pending).
    const a = await getApproval(cardA.approvalId);
    expect(a?.planProposal?.note).toBe(PLAN_PROPOSAL_ERASED_NOTE);
    expect(a?.proposal).toBe(PLAN_PROPOSAL_ERASED_NOTE);
    expect(a?.status).toBe('pending');
    // Another coach's card in the same tenant: untouched.
    const o = await getApproval(cardOther.approvalId);
    expect(o?.planProposal?.note).toBe('other note');
    expect(o?.proposal).toBe('Plan change proposed by your coach: other note');
    // The SAME coach's card in another tenant: untouched (tenant-scoped).
    expect((await getApproval(cardT2.approvalId))?.planProposal?.note).toBe('t2 note');
    // The other-kind approval: untouched (kind-scoped).
    expect((await getApproval(content.approvalId))?.proposal).toBe('publish P');
  });

  it('erasing the PARTICIPANT deletes their plan-proposal cards (row + index); others + other kinds survive', async () => {
    const cardForA = await mkCard({ tenantId: T, circleId: 'circ1', enrollmentId: 'enrP', proposalId: 'p1', coachSubject: COACH, participantSubject: A, note: 'about A' });
    const cardForB = await mkCard({ tenantId: T, circleId: 'circ2', enrollmentId: 'enrQ', proposalId: 'p2', coachSubject: COACH, participantSubject: B, note: 'about B' });
    const content = await createContentApproval({ tenantId: T, orgId: 'org1', pageId: 'pg1', pageTitle: 'P', proposal: 'publish P' });

    await eraseSubject(T, A);

    // A's card removed outright, and gone from the (tenant, status) index.
    expect(await getApproval(cardForA.approvalId)).toBeNull();
    expect((await listApprovals(T, 'pending')).some((x) => x.approvalId === cardForA.approvalId)).toBe(false);
    // B's card + the content approval survive.
    expect(await getApproval(cardForB.approvalId)).not.toBeNull();
    expect(await getApproval(content.approvalId)).not.toBeNull();
  });
});

describe('kicktodo-accountability retention purger (coach proposals, confidential-pii)', () => {
  it('deletes strictly-older proposals, keeps fresh + cutoff-equal, no-ops on wrong classification / falsy tenant', async () => {
    await proposalCol().put({ id: 'old', tenantId: T, circleId: 'c', enrollmentId: 'e', coachSubject: COACH, note: 'n', state: 'proposed', createdAt: OLD });
    await proposalCol().put({ id: 'fresh', tenantId: T, circleId: 'c', enrollmentId: 'e', coachSubject: COACH, note: 'n', state: 'proposed', createdAt: FRESH });
    await proposalCol().put({ id: 'edge', tenantId: T, circleId: 'c', enrollmentId: 'e', coachSubject: COACH, note: 'n', state: 'proposed', createdAt: cutoffIso });
    await proposalCol().put({ id: 'other', tenantId: T2, circleId: 'c', enrollmentId: 'e', coachSubject: COACH, note: 'n', state: 'proposed', createdAt: OLD });

    expect(await purgeRetained(T, 'internal', cutoffIso).then((r) => r.find((x) => x.feature === 'kicktodo-accountability')?.deleted)).toBe(0);
    expect(await purgeRetained('', 'confidential-pii', cutoffIso)).toEqual([]);

    const run = await purgeRetained(T, 'confidential-pii', cutoffIso);
    expect(run.find((r) => r.feature === 'kicktodo-accountability')).toMatchObject({ deleted: 1, ok: true });
    expect(await proposalCol().get(`${T}::e::old`)).toBeNull();
    expect(await proposalCol().get(`${T}::e::fresh`)).not.toBeNull();
    expect(await proposalCol().get(`${T}::e::edge`)).not.toBeNull(); // == cutoff → retained
    expect(await proposalCol().get(`${T2}::e::other`)).not.toBeNull(); // other tenant intact
  });
});

describe('kicktodo-accountability session scheduling discipline', () => {
  it('scheduling a session ARMS a one-shot reminder job in the scheduling owner', async () => {
    // Seed the circle the coach owns (getCircleFor passes on ownerSubject match).
    await circleCol().put({ id: 'circA', tenantId: T, type: 'coach', enrollmentId: 'enr1', ownerSubject: OWNER, name: 'Coaching', conversationId: 'cv-circA', createdAt: FRESH });
    const future = new Date(Date.now() + 3 * DAY).toISOString();

    const row = await scheduleSession(T, 'circA', OWNER, future, 'Weekly check-in');

    const job = await getJob(sessionReminderJobId(T, 'circA', row.atIso));
    expect(job).not.toBeNull();
    expect(job).toMatchObject({ tenantId: T, enabled: true });
    // The fire-at time lives in the scheduler (one-shot, ~1h before the session).
    expect(typeof job!.nextFireAt).toBe('number');
    expect(job!.nextFireAt!).toBeLessThan(Date.parse(row.atIso));
  });
});
