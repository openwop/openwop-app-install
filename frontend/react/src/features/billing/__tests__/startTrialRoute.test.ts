/**
 * ADR 1097 — the `/start-trial` link grammar. Strict on purpose: a link that does
 * not name exactly one paid tier or one bundle id is `null` (the page's "this link
 * does not name a plan" state), never a guessed target.
 */
import { describe, expect, it } from 'vitest';
import { matchStartTrialRoute, parseTrialLink, START_TRIAL_ROUTE } from '../startTrialRoute.js';
import { safeReturnPath, START_TRIAL_PATH } from '../../../auth/signInReturn.js';

describe('/start-trial route', () => {
  it('the route and the sign-in return allowlist name the same path', () => {
    expect(START_TRIAL_ROUTE).toBe(START_TRIAL_PATH);
    expect(safeReturnPath(`${START_TRIAL_ROUTE}?plan=pro`)).toBe('/start-trial?plan=pro');
  });
  it('matches the path with or without a trailing slash, nothing else', () => {
    expect(matchStartTrialRoute('/start-trial')).toBe(true);
    expect(matchStartTrialRoute('/start-trial/')).toBe(true);
    expect(matchStartTrialRoute('/start-trial/x')).toBe(false);
    expect(matchStartTrialRoute('/start-trials')).toBe(false);
  });

  it('parses a plan or a bundle, with an optional cadence', () => {
    expect(parseTrialLink('?plan=pro')).toEqual({ target: { plan: 'pro' }, cadence: 'month' });
    expect(parseTrialLink('?bundle=job-search&cadence=year')).toEqual({ target: { bundleId: 'job-search' }, cadence: 'year' });
  });

  it('refuses anything ambiguous or outside the grammar', () => {
    for (const q of ['', '?plan=free', '?plan=Pro', '?plan=pro&bundle=crm', '?plan=pro&plan=team', '?bundle=', '?bundle=../x', '?bundle=CRM', '?plan=pro&cadence=week', '?plan=pro&cadence=year&cadence=month']) {
      expect(parseTrialLink(q), q).toBeNull();
    }
  });
});
