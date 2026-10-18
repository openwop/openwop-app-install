/**
 * ADR 0415 P4 — monitoring + the kill switch:
 *
 *  - source-health checks run over the dossier with an INJECTED fetcher
 *    (ok / redirected / broken / unreachable — each a real source), never editing
 *    content, and the report is PERSISTED (read back via `getMonitorReport`)
 *  - the kill switch retires the published version (kicktodo-core refuses
 *    NEW enrollments; an ACTIVE enrollment keeps working) and withdraws the
 *    candidate with the audited reason
 *
 * Honest ceiling: "an ACTIVE enrollment keeps working" has no product branch that
 * could break it today (`retireChallenge` never touches enrollments) — kept as the
 * PRD §13 retirement-contract pin.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createCandidate, getCandidate, recordResearch, sourceHash, setCandidateSimulation } from '../src/features/kicktodo-creator/creatorService.js';
import { submitForPublication, completePublication } from '../src/features/kicktodo-creator/publishService.js';
import { checkSources, getMonitorReport, killSwitch } from '../src/features/kicktodo-creator/monitorService.js';
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
  // Uncited (so the claims gate still passes): one the fetcher reports MOVED, one it THROWS for.
  const moved = { url: 'https://example.org/moved', domain: 'example.org', title: 'Moved', hash: sourceHash('https://example.org/moved', 'Moved'), engine: 'searx' };
  const unreachable = { url: 'https://example.org/unreachable', domain: 'example.org', title: 'Unreachable', hash: sourceHash('https://example.org/unreachable', 'Unreachable'), engine: 'searx' };
  await recordResearch(TENANT, cand.id, {
    questions: [], sources: [good, dead, moved, unreachable],
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
    const dossierBefore = (await getCandidate(TENANT, cand.id))?.dossier;
    const report = await checkSources(TENANT, cand.id, async (url) => {
      if (url.endsWith('/unreachable')) throw new Error('connect ECONNREFUSED');
      if (url.endsWith('/gone')) return { status: 404, redirected: false };
      return { status: 200, redirected: url.endsWith('/moved') };
    });
    const health = Object.fromEntries((report?.findings ?? []).map((f) => [f.url, [f.health, f.httpStatus]]));
    expect(health).toEqual({
      'https://example.org/reading': ['ok', 200],
      'https://example.org/gone': ['broken', 404],
      'https://example.org/moved': ['redirected', 200],
      'https://example.org/unreachable': ['unreachable', undefined],
    });
    expect(report?.broken).toBe(2); // broken + unreachable count; redirected does not
    // …never touching content: the dossier is exactly what it was.
    expect((await getCandidate(TENANT, cand.id))?.dossier).toEqual(dossierBefore);
    // …and the report is persisted, not just returned.
    expect(await getMonitorReport(TENANT, cand.id)).toEqual(report);
  });
});

describe('kill switch', () => {
  it('retires the published version (new enrollments refused; active ones keep working) and withdraws the candidate with the audited reason', async () => {
    const { cand, draft } = await publishedCandidate();

    // An ACTIVE enrollment exists before the kill.
    const { enrollment } = await enroll({ tenantId: TENANT, ownerSubject: 'user:runner', challengeId: draft.id, challengeVersion: 1 });

    const withdrawn = await killSwitch(TENANT, cand.id, 'source integrity incident', 'user:operator');
    expect(withdrawn.state).toBe('withdrawn');
    expect(withdrawn.riskSignals).toContain('withdrawn: source integrity incident (by user:operator)');

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
