/**
 * ADR 0787 D6 — an honest cadence.
 *
 *   - the jumping search equals a minute-by-minute brute-force scan, across DST
 *     transitions, in zones with 2 h (Antarctica/Troll), 30 min
 *     (Australia/Lord_Howe), :30 / :45 offsets (Kolkata, Kathmandu, Chatham) and
 *     the US rules — so a jump never steps over a matching minute (`SCTWF-8`)
 *   - yearly / quarterly / 31st-of-month cadences have a next fire (the 30-day
 *     cap used to return null and silently kill them)
 *   - a cadence that never fires inside the horizon, an unparseable cron and an
 *     unknown zone are refused for an ENABLED job, and stay permissive for a
 *     disabled one until it is enabled (`SCTWF-9`)
 *   - a bad zone never throws out of `computeNextFire`
 *   - a parseable cadence with no further slot says so (`no-next-fire`), and a
 *     later run does not erase that
 *   - a spent one-shot is not re-fired for the SAME slot, while a later fire time
 *     re-arms it (`SCTWF-11` + the /architect Blocker on the draft)
 *
 * Tracker: TST-BSC-1 (docs/steward/TEST-ASSESSMENT.md). Red when: a day/hour
 * jump is taken without verifying where it landed (the DST month case); the
 * day-of-week restriction is ignored; the search horizon shrinks to 30 days; a
 * bad zone reaches `Intl` unchecked; `registerJob` or `updateJob` skips
 * `validateCadence` (both halves of the store claim are probed separately); the
 * advance stops recording `no-next-fire` or `recordJobRun` clears it; the spent
 * one-shot comparison is off by one in either direction; `reviveStalledJob`
 * stops checking `isStalled` or `isStalled` ignores `enabled`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { computeNextFire, parseCron, MAX_FUTURE_HORIZON_ISO, MAX_FUTURE_HORIZON_DAYS } from '../src/host/cronSchedule.js';
import {
  registerJob,
  updateJob,
  getJob,
  claimDueSlot,
  recordJobRun,
  resetScheduling,
  reviveStalledJob,
  validateCadence,
  ScheduleCadenceError,
  ONE_SHOT_CRON,
  type ScheduledJob,
} from '../src/host/schedulingService.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The oracle: the pre-0787 evaluator, minute by minute, written independently. */
function bruteNextFire(cronExpr: string, afterMs: number, timezone: string, capMs: number): number | null {
  const c = parseCron(cronExpr)!;
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (let t = Math.floor(afterMs / MIN) * MIN + MIN; t <= afterMs + capMs; t += MIN) {
    const p = Object.fromEntries(dtf.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const minute = Number(p.minute), hour = Number(p.hour) % 24, day = Number(p.day), month = Number(p.month), dow = WD[p.weekday!]!;
    if (!c.minute.has(minute) || !c.hour.has(hour) || !c.month.has(month)) continue;
    const domOk = c.dom.has(day), dowOk = c.dow.has(dow);
    const dayOk = c.domRestricted && c.dowRestricted ? domOk || dowOk : c.domRestricted ? domOk : c.dowRestricted ? dowOk : true;
    if (dayOk) return t;
  }
  return null;
}

/** The oracle is deliberately the slow, independent minute-by-minute scan (one
 *  `Intl` format per minute). Those cases take 8–12 s unloaded and crossed the
 *  default 15 s on a loaded gate box (19.7 s, a full-gate red), so they carry their
 *  own budget instead of a cheaper oracle that would share the jump's assumptions. */
const BRUTE_FORCE_TIMEOUT_MS = 60_000;

describe('ADR 0787 D6 — the jumping search never skips a match', () => {
  const ZONES = ['UTC', 'Antarctica/Troll', 'Australia/Lord_Howe', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Chatham', 'America/New_York', 'Europe/London'];
  // Every 2026 DST edge these zones have, entered a day early.
  const STARTS = ['2026-03-07', '2026-03-28', '2026-04-04', '2026-09-26', '2026-10-03', '2026-10-24', '2026-10-31'].map((d) => Date.parse(`${d}T12:34:56Z`));
  // Cadences that hit the moved hours on purpose (01:xx-03:xx local), plus
  // hour/day/weekday restrictions that force every kind of jump.
  const DAILY = ['30 2 * * *', '0 1 * * *', '59 1 * * *', '15 3 * * *', '0 0 * * *', '45 23 * * 1-5', '*/20 2 * * 0', '0 */6 * * *', '5 4 * * 6'];
  for (const zone of ZONES) {
    it(`matches the brute-force scan in ${zone}`, () => {
      for (const start of STARTS) {
        for (const cron of DAILY) {
          expect(computeNextFire(cron, start, zone), `${cron} after ${new Date(start).toISOString()} in ${zone}`).toBe(bruteNextFire(cron, start, zone, 9 * DAY));
        }
      }
    }, BRUTE_FORCE_TIMEOUT_MS);
  }

  it('matches for sparse monthly cadences across a DST month', () => {
    for (const zone of ['Antarctica/Troll', 'Australia/Lord_Howe', 'UTC']) {
      for (const start of [STARTS[1]!, STARTS[5]!]) {
        for (const cron of ['0 2 1 * *', '30 1 15 * *', '0 0 1-7 * 1']) {
          expect(computeNextFire(cron, start, zone), `${cron} in ${zone}`).toBe(bruteNextFire(cron, start, zone, 40 * DAY));
        }
      }
    }
  }, BRUTE_FORCE_TIMEOUT_MS);
});

describe('ADR 0787 D6 — the horizon, honoured', () => {
  const FEB1 = Date.parse('2026-02-01T00:00:00Z');
  it('is ONE constant: 366 days, advertised as P366D', () => {
    expect(MAX_FUTURE_HORIZON_DAYS).toBe(366);
    expect(MAX_FUTURE_HORIZON_ISO).toBe('P366D');
  });

  it('yearly, quarterly and 31st-of-month cadences have a next fire', () => {
    expect(computeNextFire('0 9 1 1 *', FEB1)).toBe(Date.parse('2027-01-01T09:00:00Z'));
    expect(computeNextFire('0 0 1 1,4,7,10 *', Date.parse('2026-04-01T00:01:00Z'))).toBe(Date.parse('2026-07-01T00:00:00Z'));
    expect(computeNextFire('0 0 31 * *', FEB1)).toBe(Date.parse('2026-03-31T00:00:00Z'));
  });

  it('a cadence that never fires in the horizon is refused for an enabled job, never stored inert', async () => {
    expect(computeNextFire('0 0 30 2 *', FEB1)).toBeNull();
    expect(validateCadence('0 0 30 2 *', undefined, FEB1)?.code).toBe('schedule_horizon_exceeded');
    // Feb 29 from March 2026: the next is 2028 — beyond 366 days.
    expect(validateCadence('0 0 29 2 *', undefined, Date.parse('2026-03-01T00:00:00Z'))?.code).toBe('schedule_horizon_exceeded');
    expect(validateCadence('0 0 29 2 *', undefined, Date.parse('2027-12-01T00:00:00Z'))).toBeNull();
  });

  it('an unparseable cron and an unknown zone are typed refusals; computeNextFire never throws on a bad zone', () => {
    expect(validateCadence('every tuesday', undefined)?.code).toBe('invalid_cron');
    expect(validateCadence('0 9 * * *', 'Mars/Olympus_Mons')?.code).toBe('invalid_timezone');
    expect(() => computeNextFire('0 9 * * *', FEB1, 'Mars/Olympus_Mons')).not.toThrow();
    expect(computeNextFire('0 9 * * *', FEB1, 'Mars/Olympus_Mons')).toBeNull();
    expect(validateCadence(ONE_SHOT_CRON, undefined)).toBeNull();
  });
});

describe('ADR 0787 D6 — the store', () => {
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    await resetScheduling();
  });
  afterEach(() => __resetHostExtPersistence());

  it('refuses an ENABLED job whose cadence cannot fire; a DISABLED one stays permissive until enabled', async () => {
    const bad = await registerJob({ jobId: 'j-bad', tenantId: 't', cronExpr: 'every tuesday', workflowId: 'wf' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_cron' } });
    const tz = await registerJob({ jobId: 'j-tz', tenantId: 't', cronExpr: '0 9 * * *', timezone: 'Nowhere/Land', workflowId: 'wf' });
    expect(tz).toMatchObject({ ok: false, error: { code: 'invalid_timezone' } });
    // A portability import arrives disabled and is stored as-is…
    const imported = await registerJob({ jobId: 'j-import', tenantId: 't', cronExpr: '0 0 30 2 *', workflowId: 'wf', enabled: false });
    expect(imported.ok).toBe(true);
    // …and is judged the moment someone arms it.
    const arming = updateJob('j-import', { enabled: true });
    await expect(arming).rejects.toBeInstanceOf(ScheduleCadenceError);
    await expect(arming).rejects.toMatchObject({ refusal: { code: 'schedule_horizon_exceeded' } });
    expect((await getJob('j-import'))?.enabled).toBe(false);
    // A cadence edit on an enabled job is judged too.
    await registerJob({ jobId: 'j-ok', tenantId: 't', cronExpr: '0 9 * * *', workflowId: 'wf' });
    const rezone = updateJob('j-ok', { timezone: 'Nowhere/Land' });
    await expect(rezone).rejects.toBeInstanceOf(ScheduleCadenceError);
    await expect(rezone).rejects.toMatchObject({ refusal: { code: 'invalid_timezone' } });
    expect((await getJob('j-ok'))?.timezone).toBeUndefined();
  });

  it('a parseable cadence with no further slot records no-next-fire, and a later run does not erase it', async () => {
    const reg = Date.parse('2027-12-01T00:00:00Z');
    const r = await registerJob({ jobId: 'j-leap', tenantId: 't', cronExpr: '0 0 29 2 *', workflowId: 'wf' }, reg);
    expect(r.ok).toBe(true);
    const slot = (await getJob('j-leap'))!.nextFireAt!;
    expect(slot).toBe(Date.parse('2028-02-29T00:00:00Z'));
    // Fire at the slot: the next Feb 29 is 2032, beyond the horizon.
    const advanced = await claimDueSlot('j-leap', slot, 1, slot);
    expect(advanced).not.toBeNull();
    let job = await getJob('j-leap');
    expect(job?.nextFireAt).toBeUndefined();
    expect(job?.lastSkipReason).toBe('no-next-fire');
    await recordJobRun('j-leap', 'run-1', slot);
    job = await getJob('j-leap');
    expect(job?.lastRunId).toBe('run-1');
    expect(job?.lastSkipReason, 'the run happened; the cadence is still exhausted').toBe('no-next-fire');
  });

  it('a spent one-shot re-registered for the SAME slot stays spent; a LATER fire time re-arms it', async () => {
    const at = Date.now() + 60 * MIN;
    const r = await registerJob({ jobId: 'j-once', tenantId: 't', cronExpr: ONE_SHOT_CRON, firstFireAtMs: at, workflowId: 'wf' });
    expect(r.ok).toBe(true);
    expect(await claimDueSlot('j-once', at, 1, at)).not.toBeNull();
    expect((await getJob('j-once'))?.nextFireAt).toBeUndefined();
    // The retried tool call: identical arguments.
    const retried = await registerJob({ jobId: 'j-once', tenantId: 't', cronExpr: ONE_SHOT_CRON, firstFireAtMs: at, workflowId: 'wf' });
    expect(retried.ok).toBe(true);
    expect((await getJob('j-once'))?.nextFireAt, 'the same slot must not fire twice').toBeUndefined();
    // KickBot coach / convene / session reminder: the same id, a NEW fire time.
    const later = at + 5 * MIN;
    const again = await registerJob({ jobId: 'j-once', tenantId: 't', cronExpr: ONE_SHOT_CRON, firstFireAtMs: later, workflowId: 'wf' });
    expect(again.ok).toBe(true);
    expect((await getJob('j-once'))?.nextFireAt).toBe(later);
  });

  it('ce sizing: a job the old 30-day search KILLED (monthly `0 9 3 * *`, no nextFireAt) is revived by the daemon pass', async () => {
    // Seed the exact prod shape: enabled, bound, parseable, nextFireAt ABSENT.
    const r = await registerJob({ jobId: 'j-dead-monthly', tenantId: 't', cronExpr: '0 9 3 * *', workflowId: 'wf', timezone: 'UTC' });
    expect(r.ok).toBe(true);
    // The pre-0787 advance wrote the row back with `nextFireAt` deleted — raw, as it did.
    const rows = new DurableCollection<ScheduledJob>('scheduler:job', (j) => j.jobId);
    const __rawPutJobForTest = (j: ScheduledJob) => rows.put(j);
    const row = (await getJob('j-dead-monthly'))!;
    delete row.nextFireAt;
    await __rawPutJobForTest(row);
    expect((await getJob('j-dead-monthly'))?.nextFireAt).toBeUndefined();
    // The expectation is derived by hand, never by `computeNextFire`: the next
    // 3rd-of-month 09:00Z strictly after `nowMs`. `nowMs` is read BEFORE the
    // revive (which searches from max(nowMs, Date.now())), so the two can only
    // disagree if 09:00Z on the 3rd falls between the two reads.
    const nowMs = Date.now();
    const at = new Date(nowMs);
    let want = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 3, 9);
    if (want <= nowMs) want = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 3, 9);
    expect(await reviveStalledJob('j-dead-monthly', nowMs)).toBe(true);
    const revived = await getJob('j-dead-monthly');
    expect(revived?.nextFireAt).toBe(want);
    // Idempotent: a second pass has nothing to do.
    expect(await reviveStalledJob('j-dead-monthly')).toBe(false);
    // A disabled or spent one-shot row is NOT revived.
    await updateJob('j-dead-monthly', { enabled: false });
    const off = (await getJob('j-dead-monthly'))!;
    delete off.nextFireAt;
    await __rawPutJobForTest(off);
    expect(await reviveStalledJob('j-dead-monthly')).toBe(false);
  });
});
