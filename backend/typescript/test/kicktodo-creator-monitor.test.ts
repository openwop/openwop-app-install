/**
 * ADR 0415 P4 — monitoring + the kill switch:
 *
 *  - source-health checks run over the dossier with an INJECTED fetcher
 *    (ok / redirected / broken / unreachable), never editing content
 *  - the kill switch retires the published version (kicktodo-core refuses
 *    NEW enrollments; an ACTIVE enrollment keeps working) and withdraws the
 *    candidate with the audited reason
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createCandidate, recordResearch, sourceHash, setCandidateSimulation } from '../src/features/kicktodo-creator/creatorService.js';
import { submitForPublication, completePublication } from '../src/features/kicktodo-creator/publishService.js';
import { checkSources, killSwitch } from '../src/features/kicktodo-creator/monitorService.js';
import { createDraft, getChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, getEnrollment, ChallengeNotEnrollableError } from '../src/features/kicktodo-core/enrollmentService.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';

const TENANT = 'tenant-kt-monitor';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
});

async function publishedCandidate() {
  const cand = await createCandidate({
    tenantId: TENANT, createdBy: 'user:author', topic: 'Evening reading habit',
    audience: 'adults', transformation: 'read daily', durationDaysTarget: 7, dailyMinutesTarget: 15,
  });
  const good = { url: 'https://example.org/reading', domain: 'example.org', title: 'Reading study', hash: sourceHash('https://example.org/reading', 'Reading study'), engine: 'searx' };
  const dead = { url: 'https://example.org/gone', domain: 'example.org', title: 'Gone', hash: sourceHash('https://example.org/gone', 'Gone'), engine: 'searx' };
  await recordResearch(TENANT, cand.id, {
    questions: [], sources: [good, dead],
    claims: [{ claimId: 'c1', text: 'Reading before bed aids wind-down', sourceHashes: [good.hash] }],
  });
  const draft = await createDraft({
    tenantId: TENANT, title: 'Evening Reading', summary: 's', outcome: 'o', durationDays: 7,
    activities: [{ stableActivityId: 'r1', day: 1, title: 'Read 10 pages', instructions: '', evidencePolicy: 'attestation' }],
  });
  // ADR 0458 P2 — the simulation gate is now real: publication requires a passing
  // verdict from all three sim personas.
  await setCandidateSimulation(TENANT, cand.id, [
    { sim: 'newcomer', verdict: 'pass', personaSummary: 'clear', findings: [] },
    { sim: 'time-poor', verdict: 'pass', personaSummary: 'fits', findings: [] },
    { sim: 'skeptic', verdict: 'pass', personaSummary: 'sourced', findings: [] },
  ]);
  await submitForPublication(TENANT, cand.id, draft.id, 1, 'user:author');
  await completePublication(TENANT, cand.id, 'user:approver');
  return { cand, draft };
}

describe('monitoring (injected fetcher)', () => {
  it('classifies ok / broken / unreachable without touching content', async () => {
    const { cand } = await publishedCandidate();
    const report = await checkSources(TENANT, cand.id, async (url) => {
      if (url.includes('gone')) return { status: 404, redirected: false };
      return { status: 200, redirected: false };
    });
    expect(report?.findings).toHaveLength(2);
    expect(report?.broken).toBe(1);
    expect(report?.findings.find((f) => f.url.includes('gone'))?.health).toBe('broken');
  });
});

describe('kill switch', () => {
  it('retires the published version (new enrollments refused; active ones keep working) and withdraws the candidate with the audited reason', async () => {
    const { cand, draft } = await publishedCandidate();

    // An ACTIVE enrollment exists before the kill.
    const { enrollment } = await enroll({ tenantId: TENANT, ownerSubject: 'user:runner', challengeId: draft.id, challengeVersion: 1 });

    const withdrawn = await killSwitch(TENANT, cand.id, 'source integrity incident', 'user:operator');
    expect(withdrawn.state).toBe('withdrawn');
    expect(withdrawn.riskSignals.join(' ')).toContain('source integrity incident');

    // The challenge version is retired — NEW enrollments are refused…
    expect((await getChallenge(TENANT, draft.id, 1))?.status).toBe('retired');
    await expect(
      enroll({ tenantId: TENANT, ownerSubject: 'user:late', challengeId: draft.id, challengeVersion: 1 }),
    ).rejects.toBeInstanceOf(ChallengeNotEnrollableError);

    // …while the EXISTING enrollment keeps its pinned version and stays active.
    const still = await getEnrollment(TENANT, enrollment.id);
    expect(still?.state).toBe('active');
    expect(still?.challengeVersion).toBe(1);
  });
});
