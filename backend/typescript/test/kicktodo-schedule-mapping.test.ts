/**
 * ADR 0443 R2 — the ONE day↔date mapping. Pinned invariants:
 *  - absent daysOfWeek ≡ today's dayNumber semantics (backward-compatible identity)
 *  - round-trip: dayNumberFor(mapDayToDate(n)) === n for every n (the materializer
 *    inverse and the Plan view's forward projection can never disagree)
 *  - a non-allowed date yields null (nothing materializes ⇒ never "missed")
 *  - enroll freezes daysOfWeek; a non-allowed day materializes nothing while an
 *    allowed day maps the NEXT day index (weekday-stretching, not skipping)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dayNumber, dayNumberFor, dueDaysOn, effectiveDateForDay, mapDayToDate } from '../src/features/kicktodo-core/types.js';

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

describe('enroll freezes daysOfWeek; materialization honors it', () => {
  const T = 'tenant-sched';
  const OWNER = 'user:sched-owner';

  beforeAll(async () => {
    const { openStorage } = await import('../src/storage/index.js');
    const { initHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
    const { registerGoalVerifier } = await import('../src/features/goals/goalVerifiers.js');
    const { __clearEnrollGuards } = await import('../src/features/kicktodo-core/enrollmentService.js');
    initHostExtPersistence(await openStorage('memory://'));
    registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
    __clearEnrollGuards();
  });

  it('invalid daysOfWeek is refused; valid is normalized + frozen on the row', async () => {
    const { createDraft, publishChallenge } = await import('../src/features/kicktodo-core/challengeService.js');
    const { enroll, InvalidDaysOfWeekError, materializeOccurrences } = await import('../src/features/kicktodo-core/enrollmentService.js');
    const draft = await createDraft({
      tenantId: T, title: 'Sched Challenge', summary: 's', outcome: 'o', durationDays: 3,
      activities: [
        { stableActivityId: 'a1', day: 1, title: 'Day one', instructions: 'i', evidencePolicy: 'attestation' },
        { stableActivityId: 'a2', day: 2, title: 'Day two', instructions: 'i', evidencePolicy: 'attestation' },
      ],
    });
    await publishChallenge(T, draft.id, 1);

    await expect(enroll({ tenantId: T, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC', daysOfWeek: [] }))
      .rejects.toBeInstanceOf(InvalidDaysOfWeekError);
    await expect(enroll({ tenantId: T, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1, timezone: 'UTC', daysOfWeek: [9] }))
      .rejects.toBeInstanceOf(InvalidDaysOfWeekError);

    const { enrollment } = await enroll({
      tenantId: T, ownerSubject: OWNER, challengeId: draft.id, challengeVersion: 1,
      timezone: 'UTC', daysOfWeek: [5, 1, 3, 1], // deduped + sorted on the row
    });
    expect(enrollment.schedulePreference?.daysOfWeek).toEqual([1, 3, 5]);

    // A non-allowed date materializes NOTHING; an allowed one maps its day index.
    const start = enrollment.startDateLocal;
    const day1Date = mapDayToDate(start, [1, 3, 5], 1);
    const occs = await materializeOccurrences(T, enrollment.id, day1Date);
    expect(occs.every((o) => o.occurrenceDateLocal === day1Date)).toBe(true);
    const disallowed = dayNumberFor(start, [1, 3, 5], '2026-01-01') === null
      ? '2026-01-01' // any date before start is fine as a null probe
      : start;
    expect(await materializeOccurrences(T, enrollment.id, disallowed)).toEqual([]);
  });

  it('setting a daypart PRESERVES the frozen daysOfWeek (the R1 merge fix)', async () => {
    const { listEnrollmentsFor, setSchedulePreference } = await import('../src/features/kicktodo-core/enrollmentService.js');
    const [e] = await listEnrollmentsFor(T, OWNER);
    const withDaypart = await setSchedulePreference(T, e!.id, OWNER, 'evening');
    expect(withDaypart?.schedulePreference?.daypart).toBe('evening');
    expect(withDaypart?.schedulePreference?.daysOfWeek).toEqual([1, 3, 5]);
    const cleared = await setSchedulePreference(T, e!.id, OWNER, null);
    expect(cleared?.schedulePreference?.daypart).toBeUndefined();
    expect(cleared?.schedulePreference?.daysOfWeek).toEqual([1, 3, 5]); // never dropped
  });
});

describe('planFor — the cross-challenge derived read (ADR 0443 R3)', () => {
  it('projects dated items via the ONE mapping, marks real check-ins, bounds the window, self-data only', async () => {
    const { listEnrollmentsFor } = await import('../src/features/kicktodo-core/enrollmentService.js');
    const { planFor } = await import('../src/features/kicktodo-core/todayService.js');
    const [e] = await listEnrollmentsFor('tenant-sched', 'user:sched-owner');
    const start = e!.startDateLocal;
    const day1 = mapDayToDate(start, [1, 3, 5], 1);
    const day2 = mapDayToDate(start, [1, 3, 5], 2);
    const items = await planFor('tenant-sched', 'user:sched-owner', day1, day2);
    expect(items.map((i) => i.dateLocal)).toEqual([day1, day2]);
    expect(items.every((i) => i.enrollmentId === e!.id)).toBe(true);
    expect(items.every((i) => i.completed === false)).toBe(true); // nothing checked in
    // over-wide window refused (silently empty), other subjects see nothing
    expect(await planFor('tenant-sched', 'user:sched-owner', day1, '2099-01-01')).toEqual([]);
    expect(await planFor('tenant-sched', 'user:nobody', day1, day2)).toEqual([]);
  });
});

describe('invite links (ADR 0444 I1) — attribution only, never authority', () => {
  it('mint requires published; re-mint revokes the prior; resolve is tenant-checked', async () => {
    const { mintInvite, revokeInvite, resolveInvite, InviteDeniedError } = await import('../src/features/kicktodo-core/inviteService.js');
    const { listEnrollmentsFor } = await import('../src/features/kicktodo-core/enrollmentService.js');
    const [e] = await listEnrollmentsFor('tenant-sched', 'user:sched-owner');
    const challengeId = e!.challengeId;

    await expect(mintInvite('tenant-sched', 'chal:nope', 'user:sched-owner')).rejects.toBeInstanceOf(InviteDeniedError);

    const t1 = await mintInvite('tenant-sched', challengeId, 'user:sched-owner');
    expect(t1.startsWith('ktinv_')).toBe(true);
    expect((await resolveInvite('tenant-sched', t1))?.inviterSubject).toBe('user:sched-owner');
    expect(await resolveInvite('tenant-OTHER', t1)).toBeNull(); // never crosses tenants

    const t2 = await mintInvite('tenant-sched', challengeId, 'user:sched-owner'); // re-mint
    expect(await resolveInvite('tenant-sched', t1)).toBeNull(); // prior revoked
    expect((await resolveInvite('tenant-sched', t2))?.challengeId).toBe(challengeId);

    await revokeInvite('tenant-sched', challengeId, 'user:sched-owner');
    expect(await resolveInvite('tenant-sched', t2)).toBeNull();
  });

  it('enroll stamps invitedBy from a live token; self/invalid tokens stamp nothing', async () => {
    const { mintInvite } = await import('../src/features/kicktodo-core/inviteService.js');
    const { enroll, listEnrollmentsFor } = await import('../src/features/kicktodo-core/enrollmentService.js');
    const [e] = await listEnrollmentsFor('tenant-sched', 'user:sched-owner');
    const token = await mintInvite('tenant-sched', e!.challengeId, 'user:sched-owner');

    const { enrollment: friend } = await enroll({
      tenantId: 'tenant-sched', ownerSubject: 'user:sched-friend',
      challengeId: e!.challengeId, challengeVersion: e!.challengeVersion,
      timezone: 'UTC', inviteToken: token,
    });
    expect(friend.invitedBy).toBe('user:sched-owner');

    const { enrollment: stranger } = await enroll({
      tenantId: 'tenant-sched', ownerSubject: 'user:sched-stranger',
      challengeId: e!.challengeId, challengeVersion: e!.challengeVersion,
      timezone: 'UTC', inviteToken: 'ktinv_bogus',
    });
    expect(stranger.invitedBy).toBeUndefined(); // invalid → silently no attribution
  });
});

describe('inviter notification (ADR 0444 I2)', () => {
  it('an attributed enroll notifies the inviter — content-minimal, no joiner identity', async () => {
    const { setNotificationBackend, getNotificationEmitter } = await import('../src/notifications/emitter.js');
    const { openStorage } = await import('../src/storage/index.js');
    setNotificationBackend(await openStorage('memory://'));
    const captured: Array<{ recipientUserId: string; message: string }> = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      if ((n.metadata as Record<string, unknown> | undefined)?.category === 'kicktodo-invite-accepted') {
        captured.push({ recipientUserId: n.recipientUserId ?? '', message: n.message ?? '' });
      }
    });
    try {
      const { mintInvite } = await import('../src/features/kicktodo-core/inviteService.js');
      const { enroll, listEnrollmentsFor } = await import('../src/features/kicktodo-core/enrollmentService.js');
      const [e] = await listEnrollmentsFor('tenant-sched', 'user:sched-owner');
      const token = await mintInvite('tenant-sched', e!.challengeId, 'user:sched-owner');
      await enroll({
        tenantId: 'tenant-sched', ownerSubject: 'user:sched-friend2',
        challengeId: e!.challengeId, challengeVersion: e!.challengeVersion,
        timezone: 'UTC', inviteToken: token,
      });
      expect(captured.length).toBe(1);
      expect(captured[0]!.recipientUserId).toBe('user:sched-owner');
      expect(captured[0]!.message).not.toContain('sched-friend2'); // joiner identity never leaked
    } finally { unsub(); }
  });

  it('ADR 0457 — a muted inviter is NOT notified (quiet-hours / per-type mute respected)', async () => {
    const { setNotificationBackend, getNotificationEmitter } = await import('../src/notifications/emitter.js');
    const { openStorage } = await import('../src/storage/index.js');
    const { setNotificationMuteResolver } = await import('../src/host/notificationPolicy.js');
    setNotificationBackend(await openStorage('memory://'));
    const captured: string[] = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      if ((n.metadata as Record<string, unknown> | undefined)?.category === 'kicktodo-invite-accepted') captured.push(n.recipientUserId ?? '');
    });
    try {
      const { mintInvite } = await import('../src/features/kicktodo-core/inviteService.js');
      const { enroll, listEnrollmentsFor } = await import('../src/features/kicktodo-core/enrollmentService.js');
      const [e] = await listEnrollmentsFor('tenant-sched', 'user:sched-owner');
      const token = await mintInvite('tenant-sched', e!.challengeId, 'user:sched-owner');
      setNotificationMuteResolver(async (_t, uid) => uid === 'user:sched-owner'); // inviter muted
      await enroll({
        tenantId: 'tenant-sched', ownerSubject: 'user:sched-friend3',
        challengeId: e!.challengeId, challengeVersion: e!.challengeVersion,
        timezone: 'UTC', inviteToken: token,
      });
      expect(captured.length).toBe(0); // courtesy notify suppressed; enroll still succeeded
    } finally {
      setNotificationMuteResolver(async () => false); // restore deliver-all
      unsub();
    }
  });
});

describe('cohort sessions (ADR 0444 S1/S2)', () => {
  it('coach schedules (idempotent, future-only); members read; outsiders uniformly denied; grantees notified', async () => {
    const { createCircle, inviteToCircle, acceptGrant } = await import('../src/features/kicktodo-accountability/circleService.js');
    const { scheduleSession, cancelSession, listSessions, SessionDeniedError, SessionTimeError } =
      await import('../src/features/kicktodo-accountability/sessionService.js');
    const { getNotificationEmitter } = await import('../src/notifications/emitter.js');
    const { listEnrollmentsFor } = await import('../src/features/kicktodo-core/enrollmentService.js');

    const [e] = await listEnrollmentsFor('tenant-sched', 'user:sched-owner');
    const circle = await createCircle({ tenantId: 'tenant-sched', type: 'cohort', enrollmentId: e!.id, ownerSubject: 'user:sched-owner', name: 'Test cohort' });
    await inviteToCircle('tenant-sched', circle.id, 'user:sched-owner', 'user:sched-member', ['progress-summary']);
    await acceptGrant(circle.id, 'user:sched-member');

    const notified: string[] = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      if ((n.metadata as Record<string, unknown> | undefined)?.category === 'kicktodo-session') notified.push(n.recipientUserId ?? '');
    });
    try {
      const at = new Date(Date.now() + 3_600_000).toISOString();
      // member cannot schedule; past time refused; coach schedules idempotently
      await expect(scheduleSession('tenant-sched', circle.id, 'user:sched-member', at, 'x')).rejects.toBeInstanceOf(SessionDeniedError);
      await expect(scheduleSession('tenant-sched', circle.id, 'user:sched-owner', '2000-01-01T00:00:00Z', 'x')).rejects.toBeInstanceOf(SessionTimeError);
      const s1 = await scheduleSession('tenant-sched', circle.id, 'user:sched-owner', at, 'Kickoff');
      const s2 = await scheduleSession('tenant-sched', circle.id, 'user:sched-owner', at, 'Kickoff');
      expect(s2.createdAt).toBe(s1.createdAt); // idempotent — same row
      // grade-code #5 — MINUTE precision enforced: a sub-minute variant of the
      // same moment converges on the SAME row (no duplicate notify fan-out).
      const subMinute = new Date(Math.floor(Date.parse(at) / 60_000) * 60_000 + 500).toISOString();
      const s3 = await scheduleSession('tenant-sched', circle.id, 'user:sched-owner', subMinute, 'Kickoff');
      expect(s3.atIso).toBe(s1.atIso);
      expect(s3.createdAt).toBe(s1.createdAt);
      expect(s1.conversationId).toBe(circle.conversationId); // the ONE chat, no second surface
      expect(notified).toContain('user:sched-member'); // S2 — grantee notified
      // member reads; outsider uniformly denied
      expect((await listSessions('tenant-sched', circle.id, 'user:sched-member')).length).toBe(1);
      await expect(listSessions('tenant-sched', circle.id, 'user:nobody')).rejects.toBeInstanceOf(SessionDeniedError);
      // cancel hides it from upcoming
      await cancelSession('tenant-sched', circle.id, 'user:sched-owner', s1.atIso);
      expect((await listSessions('tenant-sched', circle.id, 'user:sched-owner')).length).toBe(0);
    } finally { unsub(); }
  });
});
