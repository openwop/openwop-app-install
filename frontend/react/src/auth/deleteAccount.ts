/**
 * Account hard-delete helper (P3.6.5 client side).
 *
 * Two-step flow:
 *   1. DELETE /host/openwop-app/account — wipes backend rows + KMS-
 *      wrapped DEKs for the signed-in tenant. Returns row counts.
 *   2. Firebase user.delete() — revokes the IdP record so the same
 *      user can't re-authenticate. Must be called while the bearer
 *      is still fresh (within ~5 min of last sign-in) — Firebase
 *      requires "recent login" for destructive operations.
 *
 * If (2) fails with `auth/requires-recent-login`, the re-authentication
 * dialog (`auth/reauth.ts`) confirms the person in place and only the
 * Firebase step is retried (backend data is already gone). Cancelling it,
 * or a second refusal, surfaces `RequiresRecentLoginError`.
 */

import { config, authedHeaders, fetchOpts } from '../client/config.js';
import { deleteCurrentFirebaseUser } from './firebase.js';
import { isRequiresRecentLogin, ReauthCancelledError, withRecentLogin } from './reauth.js';
import i18n from '../i18n/index.js';

export interface DeleteAccountResult {
  deleted: true;
  runs: number;
  events: number;
  interrupts: number;
  workflows: number;
  secrets: number;
}

export class RequiresRecentLoginError extends Error {
  constructor() {
    super(i18n.t('auth:requiresRecentLogin'));
    this.name = 'RequiresRecentLoginError';
  }
}

export async function deleteAccount(): Promise<DeleteAccountResult> {
  // Step 1: backend hard-delete.
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/account`,
    fetchOpts({
      method: 'DELETE',
      headers: authedHeaders({ accept: 'application/json' }),
    }),
  );
  if (!res.ok) {
    throw new Error(`account delete failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as DeleteAccountResult;

  // Step 2: Firebase user revocation (no-op if not configured / not signed in).
  // Routed through firebase.ts so the lazily-loaded SDK stays the single import.
  try {
    await withRecentLogin(() => deleteCurrentFirebaseUser());
  } catch (err) {
    if (err instanceof ReauthCancelledError || isRequiresRecentLogin(err)) {
      throw new RequiresRecentLoginError();
    }
    throw err;
  }

  return body;
}
