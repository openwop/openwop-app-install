/**
 * #6214 — a throwing auth-change listener must not sign a tab out of a valid
 * token, and `hardSignOut` must keep its "never throws" promise.
 *
 * `setCurrentIdToken` and `fireAuthChanged` update their state and then rethrow
 * a listener failure as `AuthChangeDispatchError` (ADR 1148). Two callers took
 * that the wrong way:
 *  1. Firebase's `onIdTokenChanged` callback wrapped the dispatch in the same
 *     `try` as `getIdToken()`. A listener failure took the catch, and the catch
 *     set the token to null: a valid session became signed out.
 *  2. `hardSignOut` let the failure escape before it signed out the backend
 *     session and the IdP, or reject the promise callers are told cannot fail.
 *
 * Sabotage witnesses (2026-11-26):
 * - restoring the broad `try { setCurrentIdToken(await getIdToken()) } catch
 *   { setCurrentIdToken(null) }` reds the token-kept case;
 * - an unguarded `setCurrentIdToken(null)` in `hardSignOut` reds the sign-out
 *   case (it throws before the IdP sign-out);
 * - an unguarded `fireAuthChanged()` there reds both hardSignOut cases (the
 *   promise rejects).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const sdk = vi.hoisted(() => ({ callbacks: [] as Array<(u: unknown) => Promise<void> | void> }));
vi.mock('@firebase/app', () => ({ initializeApp: () => ({}) }));
vi.mock('@firebase/auth', () => ({
  getAuth: () => ({ currentUser: null }),
  // Every subscriber is kept and called, as the SDK does: firebase.ts registers its
  // token sync at init, and onAuthChanged registers its own subscriber.
  onIdTokenChanged: (_auth: unknown, cb: (u: unknown) => Promise<void> | void) => { sdk.callbacks.push(cb); return () => undefined; },
}));

let warn: MockInstance<typeof console.warn>;
/** A user the SDK would hand every subscriber. */
const user = (getIdToken: () => Promise<string>) => ({ uid: 'u1', email: 'a@example.test', displayName: 'A', photoURL: null, providerData: [], getIdToken });
/** Fires the token-changed event at every subscriber, awaiting each. */
const fire = async (u: unknown): Promise<void> => { for (const cb of [...sdk.callbacks]) await cb(u); };
const drain = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

beforeAll(() => {
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-key');
  vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'example.test');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'test-project');
});
afterAll(() => { vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.resetModules();
  sdk.callbacks = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { warn.mockRestore(); vi.doUnmock('../firebase.js'); vi.doUnmock('../backendSession.js'); });

describe('hazard 1 — the Firebase token callback keeps a valid token', () => {
  it('a throwing auth-change listener does not replace the issued token with null', async () => {
    const config = await import('../../client/config.js');
    const { onAuthChanged } = await import('../firebase.js');
    onAuthChanged(() => undefined); // starts the SDK init, which subscribes onIdTokenChanged
    await vi.waitFor(() => expect(sdk.callbacks.length).toBeGreaterThan(0));

    const stop = config.onAuthChange(() => { throw new Error('a tenant-cache clearer failed'); });
    try {
      await fire(user(async () => 'valid-token-issued-by-firebase'));
      await drain();
      expect(config.authedHeaders().authorization, 'the issued token is kept').toBe('Bearer valid-token-issued-by-firebase');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('onIdTokenChanged'), expect.objectContaining({ listenerFailureCount: 1 }));
    } finally {
      stop();
    }
  });

  it('control: a failed getIdToken still clears the token', async () => {
    const config = await import('../../client/config.js');
    const { onAuthChanged } = await import('../firebase.js');
    onAuthChanged(() => undefined);
    await vi.waitFor(() => expect(sdk.callbacks.length).toBeGreaterThan(0));
    await fire(user(async () => 'first-token'));
    expect(config.authedHeaders().authorization).toBe('Bearer first-token');
    await fire(user(async () => { throw new Error('offline'); }));
    expect(config.authedHeaders().authorization, 'the failed refresh drops the old token').not.toBe('Bearer first-token');
  });
});

describe('hazard 2 — hardSignOut never throws and never rejects', () => {
  async function load() {
    const signOut = vi.fn(async () => undefined);
    const setBackendSessionUser = vi.fn();
    vi.doMock('../firebase.js', () => ({ signOut }));
    vi.doMock('../backendSession.js', () => ({ setBackendSessionUser }));
    const config = await import('../../client/config.js');
    const mod = await import('../hardSignOut.js');
    return { config, mod, signOut, setBackendSessionUser };
  }

  it('with a throwing listener, it signs out the backend session and the IdP', async () => {
    const { config, mod, signOut, setBackendSessionUser } = await load();
    config.setCurrentIdToken('token-before-sign-out');
    const stop = config.onAuthChange(() => { throw new Error('listener failed'); });
    try {
      let promise: Promise<void> | undefined;
      expect(() => { promise = mod.hardSignOut('session_revoked'); }).not.toThrow();
      await expect(promise).resolves.toBeUndefined();
      expect(setBackendSessionUser).toHaveBeenCalledWith(null);
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(config.authedHeaders().authorization, 'the token is dropped').not.toBe('Bearer token-before-sign-out');
    } finally {
      stop();
    }
  });

  it('the promise does not reject when the closing auth-change broadcast fails', async () => {
    const { config, mod } = await load();
    config.setCurrentIdToken(null); // so the first dispatch is a no-op and only the closing broadcast fires
    const stop = config.onAuthChange((event) => { if (event.reason === 'explicit') throw new Error('listener failed on the broadcast'); });
    try {
      await expect(mod.hardSignOut('account_disabled')).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('hardSignOut.changed'), expect.objectContaining({ listenerFailureCount: 1 }));
    } finally {
      stop();
    }
  });
});
