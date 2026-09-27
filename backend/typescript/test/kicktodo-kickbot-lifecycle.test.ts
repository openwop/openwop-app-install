/**
 * ADR 0442 P6 — KickBot continuity + teardown tripwires (D4 + PRD §6.8).
 *
 * Two invariants that must hold AFTER P1-P5 composed every binding onto KickBot:
 *
 *  - RENAME CONTINUITY (D4): renaming the guide changes persona/label ONLY.
 *    Every structural binding survives byte-identical — identity (rosterId,
 *    roleKey, agentRef), board, conversation, the P1 profile (coaching), the P3
 *    per-user memory scope + knowledge binding + KB collection, the P5 convene
 *    tool, and the P2 daily-loop attribution.
 *
 *  - TEARDOWN (Option A — see the ADR P6 note): deleting KickBot leaves NO armed
 *    job under the retired identity (PRD §6.8) and reaps every KickBot-OWNED
 *    binding, while the PARTICIPANT's own state (their `user:<id>` memory + their
 *    enrollment) survives — the cascade deletes the guide, not the challenge.
 *    Deleting the participant's daily-loop JOB stops the cadence, not the goal;
 *    an idempotent re-arm on re-provision is the recovery path.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, __resetHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getRosterEntry, updateRosterEntry } from '../src/host/rosterService.js';
import { getAgentProfile } from '../src/host/agentProfileService.js';
import { getBoard } from '../src/host/kanbanService.js';
import { getConversationMeta } from '../src/host/conversationStore.js';
import { deleteRosterMemberCascade } from '../src/host/rosterCascade.js';
import { upsertAgentToolAllowlistOverride, resolveAgentToolAllowlistOverride } from '../src/host/agentToolAllowlistService.js';
import { addSubjectNote, listSubjectNotes } from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';
import { getJob, listJobsByRoster } from '../src/host/schedulingService.js';
import { __resetRosterLifecycleHooks } from '../src/host/rosterLifecycle.js';
import { listAllTenantCollections } from '../src/features/kb/kbService.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { continuationJobId } from '../src/features/goals/goalsService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards, listEnrollmentsFor } from '../src/features/kicktodo-core/enrollmentService.js';
import { ensureKickBot, KICKBOT_ROSTER_ID, KICKBOT_AGENT_ID, kickbotBoardId, registerKickbotLifecycleHooks } from '../src/features/kicktodo-core/kickbotService.js';
import { kickbotKbCollectionId } from '../src/features/kicktodo-core/kicktodoKnowledgeService.js';

const T = 'tenant-kickbot-lifecycle';
const PARTICIPANT = 'user:p1';

let storage: Storage;

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kickbot-lc-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  registerKickbotLifecycleHooks(); // the feature-boot wiring the cascade fires (P3 KB teardown)
});

afterEach(async () => {
  __resetRosterLifecycleHooks();
  __resetHostExtPersistence();
  const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
  getAgentRegistry()._resetForTest();
});

async function publishedChallenge(): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: 'Lifecycle', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

const kbCollection = async () => (await listAllTenantCollections(T)).find((c) => c.collectionId === kickbotKbCollectionId(T));

describe('KickBot rename continuity (ADR 0442 P6 / D4)', () => {
  it('rename changes ONLY persona/label — every P1-P5 binding survives byte-identical', async () => {
    const bot = await ensureKickBot(T);
    const challengeId = await publishedChallenge();
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: PARTICIPANT, challengeId, challengeVersion: 1, timezone: 'UTC' });

    const before = {
      roster: await getRosterEntry(T, KICKBOT_ROSTER_ID),
      profile: await getAgentProfile(T, KICKBOT_ROSTER_ID),
      agent: await hostExtStorage().getUserAgent(T, KICKBOT_AGENT_ID),
      kb: await kbCollection(),
      job: await getJob(continuationJobId(T, enrollment.goalId)),
      conv: await getConversationMeta(T, bot.conversationId),
    };
    expect(before.job).not.toBeNull();

    // The rename (persona + label only).
    await updateRosterEntry(T, KICKBOT_ROSTER_ID, { persona: 'Coach Nova', label: 'Coach Nova' });

    const after = {
      roster: await getRosterEntry(T, KICKBOT_ROSTER_ID),
      profile: await getAgentProfile(T, KICKBOT_ROSTER_ID),
      agent: await hostExtStorage().getUserAgent(T, KICKBOT_AGENT_ID),
      kb: await kbCollection(),
      job: await getJob(continuationJobId(T, enrollment.goalId)),
      conv: await getConversationMeta(T, bot.conversationId),
    };

    // Persona/label CHANGED — everything else structural is byte-identical.
    expect(after.roster?.persona).toBe('Coach Nova');
    // Identity (P1, ADR 0379 structural).
    expect(after.roster?.rosterId).toBe(KICKBOT_ROSTER_ID);
    expect(after.roster?.roleKey).toBe(before.roster?.roleKey);
    expect(after.roster?.agentRef).toEqual(before.roster?.agentRef);
    // Profile: P1 coaching + P3 knowledge capability, memory scope, KB binding.
    expect(after.profile?.capabilities).toEqual(before.profile?.capabilities);
    expect(after.profile?.capabilities).toEqual(expect.arrayContaining(['coaching', 'knowledge']));
    expect(after.profile?.memoryScope).toBe('per-user');
    expect(after.profile?.knowledge).toEqual(before.profile?.knowledge);
    // P5 convene tool still in the allowlist.
    expect(after.agent?.toolAllowlist).toEqual(before.agent?.toolAllowlist);
    expect(after.agent?.toolAllowlist).toContain('openwop:kicktodo.convene');
    // Board + conversation + KB collection ids are deterministic (rename-safe).
    expect(bot.boardId).toBe(kickbotBoardId(T));
    expect(after.kb?.collectionId).toBe(before.kb?.collectionId);
    expect(after.conv).not.toBeNull();
    // P2 daily-loop attribution survives the rename.
    expect(after.job).not.toBeNull();
    expect(after.job?.rosterId).toBe(KICKBOT_ROSTER_ID);
  });
});

describe('KickBot teardown tripwire (ADR 0442 P6 / PRD §6.8 — no orphan under a retired identity)', () => {
  it('reaps every KickBot-owned binding + leaves NO armed job; participant state survives', async () => {
    const bot = await ensureKickBot(T);
    const challengeId = await publishedChallenge();
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: PARTICIPANT, challengeId, challengeVersion: 1, timezone: 'UTC' });
    // Seed BOTH a KickBot-scope memory (must be cleared) and the participant's own
    // memory (must survive — it is theirs, not KickBot's).
    await addSubjectNote(T, { kind: 'agent', id: KICKBOT_ROSTER_ID }, 'kickbot-scope fact');
    await addSubjectNote(T, personSubject('p1'), 'participant private fact');
    // Simulate a convene having written a read-only confinement override for a specialist.
    await upsertAgentToolAllowlistOverride(T, 'feature.kicktodo.agents.plan-builder', { toolAllowlist: ['openwop:kicktodo.today'], updatedBy: 'test' });
    expect(await getJob(continuationJobId(T, enrollment.goalId))).not.toBeNull(); // loop armed
    expect(await kbCollection()).toBeDefined();                                    // KB collection exists

    await deleteRosterMemberCascade(T, storage, KICKBOT_ROSTER_ID);

    // REAPED — no orphan under the retired identity.
    expect(await listJobsByRoster(T, KICKBOT_ROSTER_ID)).toEqual([]); // the daily-loop JOB is gone (cadence stops)
    expect(await getBoard(bot.boardId)).toBeNull();
    expect(await getAgentProfile(T, KICKBOT_ROSTER_ID)).toBeNull();   // profile + capabilities/memoryScope/knowledge
    expect(await kbCollection()).toBeUndefined();                     // P3 KB collection (via the ADR 0288 hook)
    expect(await listSubjectNotes(T, { kind: 'agent', id: KICKBOT_ROSTER_ID })).toEqual([]); // agent memory cleared
    // P5 leave-no-trace — the convene confinement override is cleared (no durable residue).
    expect(await resolveAgentToolAllowlistOverride(T, 'feature.kicktodo.agents.plan-builder')).toBeUndefined();

    // SURVIVES — the participant's own state is not KickBot's to delete.
    const participantNotes = await listSubjectNotes(T, personSubject('p1'));
    expect(participantNotes.some((n) => n.content.includes('participant private fact'))).toBe(true);
    // The challenge itself (enrollment/goal) is user-owned — the cascade deletes
    // the guide's daily-loop cadence, NOT the participant's challenge.
    const stillEnrolled = await listEnrollmentsFor(T, PARTICIPANT);
    expect(stillEnrolled.some((e) => e.id === enrollment.id)).toBe(true);
  });
});
