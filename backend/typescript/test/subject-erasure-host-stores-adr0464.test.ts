/**
 * ADR 0464 Phase 2 — subject-erasure coverage for the four approvals-cluster host
 * stores: the approvals payload-redactor registry (approvalService), delegations
 * (approvalDelegations), Teams-delivery prefs (teamsApprovalDelivery), and the
 * review-decision ledger (reviewDecisionLedger).
 *
 * The taxonomy under test (ADR 0464 §2): a subject's OWN structurally-standalone
 * data is DELETED; structurally-needed rows are ANONYMIZED (ids → the erased
 * sentinel, free text redacted) IN PLACE with their shape (quorum tallies,
 * approver-list length, deterministic keys) preserved; another subject's and
 * another tenant's data is left intact; every eraser is idempotent.
 *
 * (The `kicktodo-plan-proposal` migration is pinned byte-identical by
 * test/kicktodo-compliance-accountability.test.ts and is not re-proved here.)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createChallengePublishApproval,
  createCommunityApproval,
  createConnectSellerApproval,
  createContentApproval,
  eraseApprovalSubject,
  getApproval,
  ERASED_SUBJECT_SENTINEL as ERASED,
  __resetApprovalStore,
} from '../src/host/approvalService.js';
import {
  createDelegation,
  revokeDelegation,
  getDelegation,
  listDelegations,
  eraseDelegationsForSubject,
  _clearDelegationsForTest,
} from '../src/host/approvalDelegations.js';
import {
  setTeamsDeliveryPref,
  getTeamsDeliveryPref,
  eraseTeamsDeliveryForSubject,
} from '../src/host/teamsApprovalDelivery.js';
import {
  appendDecision,
  tallyDecisions,
  clearDecisions,
  evaluateQuorumTally,
  eraseReviewDecisionsForSubject,
  __clearDecisionLedger,
} from '../src/host/reviewDecisionLedger.js';

const T = 'tenant-0463';
const T2 = 'tenant-0463-other';
const A = 'user:alice';
const B = 'user:bob';
const iso = (o: number) => new Date(Date.now() + o).toISOString();

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetApprovalStore();
  await __clearDecisionLedger();
  await _clearDelegationsForTest(T);
  await _clearDelegationsForTest(T2);
});

describe('ADR 0464 — approvals payload-redactor registry (store-level eraser)', () => {
  it('redacts the SUBMITTER id + proposal on their submission kinds; other subject + other tenant intact', async () => {
    const chalA = await createChallengePublishApproval({ tenantId: T, proposal: 'ship A', candidateId: 'c1', challengeId: 'ch1', challengeVersion: 1, submittedBy: A });
    const chalB = await createChallengePublishApproval({ tenantId: T, proposal: 'ship B', candidateId: 'c2', challengeId: 'ch2', challengeVersion: 1, submittedBy: B });
    const commA = await createCommunityApproval({ tenantId: T, kind: 'community-profile', proposal: 'profile A', refId: 'r1', submittedBy: A });
    const sellA = await createConnectSellerApproval({ tenantId: T, proposal: 'onboard A', submittedBy: A });
    const chalT2 = await createChallengePublishApproval({ tenantId: T2, proposal: 'ship A', candidateId: 'c3', challengeId: 'ch3', challengeVersion: 1, submittedBy: A });

    const touched = await eraseApprovalSubject(T, A);
    expect(touched).toBe(3); // chalA, commA, sellA

    const a1 = await getApproval(chalA.approvalId);
    expect(a1?.challengePublish?.submittedBy).toBe(ERASED);
    expect(a1?.proposal).toBe(ERASED);
    expect(a1?.status).toBe('pending'); // still decidable — status untouched
    expect((await getApproval(commA.approvalId))?.community?.submittedBy).toBe(ERASED);
    expect((await getApproval(sellA.approvalId))?.connectSeller?.submittedBy).toBe(ERASED);

    // B's submission + the other tenant's untouched.
    const b1 = await getApproval(chalB.approvalId);
    expect(b1?.challengePublish?.submittedBy).toBe(B);
    expect(b1?.proposal).toBe('ship B');
    expect((await getApproval(chalT2.approvalId))?.challengePublish?.submittedBy).toBe(A);
  });

  it('anonymizes an APPROVER ref in place, preserving the list length (quorum shape)', async () => {
    const gate = await createContentApproval({
      tenantId: T, orgId: 'org1', pageId: 'pg1', pageTitle: 'P', proposal: 'publish P',
      policy: { requiredApprovals: 2, approverRefs: [A, B] },
    });

    await eraseApprovalSubject(T, A);

    const g = await getApproval(gate.approvalId);
    expect(g?.policy?.approverRefs).toEqual([ERASED, B]); // A → sentinel, order + length kept
    expect(g?.policy?.requiredApprovals).toBe(2); // quorum threshold unchanged
    expect(g?.proposal).toBe('publish P'); // an approver's erasure never scrubs the author's proposal
  });

  it('is idempotent', async () => {
    await createChallengePublishApproval({ tenantId: T, proposal: 'ship A', candidateId: 'c1', challengeId: 'ch1', challengeVersion: 1, submittedBy: A });
    expect(await eraseApprovalSubject(T, A)).toBe(1);
    expect(await eraseApprovalSubject(T, A)).toBe(0);
  });
});

describe('ADR 0464 — approval:delegation eraser', () => {
  it('deletes delegations to/from the subject; anonymizes their createdBy/revokedBy + reason on others; other tenant intact', async () => {
    const from = await createDelegation({ tenantId: T, fromSubject: A, toSubject: B, startsAt: iso(-1000), endsAt: iso(1_000_000), reason: 'A away', createdBy: A });
    const to = await createDelegation({ tenantId: T, fromSubject: B, toSubject: A, startsAt: iso(-1000), endsAt: iso(1_000_000), reason: 'cover A', createdBy: B });
    // A delegation between two OTHERS that A created + revoked (A is not a party).
    const other = await createDelegation({ tenantId: T, fromSubject: B, toSubject: 'user:carol', startsAt: iso(-1000), endsAt: iso(1_000_000), reason: 'A set this up', createdBy: A });
    await revokeDelegation(T, other.delegationId, A);
    // Same shape in another tenant — must survive.
    const t2 = await createDelegation({ tenantId: T2, fromSubject: A, toSubject: B, startsAt: iso(-1000), endsAt: iso(1_000_000), createdBy: A });

    const touched = await eraseDelegationsForSubject(T, A);
    expect(touched).toBe(3); // from + to deleted, other anonymized

    expect(await getDelegation(T, from.delegationId)).toBeNull();
    expect(await getDelegation(T, to.delegationId)).toBeNull();
    const o = await getDelegation(T, other.delegationId);
    expect(o).not.toBeNull();
    expect(o?.createdBy).toBe(ERASED);
    expect(o?.revokedBy).toBe(ERASED);
    expect(o?.reason).toBe(ERASED);
    expect(o?.fromSubject).toBe(B); // the surviving parties untouched
    expect(o?.toSubject).toBe('user:carol');
    // Other tenant intact.
    expect(await getDelegation(T2, t2.delegationId)).not.toBeNull();
  });

  it('is idempotent', async () => {
    await createDelegation({ tenantId: T, fromSubject: A, toSubject: B, startsAt: iso(-1000), endsAt: iso(1_000_000), createdBy: B });
    expect(await eraseDelegationsForSubject(T, A)).toBe(1);
    expect(await eraseDelegationsForSubject(T, A)).toBe(0);
    expect((await listDelegations(T)).length).toBe(0);
  });
});

describe('ADR 0464 — approval:teams-delivery eraser', () => {
  it('deletes the subject row; other subject + other tenant intact; idempotent', async () => {
    await setTeamsDeliveryPref({ tenantId: T, userId: A, connectionId: 'cx', chatId: 'chatA' });
    await setTeamsDeliveryPref({ tenantId: T, userId: B, connectionId: 'cx', chatId: 'chatB' });
    await setTeamsDeliveryPref({ tenantId: T2, userId: A, connectionId: 'cx', chatId: 'chatA2' });

    expect(await eraseTeamsDeliveryForSubject(T, A)).toBe(1);
    expect(await getTeamsDeliveryPref(T, A)).toBeNull();
    expect(await getTeamsDeliveryPref(T, B)).not.toBeNull();
    expect(await getTeamsDeliveryPref(T2, A)).not.toBeNull();
    expect(await eraseTeamsDeliveryForSubject(T, A)).toBe(0); // idempotent
  });
});

describe('ADR 0464 — review:decision eraser (quorum shape preserved)', () => {
  it('anonymizes reviewerRef/actedBy + redacts reason WITHOUT changing the tally; key stays clearable', async () => {
    // Gate g1: a met 2-of-2 quorum voted by A and B.
    await appendDecision({ gateId: 'appr:g1', reviewerRef: A, tenantId: T, outcome: 'approved', reason: 'looks good to A', decidedAt: iso(0) });
    await appendDecision({ gateId: 'appr:g1', reviewerRef: B, tenantId: T, outcome: 'approved', decidedAt: iso(1) });
    // Gate g2: a delegate A voted on principal P's behalf.
    await appendDecision({ gateId: 'appr:g2', reviewerRef: 'user:principal', actedBy: A, tenantId: T, outcome: 'approved', reason: 'A clicked', decidedAt: iso(2) });
    // Other tenant's decision by A — must survive.
    await appendDecision({ gateId: 'appr:g3', reviewerRef: A, tenantId: T2, outcome: 'approved', decidedAt: iso(3) });

    const before = await tallyDecisions('appr:g1');
    expect(evaluateQuorumTally(before, { requiredApprovals: 2 })).toBe('accept');

    const touched = await eraseReviewDecisionsForSubject(T, A);
    expect(touched).toBe(2); // g1 (reviewerRef) + g2 (actedBy)

    // Tally COUNT unchanged → a resolved gate's outcome cannot change.
    const after = await tallyDecisions('appr:g1');
    expect(after.accepts.length).toBe(2);
    expect(evaluateQuorumTally(after, { requiredApprovals: 2 })).toBe('accept');
    // A's readable ref is scrubbed; B's is intact.
    expect(after.accepts).toContain(ERASED);
    expect(after.accepts).not.toContain(A);
    expect(after.accepts).toContain(B);

    // g2: actedBy anonymized, the principal reviewerRef (the counted identity) intact.
    const g2 = await tallyDecisions('appr:g2');
    expect(g2.accepts).toEqual(['user:principal']);

    // Other tenant untouched.
    expect((await tallyDecisions('appr:g3')).accepts).toEqual([A]);

    // The frozen key still clears (deletes the anonymized row at its real key).
    await clearDecisions('appr:g1');
    expect((await tallyDecisions('appr:g1')).accepts.length).toBe(0);
  });

  it('reaches LEGACY rows without a tenantId via the ref-match full-scan fallback', async () => {
    await appendDecision({ gateId: 'appr:legacy', reviewerRef: A, outcome: 'approved', reason: 'old', decidedAt: iso(0) });
    const touched = await eraseReviewDecisionsForSubject(T, A);
    expect(touched).toBe(1);
    const tally = await tallyDecisions('appr:legacy');
    expect(tally.accepts).toEqual([ERASED]); // count preserved, ref scrubbed
  });

  it('is idempotent', async () => {
    await appendDecision({ gateId: 'appr:g1', reviewerRef: A, tenantId: T, outcome: 'approved', reason: 'r', decidedAt: iso(0) });
    expect(await eraseReviewDecisionsForSubject(T, A)).toBe(1);
    expect(await eraseReviewDecisionsForSubject(T, A)).toBe(0);
  });
});

describe('ADR 0464 — cross-FORM matching (seed raw, erase scoped)', () => {
  // The DSAR entry point accepts either the raw principal (`alice`) or the
  // scoped form (`user:alice`); these stores persist the RAW form. Grade-data
  // finding: an exact-match eraser is silently incomplete for a scoped DSAR —
  // every approvals-cluster eraser must expand `subjectKeyForms`.
  const RAW = 'carla';
  const SCOPED = `user:${RAW}`;

  it('approval store: raw-stored submitter + approver erased by a scoped DSAR key', async () => {
    const sub = await createChallengePublishApproval({ tenantId: T, proposal: 'ship C', candidateId: 'c9', challengeId: 'ch9', challengeVersion: 1, submittedBy: RAW });
    const gate = await createContentApproval({
      tenantId: T, orgId: 'org1', pageId: 'pg9', pageTitle: 'P', proposal: 'publish P',
      policy: { requiredApprovals: 2, approverRefs: [RAW, B] },
    });
    expect(await eraseApprovalSubject(T, SCOPED)).toBe(2);
    expect((await getApproval(sub.approvalId))?.challengePublish?.submittedBy).toBe(ERASED);
    expect((await getApproval(gate.approvalId))?.policy?.approverRefs).toEqual([ERASED, B]);
  });

  it('delegation store: raw-stored parties erased by a scoped DSAR key', async () => {
    const d = await createDelegation({ tenantId: T, fromSubject: RAW, toSubject: B, startsAt: iso(-1000), endsAt: iso(1_000_000), createdBy: B });
    expect(await eraseDelegationsForSubject(T, SCOPED)).toBe(1);
    expect(await getDelegation(T, d.delegationId)).toBeNull();
  });

  it('teams-delivery store: raw-keyed row erased by a scoped DSAR key', async () => {
    await setTeamsDeliveryPref({ tenantId: T, userId: RAW, connectionId: 'cx', chatId: 'chatC' });
    expect(await eraseTeamsDeliveryForSubject(T, SCOPED)).toBe(1);
    expect(await getTeamsDeliveryPref(T, RAW)).toBeNull();
  });

  it('review-decision ledger: raw-stored reviewerRef erased by a scoped DSAR key', async () => {
    await appendDecision({ gateId: 'appr:xform', reviewerRef: RAW, tenantId: T, outcome: 'approved', decidedAt: iso(0) });
    expect(await eraseReviewDecisionsForSubject(T, SCOPED)).toBe(1);
    expect((await tallyDecisions('appr:xform')).accepts).toEqual([ERASED]);
  });
});
