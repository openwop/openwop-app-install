/**
 * Finalize a Firebase sign-in into a backend session (ADR 0026 / ADR 0003).
 *
 * After ANY Firebase auth succeeds — OAuth redirect (Google/GitHub) OR in-page
 * email/password — the SAME backend handshake runs:
 *   1. push the fresh Firebase ID token into the shared client cache so
 *      `authedHeaders()` attaches it on the next fetch;
 *   2. `/migrate-tenant` — adopt the visitor's anon sandbox into their user
 *      tenant (must run while the anon cookie is still present);
 *   3. `/oidc/bind` (Phase 4a) — bind the OIDC identity to a durable `User` so
 *      every later request resolves the canonical `user:<userId>`.
 *
 * Best-effort: a 404 (the `users` toggle off) or a transient error must never
 * block sign-in. Returns the durable backend User (or null).
 *
 * The OAuth redirect path in `SignInButton` and the email/password path in
 * `AuthCard` both call this — one handshake, no duplication.
 */
import { getCurrentIdToken } from './firebase.js';
import { setCurrentIdToken } from '../client/config.js';
import { migrateAnonToUser } from './migrateTenant.js';
import { bindOidc, getMe, type User } from '../features/users/usersClient.js';

export async function finalizeFirebaseSession(): Promise<User | null> {
  const token = await getCurrentIdToken();
  if (token) setCurrentIdToken(token);

  const migrated = await migrateAnonToUser();
  if (migrated?.migrated) console.warn('openwop: anon → user migration', migrated);

  try {
    const bound = await bindOidc();
    if (bound) console.warn('openwop: OIDC identity bound', { userId: bound.user.userId, rekeyed: bound.rekeyed });
  } catch {
    /* best-effort — sign-in completes regardless */
  }

  return getMe().catch(() => null);
}
