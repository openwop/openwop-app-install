/**
 * ADR 0442 Guide wave (Wave 2) — KickBot's ONE bounded write, `log-checkin`,
 * composes the governed `submitCheckIn` and shares the `POST /kicktodo/check-ins`
 * route's posture: fails typed without an acting human, own-data-only (a foreign/
 * absent card is a uniform `not_found` — no existence leak), enforces the declared
 * evidence policy, and is idempotent. The write itself is proven in
 * `kicktodo-evidence-policy.test.ts`; here we pin the TOOL WRAPPER — the typed
 * error mapping, the fail-empty posture, the read-before-write cardId requirement,
 * and the human-title echo.
 *
 * (The approval-card gate — `log-checkin` ∈ SENSITIVE_APPROVAL_TOOLS — is pinned by
 * `kicktodo-kickbot-connections.test.ts`.)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, journalFor, __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { runLogCheckinTool } from '../src/features/kicktodo-core/agentTools.js';
import type { EvidencePolicy } from '../src/features/kicktodo-core/types.js';

const T = 'tenant-logcheckin';

async function cardFor(policy: EvidencePolicy, owner: string, title = 'Morning run'): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: `LC ${policy} ${owner}`, summary: 's', outcome: 'o', durationDays: 1,
    activities: [{ stableActivityId: 'a1', day: 1, title, instructions: 'i', evidencePolicy: policy }],
  });
  await publishChallenge(T, draft.id, 1);
  await enroll({ tenantId: T, ownerSubject: owner, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC' });
  const today = await todayFor(T, owner);
  return today.enrollments.at(-1)!.actions[0]!.occurrence.cardId;
}
const parse = (r: { content: string }): Record<string, unknown> => {
  const v: Record<string, unknown> = JSON.parse(r.content);
  return v;
};
/** The route's uniform not-found text — identical for a foreign and an absent card. */
const NOT_FOUND = { error: 'not_found', message: 'That action was not found on your Today view.' };

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __clearEnrollGuards();
  __clearCheckInObservers();
});

describe('openwop:kicktodo.log-checkin (WRITE) — fail-closed + own-data-only', () => {
  it('a system turn (no acting user) is refused — acting_user_required', async () => {
    const r = await runLogCheckinTool({ cardId: 'anything' }, { tenantId: T });
    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual({ error: 'acting_user_required' });
  });

  it('a missing cardId is a validation_error (read `today` first, pass the exact id)', async () => {
    const r = await runLogCheckinTool({}, { tenantId: T, actingUserId: 'user:lc-1' });
    expect(r.isError).toBe(true);
    expect(parse(r)).toMatchObject({ error: 'validation_error', message: expect.stringMatching(/^Pass the EXACT `cardId`/) });
  });

  it('a bogus / absent card is a uniform not_found (no existence leak)', async () => {
    const r = await runLogCheckinTool({ cardId: 'occ:does-not-exist' }, { tenantId: T, actingUserId: 'user:lc-1' });
    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual(NOT_FOUND);
  });

  it('ANOTHER user\'s card is not_found for the caller (owner-check == the route)', async () => {
    const card = await cardFor('attestation', 'user:lc-owner');
    const r = await runLogCheckinTool({ cardId: card }, { tenantId: T, actingUserId: 'user:lc-intruder' });
    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual(NOT_FOUND);
  });

  it('happy path: records the own check-in, echoes the card TITLE, and is idempotent', async () => {
    const owner = 'user:lc-happy';
    const card = await cardFor('attestation', owner, 'Morning run');
    const r = await runLogCheckinTool({ cardId: card, note: 'felt great' }, { tenantId: T, actingUserId: owner });
    expect(r.isError).toBeUndefined();
    expect(parse(r)).toMatchObject({ recorded: true, cardId: card, cardTitle: 'Day 1: Morning run', note: 'felt great' });
    // Idempotent — a re-log wins the recorded evidence, never a duplicate/error.
    const again = await runLogCheckinTool({ cardId: card, note: 'again' }, { tenantId: T, actingUserId: owner });
    expect(again.isError).toBeUndefined();
    expect(parse(again)).toMatchObject({ recorded: true, note: 'felt great' }); // first evidence wins
    // Persisted, not just echoed: the journal holds exactly ONE entry for the card,
    // carrying the FIRST note.
    const entries = (await journalFor(T, owner)).filter((j) => j.cardId === card);
    expect(entries.map((j) => j.note)).toEqual(['felt great']);
  });

  it('a note-policy action refuses an empty note as validation_error, accepts real text', async () => {
    const owner = 'user:lc-note';
    const card = await cardFor('note', owner);
    const bare = await runLogCheckinTool({ cardId: card }, { tenantId: T, actingUserId: owner });
    expect(bare.isError).toBe(true);
    expect(parse(bare)).toMatchObject({ error: 'validation_error' });
    const ok = await runLogCheckinTool({ cardId: card, note: 'Did it' }, { tenantId: T, actingUserId: owner });
    expect(ok.isError).toBeUndefined();
    expect(parse(ok)).toMatchObject({ recorded: true });
  });

  it('a measurement-policy action refuses a bare attestation, accepts a finite number', async () => {
    const owner = 'user:lc-measure';
    const card = await cardFor('measurement', owner);
    expect(parse(await runLogCheckinTool({ cardId: card }, { tenantId: T, actingUserId: owner }))).toMatchObject({ error: 'validation_error' });
    const ok = await runLogCheckinTool({ cardId: card, measuredValue: 5 }, { tenantId: T, actingUserId: owner });
    expect(ok.isError).toBeUndefined();
    expect(parse(ok)).toMatchObject({ recorded: true, measuredValue: 5 });
  });
});
