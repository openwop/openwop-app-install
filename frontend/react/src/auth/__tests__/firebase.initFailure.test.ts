/**
 * First-visit splash hang incident (2026-11-05, fix 07318dfed) — a failed
 * Firebase SDK init must still answer `onAuthChanged`, exactly once, and must
 * not be memoized.
 *
 * `onAuthChanged` called `ensureInitAsync().then(...)` with no rejection
 * handler, so when the init failed (on myndhyve.ai: the lazy `firebase-*.js`
 * chunk did not fetch on a first visit) the subscriber was never called and
 * `useAuth().loading` never settled. `initPromise` also kept the rejection, so
 * nothing on that page could retry. The second layer of the same fix is the
 * `useAuth` watchdog (GRADE-DELTA CODE-3, `authLoadingWatchdog.test.tsx`).
 *
 * The configured path is reached by stubbing the three VITE_FIREBASE_* values;
 * the failure is injected by making `initializeApp` throw once, which takes the
 * same rejection path as a failed chunk import. Every case imports a FRESH
 * `firebase.js` (`vi.resetModules`) behind a failing first init, so neither
 * case depends on the other having run (/grade-tests wave 91, TST-GRB-1: the
 * retry case used to rely on the first case's failure, and went red alone).
 *
 * Sabotage that turns it red (wave 91 probes): skip the rejection handler's
 * `cb(null)` (the first case); answer twice (the first case, exactly-once);
 * replace `initPromise.catch(() => { initPromise = null; })` with a no-op
 * (the retry case gets the memoized rejection and never subscribes).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const sdk = vi.hoisted(() => ({ failNext: true, subscribed: 0 }));
vi.mock('@firebase/app', () => ({
  initializeApp: () => {
    if (sdk.failNext) { sdk.failNext = false; throw new Error('simulated SDK load failure'); }
    return {};
  },
}));
vi.mock('@firebase/auth', () => ({
  getAuth: () => ({ currentUser: null }),
  onIdTokenChanged: (_auth: unknown, cb: (u: null) => void) => { sdk.subscribed += 1; queueMicrotask(() => cb(null)); return () => undefined; },
}));

let warn: MockInstance<typeof console.warn>;

beforeAll(() => {
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-key');
  vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'example.test');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'test-project');
});
afterAll(() => { vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.resetModules();
  sdk.failNext = true;
  sdk.subscribed = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { warn.mockRestore(); });

/** Let any queued promise reactions and microtasks run. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

describe('onAuthChanged when the SDK fails to initialize', () => {
  it('still answers once, with signed-out, instead of never calling back', async () => {
    const { onAuthChanged, isAuthConfigured } = await import('../firebase.js');
    expect(isAuthConfigured()).toBe(true);
    const cb = vi.fn();
    onAuthChanged(cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(null));
    await drain();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(sdk.subscribed).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to initialize'), expect.any(Error));
  });

  it('does not memoize the failure: the next subscriber retries and reaches the SDK', async () => {
    const { onAuthChanged } = await import('../firebase.js');
    // Positive control: THIS module's first init really fails.
    const first = vi.fn();
    onAuthChanged(first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith(null));
    expect(sdk.subscribed).toBe(0);

    const cb = vi.fn();
    onAuthChanged(cb);
    // Two subscriptions: the init body's own token-cache listener, then this subscriber's.
    await vi.waitFor(() => expect(sdk.subscribed).toBe(2));
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(null));
  });
});
