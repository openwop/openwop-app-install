/**
 * CDP-E — email frequency governor config (ADR 0267). The cap is env-driven and
 * OFF by default (max=0 ⇒ the send loop skips the ledger scan, behavior unchanged);
 * a positive cap enables the per-recipient rolling-window governor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { emailFrequencyCap } from '../src/features/email/emailService.js';

afterEach(() => {
  delete process.env.OPENWOP_EMAIL_FREQ_CAP_MAX;
  delete process.env.OPENWOP_EMAIL_FREQ_CAP_WINDOW_DAYS;
});

describe('CDP-E emailFrequencyCap', () => {
  it('is OFF by default (max 0, 30-day window)', () => {
    expect(emailFrequencyCap()).toEqual({ max: 0, windowDays: 30 });
  });
  it('honors a positive cap + window from env', () => {
    process.env.OPENWOP_EMAIL_FREQ_CAP_MAX = '3';
    process.env.OPENWOP_EMAIL_FREQ_CAP_WINDOW_DAYS = '7';
    expect(emailFrequencyCap()).toEqual({ max: 3, windowDays: 7 });
  });
  it('treats non-positive / invalid values as OFF / default', () => {
    process.env.OPENWOP_EMAIL_FREQ_CAP_MAX = '0';
    expect(emailFrequencyCap().max).toBe(0);
    process.env.OPENWOP_EMAIL_FREQ_CAP_MAX = '-5';
    expect(emailFrequencyCap().max).toBe(0);
    process.env.OPENWOP_EMAIL_FREQ_CAP_MAX = 'lots';
    expect(emailFrequencyCap().max).toBe(0);
    process.env.OPENWOP_EMAIL_FREQ_CAP_MAX = '2';
    process.env.OPENWOP_EMAIL_FREQ_CAP_WINDOW_DAYS = 'bad';
    expect(emailFrequencyCap()).toEqual({ max: 2, windowDays: 30 });
  });
});
