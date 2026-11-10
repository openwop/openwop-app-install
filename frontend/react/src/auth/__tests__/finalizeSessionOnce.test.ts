/**
 * KT-AUTH-2 — one sign-in sends ONE `/migrate-tenant`.
 *
 * A redirect-back page load ran the handshake twice at once: the `SignInButton`
 * redirect arm and `reconcileRestoredSession` (fired by the SDK's user emission). An
 * MFA sign-in did the same with `AuthCard`. Both calls carried the anon cookie, so
 * the backend ran two full adoptions concurrently. MEASURED in production: both heap
 * OOMs (2026-11-02 08:13Z, 2026-11-03 13:29Z) had exactly that pair in flight. That
 * link is unproven (four other pairs did not crash); the double call is the defect.
 *
 * Drives the real `finalizeSession.ts`; only the network clients and the SDK are faked.
 *
 * Sabotage: remove the share in `finalizeFirebaseSession` (the first three cases
 * fail; the first is also red against `825eacfb6`'s finalizeSession); reuse finished runs for every
 * caller (the explicit re-sign-in case fails); key the share without the uid (the
 * other-user case fails); have `reconcileRestoredSession` ask for a fresh run instead
 * of `reuseCompleted` (the reconcile-after-a-finished-redirect case fails).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  uid: 'u1' as string | null,
  migrate: [] as string[],
  release: () => undefined as void,
  gate: Promise.resolve() as Promise<void>,
}));

vi.mock('../firebase.js', () => ({
  getCurrentIdToken: async () => 'token',
  getCurrentUser: () => (h.uid ? { uid: h.uid } : null),
}));
vi.mock('../../client/config.js', () => ({ setCurrentIdToken: vi.fn() }));
vi.mock('../migrateTenant.js', () => ({
  migrateAnonToUser: vi.fn(async () => { h.migrate.push(String(h.uid)); await h.gate; return { migrated: true }; }),
}));
vi.mock('../../features/users/usersClient.js', () => ({
  bindOidc: vi.fn(async () => null),
  getMe: vi.fn(async () => null),
}));

import { __resetFinalizeForTest, finalizeFirebaseSession, reconcileRestoredSession } from '../finalizeSession.js';

beforeEach(() => {
  __resetFinalizeForTest();
  h.uid = 'u1';
  h.migrate.length = 0;
  h.gate = new Promise((resolve) => { h.release = resolve; });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('KT-AUTH-2 — one handshake per sign-in', () => {
  it('the redirect arm and the restored-session reconcile share one adoption', async () => {
    const reconcile = reconcileRestoredSession();
    const redirect = finalizeFirebaseSession({ reuseCompleted: true });
    h.release();
    await Promise.all([reconcile, redirect]);
    expect(h.migrate).toEqual(['u1']);
  });

  it('an MFA sign-in (AuthCard) during the reconcile shares it too', async () => {
    const reconcile = reconcileRestoredSession();
    const authCard = finalizeFirebaseSession();
    h.release();
    await Promise.all([reconcile, authCard]);
    expect(h.migrate).toEqual(['u1']);
  });

  it('a redirect arm that resolves after the reconcile finished does not adopt again', async () => {
    h.release();
    await reconcileRestoredSession();
    await finalizeFirebaseSession({ reuseCompleted: true });
    expect(h.migrate).toEqual(['u1']);
  });

  it('a reconcile that fires after the redirect arm finished does not adopt again', async () => {
    h.release();
    await finalizeFirebaseSession({ reuseCompleted: true });
    await reconcileRestoredSession();
    expect(h.migrate).toEqual(['u1']);
  });

  it('an explicit sign-in after a finished run runs again (a re-sign-in must bind again)', async () => {
    h.release();
    await finalizeFirebaseSession();
    await finalizeFirebaseSession();
    expect(h.migrate).toEqual(['u1', 'u1']);
  });

  it('a different user never shares another user\'s run', async () => {
    const first = finalizeFirebaseSession();
    h.uid = 'u2';
    const second = finalizeFirebaseSession({ reuseCompleted: true });
    h.release();
    await Promise.all([first, second]);
    // Two separate adoptions (the fake reads the uid when it runs, so both entries
    // name the current user; the count is the claim).
    expect(h.migrate).toHaveLength(2);
  });
});
