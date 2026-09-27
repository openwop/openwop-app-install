/**
 * ADR 0458 P0 — kicktodo-creator data-subject erasure. Candidates and publication acts are
 * challenge-PROVENANCE/audit records that must OUTLIVE their author, so a DSAR ANONYMIZES
 * the person-links (`createdBy`, `submittedBy`, `completedBy`) in place — the row survives,
 * the person-link is severed. Other subjects and other tenants are untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import {
  ERASED_SUBJECT, __test as creatorTest, type FactoryCandidate,
} from '../src/features/kicktodo-creator/creatorService.js';
import {
  eraseCreatorSubject, __test as publishTest,
} from '../src/features/kicktodo-creator/publishService.js';

const T = 'tenant-A';
const T2 = 'tenant-B';
const A = 'user:alice';
const B = 'user:bob';

function candidate(tenantId: string, subject: string, id: string): FactoryCandidate {
  return {
    id, tenantId, topic: 't', audience: 'a', transformation: 'x', durationDaysTarget: 7,
    dailyMinutesTarget: 10, riskTier: 'general', riskSignals: [], state: 'intake',
    createdBy: subject, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

async function seed(tenantId: string, subject: string, candId: string): Promise<void> {
  await creatorTest.candidates.put(candidate(tenantId, subject, candId));
  await publishTest.publications.put({
    tenantId, candidateId: candId, approvalId: `ap-${candId}`, challengeId: 'c1', challengeVersion: 1,
    submittedBy: subject, completedBy: subject, rightsDecisions: [],
  });
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await seed(T, A, 'cand-A');
  await seed(T, B, 'cand-B');
  await seed(T2, A, 'cand-A2');
});

describe('ADR 0458 P0 — creator subject erasure (anonymize-in-place)', () => {
  it('anonymizes the author link on candidates + publications; the rows survive', async () => {
    await eraseCreatorSubject(T, A);

    const cand = await creatorTest.candidates.get(`${T}::cand-A`);
    expect(cand).not.toBeNull();          // provenance row SURVIVES
    expect(cand?.createdBy).toBe(ERASED_SUBJECT);
    const pub = await publishTest.publications.get(`${T}::cand-A`);
    expect(pub).not.toBeNull();
    expect(pub?.submittedBy).toBe(ERASED_SUBJECT);
    expect(pub?.completedBy).toBe(ERASED_SUBJECT);

    // Other subject in-tenant untouched.
    expect((await creatorTest.candidates.get(`${T}::cand-B`))?.createdBy).toBe(B);
    expect((await publishTest.publications.get(`${T}::cand-B`))?.submittedBy).toBe(B);
    // Same subject id in another tenant untouched.
    expect((await creatorTest.candidates.get(`${T2}::cand-A2`))?.createdBy).toBe(A);
    expect((await publishTest.publications.get(`${T2}::cand-A2`))?.submittedBy).toBe(A);
  });

  it('is idempotent (sentinel guards re-anonymize) and no-ops on a falsy subject', async () => {
    await eraseCreatorSubject(T, A);
    await eraseCreatorSubject(T, A);
    expect((await creatorTest.candidates.get(`${T}::cand-A`))?.createdBy).toBe(ERASED_SUBJECT);
    // Erasing the sentinel itself must NOT cascade onto every already-anonymized row.
    await eraseCreatorSubject(T, ERASED_SUBJECT);
    expect((await creatorTest.candidates.get(`${T}::cand-B`))?.createdBy).toBe(B);
    await eraseCreatorSubject(T, '');
    expect((await creatorTest.candidates.get(`${T}::cand-B`))?.createdBy).toBe(B);
  });

  it('runs from the host fan-out (registered at module load)', async () => {
    await eraseSubject(T, A);
    expect((await creatorTest.candidates.get(`${T}::cand-A`))?.createdBy).toBe(ERASED_SUBJECT);
    expect((await creatorTest.candidates.get(`${T}::cand-B`))?.createdBy).toBe(B);
  });
});
