/**
 * XCH-CV-2 — the publication approval says how much of the evidence was
 * actually checked. claim-verify skips a source/claim pair whose source was
 * never read, and every pair past its ceiling; before this, those counts died
 * as node outputs and the approver saw only "N sources".
 *
 * The counts are DERIVED from the recorded dossier (a citation with a recorded
 * verdict = judged; without one = not judged), so:
 *   - a dossier with no verdicts at all says verification did not run, never
 *     "0 judged";
 *   - a fully verified dossier says every cited pair was checked;
 *   - a partly verified one names the not-judged count;
 *   - the line reaches the REAL approval proposal through submitForPublication.
 *
 * What reds it: dropping `evidenceCheckNote` from the proposal, counting a
 * citation as judged without a verdict for THAT source (e.g. "the claim has a
 * support array"), or treating a pre-verification dossier as zero judged.
 * Sabotage-witnessed 2026-10-17, one probe each: removing the note from the
 * proposal reds the submit case; counting every citation of a claim with a
 * support array as judged reds the partial and submit cases; deleting the
 * pre-verification branch reds the "not run" case.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createCandidate, getCandidate, recordResearch, setCandidateDraft, setCandidateSimulation, type FactoryCandidate, type ResearchClaim } from '../src/features/kicktodo-creator/creatorService.js';
import { evidenceCheckNote, submitForPublication } from '../src/features/kicktodo-creator/publishService.js';
import { createDraft } from '../src/features/kicktodo-core/challengeService.js';
import { getApproval } from '../src/host/approvalService.js';

const T = 'tenant-kt-evidence-check';
const A = 'user:author';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

const SOURCES = [
  { url: 'https://example.org/a', domain: 'x', title: 'Source A', hash: 'ha', engine: 'searx' },
  { url: 'https://example.org/b', domain: 'x', title: 'Source B', hash: 'hb', engine: 'searx' },
];

/** Record `claims` on a fresh candidate and return the STORED candidate — the
 *  note must read what recordResearch persisted, not the fixture. */
async function recorded(claims: ResearchClaim[]): Promise<FactoryCandidate> {
  const cand = await createCandidate({ tenantId: T, createdBy: A, topic: 'Watercolor painting basics', audience: 'beginners', transformation: '', durationDaysTarget: 3, dailyMinutesTarget: 15 });
  await recordResearch(T, cand.id, { questions: [], sources: SOURCES, claims });
  const stored = await getCandidate(T, cand.id);
  if (!stored) throw new Error('candidate vanished');
  return stored;
}

const SUPPORTS = { verdict: 'supports' as const, span: 'repetition builds control', secondOpinion: 'supports' as const };

describe('evidenceCheckNote — derived from the recorded dossier (XCH-CV-2)', () => {
  it('a dossier with no verdicts says verification did not run, never "0 judged"', async () => {
    const c = await recorded([{ claimId: 'c1', text: 'brush control improves with repetition', sourceHashes: ['ha'] }]);
    const note = evidenceCheckNote(c);
    expect(note).toContain('not run');
    expect(note).not.toMatch(/\b0 source\/claim pairs judged/);
  });

  it('every cited pair judged ⇒ says all were checked', async () => {
    const c = await recorded([
      { claimId: 'c1', text: 'brush control improves with repetition', sourceHashes: ['ha', 'hb'], support: [{ sourceHash: 'ha', ...SUPPORTS }, { sourceHash: 'hb', verdict: 'unrelated' }] },
    ]);
    expect(evidenceCheckNote(c)).toBe('evidence check: 2 source/claim pairs judged, all cited pairs checked');
  });

  it('a cited pair with no verdict (claim-verify skipped it) counts as NOT judged — including a claim whose support is empty', async () => {
    const c = await recorded([
      { claimId: 'c1', text: 'brush control improves with repetition', sourceHashes: ['ha', 'hb'], support: [{ sourceHash: 'ha', ...SUPPORTS }] },
      { claimId: 'c2', text: 'wet-on-wet needs timing', sourceHashes: ['hb'], support: [] },
    ]);
    expect(evidenceCheckNote(c)).toBe('evidence check: 1 source/claim pair judged, 2 NOT judged (source unreadable or verification cap reached)');
  });
});

describe('the approval proposal carries the evidence check (XCH-CV-2)', () => {
  it('submitForPublication puts the judged / not-judged counts in front of the approver', async () => {
    // c1 is supported by `ha` (passes the claims gate) but its `hb` citation was
    // never judged — exactly the case the approver could not see before.
    const c = await recorded([
      { claimId: 'c1', text: 'brush control improves with repetition', sourceHashes: ['ha', 'hb'], support: [{ sourceHash: 'ha', ...SUPPORTS }] },
    ]);
    const draft = await createDraft({ tenantId: T, authorSubject: A, title: 'Watercolor', summary: 's', outcome: 'o', durationDays: 3, activities: [{ stableActivityId: 'd1', day: 1, title: 'Study', instructions: 'paint', evidencePolicy: 'photo' }] });
    await setCandidateDraft(T, c.id, draft.id, 1);
    await setCandidateSimulation(T, c.id, (['newcomer', 'time-poor', 'skeptic'] as const).map((sim) => ({ sim, verdict: 'pass' as const, personaSummary: '', findings: [] })));
    const record = await submitForPublication(T, c.id, draft.id, 1, A);
    const approval = await getApproval(record.approvalId);
    expect(approval?.proposal).toContain('evidence check: 1 source/claim pair judged, 1 NOT judged (source unreadable or verification cap reached)');
  });
});
