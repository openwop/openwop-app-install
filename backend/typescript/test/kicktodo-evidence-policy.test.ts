/**
 * ADR 0434 (KTFULL-B6) — the declared evidence policy is ENFORCED.
 *
 * The audit found empty evidence accepted for note/photo/measurement actions,
 * so the goals judge counted completions whose declared bar was never met.
 * This is the full policy matrix the audit said was missing — written as a
 * matrix precisely because a single happy-path case is what let this through.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import {
  todayFor, submitCheckIn, listCheckIns, __clearCheckInObservers, EvidenceRequiredError,
} from '../src/features/kicktodo-core/todayService.js';
import type { EvidencePolicy } from '../src/features/kicktodo-core/types.js';

const T = 'tenant-evidence';

async function cardFor(policy: EvidencePolicy, owner: string): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: `Policy ${policy}`, summary: 's', outcome: 'o', durationDays: 1,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: policy }],
  });
  await publishChallenge(T, draft.id, 1);
  await enroll({ tenantId: T, ownerSubject: owner, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  const today = await todayFor(T, owner);
  return today.enrollments.at(-1)!.actions[0]!.occurrence.cardId;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

describe('the evidence-policy matrix (KTFULL-B6)', () => {
  it('attestation: checking in IS the attestation — empty evidence is accepted', async () => {
    const owner = 'user:ev-attest';
    const card = await cardFor('attestation', owner);
    const ci = await submitCheckIn(T, owner, card, {});
    expect(ci.cardId).toBe(card);
  });

  it('note: an empty or whitespace-only note is REFUSED; real text is accepted', async () => {
    const owner = 'user:ev-note';
    const card = await cardFor('note', owner);
    await expect(submitCheckIn(T, owner, card, {})).rejects.toBeInstanceOf(EvidenceRequiredError);
    await expect(submitCheckIn(T, owner, card, { note: '   ' })).rejects.toBeInstanceOf(EvidenceRequiredError);
    // …and nothing was written by the refused attempts.
    expect(await listCheckIns(T, (await todayFor(T, owner)).enrollments.at(-1)!.enrollmentId)).toHaveLength(0);
    expect((await submitCheckIn(T, owner, card, { note: 'Did it' })).note).toBe('Did it');
  });

  it('photo: refused without a media reference', async () => {
    const owner = 'user:ev-photo';
    const card = await cardFor('photo', owner);
    await expect(submitCheckIn(T, owner, card, {})).rejects.toBeInstanceOf(EvidenceRequiredError);
    expect((await submitCheckIn(T, owner, card, { note: 'media:abc123' })).note).toBe('media:abc123');
  });

  it('measurement: refused without a finite number — a NOTE is not a measurement', async () => {
    const owner = 'user:ev-measure';
    const card = await cardFor('measurement', owner);
    await expect(submitCheckIn(T, owner, card, {})).rejects.toBeInstanceOf(EvidenceRequiredError);
    await expect(submitCheckIn(T, owner, card, { note: 'about 5k' })).rejects.toBeInstanceOf(EvidenceRequiredError);
    await expect(submitCheckIn(T, owner, card, { measuredValue: Number.NaN })).rejects.toBeInstanceOf(EvidenceRequiredError);
    expect((await submitCheckIn(T, owner, card, { measuredValue: 5 })).measuredValue).toBe(5);
  });

  it('a refusal leaves the card INCOMPLETE — no completion is credited without evidence', async () => {
    const owner = 'user:ev-nocredit';
    const card = await cardFor('measurement', owner);
    await expect(submitCheckIn(T, owner, card, {})).rejects.toBeInstanceOf(EvidenceRequiredError);
    const today = await todayFor(T, owner);
    const action = today.enrollments.at(-1)!.actions.find((a) => a.occurrence.cardId === card);
    expect(action?.card?.completed).toBe(false);
    expect(action?.checkIn).toBeNull();
  });
});
