/**
 * ADR 0193/0201 follow-up — retention sweep for the `email:sent` idempotency
 * ledger. Proves rows older than the TTL are deleted, fresh rows (still inside
 * the replay window) are kept so dedup keeps working, an unparseable stamp is
 * never deleted, and the env TTL override is honored. Deterministic: an explicit
 * `now` is passed so nothing reads the wall clock.
 *
 * Sabotage-witnessed (grade-tests w9): sweeping at `now` instead of the TTL cutoff reds
 * case 1; ignoring the env override reds case 2; dropping the `Number.isFinite` guard
 * reds case 3. The fresh row is seeded at 12 h so it never sits on case 2's 1-day cutoff
 * (the cases share one ledger).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { priorSend, recordSend, sweepExpiredEmailSent } from '../src/host/emailSentLedger.js';

const NOW = Date.parse('2026-07-03T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const seed = (key: string, ageDays: number): Promise<void> =>
  recordSend({ key, tenantId: 't1', provider: 'sendgrid', messageId: 'm', createdAt: iso(NOW - ageDays * DAY) });

describe('email:sent ledger TTL sweep (ADR 0193/0201)', () => {
  beforeAll(async () => {
    initHostExtPersistence(await openStorage('memory://'));
  });
  beforeEach(() => { delete process.env.OPENWOP_EMAIL_LEDGER_TTL_DAYS; });
  afterAll(() => { delete process.env.OPENWOP_EMAIL_LEDGER_TTL_DAYS; });

  it('deletes rows past the default 30-day TTL and keeps fresh rows (dedup still works)', async () => {
    await seed('t1:stale', 40); // older than 30d
    await seed('t1:fresh', 0.5);  // well inside the window (and off case 2's 1-day TTL boundary)
    const deleted = await sweepExpiredEmailSent(NOW);
    expect(deleted).toBe(1);
    expect(await priorSend('t1:stale')).toBeNull();
    const fresh = await priorSend('t1:fresh');
    expect(fresh?.key).toBe('t1:fresh'); // still dedups
  });

  it('honors OPENWOP_EMAIL_LEDGER_TTL_DAYS', async () => {
    await seed('t1:twoday', 2);
    // Default 30d would keep it; a 1-day TTL sweeps it.
    expect(await sweepExpiredEmailSent(NOW)).toBe(0);
    expect(await priorSend('t1:twoday')).not.toBeNull();
    process.env.OPENWOP_EMAIL_LEDGER_TTL_DAYS = '1';
    expect(await sweepExpiredEmailSent(NOW)).toBe(1);
    expect(await priorSend('t1:twoday')).toBeNull();
  });

  it('never deletes a row with an unparseable createdAt', async () => {
    await recordSend({ key: 't1:badstamp', tenantId: 't1', provider: 'smtp', messageId: 'm', createdAt: 'not-a-date' });
    expect(await sweepExpiredEmailSent(NOW)).toBe(0);
    expect(await priorSend('t1:badstamp')).not.toBeNull();
  });
});
