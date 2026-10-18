/**
 * ADR 0443 R2 — the ONE day↔date mapping. Pinned invariants:
 *  - absent daysOfWeek ≡ today's dayNumber semantics (backward-compatible identity)
 *  - round-trip: dayNumberFor(mapDayToDate(n)) === n for every n (the materializer
 *    inverse and the Plan view's forward projection can never disagree)
 *  - a non-allowed date yields null (nothing materializes ⇒ never "missed")
 *  - enroll freezes daysOfWeek; a non-allowed day materializes nothing while an
 *    allowed day maps the NEXT day index (weekday-stretching, not skipping)
 *
 * (The file also carries the ADR 0443 R3 planFor read, ADR 0444 I1/I2 invites +
 * inviter notification and S1/S2 cohort sessions.)
 *
 * w41 grade-tests: every service-backed case now seeds its OWN enrollment with
 * `Date` faked to Monday 2026-07-20 (the old cases shared one enrollment, so 7
 * of them crashed under shuffle). The "non-allowed day" leg used a date BEFORE
 * start — null for ANY daysOfWeek — and `occs.every(...)` on the [] that a
 * re-materialize of today returns; both now use real weekdays after the start.
 *
 * Sabotages that turn this red (w41 probes): the non-allowed null in
 * dayNumberFor, mapDayToDate's allowed-day walk, the override-beats-natural
 * rule, daysOfWeek normalization, dropping daysOfWeek in materializeOccurrences,
 * the daypart merge keeping daysOfWeek, planFor's 31-day cap, the invite tenant
 * check and self-invite rule, and the inviter mute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayNumber, dayNumberFor, dueDaysOn, effectiveDateForDay, mapDayToDate } from '../src/features/kicktodo-core/types.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { setNotificationBackend, getNotificationEmitter } from '../src/notifications/emitter.js';
import { setNotificationMuteResolver } from '../src/host/notificationPolicy.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import {
  enroll, setSchedulePreference, materializeOccurrences, occurrencesOn,
  InvalidDaysOfWeekError, __clearEnrollGuards,
} from '../src/features/kicktodo-core/enrollmentService.js';
import type { ChallengeEnrollment } from '../src/features/kicktodo-core/types.js';
import { planFor } from '../src/features/kicktodo-core/todayService.js';
import { mintInvite, revokeInvite, resolveInvite, InviteDeniedError } from '../src/features/kicktodo-core/inviteService.js';
import { createCircle, inviteToCircle, acceptGrant } from '../src/features/kicktodo-accountability/circleService.js';
import {
  scheduleSession, cancelSession, listSessions, SessionDeniedError, SessionTimeError,
} from '../src/features/kicktodo-accountability/sessionService.js';

describe('mapDayToDate / dayNumberFor (pure)', () => {
  // 2026-07-20 is a Monday (getUTCDay() === 1).
  const START = '2026-07-20';
  const WEEKDAYS = [1, 2, 3, 4, 5];

  it('absent daysOfWeek ≡ dayNumber (identity with today’s semantics)', () => {
    for (let n = 1; n <= 10; n++) {
      const date = mapDayToDate(START, undefined, n);
      expect(dayNumberFor(START, undefined, date)).toBe(n);
      expect(dayNumber(START, date)).toBe(n);
    }
  });

  it('round-trips for every day index under a weekday preference', () => {
    for (let n = 1; n <= 14; n++) {
      const date = mapDayToDate(START, WEEKDAYS, n);
      expect(dayNumberFor(START, WEEKDAYS, date)).toBe(n);
    }
  });

  it('weekday-only stretches across weekends: day 6 lands the following Monday', () => {
    expect(mapDayToDate(START, WEEKDAYS, 5)).toBe('2026-07-24'); // Fri
    expect(mapDayToDate(START, WEEKDAYS, 6)).toBe('2026-07-27'); // next Mon
  });

  it('a non-allowed date yields null (never a day index, never "missed")', () => {
    expect(dayNumberFor(START, WEEKDAYS, '2026-07-25')).toBeNull(); // Saturday
    expect(dayNumberFor(START, WEEKDAYS, '2026-07-19')).toBeNull(); // before start
  });

  it('a start date on a non-allowed weekday begins on the first allowed date', () => {
    // Start Saturday 2026-07-25 with weekday-only → day 1 is Monday 07-27.
    expect(mapDayToDate('2026-07-25', WEEKDAYS, 1)).toBe('2026-07-27');
    expect(dayNumberFor('2026-07-25', WEEKDAYS, '2026-07-27')).toBe(1);
  });
});

describe('effectiveDateForDay / dueDaysOn — override-aware mapping (ADR 0496 D1)', () => {
  const START = '2026-07-20'; // Monday
  const WEEKDAYS = [1, 2, 3, 4, 5];
  const DURATION = 10;

  it('no overrides ≡ the natural pair, day for day', () => {
    const e = { startDateLocal: START, schedulePreference: { daysOfWeek: WEEKDAYS } };
    for (let n = 1; n <= DURATION; n++) {
      const date = effectiveDateForDay(e, n);
      expect(date).toBe(mapDayToDate(START, WEEKDAYS, n));
      expect(dueDaysOn(e, DURATION, date)).toContain(n);
    }
  });

  it('MULTIPLICITY PIN (architect H4): for every day d, the set of dates that fire d is exactly {effectiveDateForDay(d)}', () => {
    // Day 3 moved to a Saturday (override beats daysOfWeek — its purpose);
    // day 5 moved ONTO day 4's natural date (two days may share a date).
    const day4Natural = mapDayToDate(START, WEEKDAYS, 4);
    const e = {
      startDateLocal: START,
      schedulePreference: { daysOfWeek: WEEKDAYS, dayOverrides: { '3': '2026-07-25', '5': day4Natural } },
    };
    // Sweep a generous date range and collect, per day, every date that fires it.
    const firedOn = new Map<number, string[]>();
    for (let off = -2; off <= 40; off++) {
      const d = new Date(Date.parse(`${START}T00:00:00Z`) + off * 86_400_000).toISOString().slice(0, 10);
      for (const day of dueDaysOn(e, DURATION, d)) (firedOn.get(day) ?? firedOn.set(day, []).get(day)!).push(d);
    }
    for (let n = 1; n <= DURATION; n++) {
      expect(firedOn.get(n)).toEqual([effectiveDateForDay(e, n)]); // exactly once, at the effective date
    }
    // The moved day fires at its override, NEVER at its natural date…
    expect(dueDaysOn(e, DURATION, mapDayToDate(START, WEEKDAYS, 3))).not.toContain(3);
    expect(dueDaysOn(e, DURATION, '2026-07-25')).toEqual([3]);
    // …and the shared date fires both days.
    expect(dueDaysOn(e, DURATION, day4Natural)).toEqual([4, 5]);
  });

  it('clearing semantics: an override equal to the natural date is not special-cased here (the write path deletes it)', () => {
    const e = { startDateLocal: START, schedulePreference: { daysOfWeek: WEEKDAYS, dayOverrides: {} } };
    expect(effectiveDateForDay(e, 2)).toBe(mapDayToDate(START, WEEKDAYS, 2));
  });
});

// ── service-backed cases: each seeds its own tenant + enrollment ──────────
const MONDAY = '2026-07-20'; // getUTCDay() === 1
const OWNER = 'user:sched-owner';
let caseNo = 0;
let T = '';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${MONDAY}T12:00:00.000Z`) });
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setNotificationBackend(storage);
  setNotificationMuteResolver(async () => false);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  caseNo += 1;
  T = `tenant-sched-${caseNo}`;
});
afterEach(() => {
  setNotificationMuteResolver(async () => false);
  vi.useRealTimers();
});

/** A published 3-day challenge (day 1 → a1, day 2 → a2). */
async function publishedChallenge(): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: 'Sched Challenge', summary: 's', outcome: 'o', durationDays: 3,
    activities: [
      { stableActivityId: 'a1', day: 1, title: 'Day one', instructions: 'i', evidencePolicy: 'attestation' },
      { stableActivityId: 'a2', day: 2, title: 'Day two', instructions: 'i', evidencePolicy: 'attestation' },
    ],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

