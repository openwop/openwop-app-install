/**
 * ADR 0442 P2 — the Daily Coach schedule is ATTRIBUTED to KickBot.
 *
 * Enroll arms the daily-loop continuation; P2 stamps its roster attribution so
 * the fired loop shows under KickBot's Schedules + Activity tabs. This is
 * PRESENTATION only:
 *   - it enables no cadence (heartbeat stays off),
 *   - and it must NEVER mirror the participant's daily occurrences onto
 *     KickBot's board — the participant board is the single completion truth.
 *
 * Sabotage witnesses (w41 /grade-tests): dropping the rosterId/agentId stamp,
 * a non-off KickBot heartbeat, materializing onto KickBot's board, and letting
 * the create-CAS loser continue to arm its own job (the forced race below).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards, __test as coreStore } from '../src/features/kicktodo-core/enrollmentService.js';
import { kickbotBoardId, KICKBOT_AGENT_ID } from '../src/features/kicktodo-core/kickbotService.js';
import { continuationJobId } from '../src/features/goals/goalsService.js';
import { getJob, listJobsByRoster, scheduleSubject } from '../src/host/schedulingService.js';
import { getBoard, listCards } from '../src/host/kanbanService.js';
import { getRosterEntry } from '../src/host/rosterService.js';

const T = 'tenant-daily-attr';
const DAILY_LOOP = 'openwop-app.kicktodo.daily-loop';
const OWNER = 'user:attr-owner';

async function published(): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: 'Attrib', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: 'i', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('daily-loop schedule attribution (ADR 0442 P2)', () => {
  it('attributes the continuation job to KickBot (rosterId + agentId)', async () => {
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId: await published(), challengeVersion: 1, timezone: 'UTC' });
    const job = await getJob(continuationJobId(T, enrollment.goalId));
    expect(job).not.toBeNull();
    expect(job!.rosterId).toBe('host:kickbot');
    expect(job!.agentId).toBe(KICKBOT_AGENT_ID);
  });

  it("shows under KickBot's Schedules tab query (listJobsByRoster) with an agent subject", async () => {
    await enroll({ tenantId: T, ownerSubject: OWNER, challengeId: await published(), challengeVersion: 1, timezone: 'UTC' });
    const daily = (await listJobsByRoster(T, 'host:kickbot')).find((j) => j.workflowId === DAILY_LOOP);
    expect(daily).toBeDefined();
    if (!daily) return;
    expect(scheduleSubject(daily)).toEqual({ kind: 'agent', id: 'host:kickbot' });
  });

  it('enables NO cadence — KickBot heartbeat is still explicitly off after enroll', async () => {
    await enroll({ tenantId: T, ownerSubject: OWNER, challengeId: await published(), challengeVersion: 1, timezone: 'UTC' });
    const entry = await getRosterEntry(T, 'host:kickbot');
    expect(entry?.heartbeatIntervalMs).toBe(-1); // never inherits a cadence
  });

  it("does NOT mirror the participant's daily occurrences onto KickBot's board (single completion truth)", async () => {
    await enroll({ tenantId: T, ownerSubject: OWNER, challengeId: await published(), challengeVersion: 1, timezone: 'UTC' });
    expect(await getBoard(kickbotBoardId(T))).not.toBeNull();
    // KickBot's board is its OWN work surface — it must carry no cards mirroring
    // the participant's action occurrences.
    expect(await listCards(kickbotBoardId(T))).toHaveLength(0);
  });

  it('is idempotent — two CONCURRENT first enrolls arm exactly ONE daily-loop job (forced race)', async () => {
    const challengeId = await published();
    // Hold every create-CAS (expected === null) until BOTH callers have passed the
    // `prior` read and built their own goal, so the loser path really runs. The
    // count below is over ALL daily-loop jobs — never filtered by the id the
    // code derives, which could not see a second job under a different goal.
    const store = coreStore.enrollments;
    const realCas = store.compareAndSwap.bind(store);
    let arrivals = 0;
    let release: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, 'compareAndSwap').mockImplementation(async (expected, next) => {
      if (expected === null) {
        arrivals += 1;
        if (arrivals >= 2) release();
        await Promise.race([bothArrived, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      }
      return realCas(expected, next);
    });
    const [a, b] = await Promise.all([
      enroll({ tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC' }),
      enroll({ tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC' }),
    ]);
    expect(arrivals).toBe(2); // the race was real
    expect(a.enrollment.id).toBe(b.enrollment.id);
    expect(a.enrollment.goalId).toBe(b.enrollment.goalId); // the loser returns the winner's row
    const daily = (await listJobsByRoster(T, 'host:kickbot')).filter((j) => j.workflowId === DAILY_LOOP);
    expect(daily).toHaveLength(1);
    expect(daily[0]!.jobId).toBe(continuationJobId(T, a.enrollment.goalId));
    expect(daily[0]!.rosterId).toBe('host:kickbot');
  });
});
