import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit coverage for the lazy Firebase module (GAP-ANALYSIS E13) on the
 * NOT-CONFIGURED path — the anon/demo deploy, and the path CI exercises. The
 * key guarantee: when VITE_FIREBASE_* is unset, the module must NEVER load the
 * Firebase SDK (`ensureInitAsync` short-circuits before the dynamic import) and
 * must degrade gracefully (null token, one `null` auth emission, a friendly
 * sign-in error). The configured/redirect path needs real OAuth and is verified
 * manually against openwop-dev.
 *
 * "Never loads the SDK" is OBSERVED: `@firebase/app` + `@firebase/auth` are
 * mocked with factories that record their own evaluation, so moving the
 * dynamic import above the `if (!cfg) return null` guard turns the
 * not-configured cases red.
 *
 * (Two former cases were cut as unfailable on this path: `getCurrentUser()`
 * and `getPendingMfaHints()` read `cachedUser` / `authMod`, which are only ever
 * assigned inside the SDK-init body — `firebase.ts` `ensureInitAsync` — so
 * without the SDK they are structurally null/[]; the no-SDK assertion below is
 * what guards that precondition.)
 */
const sdk = vi.hoisted(() => ({ loads: [] as string[] }));
vi.mock('@firebase/app', () => { sdk.loads.push('@firebase/app'); return {}; });
vi.mock('@firebase/auth', () => { sdk.loads.push('@firebase/auth'); return {}; });

import {
  isAuthConfigured,
  getCurrentIdToken,
  onAuthChanged,
  selectTotpHint,
  signInWithGoogle,
  signInWithGithub,
} from '../firebase.js';

describe('firebase auth (not configured)', () => {
  // The file OWNS the not-configured precondition rather than inheriting it from
  // whatever env the run happens to load: `readConfigFromEnv` reads these three
  // at call time, and one empty value is enough to make the build unconfigured.
  beforeEach(() => {
    vi.stubEnv('VITE_FIREBASE_API_KEY', '');
    vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', '');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports not-configured', () => {
    expect(isAuthConfigured()).toBe(false);
  });

  it('resolves a null ID token without loading the SDK', async () => {
    expect(await getCurrentIdToken()).toBeNull();
    expect(sdk.loads).toEqual([]);
  });

  it('onAuthChanged fires exactly once with null, never loads the SDK, and returns a safe unsubscribe', async () => {
    const cb = vi.fn();
    const unsub = onAuthChanged(cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalled());
    // Let any (wrong) second emission land before counting: a full macrotask
    // turn, not one microtask, so a re-emit scheduled by a timer is counted too.
    await new Promise<void>((r) => { setTimeout(r, 0); });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null);
    expect(sdk.loads).toEqual([]);
    expect(() => unsub()).not.toThrow();
  });

  it('sign-in rejects with a friendly not-configured error, without loading the SDK', async () => {
    await expect(signInWithGoogle()).rejects.toThrow(/not configured/i);
    await expect(signInWithGithub()).rejects.toThrow(/not configured/i);
    expect(sdk.loads).toEqual([]);
  });
});

/**
 * USERS-UX-1 — multi-device TOTP challenge. `selectTotpHint` is the PURE
 * selection seam `completeMfaSignIn` routes through; asserting only the first
 * hint locked out a user who lost device #1 but still holds #2. The live
 * resolver path needs a real Firebase challenge and is exercised manually.
 */
describe('MFA factor selection (USERS-UX-1)', () => {
  const hints = [
    { uid: 'factor-1', displayName: 'Old phone' },
    { uid: 'factor-2', displayName: 'New phone' },
  ] as const;

  it('defaults to the single/first hint when no factorUid is given', () => {
    expect(selectTotpHint(hints)?.uid).toBe('factor-1');
    expect(selectTotpHint([hints[1]])?.uid).toBe('factor-2');
  });

  it('an explicit factorUid selects EXACTLY that hint', () => {
    expect(selectTotpHint(hints, 'factor-2')?.uid).toBe('factor-2');
    expect(selectTotpHint(hints, 'factor-1')?.uid).toBe('factor-1');
  });

  it('an unknown factorUid resolves null — never silently a different device', () => {
    expect(selectTotpHint(hints, 'factor-gone')).toBeNull();
  });

  it('no hints at all resolves null (typed failure upstream, not a crash)', () => {
    expect(selectTotpHint([])).toBeNull();
    expect(selectTotpHint([], 'factor-1')).toBeNull();
  });
});