/** The owner enrolled Mon/Wed/Fri from Monday 2026-07-20. */
async function ownerEnrollment(): Promise<ChallengeEnrollment> {
  const challengeId = await publishedChallenge();
  const { enrollment } = await enroll({ tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC', daysOfWeek: [1, 3, 5] });
  return enrollment;
}

describe('enroll freezes daysOfWeek; materialization honors it', () => {
  it('invalid daysOfWeek is refused; valid is normalized + frozen on the row', async () => {
    const challengeId = await publishedChallenge();
    await expect(enroll({ tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC', daysOfWeek: [] }))
      .rejects.toBeInstanceOf(InvalidDaysOfWeekError);
    await expect(enroll({ tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC', daysOfWeek: [9] }))
      .rejects.toBeInstanceOf(InvalidDaysOfWeekError);

    const { enrollment } = await enroll({
      tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1,
      timezone: 'UTC', daysOfWeek: [5, 1, 3, 1], // deduped + sorted on the row
    });
    expect(enrollment.schedulePreference?.daysOfWeek).toEqual([1, 3, 5]);
    expect(enrollment.startDateLocal).toBe(MONDAY);

    // Monday (allowed) is day 1 — enroll already materialized it.
    expect((await occurrencesOn(T, enrollment.id, MONDAY)).map((o) => o.stableActivityId)).toEqual(['a1']);
    // Tuesday is AFTER the start but NOT allowed: nothing materializes (never "missed").
    expect(await materializeOccurrences(T, enrollment.id, '2026-07-21')).toEqual([]);
    expect(await occurrencesOn(T, enrollment.id, '2026-07-21')).toEqual([]);
    // Wednesday (allowed) maps the NEXT day index — day 2, not day 3 (stretching, not skipping).
    const wed = await materializeOccurrences(T, enrollment.id, '2026-07-22');
    expect(wed.map((o) => [o.stableActivityId, o.occurrenceDateLocal])).toEqual([['a2', '2026-07-22']]);
  });

  it('setting a daypart PRESERVES the frozen daysOfWeek (the R1 merge fix)', async () => {
    const e = await ownerEnrollment();
    const withDaypart = await setSchedulePreference(T, e.id, OWNER, 'evening');
    expect(withDaypart?.schedulePreference?.daypart).toBe('evening');
    expect(withDaypart?.schedulePreference?.daysOfWeek).toEqual([1, 3, 5]);
    const cleared = await setSchedulePreference(T, e.id, OWNER, null);
    expect(cleared?.schedulePreference?.daypart).toBeUndefined();
    expect(cleared?.schedulePreference?.daysOfWeek).toEqual([1, 3, 5]); // never dropped
  });
});

describe('planFor — the cross-challenge derived read (ADR 0443 R3)', () => {
  it('projects dated items via the ONE mapping, marks real check-ins, bounds the window, self-data only', async () => {
    const e = await ownerEnrollment();
    const day1 = '2026-07-20'; // Mon
    const day2 = '2026-07-22'; // Wed — day 2 under Mon/Wed/Fri
    const items = await planFor(T, OWNER, day1, day2);
    expect(items.map((i) => [i.dateLocal, i.stableActivityId])).toEqual([[day1, 'a1'], [day2, 'a2']]);
    expect(items.every((i) => i.enrollmentId === e.id)).toBe(true);
    expect(items.every((i) => i.completed === false)).toBe(true); // nothing checked in
    // a 32-day window is refused (silently empty); exactly 31 days is served
    expect(await planFor(T, OWNER, day1, '2026-08-21')).toEqual([]);
    expect((await planFor(T, OWNER, day1, '2026-08-20')).length).toBe(2);
    // other subjects see nothing
    expect(await planFor(T, 'user:nobody', day1, day2)).toEqual([]);
  });
});

describe('invite links (ADR 0444 I1) — attribution only, never authority', () => {
  it('mint requires published; re-mint revokes the prior; resolve is tenant-checked', async () => {
    const challengeId = await publishedChallenge();

    await expect(mintInvite(T, 'chal:nope', OWNER)).rejects.toBeInstanceOf(InviteDeniedError);

    const t1 = await mintInvite(T, challengeId, OWNER);
    expect(t1.startsWith('ktinv_')).toBe(true);
    expect((await resolveInvite(T, t1))?.inviterSubject).toBe(OWNER);
    expect(await resolveInvite('tenant-OTHER', t1)).toBeNull(); // never crosses tenants

    const t2 = await mintInvite(T, challengeId, OWNER); // re-mint
    expect(await resolveInvite(T, t1)).toBeNull(); // prior revoked
    expect((await resolveInvite(T, t2))?.challengeId).toBe(challengeId);

    await revokeInvite(T, challengeId, OWNER);
    expect(await resolveInvite(T, t2)).toBeNull();
  });

  it('enroll stamps invitedBy from a live token; self/invalid tokens stamp nothing', async () => {
    const challengeId = await publishedChallenge();
    const token = await mintInvite(T, challengeId, OWNER);

    const { enrollment: friend } = await enroll({
      tenantId: T, ownerSubject: 'user:sched-friend', challengeId, challengeVersion: 1, timezone: 'UTC', inviteToken: token,
    });
    expect(friend.invitedBy).toBe(OWNER);

    const { enrollment: stranger } = await enroll({
      tenantId: T, ownerSubject: 'user:sched-stranger', challengeId, challengeVersion: 1, timezone: 'UTC', inviteToken: 'ktinv_bogus',
    });
    expect(stranger.invitedBy).toBeUndefined(); // invalid → silently no attribution

    // The inviter (not yet enrolled) uses their OWN live token: no self-referral.
    const { enrollment: self } = await enroll({
      tenantId: T, ownerSubject: OWNER, challengeId, challengeVersion: 1, timezone: 'UTC', inviteToken: token,
    });
    expect(self.invitedBy).toBeUndefined();
  });
});

describe('inviter notification (ADR 0444 I2)', () => {
  function captureInviteAccepted(): { captured: Array<{ recipientUserId: string; message: string }>; unsub: () => void } {
    const captured: Array<{ recipientUserId: string; message: string }> = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      const meta: Record<string, unknown> | undefined = n.metadata;
      if (meta?.category === 'kicktodo-invite-accepted') captured.push({ recipientUserId: n.recipientUserId ?? '', message: n.message ?? '' });
    });
    return { captured, unsub };
  }

  it('an attributed enroll notifies the inviter — content-minimal, no joiner identity', async () => {
    const challengeId = await publishedChallenge();
    const token = await mintInvite(T, challengeId, OWNER);
    const { captured, unsub } = captureInviteAccepted();
    try {
      await enroll({ tenantId: T, ownerSubject: 'user:sched-friend2', challengeId, challengeVersion: 1, timezone: 'UTC', inviteToken: token });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.recipientUserId).toBe(OWNER);
      expect(captured[0]!.message).not.toContain('sched-friend2'); // joiner identity never leaked
    } finally { unsub(); }
  });

  it('ADR 0457 — a muted inviter is NOT notified (quiet-hours / per-type mute respected)', async () => {
    const challengeId = await publishedChallenge();
    const token = await mintInvite(T, challengeId, OWNER);
    const { captured, unsub } = captureInviteAccepted();
    try {
      setNotificationMuteResolver(async (_t, uid) => uid === OWNER); // inviter muted
      const { enrollment } = await enroll({ tenantId: T, ownerSubject: 'user:sched-friend3', challengeId, challengeVersion: 1, timezone: 'UTC', inviteToken: token });
      expect(enrollment.invitedBy).toBe(OWNER); // attribution still stamped…
      expect(captured).toHaveLength(0); // …but the courtesy notify is suppressed
    } finally {
      setNotificationMuteResolver(async () => false); // restore deliver-all
      unsub();
    }
  });
});

describe('cohort sessions (ADR 0444 S1/S2)', () => {
  it('coach schedules (idempotent, future-only); members read; outsiders uniformly denied; grantees notified', async () => {
    const e = await ownerEnrollment();
    const circle = await createCircle({ tenantId: T, type: 'cohort', enrollmentId: e.id, ownerSubject: OWNER, name: 'Test cohort' });
    await inviteToCircle(T, circle.id, OWNER, 'user:sched-member', ['progress-summary']);
    await acceptGrant(circle.id, 'user:sched-member');

    const notified: string[] = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      const meta: Record<string, unknown> | undefined = n.metadata;
      if (meta?.category === 'kicktodo-session') notified.push(n.recipientUserId ?? '');
    });
    try {
      const at = new Date(Date.now() + 3_600_000).toISOString();
      // member cannot schedule; past time refused; coach schedules idempotently
      await expect(scheduleSession(T, circle.id, 'user:sched-member', at, 'x')).rejects.toBeInstanceOf(SessionDeniedError);
      await expect(scheduleSession(T, circle.id, OWNER, '2000-01-01T00:00:00Z', 'x')).rejects.toBeInstanceOf(SessionTimeError);
      const s1 = await scheduleSession(T, circle.id, OWNER, at, 'Kickoff');
      const s2 = await scheduleSession(T, circle.id, OWNER, at, 'Kickoff');
      expect(s2.createdAt).toBe(s1.createdAt); // idempotent — same row
      // grade-code #5 — MINUTE precision enforced: a sub-minute variant of the
      // same moment converges on the SAME row (no duplicate notify fan-out).
      const subMinute = new Date(Math.floor(Date.parse(at) / 60_000) * 60_000 + 500).toISOString();
      const s3 = await scheduleSession(T, circle.id, OWNER, subMinute, 'Kickoff');
      expect(s3.atIso).toBe(s1.atIso);
      expect(s3.createdAt).toBe(s1.createdAt);
      expect(s1.conversationId).toBe(circle.conversationId); // the ONE chat, no second surface
      expect(notified).toEqual(['user:sched-member']); // S2 — grantee notified ONCE
      // member reads; outsider uniformly denied
      expect((await listSessions(T, circle.id, 'user:sched-member')).length).toBe(1);
      await expect(listSessions(T, circle.id, 'user:nobody')).rejects.toBeInstanceOf(SessionDeniedError);
      // cancel hides it from upcoming
      await cancelSession(T, circle.id, OWNER, s1.atIso);
      expect((await listSessions(T, circle.id, OWNER)).length).toBe(0);
    } finally { unsub(); }
  });
});
