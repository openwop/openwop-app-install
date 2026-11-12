/**
 * ADR 1097 — the remembered sign-in return is an OPEN-REDIRECT guard: it is
 * written from the current URL and later handed to `navigate()`, so a value that
 * can name another origin, or an arbitrary in-app path, would let a crafted
 * session value steer a freshly signed-in user. The guard is an allowlist of
 * exact paths (the store and `/start-trial`), resolved same-origin.
 *
 * Sabotage witness (ADR 1097 §6): reverting `safeReturnPath` to the old
 * `startsWith` prefix test reds the look-alike-path case; dropping the origin
 * comparison does not red it alone (the `//` and absolute-URL refusals are
 * checked first), which is why both checks stay.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rememberReturn, safeReturnPath, takeReturn, START_TRIAL_PATH, STORE_URL } from '../signInReturn.js';

afterEach(() => { window.sessionStorage.clear(); });

describe('sign-in return — same-origin allowlist (ADR 1097)', () => {
  it('accepts the store and the trial entry, query kept', () => {
    expect(safeReturnPath(STORE_URL)).toBe('/marketplace/bundles');
    expect(safeReturnPath('/marketplace/bundles?bundle=crm&view=compare')).toBe('/marketplace/bundles?bundle=crm&view=compare');
    expect(safeReturnPath(`${START_TRIAL_PATH}?plan=pro`)).toBe('/start-trial?plan=pro');
    expect(safeReturnPath('/start-trial/?bundle=crm&cadence=year')).toBe('/start-trial/?bundle=crm&cadence=year');
  });

  it('refuses other origins, protocol-relative and backslash forms', () => {
    for (const bad of [
      'https://evil.example/start-trial?plan=pro',
      '//evil.example/start-trial',
      '/\\evil.example/start-trial',
      '\\\\evil.example',
      'javascript:alert(1)',
      ' /start-trial',
      '/start-trial\n',
    ]) expect(safeReturnPath(bad), bad).toBeNull();
  });

  it('refuses any in-app path that is not on the allowlist, including look-alikes', () => {
    for (const bad of ['/', '/billing', '/start-trial-evil', '/marketplace/bundles-evil', '/start-trial/../admin', '/marketplace/bundles/x']) {
      expect(safeReturnPath(bad), bad).toBeNull();
    }
  });

  it('takeReturn applies the guard and the 30-minute expiry, and is one-shot', () => {
    rememberReturn('/start-trial?plan=pro');
    expect(takeReturn()).toBe('/start-trial?plan=pro');
    expect(takeReturn()).toBeNull(); // consumed
    rememberReturn('https://evil.example/');
    expect(takeReturn()).toBeNull();
    rememberReturn('/start-trial?plan=pro');
    expect(takeReturn(Date.now() + 31 * 60 * 1000)).toBeNull();
  });
});
