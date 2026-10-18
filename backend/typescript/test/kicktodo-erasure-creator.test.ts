/**
 * ADR 0458 P0 — kicktodo-creator data-subject erasure. Candidates and publication acts are
 * challenge-PROVENANCE/audit records that must OUTLIVE their author, so a DSAR ANONYMIZES
 * the person-links (`createdBy`, `submittedBy`, `completedBy`) in place — the row survives,
 * the person-link is severed. Other subjects and other tenants are untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import {
  ERASED_SUBJECT, __test as creatorTest, type FactoryCandidate,
} from '../src/features/kicktodo-creator/creatorService.js';
import {
  eraseCreatorSubject, __test as publishTest,
} from '../src/features/kicktodo-creator/publishService.js';
import { createChallengePublishApproval, getApproval } from '../src/host/approvalService.js';
import {
  anonymizeChallengeAuthor, createDraft, getChallenge, publishChallenge, ERASED_CHALLENGE_AUTHOR,
} from '../src/features/kicktodo-core/challengeService.js';

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
    // Only `Date` is faked: the sole observable effect of re-anonymizing an
    // already-`[erased]` row is an `updatedAt` bump, so the clock must move
    // between the two erasures for the sentinel guard to be witnessed (w40 probe
    // ecr-sentinel-guard-gone stayed green while this case only re-read cand-B).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
      await eraseCreatorSubject(T, A);
      await eraseCreatorSubject(T, A);
      const anonymized = await creatorTest.candidates.get(`${T}::cand-A`);
      expect(anonymized?.createdBy).toBe(ERASED_SUBJECT);

      // Erasing the sentinel itself must NOT cascade onto already-anonymized rows:
      // the row is byte-identical afterwards (no re-stamp, no updatedAt bump).
      vi.setSystemTime(new Date('2026-03-01T01:00:00.000Z'));
      await eraseCreatorSubject(T, ERASED_SUBJECT);
      expect(await creatorTest.candidates.get(`${T}::cand-A`)).toEqual(anonymized);
      expect((await creatorTest.candidates.get(`${T}::cand-B`))?.createdBy).toBe(B);

      // The falsy guard is only observable against a row whose author IS empty
      // (malformed/legacy): an unguarded '' would anonymize exactly that row.
      await seed(T, '', 'cand-blank');
      await eraseCreatorSubject(T, '');
      expect((await creatorTest.candidates.get(`${T}::cand-blank`))?.createdBy).toBe('');
      expect((await publishTest.publications.get(`${T}::cand-blank`))?.submittedBy).toBe('');
      expect((await creatorTest.candidates.get(`${T}::cand-B`))?.createdBy).toBe(B);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs from the host fan-out (registered at module load)', async () => {
    await eraseSubject(T, A);
    expect((await creatorTest.candidates.get(`${T}::cand-A`))?.createdBy).toBe(ERASED_SUBJECT);
    expect((await creatorTest.candidates.get(`${T}::cand-B`))?.createdBy).toBe(B);
  });
});

/**
 * KTFAC-3 (KickTodo wave 4C; decided by the product owner 2026-10-17) — the Factory
 * BRIEF (topic / audience / transformation, and the research questions framed from
 * them) is personal data and is erased with its creator; the provenance and the
 * published challenge stay. Before this, the DSAR replaced `createdBy` only, so the
 * creator's typed brief survived on the candidate and was quoted on the publish card.
 *
 * Breaks if: `eraseBrief` stops overwriting any brief field (the field asserts red);
 * the card redaction in `eraseCreatorSubject` is dropped or runs AFTER
 * `anonymizeCreatorAuthor` (the card still quotes the topic); `cancelPending: false`
 * is dropped (the pending publish is cancelled); `anonymizeChallengeAuthor` is
 * removed (the challenge still names the author). Each sabotage-witnessed.
 */
describe('KTFAC-3 — the Factory brief is erased with its creator', () => {
  it('erases the brief + quoted card text, keeps provenance, and leaves the publish decidable', async () => {
    const brief: FactoryCandidate = {
      ...candidate(T, A, 'cand-brief'),
      topic: 'Quit vaping after my divorce', audience: 'Me and my sister', transformation: 'Sleep through the night',
      dossier: {
        questions: ['What helps Me and my sister quit vaping after my divorce?', 'second question'],
        sources: [], claims: [], unsupportedClaimIds: [], engines: ['real'], recordedAt: '2026-01-02T00:00:00.000Z',
      },
      riskTier: 'general', riskSignals: ['quit'],
    };
    await creatorTest.candidates.put(brief);
    // The CREATOR (A) is not the SUBMITTER (B): the kind redactor matches only the submitter.
    const card = await createChallengePublishApproval({
      tenantId: T, candidateId: 'cand-brief', challengeId: 'c9', challengeVersion: 1, submittedBy: B,
      proposal: `Publish challenge "X" v1 from factory candidate "${brief.topic}" (risk tier: general).`,
    });
    await publishTest.publications.put({
      tenantId: T, candidateId: 'cand-brief', approvalId: card.approvalId, challengeId: 'c9', challengeVersion: 1,
      submittedBy: B, rightsDecisions: [],
    });

    await eraseCreatorSubject(T, A);

    const after = await creatorTest.candidates.get(`${T}::cand-brief`);
    expect(after).toMatchObject({
      createdBy: ERASED_SUBJECT, topic: ERASED_SUBJECT, audience: ERASED_SUBJECT, transformation: ERASED_SUBJECT,
      riskTier: 'general', riskSignals: ['quit'],
    });
    expect(after?.dossier?.questions).toEqual([ERASED_SUBJECT, ERASED_SUBJECT]); // shape kept, text gone
    expect(after?.dossier?.engines).toEqual(['real']);                           // provenance kept
    expect(JSON.stringify(after)).not.toMatch(/divorce|sister|Sleep through/);
    const redacted = await getApproval(card.approvalId);
    expect(redacted?.proposal).not.toContain('divorce');
    expect(redacted?.status).toBe('pending'); // the publish is still decidable
    // Another creator's brief is untouched.
    expect((await creatorTest.candidates.get(`${T}::cand-B`))?.topic).toBe('t');
  });

  it('a published challenge stays but stops naming its author; its content address is unchanged', async () => {
    const draft = await createDraft({
      tenantId: T, authorSubject: A, title: 'Kept', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
    });
    const published = await publishChallenge(T, draft.id, 1);
    const other = await createDraft({
      tenantId: T, authorSubject: B, title: 'Other', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
    });

    expect(await anonymizeChallengeAuthor(T, A)).toBe(1);
    const kept = await getChallenge(T, draft.id, 1);
    expect(kept).toMatchObject({ status: 'published', authorSubject: ERASED_CHALLENGE_AUTHOR, contentHash: published?.contentHash });
    expect((await getChallenge(T, other.id, 1))?.authorSubject).toBe(B);
    expect(await anonymizeChallengeAuthor(T, A)).toBe(0); // idempotent
  });
});
