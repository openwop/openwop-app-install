import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config, authedHeaders, fetchOpts, setCurrentIdToken, onAuthChange } from '../config.js';

/**
 * Auth-mode switching (frontend enterprise-review Batch J): authedHeaders +
 * fetchOpts must produce the right Authorization / credentials behavior across
 * bearer / cookie / signed-in-token modes, and onAuthChange must fire only on
 * identity change. config.authMode is a mutable runtime field, so we flip it
 * per case and restore after.
 */
const originalMode = config.authMode;

beforeEach(() => { setCurrentIdToken(null); });
afterEach(() => { config.authMode = originalMode; setCurrentIdToken(null); });

describe('authedHeaders', () => {
  it('bearer mode sends Authorization: Bearer <apiKey>', () => {
    config.authMode = 'bearer';
    expect(authedHeaders().authorization).toBe(`Bearer ${config.apiKey}`);
  });

  it('cookie mode sends no Authorization header', () => {
    config.authMode = 'cookie';
    expect(authedHeaders().authorization).toBeUndefined();
  });

  it('a cached ID token takes precedence over bearer apiKey', () => {
    config.authMode = 'bearer';
    setCurrentIdToken('id-token-123');
    expect(authedHeaders().authorization).toBe('Bearer id-token-123');
  });

  it('merges extra headers', () => {
    config.authMode = 'cookie';
    expect(authedHeaders({ 'x-test': '1' })['x-test']).toBe('1');
  });
});

describe('fetchOpts', () => {
  it('cookie mode includes credentials', () => {
    config.authMode = 'cookie';
    expect(fetchOpts().credentials).toBe('include');
  });

  it('bearer mode without a token omits credentials', () => {
    config.authMode = 'bearer';
    expect(fetchOpts().credentials).toBeUndefined();
  });

  it('a cached token forces credentials include even in bearer mode', () => {
    config.authMode = 'bearer';
    setCurrentIdToken('tok');
    expect(fetchOpts().credentials).toBe('include');
  });
});

describe('onAuthChange', () => {
  it('fires on identity change but not on a same-value set', () => {
    let count = 0;
    const off = onAuthChange(() => { count += 1; });
    setCurrentIdToken('a');   // change null → a
    setCurrentIdToken('a');   // no change
    setCurrentIdToken('b');   // change a → b
    setCurrentIdToken(null);  // change b → null
    off();
    setCurrentIdToken('c');   // listener detached
    expect(count).toBe(3);
  });
});
